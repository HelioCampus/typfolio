// Page side of tests/browser/verapdf.spec.ts. Served with a Content Security Policy that allows 'wasm-unsafe-eval'
// but not 'unsafe-eval' (tools/serve-smoke.ts). Starts the validator in a module worker and exposes
// window.verapdf.validate(bytes, flavour) to the test.
const result = document.getElementById('result');
// The policy must really be in force, or the test proves nothing: constructing code has to be refused here and in
// the worker. The probes' own violation reports are kept apart from the ones that would be a finding.
const violations = [];
document.addEventListener('securitypolicyviolation', event => { if (event.blockedURI !== 'eval') violations.push(`${event.violatedDirective}: ${event.blockedURI}`); });
const evalRefused = () => { try { new Function('return 1')(); return false; } catch { return true; } };
const pageRefusesEval = evalRefused();
const started = performance.now();
const worker = new Worker('./verapdf-worker.js', { type: 'module' });
const pending = new Map();
let next = 0;
const ready = new Promise((resolve, reject) => {
  worker.onerror = event => reject(new Error(event.message || 'the worker failed to start'));
  worker.onmessage = event => {
    if (event.data.ready) return resolve(event.data);
    if (event.data.failed) return reject(new Error(event.data.failed));
    pending.get(event.data.id)(event.data);
    pending.delete(event.data.id);
  };
});
window.verapdf = {
  violations,
  validate: async (bytes, flavour) => {
    await ready;
    return new Promise(resolve => {
      const id = next++;
      pending.set(id, resolve);
      worker.postMessage({ id, pdf: new Uint8Array(bytes), flavour });
    });
  },
};
try {
  const { globals, refusesEval } = await ready;
  window.verapdf.refusesEval = { page: pageRefusesEval, worker: refusesEval };
  window.verapdf.startMs = Math.round(performance.now() - started);
  window.verapdf.workerGlobals = globals;
  result.textContent = `validator ready in ${window.verapdf.startMs} ms`;
  result.dataset.status = 'passed';
} catch (error) {
  result.textContent = `${error.message}\n${violations.join('\n')}`;
  result.dataset.status = 'failed';
}
