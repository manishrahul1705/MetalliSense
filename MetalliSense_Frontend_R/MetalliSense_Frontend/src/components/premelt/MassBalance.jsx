import React from 'react';
export default function MassBalance({ balance, addition }) {
  if (!balance) return null;
  const rows = [['Corrected bath', balance.bathKg], ['Castings', balance.castingsKg], ['Returns to stock', balance.returnsKg],
    ['Configured process loss', balance.processLossKg], ['Allocation rounding carry', balance.allocationRoundingResidualKg],
    ['Unallocated bath', balance.unallocatedKg], ['Accounting difference', balance.differenceKg]];
  return <section className="border rounded p-3 my-3 text-sm" aria-label="Mass reconciliation">
    <p className="font-bold">Mass reconciliation (kg)</p>
    <p>Model accounting to 0.000001 kg; castings and returns floor to 0.001 kg inventory units. Rounding carry is separate from process loss.</p>
    {rows.map(([label, value]) => <p key={label} className="flex justify-between gap-4"><span>{label}</span><span className="font-mono">{Number(value).toFixed(6)}</span></p>)}
    {addition && <p className="mt-2">Additive deducted: {addition.deductedAdditiveKg.toFixed(6)} kg; dissolved: {addition.dissolvedAdditiveKg.toFixed(6)} kg; unrecovered before bath allocation: {addition.unrecoveredAdditiveKg.toFixed(6)} kg. These are recovery-model assumptions.</p>}
  </section>;
}
