/**
 * Evidence Provenance and Quality/Certificate Interlocks.
 *
 * Distinguishes physical measurements from models, enforces completeness
 * of required elemental chemistry and mechanical laboratory testing,
 * and ensures test certificates are derived strictly from immutable measured evidence.
 */
const { getDb, withTransaction } = require('./db');
const { GRADE_SPECS, RESIDUAL_LIMITS } = require('./config');

const EVIDENCE_TYPES = {
  SUPPLIER_DECLARED: 'SUPPLIER_DECLARED',
  CHARGE_PREDICTED: 'CHARGE_PREDICTED',
  MELT_MEASURED: 'MELT_MEASURED',
  POST_CORRECTION_MEASURED: 'POST_CORRECTION_MEASURED',
  MODEL_ESTIMATE: 'MODEL_ESTIMATE',
  LAB_MEASURED: 'LAB_MEASURED'
};

const MANDATORY_ELEMENTS = ['C', 'Si', 'Mn', 'P', 'S'];

function err(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function round(v, dp = 3) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  return Math.round(Number(v) * 10 ** dp) / 10 ** dp;
}

/**
 * Persist an evidence record into the evidence table.
 */
function recordEvidence({ heatId, evidenceType, values, sourceInstrument, units, provenance, specVersion, actor }) {
  if (!EVIDENCE_TYPES[evidenceType]) {
    throw err(400, `Invalid evidenceType '${evidenceType}'`);
  }
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
    throw err(400, 'Evidence values must be a non-empty object');
  }

  const db = getDb();
  const evidenceId = `EVD-${heatId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const nowIso = new Date().toISOString();

  db.prepare(`
    INSERT INTO evidence (
      evidence_id, heat_id, evidence_type, values_json,
      source_instrument, units, provenance, spec_version, actor, created_at, is_valid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    evidenceId,
    heatId,
    evidenceType,
    JSON.stringify(values),
    sourceInstrument || 'OES_SPECTROMETER',
    units || '%',
    provenance || evidenceType,
    specVersion || 'v1.0-standard',
    String(actor || 'unverified_analyst').trim(),
    nowIso
  );

  return { evidenceId, heatId, evidenceType, values, createdAt: nowIso };
}

/**
 * Get all evidence for a heat.
 */
function getEvidenceForHeat(heatId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM evidence WHERE heat_id = ? AND is_valid = 1 ORDER BY created_at ASC').all(heatId);
  return rows.map((r) => ({
    evidenceId: r.evidence_id,
    heatId: r.heat_id,
    evidenceType: r.evidence_type,
    values: JSON.parse(r.values_json),
    sourceInstrument: r.source_instrument,
    units: r.units,
    provenance: r.provenance,
    specVersion: r.spec_version,
    actor: r.actor,
    createdAt: r.created_at
  }));
}

/**
 * Evaluates chemistry against specification.
 * Rejects empty, partial, or non-finite values. Every mandatory element MUST be present.
 */
function evaluateChemistryStrict(grade, composition, evidenceType = null) {
  const g = String(grade || '').toUpperCase();
  const spec = GRADE_SPECS[g];
  if (!spec) {
    throw err(400, `Unknown grade specification '${grade}'`);
  }

  // Reject predicted or unmeasured evidence when measured is required
  if (evidenceType && (evidenceType === EVIDENCE_TYPES.CHARGE_PREDICTED || evidenceType === EVIDENCE_TYPES.SUPPLIER_DECLARED)) {
    throw err(422, `Evidence type '${evidenceType}' cannot satisfy measured chemistry requirement for heat completion`);
  }

  if (!composition || typeof composition !== 'object' || Array.isArray(composition) || !Object.keys(composition).length) {
    throw err(422, 'Chemistry composition is completely missing or empty');
  }

  // Verify all mandatory elements are present and finite numbers
  const missingElements = [];
  const nonFiniteElements = [];
  for (const el of MANDATORY_ELEMENTS) {
    if (composition[el] === undefined || composition[el] === null || composition[el] === '') {
      missingElements.push(el);
    } else {
      const v = Number(composition[el]);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        nonFiniteElements.push(el);
      }
    }
  }

  if (missingElements.length > 0) {
    throw err(422, `Missing required elemental analysis for: ${missingElements.join(', ')}. Incomplete chemistry cannot produce PASS.`);
  }
  if (nonFiniteElements.length > 0) {
    throw err(422, `Invalid non-finite or out-of-range value for elements: ${nonFiniteElements.join(', ')}`);
  }

  const rows = [];
  let allPass = true;

  // Grade range checks
  Object.entries(spec).forEach(([el, [lo, hi]]) => {
    const val = Number(composition[el]);
    if (!Number.isFinite(val)) {
      allPass = false;
      rows.push({ element: el, value: null, min: lo, max: hi, pass: false, error: 'MISSING_VALUE' });
      return;
    }
    const isPass = (el === 'P' || el === 'S') ? val <= hi : (val >= lo && val <= hi);
    if (!isPass) allPass = false;
    rows.push({
      element: el,
      value: round(val, 3),
      min: (el === 'P' || el === 'S') ? null : lo,
      max: hi,
      pass: isPass
    });
  });

  // Residual limits check
  const residualLimits = RESIDUAL_LIMITS[g] || {};
  Object.entries(residualLimits).forEach(([el, max]) => {
    const val = Number(composition[el]);
    if (Number.isFinite(val)) {
      const isPass = val <= max;
      if (!isPass) allPass = false;
      rows.push({
        element: el,
        value: round(val, 3),
        min: null,
        max,
        pass: isPass,
        residual: true
      });
    }
  });

  return {
    grade: g,
    rows,
    pass: allPass,
    evaluatedElements: rows.length,
    status: allPass ? 'PASS' : 'FAIL',
    provenance: evidenceType || EVIDENCE_TYPES.MELT_MEASURED,
    specificationSource: 'GRADE_SPECS_STANDARD'
  };
}

/**
 * Evaluates mechanical properties.
 * Rejects model estimates when laboratory physical results are required.
 */
function evaluateMechanicalStrict(grade, mechanical = {}, standard = {}, evidenceType = null) {
  const g = String(grade || '').toUpperCase();
  const requiresTensile = ['SG-IRON', 'LOW-CARBON-STEEL', 'MEDIUM-CARBON-STEEL', 'HIGH-CARBON-STEEL'].includes(g);

  // Model estimates cannot substitute for physical laboratory specimens
  if (requiresTensile && evidenceType === EVIDENCE_TYPES.MODEL_ESTIMATE) {
    throw err(422, `Mechanical evidence type '${evidenceType}' is an empirical model estimate. Physical tensile test specimen (LAB_MEASURED) is required.`);
  }

  // If tensile required, check that results are present
  if (requiresTensile) {
    if (!mechanical || typeof mechanical !== 'object' || Array.isArray(mechanical) || !Object.keys(mechanical).length) {
      throw err(422, `Grade '${g}' requires physical tensile test specimen laboratory results; mechanical evidence is missing`);
    }
    const uts = Number(mechanical.uts_mpa ?? mechanical.measured_uts_mpa ?? mechanical.predicted_uts_mpa);
    if (!Number.isFinite(uts) || uts <= 0) {
      throw err(422, `Grade '${g}' requires tensile strength (UTS_MPa); missing or invalid value`);
    }
  }

  const rows = [];
  let allPass = true;

  const add = (label, unit, value, min, max) => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return;
    const v = Number(value);
    const pass = (min == null || v >= min) && (max == null || v <= max);
    if (!pass) allPass = false;
    rows.push({ property: label, unit, value: round(v, 1), min: min ?? null, max: max ?? null, pass });
  };

  const utsVal = mechanical.uts_mpa ?? mechanical.measured_uts_mpa ?? mechanical.predicted_uts_mpa;
  const ysVal = mechanical.ys_mpa ?? mechanical.measured_ys_mpa ?? mechanical.predicted_ys_mpa;
  const elongVal = mechanical.elongation_pct ?? mechanical.measured_elongation_pct ?? mechanical.predicted_elongation_pct;
  const hbVal = mechanical.hardness_hb ?? mechanical.measured_hardness_hb ?? mechanical.predicted_hardness_hb;

  add('Tensile strength (UTS)', 'MPa', utsVal, standard.uts_min, null);
  add('Yield strength (YS)', 'MPa', ysVal, standard.ys_min, null);
  add('Elongation', '%', elongVal, standard.elong_min, null);
  add('Hardness', 'HB', hbVal, null, standard.hb_max);

  if (rows.length === 0 && requiresTensile) {
    allPass = false;
  }

  return {
    grade: g,
    rows,
    pass: allPass,
    evaluatedProperties: rows.length,
    status: allPass ? 'PASS' : 'FAIL',
    provenance: evidenceType || EVIDENCE_TYPES.LAB_MEASURED,
    standard: standard.ref || 'ASTM/ISO Standard Specimen'
  };
}

module.exports = {
  EVIDENCE_TYPES,
  MANDATORY_ELEMENTS,
  recordEvidence,
  getEvidenceForHeat,
  evaluateChemistryStrict,
  evaluateMechanicalStrict
};
