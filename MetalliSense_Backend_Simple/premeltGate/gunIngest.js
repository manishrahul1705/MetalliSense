/**
 * Ingest adapter for handheld XRF/LIBS exports.
 *
 * Accepts the CSV a gun exports (from the simulator via OPC UA, or a real
 * device's file), flags each piece with plant limits, and turns the session
 * into a lot decision.
 *
 * Gun readings are NEVER averaged into lot chemistry: a few surface spots
 * cannot represent a 20-tonne load. They produce evidence and flags —
 * pieces tested, pieces failed, worst reading — which decide whether the
 * lot is RELEASED, RESTRICTED or QUARANTINED.
 */
const { parse } = require('csv-parse/sync');
const store = require('./store');
const { settings } = require('./config');

const ELEMENTS = ['Cu', 'Ni', 'Cr', 'Mo', 'Sn', 'Mn', 'Si', 'C', 'P', 'S'];
const SCRAP_TYPES = ['STEEL_SCRAP', 'CI_SCRAP'];

function num(v) {
  if (v === '' || v === undefined || v === null) return null;
  if (v === 'NA' || String(v).startsWith('<')) return v; // keep device markers
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseCsv(csvText) {
  if (typeof csvText !== 'string' || !csvText.trim()) {
    throw Object.assign(new Error('CSV payload must be a non-empty string'), { status: 400 });
  }
  let records;
  try {
    records = parse(csvText, { columns: true, trim: true, skip_empty_lines: true });
  } catch (err) {
    throw Object.assign(new Error('Malformed CSV format: ' + err.message), { status: 400 });
  }
  return records.map((r) => {
    const values = {};
    ELEMENTS.forEach((el) => { values[el] = num(r[el]); });
    return {
      timestamp: r.timestamp || new Date().toISOString(),
      deviceId: r.device_id || r.deviceId || 'UNKNOWN_GUN',
      deviceType: r.device_type || r.deviceType || 'XRF',
      mode: r.mode || 'Scrap',
      lotId: r.lot_id || r.lotId || r.LOT_ID || null,
      pieceNo: Number(r.piece_no || r.pieceNo || 1),
      surfaceOk: String(r.surface_ok || r.surfaceOk) === '1' || r.surface_ok === true,
      testSeconds: Number(r.test_seconds || r.testSeconds) || null,
      values,
      deviceFlags: r.flags ? String(r.flags).split('|').filter(Boolean) : [],
    };
  });
}

const val = (v) => (typeof v === 'number' ? v : 0);

function flagPiece(reading) {
  const g = settings.gun;
  const v = reading.values;
  const flags = [];
  if (!reading.surfaceOk) return ['SURFACE_UNRELIABLE'];
  const stainless = val(v.Cr) >= g.stainlessCrMin || (val(v.Cr) > 5 && val(v.Ni) > 3);
  if (stainless) flags.push('STAINLESS');
  if (val(v.Cu) > g.pieceCuLimit) flags.push('CU_HIGH');
  if (!stainless && (val(v.Cr) > g.alloyCrMin || val(v.Mo) > g.alloyMoMin || val(v.Ni) > g.alloyNiMin)) flags.push('ALLOY_STEEL');
  return flags;
}

/** Turn a set of flagged readings into evidence + a lot decision. */
function evaluate(readings) {
  const g = settings.gun;
  const n = readings.length;
  const reliable = readings.filter((r) => r.surfaceOk);
  const count = (f) => readings.filter((r) => r.flags.includes(f)).length;
  const cu = count('CU_HIGH');
  const stainless = count('STAINLESS');
  const alloy = count('ALLOY_STEEL');

  const worst = {};
  ELEMENTS.forEach((el) => {
    const nums = reliable.map((r) => r.values[el]).filter((x) => typeof x === 'number');
    if (nums.length) {
      const max = Math.max(...nums);
      worst[el] = { value: max, pieceNo: reliable.find((r) => r.values[el] === max)?.pieceNo };
    }
  });

  const evidence = { piecesTested: n, reliable: reliable.length, cuHigh: cu, stainless, alloySteel: alloy, worst };
  const nr = Math.max(reliable.length, 1);

  let decision;
  if (n === 0) {
    decision = { status: 'AWAITING_QA', reason: 'No readings in session' };
  } else if (reliable.length / n < g.minReliableShare) {
    decision = { status: 'AWAITING_QA', reason: `Inconclusive: only ${reliable.length}/${n} readings reliable (paint/oil/rust). Clean or grind and re-test.`, retest: true };
  } else if (stainless > 0) {
    decision = { status: 'QUARANTINED', reason: `${stainless} stainless piece(s) found — segregate the load before use` };
  } else if (alloy / nr >= g.alloyQuarantineShare) {
    decision = { status: 'QUARANTINED', reason: `Wrong grade: ${alloy}/${nr} pieces are alloy steel (Cr/Mo/Ni)` };
  } else if (cu / nr >= g.cuQuarantineShare) {
    decision = { status: 'QUARANTINED', reason: `Copper contamination: ${cu}/${nr} pieces above ${g.pieceCuLimit}% Cu` };
  } else if (cu > 0) {
    decision = { status: 'RESTRICTED', reason: `${cu}/${nr} copper-bearing piece(s) — pick out visible copper, limit share`, restriction: { maxSharePct: g.cuRestrictedMaxShare } };
  } else if (alloy > 0) {
    decision = { status: 'RESTRICTED', reason: `${alloy}/${nr} alloy-steel piece(s) — limit share`, restriction: { maxSharePct: g.alloyRestrictedMaxShare } };
  } else {
    decision = { status: 'RELEASED', reason: `${reliable.length} pieces tested, none flagged` };
  }
  return { evidence, decision };
}

/**
 * Store a session from CSV text and apply the decision to the lot.
 * meta: { inspector, via: 'OPC_UA_SIMULATOR'|'CSV_UPLOAD', sessionId?, loadLabel? }
 */
// Loaded lazily: the scorecard needs the store, which is still loading when this file is first required.
function supplierGradeD(lot) {
  const g = require('./supplierScorecard').gradeForLot(lot);
  return g && g.grade === 'D' ? g : null;
}

function ingestCsv(csvText, meta = {}) {
  const readings = parseCsv(csvText).map((r) => ({ ...r, flags: flagPiece(r) }));
  if (!readings.length) throw Object.assign(new Error('CSV contains no readings'), { status: 400 });

  const lotIds = [...new Set(readings.map((r) => r.lotId).filter(Boolean))];
  if (lotIds.length === 0) throw Object.assign(new Error('CSV must contain a valid lot_id column and non-empty value'), { status: 400 });
  if (lotIds.length > 1) throw Object.assign(new Error('One session must cover exactly one lot'), { status: 400 });
  const lot = store.getLot(lotIds[0]);
  if (!lot) throw Object.assign(new Error(`Lot ${lotIds[0]} not found`), { status: 404 });
  if (!SCRAP_TYPES.includes(lot.materialType)) throw Object.assign(new Error(`${lot.lotId} is ${lot.materialType}; yard gun inspection is for scrap lots`), { status: 400 });

  const { evidence, decision } = evaluate(readings);
  const session = store.sessions.add({
    sessionId: meta.sessionId || store.sessions.nextId(),
    lotId: lot.lotId,
    device: readings[0].deviceType,
    deviceId: readings[0].deviceId,
    inspector: meta.inspector || 'Yard inspector',
    via: meta.via || 'CSV_UPLOAD',
    startedAt: new Date(readings[0].timestamp || Date.now()),
    endedAt: new Date(readings[readings.length - 1].timestamp || Date.now()),
    readings,
    evidence,
    decision,
    csv: csvText,
  });
  lot.sessionIds.push(session.sessionId);

  // Guard against "re-test until it passes": a lot quarantined by the gun
  // stays quarantined until QA releases it by hand with a reason.
  const locked = ['REJECTED', 'CONSUMED'].includes(lot.status) || (lot.status === 'QUARANTINED' && lot.decidedBy === 'GUN');
  if (locked) {
    session.decision.applied = false;
    session.decision.note = `Lot stays ${lot.status}; a manual QA decision is needed to change it.`;
    store.touch(lot);
  } else if (['RELEASED', 'RESTRICTED'].includes(decision.status) && supplierGradeD(lot)) {
    // Grade-D supplier: a passing gun result is not enough — a manager must approve the release.
    const g = supplierGradeD(lot);
    store.setStatus(lot, 'AWAITING_QA', `Gun result ${decision.status}${decision.restriction ? ` (max ${decision.restriction.maxSharePct}%)` : ''}, but ${lot.supplier} is grade D (score ${g.score}) — manager approval needed to release`, session.inspector, { decidedBy: 'GUN' });
    lot.flags = ['MANAGER_APPROVAL_REQUIRED'];
    session.decision.applied = false;
    session.decision.managerApprovalRequired = true;
    session.decision.note = 'Supplier grade D: waiting for manager approval on Raw Material Stock.';
  } else {
    store.setStatus(lot, decision.status, decision.reason, session.inspector, {
      restriction: decision.restriction || null,
      decidedBy: 'GUN',
    });
    lot.flags = decision.retest ? ['RETEST_AFTER_CLEANING'] : [];
    session.decision.applied = true;
  }
  store.log('GUN_SESSION', lot.lotId, session.inspector,
    `${session.sessionId} ${session.device}: ${evidence.piecesTested} pieces, Cu-high ${evidence.cuHigh}, stainless ${evidence.stainless}, alloy ${evidence.alloySteel} → ${decision.status}`);
  return session;
}

module.exports = { ingestCsv, parseCsv, evaluate, flagPiece };
