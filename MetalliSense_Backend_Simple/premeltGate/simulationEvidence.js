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
  if (Date.parse(chemistry.created_at) <= Date.parse(approval.consumed_at)) throw fail('A subsequent simulated sample is required after correction deduction');
  const lab = db.prepare(`SELECT * FROM evidence WHERE heat_id = ? AND is_valid = 1
    AND evidence_type = 'SIMULATED_LAB' AND execution_context = 'SIMULATION' ORDER BY rowid DESC LIMIT 1`).get(heat.heatId);
  if (!lab || Date.parse(lab.created_at) < Date.parse(chemistry.created_at)) throw fail('Final simulated laboratory QA is required after the corrected sample');
  return { chemistry, lab, approval };
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
  const elementMass = Object.fromEntries(Object.entries(initial).map(([el, pct]) => [el, mass * pct / 100]));
  for (const review of reviews) {
    for (const addition of JSON.parse(review.additions_json)) {
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
  return { composition, basis: 'SAVED_CHARGE_PLUS_CONSUMED_ADDITIONS_V1', initialMassKg: mass, bathMassKg: bathMass,
    consumedApprovalIds: reviews.map(r => r.review_id) };
}

module.exports = { latestChemistry, requireFresh, simulationReleaseEvidence, sampleForHeat };
