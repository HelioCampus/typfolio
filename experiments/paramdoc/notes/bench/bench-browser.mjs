// Drives the repo's worker-batch benchmark page headlessly and prints its final status line.
import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 200)); });
page.on('pageerror', e => console.log('page error:', String(e).slice(0, 200)));
const started = Date.now();
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForSelector('#status[data-status="running"], #status[data-status="passed"], #status[data-status="failed"]', { timeout: 600_000 });
console.log('started after', ((Date.now() - started) / 1000).toFixed(1), 's; status:', await page.textContent('#status'));
await page.waitForSelector('#status[data-status="passed"], #status[data-status="failed"], #status[data-status="cancelled"]', { timeout: 3_600_000 });
console.log(await page.textContent('#status'));
console.log('hidden:', await page.evaluate(() => document.hidden), 'cores:', await page.evaluate(() => navigator.hardwareConcurrency));
await browser.close();
