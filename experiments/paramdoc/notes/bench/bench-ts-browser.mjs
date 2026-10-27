import { chromium } from 'playwright';
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();
await page.goto(process.argv[2], { waitUntil: 'load', timeout: 120_000 });
await page.waitForFunction(() => !document.getElementById('result').textContent.startsWith('running'), null, { timeout: 1_800_000 });
console.log('TypeScript runtime in Chromium (main thread):', await page.textContent('#result'));
await browser.close();
