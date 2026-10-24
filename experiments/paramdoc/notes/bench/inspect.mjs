// Structure report of PDFs through Typfolio's own inspectPdf (pdf.js based): tagging, title, language,
// headings, tables, figures, fonts and structure roles. Usage: node inspect.mjs a.pdf b.pdf ...
import { readFileSync } from 'node:fs';
import { inspectPdf } from '../../../../packages/dev-tools/dist/pdf.js';
for (const path of process.argv.slice(2)) {
  const r = await inspectPdf(new Uint8Array(readFileSync(path)));
  console.log(`\n${path}`);
  console.log(`  pages ${r.pages}  tagged ${r.tagged}  structureTree ${r.structureTree}  title ${JSON.stringify(r.title)}  lang ${JSON.stringify(r.language)}  standard ${JSON.stringify(r.standard)}`);
  console.log(`  headings ${JSON.stringify(r.headings.map(h => `H${h.level}:${h.text}`))}`);
  console.log(`  tables ${r.tables}  figures ${JSON.stringify(r.figures)}`);
  console.log(`  roles ${JSON.stringify(r.structureRoles)}`);
  console.log(`  fonts ${r.fonts.map(f => `${f.name}${f.embedded ? '' : ' (NOT embedded)'}`).join(', ')}`);
}
