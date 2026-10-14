import { TypstPdfError } from './types.js';

export interface TemplateFromFilesOptions {
  /** Folder prefix to remove from every key. Defaults to the longest directory prefix shared by all keys. */
  base?: string;
  /** Passed through unchanged when given; otherwise omitted so core's `main.typ` default applies. */
  entrypoint?: string;
}

export interface TemplateFiles {
  entrypoint?: string;
  files: Record<string, string>;
}

const invalid = (message: string): never => { throw new TypstPdfError('INVALID_REQUEST', message); };

// Bundlers key a glob by './folder/file.typ' or '/folder/file.typ'; '../' stays so it can be a prefix.
const relative = (path: string) => path.replace(/^\.\//, '').replace(/^\/+/, '');

/**
 * Turns the result of a bundler glob of `.typ` files (for example Vite's
 * `import.meta.glob('./report/**\/*.typ', { query: '?raw', import: 'default', eager: true })`)
 * into a `PdfTemplate`. Keys become virtual paths relative to the template folder. Only the key
 * shape and value types are checked here; path rules, the reserved `/input.json` and a missing
 * entrypoint are rejected by the compiler. Pure: no file-system or bundler APIs.
 */
export function templateFromFiles(
  files: Readonly<Record<string, string>>,
  options: TemplateFromFilesOptions = {},
): TemplateFiles {
  if (!files || typeof files !== 'object' || Array.isArray(files)) invalid('templateFromFiles needs a record of file path to source string');
  const entries = Object.entries(files);
  if (!entries.length) invalid('templateFromFiles received no files; check that the glob pattern matches the template folder');
  for (const [key, source] of entries) {
    if (typeof source !== 'string') {
      invalid(`Template file ${key} is ${source === null ? 'null' : typeof source}, not a string. ` +
        "Load files with { query: '?raw', import: 'default', eager: true }: a lazy glob yields functions, " +
        "and a glob without import: 'default' yields module objects.");
    }
  }
  const keys = entries.map(([key]) => relative(key));
  let prefix: string[];
  if (options.base !== undefined) {
    if (typeof options.base !== 'string') invalid('templateFromFiles base must be a string');
    prefix = relative(options.base).split('/').filter(part => part && part !== '.');
    entries.forEach(([key], i) => {
      const parts = keys[i].split('/');
      if (!prefix.every((part, at) => parts[at] === part) || parts.length <= prefix.length) {
        invalid(`Template file ${key} is not under base ${options.base}`);
      }
    });
  } else {
    const directories = keys.map(key => key.split('/').slice(0, -1));
    prefix = directories[0];
    for (const directory of directories) {
      let shared = 0;
      while (shared < prefix.length && prefix[shared] === directory[shared]) shared += 1;
      prefix = prefix.slice(0, shared);
    }
  }
  const normalised = new Map<string, string>();
  entries.forEach(([key, source], i) => {
    const path = keys[i].split('/').slice(prefix.length).join('/');
    if (!path) invalid(`Template file ${key} has an empty path`);
    if (normalised.has(path)) invalid(`Template files collide on ${path}: ${key} duplicates another key`);
    normalised.set(path, source as string);
  });
  const template: TemplateFiles = { files: Object.fromEntries(normalised) };
  if (options.entrypoint !== undefined) template.entrypoint = options.entrypoint;
  return template;
}
