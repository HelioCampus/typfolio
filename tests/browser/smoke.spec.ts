import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

const smoke = 'http://127.0.0.1:4278';
const capture = 'http://127.0.0.1:4291';
const react = 'http://127.0.0.1:4279';

/** What the core smoke page puts in #result: one run on the page and one in a module worker. */
interface CoreSmokeReport {
  direct: { initializeMs: number; compileMs: number; bytes: number };
  worker: { initializeMs: number; compileMs: number; bytes: number; hasDocument: boolean };
}

/** What the capture smoke page puts in #result. */
interface CaptureSmokeReport {
  png: unknown;
  pdf: { bytes: number; diagnostics: unknown[] };
  checks: Record<string, boolean>;
}

// Collects page errors and console output so a failure carries the browser's own message,
// and prints the numbers the pages report so per-browser timings are visible in the run log.
function watch(page: Page) {
  const messages: string[] = [];
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) messages.push(`console.${message.type()}: ${message.text()}`); });
  page.on('pageerror', error => messages.push(`pageerror: ${error.stack ?? error}`));
  page.on('requestfailed', request => messages.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
  page.on('worker', worker => messages.push(`worker started: ${worker.url()}`));
  return messages;
}

async function settle(page: Page, testInfo: TestInfo, messages: string[], selector: string, attribute = 'data-status') {
  const target = page.locator(selector);
  try {
    await expect(target).not.toHaveAttribute(attribute, 'running');
  } finally {
    const text = await target.textContent().catch(() => '(page text unavailable)');
    const log = messages.filter(line => !line.startsWith('worker started')).join('\n');
    await testInfo.attach('page-result', { body: `${text}\n\n--- browser messages ---\n${log}`, contentType: 'text/plain' });
  }
  const status = await target.getAttribute(attribute);
  const text = await target.textContent();
  expect(status, `${text}\n--- browser messages ---\n${messages.join('\n')}`).toBe('passed');
  return text!;
}

test('core smoke: compile on the page and in a module worker', async ({ page, browser, browserName }, testInfo) => {
  const messages = watch(page);
  console.log(`[${browserName}] engine ${browser.version()}`);
  await page.goto(`${smoke}/fixtures/browser/index.html`);
  const report: CoreSmokeReport = JSON.parse(await settle(page, testInfo, messages, '#result'));
  console.log(`[${browserName}] core smoke`, JSON.stringify({
    directInitMs: Math.round(report.direct.initializeMs), directCompileMs: Math.round(report.direct.compileMs),
    workerInitMs: Math.round(report.worker.initializeMs), workerCompileMs: Math.round(report.worker.compileMs),
  }));
  expect(report.direct.bytes).toBeGreaterThan(0);
  expect(report.worker.bytes).toBeGreaterThan(0);
  expect(report.worker.hasDocument).toBe(false);
});

test('workers production app: compile, hard cancel, recover', async ({ page, browserName }, testInfo) => {
  const messages = watch(page);
  await page.goto(`${smoke}/`);
  const text = await settle(page, testInfo, messages, '#status');
  console.log(`[${browserName}] workers app`, text);
  expect(text).toContain('Compiled');
  // fixtures/basic/chart.svg is 150 bytes; the status echoes the length of the asset the page passed to compile().
  expect(text).toContain('with a 150-byte asset');
  expect(text).toContain('hard-cancelled');
  expect(text).toContain('recovered');
});

test('capture smoke: SVG capture, html2canvas, PDF/UA compile', async ({ page, browserName }, testInfo) => {
  const messages = watch(page);
  await page.goto(`${capture}/`);
  const report: CaptureSmokeReport = JSON.parse(await settle(page, testInfo, messages, '#result'));
  console.log(`[${browserName}] capture smoke`, JSON.stringify({ png: report.png, pdf: report.pdf.bytes }));
  expect(Object.keys(report.checks).length).toBeGreaterThan(0);
  for (const [name, value] of Object.entries(report.checks)) expect(value, `check ${name}`).toBe(true);
  expect(report.pdf.diagnostics).toEqual([]);
});

for (const [name, path] of [['direct', '/'], ['workers', '/workers']]) {
  test(`React example (${name} route): Generate PDF`, async ({ page, browserName }, testInfo) => {
    const messages = watch(page);
    await page.goto(`${react}${path}`);
    await page.getByRole('button', { name: 'Generate PDF' }).click();
    const output = page.locator('section.output-panel');
    try {
      await expect(output.locator('.status')).toContainText(/complete/i);
      const diagnostics = output.locator('.result-summary > div', { hasText: 'Diagnostics' });
      await expect(diagnostics.locator('strong')).toHaveText('0');
      await expect(output.locator('iframe.pdf-preview')).toBeVisible();
      console.log(`[${browserName}] react ${name}`, (await output.locator('.result-summary').innerText()).replace(/\s+/g, ' '));
    } catch (error) {
      const text = await output.innerText().catch(() => '(output panel unavailable)');
      throw new Error(`${(error as Error).message}\n--- output panel ---\n${text}\n--- browser messages ---\n${messages.join('\n')}`);
    }
  });
}

test('React example (charts route): usePdf draws charts into a PDF/UA compile', async ({ page, browserName }) => {
  const messages = watch(page);
  await page.goto(`${react}/charts`);
  await page.getByRole('button', { name: 'Generate PDF' }).click();
  const output = page.locator('section.output-panel');
  try {
    await expect(output.locator('.status')).toContainText(/complete/i);
    const summary = output.locator('.result-summary');
    await expect(summary.locator('div', { hasText: 'Charts' }).locator('strong')).toHaveText('6');
    await expect(summary.locator('div', { hasText: 'Diagnostics' }).locator('strong')).toHaveText('0');
    // The hidden renderer element is removed once the charts are drawn.
    await expect(page.locator('[data-typfolio-asset-renderer]')).toHaveCount(0);
    console.log(`[${browserName}] react charts`, (await summary.innerText()).replace(/\s+/g, ' '));
  } catch (error) {
    const text = await output.innerText().catch(() => '(output panel unavailable)');
    throw new Error(`${(error as Error).message}\n--- output panel ---\n${text}\n--- browser messages ---\n${messages.join('\n')}`);
  }
});
