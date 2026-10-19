import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(root, '.build/packed-consumer-'));
// Tarball names follow each package's own version (npm pack writes typfolio-<name>-<version>.tgz), so they are
// derived rather than hard-coded and keep working when Changesets bumps the versions.
const tarballPath = async (name: string) => {
  const { version } = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'));
  return join(root, `.build/typfolio-${name}-${version}.tgz`);
};
const tarballs = Object.fromEntries(await Promise.all(['wasm', 'core', 'workers', 'react', 'dev-tools'].map(async name => [name, await tarballPath(name)])));
const run = (command: string, args: string[]) => {
  const r = spawnSync(command, args, { cwd: dir, stdio: 'inherit' });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${command} exited ${r.status}`);
};
await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'packed-typfolio-smoke', private: true, type: 'module' }));
run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
  tarballs['wasm'],
  tarballs['core'],
  tarballs['workers'],
  tarballs['react'],
  tarballs['dev-tools'],
  'react@19.3.0',
  'react-dom@19.3.0',
  '@types/react@19.3.0',
  '@types/react-dom@19.3.0']);
// html2canvas is an optional peer of @typfolio/core: installing the tarballs must not bring it in.
// (This directory sits inside the repository, so bare-specifier resolution could still find the
// workspace's own copy; the assertions below therefore inspect the installed tree directly.)
await assert.rejects(access(join(dir, 'node_modules/html2canvas')), { code: 'ENOENT' },
  'html2canvas must not be installed in the consumer');
// pdfjs-dist is an optional peer of @typfolio/dev-tools (its /pdf entry): likewise not installed by the tarballs.
// The inspect step below resolves it from the workspace's node_modules, which sit above this directory.
await assert.rejects(access(join(dir, 'node_modules/pdfjs-dist')), { code: 'ENOENT' },
  'pdfjs-dist must not be installed in the consumer');
for (const name of ['wasm', 'core', 'workers', 'react', 'dev-tools']) {
  const manifest = JSON.parse(await readFile(join(dir, 'node_modules/@typfolio', name, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'optionalDependencies']) {
    assert.ok(!('html2canvas' in (manifest[field] ?? {})), `@typfolio/${name} must not list html2canvas in ${field}`);
    assert.ok(!('pdfjs-dist' in (manifest[field] ?? {})), `@typfolio/${name} must not list pdfjs-dist in ${field}`);
  }
  if (name !== 'dev-tools') assert.ok(!('pdfjs-dist' in (manifest.peerDependencies ?? {})), `@typfolio/${name} must not declare a pdfjs-dist peer`);
  if (name === 'core') {
    assert.ok('html2canvas' in manifest.peerDependencies, 'core must declare html2canvas as a peer dependency');
    assert.equal(manifest.peerDependenciesMeta?.html2canvas?.optional, true, 'html2canvas peer must be optional');
  }
  if (name === 'dev-tools') {
    assert.ok('pdfjs-dist' in manifest.peerDependencies, 'dev-tools must declare pdfjs-dist as a peer dependency');
    assert.equal(manifest.peerDependenciesMeta?.['pdfjs-dist']?.optional, true, 'pdfjs-dist peer must be optional');
    assert.ok(!('html2canvas' in (manifest.peerDependencies ?? {})), 'dev-tools must not declare an html2canvas peer');
  }
}
// The Typst package must ship as files (it is also the --package-path layout for editors), not only inside dist.
const packageFiles = ['typst.toml', 'lib.typ', 'sample.typ'].map(name => `typst-packages/local/typfolio/0.1.0/${name}`);
const tarball = spawnSync('tar', ['-tzf', tarballs.core], { encoding: 'utf8' });
if (tarball.error || tarball.status !== 0) throw tarball.error ?? new Error('tar exited ' + tarball.status);
const entries = tarball.stdout.split('\n');
for (const name of packageFiles) {
  assert.ok(entries.includes(`package/${name}`), `the core tarball must contain ${name}`);
  await access(join(dir, 'node_modules/@typfolio/core', name));
}
// Every tarball must carry the licence; the wasm tarball also carries the NOTICE and third-party notices and licence texts.
// npm adds LICENSE/NOTICE from a package's own root, so this guards the per-package copies.
for (const [name, extra] of [['wasm', ['NOTICE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.md', 'generated/LICENSE.typst-ts']], ['core', []], ['workers', []], ['react', []], ['dev-tools', []]] as [string, string[]][]) {
  const listing = spawnSync('tar', ['-tzf', tarballs[name]], { encoding: 'utf8' });
  if (listing.error || listing.status !== 0) throw listing.error ?? new Error('tar exited ' + listing.status);
  const files = listing.stdout.split('\n');
  for (const file of ['LICENSE', ...extra]) assert.ok(files.includes(`package/${file}`), `the ${name} tarball must contain ${file}`);
  const installed = await readFile(join(dir, 'node_modules/@typfolio', name, 'LICENSE'));
  assert.ok(installed.equals(await readFile(join(root, 'LICENSE'))), `the installed @typfolio/${name} LICENSE must equal the root LICENSE`);
  if (name === 'wasm') {
    const notice = await readFile(join(dir, 'node_modules/@typfolio/wasm/NOTICE'));
    assert.ok(notice.equals(await readFile(join(root, 'NOTICE'))), 'the installed @typfolio/wasm NOTICE must equal the root NOTICE');
    // The installed third-party files are the generated ones, made from the Cargo.lock the installed binary was built from.
    const lockSha = JSON.parse(await readFile(join(dir, 'node_modules/@typfolio/wasm/generated/provenance.json'), 'utf8')).cargoLockSha256;
    for (const file of ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.md']) {
      const installedText = await readFile(join(dir, 'node_modules/@typfolio/wasm', file), 'utf8');
      assert.equal(installedText, await readFile(join(root, 'packages/wasm', file), 'utf8'), `the installed ${file} must equal the repository copy`);
      assert.ok(installedText.includes(`Cargo.lock SHA-256: \`${lockSha}\``), `the installed ${file} must be generated from the Cargo.lock recorded in provenance.json`);
      assert.ok(!installedText.includes('Crates without a bundled licence file'), `the installed ${file} must not list crates without a licence text`);
    }
  }
}
await writeFile(join(dir, 'smoke.mjs'), `
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createAttachments, createCompiler, createLazyCompiler, definePartial, defineTemplate } from '@typfolio/core';
import { createWorkerClient } from '@typfolio/workers';
import * as react from '@typfolio/react';
import { usePdf } from '@typfolio/react';
import * as coreMain from '@typfolio/core';
import * as devTools from '@typfolio/dev-tools';
import { checkTemplate, createTemplateChecker, inputSchemaFiles } from '@typfolio/dev-tools';
import * as devToolsPdf from '@typfolio/dev-tools/pdf';
import { inspectPdf } from '@typfolio/dev-tools/pdf';
import { captureAssets, captureProps } from '@typfolio/core/capture';
import { serializeSvg, svgCapture } from '@typfolio/core/capture/svg';
import { domPngCapture } from '@typfolio/core/capture/dom';
import { CaptureRegion } from '@typfolio/react/capture';
import * as reactCapture from '@typfolio/react/capture';
assert.equal(typeof createWorkerClient, 'function');
assert.equal(typeof usePdf, 'function');
// usePdf is the React API: its compile lifecycle and chart drawing are internal.
assert.deepEqual(Object.keys(react), ['usePdf']);
// Templates are defined (no plain templates, defineInput or templateFromFiles), and nothing internal leaks.
assert.deepEqual(Object.keys(coreMain).sort(), [
  'TypstPdfError', 'capabilities', 'createAttachments', 'createCompiler', 'createLazyCompiler', 'definePartial', 'defineTemplate', 'pdfStandards',
]);
assert.equal(typeof serializeSvg, 'function');
assert.equal(typeof CaptureRegion, 'function');
assert.equal(typeof captureAssets, 'function');
assert.equal(typeof captureProps, 'function');
assert.deepEqual(Object.keys(reactCapture).sort(), ['CaptureRegion']);
assert.equal('captureAssets' in coreMain, false);
assert.deepEqual(Object.keys(devTools).sort(), ['checkTemplate', 'createTemplateChecker', 'inputSchemaFiles']);
assert.equal(typeof inputSchemaFiles, 'function');
assert.deepEqual(Object.keys(devToolsPdf), ['inspectPdf']);
assert.equal('inspectPdf' in devTools, false);
await assert.rejects(import('@typfolio/core/dev-tools'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
for (const name of Object.keys(devTools)) assert.equal(name in coreMain, false, name + ' leaked into the main entry');
assert.equal(typeof createTemplateChecker, 'function');
assert.equal(typeof checkTemplate, 'function');
await assert.rejects(import('@typfolio/react/capture/svg'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@typfolio/react/capture/dom'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
assert.equal(typeof svgCapture, 'function');
assert.equal(typeof domPngCapture, 'function');
const root = process.argv[2];
// One WASM source value per JS realm: the compilers and the template checker share it.
const wasm = await readFile(new URL(import.meta.resolve('@typfolio/wasm/compiler.wasm')));
const font = await readFile(root + '/fixtures/fonts/LibertinusSerif-Regular.otf');
// A template whose Typst reads its data with json("/input.json"): schemaPath mounts each call's data there.
const titled = defineTemplate({
  files: { 'main.typ': '#let input = json("/input.json")\\n#set text(font: "Libertinus Serif", lang: "en")\\n#set document(title: input.title)\\n#input.title' },
  schemaPath: 'input.json',
});
const compiler = await createCompiler({ wasm, fonts: [font] });
try {
  const result = await compiler.compile(titled({ title: 'Installed package works' }), { pdf: { standards: ['ua-1'] } });
  assert.equal(result.metadata.title, 'Installed package works');
  assert.ok(result.bytes.length > 1000);
  console.log('Packed core imports and compiles PDF/UA successfully.');
  const inspection = await inspectPdf(result.bytes);
  assert.equal(inspection.tagged, true);
  assert.equal(inspection.standard.pdfUa, 1);
  assert.equal(inspection.title, 'Installed package works');
  assert.equal(inspection.language, 'en');
  assert.deepEqual(inspection.headings, []);
  console.log('Packed @typfolio/dev-tools/pdf inspects that PDF: tagged, PDF/UA declared.');
  // compile takes a document; a template without data is called without any.
  const fixed = defineTemplate({ files: { 'main.typ': '#set document(title: "Fixed")\\nFixed' } });
  assert.equal((await compiler.compile(fixed())).metadata.title, 'Fixed');
  await assert.rejects(compiler.compile(fixed({ title: 'Data' })), { code: 'INVALID_REQUEST' });
  await assert.rejects(compiler.compile(titled()), { code: 'INVALID_REQUEST' });
  await assert.rejects(compiler.compile({ template: 'Hello', input: null }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(compiler.capabilities.typstPackages, ['@local/typfolio:0.1.0']);
  const packaged = defineTemplate({
    files: { 'main.typ': '#import "@local/typfolio:0.1.0": input\\n#let data = input(json.with("./report.schema.json"))\\n#set document(title: data.title)\\n#data.title' },
    schemaPath: 'report.schema.json',
  });
  assert.equal((await compiler.compile(packaged({ title: 'Packed Typst package works' }))).metadata.title, 'Packed Typst package works');
  console.log('Packed core compiles a template that imports @local/typfolio:0.1.0.');
  // A Standard Schema without a schema library.
  const schema = check => ({ '~standard': { version: 1, vendor: 'smoke', validate: value => (check(value) ? { value } : { issues: [{ message: 'invalid' }] }) } });
  const header = definePartial({
    files: { 'common/header.typ': '#import "@local/typfolio:0.1.0": input\\n#let header = input(json.with("./header.schema.json"))' },
    schema: schema(value => typeof value.name === 'string'),
    schemaPath: 'common/header.schema.json',
  });
  const report = defineTemplate({
    entrypoint: 'report/main.typ',
    files: { 'report/main.typ': '#import "@local/typfolio:0.1.0": input\\n#import "../common/header.typ": header\\n#let data = input(json.with("./input.schema.json"))\\n#set document(title: data.title + " / " + header.name)\\n#image(data.logo, width: 1cm, alt: "Logo")' },
    schema: schema(value => typeof value.title === 'string'),
    schemaPath: 'report/input.schema.json',
    partials: { header },
  });
  const attachments = createAttachments();
  const logo = attachments.add(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), 'svg');
  const defined = await compiler.compile(report({ title: 'Defined', logo }, { header: { name: 'Header' } }), { assets: attachments.assets });
  assert.equal(defined.metadata.title, 'Defined / Header');
  await assert.rejects(compiler.compile(report({ title: 1, logo }, { header: { name: 'H' } })), { code: 'INVALID_INPUT' });
  await assert.rejects(compiler.compile(report({ title: 'T', logo }, { header: { name: 1 } })), { code: 'INVALID_INPUT' });
  await assert.rejects(compiler.compile(report({ title: 'T', logo })), { code: 'INVALID_REQUEST' });
  await assert.rejects(compiler.compile(report({ title: 'T', logo }, { header: { name: 'H' }, footer: {} })), { code: 'INVALID_REQUEST' });
  // validate: false skips the schemas: the same data then fails in Typst.
  await assert.rejects(compiler.compile(report({ title: 1, logo }, { header: { name: 'H' } }), { assets: attachments.assets, validate: false }), { code: 'COMPILATION' });
  console.log('Packed core compiles a defined template with a partial and an attachment, and rejects data that fails its schema.');
} finally { await compiler.dispose(); }
const lazy = createLazyCompiler({ wasm, fonts: [font] });
try {
  assert.equal((await lazy.compile(titled({ title: 'Lazy compiler works' }))).metadata.title, 'Lazy compiler works');
  console.log('Packed core compiles with a lazy compiler.');
} finally { await lazy.dispose(); }
const checker = await createTemplateChecker({ wasm, fonts: [font] });
try {
  // A Standard Schema that implements Standard JSON Schema: the checker makes the sample's JSON Schema from it.
  const jsonSchema = { type: 'object', properties: { title: { type: 'string' }, subtitle: { type: 'string' } }, required: ['title'] };
  const reportSchema = { '~standard': { version: 1, vendor: 'smoke', validate: value => ({ value }), jsonSchema: { input: () => jsonSchema, output: () => jsonSchema } } };
  const source = body => ({ 'main.typ': '#import "@local/typfolio:0.1.0": input\\n#let data = input(json.with("./report.schema.json"))\\n#set document(title: "Check")\\n' + body });
  const checked = body => defineTemplate({ files: source(body), schema: reportSchema, schemaPath: 'report.schema.json' });
  assert.deepEqual(JSON.parse(inputSchemaFiles(checked(''))['report.schema.json']), jsonSchema);
  const good = await checker.check(checked('#data.title'), { pdf: { standards: ['ua-1'] } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.results.map(result => result.mode), ['minimal', 'full']);
  assert.ok(good.results.every(result => result.bytes.length > 1000));
  const bad = await checker.check(checked('#data.subtitle'));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.results.map(result => [result.mode, result.ok]), [['minimal', false], ['full', true]]);
  assert.match(bad.results[0].error.message, /subtitle/);
  // Without a schema, the JSON Schema file is given in assets at the data path.
  const given = defineTemplate({ files: source('#data.title'), schemaPath: 'report.schema.json' });
  const fromFile = await checker.check(given, { assets: { 'report.schema.json': new TextEncoder().encode(JSON.stringify(jsonSchema)) } });
  assert.equal(fromFile.ok, true);
  console.log('Packed @typfolio/dev-tools checks a template against a schema in both sample modes.');
} finally { await checker.dispose(); }
`);
await writeFile(join(dir, 'consumer.ts'), `
import { createCompiler, createLazyCompiler, type Assets, type CompileOptions, type CompilerOptions, type FontSource, type LazyCompiler, type PdfClient, type PdfDocument } from '@typfolio/core';
import { createAttachments, definePartial, defineTemplate, type AnyTemplate, type PartialDefinition, type StandardSchemaV1, type TemplateDefinition } from '@typfolio/core';
import { collectBatch, compileBatch, createWorkerClient, type PdfBatchJob, type PdfWorkerClient, type WorkerCompileOptions } from '@typfolio/workers';
import {
  usePdf,
  type AttachFile,
  type PdfBuildTools,
  type PdfSource,
  type PdfStatus,
  type UsePdfOptions,
  type UsePdfResult,
  type RenderAsset,
  type RenderAssetsOptions,
} from '@typfolio/react';
import {
  captureAssets,
  captureProps,
  type CaptureAdapter,
  type CaptureAssetsOptions,
  type CaptureMarker,
  type CapturedAssets,
} from '@typfolio/core/capture';
import { serializeSvg, svgCapture, type SvgSerializeOptions } from '@typfolio/core/capture/svg';
import { domPngCapture } from '@typfolio/core/capture/dom';
import { CaptureRegion, type CaptureRegionProps } from '@typfolio/react/capture';
import {
  checkTemplate,
  createTemplateChecker,
  inputSchemaFiles,
  type SampleMode,
  type SchemaFile,
  type TemplateCheckOptions,
  type TemplateCheckReport,
  type TemplateCheckResult,
  type TemplateChecker,
} from '@typfolio/dev-tools';
import { inspectPdf, type PdfFigure, type PdfFont, type PdfHeading, type PdfInspection } from '@typfolio/dev-tools/pdf';
declare const wasm: WebAssembly.Module;
declare const font: Uint8Array;
declare const worker: Worker;
const compiler: PdfClient = await createCompiler({ wasm, fonts: [font] });
// Fonts are bytes, URLs, or URL strings, mixed freely, for core and for the worker client.
declare const fontUrl: URL;
const mixedFonts: readonly FontSource[] = [font, '/fonts/bold.otf', fontUrl];
const mixedOptions: CompilerOptions = { wasm, fonts: mixedFonts };
const urlCompiler: PdfClient = await createCompiler(mixedOptions);
void urlCompiler;
// @ts-expect-error a number is not a font
const badFont: CompilerOptions = { wasm, fonts: [42] };
void badFont;
// Templates: a call binds the data, typed by the schemas, and returns the document to compile.
declare const titleSchema: StandardSchemaV1<{ title: string }>;
declare const headerSchema: StandardSchemaV1<{ name: string }>;
declare const logoSchema: StandardSchemaV1<{ src: string }>;
// A schema whose input differs from its output: a call takes what the schema accepts.
declare const countSchema: StandardSchemaV1<{ count: string }, { count: number }>;
const header = definePartial({ files: { 'common/header.typ': '' }, schema: headerSchema, schemaPath: 'common/header.schema.json' });
header satisfies PartialDefinition<{ name: string }>;
const report = defineTemplate({ files: { 'main.typ': '' }, schema: titleSchema, schemaPath: 'input.schema.json', partials: { header } });
const titled = defineTemplate({ files: { 'main.typ': '' }, schema: titleSchema, schemaPath: 'input.schema.json' });
const counted = defineTemplate({ files: { 'main.typ': '' }, schema: countSchema, schemaPath: 'input.schema.json' });
// No schema: the data is not checked, and typed unknown.
const untyped = defineTemplate({ files: { 'main.typ': '' }, schemaPath: 'input.json' });
// No schemaPath: no data.
const fixed = defineTemplate({ files: { 'main.typ': 'Hello' } });
const headerOnly = defineTemplate({ files: { 'main.typ': '' }, partials: { header } });
// A partial's own partials are filled by key in the template call too.
const logo = definePartial({ files: { 'common/logo.typ': '' }, schema: logoSchema, schemaPath: 'common/logo.schema.json' });
const brandedHeader = definePartial({ files: { 'common/branded.typ': '' }, schema: headerSchema, schemaPath: 'common/branded.schema.json', partials: { logo } });
const branded = defineTemplate({ files: { 'main.typ': '' }, schema: titleSchema, schemaPath: 'input.schema.json', partials: { header: brandedHeader } });
const reportDocument: PdfDocument = report({ title: 'T' }, { header: { name: 'H' } });
titled({ title: 'T' }) satisfies PdfDocument;
counted({ count: '3' }) satisfies PdfDocument;
untyped({ anything: [1, 'two'] }) satisfies PdfDocument;
fixed() satisfies PdfDocument;
headerOnly(undefined, { header: { name: 'H' } }) satisfies PdfDocument;
branded({ title: 'T' }, { header: { name: 'H' }, logo: { src: '/logo.png' } }) satisfies PdfDocument;
// @ts-expect-error a partial's key is missing
report({ title: 'T' }, {});
// @ts-expect-error the partials' data is required
report({ title: 'T' });
// @ts-expect-error an unknown partial key
report({ title: 'T' }, { header: { name: 'H' }, footer: { name: 'F' } });
// @ts-expect-error the data is typed by its schema
report({ title: 1 }, { header: { name: 'H' } });
// @ts-expect-error a partial's data is typed by its schema
report({ title: 'T' }, { header: { name: 1 } });
// @ts-expect-error an unknown key in the data
titled({ title: 'T', subtitle: 'S' });
// @ts-expect-error a template with data needs it
titled();
// @ts-expect-error a call takes the schema's input, not its output
counted({ count: 3 });
// @ts-expect-error a template without data takes none
fixed({ title: 'T' });
// @ts-expect-error a nested partial's data is required too
branded({ title: 'T' }, { header: { name: 'H' } });
// Templates are values of these types; a wrapper can take any template whose partials it fills.
const anyTemplate: AnyTemplate = report;
const typedDefinition: TemplateDefinition<{ title: string }> = titled;
function withHeader<T>(template: TemplateDefinition<T, { header: { name: string } }>, data: T): PdfDocument {
  return template(data, { header: { name: 'Shared' } });
}
withHeader(report, { title: 'T' });
// @ts-expect-error the wrapper's data is the template's
withHeader(report, { title: 1 });
void [anyTemplate, typedDefinition];
// compile takes a document and its options.
const compileOptions: CompileOptions = { assets: { 'logo.png': new Uint8Array([1]) }, pdf: { standards: ['ua-1'] }, signal: new AbortController().signal, validate: false };
const result: Uint8Array = (await compiler.compile(reportDocument, compileOptions)).bytes;
await compiler.compile(fixed());
// @ts-expect-error compile takes a document: call the template with its data
await compiler.compile(report);
// @ts-expect-error the 0.2 request shape is gone
await compiler.compile({ template: 'Hello', input: null });
// @ts-expect-error the data goes in the template call, not in the options
await compiler.compile(titled({ title: 'T' }), { input: { title: 'T' } });
const workerClient: PdfWorkerClient = createWorkerClient({
  compiler: { wasm, fonts: [font] },
  workerCount: 2,
  workerFactory: () => worker,
});
const urlWorkerClient: PdfWorkerClient = createWorkerClient({
  compiler: { wasm, fonts: [font, '/fonts/bold.otf', fontUrl] },
  workerFactory: () => worker,
});
void urlWorkerClient;
const workerOptions: WorkerCompileOptions = { ...compileOptions, timeoutMs: 1000 };
(await workerClient.compile(report({ title: 'T' }, { header: { name: 'H' } }), workerOptions)).bytes satisfies Uint8Array;
const jobs: PdfBatchJob<string>[] = [
  { id: 'one', document: reportDocument },
  { id: 'two', document: titled({ title: 'T' }), assets: { 'logo.png': new Uint8Array([1]) }, pdf: { standards: ['ua-1'] }, timeoutMs: 1000, validate: false },
];
for await (const outcome of compileBatch(workerClient, jobs)) {
  if (outcome.status === 'success') outcome.result.bytes satisfies Uint8Array;
}
const collected = await collectBatch(workerClient, jobs);
collected[0]?.id satisfies string;
// @ts-expect-error a batch job carries a document
await collectBatch(workerClient, [{ id: 'old', request: { template: 'Hello', input: null } }]);
const adapters: Record<string, CaptureAdapter> = {
  svg: svgCapture(),
  png: domPngCapture({ pixelRatio: 2 }),
};
const captureOptions: CaptureAssetsOptions = { adapters, require: ['chart'] };
declare const captureRoot: ParentNode;
const captured: CapturedAssets = await captureAssets(captureRoot, captureOptions);
captured.assets satisfies Assets;
await compiler.compile(untyped({ figures: captured.references }), { assets: captured.assets });
const marker: CaptureMarker = { id: 'chart', kind: 'svg', altText: 'Chart summary.' };
const decorativeMarker: CaptureMarker = { id: 'divider', kind: 'png', decorative: true };
captureProps(marker) satisfies Readonly<Record<string, string>>;
captureProps(decorativeMarker) satisfies Readonly<Record<string, string>>;
// @ts-expect-error a marker needs alt text or decorative: true
const missingAlt: CaptureMarker = { id: 'chart', kind: 'svg' };
// @ts-expect-error alt text and decorative are mutually exclusive
const bothAlt: CaptureMarker = { id: 'chart', kind: 'svg', altText: 'x', decorative: true };
const regionProps: CaptureRegionProps = { captureId: 'chart', kind: 'svg', altText: 'Chart summary.' };
const decorativeRegionProps: CaptureRegionProps<'section'> = { as: 'section', captureId: 'divider', kind: 'png', decorative: true };
CaptureRegion(regionProps);
CaptureRegion(decorativeRegionProps);
// @ts-expect-error a region needs alt text or decorative
CaptureRegion({ captureId: 'chart', kind: 'svg' });
void [missingAlt, bothAlt];
// Typed data: an interface (not assignable to a JSON type) is accepted without casts.
interface ReportInput { title: string; rows: { name: string; score: number | null }[] }
declare const rowsSchema: StandardSchemaV1<ReportInput>;
const rowsTemplate = defineTemplate({ files: { 'main.typ': '' }, schema: rowsSchema, schemaPath: 'input.schema.json' });
const rowsInput: ReportInput = { title: 'T', rows: [{ name: 'a', score: null }] };
await compiler.compile(rowsTemplate(rowsInput));
await workerClient.compile(rowsTemplate(rowsInput));
await collectBatch(workerClient, [{ id: 'typed', document: rowsTemplate(rowsInput) }]);
// @ts-expect-error the data does not match ReportInput
rowsTemplate({ title: 1, rows: [] });
// Dev-time template checks: of a defined template.
const checker: TemplateChecker = await createTemplateChecker({ wasm, fonts: [font] });
const checkOptions: TemplateCheckOptions = {
  modes: ['minimal', 'full'],
  pdf: { standards: ['ua-1'] },
  assets: { 'settings.json': new Uint8Array([123, 125]) },
  toJSONSchema: () => ({}),
};
const checkReport: TemplateCheckReport = await checker.check(report, checkOptions);
checkReport.ok satisfies boolean;
const checkResult: TemplateCheckResult | undefined = checkReport.results[0];
checkResult?.mode satisfies SampleMode;
checkResult?.bytes satisfies Uint8Array | undefined;
checkResult?.error?.code satisfies string | undefined;
checkResult?.diagnostics.length satisfies number | undefined;
(await checkTemplate(titled, { wasm, fonts: [font], modes: ['full'] })).ok satisfies boolean;
// @ts-expect-error check takes a defined template, not Typst source
await checker.check('Hello');
// @ts-expect-error check takes the template, not a document
await checker.check(titled({ title: 'T' }));
await checker.dispose();
// @ts-expect-error an unknown sample mode
const badMode: TemplateCheckOptions = { modes: ['sparse'] };
void badMode;
const schemaFile: SchemaFile = { schema: titleSchema, schemaPath: 'report/input.schema.json' };
inputSchemaFiles([report, header, schemaFile], { toJSONSchema: () => ({}) }) satisfies Record<string, string>;
inputSchemaFiles(titled) satisfies Record<string, string>;
createAttachments().add(new Uint8Array([1]), 'png') satisfies string;
// Dev-time PDF inspection.
const inspection: PdfInspection = await inspectPdf(result);
inspection.pages satisfies number;
inspection.tagged satisfies boolean;
inspection.structureTree satisfies boolean;
inspection.title satisfies string | undefined;
inspection.language satisfies string | undefined;
inspection.creationDate satisfies Date | undefined;
inspection.standard.pdfUa satisfies number | undefined;
inspection.standard.pdfA?.part satisfies number | undefined;
inspection.standard.pdfA?.conformance satisfies string | undefined;
inspection.headings satisfies PdfHeading[];
inspection.figures satisfies PdfFigure[];
inspection.tables satisfies number;
inspection.fonts satisfies PdfFont[];
inspection.structureRoles satisfies Record<string, number>;
const lazy: LazyCompiler = createLazyCompiler({ wasm, fonts: [font] });
lazy satisfies PdfClient;
await lazy.compile(rowsTemplate(rowsInput), { pdf: { standards: ['ua-1'] } });
await lazy.dispose();
// usePdf: a document, or a function that builds one (drawing charts and attaching files), and a client:
// a core compiler or a worker client.
const chartOptions: RenderAssetsOptions = {
  fontFamily: 'Libertinus Serif',
  fonts: [{ family: 'Libertinus Serif', source: '/fonts/LibertinusSerif-Regular.otf', descriptors: { weight: '400' } }],
  beforeSerialize: svg => svg.querySelector('.tooltip')?.remove(),
  directory: 'figures',
};
function useReport(title: string): UsePdfResult {
  return usePdf(report({ title }, { header: { name: 'H' } }), { client: workerClient });
}
function useChartedReport(title: string): UsePdfResult {
  return usePdf(({ render, attach }) => report({ title: render(null as never) }, { header: { name: attach(new Uint8Array([1]), 'png') } }), {
    client: lazy,
    deps: [title],
    assets: { 'logo.png': new Uint8Array([1]) },
    pdf: { standards: ['ua-1'] },
    charts: chartOptions,
    enabled: true,
    validate: false,
    onSuccess: value => value.bytes satisfies Uint8Array,
    onError: error => error satisfies unknown,
    onSettled: (value, error) => [value?.bytes satisfies Uint8Array | undefined, error satisfies unknown],
  });
}
function useMistakes(): void {
  // @ts-expect-error usePdf takes a document: call the template with its data
  usePdf(report, { client: compiler });
  // @ts-expect-error a function builds a document, not bare data
  usePdf(() => ({ title: 'T' }), { client: compiler });
  // @ts-expect-error a function's document is typed by the schemas too
  usePdf(({ attach }) => titled({ title: attach }), { client: compiler });
  // @ts-expect-error the client is required
  usePdf(titled({ title: 'T' }), {});
}
const source: PdfSource = titled({ title: 'T' });
const sourceFunction: PdfSource = ({ attach }: PdfBuildTools) => titled({ title: attach(new Uint8Array([1]), 'png') });
const attachFile: AttachFile = (_bytes, extension) => '/attachments/0.' + extension;
const usePdfOptions: UsePdfOptions = { client: compiler, pdf: { standards: ['ua-1'] } };
declare const pdfResult: UsePdfResult;
pdfResult.status satisfies PdfStatus;
pdfResult.result?.bytes satisfies Uint8Array | undefined;
pdfResult.url satisfies string | undefined;
pdfResult.isLoading satisfies boolean;
pdfResult.download('report');
pdfResult.rebuild();
pdfResult.cancel();
pdfResult.AssetRenderer satisfies import('react').ComponentType;
usePdf satisfies (source: PdfSource, options: UsePdfOptions) => UsePdfResult;
const renderChart: RenderAsset = () => '/charts/0.svg';
serializeSvg satisfies (svg: SVGSVGElement, options?: SvgSerializeOptions) => Uint8Array;
// @ts-expect-error removeSelectors was replaced by beforeSerialize
svgCapture({ removeSelectors: ['.tooltip'] });
void [useReport, useChartedReport, useMistakes, source, sourceFunction, attachFile, usePdfOptions, renderChart];
`);
run(process.execPath, ['smoke.mjs', root]);
const tsc = join(root, 'node_modules/typescript/bin/tsc');
run(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'ES2022',
  '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', 'consumer.ts']);
// Older applications resolve with `moduleResolution: "node"`, which ignores `exports`: the packages'
// `types` and `typesVersions` fields must lead it to the same declarations.
run(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'ES2022',
  '--module', 'ESNext', '--moduleResolution', 'node', '--lib', 'ES2022,DOM', 'consumer.ts']);
console.log('Packed public TypeScript declarations check without skipLibCheck, with NodeNext and with node resolution.');
