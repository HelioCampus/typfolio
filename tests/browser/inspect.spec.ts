import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

// The demo site's /inspect page: a report compiled in the page, shown in the tags panel of @typfolio/dev-tools, with
// veraPDF's verdict when the site was built with the validator. Each switch takes structure away, and the page says
// who notices; this checks that what it says is what happens.
const demo = 'http://127.0.0.1:4293';
const root = new URL('../../', import.meta.url);
const included = existsSync(fileURLToPath(new URL('.build/site/client/verapdf/manifest.json', root)));

test('the inspect page shows who notices missing structure: the compiler, the warnings, veraPDF, or nobody', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

  await page.goto(`${demo}/inspect`);
  const panel = page.getByLabel("The document's tags, page and validation");
  const status = page.getByRole('status').filter({ hasText: 'in this page' });
  await expect(status).toContainText(/Compiled in \d+ ms/);
  await expect(panel.getByText('1 page · 3 headings · 1 table · 1 figure')).toBeVisible();
  await expect(panel.getByText('No problems found')).toBeVisible();
  if (included) await expect(panel.getByText(/Passes veraPDF.s PDF\/UA-1 rules \(\d+ checks\)/)).toBeVisible({ timeout: 120_000 });

  // Headings that are only bold text: nothing flags it on a one-page document. Only the tags show it.
  const headings = page.getByRole('checkbox', { name: /Headings are marked up as headings/ });
  await headings.uncheck();
  await expect(panel.getByText('1 page · 0 headings · 1 table · 1 figure')).toBeVisible();
  await expect(panel.getByText('No problems found')).toBeVisible();
  if (included) await expect(panel.getByText(/Passes veraPDF.s PDF\/UA-1 rules \(\d+ checks\)/)).toBeVisible({ timeout: 120_000 });
  await headings.check();
  await expect(panel.getByText('1 page · 3 headings · 1 table · 1 figure')).toBeVisible();

  // A table without header cells: the standard accepts it, the warnings notice.
  const header = page.getByRole('checkbox', { name: /The table has a header row/ });
  await header.uncheck();
  await expect(panel.getByText(/^1 problem/)).toBeVisible();
  if (included) await expect(panel.getByText(/Passes veraPDF.s PDF\/UA-1 rules \(\d+ checks\)/)).toBeVisible({ timeout: 120_000 });
  await header.check();
  await expect(panel.getByText('No problems found')).toBeVisible();

  // A figure without alt text: a PDF/UA-1 compile is refused, and the last PDF stays on show.
  const alt = page.getByRole('checkbox', { name: /The chart has alternative text/ });
  await alt.uncheck();
  await expect(page.getByRole('alert')).toContainText('The compiler refused this document.');
  await expect(page.getByRole('alert')).toContainText(/alt text/);
  // As a tagged PDF it compiles, and the warnings notice.
  await page.getByRole('button', { name: 'Tagged PDF' }).click();
  await expect(status).toContainText(/Compiled in \d+ ms/);
  await expect(panel.getByText(/^1 problem/)).toBeVisible();

  expect(errors).toEqual([]);
});
