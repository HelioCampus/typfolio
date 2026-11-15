// Fetches the pinned inputs of the veraPDF WebAssembly build into .build/verapdf: the jars named in
// verapdf-source.json from Maven Central, and Oracle GraalVM for this platform. Every download is checked against the
// pinned SHA-256 before it is used; a file that is already there with the right hash is kept.
//
//   npm run setup:verapdf
//
// GRAALVM_HOME skips the GraalVM download (the build checks its version). Binaryen is not installed here: put the
// pinned `wasm-as` on PATH (macOS: `brew install binaryen`) or set WASM_AS. Downloading Oracle GraalVM means accepting
// the GraalVM Free Terms and Conditions. See docs/verapdf-build.md.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { graalvmHome, jarDirectory, jarName, jarUrl, pin, platform, run, sha256, verifiedJars, wasmAs, work } from './verapdf-source.ts';

async function download(url: string, path: string, expected: string) {
  if (existsSync(path) && sha256(readFileSync(path)) === expected) return;
  console.log(`fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${basename(path)} from ${url} is ${actual}, but verapdf-source.json pins ${expected}`);
  writeFileSync(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
}

for (const artifact of pin.artifacts) {
  if (artifact.group === 'org.verapdf' && artifact.version !== pin.verapdf) throw new Error(`${artifact.artifact} is pinned at ${artifact.version}, not veraPDF ${pin.verapdf}`);
}
mkdirSync(jarDirectory, { recursive: true });
for (const artifact of pin.artifacts) await download(jarUrl(artifact), join(jarDirectory, jarName(artifact)), artifact.sha256);
verifiedJars();

if (!process.env.GRAALVM_HOME) {
  const archive = pin.graalvm.archives[platform];
  if (!archive) throw new Error(`verapdf-source.json has no GraalVM archive for ${platform}. Set GRAALVM_HOME to ${pin.graalvm.distribution} ${pin.graalvm.version}.`);
  if (!archive.sha256) throw new Error(`verapdf-source.json does not pin a SHA-256 for the ${platform} GraalVM archive yet. Verify one and add it, or set GRAALVM_HOME.`);
  const target = join(work, 'graalvm');
  let present = false;
  try { graalvmHome(); present = true; } catch { /* not there, or another version: unpack below */ }
  if (!present) {
    const tarball = join(work, 'downloads', basename(new URL(archive.url).pathname));
    mkdirSync(join(work, 'downloads'), { recursive: true });
    await download(archive.url, tarball, archive.sha256);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    run('tar', ['-xzf', tarball, '-C', target, '--strip-components=1']);
  }
}
console.log(`GraalVM ${pin.graalvm.version} at ${graalvmHome()}; ${wasmAs()} is Binaryen ${pin.binaryen}; ${pin.artifacts.length} jars verified.`);
