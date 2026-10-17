// Shapes of the JSON files the tools read. Types only: importers use `import type`, which Node erases, so this file
// is never loaded at run time. It exists for `tsc -p tools/tsconfig.json` (part of `npm run build`).

/** compiler-source.json: the pinned compiler source, tools and expected output hashes. */
export interface CompilerPin {
  repository: string;
  revision: string;
  rust: string;
  wasmBindgen: string;
  cargoAbout: string;
  crate: string;
  target: string;
  features: string[];
  profile: string;
  crateType: string;
  cargoProfile: { optLevel: string; lto: string; codegenUnits: number };
  wasmOpt: boolean;
  wasmSha256: string;
  loaderSha256: string;
}

/** packages/wasm/generated/provenance.json: what tools/build-wasm.ts recorded about the build it ran. */
export interface Provenance {
  revision: string;
  target: string;
  profile: string;
  crateType: string;
  wasmOpt: boolean;
  cargoProfile: CompilerPin['cargoProfile'];
  cargoProfileEnv: Record<string, string>;
  cargoLockSha256: string;
  reproducibleBuild: {
    sourceDateEpoch: number;
    remappedPathPrefixes: string[];
    rustStdSourcePrefix: string;
  };
  wasm: { bytes: number; gzip9Bytes: number; sha256: string };
  loaderSha256: string;
}

/** The part of `cargo metadata --no-deps` output that the tools read. */
export interface CargoMetadata {
  packages: { name: string; version: string; manifest_path: string }[];
}
