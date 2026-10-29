"""Verify one exact Stage 2 commit in a fresh disposable checkout.

Installs each lockfile independently and creates a new declared-requirements
Python environment. No node_modules, dist, database or model output is copied
from the working tree. Failed attempts are retained.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--commit', required=True)
parser.add_argument('--evidence', required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parents[1]
out = Path(args.evidence).resolve()
out.mkdir(parents=True, exist_ok=False)
checkout = out / 'checkout'
venv = out / 'python-agent'
results = []

def run(name, command, cwd=None, timeout=300, env=None):
    started = datetime.now(timezone.utc).isoformat()
    start = time.monotonic()
    with (out / (name + '.log')).open('x', encoding='utf-8') as log:
        try:
            result = subprocess.run(command, cwd=cwd or source, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            status, code = ('PASS' if result.returncode == 0 else 'FAIL'), result.returncode
        except subprocess.TimeoutExpired:
            status, code = 'TIMEOUT', None
    results.append(dict(check=name, command=command, started=started, status=status, exitCode=code, seconds=round(time.monotonic()-start, 2)))
    (out / 'independent-results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(name, status, flush=True)
    return status == 'PASS'

if not run('clone', ['git', 'clone', '--no-hardlinks', '--no-checkout', str(source), str(checkout)]):
    raise SystemExit(1)
if not run('checkout', ['git', 'checkout', '--detach', args.commit], checkout):
    raise SystemExit(1)
actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip()
assert actual == args.commit, (actual, args.commit)
tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=checkout, text=True).strip()
(out / 'exact-commit.json').write_text(json.dumps(dict(commit=actual, tree=tree), indent=2), encoding='utf-8')
backend = checkout / 'MetalliSense_Backend_Simple'
frontend = checkout / 'MetalliSense_Frontend_R/MetalliSense_Frontend'
node_ok = run('npm-ci-backend', ['cmd', '/c', 'npm', 'ci', '--no-audit', '--no-fund'], backend, 600)
node_ok = run('npm-ci-frontend', ['cmd', '/c', 'npm', 'ci', '--no-audit', '--no-fund'], frontend, 600) and node_ok
python_ok = run('python-venv', [sys.executable, '-m', 'venv', str(venv)])
python_exe = venv / 'Scripts/python.exe'
if python_ok:
    python_ok = run('pip-agent-requirements', [str(python_exe), '-m', 'pip', 'install', '--disable-pip-version-check', '-r', str(checkout / 'MetalliSense_Agent_R/MetalliSense_Agent/requirements.txt')], checkout, 900)
    if python_ok:
        python_ok = run('pip-check', [str(python_exe), '-m', 'pip', 'check'], checkout, 60)
        run('python-packages', [str(python_exe), '-m', 'pip', 'list', '--format=json'], checkout, 60)
if node_ok and python_ok:
    command = [sys.executable, str(checkout / 'tools/stage2_checks.py'), '--evidence', str(out / 'boundary-checks'), '--agent-python', str(python_exe)]
    for name in ['stage2_context.test.js', 'stage2_evidence.test.js', 'stage1_dri_regression.test.js', 'stage1_composition.test.js', 'stage1b_security_suite.js',
                 'deduction_approval_enforcement.test.js', 'correction_feasibility.test.js', 'frontend-tests']:
        command += ['--check', name]
    run('targeted-boundaries', command, checkout, 500)
    run('exact-commit-real-ui', [sys.executable, str(checkout / 'tools/stage2_ui.py'), '--evidence', str(out / 'ui'), '--agent-python', str(python_exe)], checkout, 900)
if not run('final-working-tree', ['git', 'status', '--porcelain'], checkout):
    raise SystemExit(1)
if (out / 'final-working-tree.log').read_text(encoding='utf-8').strip():
    results.append(dict(check='checkout-cleanliness', status='FAIL', exitCode=1))
    (out / 'independent-results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
raise SystemExit(0 if all(result['status'] == 'PASS' for result in results) else 1)
