const assert = require('assert');
const { sales, initTestDb } = require('./testHelper');

async function runTests() {
  const tests = [];
  initTestDb();

  const test = (name, fn) => {
    const t0 = Date.now();
    try {
      fn();
      tests.push({ suite: 'materialBalance', test: name, status: 'PASS', duration_ms: Date.now() - t0 });
    } catch (err) {
      tests.push({ suite: 'materialBalance', test: name, status: 'FAIL', duration_ms: Date.now() - t0, error: err.message });
    }
  };

  test('TC-MB-001: Reject configuration where castingYieldPct + returnsPct > 100% (400)', () => {
    const initialConfig = sales.getConfig();
    assert.throws(() => {
      sales.updateConfig({ castingYieldPct: 85, returnsPct: 30 }); // Sum = 115%
    }, (err) => err.status === 400 && err.message.includes('exceeds 100%'));

    const currentConfig = sales.getConfig();
    assert.strictEqual(currentConfig.castingYieldPct, initialConfig.castingYieldPct);
    assert.strictEqual(currentConfig.returnsPct, initialConfig.returnsPct);
  });

  test('TC-MB-002: Reject configuration with documentedLossPct pushing sum > 100%', () => {
    assert.throws(() => {
      sales.updateConfig({ castingYieldPct: 70, returnsPct: 25, documentedLossPct: 10 }); // Sum = 105%
    }, (err) => err.status === 400 && err.message.includes('exceeds 100%'));
  });

  test('TC-MB-003: Reject negative percentage values', () => {
    assert.throws(() => {
      sales.updateConfig({ castingYieldPct: -10 });
    }, (err) => err.status === 400 && err.message.includes('must be a finite positive number >= 0'));

    assert.throws(() => {
      sales.updateConfig({ returnsPct: -5 });
    }, (err) => err.status === 400 && err.message.includes('must be a finite positive number >= 0'));
  });

  test('TC-MB-004: Accept valid joint configuration and persist', () => {
    const updated = sales.updateConfig({ castingYieldPct: 68, returnsPct: 22, documentedLossPct: 4 });
    assert.strictEqual(updated.castingYieldPct, 68);
    assert.strictEqual(updated.returnsPct, 22);
    assert.strictEqual(updated.documentedLossPct, 4);

    const reloaded = sales.getConfig();
    assert.strictEqual(reloaded.castingYieldPct, 68);
    assert.strictEqual(reloaded.returnsPct, 22);
    assert.strictEqual(reloaded.documentedLossPct, 4);
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
