// Ported from premeltGate/gateEngine.js; Node adapters removed.
export default function(module, require) {
/**
 * Pre-Melt Gate engine.
 *
 * Runs every check on a planned heat's charge BEFORE the furnace starts,
 * asks the AI service for the off-spec risk, and returns GO / WARN / HOLD.
 * startMelting() is the furnace interlock: it refuses to start unless the
 * latest gate result allows it.
 *
 *   GO   – every check passed
 *   WARN – start allowed after the operator acknowledges the warnings
 *   HOLD – start blocked; only an engineer override with a written reason
 */
const crypto = require('crypto');
const axios = require('axios');
const store = require('./store');
const gradeStore = require('../gradeSpecStore');
const additives = require('./additives');
const energy = require('./energy');
const { predictMeltdown, round } = require('./chemistry');
const {
  GRADE_SPECS, RESIDUAL_LIMITS, ADDABLE_ELEMENTS, MAX_ONLY_ELEMENTS, TRAMP_ELEMENTS, settings,
} = require('./config');

const AGENT_URL = 'http://127.0.0.1:8001';
const SPEC_ELEMENTS = ['C', 'Si', 'Mn', 'P', 'S'];
const SCRAP = ['STEEL_SCRAP', 'CI_SCRAP'];
const RANK = { PASS: 0, SKIP: 0, WARN: 1, FAIL: 2 };
const worst = (items) => items.reduce((w, i) => (RANK[i] > RANK[w] ? i : w), 'PASS');
const pct = (v) => `${Math.round(v * 100)}%`;
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

function specFor(grade) {
  const g = grade.toUpperCase();
  const fromStore = gradeStore.getByName(g);
  if (fromStore && String(fromStore._id).startsWith('custom-')) {
    return { ranges: fromStore.composition_ranges, source: 'Grade Specs page (custom grade)' };
  }
  if (GRADE_SPECS[g]) return { ranges: GRADE_SPECS[g], source: 'Standard grade limits (same as AI training specs)' };
  if (fromStore) return { ranges: fromStore.composition_ranges, source: 'Derived from dataset' };
  return null;
}

function fingerprint(heat) {
  const lines = [...heat.charge].sort((a, b) => a.lotId.localeCompare(b.lotId));
  const lotVersions = lines.map((l) => `${l.lotId}:${store.getLot(l.lotId)?.version ?? 'x'}`);
  const raw = JSON.stringify({ g: heat.grade, t: heat.targetKg, lines, lotVersions });
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function check(id, title, status, summary, details = []) {
  return { id, title, status, summary, details };
}

// ------------------------------------------------------------------ checks
function chargeWeightCheck(heat, totalKg) {
  if (!heat.charge.length || totalKg <= 0) return check('charge_weight', 'Charge weight', 'FAIL', 'The charge is empty');
  const diff = (totalKg - heat.targetKg) / heat.targetKg;
  if (Math.abs(diff) > settings.chargeWeightTolerance) {
    return check('charge_weight', 'Charge weight', 'WARN',
      `Charge ${round(totalKg, 1)} kg is ${diff > 0 ? 'above' : 'below'} the ${heat.targetKg} kg target by ${Math.abs(round(diff * 100, 1))}%`);
  }
  return check('charge_weight', 'Charge weight', 'PASS', `${round(totalKg, 1)} kg against a ${heat.targetKg} kg target`);
}

function lotStatusCheck(lines, totalKg) {
  const details = lines.map(({ lot, kg, lotId }) => {
    if (!lot) return { lotId, status: 'FAIL', text: 'Lot not found' };
    const share = totalKg > 0 ? (kg / totalKg) * 100 : 0;
    const base = `${lot.lotId} (${lot.description}) — ${lot.status}`;
    if (lot.status === 'RELEASED') return { lotId, status: 'PASS', text: `${base}` };
    if (lot.status === 'RESTRICTED') {
      const max = lot.restriction?.maxSharePct ?? 100;
      return share > max
        ? { lotId, status: 'FAIL', text: `${base}: ${round(share, 1)}% of charge exceeds the ${max}% limit (${lot.statusReason})` }
        : { lotId, status: 'WARN', text: `${base}: ${round(share, 1)}% of charge, limit ${max}% (${lot.statusReason})` };
    }
    const why = {
      AWAITING_QA: 'not tested yet',
      PROVISIONAL: 'lab result not approved yet',
      QUARANTINED: 'quarantined',
      REJECTED: 'rejected',
      CONSUMED: 'no stock left',
    }[lot.status] || lot.status;
    return { lotId, status: 'FAIL', text: `${base}: ${why} — ${lot.statusReason}` };
  });
  const st = worst(details.map((d) => d.status));
  const bad = details.filter((d) => d.status === 'FAIL').map((d) => d.lotId);
  return check('lot_status', 'Lot release status', st,
    st === 'PASS' ? 'Every lot is released' : st === 'WARN' ? 'Restricted lots are within their limits' : `Cannot be charged: ${bad.join(', ')} (see details)`, details);
}

function stockCheck(lines) {
  const details = lines.filter((l) => l.lot).map(({ lot, kg }) => {
    const avail = store.availableKg(lot.lotId);
    return kg > avail
      ? { lotId: lot.lotId, status: 'FAIL', text: `${lot.lotId}: need ${kg} kg, only ${avail} kg in stock` }
      : { lotId: lot.lotId, status: 'PASS', text: `${lot.lotId}: ${kg} kg of ${avail} kg available` };
  });
  const st = worst(details.map((d) => d.status));
  return check('stock', 'Stock available', st, st === 'PASS' ? 'Enough stock for every line' : 'Not enough stock for some lines', details);
}

function yardInspectionCheck(lines) {
  const scrap = lines.filter((l) => l.lot && SCRAP.includes(l.lot.materialType));
  if (!scrap.length) return check('yard_inspection', 'Handheld XRF/LIBS inspection', 'SKIP', 'No scrap in this charge');
  const details = scrap.map(({ lot }) => {
    const s = store.sessions.list(lot.lotId)[0];
    if (!s) return { lotId: lot.lotId, status: 'FAIL', text: `${lot.lotId}: never inspected with the handheld gun` };
    const e = s.evidence;
    const text = `${lot.lotId}: ${s.device} ${s.sessionId}, ${e.reliable}/${e.piecesTested} reliable readings, Cu-high ${e.cuHigh}, stainless ${e.stainless}, alloy ${e.alloySteel} → ${s.decision.status}`;
    const status = s.decision.status === 'RELEASED' ? 'PASS' : s.decision.status === 'RESTRICTED' ? 'WARN' : 'FAIL';
    return { lotId: lot.lotId, status, text };
  });
  const st = worst(details.map((d) => d.status));
  const notDone = details.filter((d) => d.status === 'FAIL' && d.text.includes('never inspected')).map((d) => d.lotId);
  const failed = details.filter((d) => d.status === 'FAIL' && !d.text.includes('never inspected')).map((d) => d.lotId);
  const flagged = details.filter((d) => d.status === 'WARN').map((d) => d.lotId);
  const parts = [];
  if (notDone.length) parts.push(`not inspected: ${notDone.join(', ')}`);
  if (failed.length) parts.push(`failed screening: ${failed.join(', ')}`);
  if (flagged.length) parts.push(`flagged pieces: ${flagged.join(', ')}`);
  return check('yard_inspection', 'Handheld XRF/LIBS inspection', st,
    st === 'PASS' ? 'All scrap lots screened clean' : `Scrap ${parts.join('; ')}`, details);
}

function driCheck(lines) {
  const dri = lines.filter((l) => l.lot && l.lot.materialType === 'DRI');
  if (!dri.length) return check('dri_quality', 'Sponge iron lab results', 'SKIP', 'No sponge iron in this charge');
  const details = dri.map(({ lot }) => {
    const qa = store.qa.list(lot.lotId).find((q) => q.status === 'APPROVED');
    if (!qa) return { lotId: lot.lotId, status: 'FAIL', text: `${lot.lotId}: no approved lab result` };
    const ageDays = (Date.now() - new Date(qa.testedAt).getTime()) / 86400000;
    const base = `${lot.lotId}: ${qa.qaId} metallization ${qa.calculated.metallization}%, P ${qa.values.P}%, tested ${round(ageDays, 1)} d ago`;
    if (ageDays > settings.driMaxAgeDays) return { lotId: lot.lotId, status: 'WARN', text: `${base} — older than ${settings.driMaxAgeDays} days, re-oxidation risk: re-test` };
    if (lot.storage?.wet) return { lotId: lot.lotId, status: 'WARN', text: `${base} — moisture ${qa.values.moisture}%: wet DRI re-oxidises, re-test before use` };
    return { lotId: lot.lotId, status: 'PASS', text: base };
  });
  const st = worst(details.map((d) => d.status));
  return check('dri_quality', 'Sponge iron lab results', st, st === 'PASS' ? 'Lab results approved and current' : 'Sponge iron needs attention', details);
}

function specCheck(pred, spec) {
  const k = settings.sigmaBand;
  const details = SPEC_ELEMENTS.filter((el) => spec.ranges[el]).map((el) => {
    const [lo, hi] = spec.ranges[el];
    const v = pred.composition[el];
    const s = pred.sigma[el];
    const band = `${round(v, 3)} ± ${round(k * s, 3)}`;
    const top = pred.sources[el]?.[0];
    const from = top ? ` (${top.sharePct}% from ${top.lotId})` : '';
    const out = { element: el, value: v, sigma: s, min: lo, max: hi };
    if (v > hi) return { ...out, status: 'FAIL', text: `${el} ${band}% is above the ${hi}% maximum${from}. It cannot be removed in an induction furnace — change the charge mix.` };
    if (v < lo && ADDABLE_ELEMENTS.includes(el)) return { ...out, status: 'WARN', text: `${el} ${band}% is below the ${lo}% minimum — needs an addition` };
    if (v + k * s > hi) return { ...out, status: 'WARN', text: `${el} ${band}% could exceed the ${hi}% maximum${from}` };
    if (ADDABLE_ELEMENTS.includes(el) && v - k * s < lo) return { ...out, status: 'WARN', text: `${el} ${band}% could fall below the ${lo}% minimum` };
    if (MAX_ONLY_ELEMENTS.includes(el)) return { ...out, status: 'PASS', text: `${el} ${band}% (max ${hi}%)` };
    return { ...out, status: 'PASS', text: `${el} ${band}% (${lo}–${hi}%)` };
  });
  const st = worst(details.map((d) => d.status));
  const list = (pred) => details.filter(pred).map((d) => `${d.element} ${round(d.value, 3)}%`).join(', ');
  const high = list((d) => d.status === 'FAIL');
  const low = list((d) => d.status === 'WARN' && d.value < d.min);
  const near = list((d) => d.status === 'WARN' && d.value >= d.min);
  const parts = [];
  if (high) parts.push(`above maximum: ${high}`);
  if (low) parts.push(`below minimum (needs addition): ${low}`);
  if (near) parts.push(`close to a limit: ${near}`);
  return check('spec_prediction', 'Predicted melt-down chemistry vs grade', st,
    st === 'PASS' ? 'Every element predicted inside the grade limits' : `${parts.join('; ')}`.replace(/^./, (c) => c.toUpperCase()), details);
}

function residualCheck(pred, grade) {
  const limits = RESIDUAL_LIMITS[grade.toUpperCase()];
  if (!limits) return check('residuals', 'Residual (tramp) elements', 'SKIP', 'No residual limits configured for this grade');
  const details = TRAMP_ELEMENTS.filter((el) => limits[el] !== undefined).map((el) => {
    const v = pred.composition[el];
    const s = pred.sigma[el];
    const lim = limits[el];
    const top = pred.sources[el]?.[0];
    const from = top ? ` (${top.sharePct}% from ${top.lotId})` : '';
    if (v > lim) return { element: el, value: v, max: lim, status: 'FAIL', text: `${el} ${round(v, 3)}% above the ${lim}% limit${from}` };
    if (v > settings.residualWarnShare * lim || v + settings.sigmaBand * s > lim) return { element: el, value: v, max: lim, status: 'WARN', text: `${el} ${round(v, 3)}% close to the ${lim}% limit${from}` };
    return { element: el, value: v, max: lim, status: 'PASS', text: `${el} ${round(v, 3)}% (max ${lim}%)` };
  });
  const st = worst(details.map((d) => d.status));
  return check('residuals', 'Residual (tramp) elements', st,
    st === 'PASS' ? 'Cu, Cr, Ni, Mo, Sn within limits' : st === 'WARN' ? 'Some residuals close to their limit' : 'Residual elements over the limit', details);
}

async function aiCheck(grade, pred) {
  const composition = {};
  const uncertainty = {};
  ['Fe', ...SPEC_ELEMENTS].forEach((el) => { composition[el] = pred.composition[el]; });
  SPEC_ELEMENTS.forEach((el) => { uncertainty[el] = pred.sigma[el]; });

  let ai;
  try {
    const r = await axios.post(`${AGENT_URL}/premelt/assess`, { grade, composition, uncertainty }, { timeout: settings.aiTimeoutMs });
    ai = r.data;
  } catch (e) {
    const reason = e.response?.data?.detail || e.response?.data?.error || e.message;
    const st = settings.aiRequired ? 'FAIL' : 'WARN';
    return {
      ai: null,
      check: check('ai_assessment', 'AI off-spec risk', st,
        `AI assessment unavailable (${reason}).${settings.aiRequired ? ' Fail-safe: furnace start stays locked until the AI service answers or an engineer overrides.' : ''}`),
    };
  }

  const before = ai.before_correction.risk;
  const after = ai.after_correction ? ai.after_correction.risk : before;
  const adds = ai.correction?.recommended_additions || {};
  const addText = Object.entries(adds).map(([el, v]) => `+${round(v, 3)}% ${el}`).join(', ');
    const drivers = (ai.after_correction || ai.before_correction).drivers.filter((d) => (d.impact ?? d.risk_drop_if_normal) > 0.1).slice(0, 2);
  const driverText = drivers.length
    ? ` Main driver${drivers.length > 1 ? 's' : ''}: ${drivers.map((d) => `${d.element} ${round(d.value, 3)}% (normal heats ≈ ${round(d.normal_mean, 3)}%)`).join(', ')}.` : '';

  const details = [
    { status: 'PASS', text: `Risk as charged: ${pct(before)} (range ${pct(ai.before_correction.risk_band_p10_p90[0])}–${pct(ai.before_correction.risk_band_p10_p90[1])})` },
  ];
  if (ai.correction) {
    details.push({ status: 'PASS', text: `Alloy Correction Agent: ${addText || 'no additions'} (confidence ${pct(ai.correction.confidence)})` });
    details.push({ status: 'PASS', text: `Risk after additions: ${pct(after)}` });
  }

  let st;
  let summary;
  if (after >= settings.aiHoldRisk) {
    st = 'FAIL';
    summary = `Off-spec risk stays ${pct(after)} even after the recommended additions.${driverText} Change the charge mix — an induction furnace cannot remove excess elements, and large additions are costly and unreliable.`;
  } else if (after >= settings.aiWarnRisk) {
    st = 'WARN';
    summary = `Off-spec risk ${pct(after)} after additions.${driverText}`;
  } else if (before >= settings.aiNeedsCorrectionRisk && addText) {
    st = 'WARN';
    summary = `Charge needs additions (${addText}). With them, risk drops from ${pct(before)} to ${pct(after)}.`;
  } else {
    st = 'PASS';
    summary = `Off-spec risk ${pct(before)} as charged${addText ? ` (optional trim: ${addText})` : ''}.`;
  }
  if (ai.correction && ai.correction.confidence < settings.aiMinConfidence && st === 'PASS') {
    st = 'WARN';
    summary += ` Alloy recommendation confidence is low (${pct(ai.correction.confidence)}).`;
  }
  return { ai, check: check('ai_assessment', 'AI off-spec risk', st, summary, details) };
}

// ------------------------------------------------------------------ run
async function runGate(heatId, { by } = {}) {
  const heat = store.heats.get(heatId);
  if (!heat) throw err(404, `Heat ${heatId} not found`);
  if (heat.status !== 'PLANNED') throw err(409, `Heat ${heatId} is ${heat.status}; the gate runs before melting`);
  const spec = specFor(heat.grade);
  if (!spec) throw err(400, `No specification for grade ${heat.grade}`);

  const lines = heat.charge.map((l) => ({ lotId: l.lotId, kg: Number(l.kg), lot: store.getLot(l.lotId) }));
  const totalKg = lines.reduce((s, l) => s + l.kg, 0);

  const checks = [
    chargeWeightCheck(heat, totalKg),
    lotStatusCheck(lines, totalKg),
    stockCheck(lines),
    yardInspectionCheck(lines),
    driCheck(lines),
  ];

  const prediction = predictMeltdown(lines.filter((l) => l.lot));
  let ai = null;
  let suggestedAdditions = [];
  if (prediction) {
    checks.push(specCheck(prediction, spec));
    checks.push(residualCheck(prediction, heat.grade));
    const a = await aiCheck(heat.grade, prediction);
    ai = a.ai;
    checks.push(a.check);
    if (ai?.correction?.recommended_additions) {
      const planned = Object.fromEntries(heat.charge.map((l) => [l.lotId, Number(l.kg)]));
      suggestedAdditions = additives.suggest(ai.correction.recommended_additions, prediction.metalKg, planned);
    }
  }

  const statuses = checks.map((c) => c.status);
  const decision = statuses.includes('FAIL') ? 'HOLD' : statuses.includes('WARN') ? 'WARN' : 'GO';
  const blocking = checks.filter((c) => c.status === 'FAIL').map((c) => c.summary);
  const warnings = checks.filter((c) => c.status === 'WARN').map((c) => c.summary);

  const now = new Date();
  const record = {
    gateId: `G-${heatId}-${heat.gateHistory.length + 1}`,
    heatId,
    at: now,
    by: by || 'operator',
    decision,
    headline: decision === 'GO' ? 'All checks passed. The furnace can start.'
      : decision === 'WARN' ? `${warnings.length} warning(s). The operator must acknowledge them before starting.`
        : `${blocking.length} blocking issue(s). Furnace start is locked.`,
    blocking,
    warnings,
    checks,
    spec: { grade: heat.grade, ...spec, residualLimits: RESIDUAL_LIMITS[heat.grade.toUpperCase()] || null },
    prediction,
    ai,
    suggestedAdditions,
    fingerprint: fingerprint(heat),
    validUntil: new Date(now.getTime() + settings.gateValidityMinutes * 60000),
  };
  // Energy this charge will need (and what a HOLD saves) — shown with the decision.
  try { record.energy = energy.gateSnapshot(heat, decision); } catch { record.energy = null; }
  heat.gate = record;
  heat.gateHistory.unshift({ gateId: record.gateId, at: now, decision, by: record.by, blocking: blocking.length, warnings: warnings.length });
  store.log('GATE_CHECK', heatId, record.by, `${decision}${blocking.length ? `: ${blocking[0]}` : ''}`);
  return record;
}

// ------------------------------------------------------------ interlock
function startMelting(heatId, { operator, acknowledgeWarnings, override } = {}) {
  const heat = store.heats.get(heatId);
  if (!heat) throw err(404, `Heat ${heatId} not found`);
  if (heat.status !== 'PLANNED') throw err(409, `Heat ${heatId} is already ${heat.status}`);
  if (!operator) throw err(400, 'Operator name is required to start the furnace');
  const gate = heat.gate;
  if (!gate) throw err(428, 'Run the pre-melt check before starting the furnace');
  if (gate.fingerprint !== fingerprint(heat)) throw err(409, 'The charge or a lot changed since the last check. Run the pre-melt check again.', { code: 'GATE_STALE' });
  if (Date.now() > new Date(gate.validUntil).getTime()) throw err(409, `The check is older than ${settings.gateValidityMinutes} minutes. Run it again.`, { code: 'GATE_EXPIRED' });

  let mode = 'GO';
  if (gate.decision === 'WARN') {
    if (!acknowledgeWarnings) throw err(428, 'Acknowledge the warnings to start', { warnings: gate.warnings });
    mode = 'WARN_ACKNOWLEDGED';
  }
  if (gate.decision === 'HOLD') {
    if (!override) throw err(423, 'Furnace start is locked by the pre-melt gate', { blocking: gate.blocking });
    if (!override.engineer || !override.reason || override.reason.trim().length < settings.overrideReasonMinLength) {
      throw err(400, `Override needs the engineer's name and a reason of at least ${settings.overrideReasonMinLength} characters`);
    }
    mode = 'ENGINEER_OVERRIDE';
  }

  // Re-check stock right before deducting (another heat may have used it).
  heat.charge.forEach((l) => {
    const avail = store.availableKg(l.lotId);
    if (Number(l.kg) > avail) throw err(409, `${l.lotId}: only ${avail} kg left. Run the check again.`);
  });
  heat.charge.forEach((l) => store.addMovement({ lotId: l.lotId, type: 'CHARGE', kg: -Number(l.kg), heatId, by: operator, note: `Charged to ${heatId}` }));

  heat.status = 'MELTING';
  // Freeze the energy prediction at furnace start, so later tariff/factor changes do not rewrite it.
  try { heat.energyAtStart = energy.gateSnapshot(heat, gate.decision); } catch { heat.energyAtStart = null; }
  heat.start = {
    at: new Date(),
    by: operator,
    mode,
    gateId: gate.gateId,
    gateDecision: gate.decision,
    acknowledgedWarnings: mode === 'WARN_ACKNOWLEDGED' ? gate.warnings : [],
    override: mode === 'ENGINEER_OVERRIDE' ? { engineer: override.engineer, reason: override.reason.trim(), blocking: gate.blocking } : null,
  };
  store.log(mode === 'ENGINEER_OVERRIDE' ? 'FURNACE_START_OVERRIDE' : 'FURNACE_START', heatId, operator,
    mode === 'ENGINEER_OVERRIDE' ? `HOLD overridden by ${override.engineer}: ${override.reason.trim()}` : `Started after ${gate.decision}`);
  return heat;
}

module.exports = { runGate, startMelting, specFor, fingerprint };

}
