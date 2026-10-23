import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Ports are chosen to stay clear of the dev servers in README.md (4178, 4179, 4190, 4191).
const smokePort = 4278;
const reactPort = 4279;
const capturePort = 4291;
const pretextPort = 4293;
const root = fileURLToPath(new URL('../../', import.meta.url));
// A 32 MB WASM module is compiled once per realm, so a cold start is slow on a busy machine.
const startTimeout = 180_000;

export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: '*.spec.ts',
  outputDir: root + 'test-results',
  timeout: 120_000,
  expect: { timeout: 90_000 },
  retries: 0,
  // One test at a time: each page compiles a 32 MB module, and parallel runs would distort the timings.
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: root + 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    // The browsers see the same pages every run; keep their caches out of the timings.
    serviceWorkers: 'block',
  },
  metadata: { smokePort, reactPort, capturePort, pretextPort },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: `npx vite preview --config examples/pretext-hybrid/vite.config.ts --port ${pretextPort} --strictPort`,
      cwd: root,
      url: `http://127.0.0.1:${pretextPort}/`,
      reuseExistingServer: false,
      timeout: startTimeout,
    },
    {
      // Serves fixtures/browser and the built examples/vite-app (.build/vite-app).
      command: 'node tools/serve-smoke.ts',
      cwd: root,
      env: { PORT: String(smokePort) },
      url: `http://127.0.0.1:${smokePort}/fixtures/browser/index.html`,
      reuseExistingServer: false,
      timeout: startTimeout,
    },
    {
      command: `npx vite --config examples/vite-capture/vite.config.ts --port ${capturePort} --strictPort`,
      cwd: root,
      url: `http://127.0.0.1:${capturePort}/`,
      reuseExistingServer: false,
      timeout: startTimeout,
    },
    {
      // The production build in .build/vite-react (from `npm run test:vite`).
      command: `npx vite preview --config examples/vite-react/vite.config.ts --port ${reactPort} --strictPort`,
      cwd: root,
      url: `http://127.0.0.1:${reactPort}/`,
      reuseExistingServer: false,
      timeout: startTimeout,
    },
  ],
});
