// Runs the benchmark in Chromium, Firefox and WebKit and prints the median timings.
//   node run.ts [--runs 5] [--outcomes 75] [--browsers chromium,firefox,webkit] [--headed]
import { chromium, firefox, webkit, type BrowserType } from '@playwright/test';
import { build, preview } from 'vite';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    outcomes: { type: 'string', default: '75' },
    browsers: { type: 'string', default: 'chromium,firefox,webkit' },
    headed: { type: 'boolean', default: false },
  },
});

interface Timing { mode: string; drawMs: number; waitMs: number; serializeMs: number; totalMs: number }

const engines: Record<string, BrowserType> = { chromium, firefox, webkit };
const modes = ['iframe', 'div', 'div-contain'];
const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

// A production build: React's development build is several times slower and would hide the differences.
const configFile = new URL('./vite.config.ts', import.meta.url).pathname;
const outDir = new URL('./dist', import.meta.url).pathname;
await build({ configFile, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
const server = await preview({ configFile, build: { outDir }, preview: { port: 0, strictPort: false } });
const base = server.resolvedUrls!.local[0];

const rows: string[] = [];
try {
  for (const name of values.browsers.split(',')) {
    const browser = await engines[name].launch({ headless: !values.headed });
    try {
      for (const page of ['1', '0']) {
        for (const mode of modes) {
          const tab = await browser.newPage({ viewport: { width: 1280, height: 900 } });
          const url = `${base}?mode=${mode}&runs=${values.runs}&outcomes=${values.outcomes}&page=${page}`;
          await tab.goto(url);
          await tab.waitForFunction(() => window.__bench?.status === 'done' || window.__bench?.status === 'error', null, {
            timeout: 600_000,
          });
          const bench = await tab.evaluate(() => window.__bench!);
          await tab.close();
          if (bench.status === 'error') throw new Error(`${name} ${mode}: ${bench.error}`);
          const results = bench.results as Timing[];
          const pick = (key: keyof Omit<Timing, 'mode'>) => median(results.map(r => r[key])).toFixed(0).padStart(6);
          const row = `${name.padEnd(9)} ${page === '1' ? 'page   ' : 'no page'} ${mode.padEnd(12)}${pick('drawMs')}${pick('waitMs')}${pick('serializeMs')}${pick('totalMs')}`;
          rows.push(row);
          console.log(row);
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}

console.log(`\n${Number(values.outcomes) * 2} charts, median of ${values.runs} runs (after one warm-up)`);
console.log(`${'browser'.padEnd(9)} ${'page   '} ${'mode'.padEnd(12)}  draw  wait serial total (ms)`);
for (const row of rows) console.log(row);
