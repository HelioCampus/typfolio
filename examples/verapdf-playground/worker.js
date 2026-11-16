// One veraPDF validator in a module worker: {id, name, pdf, flavour} in, {id, report | error, ms} out.
import { createValidator } from '/packages/verapdf-wasm/dist/index.js';

try {
  const started = performance.now();
  const wasm = await (await fetch('/packages/verapdf-wasm/generated/verapdf.wasm')).arrayBuffer();
  const validator = await createValidator({ wasm });
  self.onmessage = event => {
    const from = performance.now();
    let report, error;
    try { report = validator.validate(event.data.pdf, { flavour: event.data.flavour }); } catch (cause) { error = cause.message; }
    self.postMessage({ id: event.data.id, report, error, ms: performance.now() - from });
  };
  self.postMessage({ ready: true, ms: performance.now() - started, megabytes: wasm.byteLength / 1e6 });
} catch (error) {
  self.postMessage({ failed: error.message });
}
