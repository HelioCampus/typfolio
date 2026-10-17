// Generates two files for @typfolio/wasm from the output of cargo-about (https://github.com/EmbarkStudios/cargo-about):
//   - packages/wasm/THIRD_PARTY_NOTICES.md: the Rust crates in the dependency graph of the compiled crate for
//     the wasm target, with the SPDX `license` expression each crate declares in its Cargo.toml.
//   - packages/wasm/THIRD_PARTY_LICENSES.md: the licence texts those crates are used under, grouped by identical
//     text, followed by the NOTICE files the crates ship.
//
// cargo-about does the real work: it resolves the dependency graph for the target and features (tools/about.toml
// and the flags below), satisfies every crate's licence expression against the `accepted` list in that file
// (an unlisted licence makes it fail, and so does this script), and harvests the licence texts from the crate
// sources, falling back to the standard SPDX text for crates that ship none. This script only renders its JSON.
//
// The tool is installed by `npm run setup:wasm` (version `cargoAbout` in compiler-source.json) and this script runs
// at the end of `npm run build:wasm`. It checks that the SHA-256 of the pinned upstream Cargo.lock equals the
// `cargoLockSha256` recorded in packages/wasm/generated/provenance.json, so the files describe the shipped binary.
//
//   npm run notices:wasm
//
// `CARGO_ABOUT=/absolute/path/to/cargo-about` selects another binary; its version is checked.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CargoMetadata, CompilerPin, Provenance } from './types.ts';

// The part of `cargo about generate --format json` output that this script reads.
interface AboutPackage {
  name: string;
  version: string;
  authors: string[];
  manifest_path: string;
  source?: string | null;
  license?: string | null;
  license_file?: string | null;
}
interface AboutLicense {
  id: string;
  text: string;
  source_path?: string | null;
  used_by: { crate: { name: string; version: string } }[];
}
interface AboutOutput {
  crates: { package: AboutPackage }[];
  licenses: AboutLicense[];
}
interface Crate {
  name: string;
  version: string;
  authors: string[];
  dir: string;
  registry: boolean;
  license: string | undefined;
  origin: string;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const pin: CompilerPin = JSON.parse(readFileSync(join(root, 'compiler-source.json'), 'utf8'));
const source = join(root, '.build/upstream');
const provenance: Provenance = JSON.parse(readFileSync(join(root, 'packages/wasm/generated/provenance.json'), 'utf8'));
const cargoHome = resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
const aboutBinary = process.env.CARGO_ABOUT ?? join(root, '.build/tools/bin/cargo-about');

const lockSha = createHash('sha256').update(readFileSync(join(source, 'Cargo.lock'))).digest('hex');
if (lockSha !== provenance.cargoLockSha256) {
  throw new Error(`Cargo.lock sha256 ${lockSha} does not match packages/wasm/generated/provenance.json (${provenance.cargoLockSha256}). Re-run build:wasm first.`);
}

// cargo-about runs `cargo metadata` itself: use the pinned toolchain whatever the caller's default is.
const env = { ...process.env, RUSTUP_TOOLCHAIN: pin.rust, PATH: [join(cargoHome, 'bin'), process.env.PATH].filter(Boolean).join(delimiter) };
function run(command: string, args: string[], options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {}) {
  const r = spawnSync(command, args, { cwd: source, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'], ...options });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${command} exited ${r.status}`);
  return r.stdout;
}
const aboutVersion = run(aboutBinary, ['--version']).trim();
if (aboutVersion !== `cargo-about ${pin.cargoAbout}`) throw new Error(`Expected cargo-about ${pin.cargoAbout}, got ${aboutVersion}. Run npm run setup:wasm.`);
const metadata: CargoMetadata = JSON.parse(run('cargo', [`+${pin.rust}`, 'metadata', '--locked', '--offline', '--format-version=1', '--no-deps']));
const manifest = metadata.packages.find(p => p.name === pin.crate)?.manifest_path;
if (!manifest) throw new Error(`${pin.crate} is not in the upstream workspace`);
const about: AboutOutput = JSON.parse(run(aboutBinary, ['about', 'generate', '--format', 'json', '--fail', '--locked',
  '--manifest-path', manifest, '--config', join(root, 'tools/about.toml'),
  '--no-default-features', '--features', pin.features.join(' ')]));
if (sha256Of(join(source, 'Cargo.lock')) !== lockSha) throw new Error('Cargo.lock changed');
function sha256Of(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

// ---- crates ----------------------------------------------------------------------------------
const byCrate = (a: Crate, b: Crate) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true });
const escape = (text: string) => text.replaceAll('|', '\\|');
const crates: Crate[] = about.crates.map(({ package: p }) => ({
  name: p.name, version: p.version, authors: p.authors, dir: dirname(p.manifest_path), registry: p.source?.startsWith('registry+') ?? false,
  license: p.license ?? (p.license_file ? `see ${p.license_file} in the crate` : undefined),
  origin: p.source?.startsWith('registry+') ? 'crates.io' : p.source?.startsWith('git+') ? p.source.replace(/^git\+/, '').replace(/[?#].*$/, '') : 'typst.ts workspace',
})).sort(byCrate);
const noLicense = crates.filter(crate => !crate.license);
if (noLicense.length) throw new Error(`No licence declared by: ${noLicense.map(crate => `${crate.name} ${crate.version}`).join(', ')}`);

const notices = [
  '# Third-party notices for @typfolio/wasm',
  '',
  'The WebAssembly compiler in this package is built from Typst, typst.ts and the Rust crates listed below.',
  'Typst and typst.ts are licensed under the Apache License, Version 2.0; see `LICENSE.typst-ts` in',
  '`generated/` and the `NOTICE` file in this package.',
  '',
  '<!-- Generated by tools/generate-third-party-notices.mjs. Do not edit by hand. -->',
  '',
  `- Generated: ${generated()}`,
  `- Source: ${aboutVersion} (\`tools/about.toml\`) for \`${pin.crate}\` (typst.ts revision \`${provenance.revision}\`, features \`${pin.features.join(',')}\`, no default features) resolved for \`${provenance.target}\``,
  `- Cargo.lock SHA-256: \`${lockSha}\``,
  '- cargo-about lists every crate in that dependency graph, which includes proc-macro crates and their dependencies. These run on the host while compiling and are not linked into the binary; they are listed anyway, so the list may be longer than the set of crates compiled into the WebAssembly.',
  '- The licence column is the `license` field of each crate\'s `Cargo.toml` (an SPDX expression). The licence texts and copyright notices are in `THIRD_PARTY_LICENSES.md`.',
  `- ${crates.length} crates.`,
  '',
  '| Crate | Version | Licence | Origin |',
  '| --- | --- | --- | --- |',
  ...crates.map(crate => `| ${escape(crate.name)} | ${escape(crate.version)} | ${escape(crate.license!)} | ${escape(crate.origin)} |`),
  '',
].join('\n');

// ---- licence texts -----------------------------------------------------------------------------
const normalise = (text: string) => text.replace(/^﻿/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
const fence = (text: string) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
const authorsOf = (crate: Crate) => crate.authors.length ? crate.authors.join(', ') : 'no authors listed in Cargo.toml';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const crateKey = (crate: { name: string; version: string }) => `${crate.name} ${crate.version}`;
const known = new Map<string, Crate>(crates.map(crate => [crateKey(crate), crate]));
const lookup = ({ name, version }: { name: string; version: string }) => known.get(`${name} ${version}`) ?? (() => { throw new Error(`cargo-about reports a licence for ${name} ${version}, which is not in its crate list`); })();

// cargo-about already groups by identical text; texts differing only in line endings or outer whitespace are merged here.
const groups = new Map<string, { text: string; ids: Set<string>; files: Set<string | undefined>; standard: boolean; crates: Map<string, Crate> }>(); // normalised text -> { text, ids:Set, files:Set, standard, crates:Map }
for (const license of about.licenses) {
  const text = normalise(license.text);
  if (!groups.has(text)) groups.set(text, { text, ids: new Set(), files: new Set(), standard: false, crates: new Map() });
  const group = groups.get(text)!;
  group.ids.add(license.id);
  if (license.source_path) group.files.add(license.source_path.split(/[\\/]/).at(-1)); else group.standard = true;
  for (const { crate } of license.used_by) group.crates.set(crateKey(crate), lookup(crate));
}
const covered = new Set([...groups.values()].flatMap(group => [...group.crates.keys()]));
const uncovered = crates.filter(crate => !covered.has(crateKey(crate)));
if (uncovered.length) throw new Error(`cargo-about produced no licence text for: ${uncovered.map(crateKey).join(', ')}`);
const ordered = [...groups.values()].sort((a, b) => b.crates.size - a.crates.size || (sha(a.text) < sha(b.text) ? -1 : 1));

// NOTICE files (Apache-2.0 section 4(d) requires them to travel with the work; cargo-about only keeps licence texts).
// A crate takes the NOTICE* files of its own directory; a crate in a git checkout or workspace falls back to the
// root of that workspace (the nearest ancestor with a Cargo.lock), where Cargo workspaces keep theirs.
const noticeName = /^notice(\.|$)/i;
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
function noticeFiles(dir: string) {
  return readdirSync(dir).filter(name => noticeName.test(name) && isFile(join(dir, name))).sort().map(name => join(dir, name));
}
function noticesOf(crate: Crate) {
  const own = noticeFiles(crate.dir);
  if (own.length || crate.registry) return own;
  for (let up = dirname(crate.dir); up !== dirname(up); up = dirname(up)) {
    if (isFile(join(up, 'Cargo.lock'))) return noticeFiles(up);
  }
  return [];
}
const noticeGroups = new Map<string, { text: string; files: Set<string | undefined>; crates: Map<string, Crate> }>(); // normalised text -> { text, files:Set, crates:Map }
for (const crate of crates) {
  for (const file of noticesOf(crate)) {
    const text = normalise(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)));
    if (!text) continue;
    if (!noticeGroups.has(text)) noticeGroups.set(text, { text, files: new Set(), crates: new Map() });
    const group = noticeGroups.get(text)!;
    group.files.add(file.split(/[\\/]/).at(-1));
    group.crates.set(crateKey(crate), crate);
  }
}
const orderedNotices = [...noticeGroups.values()].sort((a, b) => b.crates.size - a.crates.size || (sha(a.text) < sha(b.text) ? -1 : 1));

const licenses = [
  '# Third-party licence texts for @typfolio/wasm',
  '',
  '<!-- Generated by tools/generate-third-party-notices.mjs. Do not edit by hand. -->',
  '',
  '- Generated by `tools/generate-third-party-notices.mjs` from the JSON output of ' + `${aboutVersion}.`,
  `- Generated: ${generated()}`,
  `- Cargo.lock SHA-256: \`${lockSha}\``,
  `- Scope: the ${crates.length} Rust crates listed with their SPDX expressions in \`THIRD_PARTY_NOTICES.md\` (the dependency graph of \`${pin.crate}\` for \`${provenance.target}\`, which also contains proc-macro crates that only run on the host).`,
  `- ${ordered.length} distinct licence texts cover all ${crates.length} crates. For a crate that offers a choice ("MIT OR Apache-2.0") the first licence in the \`accepted\` list of \`tools/about.toml\` is the one listed; a crate that needs several licences appears under each.`,
  '- Each text is the licence file found in the crate source, reproduced unmodified apart from trimming and line-ending normalisation, listed with the `authors` field of each crate\'s `Cargo.toml`. Where a crate ships no licence file (or keeps it in a workspace root), cargo-about uses the standard SPDX text of the licence the crate declares. Such a text has no crate-specific copyright line, and a text marked "standard SPDX text" below was used for at least one crate in its list; the other crates in the list have an identical file or none.',
  `- ${orderedNotices.length} NOTICE texts shipped by ${new Set(orderedNotices.flatMap(group => [...group.crates.keys()])).size} crates follow the licence texts.`,
  '',
  '## Licence texts',
  '',
];
ordered.forEach((group, index) => {
  const marks = fence(group.text);
  licenses.push(`### Text ${index + 1} of ${ordered.length}`, '');
  licenses.push(`Licence: ${[...group.ids].sort().join(', ')}`, '');
  const files = [...group.files].sort().map(name => `\`${name}\``);
  if (group.standard) files.push('standard SPDX text');
  licenses.push(`Files: ${files.join(', ')}`, '');
  licenses.push('Used by:', '');
  for (const crate of [...group.crates.values()].sort(byCrate)) licenses.push(`- ${crate.name} ${crate.version} (${authorsOf(crate)})`);
  licenses.push('', marks, group.text, marks, '');
});
licenses.push('## NOTICE files', '');
orderedNotices.forEach((group, index) => {
  const marks = fence(group.text);
  licenses.push(`### Notice ${index + 1} of ${orderedNotices.length}`, '');
  licenses.push(`Files: ${[...group.files].sort().map(name => `\`${name}\``).join(', ')}`, '');
  licenses.push('Shipped by:', '');
  for (const crate of [...group.crates.values()].sort(byCrate)) licenses.push(`- ${crate.name} ${crate.version} (${authorsOf(crate)})`);
  licenses.push('', marks, group.text, marks, '');
});

writeFileSync(join(root, 'packages/wasm/THIRD_PARTY_NOTICES.md'), notices);
writeFileSync(join(root, 'packages/wasm/THIRD_PARTY_LICENSES.md'), licenses.join('\n'));
console.log(`Wrote THIRD_PARTY_NOTICES.md: ${crates.length} crates.`);
console.log(`Wrote THIRD_PARTY_LICENSES.md: ${ordered.length} licence texts (${ordered.filter(group => group.standard).length} include a standard SPDX text), ${orderedNotices.length} NOTICE texts.`);

function generated() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  return (epoch ? new Date(Number(epoch) * 1000) : new Date()).toISOString().slice(0, 10);
}
