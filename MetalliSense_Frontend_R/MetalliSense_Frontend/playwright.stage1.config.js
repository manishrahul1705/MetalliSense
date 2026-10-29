import { defineConfig } from '@playwright/test';
import crypto from 'node:crypto';
process.env.DEV_ADMIN_PASSWORD ||= crypto.randomBytes(32).toString('base64url') + '!1Aa';
export default defineConfig({
  testDir: './tests', testMatch: 'stage1-real.spec.js', timeout: 120000,
  workers: 1, retries: 0, outputDir: process.env.EVIDENCE_DIR + '/playwright-results',
  reporter: [['list'], ['json', { outputFile: process.env.EVIDENCE_DIR + '/playwright.json' }]],
  use: { baseURL: 'http://127.0.0.1:4392', headless: true, trace: 'off', screenshot: 'only-on-failure', actionTimeout: 15000 },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4392 --strictPort',
    url: 'http://127.0.0.1:4392', reuseExistingServer: false,
    env: { VITE_API_BASE_URL: 'http://127.0.0.1:4391/api/v2', VITE_MOCK_MODE: 'false' } }
});
