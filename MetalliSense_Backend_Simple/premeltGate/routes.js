/**
 * /api/v2/premelt — Raw material stock, alloy additives, DRI QA,
 * handheld gun inspections, heat planning and the Pre-Melt Gate.
 * Secured with server-owned identities, least-privilege RBAC, and trusted evidence provenance.
 */
const crypto = require('crypto');
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
const { getDb } = require('./db');
const sec = require('./security');
const { requireAuth, requireHuman, requireRole } = require('./authMiddleware');
const { evaluateCorrectionFeasibility, computeCandidateHash } = require('./correctionFeasibility');

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
const bad = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

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

router.post('/lots', requireAuth, requireRole('INVENTORY_CONTROLLER', 'ADMIN'), wrap((req) => {
  const b = req.body || {};
  if (!config.MATERIAL_TYPES[b.materialType]) throw bad(400, `materialType must be one of ${Object.keys(config.MATERIAL_TYPES).join(', ')}`);
  if (!(Number(b.receivedKg) > 0)) throw bad(400, 'receivedKg must be a positive number');
  if (b.materialType === 'FERROALLOY' && !b.alloyName) throw bad(400, 'alloyName is required for ferroalloys (e.g. FeSi-75, HC FeMn, Recarburiser)');
  if (b.demoScenario && !SCENARIOS[b.demoScenario]) throw bad(400, `demoScenario must be one of ${Object.keys(SCENARIOS).join(', ')}`);
  
  const prId = b.prId ? String(b.prId).trim().toUpperCase() : null;
  if (prId) purchaseRequests.checkReceivable(prId, { materialType: b.materialType, alloyName: b.alloyName });
  const declared = {};
  Object.entries(b.declared || {}).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined) declared[k] = Number(v); });
  
  // Server-owned attribution
  const receiver = req.actor ? (req.actor.displayName || req.actor.id) : (b.receivedBy || 'stores');
  const lot = store.addLot({ ...b, declared, receivedKg: Number(b.receivedKg) }, receiver);
  
  const supplierGrade = scorecard.gradeForLot(lot);
  if (supplierGrade?.grade === 'D') lot.flags = [...(lot.flags || []), 'SUPPLIER_GRADE_D'];
  const pr = prId ? purchaseRequests.receive(prId, { lotId: lot.lotId, by: receiver }) : null;
  return { ...store.view(lot), supplierGrade, prId: pr?.prId || null };
}));

router.patch('/lots/:lotId/status', requireAuth, requireRole('QUALITY_MANAGER', 'ADMIN'), wrap((req) => {
  const lot = store.getLot(req.params.lotId);
  if (!lot) throw bad(404, `Lot ${req.params.lotId} not found`);
  const { status, reason, maxSharePct } = req.body || {};
  const allowed = ['RELEASED', 'RESTRICTED', 'QUARANTINED', 'REJECTED'];
  if (!allowed.includes(status)) throw bad(400, `status must be one of ${allowed.join(', ')}`);
  if (!reason || reason.trim().length < 10) throw bad(400, 'A manual QA decision needs a reason (10+ characters)');
  if (lot.status === 'CONSUMED') throw bad(409, 'Lot is consumed');
  if (status === 'RELEASED' && lot.materialType === 'DRI' && lot.chemistrySource !== 'LAB') throw bad(409, 'Sponge iron can only be released through an approved lab result');

  const actorName = req.actor ? (req.actor.displayName || req.actor.id) : (req.body.by || 'QA Engineer');

  const supplierGrade = scorecard.gradeForLot(lot);
  if (['RELEASED', 'RESTRICTED'].includes(status) && supplierGrade?.grade === 'D' && !req.body.managerApproval) {
    throw bad(403, `${lot.supplier} is a grade D supplier (score ${supplierGrade.score}). Releasing this lot needs a manager's approval — tick "Manager approval" and give the manager's name.`);
  }
  if (req.body.managerApproval) lot.flags = (lot.flags || []).filter((f) => f !== 'MANAGER_APPROVAL_REQUIRED');
  store.setStatus(lot, status, `${req.body.managerApproval ? 'Manager approval' : 'Manual QA decision'} by ${actorName}: ${reason.trim()}`, actorName, {
    restriction: status === 'RESTRICTED' ? { maxSharePct: Number(maxSharePct) || 20 } : null,
    decidedBy: 'MANUAL',
  });
  return store.view(lot);
}));

router.post('/lots/:lotId/adjust', requireAuth, requireRole('INVENTORY_CONTROLLER', 'ADMIN'), wrap((req) => {
  const lot = store.getLot(req.params.lotId);
  if (!lot) throw bad(404, `Lot ${req.params.lotId} not found`);
  const kg = Number(req.body?.kg);
  if (!Number.isFinite(kg) || kg === 0) throw bad(400, 'kg must be a non-zero number (negative to remove)');
  if (!req.body?.reason) throw bad(400, 'reason is required');
  if (store.availableKg(lot.lotId) + kg < 0) throw bad(400, 'Adjustment would make stock negative');
  
  const actorName = req.actor ? (req.actor.displayName || req.actor.id) : (req.body?.by || 'stores');
  store.addMovement({ lotId: lot.lotId, type: 'ADJUST', kg, by: actorName, note: req.body.reason });
  return store.view(lot);
}));

router.get('/movements', wrap((req) => store.listMovements(req.query.lotId).slice(0, Number(req.query.limit) || 200)));
router.get('/additives', wrap(() => additives.inventory()));

// Deduct additive stock atomically with idempotency and schema validation
router.post('/additives/deduct', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'INVENTORY_CONTROLLER', 'ADMIN'), wrap((req) => {
  const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotencyKey;
  const actorName = req.actor ? (req.actor.displayName || req.actor.id) : (req.body?.by || 'operator');
  const result = inventoryLedger.deductAdditivesAtomic({
    lines: req.body?.lines,
    heatId: req.body?.heatId,
    idempotencyKey,
    by: actorName,
    note: req.body?.note,
    candidateId: req.body?.candidateId,
    candidateHash: req.body?.candidateHash,
    requireApproval: true
  });
  return result.data;
}));

// ================================================================ Correction Feasibility & Approval
router.post('/corrections/evaluate', requireAuth, wrap((req) => {
  const { heatId, additions, targetGrade } = req.body || {};
  if (!heatId) throw bad(400, 'heatId is required');
  const heat = store.heats.get(heatId);
  if (!heat) throw bad(404, `Heat ${heatId} not found`);

  const db = getDb();
  const latestEv = db.prepare(`
    SELECT * FROM evidence 
    WHERE heat_id = ? AND evidence_type IN ('MELT_MEASURED', 'POST_CORRECTION_MEASURED')
    ORDER BY rowid DESC LIMIT 1
  `).get(heatId);

  const initialChem = latestEv ? JSON.parse(latestEv.values_json) : (heat.meltdown_chemistry || {});
  const grade = targetGrade || heat.grade;
  const heatMass = heat.targetKg || 1000;

  return evaluateCorrectionFeasibility({
    heatMassKg: heatMass,
    initialChemistry: initialChem,
    additions: additions || [],
    targetGrade: grade
  });
}));

router.post('/corrections/approve', requireAuth, requireRole('METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'), wrap((req) => {
  const { heatId, candidateId, candidateHash, expectedHeatVersion, evidenceVersion, specVersion, additions } = req.body || {};
  if (!heatId) throw bad(400, 'heatId is required');
  if (!candidateId || !candidateHash) throw bad(400, 'candidateId and candidateHash are required');
  if (expectedHeatVersion === undefined || expectedHeatVersion === null) throw bad(400, 'expectedHeatVersion is required');

  const db = getDb();
  const heat = db.prepare('SELECT * FROM heats WHERE heat_id = ?').get(heatId);
  if (!heat) throw bad(404, `Heat ${heatId} not found`);

  // 1. Verify heat version has not advanced (Reject stale approvals)
  if (Number(expectedHeatVersion) !== Number(heat.version)) {
    throw bad(409, `STALE_APPROVAL: Heat version advanced from v${expectedHeatVersion} to v${heat.version}. Re-evaluation required.`, {
      code: 'STALE_APPROVAL_HEAT_VERSION',
      currentVersion: heat.version,
      expectedVersion: expectedHeatVersion
    });
  }

  // 2. Verify chemistry evidence version matches (Reject if new evidence arrived)
  const latestEv = db.prepare(`
    SELECT * FROM evidence 
    WHERE heat_id = ? AND evidence_type IN ('MELT_MEASURED', 'POST_CORRECTION_MEASURED')
    ORDER BY rowid DESC LIMIT 1
  `).get(heatId);

  if (evidenceVersion && latestEv && latestEv.sample_id !== evidenceVersion) {
    throw bad(409, `STALE_APPROVAL: Newer chemistry evidence (${latestEv.sample_id}) exists for heat ${heatId} than candidate evidence (${evidenceVersion}). Re-evaluation required.`, {
      code: 'STALE_APPROVAL_EVIDENCE',
      currentEvidence: latestEv.sample_id,
      expectedEvidence: evidenceVersion
    });
  }

  // 3. Verify specification version
  if (specVersion && specVersion !== '1.0') {
    throw bad(409, `STALE_APPROVAL: Specification version mismatch (${specVersion} vs 1.0).`, {
      code: 'STALE_APPROVAL_SPEC'
    });
  }

  // 4. Verify candidate hash integrity (Reject changed candidates)
  if (additions && Array.isArray(additions)) {
    const computedHash = computeCandidateHash(additions, heat.grade, specVersion || '1.0');
    if (computedHash !== candidateHash) {
      throw bad(409, `APPROVAL_REJECTED: Candidate additions payload changed from approved hash (${candidateHash.slice(0, 8)} vs ${computedHash.slice(0, 8)}).`, {
        code: 'CHANGED_CANDIDATE_PAYLOAD'
      });
    }
  }

  // 5. Maker-checker separation: approver cannot be the heat planner or candidate maker
  const approverId = req.user ? (req.user.userId || req.user.username) : 'UNKNOWN';
  const approverUsername = req.user?.username || approverId;
  const effectiveMakerId = req.body?.makerId || heat.planned_by || 'SYSTEM';
  if (
    effectiveMakerId &&
    (effectiveMakerId.toLowerCase() === approverId.toLowerCase() ||
     effectiveMakerId.toLowerCase() === approverUsername.toLowerCase())
  ) {
    throw bad(403, 'Maker-checker violation: Heat planner or candidate maker cannot approve their own alloy correction candidate', {
      code: 'MAKER_CHECKER_VIOLATION'
    });
  }

  // 6. Record maker-checker approval review bound to exact versions
  const reviewId = sec.recordMakerCheckerReview({
    entityType: 'ALLOY_CORRECTION',
    entityId: heatId,
    entityVersion: expectedHeatVersion,
    makerId: effectiveMakerId,
    checkerId: approverId,
    decision: 'APPROVED',
    reason: `Approved candidate ${candidateId} (hash ${candidateHash.slice(0, 8)}) for heat ${heatId} v${expectedHeatVersion} with evidence ${evidenceVersion || 'NONE'}`,
    candidateHash,
    candidateId,
    additions,
    evidenceVersion: evidenceVersion || latestEv?.sample_id || null,
    specVersion: specVersion || '1.0'
  });

  return {
    approvalId: reviewId,
    status: 'APPROVED',
    heatId,
    candidateId,
    candidateHash,
    boundVersions: {
      heatVersion: expectedHeatVersion,
      evidenceVersion: evidenceVersion || latestEv?.sample_id || null,
      specVersion: specVersion || '1.0'
    },
    approvedBy: approverId,
    approvedAt: new Date().toISOString()
  };
}));

// Receive a new ferroalloy batch
router.post('/additives/receive', requireAuth, requireRole('INVENTORY_CONTROLLER', 'ADMIN'), wrap((req) => {
  const b = req.body || {};
  b.materialType = 'FERROALLOY';
  if (!b.alloyName) throw bad(400, 'alloyName is required');
  if (!(Number(b.receivedKg) > 0)) throw bad(400, 'receivedKg must be positive');
  const declared = {};
  Object.entries(b.declared || {}).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined) declared[k] = Number(v); });
  const prId = b.prId ? String(b.prId).trim().toUpperCase() : null;
  if (prId) purchaseRequests.checkReceivable(prId, { materialType: 'FERROALLOY', alloyName: b.alloyName });
  
  const receiver = req.actor ? (req.actor.displayName || req.actor.id) : (b.receivedBy || 'stores');
  const lot = store.addLot({ ...b, declared, receivedKg: Number(b.receivedKg) }, receiver);
  const pr = prId ? purchaseRequests.receive(prId, { lotId: lot.lotId, by: receiver }) : null;
  return { ...store.view(lot), prId: pr?.prId || null };
}));

// ================================================================ DRI QA
router.post('/lots/:lotId/dri-qa', requireAuth, requireRole('QUALITY_MANAGER', 'LAB_SERVICE', 'ADMIN'), wrap((req) => driQa.enter(req.params.lotId, req.body || {}, req.user)));
router.get('/dri-qa', wrap((req) => store.qa.list(req.query.lotId)));
router.post('/dri-qa/:qaId/approve', requireAuth, requireRole('QUALITY_MANAGER', 'ADMIN'), wrap((req) => driQa.approve(req.params.qaId, req.body || {}, req.user)));
router.post('/dri-qa/:qaId/reject', requireAuth, requireRole('QUALITY_MANAGER', 'ADMIN'), wrap((req) => driQa.reject(req.params.qaId, req.body || {})));

// ================================================================ handheld gun
router.get('/gun/status', wrap(() => gunService.status()));
router.post('/gun/connect', requireAuth, requireRole('OPERATOR', 'INVENTORY_CONTROLLER', 'ADMIN'), wrap(async () => {
  const r = await gunService.connect();
  if (!r.success) throw bad(503, r.error);
  return gunService.status();
}));
router.post('/gun/disconnect', requireAuth, requireRole('OPERATOR', 'INVENTORY_CONTROLLER', 'ADMIN'), wrap(async () => { await gunService.disconnect(); return gunService.status(); }));
router.post('/gun/inspect', requireAuth, requireRole('OPERATOR', 'INVENTORY_CONTROLLER', 'ADMIN'), wrap((req) => {
  const inspector = req.actor ? (req.actor.displayName || req.actor.id) : (req.body?.inspector || 'Demo inspector');
  return gunService.startInspection({ ...(req.body || {}), inspector });
}));
router.get('/gun/live', wrap(() => gunService.status().live));
router.post('/gun/argon/replace', requireAuth, requireRole('OPERATOR', 'INVENTORY_CONTROLLER', 'ADMIN'), wrap(() => ({ argonRemaining: gunService.replaceArgon() })));
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
router.post('/gun/ingest-csv', requireAuth, requireRole('OPERATOR', 'INVENTORY_CONTROLLER', 'GUN_SERVICE', 'ADMIN'), express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }), wrap((req) => {
  const csv = typeof req.body === 'string' ? req.body : req.body?.csv;
  if (!csv) throw bad(400, 'Send the CSV as text/csv, or JSON { "csv": "..." }');
  const inspector = req.actor ? (req.actor.displayName || req.actor.id) : (req.query.inspector || req.body?.inspector || 'CSV Ingest');
  const s = ingestCsv(csv, { inspector, via: 'CSV_UPLOAD' });
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

router.post('/heats', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), wrap((req) => {
  const b = req.body || {};
  if (!b.grade || !gate.specFor(b.grade)) throw bad(400, 'A known grade is required');
  if (!(Number(b.targetKg) > 0)) throw bad(400, 'targetKg must be positive');
  
  const plannedBy = req.user ? req.user.userId : (b.plannedBy || 'operator');
  const heat = store.heats.add({
    grade: b.grade.toUpperCase(), targetKg: Number(b.targetKg), charge: validateCharge(b.charge || []),
    status: 'PLANNED', plannedBy, createdAt: new Date(), gate: null, gateHistory: [],
  });
  store.log('HEAT_PLANNED', heat.heatId, plannedBy, `${heat.grade}, ${heat.targetKg} kg`);
  return heatView(heat);
}));

router.get('/heats/:heatId', wrap((req) => {
  const h = store.heats.get(req.params.heatId);
  if (!h) throw bad(404, 'Heat not found');
  return { ...heatView(h), gateResult: h.gate };
}));

router.put('/heats/:heatId/charge', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), wrap((req) => {
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

router.post('/heats/:heatId/gate-check', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), wrap((req) => gate.runGate(req.params.heatId, req.body || {})));

router.post('/heats/:heatId/start-melting', requireAuth, requireRole('OPERATOR', 'METALLURGIST', 'ADMIN'), wrap((req) => heatView(gate.startMelting(req.params.heatId, req.body || {}, req.user))));

// ================================================================ Trusted Evidence Ingestion
router.post('/heats/:heatId/evidence', requireAuth, wrap((req) => {
  const { heatId } = req.params;
  const heat = store.heats.get(heatId);
  if (!heat) throw bad(404, `Heat ${heatId} not found`);

  // Immutability interlock: completed or released heats cannot accept subsequent evidence
  if (heat.status === 'COMPLETED' || heat.status === 'RELEASED') {
    throw bad(409, `Cannot ingest evidence for heat in '${heat.status}' status. Physical evidence is immutable once completed or released.`, {
      code: 'HEAT_ALREADY_COMPLETED',
      heatId: heat.heat_id || heatId,
      heatStatus: heat.status
    });
  }

  const b = req.body || {};
  const values = b.values || b.readings;
  const { evidenceType, sampleId, sourceInstrument, units = '%', specVersion = '1.0' } = b;
  if (!evidenceType || !values) {
    throw bad(400, 'evidenceType and values are required');
  }

  // Validate authorized evidence types by caller principal
  if (evidenceType === 'MELT_MEASURED' || evidenceType === 'POST_CORRECTION_MEASURED') {
    if (req.service) {
      if (req.service.serviceType !== 'SPECTROMETER_SERVICE') {
        throw bad(403, `Service ${req.service.serviceType} is not authorized to submit chemistry evidence`);
      }
    } else if (req.user) {
      const allowed = ['METALLURGIST', 'QUALITY_MANAGER', 'ADMIN'];
      if (!(req.user.roles || []).some((r) => allowed.includes(r))) {
        throw bad(403, 'Operator accounts cannot submit measured chemistry evidence', { code: 'FORBIDDEN' });
      }
    }
  } else if (evidenceType === 'LAB_MEASURED') {
    if (req.service) {
      if (req.service.serviceType !== 'LAB_SERVICE') {
        throw bad(403, `Service ${req.service.serviceType} is not authorized to submit mechanical laboratory evidence`);
      }
    } else if (req.user) {
      const allowed = ['QUALITY_MANAGER', 'ADMIN'];
      if (!(req.user.roles || []).some((r) => allowed.includes(r))) {
        throw bad(403, 'Only Quality Manager or authorized Lab Service can submit physical mechanical evidence');
      }
    }
  } else {
    throw bad(422, `Invalid evidence provenance: ${evidenceType} cannot be submitted as physical measured evidence`, {
      code: 'INVALID_EVIDENCE_PROVENANCE'
    });
  }

  const actorId = req.actor ? req.actor.id : 'ANONYMOUS';
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');

  // Duplicate sample check with conflicting payload
  const db = getDb();
  if (sampleId) {
    const existingSample = db.prepare('SELECT * FROM evidence WHERE heat_id = ? AND sample_id = ?').get(heatId, sampleId);
    if (existingSample) {
      if (existingSample.payload_hash && existingSample.payload_hash !== payloadHash) {
        throw bad(409, `Duplicate sample ${sampleId} with conflicting values for heat ${heatId}`, { code: 'SAMPLE_PAYLOAD_CONFLICT' });
      }
      return { evidenceId: existingSample.evidence_id, sampleId, payloadHash, status: 'EXISTING_SAMPLE_RETURNED' };
    }
  }

  const evidenceId = `EV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO evidence (
      evidence_id, heat_id, evidence_type, values_json, source_instrument,
      units, provenance, spec_version, actor, created_at, is_valid,
      sample_id, payload_hash, ingested_by_service
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    evidenceId, heatId, evidenceType, JSON.stringify(values), sourceInstrument || (req.service ? req.service.serviceId : 'MANUAL_ENTRY'),
    units, evidenceType === 'MODEL_ESTIMATE' ? 'MODEL_ESTIMATE' : (req.service ? 'SERVICE_AUTHENTICATED' : 'LAB_OPERATOR_AUTHENTICATED'),
    specVersion, actorId, now, sampleId || null, payloadHash, req.service ? req.service.serviceId : null
  );

  store.log('EVIDENCE_RECORDED', heatId, actorId, `${evidenceType}: sample ${sampleId || 'N/A'}`);
  return { evidenceId, heatId, evidenceType, sampleId, payloadHash, status: 'RECORDED' };
}));

// ================================================================ misc
router.get('/config', wrap(() => ({
  settings: config.settings,
  gradeSpecs: config.GRADE_SPECS,
  residualLimits: config.RESIDUAL_LIMITS,
  materialTypes: config.MATERIAL_TYPES,
  sourceTrust: config.SOURCE_REL_SIGMA,
  meltRecovery: config.MELT_RECOVERY,
})));

router.patch('/config', requireAuth, requireRole('ADMIN', 'METALLURGIST'), wrap((req) => {
  const s = config.settings;
  Object.entries(req.body || {}).forEach(([k, v]) => {
    if (typeof s[k] === 'number' && typeof v === 'number') s[k] = v;
    if (typeof s[k] === 'boolean' && typeof v === 'boolean') s[k] = v;
  });
  return s;
}));

router.get('/audit', wrap((req) => store.audit().slice(0, Number(req.query.limit) || 100)));

// Destructive Demo Reset (Admin only, development only, requires explicit confirmation)
router.post('/demo/reset', requireAuth, requireHuman, requireRole('ADMIN'), wrap(async (req) => {
  if (process.env.NODE_ENV === 'production') {
    throw bad(403, 'Demo reset is permanently disabled in production');
  }
  if (process.env.ENABLE_DEMO_RESET !== 'true') {
    throw bad(403, 'Demo reset is disabled: requires exact ENABLE_DEMO_RESET=true');
  }
  const { adminPassword, confirm } = req.body || {};
  if (confirm !== 'DEMO_RESET_CONFIRM') {
    throw bad(400, 'Confirmation string "DEMO_RESET_CONFIRM" is required to prevent accidental data erasure');
  }
  const user = sec.getUserById(req.user.userId);
  if (!user || !adminPassword || !sec.verifyPassword(adminPassword, user.password_hash)) {
    throw bad(401, 'Admin re-authentication password verification failed');
  }

  sec.logSecurityEvent('DEMO_RESET_ATTEMPT', req.user.userId, 'HUMAN', req.ip, 'Admin initiated demo reset');
  store.seed(true);
  seedInspections();
  sec.logSecurityEvent('DEMO_RESET_COMPLETED', req.user.userId, 'HUMAN', req.ip, 'Demo reset completed');
  return { reset: true, by: req.user.username };
}));

module.exports = { router, gunService };
