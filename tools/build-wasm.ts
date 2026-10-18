import { spawnSync, type SpawnSyncOptions, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { CargoMetadata, CompilerPin } from './types.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const pin: CompilerPin = JSON.parse(readFileSync(join(root, 'compiler-source.json'), 'utf8'));
const build = join(root, '.build');
const source = join(build, 'upstream');
const output = join(root, 'packages/wasm/generated');
const cargoHome = resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
const rustupHome = resolve(process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'));
// The standard library is precompiled with `/rustc/<commit>/library/...` source paths. When the `rust-src`
// component is installed, rustc resolves them to the real toolchain directory instead, which would leak
// into panic locations. Mapping that directory back to the virtual prefix makes the output independent of
// whether `rust-src` is present. Later `--remap-path-prefix` entries take precedence over earlier ones.
function rustc(...args: string[]) {
  const r = spawnSync('rustc', [`+${pin.rust}`, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`rustc exited ${r.status}`);
  return r.stdout.trim();
}
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
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
function run(cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): string;
function run(cmd: string, args: string[], options?: SpawnSyncOptions): Buffer;
function run(cmd: string, args: string[], options: SpawnSyncOptions = {}): string | Buffer {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${cmd} exited ${r.status}`);
  return r.stdout;
}
mkdirSync(build, { recursive: true });
mkdirSync(output, { recursive: true });
const local = process.env.TYPST_TS_SOURCE;
const repo = local ? resolve(local) : join(build, 'source.git');
if (!local) {
  if (!existsSync(repo)) run('git', ['init', '--bare', repo]);
  run('git', ['-C', repo, 'fetch', '--depth=1', pin.repository, pin.revision]);
}
// Export the exact commit; never build a reference checkout's uncommitted changes.
const archive = run('git', ['-C', repo, 'archive', pin.revision], { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
const sourceDateEpoch = Number(run('git', ['-C', repo, 'show', '-s', '--format=%ct', pin.revision], {
  stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8',
}).trim());
if (!Number.isSafeInteger(sourceDateEpoch)) throw new Error('Could not determine the pinned source timestamp');
// A fresh export prevents stale source files from influencing a build.
const { rmSync } = await import('node:fs');
rmSync(source, { recursive: true, force: true });
mkdirSync(source, { recursive: true });
run('tar', ['-x', '-C', source], { input: archive, stdio: ['pipe', 'inherit', 'inherit'] });
const lockBefore = sha256(readFileSync(join(source, 'Cargo.lock')));
const bindgen = process.env.WASM_BINDGEN ?? join(build, 'tools/bin/wasm-bindgen');
const bindgenVersion = run(bindgen, ['--version'], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim();
if (bindgenVersion !== `wasm-bindgen ${pin.wasmBindgen}`) throw new Error(`Expected wasm-bindgen ${pin.wasmBindgen}, got ${bindgenVersion}`);
const buildEnv = { ...process.env };
delete buildEnv.RUSTFLAGS;
// The release profile comes only from the pin, never from the caller's environment.
for (const key of Object.keys(buildEnv)) if (key.startsWith('CARGO_PROFILE_')) delete buildEnv[key];
buildEnv.CARGO_PROFILE_RELEASE_OPT_LEVEL = String(pin.cargoProfile.optLevel);
buildEnv.CARGO_PROFILE_RELEASE_LTO = String(pin.cargoProfile.lto);
buildEnv.CARGO_PROFILE_RELEASE_CODEGEN_UNITS = String(pin.cargoProfile.codegenUnits);
if (pin.profile !== 'release') throw new Error('The pinned cargoProfile is applied to the release profile only');
buildEnv.CARGO_ENCODED_RUSTFLAGS = pathRemapping
  .flatMap(([from, to]) => ['--remap-path-prefix', `${from}=${to}`])
  .join('\x1f');
buildEnv.CARGO_TARGET_DIR = join(build, 'target');
buildEnv.SOURCE_DATE_EPOCH = String(sourceDateEpoch);
// `cargo rustc --crate-type` (not `cargo build`): the crate declares rlib + cdylib, and Cargo skips LTO for
// such a unit, so the pinned `lto` would silently not apply. A cdylib-only unit gets real LTO.
run('cargo', [`+${pin.rust}`, 'rustc', '--locked', '--release', '--target', pin.target, '-p', pin.crate,
  '--no-default-features', '--features', pin.features.join(','), '-j', process.env.CARGO_BUILD_JOBS ?? '4',
  '--crate-type', pin.crateType], {
  cwd: source, env: buildEnv,
});
if (sha256(readFileSync(join(source, 'Cargo.lock'))) !== lockBefore) throw new Error('Cargo.lock changed');
run(bindgen, [join(build, 'target', pin.target, pin.profile, 'typst_ts_web_compiler.wasm'),
  '--target', 'web', '--out-dir', output, '--out-name', 'compiler']);
// Explicit loading keeps bundlers from inlining the large WASM through a default URL.
const jsPath = join(output, 'compiler.js');
const generated = readFileSync(jsPath, 'utf8');
const defaultURL = "new URL('compiler_bg.wasm', import.meta.url)";
if (!generated.includes(defaultURL)) throw new Error('Generated loader changed; review explicit WASM loading patch');
writeFileSync(jsPath, '// Modified by Typfolio: require explicit WASM input; remove the default asset URL.\n' +
  generated.replace(defaultURL, "(() => { throw new Error('Pass WASM bytes, a module, or an explicit URL'); })()"));
copyFileSync(join(source, 'LICENSE'), join(output, 'LICENSE.typst-ts'));
const metadata: CargoMetadata = JSON.parse(run('cargo', [`+${pin.rust}`, 'metadata', '--locked', '--offline', '--format-version=1', '--no-deps'], {
  cwd: source, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
}));
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
// `wasmSha256` and `loaderSha256` in the pin are the expected output, checked by tools/check-package.ts; the provenance
// records the measured hashes below, so the expected values must not be copied into it.
const { wasmSha256: _expectedWasm, loaderSha256: _expectedLoader, ...pinnedBuild } = pin;
const provenance = {
  ...pinnedBuild, cargoLockSha256: lockBefore,
  rustc: run('rustc', [`+${pin.rust}`, '--version'], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim(),
  wasmBindgenVersion: bindgenVersion,
  upstreamManifestVersion: metadata.packages.find(p => p.name === pin.crate)!.version,
  cargoProfileEnv: Object.fromEntries(Object.entries(buildEnv).filter(([key]) => key.startsWith('CARGO_PROFILE_'))),
  reproducibleBuild: {
    sourceDateEpoch,
    remappedPathPrefixes: pathRemapping.slice(0, 3).map(([, to]) => to),
    rustStdSourcePrefix: stdSourceRemap[1],
  },
  generatedLoaderPatch: 'explicit WASM input; no default new URL',
  wasm: { bytes: wasm.length, gzip9Bytes: gzipSync(wasm, { level: 9 }).length, sha256: sha256(wasm) },
  loaderSha256: sha256(readFileSync(jsPath)),
};
writeFileSync(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify(provenance, null, 2));

// Third-party notices for the package, generated by cargo-about from the Cargo.lock whose hash was just recorded.
run(process.execPath, [join(root, 'tools/generate-third-party-notices.ts')]);
