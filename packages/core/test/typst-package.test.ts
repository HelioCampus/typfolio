import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import init, { TypstCompilerBuilder } from '@typfolio/wasm';
import { capabilities, createCompiler, TypstPdfError } from '../dist/index.js';
import type { ErrorCode, PdfCompiler, PdfResult } from '../dist/index.js';
import { typfolioPackage } from '../dist/typst-package.generated.js';
import { sampleFile, sampleSource } from '../../dev-tools/dist/sample-source.generated.js'; // built before the tests run (`npm test` builds first)

const root = new URL('../../../', import.meta.url);
const file = (path: string) => readFile(new URL(path, root));
const packageRoot = new URL('packages/core/typst-packages/', root);
const hasCode = (code: ErrorCode) => (error: unknown) => error instanceof TypstPdfError && error.code === code;
const encoder = new TextEncoder();
const helper = '#import "@local/typfolio:0.1.0": input\n';
// Prints the value as JSON in the document title so tests can assert on the whole structure.
const dump = (expression: string) => `#set document(title: json.encode(${expression}, pretty: false))\n`;
const sampleOf = (result: PdfResult): Record<string, unknown> => JSON.parse(result.metadata.title!);

interface RawResult {
  ok: boolean;
  message: string;
  title: string | undefined;
}

interface RawCompiler {
  compile(files: Record<string, string>, entrypoint?: string, inputs?: string[][]): RawResult;
}

let compiler!: PdfCompiler;
let wasm!: Buffer;
let raw!: RawCompiler;

// The editor branch cannot go through createCompiler (core always sets the marker), so this drives the
// binding like engine.ts does, but with no marker and every shipped package file (including sample.typ) read from disk.
async function createRaw(): Promise<RawCompiler> {
  const packageDir = '/@editor/typfolio';
  const builder = new TypstCompilerBuilder();
  await builder.set_access_model(undefined, () => 0, () => false, (path: string) => path, (path: string) => { throw new Error(`Not supplied: ${path}`); });
  await builder.set_package_registry(undefined, () => packageDir);
  await builder.add_raw_font(new Uint8Array(await file('fixtures/fonts/LibertinusSerif-Regular.otf')));
  const compiler = await builder.build();
  const sources = Object.fromEntries(await Promise.all(['typst.toml', 'lib.typ', 'sample.typ'].map(async (name): Promise<[string, Buffer]> =>
    [name, await readFile(new URL(`local/typfolio/0.1.0/${name}`, packageRoot))])));
  return {
    compile(files, entrypoint = '/main.typ', inputs = []) {
      compiler.reset_shadow();
      try {
        for (const [name, bytes] of Object.entries(sources)) compiler.map_shadow(`${packageDir}/${name}`, new Uint8Array(bytes));
        for (const [path, source] of Object.entries(files)) assert.ok(compiler.map_shadow(path, encoder.encode(source)));
        const world = compiler.snapshot('/', entrypoint, inputs);
        try {
          const compiled = world.compile(0, 3);
          return { ok: !compiled.hasError, message: compiled.diagnostics.map((d: { message: string }) => d.message).join('\n'), title: world.title(0) };
        } finally { world.free(); }
      } finally { compiler.reset_shadow(); }
    },
  };
}

// Zod 4 `z.toJSONSchema()` shapes: nullable object as anyOf with null, enum, defaulted array, nested object, $defs + $ref.
const zodSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    generatedAt: { type: 'string', format: 'date-time', pattern: '^\\d{4}$' },
    status: { type: 'string', enum: ['draft', 'final'] },
    author: {
      anyOf: [
        { type: 'object', properties: { name: { type: 'string' }, role: { type: ['string', 'null'] } }, required: ['name', 'role'], additionalProperties: false },
        { type: 'null' },
      ],
    },
    students: { type: 'array', items: { $ref: '#/$defs/Student' } },
    extras: { default: [], type: 'array', items: { $ref: '#/$defs/Student' } },
    meta: { default: { version: 1 }, type: 'object', properties: { version: { type: 'number' }, label: { type: 'string' } }, required: ['version', 'label'] },
  },
  required: ['title', 'generatedAt', 'status', 'author', 'students', 'extras', 'meta'],
  additionalProperties: false,
  $defs: {
    Student: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        score: { type: 'integer', minimum: 0, maximum: 100 },
        email: { type: 'string', format: 'email' },
        tags: { default: [], type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'score', 'tags'],
      additionalProperties: false,
    },
  },
};
const student = { name: 'Sample text', score: 0, email: 'user@example.com', tags: ['Sample text'] };
const zodSample = {
  title: 'Sample text',
  subtitle: 'Sample text',
  generatedAt: '2024-01-15T09:30:00Z',
  status: 'draft',
  author: { name: 'Sample text', role: 'Sample text' },
  students: [student],
  extras: [student],
  meta: { version: 1, label: 'Sample text' },
};

before(async () => {
  wasm = await file('packages/wasm/generated/compiler_bg.wasm');
  compiler = await createCompiler({ wasm, fonts: [await file('fixtures/fonts/LibertinusSerif-Regular.otf')] });
  await init({ module_or_path: wasm });
  raw = await createRaw();
});
after(() => compiler?.dispose());

const reportTemplate = (path: string) => `${helper}#let data = input(json.with("${path}"))\n#set document(title: data.title)\n= #data.title\n`;

test('the runtime branch returns request.input and needs no schema file in the request', async () => {
  const result = await compiler.compile({ template: reportTemplate('./report.schema.json'), input: { title: 'From the request' } });
  assert.equal(result.metadata.title, 'From the request');
  assert.deepEqual(result.diagnostics, []);
  // Passing no schema is fine at runtime: the sample is only needed in the editor.
  const none = await compiler.compile({ template: `${helper}#set document(title: input(none).title)`, input: { title: 'No schema' } });
  assert.equal(none.metadata.title, 'No schema');
});

test('the runtime branch works from a nested entrypoint and ignores a schema that is present', async () => {
  const entrypoint = 'reports/outcome/main.typ';
  const nested = await compiler.compile({
    template: { entrypoint, files: { [entrypoint]: reportTemplate('./schemas/report.schema.json') } },
    input: { title: 'Nested runtime' },
  });
  assert.equal(nested.metadata.title, 'Nested runtime');
  const withSchema = await compiler.compile({
    template: { files: { 'main.typ': reportTemplate('./report.schema.json'), 'report.schema.json': JSON.stringify({ type: 'object', properties: { title: { type: 'string' } } }) } },
    input: { title: 'Real input wins' },
  });
  assert.equal(withSchema.metadata.title, 'Real input wins');
});

test('the vite-react example template compiles at runtime and in the editor branch', async () => {
  const files = {
    'main.typ': await file('examples/vite-react/src/report/main.typ').then(String),
    'report.schema.json': await file('examples/vite-react/src/report/report.schema.json').then(String),
  };
  const input = Object.fromEntries(Object.keys(JSON.parse(files['report.schema.json']).properties).map(key => [key, `value of ${key}`]));
  // The schema is not sent at runtime (the app's glob only matches *.typ).
  const { 'report.schema.json': _schema, ...runtimeFiles } = files;
  const result = await compiler.compile({ template: { files: runtimeFiles }, input });
  assert.equal(result.metadata.title, 'value of title');
  assert.deepEqual(result.diagnostics, []);
  const editor = raw.compile(Object.fromEntries(Object.entries(files).map(([name, source]) => [`/${name}`, source])));
  assert.equal(editor.ok, true, editor.message);
  assert.equal(editor.title, 'Sample text');
});

test('/input.json at the project root still works beside the package', async () => {
  const result = await compiler.compile({
    template: `${helper}#let a = input(none)\n#let b = json("/input.json")\n#set document(title: a.title + "|" + b.title)`,
    input: { title: 'both' },
  });
  assert.equal(result.metadata.title, 'both|both');
});

test('the editor branch builds a shape-complete sample from a Zod-4-shaped schema', () => {
  const result = raw.compile({
    '/main.typ': helper + '#let data = input(json.with("./report.schema.json"))\n' + dump('data'),
    '/report.schema.json': JSON.stringify(zodSchema),
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(JSON.parse(result.title!), zodSample);
});

test('the editor branch resolves the schema path relative to a nested template', () => {
  const entrypoint = '/reports/outcome/main.typ';
  const result = raw.compile({
    [entrypoint]: helper + '#let data = input(json.with("./schemas/report.schema.json"))\n' + dump('data'),
    '/reports/outcome/schemas/report.schema.json': JSON.stringify(zodSchema),
  }, entrypoint);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(JSON.parse(result.title!), zodSample);
});

test('input accepts a loaded schema dictionary in the editor branch', () => {
  const result = raw.compile({
    '/main.typ': helper + '#let data = input(json("report.schema.json"))\n' + dump('data'),
    '/report.schema.json': JSON.stringify({ type: 'object', properties: { n: { type: 'integer' } } }),
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(JSON.parse(result.title!), { n: 1 });
});

test('input(none) panics with a message that names json.with in the editor branch', () => {
  const result = raw.compile({ '/main.typ': `${helper}#let data = input(none)\n` });
  assert.equal(result.ok, false);
  assert.match(result.message, /needs a JSON Schema/);
  assert.match(result.message, /json\.with\(/);
  const wrongType = raw.compile({ '/main.typ': `${helper}#let data = input("schema.json")\n` });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.message, /expects json\.with/);
});

// sample.typ is not part of the package a runtime compile sees, so these tests mount its source as a template file.
async function sample(schema: unknown, mode = 'full', name = 'schema.json') {
  const result = await compiler.compile({
    template: { files: {
      'main.typ': `#import "sample.typ": sample-from-schema\n#let schema = json("${name}")\n${dump(`sample-from-schema(schema, mode: "${mode}")`)}`,
      'sample.typ': sampleSource,
      [name]: typeof schema === 'string' ? schema : JSON.stringify(schema),
    } },
    input: null,
  });
  return sampleOf(result);
}

test('sample-from-schema can be called directly on a schema given as a template file', async () => {
  assert.deepEqual(await sample(JSON.stringify(zodSchema, null, 2)), zodSample);
});

test('sample-from-schema: preferences, merging, formats, type arrays and inference', async () => {
  const s = await sample({
    type: 'object',
    properties: {
      example: { type: 'string', examples: ['from examples'], default: 'from default' },
      fromDefault: { type: 'string', default: 'from default' },
      constant: { const: 'fixed' },
      choice: { enum: [null, 'a', 'b'] },
      emptyDefault: { type: 'array', default: [], items: { type: 'integer' } },
      emptyObjectDefault: { type: 'object', default: {}, properties: { x: { type: 'boolean' } } },
      partial: { type: 'object', default: { b: 2 }, properties: { a: { type: 'string' }, b: { type: 'integer' } } },
      minItems: { type: 'array', minItems: 3, items: { type: 'integer', minimum: 5 } },
      noItems: { type: 'array' },
      date: { type: 'string', format: 'date' },
      uuid: { type: 'string', format: 'uuid' },
      typeArray: { type: ['null', 'integer'] },
      onlyNull: { type: 'null' },
      inferredObject: { properties: { y: { type: 'number' } } },
      inferredArray: { items: { type: 'string', format: 'uri' } },
      oneOf: { oneOf: [{ type: 'null' }, { type: 'boolean' }] },
      allOf: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'integer' } } }] },
      unknown: {},
    },
  });
  assert.deepEqual(s, {
    example: 'from examples',
    fromDefault: 'from default',
    constant: 'fixed',
    choice: 'a',
    emptyDefault: [1],
    emptyObjectDefault: { x: true },
    partial: { a: 'Sample text', b: 2 },
    minItems: [5, 5, 5],
    noItems: [],
    date: '2024-01-15',
    uuid: '123e4567-e89b-12d3-a456-426614174000',
    typeArray: 1,
    onlyNull: null,
    inferredObject: { y: 1 },
    inferredArray: ['https://example.com'],
    oneOf: true,
    allOf: { a: 'Sample text', b: 1 },
    unknown: null,
  });
});

test('sample-from-schema: a recursive $ref ends instead of looping', async () => {
  const s = await sample({
    $ref: '#/$defs/Node',
    $defs: {
      Node: {
        type: 'object',
        properties: { name: { type: 'string' }, parent: { anyOf: [{ $ref: '#/$defs/Node' }, { type: 'null' }] }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } },
      },
    },
  });
  assert.equal(s.name, 'Sample text');
  assert.equal(s.parent, null);
  assert.deepEqual(s.children, [null]);
});

test('imports other than the bundled package fail with COMPILATION naming the supported one', async () => {
  for (const spec of ['@local/typfolio:0.2.0', '@local/other:0.1.0', '@preview/cetz:0.3.0']) {
    await assert.rejects(compiler.compile({ template: `#import "${spec}": x`, input: null }), (error: TypstPdfError) => {
      assert.ok(hasCode('COMPILATION')(error));
      assert.match(error.message, /Only @local\/typfolio:0\.1\.0 is available; remote Typst packages are not supported/);
      assert.ok(error.message.includes(`requested ${spec}`), error.message);
      return true;
    });
  }
});

test('template files and assets under the reserved package directory are rejected', async () => {
  const bundled = '/@typfolio/packages/local/typfolio/0.1.0/lib.typ';
  for (const name of ['@typfolio/packages/local/typfolio/0.1.0/lib.typ', bundled, '@typfolio/other.typ', '@typfolio/packages/local/typfolio/0.1.0/input.json', '@typfolio']) {
    await assert.rejects(compiler.compile({ template: { files: { 'main.typ': 'x', [name]: 'y' } }, input: null }), (error: TypstPdfError) => {
      assert.ok(hasCode('INVALID_REQUEST')(error), error.message);
      assert.match(error.message, /@typfolio.* reserved|reserved.*@typfolio/);
      return true;
    });
    await assert.rejects(compiler.compile({ template: 'x', input: null, assets: { [name]: new Uint8Array([1]) } }), hasCode('INVALID_REQUEST'));
  }
  // A look-alike name outside the reserved directory stays allowed.
  await compiler.compile({ template: { files: { 'main.typ': 'x', '@typfolio-notes/readme.typ': 'y' } }, input: null });
});

test('capabilities advertise the bundled package and still no remote packages', () => {
  assert.deepEqual(capabilities.typstPackages, ['@local/typfolio:0.1.0']);
  assert.equal(Object.isFrozen(capabilities.typstPackages), true);
  assert.equal(capabilities.remotePackages, false);
  assert.equal(compiler.capabilities, capabilities);
});

async function walk(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? walk(path) : [path];
  }))).flat();
}

const minimalZodSample = {
  title: '',
  generatedAt: '',
  status: 'draft',
  author: null,
  students: [],
  extras: [],
  meta: { version: 0, label: '' },
};

test('the editor branch builds the minimal sample when --input typfolio-sample=minimal is set', () => {
  const files = {
    '/main.typ': helper + '#let data = input(json.with("./report.schema.json"))\n' + dump('data'),
    '/report.schema.json': JSON.stringify(zodSchema),
  };
  const minimal = raw.compile(files, '/main.typ', [['typfolio-sample', 'minimal']]);
  assert.equal(minimal.ok, true, minimal.message);
  assert.deepEqual(JSON.parse(minimal.title!), minimalZodSample);
  const full = raw.compile(files, '/main.typ', [['typfolio-sample', 'full']]);
  assert.deepEqual(JSON.parse(full.title!), zodSample);
  const bad = raw.compile(files, '/main.typ', [['typfolio-sample', 'sparse']]);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /sample mode must be "full" or "minimal"/);
});

test('sample-from-schema minimal: required only, nullables, empty arrays, minimums, ignored examples and defaults', async () => {
  const s = await sample({
    type: 'object',
    properties: {
      name: { type: 'string', examples: ['ignored'], default: 'ignored' },
      optional: { type: 'string' },
      nullableType: { type: ['integer', 'null'] },
      nullableAnyOf: { anyOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { type: 'null' }] },
      nullableOneOf: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      onlyNull: { type: 'null' },
      list: { type: 'array', items: { type: 'string' } },
      defaultedList: { type: 'array', default: ['x'], items: { type: 'string' } },
      pair: { type: 'array', minItems: 2, items: { type: 'object', properties: { n: { type: 'integer', minimum: 7 } }, required: ['n'] } },
      noItems: { type: 'array', minItems: 2 },
      padded: { type: 'string', minLength: 3 },
      choice: { type: 'string', enum: ['b', 'a'] },
      constant: { const: 'fixed' },
      minimum: { type: 'integer', minimum: 5 },
      exclusive: { type: 'integer', exclusiveMinimum: 10 },
      decimal: { type: 'number', exclusiveMinimum: 0 },
      plain: { type: 'number' },
      flag: { type: 'boolean', default: true },
      date: { type: 'string', format: 'date' },
      inferredObject: { properties: { y: { type: 'number' }, z: { type: 'number' } }, required: ['z'] },
      inferredArray: { items: { type: 'string' } },
      firstBranch: { anyOf: [{ type: 'integer', minimum: 2 }, { type: 'string' }] },
      allOf: { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] }] },
      viaRef: { $ref: '#/$defs/Tag' },
      undeclared: {},
    },
    required: ['name', 'nullableType', 'nullableAnyOf', 'nullableOneOf', 'onlyNull', 'list', 'defaultedList', 'pair', 'noItems', 'padded', 'choice', 'constant',
      'minimum', 'exclusive', 'decimal', 'plain', 'flag', 'date', 'inferredObject', 'inferredArray', 'firstBranch', 'allOf', 'viaRef', 'unlisted'],
    $defs: { Tag: { type: 'object', properties: { label: { type: 'string' }, note: { type: 'string' } }, required: ['label'] } },
  }, 'minimal');
  assert.deepEqual(s, {
    name: '',
    nullableType: null,
    nullableAnyOf: null,
    nullableOneOf: null,
    onlyNull: null,
    list: [],
    defaultedList: [],
    pair: [{ n: 7 }, { n: 7 }],
    noItems: [],
    padded: 'aaa',
    choice: 'b',
    constant: 'fixed',
    minimum: 5,
    exclusive: 11,
    decimal: 0,
    plain: 0,
    flag: false,
    date: '',
    inferredObject: { z: 0 },
    inferredArray: [],
    firstBranch: 2,
    allOf: { a: '', b: 0 },
    viaRef: { label: '' },
    unlisted: null,
  });
  // Without `required` nothing is present.
  assert.deepEqual(await sample({ type: 'object', properties: { a: { type: 'string' } } }, 'minimal'), {});
});

test('sample-from-schema minimal: a recursive $ref ends instead of looping', async () => {
  const s = await sample({
    $ref: '#/$defs/Node',
    $defs: {
      Node: {
        type: 'object',
        properties: { name: { type: 'string' }, next: { $ref: '#/$defs/Node' }, children: { type: 'array', minItems: 1, items: { $ref: '#/$defs/Node' } } },
        required: ['name', 'next', 'children'],
      },
    },
  }, 'minimal');
  assert.equal(s.name, '');
  assert.equal(s.next, null);
  assert.deepEqual(s.children, [null]);
});

test('sample-from-schema defaults to full mode and rejects an unknown mode', async () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  assert.deepEqual(await sample(schema), { a: 'Sample text' });
  await assert.rejects(sample(schema, 'sparse'), (error: TypstPdfError) => hasCode('COMPILATION')(error) && /sample mode must be "full" or "minimal"/.test(error.message));
});

test('the generated modules equal the shipped package files, and the runtime module has no sample.typ', async () => {
  const directory = new URL(`${typfolioPackage.namespace}/${typfolioPackage.name}/${typfolioPackage.version}/`, packageRoot);
  const onDisk: Record<string, string> = {};
  for (const path of await walk(directory)) onDisk[fileURLToPath(path).slice(fileURLToPath(directory).length)] = await readFile(path, 'utf8');
  assert.deepEqual(Object.keys(onDisk).sort(), ['lib.typ', 'sample.typ', 'typst.toml']);
  // The runtime module embeds typst.toml and lib.typ only.
  const { 'sample.typ': diskSample, ...diskRuntime } = onDisk;
  assert.deepEqual({ ...typfolioPackage.files }, diskRuntime);
  assert.deepEqual(Object.keys(typfolioPackage.files).sort(), ['lib.typ', 'typst.toml']);
  // (`sample-from-schema` is no marker: lib.typ names it in its import.) These appear only in sample.typ.
  const generated = await readFile(new URL('../dist/typst-package.generated.js', import.meta.url), 'utf8');
  for (const marker of ['_is-nullable', 'Sample text', '123e4567-e89b-12d3-a456-426614174000']) {
    assert.ok(diskSample.includes(marker), `${marker} must be in sample.typ`);
    assert.ok(!generated.includes(marker), `the runtime module must not contain the sample builder (${marker})`);
  }
  // The @typfolio/dev-tools module embeds sample.typ and nothing else.
  assert.equal(sampleFile, 'sample.typ');
  assert.equal(sampleSource, diskSample);
  const manifest = onDisk['typst.toml'];
  assert.match(manifest, new RegExp(`^name = "${typfolioPackage.name}"$`, 'm'));
  assert.match(manifest, new RegExp(`^version = "${typfolioPackage.version}"$`, 'm'));
  assert.match(manifest, /^entrypoint = "lib\.typ"$/m);
});
