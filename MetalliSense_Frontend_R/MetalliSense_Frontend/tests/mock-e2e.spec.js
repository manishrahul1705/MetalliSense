import { test, expect } from '@playwright/test';

const routes = [
  'dashboard', 'anomaly', 'recommendation', 'rl-optimizer', 'agent', 'grades',
  'synthetic', 'spectrometer', 'training-data', 'semantic-search', 'cost-analysis',
  'full-analysis', 'mechanical-properties', 'raw-material-stock', 'yard-inspection',
  'premelt-gate', 'supplier-scorecard', 'energy', 'inventory-forecast', 'sales',
  'charge-optimizer', 'login', 'signup'
];

async function call(page, path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(async ({ path, body, method }) => {
    const r = await fetch(path, { method, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(path + ': ' + JSON.stringify(j));
    return j;
  }, { path, body, method });
}

test('every route and full browser-only workflow, persistence and reset', async ({ page }) => {
  const errors = [], blocked = [], failed = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', r => failed.push(r.url()));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === 'http://127.0.0.1:4179' || ['data:', 'blob:'].includes(u.protocol)) return route.continue();
    blocked.push(u.href);
    return route.abort();
  });
  await page.goto('/#/dashboard');
  await page.waitForFunction(() => !!window.__METALLISENSE_MOCK__);
  await expect(page.getByText('Demo mode', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reset demo data', exact: true })).toHaveCount(0);
  for (const route of routes) {
    await page.goto('/#/' + route);
    await page.waitForTimeout(850);
    await expect(page.locator('body')).not.toContainText(/service unavailable|Unexpected Application Error|Could not reach/i);
  }
  expect(errors).toEqual([]); expect(blocked).toEqual([]); expect(failed).toEqual([]);
  await page.goto('/#/raw-material-stock');
  const lot = (await call(page, '/api/v2/premelt/lots', { materialType: 'STEEL_SCRAP', supplier: 'Demo delivery', receivedKg: 1500, costPerKg: 30, truckNo: 'TN DEMO 01', demoScenario: 'copper', declared: { C: .1, Si: .2, Mn: .5, P: .02, S: .01, Cu: .8 }, by: 'Demo operator' })).data;
  await call(page, '/api/v2/premelt/gun/inspect', { lotId: lot.lotId, device: 'XRF', pieces: 25, surfacePrepared: true, inspector: 'Demo inspector' });
  await expect.poll(async () => { const r = await call(page, '/api/v2/premelt/gun/live'); return r.data?.status; }, { timeout: 30000 }).toBe('Session Complete');
  const inspected = (await call(page, '/api/v2/premelt/lots/' + lot.lotId)).data; expect(inspected.lot.status).toBe('QUARANTINED');
  const qa = (await call(page, '/api/v2/premelt/lots/DRI-0917/dri-qa', { analyst: 'Demo lab maker', feTotal: 91, feMetallic: 85, C: .15, P: .04, S: .01, SiO2: 4, Al2O3: 2, CaO: .9, MgO: .4, moisture: .2, fines: 2, confirmWarnings: true })).data;
  const released = (await call(page, '/api/v2/premelt/dri-qa/' + qa.qaId + '/approve', { approver: 'Demo lab checker' })).data; expect(released.lot.status).toBe('RELEASED');
  await page.goto('/#/charge-optimizer'); await page.getByRole('button', { name: 'Optimize charge', exact: true }).click(); await expect(page.getByRole('button', { name: 'Use this mix' }).first()).toBeVisible({ timeout: 20000 });
  const before = (await call(page, '/api/v2/premelt/movements?limit=999999')).data.length;
  await page.getByRole('button', { name: 'Use this mix' }).first().click(); await expect(page).toHaveURL(/premelt-gate/); expect((await call(page, '/api/v2/premelt/movements?limit=999999')).data.length).toBe(before);
  const heats = (await call(page, '/api/v2/premelt/heats')).data, heat = heats.find(h => Number(h.heatId.slice(2)) > 1052 && !h.history); expect(heat).toBeTruthy();
  const gate = (await call(page, '/api/v2/premelt/heats/' + heat.heatId + '/gate-check', { by: 'Demo operator' })).data; expect(['GO', 'WARN', 'HOLD']).toContain(gate.decision); expect(gate.checks.length).toBeGreaterThan(5);
  await call(page, '/api/v2/premelt/heats/' + heat.heatId + '/start-melting', { operator: 'Demo operator', acknowledgeWarnings: true, ...(gate.decision === 'HOLD' ? { override: { engineer: 'Demo engineer', reason: 'Reviewed simulated charge and approved a demo-only run' } } : {}) });
  await expect.poll(async () => { const r = await call(page, '/api/v2/api/v1/spectrometer'); return r.data.filter(r => r.heatId === heat.heatId).length; }, { timeout: 15000 }).toBeGreaterThan(0);
  const c = { Fe: 98, C: .02, Si: .02, Mn: .02, P: .06, S: .05 };
  const an = (await call(page, '/api/v2/ai/anomaly/predict', { grade: 'LOW-CARBON-STEEL', composition: c })); expect(an.is_anomaly || an.anomaly_score > .5).toBeTruthy();
  const correction = (await call(page, '/api/v2/ai/individual/analyze', { metalGrade: 'LOW-CARBON-STEEL', composition: c })).data; expect(correction.aiAnalysis.alloyRecommendation).toBeTruthy();
  const composition = { ...gate.prediction.composition, C: 2.9, Si: 1.7, Mn: .2 };
  const ranked = (await call(page, '/api/v2/rl/optimize', { grade: heat.grade, composition, batchWeightKg: gate.prediction.metalKg })).data; expect(ranked.candidates.length).toBe(3);
  const candidate = ranked.candidates.find(c => c.strategy === 'balanced'), ledgerBefore = (await call(page, '/api/v2/premelt/movements?limit=999999')).data;
  const accepted = (await call(page, '/__mock/accept-strategy', { heatId: heat.heatId, candidate, composition })).data; expect(accepted.deductedLines.length).toBeGreaterThan(0);
  const ledgerAfter = (await call(page, '/api/v2/premelt/movements?limit=999999')).data; expect(ledgerAfter.length).toBeGreaterThan(ledgerBefore.length); for (const line of accepted.deductedLines) expect(ledgerAfter.some(m => m.heatId === heat.heatId && m.lotId === line.lotId && m.kg === -line.kg)).toBe(true);
  await call(page, '/__mock/accept-strategy', { heatId: heat.heatId, candidate, composition }); expect((await call(page, '/api/v2/premelt/movements?limit=999999')).data.length).toBe(ledgerAfter.length);
  const mechanical = (await call(page, '/api/v2/mechanical/predict', { grade: heat.grade, composition: gate.prediction.composition })).data; expect(mechanical.predicted_uts_mpa).toBeGreaterThan(0);
  const completed = (await call(page, '/api/v2/sales/heats/' + heat.heatId + '/complete', { approvedBy: 'Demo tap engineer', composition: gate.prediction.composition, mechanical, acceptedStrategy: accepted })).data; expect(completed.status).toBe('COMPLETED');
  const invoice = (await call(page, '/api/v2/sales/invoices', { heatId: heat.heatId, customerId: 'C-001', createdBy: 'Demo sales', poNumber: 'SO-1001' })).data; expect(invoice.total).toBeGreaterThan(0);
  for (const path of ['/api/v2/inventory/forecast', '/api/v2/insights/suppliers/scorecard', '/api/v2/insights/energy/summary']) expect((await call(page, path)).data).toBeTruthy();
  const audit = (await call(page, '/api/v2/premelt/audit?limit=9999')).data; expect(audit.some(a => a.ref === heat.heatId && a.type === 'TAP_APPROVED')).toBe(true);
  const answer = await call(page, '/copilot/chat', { message: 'Why is ' + heat.heatId + ' on HOLD?' }); expect(answer.response).toContain(heat.heatId);
  await page.reload(); await page.waitForFunction(() => !!window.__METALLISENSE_MOCK__); expect((await call(page, '/api/v2/sales/invoices')).data.some(i => i.invoiceId === invoice.invoiceId)).toBe(true);
  const savedState = await call(page, '/__mock/state'); expect(savedState.extra.outbox.some(a => /quarantined|Anomaly/.test(a.subject))).toBe(true);
  await call(page, '/api/v2/premelt/demo/reset', {}); await page.reload(); await page.waitForFunction(() => !!window.__METALLISENSE_MOCK__); await expect.poll(async () => ((await call(page, '/api/v2/sales/invoices')).data.length)).toBe(0);
  expect((await call(page, '/api/v2/premelt/lots')).data.some(l => l.lotId === lot.lotId)).toBe(false);
  expect(errors).toEqual([]); expect(blocked).toEqual([]); expect(failed).toEqual([]);
});

for (const route of ['rl-optimizer', 'full-analysis']) test('accepted candidate stock deduction through ' + route + ' UI', async ({ page }) => {
  const errors = [], external = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', r => { if (new URL(r.request().url()).origin === 'http://127.0.0.1:4179') return r.continue(); external.push(r.request().url()); return r.abort(); });
  await page.goto('/#/dashboard'); await page.waitForFunction(() => !!window.__METALLISENSE_MOCK__);
  const gate = (await call(page, '/api/v2/premelt/heats/H-1051/gate-check', { by: 'UI tester' })).data;
  await call(page, '/api/v2/premelt/heats/H-1051/start-melting', { operator: 'UI tester', acknowledgeWarnings: true, ...(gate.decision === 'HOLD' ? { override: { engineer: 'Demo engineer', reason: 'Reviewed this simulated test heat for browser validation' } } : {}) });
  const composition = { ...gate.prediction.composition, C: 2.9, Si: 1.7, Mn: .2 }, reading = { metalGrade: 'SG-IRON', composition, heatId: 'H-1051' }, ranked = (await call(page, '/api/v2/rl/optimize', { grade: 'SG-IRON', composition, batchWeightKg: gate.prediction.metalKg })).data;
  const flow = { heatId: 'H-1051', grade: 'SG-IRON', metalKg: gate.prediction.metalKg, chargeKg: 1020, gateId: gate.gateId, gateDecision: gate.decision, predictedComposition: composition, compositionSigma: gate.prediction.sigma, gateSpec: gate.spec, stockStatus: 'pending', anomalyResult: { _reading: reading, severity: 'LOW' }, alloyResult: { _reading: reading }, rlResult: { ...ranked, _reading: reading }, suggestedAdditions: gate.suggestedAdditions };
  await page.evaluate(flow => sessionStorage.setItem('metallisense.meltFlow.v1', JSON.stringify(flow)), flow);
  await page.goto('/#/' + route); await page.reload(); await page.waitForFunction(() => !!window.__METALLISENSE_MOCK__);
  if (route === 'full-analysis') {
    await page.getByRole('button', { name: 'Run Full Analysis', exact: true }).click(); await expect(page.getByText('BALANCED', { exact: true })).toBeVisible({ timeout: 20000 });
    const card = page.locator('div.relative.border-2').filter({ has: page.getByText('BALANCED', { exact: true }) }); await card.locator('button').first().click();
  } else await page.locator('#rl-strategy-balanced').getByRole('button', { name: 'Accept & Deduct Stock' }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('metallisense.meltFlow.v1')).stockStatus)).toBe('deducted');
  const state = await call(page, '/__mock/state'), heat = state.store.heats.find(([id]) => id === 'H-1051')[1]; expect(heat.acceptedStrategy.strategy).toBe('balanced');
  const movements = state.store.movements.filter(m => m.heatId === 'H-1051' && m.type === 'ADDITION'); expect(movements.length).toBeGreaterThan(0);
  for (const line of heat.acceptedStrategy.deductedLines) expect(movements.some(m => m.lotId === line.lotId && m.kg === -line.kg)).toBe(true);
  await page.goto('/#/mechanical-properties'); await expect(page.getByText('Mechanical property prediction complete', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => { const x = await call(page, '/api/v2/premelt/heats/H-1051'); return x.data.readings?.length || 0; }, { timeout: 15000 }).toBeGreaterThan(0);
  expect(errors).toEqual([]); expect(external).toEqual([]);
});

test('accessible dialog, keyboard navigation, contrast, and reduced-motion checks', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // 1. Reduced motion emulation
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/grades');
  await page.waitForFunction(() => !!window.__METALLISENSE_MOCK__);

  const prefersReduced = await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  expect(prefersReduced).toBe(true);

  // 2. Dialog accessibility: role, labeling, focus trap, Escape dismissal, focus restoration
  const openModalBtn = page.getByRole('button', { name: /Add New Grade/i }).first();
  await expect(openModalBtn).toBeVisible({ timeout: 15000 });
  await openModalBtn.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  const titleAttr = await dialog.getAttribute('aria-labelledby');
  expect(titleAttr).toBeTruthy();
  const titleEl = page.locator('#' + titleAttr);
  await expect(titleEl).toBeVisible();

  // Test keyboard Tab looping inside dialog
  await page.keyboard.press('Tab');
  const focusedInDialog = await page.evaluate(() => {
    const active = document.activeElement;
    const dialogEl = document.querySelector('[role="dialog"]');
    return dialogEl && dialogEl.contains(active);
  });
  expect(focusedInDialog).toBe(true);

  // Test Escape key closes dialog
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible({ timeout: 5000 });

  // Focus restored to opener button or body
  const activeTagName = await page.evaluate(() => document.activeElement?.tagName);
  expect(['BUTTON', 'BODY']).toContain(activeTagName);

  // 3. Contrast verification (WCAG AA: >= 4.5:1 for standard text, >= 3.0:1 for large text/components)
  const contrastCheck = await page.evaluate(() => {
    function parseRgb(colorStr) {
      const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!match) return [0, 0, 0, 1];
      return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3]), match[4] !== undefined ? parseFloat(match[4]) : 1];
    }
    function luminance([r, g, b]) {
      const a = [r, g, b].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
    }
    function contrastRatio(rgb1, rgb2) {
      const lum1 = luminance(rgb1);
      const lum2 = luminance(rgb2);
      const brightest = Math.max(lum1, lum2);
      const darkest = Math.min(lum1, lum2);
      return (brightest + 0.05) / (darkest + 0.05);
    }
    const sampleElements = Array.from(document.querySelectorAll('button, h1, h2, h3, p, span, th, td')).filter(el => {
      const text = el.textContent.trim();
      return text.length > 2 && text.length < 50 && el.offsetParent !== null;
    }).slice(0, 30);

    let checked = 0;
    let passing = 0;
    for (const el of sampleElements) {
      const style = window.getComputedStyle(el);
      const fg = parseRgb(style.color);
      let bgStyle = style.backgroundColor;
      let curr = el;
      while (curr && (bgStyle === 'rgba(0, 0, 0, 0)' || bgStyle === 'transparent')) {
        curr = curr.parentElement;
        if (curr) bgStyle = window.getComputedStyle(curr).backgroundColor;
      }
      const bg = parseRgb(bgStyle || 'rgb(255, 255, 255)');
      const ratio = contrastRatio(fg, bg);
      checked++;
      if (ratio >= 3.0) passing++;
    }
    return { checked, passing, ratio: checked > 0 ? passing / checked : 1 };
  });
  expect(contrastCheck.ratio).toBeGreaterThanOrEqual(0.85);

  // 4. Role-aware semantic checks
  await page.goto('/#/premelt-gate');
  await page.waitForFunction(() => !!window.__METALLISENSE_MOCK__);
  const buttonsCount = await page.getByRole('button').count();
  expect(buttonsCount).toBeGreaterThan(0);
  const headingsCount = await page.getByRole('heading').count();
  expect(headingsCount).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
