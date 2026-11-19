// Verifies packages/verapdf-wasm/generated/ before it is tested or packed: the files match the hashes in
// provenance.json, and the provenance matches the pins in verapdf-source.json and the sources in the checkout.
//
// Unlike the compiler (tools/check-package.ts), the output hashes are not pinned: two GraalVM Web Image builds of the
// same inputs do not give the same bytes (see "Reproducibility" in docs/verapdf-build.md). What the binary does is
// checked by tools/check-verapdf-parity.ts instead.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyNotices } from './verapdf-notices.ts';
import { pin, root, sha256, verapdfSourceSha256 } from './verapdf-source.ts';
import type { VerapdfProvenance } from './types.ts';

const generated = join(root, 'packages/verapdf-wasm/generated');
const provenance: VerapdfProvenance = JSON.parse(readFileSync(join(generated, 'provenance.json'), 'utf8'));
if (provenance.sourceSha256 !== verapdfSourceSha256()) {
  throw new Error('The veraPDF artifact was built from other sources than this checkout (verapdf-source.json, the Java sources or the native-image metadata changed). Run npm run build:verapdf.');
}
if (provenance.verapdf !== pin.verapdf || JSON.stringify(provenance.artifacts) !== JSON.stringify(pin.artifacts)) throw new Error('veraPDF provenance does not record the pinned jars');
if (provenance.graalvm.version !== pin.graalvm.version || provenance.graalvm.distribution !== pin.graalvm.distribution || provenance.binaryen !== pin.binaryen) {
  throw new Error('veraPDF provenance does not record the pinned GraalVM and Binaryen');
}
for (const [name, expected] of [['verapdf.wasm', provenance.wasm.sha256], ['verapdf.js', provenance.launcherSha256]]) {
  if (sha256(readFileSync(join(generated, name))) !== expected) throw new Error(`${name} does not match build provenance`);
}
// The licence texts and the third-party list the build wrote are all there, unchanged, and nothing else is.
verifyNotices(generated, provenance.notices);
// The loader must not construct code: a page may then load it under a Content Security Policy that allows only
// 'wasm-unsafe-eval'.
if (/\bnew Function\(|\beval\(/.test(readFileSync(join(generated, 'verapdf.js'), 'utf8'))) throw new Error('verapdf.js constructs JavaScript code');
for (const [key, actual] of [['wasmSha256', provenance.wasm.sha256], ['launcherSha256', provenance.launcherSha256]] as const) {
  if (pin[key] !== null && pin[key] !== actual) throw new Error(`verapdf-source.json pins ${key} ${pin[key]}, but the build produced ${actual}`);
}
console.log('veraPDF artifact hashes, pinned jars and tools, source hash, licence and notice files and CSP-safe loader verified.');
