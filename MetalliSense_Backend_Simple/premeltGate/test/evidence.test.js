const assert = require('assert');
const { evidenceEngine, initTestDb } = require('./testHelper');
const {
  EVIDENCE_TYPES,
  evaluateChemistryStrict,
  evaluateMechanicalStrict
} = evidenceEngine;

async function runTests() {
  const tests = [];
  initTestDb();

  const test = (name, fn) => {
    const t0 = Date.now();
    try {
      fn();
      tests.push({ suite: 'evidenceEngine', test: name, status: 'PASS', duration_ms: Date.now() - t0 });
    } catch (err) {
      tests.push({ suite: 'evidenceEngine', test: name, status: 'FAIL', duration_ms: Date.now() - t0, error: err.message });
    }
  };

  test('TC-EV-001: Reject empty chemistry payload (422)', () => {
    assert.throws(() => {
      evaluateChemistryStrict('SG-IRON', {}, EVIDENCE_TYPES.MELT_MEASURED);
    }, (err) => err.status === 422 && err.message.includes('missing or empty'));
  });

  test('TC-EV-002: Reject partial chemistry missing required elements (422)', () => {
    assert.throws(() => {
      evaluateChemistryStrict('SG-IRON', { C: 3.6, Si: 2.5 }, EVIDENCE_TYPES.MELT_MEASURED);
    }, (err) => err.status === 422 && err.message.includes('Missing required elemental analysis'));
  });

  test('TC-EV-003: Reject non-finite and negative element concentrations (422)', () => {
    assert.throws(() => {
      evaluateChemistryStrict('SG-IRON', { C: -3.5, Si: 2.5, Mn: 0.3, P: 0.03, S: 0.01 }, EVIDENCE_TYPES.MELT_MEASURED);
    }, (err) => err.status === 422 && err.message.includes('Invalid non-finite or out-of-range'));

    assert.throws(() => {
      evaluateChemistryStrict('SG-IRON', { C: NaN, Si: 2.5, Mn: 0.3, P: 0.03, S: 0.01 }, EVIDENCE_TYPES.MELT_MEASURED);
    }, (err) => err.status === 422 && err.message.includes('Invalid non-finite or out-of-range'));
  });

  test('TC-EV-004: Reject predicted-only chemistry for tap/completion', () => {
    assert.throws(() => {
      evaluateChemistryStrict('SG-IRON', { C: 3.6, Si: 2.5, Mn: 0.3, P: 0.03, S: 0.01 }, EVIDENCE_TYPES.CHARGE_PREDICTED);
    }, (err) => err.status === 422 && err.message.includes('cannot satisfy measured chemistry requirement'));
  });

  test('TC-EV-005: Valid measured chemistry within spec returns PASS', () => {
    const res = evaluateChemistryStrict('SG-IRON', { C: 3.6, Si: 2.5, Mn: 0.3, P: 0.03, S: 0.01 }, EVIDENCE_TYPES.MELT_MEASURED);
    assert.strictEqual(res.status, 'PASS');
    assert.strictEqual(res.provenance, EVIDENCE_TYPES.MELT_MEASURED);
    assert.strictEqual(res.pass, true);
  });

  test('TC-EV-006: Measured chemistry with off-spec element returns FAIL', () => {
    // C is 4.5, spec for SG-IRON max is 3.9
    const res = evaluateChemistryStrict('SG-IRON', { C: 4.5, Si: 2.5, Mn: 0.3, P: 0.03, S: 0.01 }, EVIDENCE_TYPES.MELT_MEASURED);
    assert.strictEqual(res.status, 'FAIL');
    assert.strictEqual(res.pass, false);
    assert(res.rows.some((d) => d.element === 'C' && d.pass === false));
  });

  test('TC-EV-007: Mechanical model estimate rejected for physical certification (422)', () => {
    assert.throws(() => {
      evaluateMechanicalStrict('SG-IRON', { uts_mpa: 520, ys_mpa: 340, elongation_pct: 14 }, {}, EVIDENCE_TYPES.MODEL_ESTIMATE);
    }, (err) => err.status === 422 && err.message.includes('empirical model estimate'));
  });

  test('TC-EV-008: Mechanical lab measured within spec returns PASS', () => {
    const standard = { uts_min: 400, elong_min: 15 };
    const res = evaluateMechanicalStrict('SG-IRON', { uts_mpa: 430, ys_mpa: 320, elongation_pct: 16 }, standard, EVIDENCE_TYPES.LAB_MEASURED);
    assert.strictEqual(res.status, 'PASS');
    assert.strictEqual(res.pass, true);
    assert.strictEqual(res.provenance, EVIDENCE_TYPES.LAB_MEASURED);
  });

  test('TC-EV-009: Mechanical lab measured below minimum returns FAIL', () => {
    const standard = { uts_min: 400, elong_min: 15 };
    const res = evaluateMechanicalStrict('SG-IRON', { uts_mpa: 350, ys_mpa: 250, elongation_pct: 8 }, standard, EVIDENCE_TYPES.LAB_MEASURED);
    assert.strictEqual(res.status, 'FAIL');
    assert.strictEqual(res.pass, false);
  });

  return tests;
}

if (require.main === module) {
  runTests().then((results) => {
    console.log(JSON.stringify(results, null, 2));
    const failed = results.filter((r) => r.status === 'FAIL');
    process.exit(failed.length > 0 ? 1 : 0);
  });
}

module.exports = { runTests };
