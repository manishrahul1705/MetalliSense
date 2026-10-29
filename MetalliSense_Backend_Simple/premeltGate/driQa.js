/**
 * Sponge iron (DRI) lab results — entered by hand by the QA engineer on the
 * stock dashboard, approved by a second person (maker–checker).
 *
 * Until approved the lot is PROVISIONAL and the gate will not let it into a
 * heat. Results are never deleted: a correction is a new version.
 */
const store = require('./store');
const { getDb, withTransaction } = require('./db');
const { settings } = require('./config');
const { round } = require('./chemistry');

const FIELDS = ['feTotal', 'feMetallic', 'C', 'S', 'P', 'SiO2', 'Al2O3', 'CaO', 'MgO', 'moisture', 'fines'];
const REQUIRED = ['feTotal', 'feMetallic', 'C', 'S', 'P'];

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

function calculate(v) {
  const metallization = v.feTotal > 0 ? (v.feMetallic / v.feTotal) * 100 : 0;
  return {
    metallization: round(metallization, 2),
    // Carbon in DRI removes remaining oxygen in the furnace, so plants also
    // quote metallization + 5 × C%.
    equivalentMetallization: round(metallization + 5 * v.C, 2),
  };
}

function validate(values, lot) {
  const errors = [];
  REQUIRED.forEach((f) => { if (values[f] === undefined || values[f] === null || Number.isNaN(values[f])) errors.push(`${f} is required`); });
  FIELDS.forEach((f) => { if (values[f] !== undefined && values[f] < 0) errors.push(`${f} cannot be negative`); });
  if (values.feTotal > 100) errors.push('Fe total cannot exceed 100%');
  if (values.feMetallic > values.feTotal) errors.push('Fe metallic cannot exceed Fe total');
  if (values.C > 3) errors.push('C above 3% is not plausible for sponge iron');
  if (values.P > 0.5 || values.S > 0.5) errors.push('P or S above 0.5% is not plausible — check units');
  if (values.moisture > 20) errors.push('Moisture above 20% is not plausible');
  if (values.fines > 100) errors.push('Fines cannot exceed 100%');

  // Soft checks: plausible but unusual — the engineer must confirm.
  const warnings = [];
  const d = lot.declared || {};
  const met = values.feTotal > 0 ? (values.feMetallic / values.feTotal) * 100 : 0;
  const declaredMet = d.feTotal ? (d.feMetallic / d.feTotal) * 100 : null;
  if (declaredMet && Math.abs(met - declaredMet) > 5) warnings.push(`Metallization ${met.toFixed(1)}% differs from supplier's ${declaredMet.toFixed(1)}% by more than 5 points`);
  if (d.feTotal && Math.abs(values.feTotal - d.feTotal) > 3) warnings.push(`Fe total ${values.feTotal}% differs from supplier's ${d.feTotal}% by more than 3 points`);
  if (d.P && values.P > 2 * d.P) warnings.push(`P ${values.P}% is more than twice the supplier's ${d.P}%`);
  if (met < 70) warnings.push(`Metallization ${met.toFixed(1)}% is unusually low`);
  return { errors, warnings };
}

function releaseDecision(values, calc) {
  const r = settings.driRules;
  const reasons = [];
  let status = 'RELEASED';
  let maxShare = null;
  const restrict = (pct, why) => { if (status !== 'QUARANTINED') status = 'RESTRICTED'; maxShare = maxShare === null ? pct : Math.min(maxShare, pct); reasons.push(why); };
  const quarantine = (why) => { status = 'QUARANTINED'; reasons.push(why); };

  const m = calc.metallization;
  if (m < r.metallization.quarantineBelow) quarantine(`metallization ${m}% below ${r.metallization.quarantineBelow}%`);
  else if (m < r.metallization.releaseMin) restrict(r.metallization.restrictedMaxShare, `metallization ${m}% below ${r.metallization.releaseMin}%`);

  if (values.P > r.P.quarantineAbove) quarantine(`P ${values.P}% above ${r.P.quarantineAbove}%`);
  else if (values.P > r.P.releaseMax) restrict(r.P.restrictedMaxShare, `P ${values.P}% above ${r.P.releaseMax}%`);

  if (values.S > r.S.quarantineAbove) quarantine(`S ${values.S}% above ${r.S.quarantineAbove}%`);
  else if (values.S > r.S.releaseMax) restrict(r.S.restrictedMaxShare, `S ${values.S}% above ${r.S.releaseMax}%`);

  const reason = reasons.length
    ? `QA: ${reasons.join('; ')}${status === 'RESTRICTED' ? ` — max ${maxShare}% of charge` : ''}`
    : `QA approved: metallization ${m}%, P ${values.P}%, S ${values.S}%`;
  return { status, reason, restriction: status === 'RESTRICTED' ? { maxSharePct: maxShare } : null };
}

function enter(lotId, body, currentUser = null) {
  return withTransaction(() => enterInTransaction(lotId, body, currentUser));
}

function enterInTransaction(lotId, body, currentUser) {
  const lot = store.getLot(lotId);
  if (!lot) throw err(404, `Lot ${lotId} not found`);
  if (lot.materialType !== 'DRI') throw err(400, 'Lab entry is for sponge iron (DRI) lots');
  if (['CONSUMED', 'REJECTED'].includes(lot.status)) throw err(409, `Lot is ${lot.status}`);
  const analystName = currentUser ? (currentUser.displayName || currentUser.username) : body.analyst;
  if (!analystName) throw err(400, 'Analyst name is required');

  const values = {};
  FIELDS.forEach((f) => { if (body[f] !== undefined && body[f] !== '' && body[f] !== null) values[f] = Number(body[f]); });
  const { errors, warnings } = validate(values, lot);
  if (errors.length) throw err(400, errors.join('; '), { errors });
  if (warnings.length && !body.confirmWarnings) throw err(422, 'Unusual values — confirm to save', { warnings });

  const previous = store.qa.list(lotId);
  const rec = store.qa.add({
    lotId,
    version: previous.length + 1,
    sampleId: body.sampleId || `S-${lotId}-${previous.length + 1}`,
    sampledAt: body.sampledAt ? new Date(body.sampledAt) : new Date(),
    testedAt: body.testedAt ? new Date(body.testedAt) : new Date(),
    values,
    calculated: calculate(values),
    method: body.method || 'Ferric chloride',
    analyst: analystName,
    analystId: currentUser?.userId || null,
    warningsConfirmed: warnings,
    correctionReason: previous.length ? body.correctionReason || 'Re-test' : null,
    status: 'PENDING_APPROVAL',
    enteredAt: new Date(),
  });
  getDb().prepare("UPDATE qa_results SET status = 'SUPERSEDED' WHERE lot_id = ? AND qa_id != ? AND status = 'PENDING_APPROVAL'").run(lotId, rec.qaId);
  lot.qaIds.push(rec.qaId);
  getDb().prepare('UPDATE lots SET qa_ids_json = ? WHERE lot_id = ?').run(JSON.stringify(lot.qaIds), lotId);
  store.setStatus(lot, 'PROVISIONAL', `Lab result ${rec.qaId} entered by ${rec.analyst} — waiting for approval`, rec.analyst);
  store.log('DRI_QA_ENTERED', lotId, rec.analyst, `${rec.qaId} v${rec.version}: metallization ${rec.calculated.metallization}%, P ${values.P}%`);
  return rec;
}

function approve(qaId, body = {}, currentUser = null) {
  return withTransaction(() => approveInTransaction(qaId, body, currentUser));
}

function approveInTransaction(qaId, { approver } = {}, currentUser = null) {
  const rec = store.qa.get(qaId);
  if (!rec) throw err(404, `QA result ${qaId} not found`);
  if (rec.status !== 'PENDING_APPROVAL') throw err(409, `QA result is ${rec.status}`);
  const approverName = currentUser ? (currentUser.displayName || currentUser.username) : approver;
  if (!approverName) throw err(400, 'Approver name is required');
  if (currentUser) {
    const mc = require('./security').checkMakerCheckerSeparation({
      entityType: 'DRI_QA_APPROVAL',
      entityId: qaId,
      checkerUserId: currentUser.userId
    });
    if (!mc.allowed) throw err(403, mc.reason, { code: mc.code });
  }
  if ((approverName || "").trim().toLowerCase() === (rec.analyst || "").trim().toLowerCase()) {
    throw err(403, 'Maker–checker: the approver must be a different person from the analyst', { code: 'MAKER_CHECKER_VIOLATION' });
  }
  const lot = store.getLot(rec.lotId);
  assertLatest(rec);
  getDb().prepare("UPDATE qa_results SET status = 'SUPERSEDED' WHERE lot_id = ? AND status = 'APPROVED'").run(rec.lotId);
  rec.status = 'APPROVED';
  rec.approvedBy = approverName;
  rec.approvedAt = new Date();
  getDb().prepare("UPDATE qa_results SET status = 'APPROVED', approved_by = ?, approved_by_id = ?, approved_at = ? WHERE qa_id = ?").run(approverName, currentUser?.userId || null, rec.approvedAt.toISOString(), qaId);

  lot.tested = { ...(lot.declared || {}), ...rec.values };
  lot.chemistrySource = 'LAB';
  lot.storage = { ...(lot.storage || {}), wet: (rec.values.moisture || 0) > settings.driRules.wetMoisturePct };
  const d = releaseDecision(rec.values, rec.calculated);
  const g = require('./supplierScorecard').gradeForLot(lot);
  if (['RELEASED', 'RESTRICTED'].includes(d.status) && g?.grade === 'D') {
    // Grade-D supplier: a passing lab result still needs a manager's approval.
    store.setStatus(lot, 'AWAITING_QA', `${d.reason} — but ${lot.supplier} is grade D (score ${g.score}): manager approval needed to release`, approverName, { decidedBy: 'QA' });
    lot.flags = ['MANAGER_APPROVAL_REQUIRED'];
  } else {
    store.setStatus(lot, d.status, d.reason, approverName, { restriction: d.restriction, decidedBy: 'QA' });
  }
  getDb().prepare('UPDATE lots SET tested_json = ?, chemistry_source = ?, storage_json = ?, flags_json = ? WHERE lot_id = ?').run(JSON.stringify(lot.tested), 'LAB', JSON.stringify(lot.storage), JSON.stringify(lot.flags), lot.lotId);
  store.log('DRI_QA_APPROVED', lot.lotId, approverName, `${qaId} → ${lot.status}`);
  if (currentUser) {
    require('./security').recordMakerCheckerReview({
        entityType: 'DRI_QA_APPROVAL',
        entityId: qaId,
        entityVersion: rec.version,
        makerId: rec.analystId || rec.analyst || 'LEGACY',
        checkerId: currentUser.userId,
        decision: 'APPROVED',
        reason: d.reason
      });
  }
  return { qa: store.qa.get(qaId), lot: store.view(lot) };
}

function assertLatest(rec) {
  const latest = getDb().prepare('SELECT MAX(version) AS version FROM qa_results WHERE lot_id = ?').get(rec.lotId);
  if (latest.version !== rec.version) throw err(409, 'QA result has been superseded by a newer version');
}

function reject(qaId, body = {}, currentUser = null) {
  return withTransaction(() => rejectInTransaction(qaId, body, currentUser));
}

function rejectInTransaction(qaId, { approver, reason }, currentUser) {
  const rec = store.qa.get(qaId);
  if (!rec) throw err(404, `QA result ${qaId} not found`);
  if (rec.status !== 'PENDING_APPROVAL') throw err(409, `QA result is ${rec.status}`);
  approver = currentUser ? (currentUser.displayName || currentUser.username) : approver;
  if (!approver || !reason) throw err(400, 'Approver and reason are required');
  assertLatest(rec);
  if ((currentUser?.userId && rec.analystId === currentUser.userId) || approver.trim().toLowerCase() === (rec.analyst || '').trim().toLowerCase()) throw err(403, 'Maker-checker: rejection requires an independent checker', { code: 'MAKER_CHECKER_VIOLATION' });
  rec.status = 'REJECTED';
  rec.rejectedBy = approver;
  rec.rejectReason = reason;
  rec.rejectedAt = new Date();
  getDb().prepare("UPDATE qa_results SET status = 'REJECTED', rejected_by = ?, rejected_by_id = ?, rejected_at = ?, reject_reason = ? WHERE qa_id = ?").run(approver, currentUser?.userId || null, rec.rejectedAt.toISOString(), reason, qaId);
  if (currentUser) require('./security').recordMakerCheckerReview({ entityType: 'DRI_QA_APPROVAL', entityId: qaId, entityVersion: rec.version, makerId: rec.analystId || rec.analyst, checkerId: currentUser.userId, decision: 'REJECTED', reason });
  const lot = store.getLot(rec.lotId);
  const approved = store.qa.list(lot.lotId).find((q) => q.status === 'APPROVED');
  if (approved) {
    // Fall back to the last approved result.
    const d = releaseDecision(approved.values, approved.calculated);
    store.setStatus(lot, d.status, `${d.reason} (kept from ${approved.qaId})`, approver, { restriction: d.restriction, decidedBy: 'QA' });
  } else {
    store.setStatus(lot, 'AWAITING_QA', `Lab result rejected by ${approver}: ${reason} — re-test needed`, approver);
  }
  store.log('DRI_QA_REJECTED', lot.lotId, approver, `${qaId}: ${reason}`);
  return { qa: store.qa.get(qaId), lot: store.view(lot) };
}

module.exports = { enter, approve, reject, calculate, releaseDecision, FIELDS };
