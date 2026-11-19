// A local page for trying the WebAssembly build of veraPDF: serve the repository root over HTTP, after
// `npm run build:verapdf` and `npm run build`, and open /examples/verapdf-playground/.
const flavours = { ua1: 'PDF/UA-1', ua2: 'PDF/UA-2', '1a': 'PDF/A-1a', '1b': 'PDF/A-1b', '2a': 'PDF/A-2a', '2b': 'PDF/A-2b', '2u': 'PDF/A-2u', '3a': 'PDF/A-3a', '3b': 'PDF/A-3b', '3u': 'PDF/A-3u', '4': 'PDF/A-4', '4e': 'PDF/A-4e', '4f': 'PDF/A-4f', wt1a: 'WTPDF 1.0 Accessibility', wt1r: 'WTPDF 1.0 Reuse' };
const order = ['ua1', 'ua2', '1a', '1b', '2a', '2b', '2u', '3a', '3b', '3u', '4', '4e', '4f', 'wt1a', 'wt1r'];
const $ = id => document.getElementById(id);
const status = $('status');
const select = $('flavour');
select.add(new Option('What the file declares', 'declared'));
for (const id of order) select.add(new Option(flavours[id], id));

const worker = new Worker('./worker.js', { type: 'module' });
const pending = new Map();
let next = 0;
const ready = new Promise((resolve, reject) => {
  worker.onerror = event => reject(new Error(event.message || 'the worker could not be started'));
  worker.onmessage = event => {
    if (event.data.ready) return resolve(event.data);
    if (event.data.failed) return reject(new Error(event.data.failed));
    pending.get(event.data.id)(event.data);
    pending.delete(event.data.id);
  };
});
ready.then(
  ({ ms, megabytes }) => { status.textContent = `Validator ready in ${Math.round(ms)} ms (${megabytes.toFixed(1)} MB of WebAssembly).`; },
  error => { status.textContent = `The validator could not be started: ${error.message}. Run npm run build:verapdf and npm run build first.`; },
);
const validate = (pdf, flavour) => new Promise(resolve => {
  const id = next++;
  pending.set(id, resolve);
  worker.postMessage({ id, pdf, flavour });
});

const element = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// What validated: for the footer, and for a saved report.
let version = {};
fetch('/packages/verapdf-wasm/generated/provenance.json').then(response => response.json()).then(provenance => {
  version = { verapdf: provenance.verapdf, graalvm: provenance.graalvm.version, wasmSha256: provenance.wasm.sha256 };
  $('version').textContent = `veraPDF ${provenance.verapdf}, built to WebAssembly with ${provenance.graalvm.distribution} ${provenance.graalvm.version}.`;
}, () => {});

let chosen = [];
async function run() {
  await ready;
  const flavour = select.value;
  const results = $('results');
  results.replaceChildren();
  for (const file of chosen) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // The checksum first: the validator may be handed the bytes themselves.
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const { reports, error, ms } = await validate(bytes, flavour);
    const size = `${(file.size / 1024).toFixed(file.size < 102400 ? 1 : 0)} kB`;
    const header = element('header', {}, element('h2', { textContent: file.name }));
    const card = element('section', { className: 'file' }, header);
    if (error) {
      header.append(element('span', { className: 'verdict error', textContent: 'ERROR' }), element('span', { className: 'meta', textContent: `${size} · ${Math.round(ms)} ms` }));
      card.append(element('p', { className: 'note', textContent: error }));
    } else if (reports.length === 0) {
      header.append(element('span', { className: 'verdict none', textContent: 'NOT VALIDATED' }), element('span', { className: 'meta', textContent: `${size} · ${Math.round(ms)} ms` }));
      card.append(element('p', { className: 'note', textContent: 'The file declares no standard in its metadata, so there is nothing to validate it against. Pick a standard above to validate against it anyway.' }));
    } else {
      for (const report of reports) header.append(element('span', { className: `verdict ${report.compliant ? 'pass' : 'fail'}`, textContent: `${report.compliant ? 'PASS' : 'FAIL'} ${flavours[report.flavour]}` }));
      header.append(element('span', { className: 'meta', textContent: `${flavour === 'declared' ? 'declared by the file · ' : ''}${size} · ${Math.round(ms)} ms` }));
      const json = () => JSON.stringify({ file: file.name, sha256, bytes: file.size, validator: version, reports }, null, 2);
      const copy = element('button', { type: 'button', textContent: 'Copy JSON' });
      copy.onclick = () => navigator.clipboard.writeText(json()).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Not copied'; });
      const save = element('a', { className: 'button', textContent: 'Download JSON', download: `${file.name.replace(/\.pdf$/i, '')}.verapdf.json` });
      save.onclick = () => { save.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' })); setTimeout(() => URL.revokeObjectURL(save.href), 1000); };
      header.append(element('span', { className: 'actions' }, copy, save));
      for (const report of reports) {
        const failedChecks = report.failedRules.reduce((sum, rule) => sum + rule.failedChecks, 0);
        card.append(element('p', { className: 'note summary', textContent: report.compliant
          ? `${flavours[report.flavour]}: passes all ${report.totalAssertions} checks.`
          : `${flavours[report.flavour]}: fails ${report.failedRules.length} of ${report.profile.rules} rules. ${report.totalAssertions - failedChecks} checks passed, ${failedChecks} failed.` }));
        if (report.logs.length > 0) {
          card.append(element('details', { className: 'logs', open: report.compliant },
            element('summary', { textContent: `veraPDF logged ${report.logs.length} message${report.logs.length === 1 ? '' : 's'} while reading the file${report.compliant ? ': it validated what it could read' : ''}` }),
            element('ul', {}, ...report.logs.map(log => element('li', { textContent: `${log.level}${log.occurrences > 1 ? ` (${log.occurrences}×)` : ''}: ${log.message}` }))),
          ));
        }
        if (!report.compliant) {
          card.append(element('ul', { className: 'rules' }, ...report.failedRules.map(rule => element('li', {},
            element('details', {},
              element('summary', {},
                element('span', { className: 'clause', textContent: `${rule.specification}, ${rule.clause}, test ${rule.test}` }),
                element('span', { className: 'count', textContent: rule.failedChecks > 1 ? ` · ${rule.failedChecks} failed checks` : '' }),
                ...rule.tags.map(tag => element('span', { className: 'tag', textContent: tag })),
                element('div', { textContent: rule.message }),
              ),
              element('ol', { className: 'checks' },
                ...rule.checks.map(check => element('li', {},
                  element('span', { textContent: check.error }),
                  element('code', { className: 'context', textContent: check.context, title: 'Where the check failed, in veraPDF’s model of the file' }),
                )),
                ...(rule.failedChecks > rule.checks.length ? [element('li', { className: 'more', textContent: `… and ${rule.failedChecks - rule.checks.length} more` })] : []),
              ),
              element('p', { className: 'rule-meta', textContent: `Checked on ${rule.object}: ${rule.condition}` }),
            ),
          ))));
        }
        card.append(element('p', { className: 'note', textContent: `${report.profile.name}: ${report.profile.rules} rules. ${report.profile.description}.` }));
      }
    }
    card.append(element('p', { className: 'note checksum', textContent: `SHA-256 ${sha256}` }));
    results.append(card);
  }
  $('again').hidden = chosen.length === 0;
}

const take = files => {
  chosen = [...files].filter(file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
  if (chosen.length > 0) run();
};
$('files').onchange = event => take(event.target.files);
$('again').onclick = run;
select.onchange = () => { if (chosen.length > 0) run(); };
const drop = $('drop');
for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add('over'); });
for (const type of ['dragleave', 'drop']) drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', event => take(event.dataTransfer.files));
// A file dropped beside the box would otherwise be opened by the browser in place of this page.
for (const type of ['dragover', 'drop']) window.addEventListener(type, event => event.preventDefault());
