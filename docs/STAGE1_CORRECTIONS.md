# Stage 1 application corrections

These corrections preserve ML validity as **UNVERIFIED** and hardware integration
as **PARTIAL / SIMULATED**. They do not qualify the whole project or Stage F.

## Scope

- Agent proxies already carried service credentials in the starting commit.
  The three custom explain/optimize/feedback calls now explicitly select the
  Agent credential scope, sanitize downstream errors, and map downstream
  authentication failures to `502 / UPSTREAM_AUTH_REJECTED`. Human login failures
  retain their separate `401` contract. Payload mapping and timeouts are unchanged.
- DRI QA previously mutated detached SQLite result objects. Decisions, QA versions,
  lot chemistry, and maker/checker reviews now persist in one transaction. Stable
  maker/checker IDs accompany display names. Rejection uses the authenticated
  reviewer. Superseded/duplicate actions remain blocked. History labels tested and
  decision times separately. Migration 3 adds fields without rewriting old records.
- The spectrometer page omitted the grade, unpacked the reading list incorrectly,
  and requested readings were never stored. It now supplies grade and optional
  heat ID, uses the canonical endpoint, and displays persisted readings/receipts.
  Simulator readings use `SIMULATED_MEASURED / OPC_UA_SIMULATOR`; physical chemistry
  gates reject this type and all model/predicted chemistry. The simulator endpoint
  is restricted to development/test environments.
- Trusted chemistry ingestion validates finite numeric percentages, required
  elements, units, active heat state, service identity and evidence permissions.
  Replays compare both values and provenance metadata; legacy receipt hashes are
  preserved. Human users cannot submit service-measured chemistry.

## Verification

`tools/stage1_verify.py --evidence <new-folder> --agent-python <python.exe>` runs
sequential checks with per-check deadlines. The Python environment must contain
the Agent project's declared dependencies. The integration test copies Agent
source into an isolated runtime so model/policy writes cannot alter source files.

The proxy test first verifies that the actual Agent explanation endpoint is
provider-blocked without credentials. It then substitutes only the external LLM
with an explicitly labelled fixture. Actual Agent authentication, HTTP handlers,
analysis and RL remain in use. This is not evidence of a successful live LLM call.

For real UI checks, set `EVIDENCE_DIR` to a new directory and run from the frontend:

```
node node_modules/@playwright/test/cli.js test --config playwright.stage1.config.js
```

The test uses an isolated database, ephemeral admin password, actual backend,
actual OPC simulator, and real browser. It checks composition history/receipt,
independent DRI approval, reload/restart persistence, and retention of the human
session after an upstream authentication error. Request diagnostics omit secrets.
The upstream-error UI check uses a rejecting downstream fixture; actual Agent
credential rejection is verified separately by the proxy integration test.

The initial Stage 1B provenance failures came from an empty-charge heat whose
gate correctly blocked melting. Its provenance tests now explicitly provision
an eligible isolated heat; their expected security/provenance assertions are
unchanged. This fixture does not claim that a physical furnace gate passed.

Repository-wide lint is **BLOCKED** by missing ESLint configuration, not PASS.
The verification runner preserves its actual exit code and diagnostic log.

`tools/stage1_independent.py --commit <full-sha> --evidence <new-folder>` creates a
fresh local checkout of the exact commit, installs each Node lockfile with
`npm ci`, provisions a new Python environment from the Agent requirements, and
reruns targeted regressions, the production build and real UI journeys. It does
not copy `node_modules`, `dist`, environments or runtime databases. Dependency
installation failures remain explicit failures with retained logs.
