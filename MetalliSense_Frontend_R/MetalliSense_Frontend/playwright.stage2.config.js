import { defineConfig } from '@playwright/test';
import crypto from 'node:crypto';
for (const name of ['ADMIN', 'OPERATOR', 'METALLURGIST', 'QM', 'INVENTORY', 'FINANCE']) {
  process.env[`DEV_${name}_PASSWORD`] ||= crypto.randomBytes(24).toString('base64url') + '!1Aa';
}
process.env.METALLISENSE_AGENT_SERVICE_KEY ||= crypto.randomBytes(32).toString('hex');
export default defineConfig({
  testDir: './tests', testMatch: 'stage2-real.spec.js', timeout: 480000,
  workers: 1, retries: 0, outputDir: process.env.EVIDENCE_DIR + '/playwright-results',
  reporter: [['list'], ['json', { outputFile: process.env.EVIDENCE_DIR + '/playwright.json' }]],
  use: { baseURL: 'http://127.0.0.1:4392', headless: true, trace: 'off', screenshot: 'only-on-failure', actionTimeout: 15000 },
  webServer: { command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4392 --strictPort',
    url: 'http://127.0.0.1:4392', reuseExistingServer: false }
});
