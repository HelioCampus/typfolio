// Shared by the veraPDF tools (setup-verapdf, trace-verapdf, build-verapdf, check-verapdf-package): the pin in
// verapdf-source.json, where the pinned inputs live under .build/verapdf, and the checks that what is there is what
// the pin names. See docs/verapdf-build.md.
import { spawnSync, type SpawnSyncOptions, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VerapdfPin } from './types.ts';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const pin: VerapdfPin = JSON.parse(readFileSync(join(root, 'verapdf-source.json'), 'utf8'));
export const work = join(root, '.build/verapdf');
export const jarDirectory = join(work, 'jars');
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export function run(cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): string;
export function run(cmd: string, args: string[], options?: SpawnSyncOptions): Buffer;
export function run(cmd: string, args: string[], options: SpawnSyncOptions = {}): string | Buffer {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${cmd} exited ${r.status}`);
  return r.stdout;
}
export const capture = (cmd: string, args: string[], options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {}) =>
  run(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options }).trim();

export const jarName = (a: VerapdfPin['artifacts'][number]) => `${a.artifact}-${a.version}.jar`;
export const jarUrl = (a: VerapdfPin['artifacts'][number]) =>
  `${pin.mavenRepository}/${a.group.replaceAll('.', '/')}/${a.artifact}/${a.version}/${jarName(a)}`;

/** The pinned jars, in pin order, after checking that each is present with the pinned hash. */
export function verifiedJars(): string[] {
  return pin.artifacts.map(artifact => {
    const path = join(jarDirectory, jarName(artifact));
    if (!existsSync(path)) throw new Error(`${jarName(artifact)} is missing. Run npm run setup:verapdf.`);
    const actual = sha256(readFileSync(path));
    if (actual !== artifact.sha256) throw new Error(`${jarName(artifact)} is ${actual}, but verapdf-source.json pins ${artifact.sha256}`);
    return path;
  });
}

/** The key of this machine in `graalvm.archives`. */
export const platform = `${process.platform}-${process.arch}`;

/** GRAALVM_HOME, or the copy that setup-verapdf unpacked; its `release` file must name the pinned distribution and version. */
export function graalvmHome(): string {
  const archive = pin.graalvm.archives[platform];
  const home = process.env.GRAALVM_HOME ?? join(work, 'graalvm', archive?.home ?? '.');
  const release = join(home, 'release');
  if (!existsSync(release)) throw new Error(`No GraalVM at ${home}. Run npm run setup:verapdf, or set GRAALVM_HOME.`);
  const text = readFileSync(release, 'utf8');
  const version = /^GRAALVM_VERSION="([^"]+)"$/m.exec(text)?.[1];
  const implementor = /^IMPLEMENTOR="([^"]+)"$/m.exec(text)?.[1];
  if (version !== pin.graalvm.version) throw new Error(`GraalVM at ${home} is ${version}, but verapdf-source.json pins ${pin.graalvm.version}`);
  // The Community Edition binary has no WebAssembly backend (checked for 25.5), so the distribution is part of the pin.
  if (implementor !== 'Oracle Corporation') throw new Error(`GraalVM at ${home} is from "${implementor}"; the pin is ${pin.graalvm.distribution}`);
  return home;
}

/** Binaryen's assembler (WASM_AS, or `wasm-as` on PATH), after checking that it is the pinned version. */
export function wasmAs(): string {
  const binary = process.env.WASM_AS ?? 'wasm-as';
  let version: string;
  try { version = capture(binary, ['--version']); } catch { throw new Error(`Binaryen's wasm-as was not found (${binary}). Install Binaryen ${pin.binaryen}, or set WASM_AS.`); }
  if (!new RegExp(`^wasm-as version ${pin.binaryen}( |$)`).test(version)) throw new Error(`Expected Binaryen ${pin.binaryen}, got "${version}"`);
  return binary;
}

function walk(directory: string, files: string[]) {
  if (!existsSync(directory)) return; // the metadata directory, before the first trace
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(relative(root, path).split(sep).join('/'));
  }
}

/** Everything of ours the artifact is built from: the pin, the Java sources and the native-image metadata. Sorted. */
export function verapdfSourceFiles(): string[] {
  const files = ['verapdf-source.json'];
  walk(join(root, pin.sourceDirectory), files);
  walk(join(root, pin.metadataDirectory), files);
  return files;
}

/** SHA-256 over the relative path and contents of each source file, in order. The pinned output hashes are left out. */
export function verapdfSourceSha256(): string {
  const hash = createHash('sha256');
  for (const file of verapdfSourceFiles()) {
    let content: string | Buffer = readFileSync(join(root, file));
    if (file === 'verapdf-source.json') {
      const { wasmSha256: _wasm, launcherSha256: _launcher, ...inputs } = JSON.parse(content.toString('utf8')) as VerapdfPin;
      content = JSON.stringify(inputs);
    }
    hash.update(file).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}

export const javaSources = () => verapdfSourceFiles().filter(file => file.endsWith('.java')).map(file => join(root, file));
export const classpath = (...entries: string[]) => entries.join(delimiter);
