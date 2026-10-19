import { typfolioPackage } from './typst-package.generated.js';

const { namespace, name, version, files } = typfolioPackage;

/** The only Typst package core serves, as written in an import: `@local/typfolio:0.1.0`. */
export const bundledPackageSpec = `@${namespace}/${name}:${version}`;
/** Virtual directory reserved for core's own files; requests cannot use paths under it. */
export const reservedDirectory = '/@typfolio';
export const bundledPackageDirectory = `${reservedDirectory}/packages/${namespace}/${name}/${version}`;

export const isReservedPath = (path: string) => path === reservedDirectory || path.startsWith(`${reservedDirectory}/`);

/** Answers the compiler's package registry hook: the virtual directory, or an error naming what is supported. */
export function resolvePackage(spec: { namespace?: string; name?: string; version?: string } | string): string {
  if (typeof spec === 'object' && spec !== null && spec.namespace === namespace && spec.name === name && spec.version === version) {
    return bundledPackageDirectory;
  }
  const requested = typeof spec === 'string' ? spec : `@${spec?.namespace}/${spec?.name}:${spec?.version}`;
  // A string, not an Error: the binding wraps a thrown Error together with its JS stack trace in the diagnostic.
  throw `Only ${bundledPackageSpec} is available; remote Typst packages are not supported (requested ${requested})`;
}

const encoder = new TextEncoder();

/** The package sources as mounts in its virtual directory. */
export function packageFileMounts(): [string, Uint8Array][] {
  return Object.entries(files).map(([file, source]): [string, Uint8Array] => [`${bundledPackageDirectory}/${file}`, encoder.encode(source)]);
}

/** `sys.inputs` entry that tells the helper it is running under Typfolio: `input()` then reads the mounted data. */
export const runtimeMarker: [string, string] = ['typfolio', version];
