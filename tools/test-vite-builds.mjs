import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const provenance = JSON.parse(await readFile(new URL('../packages/wasm/generated/provenance.json', import.meta.url)));

const pin = JSON.parse(await readFile(new URL('../compiler-source.json', import.meta.url)));
assert.equal(provenance.revision, pin.revision, 'provenance must record the pinned source revision');
assert.equal(provenance.crateType, pin.crateType, 'provenance must record the pinned crate type');
assert.equal(provenance.wasmOpt, pin.wasmOpt, 'provenance must record the pinned wasm-opt setting');
assert.deepEqual(provenance.cargoProfile, pin.cargoProfile, 'provenance must record the pinned cargo profile');

function build(config, ...args) {
  const result = spawnSync(process.execPath, [vite, 'build', '--config', config, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error('Vite build failed for ' + config);
  }
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = directory + '/' + entry.name;
    return entry.isDirectory() ? files(path) : [path];
  }));
  return nested.flat();
}

async function verify(name, { largeScripts = [] } = {}) {
  const directory = root + '.build/' + name;
  const output = await files(directory);
  const wasmFiles = output.filter(path => path.endsWith('.wasm'));
  const javascriptFiles = output.filter(path => /\.m?js$/.test(path));
  assert.equal(wasmFiles.length, 1, name + ' must emit exactly one WASM asset');
  const wasmBytes = await readFile(wasmFiles[0]);
  assert.equal(createHash('sha256').update(wasmBytes).digest('hex'), provenance.wasm.sha256);
  for (const path of javascriptFiles) {
    const source = await readFile(path, 'utf8');
    assert.ok(!source.includes('data:application/wasm'), path + ' contains an inlined WASM data URL');
    assert.ok(!source.includes('AGFzbQE'), path + ' appears to contain base64-encoded WASM');
    const limit = largeScripts.some(pattern => pattern.test(path)) ? 2 * 1024 * 1024 : 1024 * 1024;
    assert.ok((await stat(path)).size < limit, path + ' is unexpectedly large');
  }
  return {
    outputFiles: output.length,
    javascriptBytes: (await Promise.all(javascriptFiles.map(path => stat(path)))).reduce((sum, value) => sum + value.size, 0),
    wasmBytes: wasmBytes.length,
  };
}

async function verifyReactBoundary() {
  const directory = root + '.build/vite-react';
  const output = await files(directory);
  const javascriptFiles = output.filter(path => /\.m?js$/.test(path));
  const html = await readFile(directory + '/index.html', 'utf8');
  const entryUrl = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  assert.ok(entryUrl, 'React build must have a JavaScript entry');
  const entry = directory + entryUrl;
  const direct = javascriptFiles.find(path => /\/DirectPage-[^/]+\.js$/.test(path));
  const worker = javascriptFiles.find(path => /\/WorkerPage-[^/]+\.js$/.test(path));
  assert.ok(direct, 'React build must emit a direct compiler route chunk');
  assert.ok(worker, 'React build must emit a worker compiler route chunk');

  const entrySource = await readFile(entry, 'utf8');
  const directSource = await readFile(direct, 'utf8');
  const workerSource = await readFile(worker, 'utf8');
  const allSource = (await Promise.all(javascriptFiles.map(path => readFile(path, 'utf8')))).join('\n');
  for (const [name, source] of [['entry', entrySource], ['direct route', directSource]]) {
    assert.ok(!source.includes('Typfolio worker'), `${name} contains worker implementation text`);
    assert.ok(!source.includes('The worker queue limit'), `${name} contains worker queue code`);
  }
  assert.ok(workerSource.includes('The worker queue limit'), 'worker route does not contain the worker client');
  assert.ok(!allSource.includes('html2canvas'), 'React build includes unused DOM capture code');
  // The runtime path embeds lib.typ (`input()`), not the sample builder that only dev-tools ships.
  assert.ok(allSource.includes(runtimePackageMarker), 'React build is missing the bundled Typst package text');
  for (const marker of sampleBuilderMarkers) {
    assert.ok(!allSource.includes(marker), 'React build contains the dev-tools sample builder: ' + marker);
  }
}

// Strings from sample.typ that survive minification and do not occur in lib.typ. (`sample-from-schema`
// is no marker: lib.typ names it in its import.) Text from lib.typ proves the runtime package is bundled.
const runtimePackageMarker = 'input() needs a JSON Schema';
const sampleBuilderMarkers = ['_is-nullable', 'Sample text', '123e4567-e89b-12d3-a456-426614174000'];

// Positive control for the check above: a bundle that imports @typfolio/core/dev-tools must contain every marker.
async function verifyDevToolsBuild() {
  const entryDirectory = root + '.build/vite-devtools-entry';
  const outDir = root + '.build/vite-devtools';
  await mkdir(entryDirectory, { recursive: true });
  await writeFile(entryDirectory + '/entry.js', "import { createTemplateChecker } from '@typfolio/core/dev-tools';\nconsole.log(createTemplateChecker);\n");
  await viteBuild({
    configFile: false, root, logLevel: 'warn',
    build: { outDir, emptyOutDir: true, rollupOptions: { input: entryDirectory + '/entry.js', output: { entryFileNames: 'entry.js' } } },
  });
  const sources = await Promise.all((await files(outDir)).filter(path => /\.m?js$/.test(path)).map(path => readFile(path, 'utf8')));
  const all = sources.join('\n');
  for (const marker of [runtimePackageMarker, ...sampleBuilderMarkers]) {
    assert.ok(all.includes(marker), 'positive control: the dev-tools bundle is missing ' + marker);
  }
  return { devToolsBytes: all.length };
}

// Strings from inside html2canvas that survive minification. The app's own text
// (error messages, the lazy chunk's file name) also says "html2canvas", so absence
// checks must use these. verifyCaptureBuilds proves they match in the DOM build.
const html2canvasMarkers = [
  'data-html2canvas-ignore',
  'html2canvas-container',
  'Unable to find element in cloned iframe',
];

async function verifyCaptureBuilds() {
  const read = async name => {
    const output = (await files(root + '.build/' + name)).filter(path => /\.m?js$/.test(path));
    return Promise.all(output.map(async path => ({ path, source: await readFile(path, 'utf8') })));
  };
  const hasMarkers = source => html2canvasMarkers.every(marker => source.includes(marker));

  // Applications that use captureAssets/captureProps and svgCapture never get html2canvas.
  const svg = await read('vite-capture-svg');
  assert.ok(svg.some(({ path }) => path.endsWith('/entry.js')), 'SVG capture build must emit its entry');
  for (const { path, source } of svg) {
    assert.ok(source.includes('data-typfolio-capture'), path + ' is missing the capture code it should contain');
    assert.ok(!source.includes('html2canvas'), path + ' mentions html2canvas without the DOM adapter');
    for (const marker of html2canvasMarkers) {
      assert.ok(!source.includes(marker), path + ' contains html2canvas code: ' + marker);
    }
  }

  // Applications that use domPngCapture load html2canvas from a separate lazy chunk.
  const dom = await read('vite-capture-dom');
  const entry = dom.find(({ path }) => path.endsWith('/entry.js'));
  assert.ok(entry, 'DOM capture build must emit its entry');
  const chunks = dom.filter(({ source }) => hasMarkers(source));
  assert.equal(chunks.length, 1, 'positive control: exactly one chunk must contain every html2canvas marker');
  const [chunk] = chunks;
  assert.notEqual(chunk.path, entry.path, 'html2canvas is bundled into the entry chunk');
  for (const marker of html2canvasMarkers) {
    assert.ok(!entry.source.includes(marker), 'entry chunk contains html2canvas code: ' + marker);
  }
  const chunkName = chunk.path.slice(chunk.path.lastIndexOf('/') + 1);
  const references = entry.source.split(chunkName).length - 1;
  const dynamicImports = entry.source.match(new RegExp('import\\(\\s*[`"\'][^`"\']*' + chunkName.replace(/\./g, '\\.'), 'g')) ?? [];
  assert.equal(references, 1, 'entry must reference the html2canvas chunk exactly once');
  assert.equal(dynamicImports.length, 1, 'entry must load the html2canvas chunk only through a dynamic import()');
  return { entryBytes: entry.source.length, html2canvasChunk: chunkName, html2canvasBytes: chunk.source.length };
}

build('examples/vite-app/vite.config.mjs');
build('examples/vite-library/vite.config.mjs');
build('examples/vite-react/vite.config.ts');
build('examples/pretext-hybrid/vite.config.ts');
build('examples/vite-capture/vite.config.mjs', '--mode', 'svg');
build('examples/vite-capture/vite.config.mjs', '--mode', 'dom');
await verifyReactBoundary();
const captureBuilds = await verifyCaptureBuilds();
const devToolsBuild = await verifyDevToolsBuild();

console.log(JSON.stringify({
  app: await verify('vite-app'),
  library: await verify('vite-library'),
  reactRouted: await verify('vite-react'),
  pretextHybrid: await verify('pretext-hybrid', { largeScripts: [/pdf\.worker/] }),
  captureDom: captureBuilds,
  devTools: devToolsBuild,
  wasmExternal: true,
}, null, 2));
