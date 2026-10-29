# MetalliSense local startup and shutdown

This is a bounded local prototype. It uses session authentication, RBAC, CSRF
protection and durable SQLite business/evidence/document stores. Physical hardware
commissioning is PARTIAL/SIMULATED, industrial ML validity is UNVERIFIED, and live
provider explanations require legitimate provider configuration. Fixture-backed
explanation tests are separate from provider-blocked live behavior.

## Install without replacing existing work

Use Node.js 24.x (verified locally with 24.21.0) with `node:sqlite`, Python 3.11, Git and PowerShell. From the
repository root, install each service's own declared dependencies:

```powershell
Push-Location MetalliSense_Backend_Simple
npm ci
if (!(Test-Path -LiteralPath config.env)) { Copy-Item config.env.example config.env }
Pop-Location
Push-Location MetalliSense_Frontend_R/MetalliSense_Frontend
npm ci
Pop-Location
Push-Location MetalliSense_AI_R/MetalliSense_AI
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Pop-Location
Push-Location MetalliSense_Agent_R/MetalliSense_Agent
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Pop-Location
```

Use new environment directories if `.venv` already contains work to preserve.
Do not copy dependencies from another checkout. Do not retrain or overwrite
bundled models to suppress version warnings. `pip check` verifies dependency
consistency, not industrial model validity.

## Configure local identities and storage

The backend reads `MetalliSense_Backend_Simple/config.env`; existing process
environment variables take precedence. Review its CSV path, service URLs and
allowed origins. Backend service calls need the same scoped secret configured in
the receiving Python service: `METALLISENSE_AI_SERVICE_KEY` and
`METALLISENSE_AGENT_SERVICE_KEY`. Generate private random values locally and set
each in the corresponding terminals; never commit or print them in evidence.
Provider keys are optional for the local simulated lifecycle and must never be
placed in frontend `VITE_` variables. Missing provider capability stays unavailable.

For first-time local account setup, in the backend terminal set:

```powershell
$env:NODE_ENV = 'development'
$env:SEED_DEV_ACCOUNTS = 'true'
$env:METALLISENSE_DB_PATH = Join-Path $env:LOCALAPPDATA 'MetalliSense\local.db'
foreach ($roleName in 'ADMIN','OPERATOR','METALLURGIST','QM','INVENTORY','FINANCE') {
    $localPassword = Read-Host "Private local password for $roleName" -AsSecureString
    [Environment]::SetEnvironmentVariable("DEV_${roleName}_PASSWORD", [System.Net.NetworkCredential]::new('', $localPassword).Password, 'Process')
}
```

Seeding requires explicit development/test opt-in and an empty users table; it
never resets existing accounts. Production seeding is prohibited. Log in with
`admin1`, `operator1`, `metallurgist1`, `qm1`, `inventory1` or `finance1` and the
corresponding locally supplied password. After initial setup, disable
`SEED_DEV_ACCOUNTS` for later starts. Unset optional passwords are generated;
they are not a usable documented default. Never use `NODE_ENV=test` for normal
interactive startup. Keep the SQLite file and its WAL/SHM companions intact;
back up a stopped store before maintenance. The fallback database location is
under the OS temporary directory, so set an explicit durable path for repeat use.

Ordinary startup is OPERATIONAL. For an isolated simulated lifecycle, use a
**new** dedicated database and set these together before starting the backend:

```powershell
$env:METALLISENSE_SIMULATION = 'true'
$env:METALLISENSE_SIMULATION_STORE = Join-Path $env:LOCALAPPDATA 'MetalliSense\simulation-local.db'
$env:METALLISENSE_DB_PATH = $env:METALLISENSE_SIMULATION_STORE
```

For a new simulation store, apply the first-time account setup opt-in and private passwords to that store too. Do not point simulation at an operational store or switch its persisted context.
Simulation documents are not physical or commercial release certificates.

## Start in separate terminals

From the repository root in each terminal:

```powershell
# Backend: apply the environment configuration above in this terminal first.
Set-Location MetalliSense_Backend_Simple
npm start
# HTTP 3000; built-in spectrometer simulator 4334; handheld simulator 4335.
```

```powershell
# AI: set the matching METALLISENSE_AI_SERVICE_KEY first.
Set-Location MetalliSense_AI_R/MetalliSense_AI
.\.venv\Scripts\python.exe -X utf8 app\main.py
# HTTP 8000
```

```powershell
# Agent: set the matching METALLISENSE_AGENT_SERVICE_KEY first.
Set-Location MetalliSense_Agent_R/MetalliSense_Agent
.\.venv\Scripts\python.exe -X utf8 app\main.py
# HTTP 8001
```

```powershell
Set-Location MetalliSense_Frontend_R/MetalliSense_Frontend
npm run dev -- --host 127.0.0.1
# Open http://127.0.0.1:5173 and log in.
```

Backend health: `http://127.0.0.1:3000/api/v1/health`. AI/Agent expose `/health`
on their respective ports. Health or authorization acceptance alone does not
prove successful inference. Authenticated business routes require login; missing
login is not diagnosed by expecting unauthenticated grade JSON.

For built frontend assets, run `npm run build`, then
`npm run preview -- --host 127.0.0.1 --port 5173`. Keep the backend and required
Python services running. Avoid port conflicts; do not terminate unknown owners.

Standalone VectorSearch is EXCLUDED from this audit, including `POST /reindex`
and `POST /semantic-search`; it is not required for the tested lifecycle. Agent
vector routes `/vector/reindex`, `/vector/search`, `/vector/memory/add` and
`/vector/memory/recall` remain in scope and use Agent's configuration. This does
not establish standalone VectorSearch functionality.

## Verify and shut down

Focused correction: `node MetalliSense_Backend_Simple/premeltGate/test/csrf_auth_method.test.js`.
Frontend commands from its folder: `npm run test:mock`, `npm run lint`,
`npm run build`. The complete automated lifecycle uses `tools/stage2_ui.py`
with a fresh evidence directory and `--agent-python` pointing to the declared
Agent environment. It owns isolated database/ports 4391, 4392, 4393, 4334, 4335;
stop interactive backend instances using those simulator ports before that run.

Use **Ctrl+C** in each terminal that you started and wait for exit. Keep
configuration, SQLite stores and evidence. Do not delete stores as a shutdown
step. Verify release of task-owned ports; if process inspection is denied, report
that limitation instead of claiming every process is absent. No deployment is
required for local verification. Consult the correction handoff for exact commit,
passed/failed/blocked/unexecuted checks and process/port receipts.


## Temporary local automatic metallurgist login

For the owner-operated local demo, stop your existing backend with Ctrl+C in
its terminal, then from the repository root run:

```powershell
.\tools\start-local-admin.ps1
```

Leave that terminal running. In the frontend terminal run `npm run dev -- --host
127.0.0.1 --port 5173 --strictPort` from its folder, and refresh
`http://127.0.0.1:5173/spectrometer`. The development UI restores a real local
admin session without entering a password. The account is separate from existing
users; their passwords are not overwritten. Cookies, CSRF and role checks remain.
This mode is explicitly enabled only for development and loopback browser origins;
normal and production starts do not enable it. Stop the launcher and restart with
normal configuration to disable automatic session creation. Sign Out revokes the
current session; refreshing while this mode is enabled signs in again.

Click Connect to start the OPC client. The simulator server starts with the
backend, but the client does not auto-connect. Reading history loads after a
successful connection. Request Reading acquires a new grade/heat-specific sample;
connecting alone does not create heat evidence. This remains simulated equipment.


If startup reports EADDRINUSE on 3000, 4334 or 4335, another backend is already
running. Stop both the failed duplicate and the original backend with Ctrl+C in
their respective terminals, then run the local-admin launcher once. The launcher
checks IPv4 and IPv6 availability for all three ports and disables HTTP port
fallback. Do not change the frontend API to 30001 to work around this conflict;
that does not resolve the shared simulator ports. Sampling-interval warnings
are separate from the EADDRINUSE startup failure.
