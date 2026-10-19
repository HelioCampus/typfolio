// Generates two modules from the Typst package shipped in packages/core/typst-packages. The .typ/.toml
// files are the source of truth; the JavaScript packages cannot read files in the browser, so they embed their text.
//   packages/core/src/typst-package.generated.ts          typst.toml + lib.typ: what every runtime compile mounts.
//   packages/dev-tools/src/sample-source.generated.ts     sample.typ: only @typfolio/dev-tools imports it, so
//                                                         the runtime bundle never carries the sample builder.
// Run as the first step of `npm run build`.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const packagesDir = join(root, 'packages/core/typst-packages');
const output = join(root, 'packages/core/src/typst-package.generated.ts');
const sampleOutput = join(root, 'packages/dev-tools/src/sample-source.generated.ts');
const runtimeFiles = ['typst.toml', 'lib.typ'];
const devFiles = ['sample.typ'];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
}

const files = (await walk(packagesDir)).map(path => relative(packagesDir, path).split('\\').join('/')).sort();
const layout = /^([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/;
const ids = new Set(files.map(file => file.split('/').slice(0, 3).join('/')));
if (ids.size !== 1) throw new Error(`Expected exactly one package under ${packagesDir}, found: ${[...ids].join(', ') || 'none'}`);
const [namespace, name, version] = [...ids][0].split('/');
const contents: Record<string, string> = {};
for (const file of files) {
  const inner = layout.exec(file)?.[4];
  if (!inner) throw new Error(`Unexpected file outside <namespace>/<name>/<version>/: ${file}`);
  contents[inner] = await readFile(join(packagesDir, file), 'utf8');
}
const unassigned = Object.keys(contents).filter(file => ![...runtimeFiles, ...devFiles].includes(file));
if (unassigned.length) throw new Error(`Package files that are neither runtime nor dev-tools files: ${unassigned.join(', ')}; assign them in ${relative(root, fileURLToPath(import.meta.url))}`);
for (const file of [...runtimeFiles, ...devFiles]) if (!(file in contents)) throw new Error(`The package is missing ${file}`);
const toml = contents['typst.toml'] ?? '';
const field = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1];
if (field('name') !== name || field('version') !== version) {
  throw new Error(`typst.toml name/version (${field('name')}/${field('version')}) must match the directory ${namespace}/${name}/${version}`);
}

/**
 * What every app bundles, so only what the compiler reads: typst.toml's `[package]` name, version and
 * entrypoint, and lib.typ with its comment lines blanked (not removed, so a compile error's line
 * numbers still match the file). Editors read the files themselves, comments included.
 */
function runtimeFileContents(files: Readonly<Record<string, string>>): Record<string, string> {
  return {
    'typst.toml': files['typst.toml'].split('\n').filter(line => /^\s*(\[package\]|(name|version|entrypoint)\s*=)/.test(line)).join('\n') + '\n',
    'lib.typ': files['lib.typ'].split('\n').map(line => (/^\s*\/\//.test(line) ? '' : line)).join('\n'),
  };
}

const body = `// GENERATED FILE. Do not edit.
// Source of truth: packages/core/typst-packages/${posix.join(namespace, name, version)}/.
// Regenerate with \`node tools/generate-typst-package.mjs\` (the root \`npm run build\` does this first).

export const typfolioPackage = ${JSON.stringify({ namespace, name, version, files: runtimeFileContents(contents) }, null, 2)} as const;
`;
await writeFile(output, body);
const sampleBody = `// GENERATED FILE. Do not edit.
// Source of truth: packages/core/typst-packages/${posix.join(namespace, name, version)}/sample.typ.
// Only @typfolio/dev-tools may import this module; the runtime entry must never reach it.
// Regenerate with \`node tools/generate-typst-package.mjs\` (the root \`npm run build\` does this first).

export const sampleFile = 'sample.typ';
export const sampleSource = ${JSON.stringify(contents['sample.typ'])};
`;
await mkdir(dirname(sampleOutput), { recursive: true });
await writeFile(sampleOutput, sampleBody);
console.log(`Generated ${relative(root, output)} for @${namespace}/${name}:${version} (${runtimeFiles.length} runtime files) and ${relative(root, sampleOutput)}`);
