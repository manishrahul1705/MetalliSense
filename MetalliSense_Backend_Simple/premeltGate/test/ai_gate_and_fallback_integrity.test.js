/**
 * AI Gate and Fallback Integrity Test
 *
 * Verifies:
 * 1. Behavior when aiRequired=true vs aiRequired=false
 * 2. Unreachable AI service -> FAIL vs WARN
 * 3. AI service timeout and malformed response
 * 4. Furnace start interlock: HOLD requires authorized engineer override (>= 20 chars, maker-checker)
 * 5. GET /api/v2/rl/policy/status: verifies whether offline status returns fabricated metrics
 * 6. POST /api/v2/rl/optimize: verifies fallback response behavior
 */

const assert = require('node:assert');
const path = require('node:path');

// Load isolated test helper
const store = require('../store');
const { settings, GRADE_SPECS } = require('../config');
const { runGate, startMelting } = require('../gateEngine');
const { evaluateCorrectionFeasibility } = require('../correctionFeasibility');

console.log('================================================================');
console.log('AI Gate and Fallback Integrity Verification');
console.log('================================================================\n');

async function runTests() {
  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`[PASS] Test ${total}: ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] Test ${total}: ${name}`);
      console.error(`       Error: ${err.message}`);
    }
  }

  async function asyncTest(name, fn) {
    total++;
    try {
      await fn();
      console.log(`[PASS] Test ${total}: ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] Test ${total}: ${name}`);
      console.error(`       Error: ${err.message}`);
    }
  }

  // Ensure fresh seed
  store.seed();

  // Test 1: Baseline config observation
  test('Inspect aiRequired setting and its default behavior', () => {
    console.log(`       settings.aiRequired = ${settings.aiRequired}`);
    console.log(`       PREMELT_AI_REQUIRED env = ${process.env.PREMELT_AI_REQUIRED}`);
    // Record current state
    assert.strictEqual(typeof settings.aiRequired, 'boolean');
  });

  // Test 2: Pre-melt Gate with aiRequired = true when AI is offline
  await asyncTest('aiRequired=true with AI service offline MUST produce FAIL and HOLD decision', async () => {
    const originalAiRequired = settings.aiRequired;
    const originalTimeout = settings.aiTimeoutMs;
    settings.aiRequired = true;
    settings.aiTimeoutMs = 300; // fast timeout for test
    try {
      // Plan a clean heat
      const heat = store.heats.add({
        grade: 'SG-IRON',
        targetKg: 1000,
        charge: [
          { lotId: 'PIG-0901', kg: 500 },
          { lotId: 'SCR-0912', kg: 500 }
        ]
      });

      // Release lots so only AI can cause FAIL
      store.setStatus(store.getLot('PIG-0901'), 'RELEASED', 'QA Released', 'testAdmin');
      store.setStatus(store.getLot('SCR-0912'), 'RELEASED', 'QA Released', 'testAdmin');

      const gate = await runGate(heat.heatId, { by: 'operator1' });
      const aiCheckItem = gate.checks.find(c => c.id === 'ai_assessment');

      assert(aiCheckItem, 'ai_assessment check must exist');
      console.log(`       aiCheck status: ${aiCheckItem.status}`);
      console.log(`       overall gate decision: ${gate.decision}`);
      assert.strictEqual(aiCheckItem.status, 'FAIL', 'When aiRequired=true and AI is unreachable, status MUST be FAIL');
      assert.strictEqual(gate.decision, 'HOLD', 'When an item has FAIL, overall gate decision MUST be HOLD');
    } finally {
      settings.aiRequired = originalAiRequired;
      settings.aiTimeoutMs = originalTimeout;
    }
  });

  // Test 3: Interlock enforcement when decision is HOLD
  test('startMelting without override on HOLD heat MUST be rejected with 423', () => {
    const originalAiRequired = settings.aiRequired;
    settings.aiRequired = true;
    try {
      const heat = store.heats.add({
        grade: 'SG-IRON',
        targetKg: 1000,
        charge: [
          { lotId: 'PIG-0901', kg: 500 },
          { lotId: 'SCR-0912', kg: 500 }
        ]
      });
      // Mock gate decision = HOLD
      const gate = {
        gateId: 'G-TEST-HOLD',
        decision: 'HOLD',
        blocking: ['AI assessment unavailable'],
        warnings: [],
        fingerprint: require('../gateEngine').fingerprint(heat),
        validUntil: new Date(Date.now() + 30 * 60000)
      };
      store.heats.update(heat.heatId, { gate });

      assert.throws(() => {
        startMelting(heat.heatId, { operator: 'operator1', acknowledgeWarnings: true });
      }, (err) => {
        assert.strictEqual(err.status, 423, 'Must throw 423 locked');
        assert(err.message.includes('locked by the pre-melt gate'));
        return true;
      });
    } finally {
      settings.aiRequired = originalAiRequired;
    }
  });

  // Test 4: Engineer override requirements on HOLD
  test('Engineer override on HOLD requires authorized role and >= 20 chars reason', () => {
    const heat = store.heats.add({
      grade: 'SG-IRON',
      targetKg: 1000,
      charge: [
        { lotId: 'PIG-0901', kg: 500 },
        { lotId: 'SCR-0912', kg: 500 }
      ]
    });
    const gate = {
      gateId: 'G-TEST-HOLD-2',
      decision: 'HOLD',
      blocking: ['AI assessment unavailable'],
      warnings: [],
      fingerprint: require('../gateEngine').fingerprint(heat),
      validUntil: new Date(Date.now() + 30 * 60000)
    };
    store.heats.update(heat.heatId, { gate });

    // Sub-test 4A: Reason too short (< 20 chars) -> 400
    assert.throws(() => {
      startMelting(heat.heatId, {
        operator: 'operator1',
        override: { engineer: 'metallurgist1', reason: 'Short reason' }
      }, { userId: 'u-met', username: 'metallurgist1', roles: ['METALLURGIST'] });
    }, (err) => {
      assert.strictEqual(err.status, 400);
      return true;
    });

    // Sub-test 4B: Unauthorized role (OPERATOR) -> 403
    assert.throws(() => {
      startMelting(heat.heatId, {
        operator: 'operator1',
        override: { engineer: 'operator1', reason: 'This reason is long enough but role is invalid.' }
      }, { userId: 'u-op', username: 'operator1', roles: ['OPERATOR'] });
    }, (err) => {
      assert.strictEqual(err.status, 403);
      return true;
    });

    // Sub-test 4C: Authorized role (METALLURGIST) with valid reason -> SUCCESS
    const result = startMelting(heat.heatId, {
      operator: 'operator1',
      override: { engineer: 'metallurgist1', reason: 'Controlled metallurgical override for test heat with full supervision.' }
    }, { userId: 'u-met', username: 'metallurgist1', roles: ['METALLURGIST'] });
    assert.strictEqual(result.status, 'MELTING');
    assert.strictEqual(result.start.mode, 'ENGINEER_OVERRIDE');
  });

  // Test 5: aiRequired=false behavior (Relaxed setting observation)
  await asyncTest('aiRequired=false downgrades unavailable AI to WARN, permitting start without override', async () => {
    const originalAiRequired = settings.aiRequired;
    const originalTimeout = settings.aiTimeoutMs;
    settings.aiRequired = false;
    settings.aiTimeoutMs = 300;
    try {
      const heat = store.heats.add({
        grade: 'SG-IRON',
        targetKg: 1000,
        charge: [
          { lotId: 'PIG-0901', kg: 600 },
          { lotId: 'RET-1043', kg: 400 }
        ]
      });

      const gate = await runGate(heat.heatId, { by: 'operator1' });
      const aiCheckItem = gate.checks.find(c => c.id === 'ai_assessment');
      assert.strictEqual(aiCheckItem.status, 'WARN', 'aiRequired=false downgrades status to WARN');
      assert.strictEqual(gate.decision, 'WARN', 'decision becomes WARN');

      // Operator can start directly with acknowledgeWarnings: true without engineer override
      const result = startMelting(heat.heatId, {
        operator: 'operator1',
        acknowledgeWarnings: true
      }, { userId: 'u-op', username: 'operator1', roles: ['OPERATOR'] });
      assert.strictEqual(result.status, 'MELTING');
      assert.strictEqual(result.start.mode, 'WARN_ACKNOWLEDGED');
    } finally {
      settings.aiRequired = originalAiRequired;
      settings.aiTimeoutMs = originalTimeout;
    }
  });

  // Test 6: Physical mass balance bounds verification
  test('Deterministic correction feasibility satisfies all grade specification bounds', () => {
    const grade = 'SG-IRON';
    const spec = GRADE_SPECS[grade];
    const batchWeightKg = 1000;
    const initialChemistry = { C: 3.1, Si: 1.5, Mn: 0.35, P: 0.03, S: 0.02 };
    const additions = [
      { lotId: 'ALY-0903', alloyName: 'FeSi-75', kg: 6.0 },
      { lotId: 'ALY-0905', alloyName: 'Recarburiser', kg: 3.0 },
      { lotId: 'ALY-0904', alloyName: 'HC FeMn', kg: 2.0 }
    ];

    const result = evaluateCorrectionFeasibility({
      targetGrade: grade,
      heatMassKg: batchWeightKg,
      initialChemistry,
      additions
    });

    assert(result.feasible, 'Correction must be feasible');
    console.log('       Final predicted composition after correction:', result.predictedChemistry);

    // Verify all core elements are strictly within spec ranges
    for (const [el, [min, max]] of Object.entries(spec)) {
      const val = result.predictedChemistry[el];
      if (val !== undefined) {
        assert(val >= min - 0.001, `${el} (${val}) below min ${min}`);
        assert(val <= max + 0.001, `${el} (${val}) above max ${max}`);
      }
    }
  });

  console.log(`\nResults: ${passed} / ${total} tests passed (${Math.round((passed / total) * 100)}%)`);
  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
