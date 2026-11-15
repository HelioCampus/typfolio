// Module worker of the veraPDF browser test: one validator, {id, pdf, flavour} in, {id, report | error, ms} out.
import { createValidator } from '/packages/verapdf-wasm/dist/index.js';

try {
  const before = new Set(Object.getOwnPropertyNames(globalThis));
  const wasm = await (await fetch('/packages/verapdf-wasm/generated/verapdf.wasm')).arrayBuffer();
  const validator = await createValidator({ wasm });
  self.onmessage = event => {
    const started = performance.now();
    let report, error;
    try { report = validator.validate(event.data.pdf, { flavour: event.data.flavour }); } catch (cause) { error = { code: cause.code, message: cause.message }; }
    self.postMessage({ id: event.data.id, report, error, ms: performance.now() - started });
  };
  let refusesEval = true;
  try { new Function('return 1')(); refusesEval = false; } catch { /* refused, as the policy says */ }
  self.postMessage({ ready: true, refusesEval, globals: Object.getOwnPropertyNames(globalThis).filter(name => !before.has(name) && name !== 'onmessage') });
} catch (error) {
  self.postMessage({ failed: `${error.code ?? error.name}: ${error.message}` });
}
