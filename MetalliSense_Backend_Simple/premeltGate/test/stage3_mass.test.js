const assert = require('node:assert/strict');
const { allocateBath } = require('../massAccounting');
// Independently calculated demonstration: 963.6 + (0.75*.85 + .001*.85
// + .003*.85 + .0003 + .0001 + .2456*.95) = 964.474620 kg.
const b = allocateBath(964.47462, { castingYieldPct: 70, returnsPct: 25, documentedLossPct: 5 });
assert.equal(b.castingsKg, 675.132);
assert.equal(b.returnsKg, 241.118);
assert.equal(b.processLossKg, 48.223731);
assert.equal(b.allocationRoundingResidualKg, 0.000889);
assert.equal(b.unallocatedKg, 0);
assert.equal(Math.round((b.castingsKg + b.returnsKg + b.processLossKg + b.allocationRoundingResidualKg) * 1e6), 964474620);
assert.equal(Math.round((b.accountedKg + 36.4 + 0.12538) * 1e6), 1001000000, '1000 kg base charge plus 1 kg additive; unrecovered additive is counted once outside the bath');
assert.equal(b.differenceKg, 0);
assert.equal(b.conserved, true);
for (const mass of [0.000001, 0.9, 1.5, 1000.999999, 964.47462]) {
  const x = allocateBath(mass, { castingYieldPct: 70, returnsPct: 25, documentedLossPct: 5 });
  assert.equal(x.differenceKg, 0);
  assert(x.allocationRoundingResidualKg >= 0 && x.allocationRoundingResidualKg < 0.002);
}
const partial = allocateBath(100, { castingYieldPct: 68, returnsPct: 22, documentedLossPct: 4 });
assert.equal(partial.unallocatedKg, 6, 'Incomplete allocation is explicit, not silently called loss');
console.log('PASS: independent microkg conservation, original 0.47462 kg discrepancy, gram outputs, explicit residual and unrecovered additive accounting');
