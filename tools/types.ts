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

/** verapdf-source.json: the pinned veraPDF jars, GraalVM, Binaryen, build inputs and expected output hashes. */
export interface VerapdfPin {
  /** The veraPDF library version; every `org.verapdf` artifact must be at it. */
  verapdf: string;
  mavenRepository: string;
  /**
   * The jars on the build class path, in order, each with the SHA-256 of the file and the licence it is used under,
   * as an SPDX expression: the choice made where a jar offers several (veraPDF: MPL, not GPL; the JAXB API: CDDL).
   * The build refuses a licence that tools/build-verapdf.ts does not know how to give notice for.
   */
  artifacts: { group: string; artifact: string; version: string; sha256: string; license: string }[];
  graalvm: {
    distribution: string;
    /** `GRAALVM_VERSION` in the distribution's `release` file. */
    version: string;
    java: string;
    /** Per `${process.platform}-${process.arch}`: the archive, its hash (null until someone has verified one) and
     *  the path of the Java home inside the unpacked archive. */
    archives: Record<string, { url: string; sha256: string | null; home: string }>;
  };
  /** The Binaryen release whose `wasm-as` assembles the module. */
  binaryen: string;
  sourceDirectory: string;
  metadataDirectory: string;
  mainClass: string;
  initializeAtBuildTime: string[];
  /** Further native-image arguments, after `--tool:svm-wasm`. */
  nativeImageArgs: string[];
  /** Expected output hashes; null until a build has been shown to reproduce. */
  wasmSha256: string | null;
  launcherSha256: string | null;
}

/** packages/verapdf-wasm/generated/provenance.json: what tools/build-verapdf.ts recorded about the build it ran. */
export interface VerapdfProvenance {
  verapdf: string;
  artifacts: VerapdfPin['artifacts'];
  graalvm: { distribution: string; version: string; java: string; platform: string; nativeImage: string };
  binaryen: string;
  wasmAs: string;
  mainClass: string;
  initializeAtBuildTime: string[];
  nativeImageArgs: string[];
  sourceSha256: string;
  git: { commit: string | null; dirty: boolean };
  wasm: { bytes: number; gzip9Bytes: number; sha256: string };
  launcherSha256: string;
  /** The files under generated/licenses and THIRD_PARTY_NOTICES.md, each with its SHA-256. */
  notices: Record<string, string>;
}
