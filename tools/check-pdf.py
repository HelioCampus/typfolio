"""Structural regression checks, not a PDF/UA conformance validator."""
from pathlib import Path
import json
import sys
import xml.etree.ElementTree as ET
from pypdf import PdfReader

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.build/test-output')
ua = PdfReader(root / 'ua.pdf')
catalog = ua.trailer['/Root']
assert catalog['/MarkInfo']['/Marked']
assert '/StructTreeRoot' in catalog
assert catalog['/Lang'] == 'en'
assert ua.metadata.title == 'Assessment report'
assert ua.metadata.creation_date.timestamp() == 1700000000
assert 'Critical thinking' in ua.pages[0].extract_text()

def metadata(reader):
    return ET.fromstring(reader.trailer['/Root']['/Metadata'].get_data())

ua_ns = '{http://www.aiim.org/pdfua/ns/id/}part'
assert metadata(ua).find('.//' + ua_ns).text == '1'
plain = PdfReader(root / 'default.pdf')
assert metadata(plain).find('.//' + ua_ns) is None
assert '/StructTreeRoot' in plain.trailer['/Root']
untagged = PdfReader(root / 'untagged.pdf')
assert '/StructTreeRoot' not in untagged.trailer['/Root']

roles, alts = set(), []
def walk(node):
    if hasattr(node, 'get_object'):
        node = node.get_object()
    if isinstance(node, list):
        for child in node: walk(child)
    elif isinstance(node, dict):
        if '/S' in node: roles.add(str(node['/S']))
        if '/Alt' in node: alts.append(str(node['/Alt']))
        if '/K' in node: walk(node['/K'])
walk(catalog['/StructTreeRoot'])
assert {'/H1', '/Table', '/Figure'}.issubset(roles), roles
assert any('blue bar' in value for value in alts), alts

outcome_sets = PdfReader(root / 'outcome-sets.pdf')
assert outcome_sets.metadata.title == 'Lorem Ipsum Dolor Sit Amet'
outcome_catalog = outcome_sets.trailer['/Root']
assert outcome_catalog['/MarkInfo']['/Marked']
assert '/StructTreeRoot' in outcome_catalog
assert metadata(outcome_sets).find('.//' + ua_ns).text == '1'
outcome_text = '\n'.join(page.extract_text() or '' for page in outcome_sets.pages)
assert 'Voluptate Velit Esse' in outcome_text
assert 'Magna Aliqua' in outcome_text

for path in root.glob('standard-*.pdf'):
    standard = path.stem.removeprefix('standard-')
    reader = PdfReader(path)
    xml = metadata(reader)
    if standard[0].isdigit():
        # A PDF catalog can override the header version.
        version = str(reader.trailer['/Root'].get('/Version', reader.pdf_header[5:])).lstrip('/')
        assert version == standard, (standard, version)
    elif standard.startswith('a-'):
        ns = '{http://www.aiim.org/pdfa/ns/id/}'
        assert xml.find('.//' + ns + 'part').text == standard[2], standard
        conformance = xml.find('.//' + ns + 'conformance')
        if len(standard) > 3:
            assert conformance.text.lower() == standard[3], standard

print(json.dumps({'pages': len(ua.pages), 'roles': sorted(roles), 'imageAltText': alts,
                  'pdfUaMetadata': True, 'tagToggle': True, 'timestamp': 1700000000,
                  'outcomeSetsPages': len(outcome_sets.pages),
                  'standardFilesChecked': len(list(root.glob('standard-*.pdf')))}, indent=2))
