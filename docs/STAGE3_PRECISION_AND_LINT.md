# Stage 3 accounting and lint policy

The Stage 2 demonstration deducted 1000 kg base charge and 1 kg FeSi.
The saved charge model yielded 963.6 kg liquid metal. FeSi dissolved mass is
0.874620 kg using the declared per-element recoveries, leaving 0.125380 kg
unrecovered additive outside the liquid bath. The base-charge model's 36.4 kg
non-liquid difference is separate. Neither difference is counted again in bath
allocation. These are simulated recovery assumptions, not measured losses.

Corrected bath mass is 964.474620 kg. The previous implementation rounded bath,
castings, returns and loss independently to whole kilograms, then tested an
unrounded identity with a 1 kg tolerance. Thus the stored 675 + 241 + 48 kg did
not conserve the actual bath, despite its conservation flag.

Stage 3 performs accounting in integer microkilograms (0.000001 kg). This is
computational precision, not a claim of physical scale accuracy. Castings and
returns floor to the existing 0.001 kg inventory ledger resolution. Configured
process loss remains its explicit fraction of the bath; the rounding carry is
separate. For the demonstrated 70/25/5 allocation:

| Quantity | kg |
| --- | ---: |
| Castings | 675.132000 |
| Returns | 241.118000 |
| Configured process loss | 48.223731 |
| Allocation rounding carry | 0.000889 |
| Total accounted | 964.474620 |
| Difference | 0.000000 |

An incomplete configured allocation produces explicit unallocated mass and
blocks release. No increased tolerance hides a discrepancy. An independent
arithmetic regression verifies this example, gram flooring and full input mass
including unrecovered additive. Certificates and the simulation lifecycle panel
show all allocation terms; inventory and invoice quantities use ledger grams.

ESLint 9 uses a flat configuration across every frontend JS/JSX/MJS application,
mock, test and configuration file. Only dependencies, generated dist and generated
test reports are excluded. Core recommended checks, undefined identifiers,
syntax, JSX variable usage and hook-order checks are blocking. Legacy unused
bindings, hook dependency omissions and Fast Refresh export organization remain
visible warnings. The initial working check found 12 blocking errors and 90
warnings. Focused fixes resolve the blocking errors without hiding application
paths or changing the lint command to unconditional success. The warnings remain
technical debt; exit 0 is not a zero-warning claim.

Historical Stage 1/2 lint BLOCKED receipts remain unchanged. Their status does
not become retroactive PASS when the Stage 3 configuration is introduced.
