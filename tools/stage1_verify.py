"""Sequential, deadline-bounded Stage 1 checks with immutable per-attempt logs."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--evidence', required=True)
parser.add_argument('--agent-python', required=True)
parser.add_argument('--targeted-only', action='store_true')
parser.add_argument('--check', action='append', help='Run only these named backend checks')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
out = Path(args.evidence).resolve()
out.mkdir(parents=True, exist_ok=False)
env = {**os.environ, 'EVIDENCE_DIR': str(out), 'STAGE1_AGENT_PYTHON': args.agent_python}
tests = ['stage1_dri_regression.test.js', 'stage1_composition.test.js', 'stage1_proxy.test.js']
if not args.targeted_only:
    tests += ['stage1b_security_suite.js', 'stateMachine.test.js', 'inventory.test.js',
              'evidence.test.js', 'materialBalance.test.js', 'durability.test.js',
              'deduction_approval_enforcement.test.js', 'correction_feasibility.test.js',
              'remediation_security.test.js', 'narrow_error_handling.test.js']
commands = [(name, ['node', str(root / 'MetalliSense_Backend_Simple/premeltGate/test' / name)], root, 200) for name in (args.check or tests)]
if not args.targeted_only and not args.check:
    frontend = root / 'MetalliSense_Frontend_R/MetalliSense_Frontend'
    commands += [('frontend-lint', ['cmd', '/c', 'npm', 'run', 'lint'], frontend, 120),
                 ('frontend-build', ['cmd', '/c', 'npm', 'run', 'build'], frontend, 180)]
results = []
for name, command, cwd, deadline in commands:
    start = time.monotonic()
    with (out / (name + '.log')).open('w', encoding='utf-8') as log:
        try:
            result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=deadline)
            status = 'PASS' if result.returncode == 0 else 'FAIL'
            code = result.returncode
        except subprocess.TimeoutExpired:
            status, code = 'TIMEOUT', None
            log.write('\nOverall check deadline exceeded; retained diagnostics.\n')
    results.append(dict(check=name, status=status, exitCode=code, seconds=round(time.monotonic()-start, 2)))
    if name == 'frontend-lint' and "ESLint couldn't find an eslint.config." in (out / (name + '.log')).read_text(encoding='utf-8'):
        results[-1]['status'] = status = 'BLOCKED'
        results[-1]['reason'] = 'Repository ESLint configuration is missing; lint did not execute'
    (out / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(name, status, flush=True)
raise SystemExit(0 if all(r['status'] == 'PASS' for r in results) else 1)
