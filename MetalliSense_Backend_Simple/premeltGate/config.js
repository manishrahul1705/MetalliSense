/**
 * Pre-Melt Gate — plant-configurable settings.
 *
 * Every number here is an illustrative default for the demo. A real plant
 * sets its own limits; change them via PATCH /api/v2/premelt/config or here.
 */

// Elements the AI models understand (dataset.csv columns).
const CORE_ELEMENTS = ['Fe', 'C', 'Si', 'Mn', 'P', 'S'];
// Tramp / residual elements. Not in the AI models, checked by rules.
// These are what a handheld XRF screens scrap for.
const TRAMP_ELEMENTS = ['Cu', 'Cr', 'Ni', 'Mo', 'Sn'];
const ALL_ELEMENTS = [...CORE_ELEMENTS, ...TRAMP_ELEMENTS];

// Elements a melt shop can raise by adding material (recarburiser, FeSi,
// FeMn). Anything ABOVE its maximum cannot be removed in an induction
// furnace, which does almost no refining — only a different charge fixes it.
const ADDABLE_ELEMENTS = ['C', 'Si', 'Mn'];
// Impurities: only a maximum matters.
const MAX_ONLY_ELEMENTS = ['P', 'S'];

// Grade chemistry limits. Same ranges as MetalliSense_AI/app/data/grades.json,
// which the AI models were trained on. A grade edited on the Grade Specs page
// overrides these. Fe is the balance element and is not checked.
const GRADE_SPECS = {
  'SG-IRON': { C: [3.0, 4.0], Si: [1.8, 2.8], Mn: [0.3, 1.0], P: [0.01, 0.08], S: [0.01, 0.03] },
  'GREY-IRON': { C: [2.5, 3.8], Si: [1.0, 2.5], Mn: [0.4, 1.2], P: [0.02, 0.15], S: [0.02, 0.12] },
  'LOW-CARBON-STEEL': { C: [0.05, 0.25], Si: [0.1, 0.5], Mn: [0.3, 0.9], P: [0.01, 0.04], S: [0.01, 0.05] },
  'MEDIUM-CARBON-STEEL': { C: [0.3, 0.6], Si: [0.15, 0.6], Mn: [0.5, 1.5], P: [0.01, 0.04], S: [0.01, 0.05] },
  'HIGH-CARBON-STEEL': { C: [0.6, 1.4], Si: [0.2, 0.8], Mn: [0.6, 1.8], P: [0.01, 0.04], S: [0.01, 0.05] },
};

// Residual element maximums (%), per grade. Illustrative.
const RESIDUAL_LIMITS = {
  'SG-IRON': { Cu: 0.3, Cr: 0.08, Ni: 0.5, Mo: 0.1, Sn: 0.05 },
  'GREY-IRON': { Cu: 0.6, Cr: 0.3, Ni: 0.5, Mo: 0.2, Sn: 0.1 },
  'LOW-CARBON-STEEL': { Cu: 0.3, Cr: 0.2, Ni: 0.2, Mo: 0.06, Sn: 0.03 },
  'MEDIUM-CARBON-STEEL': { Cu: 0.3, Cr: 0.2, Ni: 0.2, Mo: 0.06, Sn: 0.03 },
  'HIGH-CARBON-STEEL': { Cu: 0.3, Cr: 0.2, Ni: 0.2, Mo: 0.06, Sn: 0.03 },
};

const MATERIAL_TYPES = {
  STEEL_SCRAP: { label: 'Steel scrap', prefix: 'SCR', yield: 0.95, needs: 'GUN', trust: 'DECLARED' },
  CI_SCRAP: { label: 'Cast iron scrap', prefix: 'CIS', yield: 0.93, needs: 'GUN', trust: 'DECLARED' },
  PIG_IRON: { label: 'Pig iron', prefix: 'PIG', yield: 0.97, needs: null, trust: 'CERTIFICATE' },
  DRI: { label: 'Sponge iron (DRI)', prefix: 'DRI', yield: null, needs: 'LAB', trust: 'DECLARED' },
  RETURNS: { label: 'Foundry returns', prefix: 'RET', yield: 0.98, needs: null, trust: 'PARENT_HEAT' },
  FERROALLOY: { label: 'Ferroalloy / additive', prefix: 'ALY', yield: 0.9, needs: null, trust: 'CERTIFICATE' },
};

// How much we trust each chemistry source: 1-sigma as a fraction of the
// value, plus an absolute floor per element. Declared values are weakest;
// lab results and the parent heat's final spectrometer reading are strongest.
const SOURCE_REL_SIGMA = {
  DECLARED: 0.15,
  CERTIFICATE: 0.06,
  LAB: 0.03,
  PARENT_HEAT: 0.03,
};
const ABS_SIGMA_FLOOR = { C: 0.01, Si: 0.01, Mn: 0.01, P: 0.002, S: 0.002, Cu: 0.005, Cr: 0.005, Ni: 0.005, Mo: 0.002, Sn: 0.002 };
// Melting variability that no lot data explains (fraction of predicted value).
const PROCESS_REL_SIGMA = 0.02;

// Element recovery during melting of the base charge (oxidation losses).
// Ferroalloy lots use their own lot yield instead.
const MELT_RECOVERY = { C: 0.96, Si: 0.95, Mn: 0.93, P: 1.0, S: 1.0, Cu: 1.0, Cr: 0.97, Ni: 1.0, Mo: 1.0, Sn: 1.0 };

// Which ferroalloy supplies each addable element, and its recovery.
const ADDITIVE_FOR = {
  C: { alloyName: 'Recarburiser', recovery: 0.9 },
  Si: { alloyName: 'FeSi-75', recovery: 0.9 },
  Mn: { alloyName: 'HC FeMn', recovery: 0.9 },
};

const settings = {
  // Charge weight may differ from the heat's target by this fraction before a warning.
  chargeWeightTolerance: 0.05,
  // A gate result is valid this long; after that the check must be re-run.
  gateValidityMinutes: 30,
  // Warn if the prediction's ±2σ band crosses a spec limit.
  sigmaBand: 2,
  // Residual element at more than this share of its limit -> warning.
  residualWarnShare: 0.8,
  // AI thresholds on P(off-spec heat) AFTER the recommended additions.
  aiHoldRisk: 0.5,
  aiWarnRisk: 0.25,
  // Before-correction risk at or above this means the charge needs additions.
  aiNeedsCorrectionRisk: 0.5,
  aiMinConfidence: 0.5,
  // No AI answer -> HOLD (fail-safe). Set false to downgrade to WARN.
  aiRequired: process.env.PREMELT_AI_REQUIRED !== undefined ? process.env.PREMELT_AI_REQUIRED === 'true' : true,
  aiTimeoutMs: 20000,
  // DRI
  driMaxAgeDays: 7,
  driRules: {
    metallization: { releaseMin: 85, quarantineBelow: 80, restrictedMaxShare: 25 },
    P: { releaseMax: 0.05, quarantineAbove: 0.08, restrictedMaxShare: 25 },
    S: { releaseMax: 0.03, quarantineAbove: 0.05, restrictedMaxShare: 30 },
    wetMoisturePct: 1.0,
  },
  // Handheld gun (per-piece limits and lot rules)
  gun: {
    pieceCuLimit: 0.5,
    stainlessCrMin: 10,
    alloyCrMin: 0.5,
    alloyMoMin: 0.15,
    alloyNiMin: 0.5,
    minReliableShare: 0.7,
    cuQuarantineShare: 0.1,
    cuRestrictedMaxShare: 20,
    alloyQuarantineShare: 0.2,
    alloyRestrictedMaxShare: 25,
    defaultPieces: 15,
    argonTestsPerCanister: 150,
  },
  // Override of a HOLD needs a written reason at least this long.
  overrideReasonMinLength: 20,
};

module.exports = {
  CORE_ELEMENTS,
  TRAMP_ELEMENTS,
  ALL_ELEMENTS,
  ADDABLE_ELEMENTS,
  MAX_ONLY_ELEMENTS,
  GRADE_SPECS,
  RESIDUAL_LIMITS,
  MATERIAL_TYPES,
  SOURCE_REL_SIGMA,
  ABS_SIGMA_FLOOR,
  PROCESS_REL_SIGMA,
  MELT_RECOVERY,
  ADDITIVE_FOR,
  settings,
};
