"""Append-only, sequential Stage 2 command records. No credentials in logs."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--evidence', required=True)
parser.add_argument('--check', action='append', required=True)
parser.add_argument('--agent-python')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
out = Path(args.evidence).resolve()
out.mkdir(parents=True, exist_ok=False)
results = []
env = {**os.environ, 'EVIDENCE_DIR': str(out), 'JOBLIB_MULTIPROCESSING': '0'}
if args.agent_python:
    env['STAGE1_AGENT_PYTHON'] = str(Path(args.agent_python).resolve())
for name in args.check:
    command = ['node', str(root / 'MetalliSense_Backend_Simple/premeltGate/test' / name)]
    cwd = root
    if name in ['frontend-lint', 'frontend-tests', 'frontend-build']:
        cwd = root / 'MetalliSense_Frontend_R/MetalliSense_Frontend'
        command = ['cmd', '/c', 'npm', 'run', {'frontend-lint': 'lint', 'frontend-tests': 'test:mock', 'frontend-build': 'build'}[name]]
    started = datetime.now(timezone.utc).isoformat()
    start = time.monotonic()
    with (out / (name + '.log')).open('x', encoding='utf-8') as log:
        try:
            result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
            code = result.returncode
            status = 'PASS' if code == 0 else 'FAIL'
        except subprocess.TimeoutExpired:
            status, code = 'TIMEOUT', None
            log.write('\nRequired check exceeded 180 second deadline.\n')
    if name == 'frontend-lint' and "ESLint couldn't find an eslint.config." in (out / (name + '.log')).read_text(encoding='utf-8'):
        status = 'BLOCKED'
    results.append(dict(check=name, command=command, started=started, status=status, exitCode=code, seconds=round(time.monotonic()-start, 2)))
    (out / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(name, status, flush=True)
raise SystemExit(0 if all(r['status'] == 'PASS' for r in results) else 1)
