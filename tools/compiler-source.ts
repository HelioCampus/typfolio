// The source a compiler artifact is built from, as one hash: the workspace manifest, the lockfile and every file of the
// compiler crate. tools/build-wasm.ts records it in provenance.json and tools/check-package.ts recomputes it, so an
// artifact built from other sources than the checkout is detected; CI caches the artifact by the same files.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { CompilerPin } from './types.ts';

/** The files, as paths relative to the repository root with forward slashes, sorted. */
export function compilerSourceFiles(root: string, pin: CompilerPin): string[] {
  const files: string[] = ['Cargo.toml', 'Cargo.lock'];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(join(root, pin.crateDirectory));
  return files;
}

/** SHA-256 over the relative path and contents of each file, in order. */
export function compilerSourceSha256(root: string, pin: CompilerPin): string {
  const hash = createHash('sha256');
  for (const file of compilerSourceFiles(root, pin)) {
    hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0');
  }
  return hash.digest('hex');
}

/** The version a crate is locked at in the workspace's Cargo.lock, or undefined. */
export function lockedVersion(root: string, crate: string): string | undefined {
  const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
  return new RegExp(`\\[\\[package\\]\\]\\nname = "${crate.replaceAll('-', '\\-')}"\\nversion = "([^"]+)"`).exec(lock)?.[1];
}
