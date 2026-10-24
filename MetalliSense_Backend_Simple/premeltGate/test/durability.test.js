const assert = require('assert');
const { getDb, closeDb, store, initTestDb, testDbPath, withTransaction } = require('./testHelper');

async function runTests() {
  const tests = [];
  initTestDb();

  const test = (name, fn) => {
    const t0 = Date.now();
    try {
      fn();
      tests.push({ suite: 'durability', test: name, status: 'PASS', duration_ms: Date.now() - t0 });
    } catch (err) {
      tests.push({ suite: 'durability', test: name, status: 'FAIL', duration_ms: Date.now() - t0, error: err.message });
    }
  };

  test('TC-DUR-001: Data persists across connection close and reopening', () => {
    // Write test heat and lot
    const heat = store.heats.add({ grade: 'SG-IRON', targetKg: 2500, charge: [] });
    store.log('DURABILITY_CHECK', heat.heatId, 'durability_tester', 'Persistence verification event');

    // Simulate process shutdown by closing DB
    closeDb();

    // Reopen DB connection
    const db = getDb();
    const loadedHeat = store.heats.get(heat.heatId);
    assert(loadedHeat !== null);
    assert.strictEqual(loadedHeat.heatId, heat.heatId);
    assert.strictEqual(loadedHeat.targetKg, 2500);

    const audit = store.audit();
    assert(audit.some((a) => a.type === 'DURABILITY_CHECK' && a.ref === heat.heatId));
  });

  test('TC-DUR-002: Audit log retains >550 events without 500-event circular truncation', () => {
    // Generate 600 audit events
    const initialCount = store.audit().length;
    const db = getDb();
    const insertStmt = db.prepare('INSERT INTO audit_events (at, type, ref, by, detail) VALUES (?, ?, ?, ?, ?)');

    withTransaction((txDb) => {
      for (let i = 0; i < 600; i++) {
        insertStmt.run(new Date().toISOString(), 'MASS_AUDIT_EVENT', `EVT-${i}`, 'mass_tester', `Retention test event ${i}`);
      }
    });

    const allAudit = store.audit();
    assert(allAudit.length >= 600, `Expected at least 600 events, got ${allAudit.length}`);
    // Check that earliest and latest events exist
    assert(allAudit.some((a) => a.detail === 'Retention test event 0'));
    assert(allAudit.some((a) => a.detail === 'Retention test event 599'));
  });

  test('TC-DUR-003: Failed transaction completely rolls back without partial writes', () => {
    const db = getDb();
    const initialAuditCount = store.audit().length;

    assert.throws(() => {
      withTransaction((txDb) => {
        txDb.prepare('INSERT INTO audit_events (at, type, ref, by, detail) VALUES (?, ?, ?, ?, ?)').run(
          new Date().toISOString(), 'ROLLBACK_TEST', 'REF-001', 'tester', 'Should not persist'
        );
        throw new Error('Forced crash inside transaction');
      });
    }, (err) => err.message.includes('Forced crash'));

    // Verify event was not written
    const allAudit = store.audit();
    assert.strictEqual(allAudit.length, initialAuditCount);
    assert(!allAudit.some((a) => a.type === 'ROLLBACK_TEST'));
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
