# MetalliSense: Intelligent Foundry Decision Support System

MetalliSense is a local, human-in-the-loop foundry decision-support prototype. It connects material inspection, pre-melt checks, simulated chemistry, correction planning, independent approval, inventory accounting and simulated documents. Verification is bounded to isolated local workflows; it is not industrial qualification or production certification.

---

## 1. System Architecture

The platform operates as a coordinated multi-service architecture:

| Service | Technology | Default Port | Responsibility |
|---|---|---|---|
| **Frontend** | React 18, Vite, Tailwind CSS | `5173` | Operator workflows, MeltFlowContext, real-time charts |
| **Backend** | Node.js, Express | `3000` | Session authentication, RBAC, durable SQLite business/evidence/document stores, CSV reference data |
| **Spectrometer Sim** | Node.js (node-opcua) | `4334` | Simulated OPC UA optical emission spectrometer |
| **Handheld Gun Sim** | Node.js (node-opcua) | `4335` | Simulated handheld XRF/LIBS yard inspection gun |
| **AI Service** | Python 3.11, FastAPI | `8000` | IsolationForest anomaly detection, GradientBoosting alloy correction, mechanical models |
| **Agent Service** | Python 3.11, FastAPI | `8001` | Pre-melt HistGradientBoosting deviation risk, contextual-bandit RL policy, Copilot chat & voice |
| **Vector Search** | Python 3.11, FastAPI | `8002` | Standalone service; excluded from this audit (including its two mutation routes) |

---

## 2. Dual-Mode Operation

MetalliSense supports two operational deployment modes:

### Mode A: Full Multi-Service Microstack
Connects the React frontend to Node.js on port `3000`, AI on `8000` and Agent on `8001`. Standalone VectorSearch on `8002` is optional and excluded from this audit: `POST /reindex` and `POST /semantic-search`. Agent vector features (`/vector/reindex`, `/vector/search`, `/vector/memory/add`, `/vector/memory/recall`) are distinct and remain in scope.

### Mode B: Static Browser Demonstration Mode
The frontend includes an integrated in-browser mock engine (`src/mock/server.js`) that intercepts all Axios and fetch calls. It executes:
- In-browser simulated Pre-Melt Gate interlocks and SHA-1 fingerprinting.
- In-browser serialized scikit-learn decision trees for anomaly detection and alloy recommendations (`src/mock/models/*.json`).
- Linear programming charge mix optimizer using `javascript-lp-solver`.
- Runs completely offline without any Node backend or Python services running.

To launch the static demo:
```bash
cd MetalliSense_Frontend_R/MetalliSense_Frontend
npm ci
npm run dev:mock
```

---

## 3. Getting Started & Startup Instructions

Use [docs/TORUN.md](docs/TORUN.md) for PowerShell startup, authentication,
configuration, database persistence and shutdown commands. Node.js 24.x (verified locally with 24.21.0) with
`node:sqlite`, Python 3.11 and Git are required. Install Node dependencies with
`npm ci` and Python dependencies from each service's own `requirements.txt`.
Do not overwrite an existing configuration or database when setting up.

Human mutations use authenticated sessions, RBAC and CSRF validation. A Bearer
header does not exempt a request authenticated by cookie. Machine service keys
are separate from human identities; CORS is not a substitute for CSRF protection.
SQLite stores persist across restart. CSV reference datasets and some legacy
analytics caches are separate from the durable business/evidence stores.

Route counts are deliberately omitted here. For reproducible counts use
`tools/stage3_routes.cjs` (Express declarations versus mounted URLs/aliases) and
`tools/stage3_python_routes.py` (Python mutation declarations by service). An
endpoint total must state its methods, mounts, aliases and excluded services.

### Verification limits

- Hardware is PARTIAL/SIMULATED; the lifecycle uses actual OPC UA communication
  with a simulator, not a commissioned physical instrument.
- Industrial ML validity is UNVERIFIED; dependency/model-version warnings remain
  limitations. Do not retrain or overwrite bundled models as a startup step.
- Live explanations are PROVIDER-BLOCKED without legitimate provider credentials.
  Fixture-backed contract checks are reported separately from live responses.
- Browser mock mode is a demonstration, not evidence of durable backend behavior.
- See the append-only correction handoff for exact tested commit, results and any
  blocked verification. A passing local lifecycle does not imply unrestricted
  security clearance or production readiness.

---

## 4. Retrospective Import Dating Disclosure

This repository history has been imported and structured across **19 October 2026 through 22 October 2026 (Asia/Kolkata, UTC+05:30)**. These commit dates reflect structured retrospective publication import milestones organizing the multi-tier codebase into reviewable architectural stages, rather than chronological evidence that development occurred on those specific dates.

---

## 5. Contributor Attribution & License

- **Lead Author & System Architect**: Manish Rahul (<manish.skillnxt@gmail.com>)
- **Bundled Fonts**: JetBrains Mono and Montserrat are licensed under the SIL Open Font License (OFL). See `src/assets/demo-fonts/` for license terms.
