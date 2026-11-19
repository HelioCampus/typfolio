import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { samplePdfs } from './sample-pdfs.ts';

// The demo site's /validate page, as Cloudflare would serve it (Wrangler's static assets over .build/pretext-hybrid):
// veraPDF in a module worker, from a gzipped binary that the page unpacks itself. Files are validated in the page.
const demo = 'http://127.0.0.1:4293';
const root = new URL('../../', import.meta.url);
// The site is built with the validator when it has been built here (npm run build:verapdf), and without it otherwise.
const included = existsSync(fileURLToPath(new URL('.build/pretext-hybrid/client/verapdf/manifest.json', root)));

test('the validate page says so when the site was built without the validator', async ({ page }) => {
  test.skip(included, 'this build of the site includes the validator');
  await page.goto(`${demo}/validate`);
  await expect(page.getByRole('status')).toContainText('This build of the site does not include the validator');
  expect(page.workers()).toHaveLength(0);
});

test('the validate page validates dropped PDFs in the page: what they declare, or a chosen standard', async ({ page }) => {
  test.skip(!included, 'the site was built without the validator (npm run build:verapdf)');
  const { ua1, plain } = await samplePdfs();

  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.context().on('request', request => {
    const url = new URL(request.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') requests.push(`${request.method()} ${url.origin}${url.pathname}`);
  });

  await page.goto(`${demo}/validate`);
  await expect(page.getByRole('status')).toContainText('Validator ready', { timeout: 120_000 });
  await expect(page.getByRole('combobox', { name: 'What to validate against' })).toHaveValue('declared');
  // The binary came gzipped, under Cloudflare's 25 MiB limit for one file.
  expect(requests).toContain(`GET ${demo}/verapdf/verapdf.wasm.gz`);

  await page.locator('input[type=file]').setInputFiles([
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from(ua1) },
    { name: 'plain.pdf', mimeType: 'application/pdf', buffer: Buffer.from(plain) },
  ]);
  const report = page.getByRole('article').filter({ hasText: 'report.pdf' });
  await expect(report.getByText('PASS PDF/UA-1', { exact: true })).toBeVisible();
  await expect(report.getByText(/^PDF\/UA-1: passes all \d+ checks\.$/)).toBeVisible();
  await expect(report.getByText(/^SHA-256 [0-9a-f]{64}$/)).toBeVisible();
  // A file that declares no standard is not validated, which is not a pass.
  const undeclared = page.getByRole('article').filter({ hasText: 'plain.pdf' });
  await expect(undeclared.getByText('NOT VALIDATED', { exact: true })).toBeVisible();
  await expect(undeclared.getByText(/declares no standard in its metadata/)).toBeVisible();

  // A chosen standard validates both again; a failed rule opens to what was wrong and where.
  await page.getByRole('combobox', { name: 'What to validate against' }).selectOption('ua2');
  await expect(report.getByText('FAIL PDF/UA-2', { exact: true })).toBeVisible();
  await expect(undeclared.getByText('FAIL PDF/UA-2', { exact: true })).toBeVisible();
  const rule = report.locator('details').filter({ hasText: 'ISO 14289-2:2024, 5, test 2' });
  await rule.locator('summary').click();
  await expect(rule.getByText('The "part" property of the PDF/UA Identification Schema is 1 instead of 2 for PDF/UA-2 conforming file')).toBeVisible();

  // The report can be saved, and the licence that has to travel with the binary is served beside it.
  const [download] = await Promise.all([page.waitForEvent('download'), report.getByRole('button', { name: 'Download JSON' }).click()]);
  expect(download.suggestedFilename()).toBe('report.verapdf.json');
  const licence = await page.request.get(`${demo}/verapdf/LICENSE.txt`);
  expect(licence.ok()).toBe(true);
  expect(await licence.text()).toMatch(/GraalVM Free Terms and\s+Conditions/);

  // Nothing was uploaded: every request the page made was a GET to the site itself.
  expect(requests.filter(entry => !entry.startsWith(`GET ${demo}/`))).toEqual([]);
  expect(errors).toEqual([]);
});
