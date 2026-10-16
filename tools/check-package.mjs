import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const file = path => readFile(new URL(path, root));
const provenance = JSON.parse(await file('packages/wasm/generated/provenance.json'));
const pin = JSON.parse(await file('compiler-source.json'));
if (provenance.revision !== pin.revision) throw new Error('WASM source revision does not match the pin');
if (!Number.isSafeInteger(provenance.reproducibleBuild?.sourceDateEpoch) ||
    JSON.stringify(provenance.reproducibleBuild.remappedPathPrefixes) !== JSON.stringify(['/typfolio', '/cargo', '/rustup'])) {
  throw new Error('WASM provenance does not contain the required reproducible-build policy');
}
if (provenance.profile !== pin.profile || provenance.crateType !== pin.crateType || provenance.wasmOpt !== pin.wasmOpt ||
    JSON.stringify(provenance.cargoProfile) !== JSON.stringify(pin.cargoProfile)) {
  throw new Error('WASM provenance does not record the pinned build profile, crate type, and wasm-opt setting');
}
const profileEnv = {
  CARGO_PROFILE_RELEASE_OPT_LEVEL: String(pin.cargoProfile.optLevel),
  CARGO_PROFILE_RELEASE_LTO: String(pin.cargoProfile.lto),
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: String(pin.cargoProfile.codegenUnits),
};
if (JSON.stringify(provenance.cargoProfileEnv) !== JSON.stringify(profileEnv)) {
  throw new Error('WASM provenance cargo profile environment does not match the pinned profile');
}
if (!/^\/rustc\/[0-9a-f]{40}$/.test(provenance.reproducibleBuild.rustStdSourcePrefix ?? '')) {
  throw new Error('WASM provenance does not record the remapped Rust standard library source prefix');
}
for (const [path, expected] of [['compiler_bg.wasm', provenance.wasm.sha256], ['compiler.js', provenance.loaderSha256]]) {
  const hash = createHash('sha256').update(await file(`packages/wasm/generated/${path}`)).digest('hex');
  if (hash !== expected) throw new Error(`${path} does not match build provenance`);
}
// The pinned hashes make a rebuild prove it reproduces the artifact that was reviewed. A mismatch means a different
// toolchain, platform or dependency resolution produced other bytes, or the pin was not updated after a deliberate
// compiler change (see "Rebuild" in docs/compiler-build.md).
for (const [label, key, actual] of [['compiler_bg.wasm', 'wasmSha256', provenance.wasm.sha256], ['compiler.js', 'loaderSha256', provenance.loaderSha256]]) {
  if (!/^[0-9a-f]{64}$/.test(pin[key] ?? '')) throw new Error(`compiler-source.json must pin ${key}`);
  if (actual !== pin[key]) {
    throw new Error(`The build is not reproducing the pinned artifact: ${label} is ${actual} but compiler-source.json pins ${key} ${pin[key]}. ` +
      'If the compiler was changed on purpose, update the pins in the same commit; otherwise the toolchain, platform or dependencies differ from the pinned build.');
  }
}
for (const path of ['compiler.d.ts', 'LICENSE.typst-ts']) {
  await access(new URL(`packages/wasm/generated/${path}`, root));
}
console.log('WASM package artifact hashes, pinned artifact hashes, pinned build profile, reproducible-build policy, declarations, and upstream license verified.');
