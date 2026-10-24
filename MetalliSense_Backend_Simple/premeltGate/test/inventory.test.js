const assert = require('assert');
const { getDb, store, inventoryLedger, createMeltingHeat, initTestDb } = require('./testHelper');
const { deductAdditivesAtomic } = inventoryLedger;

async function runTests() {
  const tests = [];
  initTestDb();

  const test = (name, fn) => {
    const t0 = Date.now();
    try {
      fn();
      tests.push({ suite: 'inventoryLedger', test: name, status: 'PASS', duration_ms: Date.now() - t0 });
    } catch (err) {
      tests.push({ suite: 'inventoryLedger', test: name, status: 'FAIL', duration_ms: Date.now() - t0, error: err.message });
    }
  };

  const getFerroalloyLot = () => {
    const lots = store.listLots().filter((l) => l.materialType === 'FERROALLOY' && store.availableKg(l.lotId) > 50);
    if (!lots.length) {
      return store.addLot({ materialType: 'FERROALLOY', alloyName: 'FeSi-75', receivedKg: 500, costPerKg: 100 }, 'stores');
    }
    return lots[0];
  };

  test('TC-INV-001: Deduct single additive line successfully', () => {
    const heat = createMeltingHeat('H-INV-001');
    const lot = getFerroalloyLot();
    const initialStock = store.availableKg(lot.lotId);
    const key = `IDEMP-001-${Date.now()}`;

    const res = deductAdditivesAtomic({
      lines: [{ lotId: lot.lotId, kg: 15.5 }],
      heatId: heat.heatId,
      idempotencyKey: key,
      by: 'operator_1'
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.idempotent_replay, false);
    assert.strictEqual(res.data.deducted.length, 1);
    assert.strictEqual(res.data.deducted[0].deductedKg, 15.5);
    assert.strictEqual(store.availableKg(lot.lotId), initialStock - 15.5);
  });

  test('TC-INV-002: Multi-line deduction atomic success', () => {
    const heat = createMeltingHeat('H-INV-002');
    const lot1 = store.addLot({ materialType: 'FERROALLOY', alloyName: 'FeSi-75', receivedKg: 200, costPerKg: 100 }, 'stores');
    const lot2 = store.addLot({ materialType: 'FERROALLOY', alloyName: 'HC FeMn', receivedKg: 200, costPerKg: 80 }, 'stores');
    const key = `IDEMP-002-${Date.now()}`;

    const res = deductAdditivesAtomic({
      lines: [
        { lotId: lot1.lotId, kg: 10.25 },
        { lotId: lot2.lotId, kg: 20.5 }
      ],
      heatId: heat.heatId,
      idempotencyKey: key,
      by: 'operator_1'
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.deducted.length, 2);
    assert.strictEqual(store.availableKg(lot1.lotId), 200 - 10.25);
    assert.strictEqual(store.availableKg(lot2.lotId), 200 - 20.5);
  });

  test('TC-INV-003: Multi-line atomic rollback when one line exceeds stock', () => {
    const heat = createMeltingHeat('H-INV-003');
    const lot1 = store.addLot({ materialType: 'FERROALLOY', alloyName: 'FeSi-75', receivedKg: 100, costPerKg: 100 }, 'stores');
    const lot2 = store.addLot({ materialType: 'FERROALLOY', alloyName: 'HC FeMn', receivedKg: 50, costPerKg: 80 }, 'stores');
    const key = `IDEMP-003-${Date.now()}`;

    assert.throws(() => {
      deductAdditivesAtomic({
        lines: [
          { lotId: lot1.lotId, kg: 10 },
          { lotId: lot2.lotId, kg: 9999 } // Exceeds available stock of 50
        ],
        heatId: heat.heatId,
        idempotencyKey: key,
        by: 'operator_1'
      });
    }, (err) => err.status === 409 && err.message.includes('only 50 kg available'));

    // Assert entire batch rolled back: lot1 is completely unchanged!
    assert.strictEqual(store.availableKg(lot1.lotId), 100);
    assert.strictEqual(store.availableKg(lot2.lotId), 50);
  });

  test('TC-INV-004: Reject negative kg (400)', () => {
    const heat = createMeltingHeat('H-INV-004');
    const lot = getFerroalloyLot();
    assert.throws(() => {
      deductAdditivesAtomic({
        lines: [{ lotId: lot.lotId, kg: -10 }],
        heatId: heat.heatId,
        idempotencyKey: `KEY-NEG-${Date.now()}`
      });
    }, (err) => err.status === 400 && err.message.includes('greater than zero'));
  });

  test('TC-INV-005: Reject zero kg (400)', () => {
    const heat = createMeltingHeat('H-INV-005');
    const lot = getFerroalloyLot();
    assert.throws(() => {
      deductAdditivesAtomic({
        lines: [{ lotId: lot.lotId, kg: 0 }],
        heatId: heat.heatId,
        idempotencyKey: `KEY-ZERO-${Date.now()}`
      });
    }, (err) => err.status === 400 && err.message.includes('greater than zero'));
  });

  test('TC-INV-006: Reject non-numeric string kg (400)', () => {
    const heat = createMeltingHeat('H-INV-006');
    const lot = getFerroalloyLot();
    assert.throws(() => {
      deductAdditivesAtomic({
        lines: [{ lotId: lot.lotId, kg: 'fifteen' }],
        heatId: heat.heatId,
        idempotencyKey: `KEY-STR-${Date.now()}`
      });
    }, (err) => err.status === 400 && err.message.includes('must be a finite positive number'));
  });

  test('TC-INV-007: Reject NaN and Infinity kg (400)', () => {
    const heat = createMeltingHeat('H-INV-007');
    const lot = getFerroalloyLot();
    assert.throws(() => {
      deductAdditivesAtomic({
        lines: [{ lotId: lot.lotId, kg: NaN }],
        heatId: heat.heatId,
        idempotencyKey: `KEY-NAN-${Date.now()}`
      });
    }, (err) => err.status === 400);

    assert.throws(() => {
      deductAdditivesAtomic({
        lines: [{ lotId: lot.lotId, kg: Infinity }],
        heatId: heat.heatId,
        idempotencyKey: `KEY-INF-${Date.now()}`
      });
    }, (err) => err.status === 400);
  });

  test('TC-INV-008: Reject excessive decimal precision (>3 decimals)', () => {
    const heat = createMeltingHeat('H-INV-008');
    const lot = getFerroalloyLot();
    assert.throws(() => {
      deductAdditivesAtomic({
        lines: [{ lotId: lot.lotId, kg: 1.2345 }], // 4 decimal places
        heatId: heat.heatId,
        idempotencyKey: `KEY-PREC-${Date.now()}`
      });
    }, (err) => err.status === 400 && err.message.includes('maximum allowed precision'));
  });

  test('TC-INV-009: Aggregate duplicate lot lines in single request', () => {
    const heat = createMeltingHeat('H-INV-009');
    const lot = store.addLot({ materialType: 'FERROALLOY', alloyName: 'FeSi-75', receivedKg: 100, costPerKg: 100 }, 'stores');
    const key = `IDEMP-DUP-${Date.now()}`;

    const res = deductAdditivesAtomic({
      lines: [
        { lotId: lot.lotId, kg: 10 },
        { lotId: lot.lotId, kg: 15 } // same lot, total 25
      ],
      heatId: heat.heatId,
      idempotencyKey: key,
      by: 'operator_1'
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.deducted.length, 1);
    assert.strictEqual(res.data.deducted[0].deductedKg, 25);
    assert.strictEqual(store.availableKg(lot.lotId), 75);
  });

  test('TC-INV-010: Reject request without Idempotency-Key (400)', () => {
    const heat = createMeltingHeat('H-INV-010');
    const lot = getFerroalloyLot();
    assert.throws(() => {
      deductAdditivesAtomic({
        lines: [{ lotId: lot.lotId, kg: 5 }],
        heatId: heat.heatId
      });
    }, (err) => err.status === 400 && err.message.includes('Idempotency-Key'));
  });

  test('TC-INV-011: Idempotency replay returns previous receipt without re-deducting', () => {
    const heat = createMeltingHeat('H-INV-011');
    const lot = store.addLot({ materialType: 'FERROALLOY', alloyName: 'FeSi-75', receivedKg: 100, costPerKg: 100 }, 'stores');
    const key = `IDEMP-REPLAY-${Date.now()}`;

    const firstCall = deductAdditivesAtomic({
      lines: [{ lotId: lot.lotId, kg: 20 }],
      heatId: heat.heatId,
      idempotencyKey: key
    });
    assert.strictEqual(firstCall.idempotent_replay, false);
    assert.strictEqual(store.availableKg(lot.lotId), 80);

    // Replay identical request
    const replayCall = deductAdditivesAtomic({
      lines: [{ lotId: lot.lotId, kg: 20 }],
      heatId: heat.heatId,
      idempotencyKey: key
    });
    assert.strictEqual(replayCall.idempotent_replay, true);
    assert.strictEqual(replayCall.statusCode, 200);
    assert.strictEqual(replayCall.data.deducted[0].deductedKg, 20);
    // Stock is still 80, NOT 60!
    assert.strictEqual(store.availableKg(lot.lotId), 80);
  });

  test('TC-INV-012: Idempotency conflict (same key, different payload) returns 409', () => {
    const heat = createMeltingHeat('H-INV-012');
    const lot = store.addLot({ materialType: 'FERROALLOY', alloyName: 'FeSi-75', receivedKg: 100, costPerKg: 100 }, 'stores');
    const key = `IDEMP-CONF-${Date.now()}`;

    deductAdditivesAtomic({
      lines: [{ lotId: lot.lotId, kg: 10 }],
      heatId: heat.heatId,
      idempotencyKey: key
    });

    assert.throws(() => {
      deductAdditivesAtomic({
        lines: [{ lotId: lot.lotId, kg: 25 }], // Different quantity!
        heatId: heat.heatId,
        idempotencyKey: key
      });
    }, (err) => err.status === 409 && err.code === 'IDEMPOTENCY_CONFLICT');
  });

  test('TC-INV-013: Reject deduction for unknown heat (404)', () => {
    const lot = getFerroalloyLot();
    assert.throws(() => {
      deductAdditivesAtomic({
        lines: [{ lotId: lot.lotId, kg: 10 }],
        heatId: 'H-DOES-NOT-EXIST-999',
        idempotencyKey: `KEY-UNK-${Date.now()}`
      });
    }, (err) => err.status === 404 && err.message.includes('not found'));
  });

  test('TC-INV-014: Reject deduction for heat in non-melting state (409)', () => {
    const lot = getFerroalloyLot();
    const plannedHeat = store.heats.add({ grade: 'SG-IRON', targetKg: 1000, charge: [] });
    assert.strictEqual(plannedHeat.status, 'PLANNED');

    assert.throws(() => {
      deductAdditivesAtomic({
        lines: [{ lotId: lot.lotId, kg: 10 }],
        heatId: plannedHeat.heatId,
        idempotencyKey: `KEY-NOTMELT-${Date.now()}`
      });
    }, (err) => err.status === 409 && err.message.includes('must be in an active melting or correction phase'));
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
