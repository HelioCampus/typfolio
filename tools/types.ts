// Shapes of the JSON files the tools read. Types only: importers use `import type`, which Node erases, so this file
// is never loaded at run time. It exists for `tsc -p tools/tsconfig.json` (part of `npm run build`).

/** compiler-source.json: the pinned compiler crate, Typst version, tools, build profile and expected output hashes. */
export interface CompilerPin {
  /** The workspace crate that is built: `typfolio-compiler`. */
  crate: string;
  /** Its directory, relative to the repository root; every file in it is part of the source the artifact is built from. */
  crateDirectory: string;
  /** The Typst version the lockfile must resolve. */
  typst: string;
  rust: string;
  wasmBindgen: string;
  cargoAbout: string;
  target: string;
  features: string[];
  profile: string;
  crateType: string;
  cargoProfile: { optLevel: string; lto: string; codegenUnits: number; panic: string; strip: string };
  wasmOpt: boolean;
  wasmSha256: string;
  loaderSha256: string;
}

/** packages/wasm/generated/provenance.json: what tools/build-wasm.ts recorded about the build it ran. */
export interface Provenance {
  crate: string;
  crateVersion: string;
  crateDirectory: string;
  typst: string;
  typstPdf: string;
  rust: string;
  wasmBindgen: string;
  target: string;
  features: string[];
  profile: string;
  crateType: string;
  wasmOpt: boolean;
  cargoProfile: CompilerPin['cargoProfile'];
  cargoProfileEnv: Record<string, string>;
  /** SHA-256 over the source the binary was built from: the workspace manifest, the lockfile and the crate's files. */
  sourceSha256: string;
  cargoLockSha256: string;
  git: { commit: string | null; dirty: boolean };
  rustc: string;
  wasmBindgenVersion: string;
  reproducibleBuild: {
    remappedPathPrefixes: string[];
    rustStdSourcePrefix: string;
  };
  generatedLoaderPatch: string;
  wasm: { bytes: number; gzip9Bytes: number; sha256: string };
  loaderSha256: string;
}

/** The part of `cargo metadata` output that the tools read. */
export interface CargoMetadata {
  packages: { name: string; version: string; manifest_path: string }[];
}
