import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const root = path.resolve('../..');
const evidenceDir = process.env.EVIDENCE_DIR;
const backendUrl = 'http://127.0.0.1:4391';
let backend, agent;
const children = [];
function launch(script, args, env, label, cwd = root) {
  const fd = fs.openSync(path.join(evidenceDir, `${label}-${Date.now()}.log`), 'wx');
  const child = spawn(script, args, { env, cwd, stdio: label === 'backend' ? ['ignore', fd, fd, 'ipc'] : ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd); children.push({ label, pid: child.pid, child });
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned process ${child.pid} did not exit`)), 10000); })]); }
  finally { clearTimeout(timer); }
}
function backendEnv() {
  const db = path.join(evidenceDir, 'simulation.db');
  return { ...process.env, NODE_ENV: 'test', SEED_DEV_ACCOUNTS: 'true',
    METALLISENSE_DB_PATH: db, METALLISENSE_SIMULATION: 'true', METALLISENSE_SIMULATION_STORE: db,
    AGENT_SERVICE_URL: 'http://127.0.0.1:4393', ALLOWED_ORIGINS: 'http://127.0.0.1:4392' };
}
async function startBackend(request) {
  backend = launch(process.execPath, [path.join(root, 'MetalliSense_Backend_Simple/premeltGate/test/stage2_ui_backend.js')], backendEnv(), 'backend');
  await expect.poll(async () => { try { return (await request.get(`${backendUrl}/api/v1/health`, { timeout: 1000 })).status(); } catch { return 0; } }, { timeout: 45000 }).toBe(200);
}
async function fault(stage) {
  const id = `${Date.now()}-${Math.random()}`;
  await new Promise((resolve, reject) => {
    const listener = message => { if (message.faultReady === id) { clearTimeout(timer); backend.off('message', listener); resolve(); } };
    const timer = setTimeout(() => { backend.off('message', listener); reject(new Error('Fault injection IPC deadline exceeded')); }, 3000);
    backend.on('message', listener); backend.send({ id, stage2Fault: stage });
  });
}
test.beforeAll(async ({ request }) => {
  expect(process.env.STAGE2_AGENT_PYTHON).toBeTruthy();
  const runtime = path.join(evidenceDir, 'agent-runtime');
  fs.cpSync(path.join(root, 'MetalliSense_Agent_R/MetalliSense_Agent/app'), path.join(runtime, 'app'), { recursive: true, filter: name => !name.includes('__pycache__') });
  agent = launch(process.env.STAGE2_AGENT_PYTHON, [path.join(root, 'tools/stage1_agent_fixture.py'), runtime, '4393'],
    { ...process.env, STAGE1_EXTERNAL_LLM_FIXTURE: 'false', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8',
      JOBLIB_MULTIPROCESSING: '0', GROQ_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' }, 'actual-agent', runtime);
  await expect.poll(async () => { try { return (await request.get('http://127.0.0.1:4393/health', { timeout: 1000 })).status(); } catch { return 0; } }, { timeout: 90000 }).toBe(200);
  await startBackend(request);
});
test.afterAll(async () => {
  const results = [];
  for (const owned of [...children].reverse()) {
    try { await stop(owned.child); results.push({ label: owned.label, pid: owned.pid, exited: true }); }
    catch (e) { results.push({ label: owned.label, pid: owned.pid, exited: false, message: e.message }); }
  }
  fs.writeFileSync(path.join(evidenceDir, 'owned-process-cleanup.json'), JSON.stringify(results, null, 2));
  expect(results.every(r => r.exited)).toBeTruthy();
});

test('complete isolated simulated batch through human UI, actual OPC UA, persistence and documents', async ({ browser, request }) => {
  const diagnostics = [], steps = [], contexts = [], errors = [], boundaries = [];
  let activePage;
  const record = async (name, fn) => {
    const entry = { name, status: 'FAIL', at: new Date().toISOString() }; steps.push(entry);
    try { entry.result = await fn(); entry.status = 'PASS'; }
    catch (e) { entry.error = e.message; throw e; }
  };
  async function login(username, passwordEnv) {
    const context = await browser.newContext(); contexts.push(context);
    const page = await context.newPage(); activePage = page;
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.url().includes(':4391/api/')) diagnostics.push({ method: r.request().method(), url: r.url(), status: r.status() }); });
    await page.goto('/login');
    await page.getByRole('textbox', { name: /username/i }).fill(username);
    await page.locator('input[type=password]').fill(process.env[passwordEnv]);
    const loggedIn = page.waitForResponse(r => r.url().endsWith('/auth/login') && r.request().method() === 'POST', { timeout: 15000 });
    await page.getByRole('button', { name: /sign in|log in|login/i }).click();
    const loginResponse = await loggedIn;
    expect(loginResponse.status(), 'Human UI login must succeed').toBe(200);
    await expect(page).not.toHaveURL(/login/, { timeout: 15000 });
    return page;
  }
  async function receive(page, materialType, description, quantity, declared, alloyName) {
    await page.goto('/raw-material-stock');
    await page.getByRole('button', { name: 'Receive truck', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Material', { exact: true }).locator('..').locator('select').selectOption(materialType);
    await dialog.getByLabel('Description', { exact: true }).fill(description);
    await dialog.getByLabel('Supplier', { exact: true }).fill('Stage2 isolated fixture supplier');
    await dialog.getByLabel('Weighbridge net (kg)', { exact: true }).fill(String(quantity));
    if (alloyName) await dialog.getByText('Alloy', { exact: true }).locator('..').locator('select').selectOption(alloyName);
    for (const [el, value] of Object.entries(declared)) await dialog.getByLabel(`${el} %`, { exact: true }).fill(String(value));
    const response = page.waitForResponse(r => r.url().endsWith('/premelt/lots') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Receive lot', exact: true }).click();
    const result = await response; expect(result.status()).toBe(200);
    return (await result.json()).data;
  }
  async function panel(page, heatId) {
    await page.goto('/spectrometer');
    await page.getByLabel('Heat ID', { exact: true }).fill(heatId);
    await page.getByRole('button', { name: 'Load simulation batch', exact: true }).click();
    await expect(page.getByText(new RegExp(`Batch ${heatId}:`))).toBeVisible();
  }
  async function api(page, route, data, extraHeaders = {}) {
    const cookies = await page.context().cookies(backendUrl);
    const csrf = cookies.find(c => c.name === 'metallisense_csrf')?.value;
    try {
      return await page.request.post(`${backendUrl}/api/v2/${route}`, { headers: { 'X-CSRF-Token': csrf || '', ...extraHeaders }, data, timeout: 10000 });
    } catch (error) {
      // Record a transport failure without copying Playwright's cookie-bearing
      // request dump into the shared report. It remains a required test failure.
      diagnostics.push({ method: 'POST', url: `${backendUrl}/api/v2/${route}`, transportError: /ECONNRESET/.test(error.message) ? 'ECONNRESET' : 'REQUEST_FAILED' });
      throw new Error(`HTTP request failed for ${route}; see sanitized diagnostics`);
    }
  }
  async function get(page, route) {
    const r = await page.request.get(`${backendUrl}/api/v2/${route}`, { timeout: 10000 }); expect(r.status()).toBe(200); return (await r.json()).data;
  }
  function persisted() {
    const db = new DatabaseSync(path.join(evidenceDir, 'simulation.db'), { readOnly: true });
    try { return Object.fromEntries(['lots', 'qa_results', 'heats', 'evidence', 'movements', 'maker_checker_reviews', 'correction_candidates', 'simulation_artifacts', 'invoices', 'idempotency_receipts', 'heat_transitions']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
    finally { db.close(); }
  }
  async function reject(name, page, route, body, status, extraHeaders) {
    const before = persisted();
    const response = await api(page, route, body, extraHeaders);
    const payload = await response.json();
    boundaries.push({ name, route, request: body, status: response.status(), response: payload });
    expect(response.status(), name).toBe(status);
    expect(persisted(), `${name}: rejected operation changed persisted business values`).toEqual(before);
  }
  try {
    const admin = await login('admin1', 'DEV_ADMIN_PASSWORD');
    let pig, dri, alloy, heatId, correctedReading;
    await record('a. Material intake through UI', async () => {
      pig = await receive(admin, 'PIG_IRON', 'Stage2 deterministic pig iron', 1000, { C: 4.02, Si: 2.6, Mn: 0.65, P: 0.025, S: 0.015 });
      dri = await receive(admin, 'DRI', 'Stage2 deterministic DRI', 200, {});
      alloy = await receive(admin, 'FERROALLOY', 'Stage2 certified FeSi', 100, { Si: 75, C: 0.1, Mn: 0.3, P: 0.03, S: 0.01 }, 'FeSi-75');
      return { pig: pig.lotId, dri: dri.lotId, alloy: alloy.lotId };
    });
    const qm = await login('qm1', 'DEV_QM_PASSWORD');
    await record('b1. DRI QA entry through UI', async () => {
      await qm.goto('/raw-material-stock');
      const row = qm.getByRole('row').filter({ hasText: dri.lotId });
      await row.getByRole('button', { name: /lab/i }).click();
      const dialog = qm.getByRole('dialog');
      await dialog.getByLabel('Analyst (QA engineer) *', { exact: true }).fill('Simulation fixture QA');
      for (const [label, value] of Object.entries({ 'Fe total % *': 92, 'Fe metallic % *': 85, 'C % *': 1.2, 'P % *': 0.02, 'S % *': 0.015 })) await dialog.getByLabel(label, { exact: true }).fill(String(value));
      await dialog.getByRole('button', { name: 'Save lab result', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      return get(qm, `premelt/lots/${dri.lotId}`);
    });
    const op = await login('operator1', 'DEV_OPERATOR_PASSWORD');
    await record('c. Grade and feasible charge plan through UI', async () => {
      await op.goto('/premelt-gate');
      await op.getByText('Grade', { exact: true }).locator('..').locator('select').selectOption('SG-IRON');
      await op.getByLabel('Target charge (kg)', { exact: true }).fill('1000');
      const response = op.waitForResponse(r => r.url().endsWith('/premelt/heats') && r.request().method() === 'POST');
      await op.getByRole('button', { name: 'Plan heat', exact: true }).click();
      const planned = await response; expect(planned.status()).toBe(200); heatId = (await planned.json()).data.heatId;
      for (const [index, line] of [[pig.lotId, 900], [dri.lotId, 100]].entries()) {
        await op.getByRole('button', { name: 'Add lot', exact: true }).click();
        await op.getByLabel('Lot', { exact: true }).nth(index).selectOption(line[0]);
        await op.getByLabel('kg', { exact: true }).nth(index).fill(String(line[1]));
      }
      await op.getByRole('button', { name: 'Save', exact: true }).click();
      return { heatId };
    });
    await record('d1. Genuine HOLD from pending independent DRI QA', async () => {
      const response = op.waitForResponse(r => r.url().includes('/gate-check'));
      await op.getByRole('button', { name: 'Run pre-melt check', exact: true }).click();
      const result = await (await response).json(); expect(result.data.decision).toBe('HOLD');
      expect(result.data.checks.some(c => c.status === 'FAIL' && /lot|dri/i.test(c.id || c.key || c.title))).toBeTruthy();
      await op.screenshot({ path: path.join(evidenceDir, 'gate-hold.png'), fullPage: true });
      return result.data;
    });
    await record('b2. Independent DRI approval through UI', async () => {
      await admin.goto('/raw-material-stock');
      const row = admin.getByRole('row').filter({ hasText: dri.lotId });
      await row.getByRole('button', { name: /^Approve$/i }).click();
      await admin.getByLabel('Approver (must be a different person)', { exact: true }).fill('Independent fixture reviewer');
      await admin.getByRole('button', { name: 'Approve and apply release rules', exact: true }).click();
      await expect(row.getByText('Released', { exact: true })).toBeVisible();
      await admin.screenshot({ path: path.join(evidenceDir, 'dri-approved.png'), fullPage: true });
      return get(admin, `premelt/lots/${dri.lotId}`);
    });
    await record('d2. Resolve HOLD cause and obtain GO', async () => {
      await op.reload();
      const response = op.waitForResponse(r => r.url().includes('/gate-check'));
      await op.getByRole('button', { name: 'Run pre-melt check', exact: true }).click();
      const result = await (await response).json(); expect(result.data.decision).toBe('GO');
      await op.screenshot({ path: path.join(evidenceDir, 'gate-go.png'), fullPage: true });
      return result.data;
    });
    await record('e. Permitted melting transition through UI', async () => {
      await op.locator('input[placeholder="Name"]').fill('Operator fixture');
      await op.getByRole('button', { name: /^Start melting/ }).click();
      await expect.poll(async () => (await get(op, `premelt/heats/${heatId}`)).status).toBe('MELTING');
      return get(op, `premelt/heats/${heatId}`);
    });
    await reject('Missing chemistry cannot evaluate correction', op, 'premelt/corrections/evaluate', { heatId, additions: [{ lotId: alloy.lotId, alloyName: 'FeSi-75', kg: 1 }] }, 422);
    await reject('Release before final QA', qm, `sales/heats/${heatId}/complete`, {}, 422);
    await reject('Invoice before release', admin, 'sales/invoices', { heatId, customerId: 'C-001' }, 409);
    const beforeCertificate = persisted();
    expect((await admin.request.get(`${backendUrl}/api/v2/sales/certificates/${heatId}`)).status()).toBe(409);
    expect(persisted()).toEqual(beforeCertificate);
    await reject('Disconnected simulator', op, 'spectrometer/opc-reading', { heatId, metalGrade: 'SG-IRON' }, 503);
    await reject('Wrong heat acquisition', op, 'spectrometer/opc-reading', { heatId: 'H-NOT-THIS-HEAT', metalGrade: 'SG-IRON' }, 404);
    await reject('Human cannot submit physical chemistry', admin, `premelt/heats/${heatId}/evidence`, { evidenceType: 'MELT_MEASURED', units: '%', values: { C: 3.5, Si: 2.2, Mn: 0.5, P: 0.02, S: 0.015 } }, 422);
    await record('f. Heat-linked actual OPC UA simulator reading', async () => {
      await panel(op, heatId);
      const connect = op.getByRole('button', { name: 'Connect', exact: true });
      if (await connect.isVisible()) await connect.click();
      await expect(op.getByRole('button', { name: 'Request Reading', exact: true })).toBeEnabled({ timeout: 20000 });
      await op.getByRole('button', { name: 'Request Reading', exact: true }).click();
      await expect(op.getByText(/Receipt: SIM-/)).toBeVisible({ timeout: 20000 });
      await op.screenshot({ path: path.join(evidenceDir, 'initial-opc-sample.png'), fullPage: true });
      return get(op, `premelt/heats/${heatId}/evidence`);
    });
    const makerProbeResponse = await api(admin, 'premelt/corrections/evaluate', { heatId, additions: [{ lotId: alloy.lotId, alloyName: 'FeSi-75', kg: 1 }] });
    expect(makerProbeResponse.status()).toBe(200);
    const makerProbe = (await makerProbeResponse.json()).data;
    await reject('Authorized administrator cannot approve their own evaluated candidate', admin, 'premelt/corrections/approve', makerProbe, 403);
    await record('g. Feasible correction calculated and saved through UI', async () => {
      await op.getByLabel('Correction stock', { exact: true }).selectOption(alloy.lotId);
      await op.getByLabel('Correction kg', { exact: true }).fill('1');
      await op.getByRole('button', { name: 'Evaluate and save correction', exact: true }).click();
      await expect(op.getByText(/Feasible candidate saved/)).toBeVisible();
      return get(op, `premelt/heats/${heatId}/corrections`);
    });
    const met = await login('metallurgist1', 'DEV_METALLURGIST_PASSWORD');
    const savedCandidate = (await get(op, `premelt/heats/${heatId}/corrections`))[0];
    await reject('Unauthorized correction approval', op, 'premelt/corrections/approve', savedCandidate, 403);
    await reject('Stale candidate version', met, 'premelt/corrections/approve', { ...savedCandidate, expectedHeatVersion: savedCandidate.expectedHeatVersion - 1 }, 409);
    await reject('Changed quantities after evaluation', met, 'premelt/corrections/approve', { ...savedCandidate, additions: [{ lotId: alloy.lotId, alloyName: 'FeSi-75', kg: 2 }] }, 409);
    await reject('Wrong sample approval', met, 'premelt/corrections/approve', { ...savedCandidate, evidenceVersion: 'WRONG-HEAT-SAMPLE' }, 409);
    const beforeStock = persisted();
    const unavailable = await api(op, 'premelt/corrections/evaluate', { heatId, additions: [{ lotId: alloy.lotId, alloyName: 'FeSi-75', kg: 10000 }] });
    expect(unavailable.status()).toBe(200); expect((await unavailable.json()).data.feasible).toBe(false);
    expect(persisted()).toEqual(beforeStock);
    await record('h. Independent exact-candidate approval through UI', async () => {
      await panel(met, heatId);
      await met.getByRole('button', { name: 'Independently approve correction', exact: true }).click();
      await expect(met.getByText('Independent correction approval recorded.', { exact: true })).toBeVisible();
      return get(met, `premelt/heats/${heatId}/corrections`);
    });
    await record('i. Atomic deduction of approved quantities through UI', async () => {
      await panel(op, heatId);
      await reject('Changed quantities after approval', op, 'premelt/additives/deduct', { heatId, candidateId: savedCandidate.candidateId, candidateHash: savedCandidate.candidateHash,
        lines: [{ lotId: alloy.lotId, alloyName: 'FeSi-75', kg: 2 }] }, 409, { 'Idempotency-Key': 'rejected-changed-quantity' });
      for (const stage of ['AFTER_FIRST_WRITE', 'BEFORE_COMMIT']) {
        await fault(stage);
        try { await reject(`Atomic rollback at ${stage}`, op, 'premelt/additives/deduct', { heatId, candidateId: savedCandidate.candidateId,
          candidateHash: savedCandidate.candidateHash, lines: savedCandidate.additions }, 500, { 'Idempotency-Key': `rollback-${stage}` }); }
        finally { await fault(null); }
      }
      // Lost response after commit: retry the same normal UI operation/key.
      await fault('AFTER_COMMIT_BEFORE_RESPONSE');
      const lostResponse = op.waitForResponse(r => r.url().endsWith('/additives/deduct'));
      await op.getByRole('button', { name: 'Deduct approved simulation stock', exact: true }).click();
      expect((await lostResponse).status()).toBe(500);
      await fault(null);
      const afterLostResponse = persisted();
      const response = op.waitForResponse(r => r.url().endsWith('/additives/deduct'));
      await op.getByRole('button', { name: 'Deduct approved simulation stock', exact: true }).click();
      const receipt = await response; expect(receipt.status()).toBe(200);
      await expect(op.getByText(/Approved stock deducted/)).toBeVisible();
      expect(persisted()).toEqual(afterLostResponse);
      return (await receipt.json()).data;
    });
    await record('j. Corrected subsequent OPC sample from material balance', async () => {
      const response = op.waitForResponse(r => r.url().endsWith('/opc-reading'));
      await op.getByRole('button', { name: 'Request Reading', exact: true }).click();
      const r = await response; expect(r.status()).toBe(200);
      const reading = (await r.json()).data.reading;
      correctedReading = reading;
      expect(reading.simulationBasis.consumedApprovalIds).toHaveLength(1);
      await op.screenshot({ path: path.join(evidenceDir, 'corrected-opc-sample.png'), fullPage: true });
      return reading;
    });
    await record('k. Independent simulated final QA and release through UI', async () => {
      await panel(qm, heatId);
      const labValues = { uts_mpa: 450, ys_mpa: 280, elongation_pct: 12, hardness_hb: 200 };
      await reject('Unauthorized human final QA', op, `premelt/heats/${heatId}/evidence`, { evidenceType: 'SIMULATED_LAB', units: 'MPa, %, HB', values: labValues }, 403);
      await reject('Invalid laboratory units', qm, `premelt/heats/${heatId}/evidence`, { evidenceType: 'SIMULATED_LAB', units: '%', values: labValues }, 422);
      await reject('Invalid laboratory values', qm, `premelt/heats/${heatId}/evidence`, { evidenceType: 'SIMULATED_LAB', units: 'MPa, %, HB', values: { ...labValues, uts_mpa: null } }, 422);
      for (const [key, value] of Object.entries({ uts_mpa: 450, ys_mpa: 280, elongation_pct: 12, hardness_hb: 200 })) await qm.getByLabel(key, { exact: true }).fill(String(value));
      await qm.getByRole('button', { name: 'Save simulated final QA', exact: true }).click();
      await expect(qm.getByText(/Simulated final QA recorded/)).toBeVisible();
      await qm.getByRole('button', { name: 'Release simulation batch', exact: true }).click();
      await expect(qm.getByText(/Simulation batch released/)).toBeVisible();
      await qm.screenshot({ path: path.join(evidenceDir, 'simulation-release.png'), fullPage: true });
      return get(qm, `premelt/heats/${heatId}`);
    });
    const fin = await login('finance1', 'DEV_FINANCE_PASSWORD');
    await record('l. Simulation certificate and invoice through UI', async () => {
      await fin.goto('/sales');
      const row = fin.getByRole('row').filter({ hasText: heatId });
      await row.getByRole('button', { name: 'Create invoice', exact: true }).click();
      const dialog = fin.getByRole('dialog', { name: 'Create invoice' });
      await dialog.getByLabel('Prepared by', { exact: true }).fill('Simulation finance fixture');
      const response = fin.waitForResponse(r => r.url().endsWith('/sales/invoices') && r.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Issue invoice', exact: true }).click();
      const invoice = await response; expect(invoice.status()).toBe(200);
      const artifact = (await invoice.json()).data;
      expect(artifact.executionContext).toBe('SIMULATION');
      await expect(fin.getByText('SIMULATION INVOICE', { exact: true })).toBeVisible();
      await fin.screenshot({ path: path.join(evidenceDir, 'simulation-invoice.png'), fullPage: true });
      await fin.getByRole('button', { name: 'Test certificate', exact: true }).click();
      await expect(fin.getByText('SIMULATION CERTIFICATE', { exact: true })).toBeVisible();
      await fin.screenshot({ path: path.join(evidenceDir, 'simulation-certificate.png'), fullPage: true });
      return { invoice: artifact, certificate: await get(fin, `sales/certificates/${heatId}`) };
    });
    await record('m. Traceability, backend restart and idempotency', async () => {
      const snapshot = async () => ({ heat: await get(admin, `premelt/heats/${heatId}`), evidence: await get(admin, `premelt/heats/${heatId}/evidence`),
        corrections: await get(admin, `premelt/heats/${heatId}/corrections`), stock: await get(admin, `premelt/lots/${alloy.lotId}`),
        certificate: await get(admin, `sales/certificates/${heatId}`), invoices: await get(admin, 'sales/invoices') });
      const before = await snapshot();
      const persistedBefore = persisted();
      const initialBath = before.heat.gateResult.prediction;
      // Independent arithmetic using declared FeSi composition and recovery,
      // rather than calling the production material-balance helper.
      const recoveredKg = { C: 0.001 * 0.85, Si: 0.75 * 0.85, Mn: 0.003 * 0.85,
        P: 0.0003, S: 0.0001, Fe: 0.2456 * 0.95 };
      const dissolvedKg = Object.values(recoveredKg).reduce((a, b) => a + b, 0);
      const expectedBathMassKg = initialBath.metalKg + dissolvedKg;
      expect(correctedReading.simulationBasis.bathMassKg).toBeCloseTo(expectedBathMassKg, 8);
      const expectedChemistry = {};
      for (const el of ['C', 'Si', 'Mn', 'P', 'S', 'Fe']) {
        const expected = (initialBath.metalKg * initialBath.composition[el] / 100 + recoveredKg[el]) / expectedBathMassKg * 100;
        expectedChemistry[el] = expected;
        expect(Math.abs(correctedReading.composition[el] - expected)).toBeLessThanOrEqual(0.00051);
      }
      expect(before.stock.lot.availableKg).toBe(99);
      expect((await get(admin, `premelt/lots/${pig.lotId}`)).lot.availableKg).toBe(100);
      expect((await get(admin, `premelt/lots/${dri.lotId}`)).lot.availableKg).toBe(100);
      expect(before.heat.tap.castingsKg).toBe(Math.floor(expectedBathMassKg * 0.70 * 1000) / 1000);
      expect(before.heat.tap.returnsKg).toBe(Math.floor(expectedBathMassKg * 0.25 * 1000) / 1000);
      const allocation = before.heat.tap.massBalance;
      expect(allocation.differenceKg).toBe(0);
      expect(Math.round((allocation.castingsKg + allocation.returnsKg + allocation.processLossKg + allocation.allocationRoundingResidualKg + allocation.unallocatedKg) * 1e6)).toBe(Math.round(expectedBathMassKg * 1e6));
      expect(before.certificate.massBalance).toEqual(allocation);
      expect(correctedReading.simulationBasis.unrecoveredAdditiveKg).toBe(0.12538);
      const invoice = before.invoices.find(i => i.heatId === heatId);
      expect(invoice.taxableRs).toBe(Math.round(before.heat.tap.castingsKg * before.heat.tap.sellingRsPerKg * 100) / 100);
      expect(invoice.gstRs).toBeCloseTo(invoice.taxableRs * 0.18, 2);
      expect(invoice.totalRs).toBeCloseTo(invoice.taxableRs + invoice.gstRs, 2);
      fs.writeFileSync(path.join(evidenceDir, 'inventory-material-reconciliation.json'), JSON.stringify({
        initialBath, recoveredKg, dissolvedKg, expectedBathMassKg, expectedChemistry,
        correctedReading, stock: before.stock, tap: before.heat.tap, invoice,
        movements: persistedBefore.movements.filter(m => m.heat_id === heatId),
        rounding: 'Chemistry 0.001 percentage point; ledger and castings/returns floor to 0.001 kg; mass accounting 0.000001 kg with explicit carry'
      }, null, 2));
      await stop(backend); await startBackend(request);
      const after = await snapshot(); expect(after).toEqual(before);
      expect(persisted()).toEqual(persistedBefore);
      const replay = await api(op, 'premelt/additives/deduct', { heatId, lines: savedCandidate.additions,
        candidateId: savedCandidate.candidateId, candidateHash: savedCandidate.candidateHash }, { 'Idempotency-Key': `simulation-${savedCandidate.candidateId}` });
      expect(replay.status()).toBe(200);
      expect(persisted()).toEqual(persistedBefore);
      expect((await api(qm, `sales/heats/${heatId}/complete`, { version: after.heat.version })).status()).toBe(200);
      expect((await api(fin, 'sales/invoices', { heatId, customerId: 'C-001' })).status()).toBe(409);
      expect(await snapshot()).toEqual(before);
      return { before, after, persistedBefore, persistedAfter: persisted() };
    });
    await record('n. Snapshot stability after configuration changes; responsive and keyboard controls', async () => {
      const cert = await get(admin, `sales/certificates/${heatId}`);
      const invoice = (await get(admin, 'sales/invoices')).find(i => i.heatId === heatId);
      const fullInvoice = await get(admin, `sales/invoices/${invoice.invoiceId}`);
      const configuration = await get(admin, 'sales/config');
      const changed = await admin.request.patch(`${backendUrl}/api/v2/sales/config`, { headers: { 'X-CSRF-Token': (await admin.context().cookies(backendUrl)).find(c => c.name === 'metallisense_csrf').value }, data: { seller: { name: 'Changed isolated configuration' }, castingYieldPct: 68, returnsPct: 27, documentedLossPct: 5 } });
      expect(changed.status()).toBe(200);
      expect(await get(admin, `sales/certificates/${heatId}`)).toEqual(cert);
      expect(await get(admin, `sales/invoices/${invoice.invoiceId}`)).toEqual(fullInvoice);
      const restored = await admin.request.patch(`${backendUrl}/api/v2/sales/config`, { headers: { 'X-CSRF-Token': (await admin.context().cookies(backendUrl)).find(c => c.name === 'metallisense_csrf').value }, data: configuration });
      expect(restored.status()).toBe(200);
      for (const width of [360, 768, 1280]) {
        await qm.setViewportSize({ width, height: 900 });
        await qm.goto('/spectrometer');
        await qm.getByLabel('Heat ID', { exact: true }).fill(heatId);
        const load = qm.getByRole('button', { name: 'Load simulation batch', exact: true });
        await load.focus(); await qm.keyboard.press('Enter');
        await expect(qm.getByRole('region', { name: 'Mass reconciliation' })).toBeVisible();
        expect(await qm.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
        await qm.screenshot({ path: path.join(evidenceDir, `responsive-keyboard-${width}.png`), fullPage: true });
      }
      return { certificateStable: true, invoiceStable: true, widths: [360,768,1280], keyboard: 'Enter activates native load button', zoom: 'OWNER-REPORTED MANUAL PASS only; not re-executed' };
    });
    expect(errors).toEqual([]);
  } finally {
    if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: path.join(evidenceDir, 'last-browser-state.png'), fullPage: true });
    fs.writeFileSync(path.join(evidenceDir, 'lifecycle-results.json'), JSON.stringify({ steps, boundaries, diagnostics, errors }, null, 2));
    for (const context of contexts) await context.close();
  }
});
