"""Fresh exact-commit local stability verification; standalone VectorSearch excluded."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

p = argparse.ArgumentParser()
p.add_argument('--commit', required=True)
p.add_argument('--evidence', required=True)
a = p.parse_args()
source = Path(__file__).resolve().parents[1]
out = Path(a.evidence).resolve()
out.mkdir(parents=True, exist_ok=False)
checkout = out / 'checkout'
results = []
env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1', 'JOBLIB_MULTIPROCESSING': '0'}

def run(name, command, cwd=None, timeout=300):
    started = time.monotonic()
    row = {'name': name, 'command': command, 'started': datetime.now(timezone.utc).isoformat()}
    with (out / (name + '.log')).open('x', encoding='utf-8') as log:
        try:
            r = subprocess.run(command, cwd=cwd or checkout, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            row.update(status='PASS' if r.returncode == 0 else 'FAIL', exitCode=r.returncode)
        except subprocess.TimeoutExpired:
            row.update(status='TIMEOUT', exitCode=None)
    row['seconds'] = round(time.monotonic() - started, 3)
    results.append(row)
    (out / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(name, row['status'], flush=True)
    return row['status'] == 'PASS'

if not run('clone', ['git', 'clone', '--no-hardlinks', '--no-checkout', str(source), str(checkout)], source):
    raise SystemExit(1)
if not run('checkout', ['git', 'checkout', '--detach', a.commit]):
    raise SystemExit(1)
def git(*args):
    return subprocess.check_output(['git', *args], cwd=checkout, text=True).strip()
assert git('rev-parse', 'HEAD') == a.commit
(out / 'frozen-candidate.json').write_text(json.dumps({'head': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'), 'initialStatus': git('status', '--porcelain')}, indent=2))
backend = checkout / 'MetalliSense_Backend_Simple'
frontend = checkout / 'MetalliSense_Frontend_R/MetalliSense_Frontend'
node_ok = run('npm-ci-backend', ['cmd', '/c', 'npm', 'ci', '--no-audit', '--no-fund'], backend, 600)
node_ok = run('npm-ci-frontend', ['cmd', '/c', 'npm', 'ci', '--no-audit', '--no-fund'], frontend, 600) and node_ok
manifest = {}
for rel in ['MetalliSense_Backend_Simple/package-lock.json', 'MetalliSense_Frontend_R/MetalliSense_Frontend/package-lock.json', 'MetalliSense_AI_R/MetalliSense_AI/requirements.txt', 'MetalliSense_Agent_R/MetalliSense_Agent/requirements.txt']:
    manifest[rel] = hashlib.sha256((checkout / rel).read_bytes()).hexdigest()
(out / 'dependency-input-hashes.json').write_text(json.dumps(manifest, indent=2))
environments = {}
for service, rel in [('AGENT', 'MetalliSense_Agent_R/MetalliSense_Agent'), ('AI', 'MetalliSense_AI_R/MetalliSense_AI')]:
    venv = out / ('python-' + service.lower())
    exe = venv / 'Scripts/python.exe'
    ok = run('venv-' + service, [sys.executable, '-m', 'venv', str(venv)], timeout=120)
    if ok:
        ok = run('pip-' + service, [str(exe), '-m', 'pip', 'install', '--disable-pip-version-check', '-r', str(checkout / rel / 'requirements.txt')], timeout=1200)
    if ok:
        ok = run('pip-check-' + service, [str(exe), '-m', 'pip', 'check'], timeout=60)
        run('packages-' + service, [str(exe), '-m', 'pip', 'list', '--format=json'], timeout=60)
    environments[service] = str(exe) if ok else None
if node_ok:
    run('python-route-inventory', [sys.executable, 'tools/stage3_python_routes.py', str(out / 'python-routes.json')])
    for service, exe in environments.items():
        if exe:
            run('authorization-' + service, [exe, 'tools/stage3_python_auth.py', '--service', service, '--routes', str(out / 'python-routes.json'), '--output', str(out / ('authorization-' + service))], timeout=300)
    command = [sys.executable, 'tools/stage2_checks.py', '--evidence', str(out / 'regressions')]
    if environments['AGENT']:
        command += ['--agent-python', environments['AGENT']]
    checks = ['csrf_auth_method.test.js', 'stage1b_security_suite.js', 'remediation_security.test.js', 'narrow_error_handling.test.js', 'stage3_mass.test.js', 'stage3_release.test.js', 'stage2_context.test.js', 'stage2_evidence.test.js', 'concurrency.test.js', 'frontend-tests', 'frontend-lint', 'frontend-build']
    if environments['AGENT']:
        checks += ['stage1_proxy.test.js']
    for name in checks:
        command += ['--check', name]
    gates = run('correction-regressions', command, timeout=900)
    if environments['AGENT']:
        ui = [sys.executable, 'tools/stage2_ui.py', '--evidence', str(out / 'ui'), '--agent-python', environments['AGENT']]
        # UI uses its own test API URL; default production assets cannot be reused.
        run('complete-lifecycle', ui, timeout=900)
run('final-checkout-status', ['git', 'status', '--porcelain'])
clean = git('status', '--porcelain') == ''
(out / 'final-source.json').write_text(json.dumps({'head': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'), 'clean': clean}, indent=2))
raise SystemExit(0 if clean and all(r['status'] == 'PASS' for r in results) else 1)
