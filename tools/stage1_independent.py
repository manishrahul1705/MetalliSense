"""Verify an exact local commit using a new checkout and fresh dependencies.

No node_modules, dist, Python environment, database, or model output is copied
from the development working tree. All artifacts and failures remain in evidence.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

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
    start = time.monotonic()
    with (out / (name + '.log')).open('w', encoding='utf-8') as log:
        try:
            result = subprocess.run(command, cwd=cwd or source, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            status, code = ('PASS' if result.returncode == 0 else 'FAIL'), result.returncode
        except subprocess.TimeoutExpired:
            status, code = 'TIMEOUT', None
    results.append(dict(check=name, status=status, exitCode=code, seconds=round(time.monotonic()-start, 2)))
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
if node_ok and python_ok:
    run('targeted-regressions', [sys.executable, str(checkout / 'tools/stage1_verify.py'), '--targeted-only', '--evidence', str(out / 'targeted'), '--agent-python', str(python_exe)], checkout, 300)
if node_ok:
    run('production-build', ['cmd', '/c', 'npm', 'run', 'build'], frontend, 300)
    ui = out / 'ui'
    ui.mkdir()
    env = {**os.environ, 'EVIDENCE_DIR': str(ui)}
    run('real-ui', ['node', 'node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.stage1.config.js'], frontend, 240, env)
run('final-working-tree', ['git', 'status', '--short'], checkout)
raise SystemExit(0 if all(result['status'] == 'PASS' for result in results) else 1)
