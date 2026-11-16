// Builds veraPDF's validator for WebAssembly with GraalVM Web Image and generates packages/verapdf-wasm/generated/:
// the binary, an ES module loader made from GraalVM's JavaScript launcher, and provenance.json. Every input is pinned in verapdf-source.json (the
// veraPDF jars by hash, Oracle GraalVM, Binaryen); the Java entry and the two shadowed classes are in
// packages/verapdf-wasm/java, and what the image may reach by reflection is the checked-in metadata in
// packages/verapdf-wasm/native-image (tools/trace-verapdf.ts regenerates it; the build never traces).
//
//   npm run setup:verapdf   # once: the pinned jars and GraalVM into .build/verapdf
//   npm run build:verapdf   # does nothing when the artifact is already built from these inputs; -- --force rebuilds
//
// See docs/verapdf-build.md.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { capture, classpath, graalvmHome, javaSources, pin, platform, root, run, sha256, verapdfSourceSha256, verifiedJars, wasmAs, work } from './verapdf-source.ts';
import { verifyNotices, writeNotices } from './verapdf-notices.ts';
import type { VerapdfProvenance } from './types.ts';

const home = graalvmHome();
const jars = verifiedJars();
const assembler = wasmAs();
const assemblerVersion = capture(assembler, ['--version']);
const metadata = join(root, pin.metadataDirectory);
if (!existsSync(join(metadata, 'META-INF/native-image/reachability-metadata.json'))) throw new Error(`${pin.metadataDirectory} has no reachability metadata. Run npm run trace:verapdf.`);
const sourceSha256 = verapdfSourceSha256();
const git = (() => {
  try {
    const commit = capture('git', ['rev-parse', 'HEAD']);
    const dirty = capture('git', ['status', '--porcelain', '--', 'verapdf-source.json', pin.sourceDirectory, pin.metadataDirectory]) !== '';
    return { commit, dirty };
  } catch { return { commit: null, dirty: false }; }
})();

const classes = join(work, 'classes');
const image = join(work, 'image');
const output = join(root, 'packages/verapdf-wasm/generated');

// A build takes most of a minute and does not reproduce its bytes, so one that is already there for these exact
// inputs is kept: same source hash (the pin, the Java sources, the metadata), same tool versions, and files that
// still match the hashes recorded with them. `--force` builds anyway.
if (!process.argv.includes('--force')) {
  try {
    const previous: VerapdfProvenance = JSON.parse(readFileSync(join(output, 'provenance.json'), 'utf8'));
    const current = previous.sourceSha256 === sourceSha256 && previous.graalvm.version === pin.graalvm.version && previous.graalvm.platform === platform &&
      previous.wasmAs === assemblerVersion && sha256(readFileSync(join(output, 'verapdf.wasm'))) === previous.wasm.sha256 &&
      sha256(readFileSync(join(output, 'verapdf.js'))) === previous.launcherSha256 && existsSync(join(classes, 'Validate.class'));
    if (current) verifyNotices(output, previous.notices);
    if (current) {
      console.log(`packages/verapdf-wasm/generated is up to date with its sources (${sourceSha256.slice(0, 12)}); nothing built. Pass --force to build anyway.`);
      process.exit(0);
    }
  } catch { /* no artifact yet, or an unreadable one: build */ }
}
for (const directory of [classes, image, output]) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
}

// Our classes come first on the class path: two of them shadow classes in the jars (JAXB's Util, veraPDF's Flate
// filter), which only works while they win the lookup.
run(join(home, 'bin/javac'), ['-parameters', '-cp', classpath(...jars), '-d', classes, ...javaSources()]);
// `--tool:svm-wasm` must be the first argument. The assembler is found on PATH, so its directory is put there.
const env = { ...process.env };
if (process.env.WASM_AS) env.PATH = `${join(process.env.WASM_AS, '..')}:${env.PATH}`;
run(join(home, 'bin/native-image'), ['--tool:svm-wasm', `--initialize-at-build-time=${pin.initializeAtBuildTime.join(',')}`, ...pin.nativeImageArgs,
  '-cp', classpath(classes, metadata, ...jars), '-o', 'verapdf', pin.mainClass], { cwd: image, env });

// GraalVM's launcher is a classic script that starts the VM as soon as it is loaded, finds its binary next to its own
// file name, and leaves what the Java side exports in globals. It is turned into an ES module with one export,
// `instantiate(wasm)`, which starts a VM of its own from the bytes or compiled module it is given and resolves to
// the exported function. Each patch names the exact text it expects, so a GraalVM update that changes the launcher
// fails here instead of producing a loader that half works.
const original = readFileSync(join(image, 'verapdf.js'), 'utf8');
const replaceOnce = (text: string, from: string, to: string, what: string) => {
  if (text.split(from).length !== 2) throw new Error(`Generated launcher changed (${what}); review the loader patches in tools/build-verapdf.ts`);
  return text.replace(from, () => to);
};
// 1. Drop the trailing block that reads the command line and starts the VM.
const autorun = original.lastIndexOf('\n(function() {\n');
if (autorun < 0 || !/GraalVM\.run\(load_cmd_args\(\),\s*config\)/.test(original.slice(autorun))) throw new Error('Generated launcher changed (start-up block); review the loader patches in tools/build-verapdf.ts');
let body = original.slice(0, autorun);
// 2. Take the binary from the caller, not from a path derived from the script's own URL.
body = replaceOnce(body,
  `    const wasmPath = config.wasm_path || runtime.getCurrentFile() + ".wasm";
    const file = await runtime.fetchData(wasmPath);
    const result = await WebAssembly.instantiate(file, wasmImports);`,
  `    const result = config.wasm instanceof WebAssembly.Module
        ? { instance: await WebAssembly.instantiate(config.wasm, wasmImports) }
        : await WebAssembly.instantiate(config.wasm, wasmImports);`, 'loading the binary');
// 3. The Java entry hands its function to `typfolioVerapdfExport` (packages/verapdf-wasm/java/WasmMain.java).
if (body.split('typfolioVerapdfExport(fn);').length !== 2) throw new Error('The launcher does not contain the export call of WasmMain exactly once');
const loaderSource = `// Generated by tools/build-verapdf.ts from GraalVM Web Image's launcher (its licence header is kept below).
// Modified by Typfolio: an ES module that starts one VM per call from an explicit binary; no start on load, no
// default binary URL, no globals.
/**
 * @param {BufferSource | WebAssembly.Module} wasm
 * @returns {Promise<(request: { pdf: string, flavour: string, maxChecksPerRule: number }) => unknown>} the validator entry; \`pdf\` has one code unit per byte
 */
export async function instantiate(wasm) {
let typfolioVerapdfExported;
const typfolioVerapdfExport = fn => { typfolioVerapdfExported = fn; };
${body}
const config = new GraalVM.Config();
config.wasm = wasm;
await GraalVM.run([], config);
if (typeof typfolioVerapdfExported !== 'function') throw new Error('The veraPDF image started without exporting its entry');
return typfolioVerapdfExported;
}
`;
// The loader must not construct code, so that a page can load it under a Content Security Policy that allows
// 'wasm-unsafe-eval' without 'unsafe-eval'.
if (/\bnew Function\(|\beval\(/.test(loaderSource)) throw new Error('The generated loader constructs JavaScript code');
writeFileSync(join(output, 'verapdf.js'), loaderSource);
writeFileSync(join(output, 'verapdf.d.ts'), `/** Starts a veraPDF VM from the binary. The entry takes the PDF as a string with one UTF-16 code unit per byte. */
export function instantiate(wasm: BufferSource | WebAssembly.Module): Promise<(request: { pdf: string; flavour: string; maxChecksPerRule: number }) => unknown>;
`);
copyFileSync(join(image, 'verapdf.js.wasm'), join(output, 'verapdf.wasm'));
writeFileSync(join(output, '.gitkeep'), '');

const wasm = readFileSync(join(output, 'verapdf.wasm'));
const launcher = readFileSync(join(output, 'verapdf.js'));
for (const path of [root.replace(/\/$/, ''), home]) {
  if (wasm.includes(Buffer.from(path)) || launcher.includes(Buffer.from(path))) throw new Error(`The generated image contains a local build path: ${path}`);
}

// The licence texts and the third-party list that have to travel with the binary.
const notices = writeNotices(home, jars, output);

const provenance: VerapdfProvenance = {
  verapdf: pin.verapdf,
  artifacts: pin.artifacts,
  graalvm: { distribution: pin.graalvm.distribution, version: pin.graalvm.version, java: pin.graalvm.java, platform,
    nativeImage: capture(join(home, 'bin/native-image'), ['--version']).split('\n')[0] },
  binaryen: pin.binaryen,
  wasmAs: assemblerVersion,
  mainClass: pin.mainClass,
  initializeAtBuildTime: pin.initializeAtBuildTime,
  nativeImageArgs: pin.nativeImageArgs,
  sourceSha256,
  git,
  wasm: { bytes: wasm.length, gzip9Bytes: gzipSync(wasm, { level: 9 }).length, sha256: sha256(wasm) },
  launcherSha256: sha256(launcher),
  notices,
};
writeFileSync(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ ...provenance, artifacts: `${provenance.artifacts.length} jars`, notices: `${Object.keys(notices).length} licence and notice files` }, null, 2));
