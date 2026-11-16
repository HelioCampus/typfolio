// Checks the WebAssembly build of veraPDF against unmodified veraPDF on the JVM: every sample PDF under every
// flavour must give the same report: the verdict, the number of assertions, the profile, and each failed rule with its
// count, description, tags and listed checks (the order of failed rules is not compared). Then the same for copies of the files with damaged
// stream data, where an error must be the same error.
//
//   node tools/check-verapdf-parity.ts [<directory of sample PDFs>]     (default: .build/test-output, written by npm test)
//
// The JVM side puts the pinned jars before our classes on the class path, so it runs veraPDF's own Flate filter and
// JAXB's own Util, not the shadowed ones the image is built with.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capture, classpath, graalvmHome, root, verifiedJars, work } from './verapdf-source.ts';

const DAMAGED_FLAVOURS = ['ua1', '2b'];
const DAMAGED_VARIANTS = 4;
const FLAVOURS = ['ua1', 'ua2', '1a', '1b', '2a', '2b', '2u', '3a', '3b', '3u', '4', '4e', '4f', 'wt1a', 'wt1r'];
const samples = resolve(process.argv[2] ?? join(root, '.build/test-output'));
const pdfs = readdirSync(samples).filter(name => name.endsWith('.pdf')).sort().map(name => join(samples, name));
if (pdfs.length === 0) throw new Error(`No sample PDFs in ${samples}. Run npm test first, or pass a directory.`);
const classes = join(work, 'classes');
if (!existsSync(join(classes, 'Validate.class'))) throw new Error('No compiled entry in .build/verapdf/classes. Run npm run build:verapdf.');

interface Report { error?: string; compliant: boolean; totalAssertions: number; profile: unknown;
  failedRules: { specification: string; clause: string; test: number; failedChecks: number; message: string; object: string; condition: string; tags: string[]; checks: { context: string; error: string }[] }[] }
const stable = (value: unknown) => JSON.stringify(value).replace(/(usedGlyphs\[\d+\]\([^()]*? \d+ \d+ )\d+( \d+ (?:true|false)\))/g, '$1#$2');
const normalise = (json: string) => {
  const report: Report = JSON.parse(json);
  if (report.error) return `error: ${report.error}`;
  // Everything in the report, with the rules in a fixed order; a rule's checks stay in veraPDF's order. veraPDF
  // names a glyph in a context by, among other things, a number that is not derived from the file:
  // `usedGlyphs[0](Font Font 1 0 234952919 0 true)`. It was the same in two JVM runs and another one in the image,
  // where it also changes from call to call, as an object's default hash code would. That number is left out.
  return stable([report.compliant, report.totalAssertions, report.profile,
    report.failedRules.map(rule => JSON.stringify([`${rule.specification} ${rule.clause}-${rule.test} x${rule.failedChecks}`, rule.message, rule.object, rule.condition, rule.tags, rule.checks])).sort()]);
};

const generated = join(root, 'packages/verapdf-wasm/generated');
const { instantiate }: { instantiate(wasm: Uint8Array): Promise<(request: { pdf: string; flavour: string; maxChecksPerRule: number }) => unknown> } =
  await import(pathToFileURL(join(generated, 'verapdf.js')).href);
const entry = await instantiate(readFileSync(join(generated, 'verapdf.wasm')));
// The same limit as the JVM entry's default, so that the listed checks can be compared too.
const validate = (pdf: string, flavour: string) => entry({ pdf, flavour, maxChecksPerRule: 20 });
// The entry takes one UTF-16 code unit per byte.
const encoded = pdfs.map(path => readFileSync(path).toString('latin1'));
const java = join(graalvmHome(), 'bin/java');
const jars = verifiedJars();
const jvmReports = (flavour: string, paths: string[]) => {
  const reports = capture(java, ['-cp', classpath(...jars, classes), 'Validate', flavour, ...paths], { maxBuffer: 256 * 1024 * 1024 }).split('\n');
  if (reports.length !== paths.length) throw new Error(`The JVM run for ${flavour} printed ${reports.length} reports for ${paths.length} files`);
  return reports;
};

let same = 0;
let different = 0;
const compare = (label: string, flavour: string, path: string, wasm: string, reference: string) => {
  if (wasm === reference) { same++; return; }
  different++;
  console.error(`DIFFERENT ${label} ${flavour} ${basename(path)}\n  wasm: ${wasm.slice(0, 500)}\n  jvm:  ${reference.slice(0, 500)}`);
};
for (const flavour of FLAVOURS) {
  const jvm = jvmReports(flavour, pdfs);
  pdfs.forEach((path, index) => {
    const wasm = normalise(String(validate(encoded[index]!, flavour)));
    // On intact files an error on both sides is not agreement: nothing was validated.
    if (wasm.startsWith('error')) { different++; console.error(`ERROR ${flavour} ${basename(path)}: ${wasm.slice(0, 500)}`); return; }
    compare('intact', flavour, path, wasm, normalise(jvm[index]!));
  });
}
console.log(`${same} of ${same + different} runs match (${pdfs.length} files x ${FLAVOURS.length} flavours)`);

// Which flavours each file declares, as veraPDF's parser reads them.
const detected = jvmReports('detect', pdfs);
let sameDetection = 0;
pdfs.forEach((path, index) => {
  const wasm = String(entry({ pdf: encoded[index]!, flavour: 'detect', maxChecksPerRule: 1 }));
  if (wasm === detected[index] && !wasm.includes('"error"')) { sameDetection++; return; }
  different++;
  console.error(`DIFFERENT detection ${basename(path)}\n  wasm: ${wasm.slice(0, 300)}\n  jvm:  ${detected[index]!.slice(0, 300)}`);
});
console.log(`${sameDetection} of ${pdfs.length} files declare the same flavours on both sides`);

// Damaged files: bytes inside stream data are overwritten, which mostly hits Flate-compressed content, fonts and
// metadata. Here the two sides must agree on whatever comes out, an error included: this is where the replacement
// inflater has to fail the way zlib does.
const damagedDirectory = join(work, 'damaged');
rmSync(damagedDirectory, { recursive: true, force: true });
mkdirSync(damagedDirectory, { recursive: true });
let state = 0x2545f491;
const random = (below: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % below; };
const damaged: string[] = [];
for (const path of pdfs) {
  const bytes = readFileSync(path);
  const streams: [number, number][] = [];
  for (let at = bytes.indexOf('stream\n'); at >= 0; at = bytes.indexOf('stream\n', at + 1)) {
    if (bytes.subarray(at - 3, at).toString('latin1') === 'end') continue;
    const end = bytes.indexOf('endstream', at);
    if (end - at > 40) streams.push([at + 7, end]);
  }
  if (streams.length === 0) continue;
  for (let variant = 0; variant < DAMAGED_VARIANTS; variant++) {
    const copy = Buffer.from(bytes);
    const hits = 1 + random(3);
    for (let hit = 0; hit < hits; hit++) {
      const [from, to] = streams[random(streams.length)]!;
      copy[from + random(to - from)] = random(256);
    }
    const name = join(damagedDirectory, `${basename(path, '.pdf')}-damaged-${variant}.pdf`);
    writeFileSync(name, copy);
    damaged.push(name);
  }
}
const before = same + different;
const sameBefore = same;
const damagedEncoded = damaged.map(path => readFileSync(path).toString('latin1'));
for (const flavour of DAMAGED_FLAVOURS) {
  const jvm = jvmReports(flavour, damaged);
  damaged.forEach((path, index) => compare('damaged', flavour, path, normalise(String(validate(damagedEncoded[index]!, flavour))), normalise(jvm[index]!)));
}
console.log(`${same - sameBefore} of ${same + different - before} runs on damaged files match (${damaged.length} files x ${DAMAGED_FLAVOURS.length} flavours)`);
if (different > 0) process.exit(1);
