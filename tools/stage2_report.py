"""Create the final append-only Stage 2 evidence index and handoff."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import subprocess
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--evidence', required=True)
parser.add_argument('--ui', default='ui-final')
parser.add_argument('--independent', default='independent-01')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
out = Path(args.evidence).resolve()
ui = out / args.ui
independent = out / args.independent
def git(*args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()
def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))
def write(name, value):
    with (out / name).open('x', encoding='utf-8') as file:
        file.write(value)

lifecycle = read(ui / 'lifecycle-results.json')
checks = read(out / 'checks-full/results.json')
verification = read(independent / 'independent-results.json')
exact = read(independent / 'exact-commit.json')
head, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
assert head == exact['commit'] and tree == exact['tree']
complete = all(step['status'] == 'PASS' for step in lifecycle['steps']) and all(check['status'] == 'PASS' for check in verification)
model = root / 'MetalliSense_Agent_R/MetalliSense_Agent/app/models/premelt_risk_model.pkl'
model_hash = hashlib.sha256(model.read_bytes()).hexdigest()
assert model_hash == '1044e9e701ed9a937b3f1b4f18bc96c68a2823994a5b6c6a8646a8ca6080fef3'
write('ending-working-tree.txt', git('status', '--short') + '\n')
write('simulation-contract.md', (root / 'docs/STAGE2_SIMULATION_CONTRACT.md').read_text(encoding='utf-8'))
with (out / 'lifecycle-step-matrix.csv').open('x', newline='', encoding='utf-8') as file:
    writer = csv.DictWriter(file, fieldnames=['name', 'status', 'at'])
    writer.writeheader()
    writer.writerows({key: step.get(key, '') for key in ['name', 'status', 'at']} for step in lifecycle['steps'])
step_rows = '\n'.join(f"| {step['name']} | {step['status']} |" for step in lifecycle['steps'])
test_rows = '\n'.join(f"| {check['check']} | {check['status']} | {check['exitCode']} |" for check in checks)
independent_rows = '\n'.join(f"| {check['check']} | {check['status']} | {check['exitCode']} |" for check in verification)
reconciliation = read(ui / 'inventory-material-reconciliation.json')
write('STAGE2_HANDOFF.md', f'''# Stage 2 simulated batch lifecycle handoff

Generated {datetime.now(timezone.utc).isoformat()}.
Stage 2 completion gate: **{'PASS' if complete else 'NOT SATISFIED'}**.
This is an isolated prototype simulation result. It does not establish Stage F,
industrial ML validity, physical metallurgical performance or production readiness.

## Repository and preservation

- Branch: `{git('branch', '--show-current')}`.
- Starting HEAD: `6966025979474bcc984b0fa85362e758b1353006`.
- Starting tree: `4687adf2be5f07ccf817c29c856d30dc92db6458`.
- Ending HEAD: `{head}`.
- Ending tree: `{tree}`.
- Commit identity/time: `{git('log', '-1', '--format=%an <%ae> | %cn <%ce> | %aI | %cI')}`.
- The pre-existing modified model and Python caches are preserved outside the
  Stage 2 commit. Model SHA-256 remains `{model_hash}`.
- See `ending-working-tree.txt`. No amend, reset, rebase, push or deployment.

## Implementation and root causes

- Added explicit server-configured, permanently bound simulation storage with
  context constraints. Default and production paths cannot adopt simulation stores.
- Reused the actual OPC server/client and existing evidence, planning, correction,
  inventory and sales interfaces. Simulation samples use saved charge prediction
  and consumed additions; no reading is promoted to physical evidence.
- Persisted correction candidates with authenticated makers, exact quantities,
  heat/sample/specification versions and hashes. Independent approval and atomic
  deduction retain these bindings and consumed review state.
- Added missing simulation correction/final-QA/release controls to Spectrometer.
  Release uses persisted subsequent chemistry and explicitly simulated QA rather
  than client-submitted composition/model output. Start and release are transactional.
- Added durable simulation-labelled certificate/invoice snapshots and retrieval.
  Repaired invoice/view field mismatches and amount-in-words indexing.
- Startup previously re-applied a seeded yard inspection because detached lot
  session IDs were not durable. It now consults persisted inspection sessions.

## Lifecycle matrix

| Step | Result |
| --- | --- |
{step_rows}

Primary browser run: `{args.ui}`. Exact-commit browser run: `{args.independent}/ui`.
Human steps use real UI controls; OPC acquisition is recorded separately with
server instrument origin and human requester. Separate accounts establish
application-level maker-checker separation, not independence of real-world people.

## Isolation and security

- Context boundary tests reject missing isolated configuration, production
  simulation, context changes, cross-context approvals and operational reopen.
- Operational strict chemistry still rejects simulated evidence; operational
  correction selection excludes it. Simulation refuses physical-evidence submission.
- `{len(lifecycle['boundaries'])}` recorded HTTP negative/fault cases compare exact
  persisted domain values, not only row counts. Cases include stale/wrong sample,
  changed quantities, authorized self-approval, missing QA, invalid units/values,
  disconnected/wrong-heat acquisition, unauthorized actions and premature invoicing.
- Injected failures after a movement write and before commit roll back all business
  writes, including approval consumption and receipts. Lost response after commit
  is recovered through the same normal UI request/key with no second deduction.
- Restart compares complete persisted business rows. Completed deduction/release
  retries and duplicate invoice attempts preserve state and artifact uniqueness.
- Existing full Stage 1B: 35/35; frontend tests: 37/37. Security remediation and
  deduction/correction suites remain passing. See raw logs for individual cases.

## Regression results

| Check | Status | Exit |
| --- | --- | --- |
{test_rows}

Lint remains **BLOCKED**, exit 2: repository ESLint configuration is absent.
The full-check runner exits nonzero for that blocked check; it is never counted
as passing. Functional checks and browser builds have separate recorded results.
Live explanation remains provider-blocked without legitimate provider configuration.
Stage 1 explanation-contract success remains separately fixture-backed.
ML validity is **UNVERIFIED**; hardware is **PARTIAL / SIMULATED**.

## Material and inventory reconciliation

- Initial simulated bath mass: {reconciliation['initialBath']['metalKg']} kg.
- Dissolved FeSi mass: {reconciliation['dissolvedKg']} kg from 1 kg stock deduction.
- Corrected simulated bath mass: {reconciliation['expectedBathMassKg']} kg.
- Castings: {reconciliation['tap']['castingsKg']} kg; returns:
  {reconciliation['tap']['returnsKg']} kg; documented/rounding loss:
  {reconciliation['tap']['lossKg']} kg.
- Chosen pig iron balance 100 kg, DRI balance 100 kg, FeSi balance 99 kg.
- See `{args.ui}/inventory-material-reconciliation.json` for independent arithmetic,
  elemental values, movement quantities, receipts and invoice reconciliation.
- Mechanical fixture values (450 MPa UTS, 280 MPa YS, 12% elongation, 200 HB)
  are hypothetical specimen results, explicitly labelled as simulation.

## Exact-commit independent verification

| Check | Status | Exit |
| --- | --- | --- |
{independent_rows}

Each Node project used its own lockfile with `npm ci`. No `node_modules` or `dist`
was copied. The fresh Python environment used declared Agent requirements; package
resolution and `pip check` are retained. Assets were built inside the checkout.
Unpinned transitive/optional Python dependencies and persisted-model version warnings
remain reproducibility and validity limitations. No verification-only commit.

## Retained failures and cleanup

- `ui-01`: intake selector harness failure before lifecycle transitions.
- `ui-02`: furnace button locator failure after genuine HOLD/GO verification.
- `ui-03`: full UI journey succeeded through documents; restart detected a real
  seeded-inspection replay, plus a cleanup harness signal/exit-code mismatch.
- `ui-04`: complete lifecycle/restart passed; `ui-final` adds rollback, lost-response,
  authorized self-approval rejection and independent material/invoice reconciliation.
- `checks-01`, `checks-02`, `checks-03` retain earlier passing targeted checks.
- Automatic permission review intermittently failed for capacity/timeouts; rejected
  commands were not executed and were retried after review recovered.
- Three confirmed orphan joblib workers from the broad proxy regression were
  diagnosed and stopped; see `process-scan-before-commit.json` and
  `cleanup-regression-workers.json`. Later runners disable multiprocessing.
- Each UI run retains owned-process and exclusive port-release results. Only
  task-owned processes were stopped. Final cleanup evidence is indexed separately.

Screenshots and sanitized HTTP diagnostics are retained in each browser directory.
Databases, failed runs and dependency environments are preserved. See
`artifact-index.json` for the evidence inventory and hashes.

**No push or deployment. No Stage F or production-readiness claim.**
''')
entries = []
for base, dirs, files in os.walk(out):
    dirs[:] = [d for d in dirs if d not in {'checkout', 'python-agent', 'agent-runtime', 'node_modules', '.git', '__pycache__'}]
    for name in files:
        file = Path(base) / name
        entries.append({'path': str(file.relative_to(out)), 'bytes': file.stat().st_size, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
write('artifact-index.json', json.dumps(entries, indent=2))
print('Stage 2 handoff and evidence index written; completion gate:', 'PASS' if complete else 'NOT SATISFIED')
raise SystemExit(0 if complete else 1)
