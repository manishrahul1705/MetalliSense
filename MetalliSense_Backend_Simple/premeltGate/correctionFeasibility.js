/**
 * Metallurgical Combined Additions Feasibility Engine
 *
 * Implements rigorous metallurgical thermodynamics evaluating combined additions:
 * - Heat molten bath mass and initial chemistry
 * - Multi-element additive compositions (e.g. FeSi-75 adds Si, Fe, C, Mn, P, S)
 * - Specific element recovery factors and dissolved mass yield
 * - Dilution effects of total mass increase
 * - Stock limit checks
 * - Bounds checking across ALL target grade elements (C, Si, Mn, P, S, Cr, Ni, Cu, Mo, Mg)
 */
const crypto = require('crypto');
const store = require('./store');
const { GRADE_SPECS, RESIDUAL_LIMITS } = require('./config');

// Standard alloy certified composition defaults (percentage by weight)
const ALLOY_COMPOSITIONS = {
  'FeSi-75': {
    Si: 75.0,
    C: 0.10,
    Mn: 0.30,
    P: 0.030,
    S: 0.010,
    Fe: 24.56
  },
  'Recarburiser': {
    C: 98.5,
    S: 0.40,
    P: 0.010,
    Fe: 0.10,
    Ash: 0.99
  },
  'HC FeMn': {
    Mn: 70.0,
    C: 6.80,
    Si: 1.00,
    P: 0.250,
    S: 0.020,
    Fe: 21.93
  }
};

// Metallurgical recovery factors per element and alloy type
const ALLOY_RECOVERIES = {
  'FeSi-75': {
    Si: 0.85,
    C: 0.85,
    Mn: 0.85,
    P: 1.00,
    S: 1.00,
    Fe: 0.95
  },
  'Recarburiser': {
    C: 0.85,
    S: 0.90,
    P: 1.00,
    Fe: 0.95
  },
  'HC FeMn': {
    Mn: 0.85,
    C: 0.85,
    Si: 0.85,
    P: 1.00,
    S: 1.00,
    Fe: 0.95
  }
};

function round(val, decimals = 3) {
  if (val === null || val === undefined || !Number.isFinite(val)) return val;
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

function computeCandidateHash(additions, targetGrade, specVersion = '1.0') {
  const canonical = additions
    .map((a) => ({
      lotId: String(a.lotId || '').trim(),
      alloyName: String(a.alloyName || '').trim(),
      kg: Number(Number(a.kg).toFixed(3))
    }))
    .sort((a, b) => a.lotId.localeCompare(b.lotId) || a.alloyName.localeCompare(b.alloyName));

  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ grade: targetGrade, specVersion, additions: canonical }))
    .digest('hex');
}

/**
 * Evaluate Combined Additions Feasibility
 *
 * @param {Object} params
 * @param {number} params.heatMassKg - initial molten metal mass in furnace
 * @param {Object} params.initialChemistry - map of element symbol -> % in bath
 * @param {Array}  params.additions - array of { lotId, alloyName, kg }
 * @param {string} params.targetGrade - target specification grade (e.g. 'SG-IRON')
 * @param {Object} [params.options] - additional configuration
 */
function evaluateCorrectionFeasibility({
  heatMassKg,
  initialChemistry,
  additions = [],
  targetGrade = 'SG-IRON',
  options = {}
}) {
  const mass0 = Number(heatMassKg) || 1000;
  const chem0 = { ...(initialChemistry || {}) };
  const g = String(targetGrade || 'SG-IRON').toUpperCase();
  const ranges = GRADE_SPECS[g];

  if (!ranges) {
    throw new Error(`UNKNOWN_SPEC_GRADE: Specification for grade '${targetGrade}' not found`);
  }
  const residualLimits = RESIDUAL_LIMITS[g] || { Cu: 0.3, Cr: 0.08, Ni: 0.5, Mo: 0.1, Sn: 0.05 };

  const stockChecks = [];
  let stockFeasible = true;

  // 1. Stock Limit & Addition Pre-check
  for (const add of additions) {
    const kgReq = Number(add.kg);
    if (!Number.isFinite(kgReq) || kgReq <= 0) {
      return {
        feasible: false,
        reason: 'INVALID_ADDITION_QUANTITY',
        detail: `Addition quantity for ${add.alloyName || add.lotId} must be positive finite number (got ${add.kg})`
      };
    }

    if (add.lotId) {
      const avail = store.availableKg(add.lotId);
      const ok = avail >= kgReq;
      stockChecks.push({
        lotId: add.lotId,
        alloyName: add.alloyName,
        requestedKg: round(kgReq, 2),
        availableKg: round(avail, 2),
        sufficient: ok
      });
      if (!ok) {
        stockFeasible = false;
      }
    }
  }

  if (!stockFeasible) {
    return {
      feasible: false,
      reason: 'INSUFFICIENT_STOCK',
      stockChecks,
      detail: 'One or more required additive lots have insufficient stock for requested addition'
    };
  }

  // 2. Combined Additions Mass and Element Balances
  // Elements to track for SG-Iron and general ferrous metallurgy:
  const trackedElements = ['C', 'Si', 'Mn', 'P', 'S', 'Cr', 'Ni', 'Cu', 'Mo', 'Mg', 'Fe'];

  // Calculate dissolved mass added and element contributions
  let totalDissolvedAddedKg = 0;
  const addedElementKg = {};
  trackedElements.forEach((el) => { addedElementKg[el] = 0; });

  for (const add of additions) {
    const alloy = add.alloyName || 'FeSi-75';
    const declaredComp = ALLOY_COMPOSITIONS[alloy] || {};
    const recoveries = ALLOY_RECOVERIES[alloy] || {};

    let addDissolvedKg = 0;

    for (const el of trackedElements) {
      const pctInAlloy = Number(declaredComp[el]) || 0;
      if (pctInAlloy > 0) {
        const recovery = Number(recoveries[el]) || 0.85;
        const dissolvedElKg = (add.kg * (pctInAlloy / 100)) * recovery;
        addedElementKg[el] += dissolvedElKg;
        addDissolvedKg += dissolvedElKg;
      }
    }
    totalDissolvedAddedKg += addDissolvedKg;
  }

  // Combined final bath mass
  const finalMassKg = mass0 + totalDissolvedAddedKg;
  const predictedChemistry = {};

  // Compute final concentrations under dilution
  for (const el of trackedElements) {
    const initElKg = mass0 * ((Number(chem0[el]) || 0) / 100);
    const finalElKg = initElKg + addedElementKg[el];
    const finalPct = (finalElKg / finalMassKg) * 100;
    predictedChemistry[el] = round(finalPct, 3);
  }

  // 3. Spec Compliance Check Across ALL Grade Bounds
  const outOfSpecElements = [];
  const checkedElements = [];

  for (const [el, bounds] of Object.entries(ranges || {})) {
    checkedElements.push(el);
    const val = predictedChemistry[el] !== undefined ? predictedChemistry[el] : (Number(chem0[el]) || 0);
    const minVal = Array.isArray(bounds) ? bounds[0] : bounds.min;
    const maxVal = Array.isArray(bounds) ? bounds[1] : bounds.max;

    if (minVal !== undefined && val < minVal) {
      outOfSpecElements.push({
        element: el,
        predictedPct: val,
        bound: 'MIN',
        expectedMin: minVal,
        diff: round(val - minVal, 3)
      });
    }

    if (maxVal !== undefined && val > maxVal) {
      outOfSpecElements.push({
        element: el,
        predictedPct: val,
        bound: 'MAX',
        expectedMax: maxVal,
        diff: round(val - maxVal, 3)
      });
    }
  }

  // Also check residual limits if applicable
  for (const [el, maxLimit] of Object.entries(residualLimits)) {
    if (!ranges[el] && maxLimit !== undefined) {
      checkedElements.push(el);
      const val = predictedChemistry[el] !== undefined ? predictedChemistry[el] : (Number(chem0[el]) || 0);
      if (val > maxLimit) {
        outOfSpecElements.push({
          element: el,
          predictedPct: val,
          bound: 'RESIDUAL_MAX',
          expectedMax: maxLimit,
          diff: round(val - maxLimit, 3)
        });
      }
    }
  }

  const gradeBoundsSatisfied = outOfSpecElements.length === 0;
  const candidateHash = computeCandidateHash(additions, targetGrade, options.specVersion || '1.0');

  return {
    feasible: gradeBoundsSatisfied && stockFeasible,
    targetGrade,
    initialMassKg: round(mass0, 1),
    finalMassKg: round(finalMassKg, 2),
    massIncreaseKg: round(totalDissolvedAddedKg, 2),
    initialChemistry: chem0,
    predictedChemistry,
    additions: additions.map((a) => ({
      lotId: a.lotId,
      alloyName: a.alloyName,
      kg: round(a.kg, 2)
    })),
    stockChecks,
    gradeBoundsSatisfied,
    checkedElements: Array.from(new Set(checkedElements)),
    outOfSpecElements,
    candidateHash
  };
}

module.exports = {
  ALLOY_COMPOSITIONS,
  ALLOY_RECOVERIES,
  computeCandidateHash,
  evaluateCorrectionFeasibility
};
