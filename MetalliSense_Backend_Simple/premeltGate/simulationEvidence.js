const { getDb } = require('./db');
const { context } = require('./simulationContext');
const fail = message => Object.assign(new Error(message), { status: 422 });

function latestChemistry(heatId, db = getDb()) {
  const types = context(db) === 'SIMULATION'
    ? ['SIMULATED_MEASURED'] : ['MELT_MEASURED', 'POST_CORRECTION_MEASURED'];
  return db.prepare(`SELECT * FROM evidence WHERE heat_id = ? AND is_valid = 1
    AND execution_context = ? AND evidence_type IN (${types.map(() => '?').join(',')})
    ORDER BY rowid DESC LIMIT 1`).get(heatId, context(db), ...types);
}

function requireFresh(row) {
  if (!row || row.units !== '%' || Date.now() - Date.parse(row.created_at) > 15 * 60 * 1000
      || !Number.isFinite(Date.parse(row.created_at)) || Date.parse(row.created_at) > Date.now() + 5000) {
    throw fail('A valid heat-linked composition sample less than 15 minutes old is required');
  }
  require('./compositionValidation').validateComposition(JSON.parse(row.values_json));
  return row;
}

function simulationReleaseEvidence(heat) {
  const db = getDb();
  if (heat.executionContext !== 'SIMULATION' || context(db) !== 'SIMULATION') throw fail('Simulation context mismatch');
  const approval = db.prepare(`SELECT * FROM maker_checker_reviews WHERE entity_type = 'ALLOY_CORRECTION'
    AND entity_id = ? AND decision = 'APPROVED' AND is_consumed = 1 AND execution_context = 'SIMULATION'
    ORDER BY rowid DESC LIMIT 1`).get(heat.heatId);
  if (!approval) throw fail('An independently approved and consumed correction is required before simulation release');
  const chemistry = requireFresh(latestChemistry(heat.heatId, db));
  if (chemistry.heat_version !== heat.version) throw fail('Chemistry is not bound to the current heat version');
  if (Date.parse(chemistry.created_at) <= Date.parse(approval.consumed_at)) throw fail('A subsequent simulated sample is required after correction deduction');
  const lab = db.prepare(`SELECT * FROM evidence WHERE heat_id = ? AND is_valid = 1
    AND evidence_type = 'SIMULATED_LAB' AND execution_context = 'SIMULATION' ORDER BY rowid DESC LIMIT 1`).get(heat.heatId);
  if (!lab || lab.heat_version !== heat.version || lab.parent_evidence_id !== chemistry.evidence_id || Date.parse(lab.created_at) < Date.parse(chemistry.created_at)) throw fail('Final simulated laboratory QA is required for the exact corrected sample and heat version');
  return { chemistry, lab, approval };
}

function operationalReleaseEvidence(heat) {
  const db = getDb();
  if (heat.executionContext !== 'OPERATIONAL' || context(db) !== 'OPERATIONAL') throw fail('Operational context mismatch');
  const chemistry = requireFresh(latestChemistry(heat.heatId, db));
  if (chemistry.heat_version !== heat.version || !chemistry.ingested_by_service || chemistry.provenance !== 'SERVICE_AUTHENTICATED') throw fail('Trusted chemistry bound to the current heat version is required');
  const lab = db.prepare(`SELECT * FROM evidence WHERE heat_id = ? AND is_valid = 1
    AND execution_context = 'OPERATIONAL' AND evidence_type = 'LAB_MEASURED' ORDER BY rowid DESC LIMIT 1`).get(heat.heatId);
  if (!lab || lab.heat_version !== heat.version || lab.parent_evidence_id !== chemistry.evidence_id) throw fail('Persisted physical laboratory evidence bound to the exact chemistry sample is required');
  return { chemistry, lab };
}

// Deterministic well-mixed bath model. Initial chemistry comes from the saved
// charge prediction; subsequent chemistry uses the exact consumed additions.
// This is a simulation assumption, never a physical measurement claim.
function sampleForHeat(heatId) {
  const db = getDb();
  if (context(db) !== 'SIMULATION') return null;
  const heat = require('./store').heats.get(heatId);
  if (!heat || heat.executionContext !== 'SIMULATION' || !heat.start) throw fail('A started simulation heat is required');
  const initial = heat.gate?.prediction?.composition;
  const mass = heat.gate?.prediction?.metalKg;
  if (!initial || !(mass > 0)) throw fail('Saved charge chemistry and bath mass are required');
  const reviews = db.prepare(`SELECT * FROM maker_checker_reviews WHERE entity_type = 'ALLOY_CORRECTION'
    AND entity_id = ? AND is_consumed = 1 ORDER BY rowid ASC`).all(heatId);
  const { ALLOY_COMPOSITIONS, ALLOY_RECOVERIES } = require('./correctionFeasibility');
  let bathMass = mass;
  let deductedAdditiveKg = 0;
  const elementMass = Object.fromEntries(Object.entries(initial).map(([el, pct]) => [el, mass * pct / 100]));
  for (const review of reviews) {
    for (const addition of JSON.parse(review.additions_json)) {
      deductedAdditiveKg += addition.kg;
      const alloy = ALLOY_COMPOSITIONS[addition.alloyName];
      const recovery = ALLOY_RECOVERIES[addition.alloyName];
      if (!alloy || !recovery) throw fail('Unsupported simulation alloy');
      for (const [el, pct] of Object.entries(alloy)) {
        if (el === 'Ash') continue;
        const dissolved = addition.kg * pct / 100 * (recovery[el] ?? 0.85);
        elementMass[el] = (elementMass[el] || 0) + dissolved;
        bathMass += dissolved;
      }
    }
  }
  const composition = Object.fromEntries(Object.entries(elementMass).map(([el, kg]) => [el, Math.round(kg / bathMass * 100000) / 1000]));
  require('./compositionValidation').validateComposition(composition);
  const canonicalKg = v => Math.round(v * 1e6) / 1e6;
  const dissolvedAdditiveKg = canonicalKg(bathMass - mass);
  return { composition, basis: 'SAVED_CHARGE_PLUS_CONSUMED_ADDITIONS_V1', heatVersion: heat.version,
    initialMassKg: mass, bathMassKg: canonicalKg(bathMass), deductedAdditiveKg: canonicalKg(deductedAdditiveKg),
    dissolvedAdditiveKg, unrecoveredAdditiveKg: canonicalKg(deductedAdditiveKg - dissolvedAdditiveKg),
    consumedApprovalIds: reviews.map(r => r.review_id) };
}

module.exports = { latestChemistry, requireFresh, simulationReleaseEvidence, operationalReleaseEvidence, sampleForHeat };
