// Regenerates packages/verapdf-wasm/native-image/META-INF/native-image/reachability-metadata.json, the checked-in list
// of what the WebAssembly image may reach by reflection or load as a resource. Run it after changing the veraPDF
// version or the Java sources, review the diff and commit it; the build itself never traces.
//
//   npm run trace:verapdf [-- <directory of sample PDFs>]     (default: .build/test-output, written by npm test)
//
// It runs the validator on the JVM under GraalVM's tracing agent, for every sample PDF and flavour, and then makes
// the result independent of which samples there were:
// - Rhino's bytecode compiler is removed. veraPDF asks Rhino for optimisation level 9, which compiles each rule test
//   to JVM bytecode; an ahead-of-time image cannot load that. Rhino looks the compiler up by reflection and falls
//   back to its interpreter when the lookup fails.
// - Every veraPDF model class is registered with all its members: rule tests call model getters through Rhino, by
//   reflection, and tracing only sees the getters the samples reached.
// - The JDK collection classes that model getters return are registered with their public methods, for the same
//   reason.
// - Font data, validation profiles and Rhino's messages are included whole, not just the files the samples read.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { capture, classpath, graalvmHome, javaSources, pin, root, run, verifiedJars, work } from './verapdf-source.ts';

const FLAVOURS = ['ua1', 'ua2', '1a', '1b', '2a', '2b', '2u', '3a', '3b', '3u', '4', '4e', '4f', 'wt1a', 'wt1r'];
const MODEL_PACKAGES = ['org/verapdf/model/', 'org/verapdf/gf/model/'];
const RESOURCE_GLOBS = ['font/*', 'font/cmap/*', 'font/stdmetrics/*', 'org/verapdf/pdfa/validation/*', 'org/verapdf/release/*', 'org/mozilla/javascript/resources/*'];
const BUNDLES = ['org.mozilla.javascript.resources.Messages'];
// Rule tests also call methods of the collections that model getters return (`list.contains(...)`), again through
// Rhino by reflection. Which list class a getter returns depends on the file, so the usual ones are registered.
const JDK_COLLECTIONS = ['java.util.ArrayList', 'java.util.LinkedList', 'java.util.Arrays$ArrayList', 'java.util.HashSet', 'java.util.LinkedHashSet',
  'java.util.TreeSet', 'java.util.HashMap', 'java.util.LinkedHashMap', 'java.util.TreeMap', 'java.util.Collections$EmptyList',
  'java.util.Collections$EmptySet', 'java.util.Collections$EmptyMap', 'java.util.Collections$SingletonList', 'java.util.Collections$SingletonSet',
  'java.util.Collections$UnmodifiableList', 'java.util.Collections$UnmodifiableRandomAccessList', 'java.util.Collections$UnmodifiableSet',
  'java.util.Collections$UnmodifiableCollection', 'java.util.Collections$UnmodifiableMap', 'java.util.ImmutableCollections$List12',
  'java.util.ImmutableCollections$ListN', 'java.util.ImmutableCollections$Set12', 'java.util.ImmutableCollections$SetN', 'java.util.ArrayList$SubList',
  'java.util.List', 'java.util.Set', 'java.util.Collection', 'java.util.Map'];
const ALL_MEMBERS = { allPublicMethods: true, allDeclaredMethods: true, allPublicFields: true, allDeclaredFields: true };

const samples = resolve(process.argv[2] ?? join(root, '.build/test-output'));
const pdfs = readdirSync(samples).filter(name => name.endsWith('.pdf')).sort().map(name => join(samples, name));
if (pdfs.length === 0) throw new Error(`No sample PDFs in ${samples}. Run npm test first, or pass a directory.`);

const home = graalvmHome();
const jars = verifiedJars();
const classes = join(work, 'trace/classes');
const traced = join(work, 'trace/metadata');
rmSync(join(work, 'trace'), { recursive: true, force: true });
mkdirSync(classes, { recursive: true });
// The Web Image entry needs the Web Image API, which only the image build has; tracing runs the plain entry.
run(join(home, 'bin/javac'), ['-parameters', '-cp', classpath(...jars), '-d', classes, ...javaSources().filter(file => !file.endsWith(`${pin.mainClass}.java`))]);
for (const flavour of FLAVOURS) {
  console.log(`tracing ${flavour} over ${pdfs.length} files`);
  run(join(home, 'bin/java'), [`-agentlib:native-image-agent=config-merge-dir=${traced}`, '-cp', classpath(classes, ...jars), 'Validate', flavour, ...pdfs],
    { stdio: ['ignore', 'ignore', 'inherit'] });
}

type Entry = Record<string, unknown> & { type?: unknown };
const metadata: { reflection?: Entry[]; resources?: Entry[] } & Record<string, unknown> = JSON.parse(readFileSync(join(traced, 'reachability-metadata.json'), 'utf8'));
const reflection = new Map<string, Entry>();
for (const entry of metadata.reflection ?? []) {
  const key = JSON.stringify(entry.type);
  if (key.includes('org.mozilla.javascript.optimizer')) continue;
  reflection.set(key, entry);
}
for (const jar of jars) {
  for (const name of capture(join(home, 'bin/jar'), ['tf', jar], { maxBuffer: 64 * 1024 * 1024 }).split('\n')) {
    if (!name.endsWith('.class') || !MODEL_PACKAGES.some(prefix => name.startsWith(prefix))) continue;
    const type = name.slice(0, -'.class'.length).replaceAll('/', '.');
    const key = JSON.stringify(type);
    reflection.set(key, { ...(reflection.get(key) ?? { type }), ...ALL_MEMBERS });
  }
}
for (const type of JDK_COLLECTIONS) {
  const key = JSON.stringify(type);
  reflection.set(key, { ...(reflection.get(key) ?? { type }), allPublicMethods: true });
}
// Stable order and member order, so that a re-trace only shows real changes.
const sortMembers = (entry: Entry) => {
  for (const member of ['methods', 'fields'] as const) {
    const list = entry[member];
    if (Array.isArray(list)) entry[member] = list.map(item => JSON.stringify(item)).sort().map(item => JSON.parse(item));
  }
  return entry;
};
metadata.reflection = [...reflection.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => sortMembers(entry));
const resources = new Set((metadata.resources ?? []).map(entry => JSON.stringify(entry)));
for (const glob of RESOURCE_GLOBS) resources.add(JSON.stringify({ glob }));
for (const bundle of BUNDLES) resources.add(JSON.stringify({ bundle }));
metadata.resources = [...resources].sort().map(entry => JSON.parse(entry));

const output = join(root, pin.metadataDirectory, 'META-INF/native-image');
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'reachability-metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(`${metadata.reflection.length} reflection entries and ${metadata.resources.length} resource entries written to ${join(pin.metadataDirectory, 'META-INF/native-image/reachability-metadata.json')}`);
