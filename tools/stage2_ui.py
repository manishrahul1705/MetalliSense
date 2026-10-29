"""Build and run one real lifecycle runner, preserving every attempt."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--evidence', required=True)
parser.add_argument('--agent-python', required=True)
parser.add_argument('--reuse-built-assets', action='store_true', help='Only for harness-only retries; retain preceding production build evidence')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
out = Path(args.evidence).resolve()
out.mkdir(parents=True, exist_ok=False)
frontend = root / 'MetalliSense_Frontend_R/MetalliSense_Frontend'
env = {**os.environ, 'EVIDENCE_DIR': str(out), 'STAGE2_AGENT_PYTHON': str(Path(args.agent_python).resolve()),
       'VITE_API_BASE_URL': 'http://127.0.0.1:4391/api/v2', 'VITE_API_URL': 'http://127.0.0.1:4391', 'VITE_MOCK_MODE': 'false'}
results = []
for port in [4391, 4392, 4393, 4334, 4335]:
    with socket.socket() as probe:
        if os.name == 'nt':
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        probe.bind(('127.0.0.1', port))

def run(name, command, cwd, timeout):
    started = datetime.now(timezone.utc).isoformat()
    start = time.monotonic()
    with (out / f'{name}.log').open('x', encoding='utf-8') as log:
        try:
            completed = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            code = completed.returncode
            status = 'PASS' if code == 0 else 'FAIL'
        except subprocess.TimeoutExpired:
            code, status = None, 'TIMEOUT'
            log.write('\nLifecycle command exceeded overall deadline. Preserve diagnostics before cleanup.\n')
    results.append(dict(name=name, command=command, started=started, exitCode=code, status=status, seconds=round(time.monotonic()-start, 2)))
    (out / 'commands.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(name, status, flush=True)
    return code == 0

run('preflight-head', ['git', 'rev-parse', 'HEAD', 'HEAD^{tree}'], root, 10)
run('preflight-status', ['git', 'status', '--short'], root, 10)
model = root / 'MetalliSense_Agent_R/MetalliSense_Agent/app/models/premelt_risk_model.pkl'
(out / 'preserved-model-hash.json').write_text(json.dumps({'sha256': hashlib.sha256(model.read_bytes()).hexdigest()}))
if args.reuse_built_assets or run('production-build', ['cmd', '/c', 'npm', 'run', 'build'], frontend, 180):
    if args.reuse_built_assets:
        (out / 'asset-reuse.json').write_text(json.dumps({'reason': 'Harness-only retry; application assets unchanged since preceding retained production build', 'indexSha256': hashlib.sha256((frontend / 'dist/index.html').read_bytes()).hexdigest()}))
    run('real-ui', ['node', 'node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.stage2.config.js'], frontend, 660)
ports = []
for port in [4391, 4392, 4393, 4334, 4335]:
    try:
        with socket.socket() as probe:
            if os.name == 'nt':
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind(('127.0.0.1', port))
        ports.append({'port': port, 'released': True})
    except OSError as error:
        ports.append({'port': port, 'released': False, 'error': str(error)})
(out / 'cleanup-ports.json').write_text(json.dumps(ports, indent=2))
if not all(p['released'] for p in ports):
    results.append({'name': 'owned-port-release', 'status': 'FAIL'})
raise SystemExit(0 if all(r['status'] == 'PASS' for r in results) else 1)
