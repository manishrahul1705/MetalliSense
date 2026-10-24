/**
 * /api/v2/premelt — Raw material stock, alloy additives, DRI QA,
 * handheld gun inspections, heat planning and the Pre-Melt Gate.
 */
const express = require('express');
const store = require('./store');
const driQa = require('./driQa');
const additives = require('./additives');
const gunService = require('./gunService');
const { ingestCsv } = require('./gunIngest');
const { simulateSession, toCsv, SCENARIOS } = require('./gunSimulator');
const gate = require('./gateEngine');
const config = require('./config');
const inventoryLedger = require('./inventoryLedger');
const { lotChemistry } = require('./chemistry');
const scorecard = require('./supplierScorecard');
const purchaseRequests = require('./purchaseRequests');

const router = express.Router();

const wrap = (fn) => async (req, res) => {
  try {
    const data = await fn(req, res);
    if (!res.headersSent) res.json({ status: 'success', data });
  } catch (e) {
    const status = e.status || 500;
    const { message, status: _s, stack, ...extra } = e;
    res.status(status).json({ status: status < 500 ? 'fail' : 'error', message, ...extra });
  }
};
const bad = (status, message) => Object.assign(new Error(message), { status });

const sessionSummary = ({ csv, readings, ...s }) => ({ ...s, readingCount: readings.length });

// A clean lot that was inspected before the demo starts.
function seedInspections() {
  const lot = store.getLot('SCR-0912');
  if (lot && !lot.sessionIds.length) {
    const sim = simulateSession(lot, { device: 'XRF', pieces: 15, sessionNo: 1, startAt: Date.now() - 36 * 3600 * 1000 });
    ingestCsv(toCsv(sim.rows), { inspector: 'M. Karthik (yard)', via: 'OPC_UA_SIMULATOR' });
  }
}
seedInspections();

// ================================================================ stock
router.get('/summary', wrap(() => {
  // Past deliveries (supplier history) are for the scorecard, not today's stock.
  const lots = store.listLots().filter((l) => !l.history).map(store.view);
  const byType = {};
  lots.forEach((l) => {
    const t = (byType[l.materialType] = byType[l.materialType] || { materialType: l.materialType, label: l.materialLabel, availableKg: 0, usableKg: 0, lots: 0 });
    t.availableKg += l.availableKg;
    if (['RELEASED', 'RESTRICTED'].includes(l.status)) t.usableKg += l.availableKg;
    if (l.status !== 'CONSUMED') t.lots += 1;
  });
  const byStatus = {};
  lots.filter((l) => l.status !== 'CONSUMED').forEach((l) => { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });

  const alerts = [];
  lots.filter((l) => l.status === 'QUARANTINED').forEach((l) => alerts.push({ level: 'error', lotId: l.lotId, text: `${l.lotId} quarantined: ${l.statusReason}` }));
  lots.filter((l) => l.status === 'AWAITING_QA').forEach((l) => alerts.push({ level: 'warning', lotId: l.lotId, text: `${l.lotId} waiting for ${l.materialType === 'DRI' ? 'QA lab result' : 'yard gun inspection'}` }));
  lots.filter((l) => l.status === 'PROVISIONAL').forEach((l) => alerts.push({ level: 'warning', lotId: l.lotId, text: `${l.lotId} lab result waiting for approval` }));
  lots.filter((l) => l.materialType === 'DRI' && l.chemistrySource === 'LAB' && l.status !== 'CONSUMED').forEach((l) => {
    const qa = store.qa.list(l.lotId).find((q) => q.status === 'APPROVED');
    const age = qa ? (Date.now() - new Date(qa.testedAt).getTime()) / 86400000 : 0;
    if (age > config.settings.driMaxAgeDays) alerts.push({ level: 'warning', lotId: l.lotId, text: `${l.lotId} lab result is ${age.toFixed(0)} days old — re-test (re-oxidation)` });
  });
  additives.inventory().filter((a) => a.lowStock).forEach((a) => alerts.push({ level: 'warning', text: `${a.alloyName} low: ${a.availableKg} kg (reorder at ${a.reorderLevelKg} kg)` }));

  return { byType: Object.values(byType), byStatus, alerts, lotCount: lots.length };
}));

router.get('/lots', wrap((req) => {
  let lots = store.listLots().filter((l) => req.query.all === '1' || !l.history).map(store.view);
  if (req.query.type) lots = lots.filter((l) => l.materialType === req.query.type);
  if (req.query.status) lots = lots.filter((l) => l.status === req.query.status);
  const grades = scorecard.gradeIndex();
  return lots.map((l) => {
    const raw = store.getLot(l.lotId);
    const chem = lotChemistry(raw);
    return { ...l, metalYieldPct: Math.round(chem.yield * 1000) / 10, supplierGrade: scorecard.gradeForLot(raw, grades) };
  });
}));

router.get('/lots/:lotId', wrap((req) => {
  const lot = store.getLot(req.params.lotId);
  if (!lot) throw bad(404, `Lot ${req.params.lotId} not found`);
  const chem = lotChemistry(lot);
  return {
    lot: { ...store.view(lot), supplierGrade: scorecard.gradeForLot(lot) },
    meltContribution: { composition: chem.composition, yieldPct: Math.round(chem.yield * 1000) / 10, source: chem.source },
    qa: store.qa.list(lot.lotId),
    gunSessions: store.sessions.list(lot.lotId).map(({ csv, ...s }) => s),
    movements: store.listMovements(lot.lotId),
    heats: store.heats.list().filter((h) => h.charge.some((c) => c.lotId === lot.lotId)).map((h) => ({ heatId: h.heatId, grade: h.grade, status: h.status })),
  };
}));

router.post('/lots', wrap((req) => {
  const b = req.body || {};
  if (!config.MATERIAL_TYPES[b.materialType]) throw bad(400, `materialType must be one of ${Object.keys(config.MATERIAL_TYPES).join(', ')}`);
  if (!(Number(b.receivedKg) > 0)) throw bad(400, 'receivedKg must be a positive number');
  if (b.materialType === 'FERROALLOY' && !b.alloyName) throw bad(400, 'alloyName is required for ferroalloys (e.g. FeSi-75, HC FeMn, Recarburiser)');
  if (b.demoScenario && !SCENARIOS[b.demoScenario]) throw bad(400, `demoScenario must be one of ${Object.keys(SCENARIOS).join(', ')}`);
  // Receiving against a purchase request: check it first, link it after.
  const prId = b.prId ? String(b.prId).trim().toUpperCase() : null;
  if (prId) purchaseRequests.checkReceivable(prId, { materialType: b.materialType, alloyName: b.alloyName });
  const declared = {};
  Object.entries(b.declared || {}).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined) declared[k] = Number(v); });
  const lot = store.addLot({ ...b, declared, receivedKg: Number(b.receivedKg) }, b.receivedBy || 'stores');
  // The supplier's grade decides how hard this lot is inspected.
  const supplierGrade = scorecard.gradeForLot(lot);
  if (supplierGrade?.grade === 'D') lot.flags = [...(lot.flags || []), 'SUPPLIER_GRADE_D'];
  const pr = prId ? purchaseRequests.receive(prId, { lotId: lot.lotId, by: b.receivedBy || 'stores' }) : null;
  return { ...store.view(lot), supplierGrade, prId: pr?.prId || null };
}));

router.patch('/lots/:lotId/status', wrap((req) => {
  const lot = store.getLot(req.params.lotId);
  if (!lot) throw bad(404, `Lot ${req.params.lotId} not found`);
  const { status, by, reason, maxSharePct } = req.body || {};
  const allowed = ['RELEASED', 'RESTRICTED', 'QUARANTINED', 'REJECTED'];
  if (!allowed.includes(status)) throw bad(400, `status must be one of ${allowed.join(', ')}`);
  if (!by || !reason || reason.trim().length < 10) throw bad(400, 'A manual QA decision needs a name and a reason (10+ characters)');
  if (lot.status === 'CONSUMED') throw bad(409, 'Lot is consumed');
  if (status === 'RELEASED' && lot.materialType === 'DRI' && lot.chemistrySource !== 'LAB') throw bad(409, 'Sponge iron can only be released through an approved lab result');
  // Grade-D supplier: releasing (fully or restricted) needs a manager's approval.
  const supplierGrade = scorecard.gradeForLot(lot);
  if (['RELEASED', 'RESTRICTED'].includes(status) && supplierGrade?.grade === 'D' && !req.body.managerApproval) {
    throw bad(403, `${lot.supplier} is a grade D supplier (score ${supplierGrade.score}). Releasing this lot needs a manager's approval — tick "Manager approval" and give the manager's name.`);
  }
  if (req.body.managerApproval) lot.flags = (lot.flags || []).filter((f) => f !== 'MANAGER_APPROVAL_REQUIRED');
  store.setStatus(lot, status, `${req.body.managerApproval ? 'Manager approval' : 'Manual QA decision'} by ${by}: ${reason.trim()}`, by, {
    restriction: status === 'RESTRICTED' ? { maxSharePct: Number(maxSharePct) || 20 } : null,
    decidedBy: 'MANUAL',
  });
  return store.view(lot);
}));

router.post('/lots/:lotId/adjust', wrap((req) => {
  const lot = store.getLot(req.params.lotId);
  if (!lot) throw bad(404, `Lot ${req.params.lotId} not found`);
  const kg = Number(req.body?.kg);
  if (!Number.isFinite(kg) || kg === 0) throw bad(400, 'kg must be a non-zero number (negative to remove)');
  if (!req.body.by || !req.body.reason) throw bad(400, 'by and reason are required');
  if (store.availableKg(lot.lotId) + kg < 0) throw bad(400, 'Adjustment would make stock negative');
  store.addMovement({ lotId: lot.lotId, type: 'ADJUST', kg, by: req.body.by, note: req.body.reason });
  return store.view(lot);
}));

router.get('/movements', wrap((req) => store.listMovements(req.query.lotId).slice(0, Number(req.query.limit) || 200)));
router.get('/additives', wrap(() => additives.inventory()));

// Deduct additive stock atomically with idempotency and schema validation
router.post('/additives/deduct', wrap((req) => {
  const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotencyKey;
  const result = inventoryLedger.deductAdditivesAtomic({
    lines: req.body?.lines,
    heatId: req.body?.heatId,
    idempotencyKey,
    by: req.body?.by,
    note: req.body?.note
  });
  return result.data;
}));

// Receive a new ferroalloy batch (same flow as other lot types, surfaced separately for clarity)
router.post('/additives/receive', wrap((req) => {
  const b = req.body || {};
  b.materialType = 'FERROALLOY';
  if (!b.alloyName) throw bad(400, 'alloyName is required');
  if (!(Number(b.receivedKg) > 0)) throw bad(400, 'receivedKg must be positive');
  const declared = {};
  Object.entries(b.declared || {}).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined) declared[k] = Number(v); });
  const prId = b.prId ? String(b.prId).trim().toUpperCase() : null;
  if (prId) purchaseRequests.checkReceivable(prId, { materialType: 'FERROALLOY', alloyName: b.alloyName });
  const lot = store.addLot({ ...b, declared, receivedKg: Number(b.receivedKg) }, b.receivedBy || 'stores');
  const pr = prId ? purchaseRequests.receive(prId, { lotId: lot.lotId, by: b.receivedBy || 'stores' }) : null;
  return { ...store.view(lot), prId: pr?.prId || null };
}));

// ================================================================ DRI QA
router.post('/lots/:lotId/dri-qa', wrap((req) => driQa.enter(req.params.lotId, req.body || {})));
router.get('/dri-qa', wrap((req) => store.qa.list(req.query.lotId)));
router.post('/dri-qa/:qaId/approve', wrap((req) => driQa.approve(req.params.qaId, req.body || {})));
router.post('/dri-qa/:qaId/reject', wrap((req) => driQa.reject(req.params.qaId, req.body || {})));

// ================================================================ handheld gun
router.get('/gun/status', wrap(() => gunService.status()));
router.post('/gun/connect', wrap(async () => {
  const r = await gunService.connect();
  if (!r.success) throw bad(503, r.error);
  return gunService.status();
}));
router.post('/gun/disconnect', wrap(async () => { await gunService.disconnect(); return gunService.status(); }));
router.post('/gun/inspect', wrap((req) => gunService.startInspection(req.body || {})));
router.get('/gun/live', wrap(() => gunService.status().live));
router.post('/gun/argon/replace', wrap(() => ({ argonRemaining: gunService.replaceArgon() })));
router.get('/gun/scenarios', wrap(() => Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label }))));
router.get('/gun/sessions', wrap((req) => store.sessions.list(req.query.lotId).map(sessionSummary)));
router.get('/gun/sessions/:sessionId', wrap((req) => {
  const s = store.sessions.get(req.params.sessionId);
  if (!s) throw bad(404, 'Session not found');
  const { csv, ...rest } = s;
  return rest;
}));
router.get('/gun/sessions/:sessionId/csv', (req, res) => {
  const s = store.sessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ status: 'fail', message: 'Session not found' });
  res.type('text/csv').attachment(`${s.sessionId}.csv`).send(s.csv);
});
// Real gun export (or any CSV in the same format): text/csv body, or JSON { csv, inspector }
router.post('/gun/ingest-csv', express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }), wrap((req) => {
  const csv = typeof req.body === 'string' ? req.body : req.body?.csv;
  if (!csv) throw bad(400, 'Send the CSV as text/csv, or JSON { "csv": "..." }');
  const s = ingestCsv(csv, { inspector: req.query.inspector || req.body?.inspector, via: 'CSV_UPLOAD' });
  return sessionSummary(s);
}));

// ================================================================ heats + gate
const heatView = (h) => {
  const { gate: g, ...rest } = h;
  return {
    ...rest,
    chargeKg: h.charge.reduce((s, l) => s + Number(l.kg), 0),
    gate: g ? { gateId: g.gateId, at: g.at, decision: g.decision, headline: g.headline, validUntil: g.validUntil, stale: h.status === 'PLANNED' && g.fingerprint !== gate.fingerprint(h) } : null,
  };
};

function validateCharge(charge) {
  if (!Array.isArray(charge)) throw bad(400, 'charge must be an array of { lotId, kg }');
  const seen = new Set();
  return charge.map((l) => {
    const kg = Number(l.kg);
    if (!l.lotId || !store.getLot(l.lotId)) throw bad(400, `Unknown lot ${l.lotId}`);
    if (!(kg > 0)) throw bad(400, `${l.lotId}: kg must be positive`);
    if (seen.has(l.lotId)) throw bad(400, `${l.lotId} appears twice — merge the lines`);
    seen.add(l.lotId);
    return { lotId: l.lotId, kg: Math.round(kg * 10) / 10 };
  });
}

router.get('/heats', wrap((req) => store.heats.list().filter((h) => req.query.all === '1' || !h.history).map(heatView)));
router.post('/heats', wrap((req) => {
  const b = req.body || {};
  if (!b.grade || !gate.specFor(b.grade)) throw bad(400, 'A known grade is required');
  if (!(Number(b.targetKg) > 0)) throw bad(400, 'targetKg must be positive');
  const heat = store.heats.add({
    grade: b.grade.toUpperCase(), targetKg: Number(b.targetKg), charge: validateCharge(b.charge || []),
    status: 'PLANNED', plannedBy: b.plannedBy || 'operator', createdAt: new Date(), gate: null, gateHistory: [],
  });
  store.log('HEAT_PLANNED', heat.heatId, heat.plannedBy, `${heat.grade}, ${heat.targetKg} kg`);
  return heatView(heat);
}));
router.get('/heats/:heatId', wrap((req) => {
  const h = store.heats.get(req.params.heatId);
  if (!h) throw bad(404, 'Heat not found');
  return { ...heatView(h), gateResult: h.gate };
}));
router.put('/heats/:heatId/charge', wrap((req) => {
  const h = store.heats.get(req.params.heatId);
  if (!h) throw bad(404, 'Heat not found');
  if (h.status !== 'PLANNED') throw bad(409, `Heat is ${h.status}; the charge can no longer change`);
  h.charge = validateCharge(req.body?.charge || []);
  if (req.body?.targetKg) h.targetKg = Number(req.body.targetKg);
  if (req.body?.grade) {
    if (!gate.specFor(req.body.grade)) throw bad(400, 'Unknown grade');
    h.grade = req.body.grade.toUpperCase();
  }
  store.heats.update(req.params.heatId, { charge: h.charge, targetKg: h.targetKg, grade: h.grade });
  return { ...heatView(store.heats.get(req.params.heatId)), gateResult: h.gate };
}));
router.post('/heats/:heatId/gate-check', wrap((req) => gate.runGate(req.params.heatId, req.body || {})));
router.post('/heats/:heatId/start-melting', wrap((req) => heatView(gate.startMelting(req.params.heatId, req.body || {}))));

// ================================================================ misc
router.get('/config', wrap(() => ({
  settings: config.settings,
  gradeSpecs: config.GRADE_SPECS,
  residualLimits: config.RESIDUAL_LIMITS,
  materialTypes: config.MATERIAL_TYPES,
  sourceTrust: config.SOURCE_REL_SIGMA,
  meltRecovery: config.MELT_RECOVERY,
})));
router.patch('/config', wrap((req) => {
  const s = config.settings;
  Object.entries(req.body || {}).forEach(([k, v]) => {
    if (typeof s[k] === 'number' && typeof v === 'number') s[k] = v;
    if (typeof s[k] === 'boolean' && typeof v === 'boolean') s[k] = v;
  });
  return s;
}));
router.get('/audit', wrap((req) => store.audit().slice(0, Number(req.query.limit) || 100)));
router.post('/demo/reset', wrap(() => {
  if (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEMO_RESET !== 'true') {
    throw bad(403, 'Demo reset is disabled in production or without ENABLE_DEMO_RESET=true');
  }
  store.seed(true);
  seedInspections();
  return { reset: true };
}));

module.exports = { router, gunService };
