// Module worker for the manual browser check: starts one validator and answers {id, pdf, flavour} messages.
import { createValidator } from '/packages/verapdf-wasm/dist/index.js';

const wasm = await (await fetch('/packages/verapdf-wasm/generated/verapdf.wasm')).arrayBuffer();
const validator = await createValidator({ wasm });
self.onmessage = event => {
  const started = performance.now();
  let report, error;
  try { report = validator.validate(event.data.pdf, { flavour: event.data.flavour }); } catch (cause) { error = `${cause.code}: ${cause.message}`; }
  self.postMessage({ id: event.data.id, report, error, ms: performance.now() - started });
};
self.postMessage({ ready: true });
