const assert = require('assert');
const { getDb, store, heatStateMachine, initTestDb } = require('./testHelper');
const { HEAT_STATES, transitionHeat } = heatStateMachine;

async function runTests() {
  const tests = [];
  initTestDb();

  const test = (name, fn) => {
    const t0 = Date.now();
    try {
      fn();
      tests.push({ suite: 'heatStateMachine', test: name, status: 'PASS', duration_ms: Date.now() - t0 });
    } catch (err) {
      tests.push({ suite: 'heatStateMachine', test: name, status: 'FAIL', duration_ms: Date.now() - t0, error: err.message });
    }
  };

  test('TC-SM-001: Valid transition PLANNED -> GATE_EVALUATED -> MELTING', () => {
    const heat = store.heats.add({ grade: 'SG-IRON', targetKg: 1000, charge: [] });
    assert.strictEqual(heat.status, 'PLANNED');
    assert.strictEqual(heat.version, 1);

    const evaluated = transitionHeat(heat.heatId, HEAT_STATES.GATE_EVALUATED, { actor: 'tester' });
    assert.strictEqual(evaluated.status, 'GATE_EVALUATED');
    assert.strictEqual(evaluated.version, 2);

    const melting = transitionHeat(heat.heatId, HEAT_STATES.MELTING, { actor: 'tester' });
    assert.strictEqual(melting.status, 'MELTING');
    assert.strictEqual(melting.version, 3);
  });

  test('TC-SM-002: Transition through full lifecycle to RELEASED', () => {
    const heat = store.heats.add({ grade: 'SG-IRON', targetKg: 1000, charge: [] });
    transitionHeat(heat.heatId, HEAT_STATES.GATE_EVALUATED, { actor: 'tester' });
    transitionHeat(heat.heatId, HEAT_STATES.MELTING, { actor: 'tester' });
    transitionHeat(heat.heatId, HEAT_STATES.AWAITING_MEASURED_CHEMISTRY, { actor: 'tester' });
    transitionHeat(heat.heatId, HEAT_STATES.CORRECTION_PENDING, { actor: 'tester' });
    transitionHeat(heat.heatId, HEAT_STATES.AWAITING_POST_CORRECTION_MEASUREMENT, { actor: 'tester' });
    transitionHeat(heat.heatId, HEAT_STATES.QUALITY_REVIEW, { actor: 'tester' });
    transitionHeat(heat.heatId, HEAT_STATES.COMPLETED, { actor: 'tester' });
    const released = transitionHeat(heat.heatId, HEAT_STATES.RELEASED, { actor: 'metallurgist' });
    assert.strictEqual(released.status, 'RELEASED');
  });

  test('TC-SM-003: Terminal state RELEASED rejects further transitions (409)', () => {
    const heat = store.heats.add({ grade: 'SG-IRON', targetKg: 1000, charge: [] });
    transitionHeat(heat.heatId, HEAT_STATES.GATE_EVALUATED, { actor: 'tester' });
    transitionHeat(heat.heatId, HEAT_STATES.MELTING, { actor: 'tester' });
    transitionHeat(heat.heatId, HEAT_STATES.COMPLETED, { actor: 'tester' });
    transitionHeat(heat.heatId, HEAT_STATES.RELEASED, { actor: 'tester' });

    assert.throws(() => {
      transitionHeat(heat.heatId, HEAT_STATES.PLANNED, { actor: 'tester' });
    }, (err) => err.status === 409 && err.message.includes('terminal state'));
  });

  test('TC-SM-004: Terminal state REJECTED rejects further transitions (409)', () => {
    const heat = store.heats.add({ grade: 'SG-IRON', targetKg: 1000, charge: [] });
    transitionHeat(heat.heatId, HEAT_STATES.REJECTED, { actor: 'tester' });

    assert.throws(() => {
      transitionHeat(heat.heatId, HEAT_STATES.MELTING, { actor: 'tester' });
    }, (err) => err.status === 409 && err.message.includes('terminal state'));
  });

  test('TC-SM-005: Invalid transition forbidden (PLANNED -> RELEASED)', () => {
    const heat = store.heats.add({ grade: 'SG-IRON', targetKg: 1000, charge: [] });
    assert.throws(() => {
      transitionHeat(heat.heatId, HEAT_STATES.RELEASED, { actor: 'tester' });
    }, (err) => err.status === 409 && err.message.includes('Forbidden heat state transition'));
  });

  test('TC-SM-006: Optimistic concurrency mismatch throws 409 Conflict', () => {
    const heat = store.heats.add({ grade: 'SG-IRON', targetKg: 1000, charge: [] });
    // Current version is 1. Provide expectedVersion 99
    assert.throws(() => {
      transitionHeat(heat.heatId, HEAT_STATES.GATE_EVALUATED, { actor: 'tester', expectedVersion: 99 });
    }, (err) => err.status === 409 && err.message.includes('Optimistic concurrency conflict'));
  });

  test('TC-SM-007: Optimistic concurrency matching expectedVersion succeeds', () => {
    const heat = store.heats.add({ grade: 'SG-IRON', targetKg: 1000, charge: [] });
    const updated = transitionHeat(heat.heatId, HEAT_STATES.GATE_EVALUATED, { actor: 'tester', expectedVersion: 1 });
    assert.strictEqual(updated.version, 2);
  });

  test('TC-SM-008: Transition history recorded in heat_transitions table', () => {
    const heat = store.heats.add({ grade: 'SG-IRON', targetKg: 1000, charge: [] });
    transitionHeat(heat.heatId, HEAT_STATES.GATE_EVALUATED, { actor: 'qa_lead', note: 'Gate cleared' });
    const transitions = heatStateMachine.getHeatTransitions(heat.heatId);
    assert(transitions.length >= 1);
    assert.strictEqual(transitions[0].prevState, 'PLANNED');
    assert.strictEqual(transitions[0].newState, 'GATE_EVALUATED');
    assert.strictEqual(transitions[0].actor, 'qa_lead');
    assert.strictEqual(transitions[0].note, 'Gate cleared');
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
