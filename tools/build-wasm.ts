// Builds Typfolio's Typst compiler (crates/compiler) for WebAssembly and generates packages/wasm/generated/: the binary,
// the wasm-bindgen loader and declarations, and provenance.json. Every input is pinned in compiler-source.json (the
// crate, the Typst version the lockfile must resolve, the Rust toolchain, wasm-bindgen, the release profile) and the
// output is reproducible: the pin also records the expected hashes, which tools/check-package.ts verifies.
//
//   npm run setup:wasm   # once: the pinned toolchain, wasm-bindgen-cli and cargo-about into .build/tools
//   npm run build:wasm
//
// CARGO_BUILD_JOBS sets Cargo's parallelism (default 4; it does not change the output). WASM_BINDGEN selects a
// wasm-bindgen binary of the pinned version. See docs/compiler-build.md.
import { spawnSync, type SpawnSyncOptions, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { compilerSourceSha256, lockedVersion } from './compiler-source.ts';
import type { CargoMetadata, CompilerPin } from './types.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const pin: CompilerPin = JSON.parse(readFileSync(join(root, 'compiler-source.json'), 'utf8'));
const build = join(root, '.build');
const output = join(root, 'packages/wasm/generated');
const cargoHome = resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
const rustupHome = resolve(process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'));
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
function run(cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): string;
function run(cmd: string, args: string[], options?: SpawnSyncOptions): Buffer;
function run(cmd: string, args: string[], options: SpawnSyncOptions = {}): string | Buffer {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${cmd} exited ${r.status}`);
  return r.stdout;
}
const capture = (cmd: string, args: string[], options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {}) =>
  run(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options }).trim();
function rustc(...args: string[]) { return capture('rustc', [`+${pin.rust}`, ...args]); }

// The source: the lockfile must resolve the pinned Typst, and every file the artifact is built from is hashed into the
// provenance, so tools/check-package.ts can tell an artifact that no longer matches the checkout.
for (const crate of ['typst', 'typst-pdf', 'typst-layout']) {
  const version = lockedVersion(root, crate);
  if (version !== pin.typst) throw new Error(`Cargo.lock resolves ${crate} ${version}, but compiler-source.json pins Typst ${pin.typst}`);
}
const sourceSha256 = compilerSourceSha256(root, pin);
const lockSha256 = sha256(readFileSync(join(root, 'Cargo.lock')));
// The crates the lockfile names, into Cargo's registry cache (a no-op when they are there); everything after this runs
// offline, so the lockfile alone decides what is compiled.
run('cargo', [`+${pin.rust}`, 'fetch', '--locked', '--target', pin.target]);
const metadata: CargoMetadata = JSON.parse(capture('cargo', [`+${pin.rust}`, 'metadata', '--locked', '--offline', '--format-version=1', '--no-deps'], { maxBuffer: 32 * 1024 * 1024 }));
const crate = metadata.packages.find(p => p.name === pin.crate);
if (!crate) throw new Error(`${pin.crate} is not a member of the workspace`);
if (resolve(crate.manifest_path) !== join(root, pin.crateDirectory, 'Cargo.toml')) throw new Error(`${pin.crate} is not at ${pin.crateDirectory}`);
const git = (() => {
  try {
    const commit = capture('git', ['rev-parse', 'HEAD']);
    const dirty = capture('git', ['status', '--porcelain', '--', 'Cargo.toml', 'Cargo.lock', pin.crateDirectory]) !== '';
    return { commit, dirty };
  } catch { return { commit: null, dirty: false }; }
})();

const bindgen = process.env.WASM_BINDGEN ?? join(build, 'tools/bin/wasm-bindgen');
const bindgenVersion = capture(bindgen, ['--version']);
if (bindgenVersion !== `wasm-bindgen ${pin.wasmBindgen}`) throw new Error(`Expected wasm-bindgen ${pin.wasmBindgen}, got ${bindgenVersion}`);

// Reproducibility: the build paths are remapped to stable virtual prefixes. The standard library is precompiled with
// `/rustc/<commit>/library/...` source paths; when the `rust-src` component is installed, rustc resolves them to the
// real toolchain directory instead, which would leak into panic locations. Mapping that directory back to the virtual
// prefix makes the output independent of whether `rust-src` is present. Later `--remap-path-prefix` entries take
// precedence over earlier ones.
const rustcCommit = rustc('-vV').match(/^commit-hash: ([0-9a-f]{40})$/m)?.[1];
if (!rustcCommit) throw new Error('Could not determine the rustc commit hash');
const toolchainSource = join(rustc('--print', 'sysroot'), 'lib/rustlib/src/rust');
const stdSourceRemap = [toolchainSource, `/rustc/${rustcCommit}`];
const pathRemapping = [
  [resolve(root), '/typfolio'],
  [cargoHome, '/cargo'],
  [rustupHome, '/rustup'],
  stdSourceRemap,
];

// The release profile comes only from the pin, never from the caller's environment or the workspace manifest.
const buildEnv = { ...process.env };
delete buildEnv.RUSTFLAGS;
for (const key of Object.keys(buildEnv)) if (key.startsWith('CARGO_PROFILE_')) delete buildEnv[key];
if (pin.profile !== 'release') throw new Error('The pinned cargoProfile is applied to the release profile only');
const profileEnv = {
  CARGO_PROFILE_RELEASE_OPT_LEVEL: String(pin.cargoProfile.optLevel),
  CARGO_PROFILE_RELEASE_LTO: String(pin.cargoProfile.lto),
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: String(pin.cargoProfile.codegenUnits),
  CARGO_PROFILE_RELEASE_PANIC: String(pin.cargoProfile.panic),
  CARGO_PROFILE_RELEASE_STRIP: String(pin.cargoProfile.strip),
};
Object.assign(buildEnv, profileEnv);
buildEnv.CARGO_ENCODED_RUSTFLAGS = pathRemapping.flatMap(([from, to]) => ['--remap-path-prefix', `${from}=${to}`]).join('\x1f');
buildEnv.CARGO_TARGET_DIR = join(build, 'target');
delete buildEnv.SOURCE_DATE_EPOCH; // Nothing in the toolchain embeds a build time; the output must not depend on the caller's value.

mkdirSync(build, { recursive: true });
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
// `cargo rustc --crate-type cdylib` (not `cargo build`): the crate declares rlib + cdylib, and Cargo skips LTO for such a
// unit, so the pinned `lto` would silently not apply. A cdylib-only unit gets real LTO.
const features = pin.features.length ? ['--no-default-features', '--features', pin.features.join(',')] : [];
run('cargo', [`+${pin.rust}`, 'rustc', '--locked', '--offline', '--release', '--target', pin.target, '-p', pin.crate, ...features,
  '-j', process.env.CARGO_BUILD_JOBS ?? '4', '--crate-type', pin.crateType], { env: buildEnv });
if (sha256(readFileSync(join(root, 'Cargo.lock'))) !== lockSha256) throw new Error('Cargo.lock changed');
run(bindgen, [join(build, 'target', pin.target, pin.profile, `${pin.crate.replaceAll('-', '_')}.wasm`),
  '--target', 'web', '--out-dir', output, '--out-name', 'compiler']);

// Explicit loading keeps bundlers from inlining the large WASM through a default URL: applications supply bytes, a
// compiled module, a Response, or a hosted URL.
const jsPath = join(output, 'compiler.js');
const generated = readFileSync(jsPath, 'utf8');
const defaultURL = "new URL('compiler_bg.wasm', import.meta.url)";
if (!generated.includes(defaultURL)) throw new Error('Generated loader changed; review explicit WASM loading patch');
writeFileSync(jsPath, '// Modified by Typfolio: require explicit WASM input; remove the default asset URL.\n' +
  generated.replace(defaultURL, "(() => { throw new Error('Pass WASM bytes, a module, or an explicit URL'); })()"));

const wasm = readFileSync(join(output, 'compiler_bg.wasm'));
const loader = readFileSync(jsPath);
for (const [path] of pathRemapping) {
  const bytes = Buffer.from(path);
  if (wasm.includes(bytes) || loader.includes(bytes)) throw new Error(`Generated compiler leaks an unremapped build path: ${path}`);
}
// The std source prefix must have been mapped back to its virtual `/rustc/<commit>` form.
for (const virtual of ['/rustup/toolchains', toolchainSource]) {
  if (wasm.includes(Buffer.from(virtual))) throw new Error(`Generated compiler contains an unmapped toolchain source path: ${virtual}`);
}
// The crate makes no JavaScript calls of its own, so the loader must not construct code: that is what lets a page load
// it under a Content Security Policy with only 'wasm-unsafe-eval'.
if (/\bnew Function\(|\beval\(/.test(loader.toString('utf8'))) throw new Error('Generated loader constructs JavaScript code; the compiler must not import js_sys::Function or eval');

// `wasmSha256` and `loaderSha256` in the pin are the expected output, checked by tools/check-package.ts; the provenance
// records the measured hashes below, so the expected values must not be copied into it.
const { wasmSha256: _expectedWasm, loaderSha256: _expectedLoader, ...pinnedBuild } = pin;
const provenance = {
  ...pinnedBuild,
  crateVersion: crate.version,
  typstPdf: lockedVersion(root, 'typst-pdf'),
  sourceSha256,
  cargoLockSha256: lockSha256,
  git,
  rustc: rustc('--version'),
  wasmBindgenVersion: bindgenVersion,
  cargoProfileEnv: profileEnv,
  reproducibleBuild: {
    remappedPathPrefixes: pathRemapping.slice(0, 3).map(([, to]) => to),
    rustStdSourcePrefix: stdSourceRemap[1],
  },
  generatedLoaderPatch: 'explicit WASM input; no default new URL',
  wasm: { bytes: wasm.length, gzip9Bytes: gzipSync(wasm, { level: 9 }).length, sha256: sha256(wasm) },
  loaderSha256: sha256(loader),
};
writeFileSync(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify(provenance, null, 2));

// Third-party notices for the package, generated by cargo-about from the Cargo.lock whose hash was just recorded.
run(process.execPath, [join(root, 'tools/generate-third-party-notices.ts')]);
