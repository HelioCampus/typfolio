import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = path => readFile(new URL(path, `file://${root}`));
const packages = ['wasm', 'core', 'workers', 'react'];

test('the root LICENSE is the Apache License 2.0 and NOTICE names the copyright holder', async () => {
  const license = (await read('LICENSE')).toString('utf8');
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  assert.match((await read('NOTICE')).toString('utf8'), /^Typfolio\nCopyright 2026 HelioCampus\n/);
});

test('every package carries a byte-identical copy of LICENSE and declares Apache-2.0', async () => {
  const license = await read('LICENSE');
  assert.equal(JSON.parse(await read('package.json')).license, 'Apache-2.0');
  for (const name of packages) {
    assert.ok((await read(`packages/${name}/LICENSE`)).equals(license), `packages/${name}/LICENSE differs from the root LICENSE`);
    assert.equal(JSON.parse(await read(`packages/${name}/package.json`)).license, 'Apache-2.0', `@typfolio/${name} license field`);
  }
});

test('@typfolio/wasm carries a byte-identical copy of NOTICE and lists it and its third-party notices and licences in files', async () => {
  assert.ok((await read('packages/wasm/NOTICE')).equals(await read('NOTICE')), 'packages/wasm/NOTICE differs from the root NOTICE');
  const manifest = JSON.parse(await read('packages/wasm/package.json'));
  assert.ok(['NOTICE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.md'].every(file => manifest.files.includes(file)), 'files must include NOTICE, THIRD_PARTY_NOTICES.md and THIRD_PARTY_LICENSES.md (npm only adds LICENSE automatically)');
  await read('packages/wasm/THIRD_PARTY_NOTICES.md');
});

test('THIRD_PARTY_LICENSES.md matches the shipped Cargo.lock and covers every crate in THIRD_PARTY_NOTICES.md', async () => {
  const provenance = JSON.parse(await read('packages/wasm/generated/provenance.json'));
  const notices = (await read('packages/wasm/THIRD_PARTY_NOTICES.md')).toString('utf8');
  const licenses = (await read('packages/wasm/THIRD_PARTY_LICENSES.md')).toString('utf8');
  assert.ok(licenses.includes(`Cargo.lock SHA-256: \`${provenance.cargoLockSha256}\``), 'the licence bundle must be generated from the Cargo.lock recorded in provenance.json');
  assert.ok(notices.includes(`Cargo.lock SHA-256: \`${provenance.cargoLockSha256}\``), 'the notices must be generated from the Cargo.lock recorded in provenance.json');

  const crates = [...notices.matchAll(/^\| (?!Crate \||--- \|)([^|]+) \| ([^|]+) \|/gm)].map(m => `${m[1]} ${m[2]}`);
  assert.ok(crates.length > 300, `expected the notices table to list the crates of the dependency graph, found ${crates.length}`);
  assert.equal(new Set(crates).size, crates.length, 'the notices table must not repeat a crate');
  assert.equal(notices.match(/^- (\d+) crates\.$/m)?.[1], String(crates.length), 'the notices crate count must match its table');

  // cargo-about supplies the standard SPDX text for a crate that ships none, so every crate has a text and the old
  // "Crates without a bundled licence file" section no longer exists.
  assert.ok(!licenses.includes('Crates without a bundled licence file'), 'cargo-about covers every crate; no "without a licence file" section is expected');
  const noticeStart = licenses.indexOf('## NOTICE files');
  assert.ok(noticeStart > 0, 'missing the "NOTICE files" section');
  const texts = licenses.slice(0, noticeStart);
  const withText = new Set([...texts.matchAll(/^- (\S+ \S+) \(/gm)].map(m => m[1]));
  assert.deepEqual(crates.filter(id => !withText.has(id)), [], 'crates in THIRD_PARTY_NOTICES.md that THIRD_PARTY_LICENSES.md has no licence text for');
  assert.deepEqual([...withText].filter(id => !crates.includes(id)), [], 'crates with a licence text that THIRD_PARTY_NOTICES.md does not list');
  assert.equal(licenses.match(/(\d+) distinct licence texts cover all (\d+) crates/)?.[2], String(crates.length), 'the stated crate count of the licence bundle must match the notices table');
  assert.equal(licenses.match(/(\d+) distinct licence texts/)?.[1], String(texts.match(/^### Text \d+ of \d+$/gm).length), 'the stated number of licence texts must match the sections');
  assert.ok(/Copyright \(c\)/i.test(texts), 'the bundle must contain copyright lines');
  assert.ok(/^- typst 0\.\d+\.\d+ \(/m.test(licenses.slice(noticeStart)), 'the NOTICE of the typst crates must be reproduced');

  // cargo-about enforces the `accepted` list of tools/about.toml when it generates; here the pin and target are checked.
  const config = (await read('tools/about.toml')).toString('utf8');
  const pin = JSON.parse(await read('compiler-source.json'));
  assert.match(pin.cargoAbout, /^\d+\.\d+\.\d+$/, 'compiler-source.json must pin cargoAbout');
  assert.ok(notices.includes(`cargo-about ${pin.cargoAbout}`), 'the notices must be generated by the pinned cargo-about');
  assert.match(config, /^targets = \["wasm32-unknown-unknown"\]$/m);
});
