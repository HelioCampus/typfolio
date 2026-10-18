// Opens one benchmark page and prints its console errors and result: node debug.ts "<query>"
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const server = await createServer({
  configFile: new URL('./vite.config.ts', import.meta.url).pathname,
  server: { port: 0, strictPort: false },
});
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') console.log(message.type(), message.text().slice(0, 800));
  });
  page.on('pageerror', error => console.log('pageerror', error.message.slice(0, 800)));
  await page.goto(server.resolvedUrls!.local[0] + (process.argv[2] ?? '?mode=iframe&runs=1&outcomes=5'));
  await page.waitForTimeout(Number(process.argv[3] ?? 15000));
  console.log(JSON.stringify(await page.evaluate(() => window.__bench)));
} finally {
  await browser.close();
  await server.close();
}
