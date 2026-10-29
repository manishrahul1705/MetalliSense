import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('../..');
const evidence = process.env.EVIDENCE_DIR;
let backend;
async function startBackend(request) {
  const log = fs.openSync(path.join(evidence, `ui-backend-${Date.now()}.log`), 'w');
  backend = spawn(process.execPath, [path.join(root, 'MetalliSense_Backend_Simple/premeltGate/test/stage1_ui_backend.js')], { cwd: root, env: process.env, stdio: ['ignore', log, log], windowsHide: true });
  await expect.poll(async () => { try { return (await request.get('http://127.0.0.1:4391/api/v1/health', { timeout: 1000 })).status(); } catch { return 0; } }, { timeout: 30000 }).toBe(200);
}
async function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  const stopped = new Promise(resolve => backend.once('exit', resolve));
  backend.kill(); await stopped;
}
test.beforeAll(async ({ request }) => startBackend(request));
test.afterAll(async () => stopBackend());
test('real UI simulated composition receipt and independent DRI approval survive reload and backend restart', async ({ page, request }) => {
  const diagnostic = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.url().includes(':4391/api/')) diagnostic.push({ method: r.request().method(), url: r.url(), status: r.status() }); });
  try {
    await page.goto('/login');
    await page.getByRole('textbox', { name: /username/i }).fill('admin1');
    await page.locator('input[type="password"]').fill(process.env.DEV_ADMIN_PASSWORD);
    await page.getByRole('button', { name: /sign in|log in|login/i }).click();
    await expect(page).not.toHaveURL(/login/);
    const fixture = JSON.parse(fs.readFileSync(path.join(evidence, 'ui-fixture.json')));
    await page.goto('/spectrometer');
    await expect(page.getByText('OPC Control Panel')).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'composition-before.png'), fullPage: true });
    // Real application endpoint, real simulator, current browser session + CSRF.
    const cookies = await page.context().cookies('http://127.0.0.1:4391');
    const csrf = cookies.find(c => c.name === 'metallisense_csrf').value;
    const connected = await page.request.post('http://127.0.0.1:4391/api/v2/spectrometer/opc-connect', { headers: { 'X-CSRF-Token': csrf }, data: {} });
    expect(connected.ok()).toBeTruthy();
    await page.getByLabel('Grade', { exact: true }).fill('SG-IRON');
    await page.getByLabel('Heat ID', { exact: true }).fill(fixture.heatId);
    await expect(page.getByRole('button', { name: 'Request Reading' })).toBeEnabled({ timeout: 15000 });
    await page.getByRole('button', { name: 'Request Reading' }).click();
    await expect(page.getByText(/Receipt: SIM-/)).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/OPC_UA_SIMULATOR/)).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'composition-after.png'), fullPage: true });
    await page.reload();
    await expect(page.getByText(/Receipt: SIM-/)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Simulated', exact: true })).toBeVisible();
    await page.getByText('Reading History', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, 'composition-history-after-reload.png'), fullPage: true });
    await page.goto('/raw-material-stock');
    await page.getByText(fixture.lotId, { exact: true }).first().click();
    await expect(page.getByText('PENDING_APPROVAL', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'dri-before.png'), fullPage: true });
    // Select the application's independent approval action from the lot row.
    await page.keyboard.press('Escape');
    const row = page.getByRole('row').filter({ hasText: fixture.lotId });
    await row.getByRole('button', { name: /approve/i }).click();
    await page.getByText('Approver (must be a different person)').locator('..').getByRole('textbox').fill('Display text cannot change server actor');
    await page.getByRole('button', { name: 'Approve and apply release rules' }).click();
    await expect(row.getByText('Released', { exact: true })).toBeVisible();
    await page.getByText(fixture.lotId, { exact: true }).first().click();
    await expect(page.getByText('APPROVED', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'dri-after.png'), fullPage: true });
    await stopBackend(); await startBackend(request);
    await page.reload();
    await page.getByText(fixture.lotId, { exact: true }).first().click();
    await expect(page.getByText('APPROVED', { exact: true })).toBeVisible();
    const detailResponse = await page.request.get(`http://127.0.0.1:4391/api/v2/premelt/lots/${fixture.lotId}`);
    const detail = (await detailResponse.json()).data;
    expect(detail.lot.chemistrySource).toBe('LAB');
    expect(detail.qa[0].status).toBe('APPROVED');
    expect(detail.qa[0].approvedById).not.toBe(detail.qa[0].analystId);
    fs.writeFileSync(path.join(evidence, 'dri-persisted.json'), JSON.stringify(detail, null, 2));
    await page.goto('/spectrometer');
    await expect(page.getByText(/Receipt: SIM-/)).toBeVisible();
    const priorURL = page.url();
    const upstreamError = await page.evaluate(async () => {
      const { default: api } = await import('/src/services/api.js');
      try { await api.post('/ai/explain', { metalGrade: 'SG-IRON', composition: { C: 3.5, Si: 2.2, Mn: 0.35, P: 0.02, S: 0.01 } }); }
      catch (error) { return { status: error.response.status, data: error.response.data }; }
    });
    expect(upstreamError.status).toBe(502);
    expect(upstreamError.data.code).toBe('UPSTREAM_AUTH_REJECTED');
    expect(page.url()).toBe(priorURL);
    expect((await page.request.get('http://127.0.0.1:4391/api/v2/auth/me')).status()).toBe(200);
    expect(errors).toEqual([]);
  } finally { fs.writeFileSync(path.join(evidence, 'ui-diagnostics.json'), JSON.stringify({ requests: diagnostic, pageErrors: errors }, null, 2)); }
});
