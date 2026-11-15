// Checks the WebAssembly build of veraPDF against unmodified veraPDF on the JVM: every sample PDF under every
// flavour must give the same verdict, the same number of assertions and the same failed rules with the same number of
// failed checks (the order of failed rules is not compared).
//
//   node tools/check-verapdf-parity.ts [<directory of sample PDFs>]     (default: .build/test-output, written by npm test)
//
// The JVM side puts the pinned jars before our classes on the class path, so it runs veraPDF's own Flate filter and
// JAXB's own Util, not the shadowed ones the image is built with.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capture, classpath, graalvmHome, root, verifiedJars, work } from './verapdf-source.ts';

const FLAVOURS = ['ua1', 'ua2', '1a', '1b', '2a', '2b', '2u', '3a', '3b', '3u', '4', '4e', '4f', 'wt1a', 'wt1r'];
const samples = resolve(process.argv[2] ?? join(root, '.build/test-output'));
const pdfs = readdirSync(samples).filter(name => name.endsWith('.pdf')).sort().map(name => join(samples, name));
if (pdfs.length === 0) throw new Error(`No sample PDFs in ${samples}. Run npm test first, or pass a directory.`);
const classes = join(work, 'classes');
if (!existsSync(join(classes, 'Validate.class'))) throw new Error('No compiled entry in .build/verapdf/classes. Run npm run build:verapdf.');

interface Report { error?: string; compliant: boolean; totalAssertions: number; failedRules: { specification: string; clause: string; test: number; failedChecks: number }[] }
const normalise = (json: string) => {
  const report: Report = JSON.parse(json);
  if (report.error) return `error: ${report.error}`;
  return JSON.stringify([report.compliant, report.totalAssertions,
    report.failedRules.map(rule => `${rule.specification} ${rule.clause}-${rule.test} x${rule.failedChecks}`).sort()]);
};

const generated = join(root, 'packages/verapdf-wasm/generated');
const { instantiate }: { instantiate(wasm: Uint8Array): Promise<(pdf: string, flavour: string) => unknown> } =
  await import(pathToFileURL(join(generated, 'verapdf.js')).href);
const validate = await instantiate(readFileSync(join(generated, 'verapdf.wasm')));
// The entry takes one UTF-16 code unit per byte.
const encoded = pdfs.map(path => readFileSync(path).toString('latin1'));
const java = join(graalvmHome(), 'bin/java');
const jars = verifiedJars();

let same = 0;
let different = 0;
for (const flavour of FLAVOURS) {
  const jvm = capture(java, ['-cp', classpath(...jars, classes), 'Validate', flavour, ...pdfs], { maxBuffer: 256 * 1024 * 1024 }).split('\n');
  if (jvm.length !== pdfs.length) throw new Error(`The JVM run for ${flavour} printed ${jvm.length} reports for ${pdfs.length} files`);
  pdfs.forEach((path, index) => {
    const wasm = normalise(String(validate(encoded[index], flavour)));
    const reference = normalise(jvm[index]);
    if (wasm === reference && !wasm.startsWith('error')) { same++; return; }
    different++;
    console.error(`DIFFERENT ${flavour} ${basename(path)}\n  wasm: ${wasm.slice(0, 500)}\n  jvm:  ${reference.slice(0, 500)}`);
  });
}
console.log(`${same} of ${same + different} runs match (${pdfs.length} files x ${FLAVOURS.length} flavours)`);
if (different > 0) process.exit(1);
