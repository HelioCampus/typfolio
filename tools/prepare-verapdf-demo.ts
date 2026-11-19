// Puts the veraPDF validator where the demo site (site) serves it from: public/verapdf/, which
// Vite copies into the static output. The site's Vite config runs this at the start of every dev server and build.
//
// Nothing of the validator goes through the site's bundle: the page starts public/verapdf/worker.js as a module
// worker by URL, and that worker imports the package's own files beside it. So a checkout without the validator
// (`npm run build:verapdf` has not been run; CI) still builds the site. Then public/verapdf/ is removed, and the
// page says the validator is not part of the build.
//
// What is written:
// - verapdf.wasm.gz: the binary, gzipped. Cloudflare takes files up to 25 MiB and the binary is larger; the worker
//   unpacks it in the browser and checks it against the hash in manifest.json.
// - manifest.json: the versions, sizes and SHA-256 of the binary, from its build provenance.
// - dist/, generated/verapdf.js, worker.js: the package's API, its loader, and the site's worker.
// - LICENSE, LICENSE-APACHE, THIRD_PARTY_NOTICES.md, licenses/, java/: what has to travel with the binary, and the
//   source of the veraPDF file that is modified (see packages/verapdf-wasm/LICENSE).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = join(root, 'packages/verapdf-wasm');
const site = join(root, 'site');
const target = join(site, 'public/verapdf');

export interface VerapdfDemoManifest {
  verapdf: string;
  graalvm: string;
  wasmBytes: number;
  gzipBytes: number;
  wasmSha256: string;
}

/** Writes public/verapdf/ and returns its manifest, or removes it and returns undefined when there is no validator. */
export function prepareVerapdfDemo(): VerapdfDemoManifest | undefined {
  const binary = join(pkg, 'generated/verapdf.wasm');
  const provenancePath = join(pkg, 'generated/provenance.json');
  if (![binary, provenancePath, join(pkg, 'generated/verapdf.js'), join(pkg, 'dist/index.js'), join(pkg, 'generated/licenses/oracle-graalvm/LICENSE.txt')].every(path => existsSync(path))) {
    rmSync(target, { recursive: true, force: true });
    return undefined;
  }
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  const wasm = readFileSync(binary);
  const wasmSha256 = createHash('sha256').update(wasm).digest('hex');
  if (wasmSha256 !== provenance.wasm.sha256) throw new Error('packages/verapdf-wasm/generated/verapdf.wasm does not match its provenance. Run npm run build:verapdf -- --force.');

  // Unchanged since the last run: gzipping 30 MB takes seconds, and the dev server starts often.
  const manifestPath = join(target, 'manifest.json');
  const previous: Partial<VerapdfDemoManifest> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  const keep = previous.wasmSha256 === wasmSha256 && existsSync(join(target, 'verapdf.wasm.gz'));
  const gzip = keep ? readFileSync(join(target, 'verapdf.wasm.gz')) : gzipSync(wasm, { level: 9 });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'verapdf.wasm.gz'), gzip);
  const manifest: VerapdfDemoManifest = { verapdf: provenance.verapdf, graalvm: `${provenance.graalvm.distribution} ${provenance.graalvm.version}`, wasmBytes: wasm.length, gzipBytes: gzip.length, wasmSha256 };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // The worker imports ./dist/index.js, which imports ../generated/verapdf.js: the package's own layout.
  cpSync(join(pkg, 'dist/index.js'), join(target, 'dist/index.js'));
  cpSync(join(pkg, 'generated/verapdf.js'), join(target, 'generated/verapdf.js'));
  cpSync(join(site, 'verapdf/worker.js'), join(target, 'worker.js'));
  for (const name of ['LICENSE', 'LICENSE-APACHE']) cpSync(join(pkg, name), join(target, `${name}.txt`));
  cpSync(join(pkg, 'generated/THIRD_PARTY_NOTICES.md'), join(target, 'THIRD_PARTY_NOTICES.md'));
  cpSync(join(pkg, 'generated/licenses'), join(target, 'licenses'), { recursive: true });
  cpSync(join(pkg, 'java'), join(target, 'java'), { recursive: true });
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = prepareVerapdfDemo();
  console.log(manifest ? `site/public/verapdf: veraPDF ${manifest.verapdf}, ${(manifest.gzipBytes / 1e6).toFixed(1)} MB gzipped` : 'No validator built: site/public/verapdf removed.');
}
