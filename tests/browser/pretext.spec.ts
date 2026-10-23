import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const demo = 'http://127.0.0.1:4293';

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.context().on('request', request => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (request.method() !== 'GET' || url.origin !== demo || (!request.isNavigationRequest() && !url.pathname.startsWith('/assets/'))) {
      errors.push(`Unexpected non-static request: ${request.method()} ${url.href}`);
    }
  });
  return errors;
}

async function expectLivePdf(page: Page, zoom: string) {
  await expect(page.getByRole('switch', { name: 'Live PDF mode' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Viewer', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status', { name: 'Zoom level' })).toHaveText(zoom);
  await expect(page.getByRole('button', { name: 'Download frame' })).toBeEnabled();
  await expect(page.getByLabel('Live PDF preview')).toBeVisible();
}

test('Start demo: static overview, demo links and compiler loaded on demand', async ({ page }) => {
  const errors = watchErrors(page);
  const wasmRequests: string[] = [];
  page.context().on('request', request => { if (new URL(request.url()).pathname.endsWith('.wasm')) wasmRequests.push(request.url()); });
  const response = await page.goto(demo);
  expect(await response!.text()).toContain('Meaning belongs');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Compile PDFs in your browser.Accessible, typed and fast.');
  await expect(page.getByRole('link', { name: '1000 PDFs, one browser.' })).toHaveAttribute('href', '/performance');
  await expect(page.getByRole('link', { name: 'A page that flows.' })).toHaveAttribute('href', '/editorial');
  expect(wasmRequests).toEqual([]);
  expect(page.workers()).toHaveLength(0);
  await page.getByRole('link', { name: 'Type in motion.' }).click();
  await expect(page).toHaveURL(`${demo}/ascii`);
  await expectLivePdf(page, '100%');
  expect(wasmRequests).toHaveLength(1);
  await page.reload();
  await expectLivePdf(page, '100%');
  expect(wasmRequests).toHaveLength(2);
  await page.getByRole('link', { name: 'Typfolio home' }).click();
  await expect(page).toHaveURL(`${demo}/`);
  await expect(page.getByRole('heading', { name: 'Three demos. Compiled here.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Start demo: direct routes, live PDFs, refresh and browser history', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(`${demo}/editorial`);
  await expectLivePdf(page, '50%');
  await page.reload();
  await expectLivePdf(page, '50%');
  await page.getByRole('link', { name: 'Variable ASCII', exact: true }).click();
  await expect(page).toHaveURL(`${demo}/ascii`);
  await expectLivePdf(page, '100%');
  await page.goBack();
  await expect(page).toHaveURL(`${demo}/editorial`);
  await expectLivePdf(page, '50%');
  await page.goForward();
  await expectLivePdf(page, '100%');
  expect(errors).toEqual([]);
});

test('Start demo: 1000 worker PDFs, preview and persistent run history', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(`${demo}/performance?workers=2&count=1000&autostart`);
  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-status', 'passed');
  await expect(status).toContainText('1000 PDFs');
  await page.getByRole('button', { name: 'Open report-0001.pdf', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'report-0001.pdf', exact: true });
  await expect(preview.getByLabel('PDF page 1')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Runs', exact: true }).getByRole('row')).toHaveCount(2);
  await page.getByRole('link', { name: 'Pretext', exact: true }).click();
  await expect(page).toHaveURL(`${demo}/ascii`);
  await page.getByRole('link', { name: 'Worker batch', exact: true }).click();
  await expect(page).toHaveURL(`${demo}/performance`);
  await expect(status).toHaveText('Ready.');
  await expect(page.getByRole('region', { name: 'Runs', exact: true }).getByRole('row')).toHaveCount(2);
  await page.reload();
  await expect(status).toHaveText('Ready.');
  await expect(page.getByRole('region', { name: 'Runs', exact: true }).getByRole('row')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('Start demo: cancel during compiler download and reuse the module on the next run', async ({ page }) => {
  const errors = watchErrors(page);
  let releaseDownload!: () => void;
  const heldDownload = new Promise<void>(resolve => { releaseDownload = resolve; });
  let downloads = 0;
  await page.route('**/*.wasm', async route => {
    downloads++;
    await heldDownload;
    await route.continue();
  });
  const downloadStarted = page.waitForRequest('**/*.wasm');
  try {
    await page.goto(`${demo}/performance?workers=2&count=20&autostart`);
    await downloadStarted;
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#status')).toHaveAttribute('data-status', 'cancelled');
    expect(page.workers()).toHaveLength(0);
  } finally {
    releaseDownload();
  }
  await page.getByRole('button', { name: 'Render', exact: true }).click();
  await expect(page.locator('#status')).toHaveAttribute('data-status', 'passed');
  await expect(page.locator('#status')).toContainText('20 PDFs');
  expect(downloads).toBe(1);
  expect(errors).toEqual([]);
});

test('Static hosting: route entry pages, real asset responses and missing-file status', async ({ request }) => {
  for (const route of ['/ascii', '/ascii/', '/editorial', '/editorial/', '/performance?workers=2&count=1000', '/performance/']) {
    const response = await request.get(demo + route);
    expect(response.status(), route).toBe(200);
    expect(response.url(), route).toBe(demo + route.replace(/\/$/, ''));
    const html = await response.text();
    expect(html, route).toContain('Loading the demo');
    expect(html, route).not.toContain('id="home-title"');
  }
  const index = await request.get(demo);
  const html = await index.text();
  expect(html).toContain('id="home-title"');
  const entryUrl = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  expect(entryUrl).toBeDefined();
  const entry = await request.get(demo + entryUrl);
  expect(entry.status()).toBe(200);
  expect(entry.headers()['content-type']).toContain('javascript');
  expect(entry.headers()['cache-control']).toContain('immutable');
  for (const path of ['/assets/missing.js', '/assets/missing.wasm', '/missing-page', '/api/test', '/_serverFn/test']) {
    const response = await request.get(demo + path);
    expect(response.status(), path).toBe(404);
    expect(await response.text(), path).not.toContain('id="home-title"');
  }
});
