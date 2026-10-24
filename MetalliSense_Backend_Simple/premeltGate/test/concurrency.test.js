const assert = require('assert');
const { store, inventoryLedger, heatStateMachine, createMeltingHeat, initTestDb } = require('./testHelper');

async function runTests() {
  const tests = [];
  initTestDb();

  const test = async (name, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      tests.push({ suite: 'concurrency', test: name, status: 'PASS', duration_ms: Date.now() - t0 });
    } catch (err) {
      tests.push({ suite: 'concurrency', test: name, status: 'FAIL', duration_ms: Date.now() - t0, error: err.message });
    }
  };

  await test('TC-CONC-001: Concurrent deductions respect stock limit without negative balance', async () => {
    const heat = createMeltingHeat('H-CONC-001');
    const lot = store.addLot({ materialType: 'FERROALLOY', alloyName: 'FeSi-75', receivedKg: 50, costPerKg: 100 }, 'stores');

    // Launch 5 parallel deductions of 20 kg each. Total requested = 100 kg. Only 50 kg available!
    // Exactly 2 must succeed (20 + 20 = 40 kg, leaves 10 kg), and 3 must fail with 409 (insufficient stock).
    const results = [];
    const promises = [1, 2, 3, 4, 5].map((idx) => {
      return new Promise((resolve) => {
        try {
          const res = inventoryLedger.deductAdditivesAtomic({
            lines: [{ lotId: lot.lotId, kg: 20 }],
            heatId: heat.heatId,
            idempotencyKey: `IDEMP-PAR-${idx}-${Date.now()}`
          });
          results.push({ idx, status: 'SUCCESS', data: res });
        } catch (err) {
          results.push({ idx, status: 'FAIL', error: err.message, statusCode: err.status });
        }
        resolve();
      });
    });

    await Promise.all(promises);

    const successes = results.filter((r) => r.status === 'SUCCESS');
    const failures = results.filter((r) => r.status === 'FAIL');

    assert.strictEqual(successes.length, 2, `Expected 2 successes, got ${successes.length}`);
    assert.strictEqual(failures.length, 3, `Expected 3 failures, got ${failures.length}`);
    assert.strictEqual(store.availableKg(lot.lotId), 10);
  });

  await test('TC-CONC-002: Concurrent transitions with optimistic locking permit only one winner', async () => {
    const heat = store.heats.add({ grade: 'SG-IRON', targetKg: 1000, charge: [] });
    const currentVersion = heat.version; // 1

    // Two parallel transitions both attempting transition from version 1
    const results = [];
    const attempt1 = new Promise((resolve) => {
      try {
        const res = heatStateMachine.transitionHeat(heat.heatId, heatStateMachine.HEAT_STATES.GATE_EVALUATED, {
          actor: 'worker_1',
          expectedVersion: currentVersion
        });
        results.push({ worker: 1, status: 'SUCCESS', data: res });
      } catch (err) {
        results.push({ worker: 1, status: 'FAIL', error: err.message, statusCode: err.status });
      }
      resolve();
    });

    const attempt2 = new Promise((resolve) => {
      try {
        const res = heatStateMachine.transitionHeat(heat.heatId, heatStateMachine.HEAT_STATES.HELD, {
          actor: 'worker_2',
          expectedVersion: currentVersion
        });
        results.push({ worker: 2, status: 'SUCCESS', data: res });
      } catch (err) {
        results.push({ worker: 2, status: 'FAIL', error: err.message, statusCode: err.status });
      }
      resolve();
    });

    await Promise.all([attempt1, attempt2]);

    const successes = results.filter((r) => r.status === 'SUCCESS');
    const conflicts = results.filter((r) => r.status === 'FAIL');

    assert.strictEqual(successes.length, 1, 'Exactly one concurrent transition must succeed');
    assert.strictEqual(conflicts.length, 1, 'The other concurrent transition must be rejected with 409 Conflict');
    assert.strictEqual(conflicts[0].statusCode, 409);
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
