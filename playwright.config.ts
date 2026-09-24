import { defineConfig } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080';
if (/urbanprocures\.com|urban-procure\.pages\.dev/.test(new URL(baseURL).hostname)) {
  throw new Error('Browser tests must use an isolated preview, never production.');
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  workers: 1,
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'npm run build && node scripts/preview-worker.mjs',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
