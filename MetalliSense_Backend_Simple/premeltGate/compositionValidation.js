const ELIGIBLE_EVIDENCE_STATES = new Set([
  'MELTING', 'AWAITING_MEASURED_CHEMISTRY', 'CORRECTION_PENDING',
  'AWAITING_POST_CORRECTION_MEASUREMENT', 'AWAITING_MECHANICAL_EVIDENCE', 'QUALITY_REVIEW'
]);
function validateComposition(values) {
  const invalid = message => { throw Object.assign(new Error(message), { status: 422, code: 'INVALID_COMPOSITION' }); };
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) invalid('Composition must be a non-empty object');
  for (const element of ['C', 'Si', 'Mn', 'P', 'S']) {
    if (!(element in values)) invalid(`Missing required element ${element}`);
  }
  for (const [element, value] of Object.entries(values)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) invalid(`Invalid percentage for ${element}`);
  }
}
module.exports = { validateComposition, ELIGIBLE_EVIDENCE_STATES };
