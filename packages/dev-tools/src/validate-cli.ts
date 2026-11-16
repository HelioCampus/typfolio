#!/usr/bin/env node
// typfolio-validate: validates PDF files with veraPDF (`@typfolio/dev-tools/validate`), for a script or CI.
// Exit status: 0 when every file passes, 1 when one fails, 2 for wrong usage or a file that could not be validated.
import { readFile } from 'node:fs/promises';
import { createPdfValidator, formatValidationReport, pdfValidationFlavourIds, pdfValidationFlavours, type PdfValidationFlavour, type PdfValidationReport } from './validate.js';

const usage = `Usage: typfolio-validate [options] <file.pdf>...

Validates each file with veraPDF and prints a report. A pass is a machine check of
one flavour's rules; it does not establish that a document is accessible.

Options:
  -f, --flavour <id>   What to validate against (default: ua1):
${pdfValidationFlavourIds.map(id => `                         ${id.padEnd(6)}${pdfValidationFlavours[id]}`).join('\n')}
      --format <kind>  text (default) or json
      --max-checks <n> How many failed checks of one rule to list (default: 3 as text, 20 as json)
      --wasm <file>    The validator's binary, when not the installed @typfolio/verapdf-wasm
  -h, --help           Show this text

Exit status: 0 all files pass, 1 a file fails, 2 wrong usage or a file could not be validated.`;

function fail(message: string): never {
  process.stderr.write(`typfolio-validate: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let flavour = 'ua1';
let format = 'text';
let wasmPath: string | undefined;
let maxChecks: string | undefined;
const files: string[] = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;
  const value = (name: string) => args[++index] ?? fail(`${name} needs a value`);
  if (arg === '-h' || arg === '--help') {
    process.stdout.write(usage + '\n');
    process.exit(0);
  } else if (arg === '-f' || arg === '--flavour' || arg === '--flavor') flavour = value(arg);
  else if (arg.startsWith('--flavour=') || arg.startsWith('--flavor=')) flavour = arg.slice(arg.indexOf('=') + 1);
  else if (arg === '--format') format = value(arg);
  else if (arg.startsWith('--format=')) format = arg.slice('--format='.length);
  else if (arg === '--max-checks') maxChecks = value(arg);
  else if (arg.startsWith('--max-checks=')) maxChecks = arg.slice('--max-checks='.length);
  else if (arg === '--wasm') wasmPath = value(arg);
  else if (arg.startsWith('--wasm=')) wasmPath = arg.slice('--wasm='.length);
  else if (arg === '--') { files.push(...args.slice(index + 1)); break; }
  else if (arg.startsWith('-') && arg !== '-') fail(`unknown option ${arg}\n\n${usage}`);
  else files.push(arg);
}
if (!(flavour in pdfValidationFlavours)) fail(`unknown flavour ${JSON.stringify(flavour)}; the flavours are ${pdfValidationFlavourIds.join(', ')}`);
if (format !== 'text' && format !== 'json') fail(`unknown format ${JSON.stringify(format)}; it is text or json`);
const maxChecksPerRule = maxChecks === undefined ? (format === 'json' ? 20 : 3) : Number(maxChecks);
if (!Number.isInteger(maxChecksPerRule) || maxChecksPerRule < 1 || maxChecksPerRule > 10000) fail(`--max-checks must be a whole number from 1 to 10000, not ${JSON.stringify(maxChecks)}`);
if (files.length === 0) fail(`no file given\n\n${usage}`);

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
let validator;
try {
  validator = await createPdfValidator({ wasm: wasmPath === undefined ? undefined : await readFile(wasmPath) });
} catch (error) {
  fail(message(error));
}

type Result = { file: string } & (PdfValidationReport | { error: string });
const results: Result[] = [];
for (const file of files) {
  try {
    results.push({ file, ...validator.validate(await readFile(file), { flavour: flavour as PdfValidationFlavour, maxChecksPerRule }) });
  } catch (error) {
    results.push({ file, error: message(error) });
  }
}
if (format === 'json') process.stdout.write(JSON.stringify(results, null, 2) + '\n');
else {
  for (const result of results) {
    if ('error' in result) process.stdout.write(`${result.file}: ERROR ${result.error}\n`);
    else process.stdout.write(formatValidationReport(result, result.file) + '\n');
  }
}
process.exitCode = results.some(result => 'error' in result) ? 2 : results.some(result => !('error' in result) && !result.compliant) ? 1 : 0;
