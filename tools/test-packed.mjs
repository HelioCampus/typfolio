import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(root, '.build/packed-consumer-'));
const run = (command, args) => {
  const r = spawnSync(command, args, { cwd: dir, stdio: 'inherit' });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${command} exited ${r.status}`);
};
await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'packed-typfolio-smoke', private: true, type: 'module' }));
run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
  join(root, '.build/typfolio-wasm-0.0.0-dev.1.tgz'),
  join(root, '.build/typfolio-core-0.0.0-dev.1.tgz'),
  join(root, '.build/typfolio-workers-0.0.0-dev.1.tgz'),
  join(root, '.build/typfolio-react-0.0.0-dev.1.tgz'),
  join(root, '.build/typfolio-dev-tools-0.0.0-dev.1.tgz'),
  'react@19.3.0',
  '@types/react@19.3.0']);
// html2canvas is an optional peer of @typfolio/core: installing the tarballs must not bring it in.
// (This directory sits inside the repository, so bare-specifier resolution could still find the
// workspace's own copy; the assertions below therefore inspect the installed tree directly.)
await assert.rejects(access(join(dir, 'node_modules/html2canvas')), { code: 'ENOENT' },
  'html2canvas must not be installed in the consumer');
for (const name of ['wasm', 'core', 'workers', 'react', 'dev-tools']) {
  const manifest = JSON.parse(await readFile(join(dir, 'node_modules/@typfolio', name, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'optionalDependencies']) {
    assert.ok(!('html2canvas' in (manifest[field] ?? {})), `@typfolio/${name} must not list html2canvas in ${field}`);
  }
  if (name === 'core') {
    assert.ok('html2canvas' in manifest.peerDependencies, 'core must declare html2canvas as a peer dependency');
    assert.equal(manifest.peerDependenciesMeta?.html2canvas?.optional, true, 'html2canvas peer must be optional');
  }
}
// The Typst package must ship as files (it is also the --package-path layout for editors), not only inside dist.
const packageFiles = ['typst.toml', 'lib.typ', 'sample.typ'].map(name => `typst-packages/local/typfolio/0.1.0/${name}`);
const tarball = spawnSync('tar', ['-tzf', join(root, '.build/typfolio-core-0.0.0-dev.1.tgz')], { encoding: 'utf8' });
if (tarball.error || tarball.status !== 0) throw tarball.error ?? new Error('tar exited ' + tarball.status);
const entries = tarball.stdout.split('\n');
for (const name of packageFiles) {
  assert.ok(entries.includes(`package/${name}`), `the core tarball must contain ${name}`);
  await access(join(dir, 'node_modules/@typfolio/core', name));
}
// Every tarball must carry the licence; the wasm tarball also carries the NOTICE and third-party notices and licence texts.
// npm adds LICENSE/NOTICE from a package's own root, so this guards the per-package copies.
for (const [name, extra] of [['wasm', ['NOTICE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.md', 'generated/LICENSE.typst-ts']], ['core', []], ['workers', []], ['react', []], ['dev-tools', []]]) {
  const listing = spawnSync('tar', ['-tzf', join(root, `.build/typfolio-${name}-0.0.0-dev.1.tgz`)], { encoding: 'utf8' });
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
import { createCompiler, templateFromFiles } from '@typfolio/core';
import { createWorkerClient } from '@typfolio/workers';
import { PdfProvider, usePdfCompilation, usePdfObjectUrl } from '@typfolio/react';
import * as coreMain from '@typfolio/core';
import * as devTools from '@typfolio/dev-tools';
import { checkTemplate, createTemplateChecker } from '@typfolio/dev-tools';
import { captureAssets, captureProps } from '@typfolio/core/capture';
import { svgCapture } from '@typfolio/core/capture/svg';
import { domPngCapture } from '@typfolio/core/capture/dom';
import { CaptureRegion } from '@typfolio/react/capture';
import * as reactCapture from '@typfolio/react/capture';
assert.equal(typeof createWorkerClient, 'function');
assert.equal(typeof PdfProvider, 'function');
assert.equal(typeof usePdfCompilation, 'function');
assert.equal(typeof usePdfObjectUrl, 'function');
assert.equal(typeof CaptureRegion, 'function');
assert.equal(typeof captureAssets, 'function');
assert.equal(typeof captureProps, 'function');
assert.deepEqual(Object.keys(reactCapture).sort(), ['CaptureRegion']);
assert.equal('captureAssets' in coreMain, false);
assert.deepEqual(Object.keys(devTools).sort(), ['checkTemplate', 'createTemplateChecker']);
await assert.rejects(import('@typfolio/core/dev-tools'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
for (const name of Object.keys(devTools)) assert.equal(name in coreMain, false, name + ' leaked into the main entry');
assert.equal(typeof createTemplateChecker, 'function');
assert.equal(typeof checkTemplate, 'function');
assert.equal(typeof templateFromFiles, 'function');
await assert.rejects(import('@typfolio/react/capture/svg'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@typfolio/react/capture/dom'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
assert.equal(typeof svgCapture, 'function');
assert.equal(typeof domPngCapture, 'function');
const root = process.argv[2];
// One WASM source value per JS realm: the compiler and the template checker share it.
const wasm = await readFile(new URL(import.meta.resolve('@typfolio/wasm/compiler.wasm')));
const compiler = await createCompiler({
  wasm,
  fonts: [await readFile(root + '/fixtures/fonts/LibertinusSerif-Regular.otf')],
});
try {
  const result = await compiler.compile({
    template: '#let input = json("/input.json")\\n#set text(font: "Libertinus Serif", lang: "en")\\n#set document(title: input.title)\\n#input.title',
    input: { title: 'Installed package works' }, pdf: { standards: ['ua-1'] },
  });
  assert.equal(result.metadata.title, 'Installed package works');
  assert.ok(result.bytes.length > 1000);
  console.log('Packed core imports and compiles PDF/UA successfully.');
  assert.deepEqual(compiler.capabilities.typstPackages, ['@local/typfolio:0.1.0']);
  const packaged = await compiler.compile({
    template: '#import "@local/typfolio:0.1.0": input\\n#let data = input(json.with("./report.schema.json"))\\n#set document(title: data.title)\\n#data.title',
    input: { title: 'Packed Typst package works' },
  });
  assert.equal(packaged.metadata.title, 'Packed Typst package works');
  console.log('Packed core compiles a template that imports @local/typfolio:0.1.0.');
} finally { await compiler.dispose(); }
const checker = await createTemplateChecker({
  wasm,
  fonts: [await readFile(root + '/fixtures/fonts/LibertinusSerif-Regular.otf')],
});
try {
  const schema = JSON.stringify({ type: 'object', properties: { title: { type: 'string' }, subtitle: { type: 'string' } }, required: ['title'] });
  const files = body => ({ 'main.typ': '#import "@local/typfolio:0.1.0": input\\n#let data = input(json.with("./report.schema.json"))\\n#set document(title: "Check")\\n' + body, 'report.schema.json': schema });
  const good = await checker.check({ files: files('#data.title') }, { pdf: { standards: ['ua-1'] } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.results.map(result => result.mode), ['minimal', 'full']);
  assert.ok(good.results.every(result => result.bytes.length > 1000));
  const bad = await checker.check({ files: files('#data.subtitle') });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.results.map(result => [result.mode, result.ok]), [['minimal', false], ['full', true]]);
  assert.match(bad.results[0].error.message, /subtitle/);
  console.log('Packed @typfolio/dev-tools checks a template against a schema in both sample modes.');
} finally { await checker.dispose(); }
`);
await writeFile(join(dir, 'consumer.ts'), `
import { createCompiler, templateFromFiles, type JsonValue, type PdfRequest, type PdfTemplate, type PdfClient, type PdfResult } from '@typfolio/core';
import { collectBatch, compileBatch, createWorkerClient, type PdfWorkerClient } from '@typfolio/workers';
import {
  PdfProvider,
  usePdfCompilation,
  usePdfObjectUrl,
  type PdfCompilation,
  type PdfCompilationOptions,
  type PdfProviderProps,
  type UsePdfCompilationOptions,
} from '@typfolio/react';
import {
  captureAssets,
  captureProps,
  type CaptureAdapter,
  type CaptureAssetsOptions,
  type CaptureMarker,
  type CapturedAssets,
} from '@typfolio/core/capture';
import { svgCapture } from '@typfolio/core/capture/svg';
import { domPngCapture } from '@typfolio/core/capture/dom';
import { CaptureRegion, type CaptureRegionProps } from '@typfolio/react/capture';
import {
  checkTemplate,
  createTemplateChecker,
  type SampleMode,
  type TemplateCheckOptions,
  type TemplateCheckReport,
  type TemplateCheckResult,
  type TemplateChecker,
} from '@typfolio/dev-tools';
declare const wasm: WebAssembly.Module;
declare const font: Uint8Array;
declare const worker: Worker;
const compiler: PdfClient = await createCompiler({ wasm, fonts: [font] });
const request: PdfRequest = { template: { entrypoint: 'main.typ', files: { 'main.typ': 'Hello' } }, input: null };
const stringTemplate: PdfTemplate = 'Hello';
const defaultEntrypointTemplate: PdfTemplate = { files: { 'main.typ': 'Hello' } };
const stringRequest: PdfRequest = { template: stringTemplate, input: null };
const defaultEntrypointRequest: PdfRequest = { template: defaultEntrypointTemplate, input: null };
// @ts-expect-error an object template needs files
const missingFiles: PdfTemplate = { entrypoint: 'main.typ' };
stringRequest.template satisfies PdfTemplate;
defaultEntrypointRequest.template satisfies PdfTemplate;
const result: Uint8Array = (await compiler.compile(request)).bytes;
const workerClient: PdfWorkerClient = createWorkerClient({
  compiler: { wasm, fonts: [font] },
  workerCount: 2,
  workerFactory: () => worker,
});
const jobs = [{ id: 'one', request }];
for await (const outcome of compileBatch(workerClient, jobs)) {
  if (outcome.status === 'success') outcome.result.bytes satisfies Uint8Array;
}
const collected = await collectBatch(workerClient, jobs);
collected[0]?.id satisfies string;
const providerProps: PdfProviderProps = { client: compiler };
const workerProviderProps: PdfProviderProps = { client: workerClient };
PdfProvider satisfies (props: PdfProviderProps) => unknown;
usePdfCompilation satisfies (options?: UsePdfCompilationOptions) => { compile(request: PdfRequest): Promise<unknown> };
usePdfObjectUrl satisfies (result: PdfResult | undefined) => string | undefined;
declare const compilation: PdfCompilation;
const compileOptions: PdfCompilationOptions = {
  onSuccess: (value, input) => value.bytes.length + (typeof input.template === 'string' ? input.template : Object.keys(input.template.files).join()).length,
  onSettled: (value, error, input) => [value?.bytes.length, error, input.input],
};
compilation.compile(request, compileOptions) satisfies Promise<PdfResult>;
compilation.isRecompiling satisfies boolean;
providerProps.client satisfies PdfClient;
workerProviderProps.client satisfies PdfClient;
const adapters: Record<string, CaptureAdapter> = {
  svg: svgCapture(),
  png: domPngCapture({ pixelRatio: 2 }),
};
const captureOptions: CaptureAssetsOptions = { adapters, require: ['chart'] };
declare const captureRoot: ParentNode;
const captured: CapturedAssets = await captureAssets(captureRoot, captureOptions);
captured.assets satisfies PdfRequest['assets'];
captured.references satisfies JsonValue;
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
// Typed input: an interface (not assignable to JsonValue) is accepted without casts everywhere a request is accepted.
interface ReportInput { title: string; rows: { name: string; score: number | null }[] }
const typedRequest: PdfRequest<ReportInput> = { template: 'Hello', input: { title: 'T', rows: [{ name: 'a', score: null }] } };
typedRequest.input.rows[0]?.name satisfies string | undefined;
await compiler.compile(typedRequest);
await workerClient.compile(typedRequest);
await compilation.compile(typedRequest);
await collectBatch(workerClient, [{ id: 'typed', request: typedRequest }]);
const typedOptions: PdfCompilationOptions = { onSuccess: (_value, submitted) => submitted.input satisfies unknown };
void typedOptions;
// @ts-expect-error input does not match ReportInput
const wrongInput: PdfRequest<ReportInput> = { template: 'Hello', input: { title: 1, rows: [] } };
void wrongInput;
// Dev-time template checks.
const checker: TemplateChecker = await createTemplateChecker({ wasm, fonts: [font] });
const checkOptions: TemplateCheckOptions = { modes: ['minimal', 'full'], pdf: { standards: ['ua-1'] } };
const report: TemplateCheckReport = await checker.check({ entrypoint: 'main.typ', files: { 'main.typ': 'Hello' } }, checkOptions);
report.ok satisfies boolean;
const checkResult: TemplateCheckResult | undefined = report.results[0];
checkResult?.mode satisfies SampleMode;
checkResult?.bytes satisfies Uint8Array | undefined;
checkResult?.error?.code satisfies string | undefined;
checkResult?.diagnostics.length satisfies number | undefined;
(await checkTemplate('Hello', { wasm, fonts: [font], modes: ['full'] })).ok satisfies boolean;
await checker.dispose();
// @ts-expect-error an unknown sample mode
const badMode: TemplateCheckOptions = { modes: ['sparse'] };
void badMode;
// A plain PdfRequest keeps working, and a loaded template folder is a PdfTemplate.
const folderTemplate: PdfTemplate = templateFromFiles({ './report/main.typ': 'Hello' }, { entrypoint: 'main.typ' });
await compiler.compile({ template: folderTemplate, input: {} });
`);
run(process.execPath, ['smoke.mjs', root]);
run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022',
  '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', 'consumer.ts']);
console.log('Packed public TypeScript declarations check without skipLibCheck.');
