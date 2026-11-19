// Checks the plain Java inflater that replaces java.util.zip.Inflater in the WebAssembly build of veraPDF
// (packages/verapdf-wasm/java/org/verapdf/cos/filters/PureInflater.java), on the JVM, where both exist:
//
// 1. PureInflater and java.util.zip.Inflater are driven with the same calls over valid, damaged and random zlib
//    streams, and every result, exception, written byte and count of remaining input must be the same.
// 2. The same streams are decoded through COSFilterFlateDecode, once with veraPDF's own class (the jars first on the
//    class path) and once with the shadowed one, and what comes out must be the same.
//
//   node tools/check-verapdf-inflater.ts [<cases> [<seed>]]     (default: 4000 cases, seed 1)
//
// The harness is packages/verapdf-wasm/java-test/org/verapdf/cos/filters/InflaterFuzz.java. Part of
// `npm run check:verapdf`.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { capture, classpath, graalvmHome, javaSources, root, run, verifiedJars, work } from './verapdf-source.ts';

const cases = process.argv[2] ?? '4000';
const seed = process.argv[3] ?? '1';
const home = graalvmHome();
const jars = verifiedJars();
const classes = join(work, 'inflater-test');
rmSync(classes, { recursive: true, force: true });
mkdirSync(classes, { recursive: true });
run(join(home, 'bin/javac'), ['-nowarn', '-cp', classpath(...jars), '-d', classes,
  ...javaSources().filter(file => file.includes('/org/verapdf/cos/filters/')),
  join(root, 'packages/verapdf-wasm/java-test/org/verapdf/cos/filters/InflaterFuzz.java')], { stdio: ['ignore', 'inherit', 'ignore'] });

const java = join(home, 'bin/java');
const fuzz = (mode: string, ...path: string[]) =>
  capture(java, ['-cp', classpath(...path), 'org.verapdf.cos.filters.InflaterFuzz', mode, seed, cases], { maxBuffer: 256 * 1024 * 1024 });

let summary: string;
try { summary = fuzz('inflater', classes, ...jars); } catch (error) {
  // The harness prints the first difference and exits 1.
  console.error(`PureInflater differs from java.util.zip.Inflater (cases ${cases}, seed ${seed}); run the harness to see the case: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
console.log(`inflater: ${summary}`);

const shadowed = fuzz('filter', classes, ...jars).split('\n');
const original = fuzz('filter', ...jars, classes).split('\n');
const different = shadowed.filter((line, index) => line !== original[index]);
if (shadowed.length !== original.length || different.length > 0) {
  console.error(`COSFilterFlateDecode: ${different.length} of ${shadowed.length} streams decode differently, first: ${different[0]}`);
  process.exit(1);
}
const failed = original.filter(line => line.includes(' IOException ')).length;
console.log(`filter: ${original.length} streams decode identically through veraPDF's class and the shadowed one (${failed} end in an IOException in both)`);
