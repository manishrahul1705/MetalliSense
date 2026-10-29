// Kilograms are represented as integer microkilograms during accounting.
// Inventory/output quantities are floored to the existing 0.001 kg ledger unit;
// the remaining mass is an explicit rounding carry, never fabricated process loss.
const SCALE = 1e6;
function units(kg) {
  if (!Number.isFinite(kg) || kg < 0 || !Number.isSafeInteger(Math.round(kg * SCALE))) throw Object.assign(new Error('Invalid mass in kg'), { status: 422 });
  return Math.round(kg * SCALE);
}
const kg = value => value / SCALE;
function allocateBath(bathKg, settings) {
  const bath = units(bathKg);
  const fractions = [settings.castingYieldPct, settings.returnsPct, settings.documentedLossPct];
  if (fractions.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0) || fractions.reduce((a, b) => a + b, 0) > 100) throw Object.assign(new Error('Invalid mass allocation fractions'), { status: 422 });
  const [casting, returns, loss] = fractions;
  const castings = Math.floor(Math.round(bath * casting / 100) / 1000) * 1000;
  const returned = Math.floor(Math.round(bath * returns / 100) / 1000) * 1000;
  const processLoss = Math.round(bath * loss / 100);
  const unallocated = Math.round(bath * (100 - casting - returns - loss) / 100);
  const carry = bath - castings - returned - processLoss - unallocated;
  const accounted = castings + returned + processLoss + unallocated + carry;
  return { policy: 'KG_MICRO_ACCOUNTING_GRAM_OUTPUT_FLOOR_V1', bathKg: kg(bath),
    castingsKg: kg(castings), returnsKg: kg(returned), processLossKg: kg(processLoss),
    unallocatedKg: kg(unallocated), allocationRoundingResidualKg: kg(carry),
    accountedKg: kg(accounted), differenceKg: kg(bath - accounted), conserved: bath === accounted,
    precisionKg: 0.000001, inventoryPrecisionKg: 0.001,
    assumptions: 'Configured casting/returns/process-loss fractions; casting and returns floor to ledger grams. Rounding carry is retained separately, not called process loss.' };
}
module.exports = { allocateBath, units, kg };
