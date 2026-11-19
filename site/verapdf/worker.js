// The demo site's veraPDF worker, served as it is at /verapdf/worker.js (tools/prepare-verapdf-demo.ts copies it
// there, beside the validator's own files). A module worker: it fetches the gzipped binary, unpacks it, checks it
// against the manifest's hash, and then validates what it is sent. Files never leave the page.
//
//   in:  { id, pdf: Uint8Array, flavour: 'declared' | 'detect' | <flavour id> }
//   out: { ready: true, ms } | { failed: message } | { progress: fraction } | { id, reports, ms } |
//        { id, flavours, ms } | { id, error, ms }
import { createValidator } from './dist/index.js';

async function binary(manifest) {
  const response = await fetch(new URL('./verapdf.wasm.gz', import.meta.url));
  if (!response.ok) throw new Error(`the validator could not be fetched (HTTP ${response.status})`);
  // Read in pieces, to say how far along the download is.
  const total = Number(response.headers.get('content-length')) || manifest.gzipBytes;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    self.postMessage({ progress: Math.min(received / total, 1) });
  }
  let bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  // A server may already have undone the gzip (Content-Encoding); the first bytes say which it is.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== manifest.wasmSha256) throw new Error('the validator that was fetched is not the one this site was built with');
  return bytes;
}

try {
  const started = performance.now();
  const manifest = await (await fetch(new URL('./manifest.json', import.meta.url))).json();
  const validator = await createValidator({ wasm: await binary(manifest) });
  self.onmessage = event => {
    const from = performance.now();
    const { id, pdf, flavour } = event.data;
    try {
      // 'detect' asks which flavours the file declares; 'declared' validates against each of them.
      if (flavour === 'detect') return self.postMessage({ id, flavours: validator.detectFlavours(pdf), ms: performance.now() - from });
      const reports = flavour === 'declared' ? validator.validateDeclared(pdf) : [validator.validate(pdf, { flavour })];
      self.postMessage({ id, reports, ms: performance.now() - from });
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error), ms: performance.now() - from });
    }
  };
  self.postMessage({ ready: true, ms: performance.now() - started });
} catch (error) {
  self.postMessage({ failed: error instanceof Error ? error.message : String(error) });
}
