// The licence texts and the third-party list that travel with the veraPDF WebAssembly binary, written by
// tools/build-verapdf.ts into packages/verapdf-wasm/generated/: `licenses/` and `THIRD_PARTY_NOTICES.md`.
//
// Everything comes from what the binary was built from, so it cannot drift from it: the licence and notice files
// inside each pinned jar, the notices carried by the font data in veraPDF's parser jar, the licence files of the
// pinned GraalVM, and two texts that no jar contains, kept in tools/notices/verapdf. Each jar's licence is the one
// recorded for it in verapdf-source.json; a licence this file has no text for stops the build, so a new dependency
// is not shipped without someone looking at its terms.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { capture, jarName, pin, root, run, sha256, work } from './verapdf-source.ts';

/** Where the text of each licence a jar may be under is found in generated/licenses. */
const licenceTexts: Record<string, string> = {
  'MPL-2.0': 'verapdf/LICENSE.MPL',
  'CDDL-1.1': 'jaxb-api/LICENSE.txt',
  'BSD-3-Clause': 'the component\'s own folder',
};
const sources: Record<string, string> = {
  'org.verapdf': 'https://github.com/veraPDF (veraPDF-library, veraPDF-parser, veraPDF-validation, veraPDF-model at the version\'s tag)',
  'org.mozilla': 'https://github.com/mozilla/rhino',
  'javax.xml.bind': 'https://github.com/javaee/jaxb-spec',
  'com.sun.xml.bind': 'https://github.com/eclipse-ee4j/jaxb-ri',
  'javax.activation': 'https://github.com/javaee/activation',
};

function filesUnder(directory: string, base = directory): string[] {
  return readdirSync(directory).sort().flatMap(entry => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path, base) : [relative(base, path).split(sep).join('/')];
  });
}

/** Writes generated/licenses and generated/THIRD_PARTY_NOTICES.md; returns each written file with its SHA-256. */
export function writeNotices(graalvm: string, jars: string[], output: string): Record<string, string> {
  const licenses = join(output, 'licenses');
  const scratch = join(work, 'notices');
  for (const directory of [licenses, scratch]) {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
  }
  const jar = join(graalvm, 'bin/jar');
  const extract = (archive: string, name: string) => {
    const target = join(scratch, name);
    mkdirSync(target, { recursive: true });
    run(jar, ['xf', archive], { cwd: target });
    return target;
  };

  // Each jar's own licence and notice files.
  const rows: string[] = [];
  for (const [index, artifact] of pin.artifacts.entries()) {
    for (const part of artifact.license.split(' AND ')) {
      if (!(part in licenceTexts)) throw new Error(`${jarName(artifact)} is pinned under ${artifact.license}; tools/verapdf-notices.ts has no licence text for ${part}`);
    }
    const unpacked = extract(jars[index]!, artifact.artifact);
    const meta = join(unpacked, 'META-INF');
    const own = existsSync(meta) ? readdirSync(meta).filter(name => /^(LICEN[SC]E|NOTICE|COPYING)[^/]*$/i.test(name)).sort() : [];
    for (const name of own) {
      mkdirSync(join(licenses, artifact.artifact), { recursive: true });
      copyFileSync(join(meta, name), join(licenses, artifact.artifact, name));
    }
    const where = own.length > 0 ? `\`licenses/${artifact.artifact}/\`` : artifact.group === 'org.verapdf' ? '`licenses/verapdf/`' : `none in the jar; ${artifact.license} is in \`licenses/${licenceTexts[artifact.license]}\``;
    rows.push(`| ${artifact.group}:${artifact.artifact} | ${artifact.version} | ${artifact.license} | ${where} | ${sources[artifact.group] ?? ''} |`);
  }
  for (const text of Object.values(licenceTexts)) {
    if (text.includes('/') && !existsSync(join(licenses, text)) && !text.startsWith('verapdf/')) throw new Error(`No jar provided licenses/${text}; review tools/verapdf-notices.ts`);
  }

  // veraPDF's own texts, which its jars do not contain.
  mkdirSync(join(licenses, 'verapdf'), { recursive: true });
  copyFileSync(join(root, 'tools/notices/verapdf/LICENSE.MPL'), join(licenses, 'verapdf/LICENSE.MPL'));
  copyFileSync(join(root, 'tools/notices/verapdf/xmp-core-LICENSE.txt'), join(licenses, 'verapdf/xmp-core-LICENSE.txt'));

  // The font data in veraPDF's parser jar, which is in the binary whole: Adobe's CMap resources each carry their
  // licence in their header, and the Core 14 font metrics may not be distributed without their ReadMe.
  const parser = join(scratch, 'parser/font');
  const fontData = join(licenses, 'adobe-font-data');
  mkdirSync(fontData, { recursive: true });
  const cmaps = readdirSync(join(parser, 'cmap')).sort();
  const blocks = new Map<string, string[]>();
  for (const name of cmaps) {
    const block = readFileSync(join(parser, 'cmap', name), 'latin1').split(/\r?\n/).filter(line => line.startsWith('%%Copyright:'))
      .map(line => line.slice('%%Copyright:'.length).replace(/^ /, '').trimEnd()).join('\n').replace(/^-+\n|\n-+$/g, '');
    if (!block.includes('Redistribution and use in source and binary forms')) throw new Error(`font/cmap/${name} in the parser jar carries no licence header; review tools/verapdf-notices.ts`);
    blocks.set(block, [...blocks.get(block) ?? [], name]);
  }
  writeFileSync(join(fontData, 'CMap-resources.txt'), 'Adobe CMap resources (font/cmap in veraPDF\'s parser jar). Each file carries one of these notices in its header.\n\n' +
    [...blocks].map(([block, names]) => `${'='.repeat(78)}\n${names.join(', ')}\n${'='.repeat(78)}\n\n${block}\n`).join('\n'));
  copyFileSync(join(parser, 'stdmetrics/MustRead.html'), join(fontData, 'Core14-AFM-MustRead.html'));
  const afm = new Set<string>();
  for (const name of readdirSync(join(parser, 'stdmetrics')).filter(file => file.endsWith('.afm')).sort()) {
    for (const line of readFileSync(join(parser, 'stdmetrics', name), 'latin1').split(/\r?\n/)) {
      if (/^Comment Copyright|^Notice /.test(line)) afm.add(line.replace(/^(Comment|Notice) /, '').trim());
    }
  }
  writeFileSync(join(fontData, 'Core14-AFM-copyright.txt'), 'Copyright and trademark notices of the Core 14 AFM files (font/stdmetrics in veraPDF\'s parser jar), which are in the\nbinary unmodified. See Core14-AFM-MustRead.html for the terms.\n\n' + [...afm].join('\n') + '\n');

  // GraalVM's own licence, notice and licence information manual, for the runtime it compiles into the binary.
  const oracle = join(licenses, 'oracle-graalvm');
  mkdirSync(oracle, { recursive: true });
  for (const name of ['LICENSE.txt', 'NOTICE.txt', 'license-information-user-manual.zip']) {
    if (!existsSync(join(graalvm, name))) throw new Error(`${pin.graalvm.distribution} ${pin.graalvm.version} has no ${name}; review tools/verapdf-notices.ts`);
    cpSync(join(graalvm, name), join(oracle, name));
  }
  if (!readFileSync(join(oracle, 'LICENSE.txt'), 'utf8').includes('GraalVM Free Terms and Conditions')) throw new Error('The GraalVM licence is not the GraalVM Free Terms and Conditions; the package\'s LICENSE describes those');

  const javaVersion = capture(join(graalvm, 'bin/java'), ['--version']).split('\n')[0];
  writeFileSync(join(output, 'THIRD_PARTY_NOTICES.md'), `# Third-party notices

Generated by \`tools/build-verapdf.ts\` from the inputs of this build of \`verapdf.wasm\`. See the package's \`LICENSE\`
for what the binary as a whole may be used for.

## Libraries compiled into the binary

| Component | Version | Used under | Licence and notice files | Source |
|---|---|---|---|---|
${rows.join('\n')}

veraPDF is dual-licensed GPLv3+ / MPLv2+ and is used here under the Mozilla Public License 2.0. One of its files is
replaced: \`org/verapdf/cos/filters/COSFilterFlateDecode.java\`, whose modified source is in this package under
\`java/\` and stays under the MPL 2.0. The source of the other files is in the \`-sources.jar\` of each artifact at
${pin.mavenRepository}/org/verapdf/ and in the repositories named above, at the tag of version ${pin.verapdf}.
veraPDF's \`xmp-core\` module is derived from Adobe's XMP Toolkit; its licence file is
\`licenses/verapdf/xmp-core-LICENSE.txt\`, and its source files carry an Adobe Systems copyright header.

The JAXB API, \`jaxb-core\` and the JavaBeans Activation Framework API are offered under CDDL 1.1 or GPLv2 with the
Classpath exception and are used under CDDL 1.1. Rhino's notice file lists the code it contains from other
projects.

## Font data

veraPDF's parser jar contains font data that is in the binary whole (\`licenses/adobe-font-data/\`):

- ${cmaps.length} Adobe CMap resources, under the BSD-style licence in each file's header (\`CMap-resources.txt\`).
- The 14 Core font metric (AFM) files, under the terms of \`Core14-AFM-MustRead.html\`, which may not be
  distributed without that file; their copyright notices are in \`Core14-AFM-copyright.txt\`.
- The Adobe Glyph List, which carries no notice in the jar.

## The runtime

The binary is produced by ${pin.graalvm.distribution} ${pin.graalvm.version} (${javaVersion}) Native Image, which
compiles its runtime and the parts of the Java class library that veraPDF uses into the binary. Those parts stay
under the GraalVM Free Terms and Conditions, \`licenses/oracle-graalvm/LICENSE.txt\`. Oracle's notices for the
third-party code in GraalVM are in \`licenses/oracle-graalvm/NOTICE.txt\` and
\`licenses/oracle-graalvm/license-information-user-manual.zip\`, both copied unchanged from that distribution.
`);
  return Object.fromEntries(['THIRD_PARTY_NOTICES.md', ...filesUnder(licenses).map(file => `licenses/${file}`)].map(file => [file, sha256(readFileSync(join(output, file)))]));
}

/** For tools/check-verapdf-package.ts: the notice files recorded in the provenance are there and unchanged. */
export function verifyNotices(output: string, recorded: Record<string, string> | undefined): void {
  if (!recorded || !('THIRD_PARTY_NOTICES.md' in recorded) || !('licenses/oracle-graalvm/LICENSE.txt' in recorded) || !('licenses/verapdf/LICENSE.MPL' in recorded)) {
    throw new Error('veraPDF provenance does not record the licence and notice files. Run npm run build:verapdf -- --force.');
  }
  for (const [file, expected] of Object.entries(recorded)) {
    if (!existsSync(join(output, file)) || sha256(readFileSync(join(output, file))) !== expected) throw new Error(`${file} does not match build provenance`);
  }
  const present = filesUnder(join(output, 'licenses')).map(file => `licenses/${file}`);
  const extra = present.filter(file => !(file in recorded));
  if (extra.length > 0) throw new Error(`generated/licenses has files the build did not write: ${extra.join(', ')}`);
}
