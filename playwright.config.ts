import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    // NODE_ENV=production: serve the real build/dist bundle (matches the
    // deployed app) instead of Vite's dev middleware. Without this, the dev
    // server's React StrictMode double-invokes every mount effect (a
    // dev-only artifact), which makes any test asserting "fetched once on
    // mount" flaky/wrong for reasons that have nothing to do with real
    // app behavior — see e2e/canvas-vector-load.spec.ts.
    // SHEET_FLUSH_INTERVAL_MS=2000: sheets-editor.spec.ts/collab-sheets.spec.ts
    // assert the autosave engine actually lands edits on disk (the
    // data-loss-regression proof) — waiting out the real 15s production
    // cadence per assertion would make those specs unbearably slow.
    command: 'npm run build && NODE_ENV=production STORAGE_PATH=.e2e-data PORT=3000 SHEET_FLUSH_INTERVAL_MS=2000 npx tsx server.ts',
    url: 'http://localhost:3000',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
