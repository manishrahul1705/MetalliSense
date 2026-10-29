"""One deadline-bounded command with append-only stdout and source identity."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from datetime import datetime, timezone
import time

p = argparse.ArgumentParser()
p.add_argument('--evidence', required=True)
p.add_argument('--name', required=True)
p.add_argument('--cwd', default='.')
p.add_argument('--timeout', type=int, default=240)
p.add_argument('command', nargs=argparse.REMAINDER)
a = p.parse_args()
root = Path(__file__).resolve().parents[1]
out = Path(a.evidence) / a.name
out.mkdir(parents=True, exist_ok=False)
command = a.command[1:] if a.command[:1] == ['--'] else a.command
def git(*args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()
identity = {'head': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
            'status': git('status', '--porcelain'),
            'diffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', '--binary'], cwd=root)).hexdigest()}
start = time.monotonic()
receipt = dict(started=datetime.now(timezone.utc).isoformat(), command=command, cwd=str((root / a.cwd).resolve()), source=identity)
with (out / 'stdout-stderr.log').open('x', encoding='utf-8') as log:
    try:
        result = subprocess.run(command, cwd=root / a.cwd, env={**os.environ, 'JOBLIB_MULTIPROCESSING': '0'}, stdout=log, stderr=subprocess.STDOUT, timeout=a.timeout)
        receipt.update(exitCode=result.returncode, status='PASS' if result.returncode == 0 else 'FAIL')
    except subprocess.TimeoutExpired:
        receipt.update(exitCode=None, status='TIMEOUT')
receipt.update(ended=datetime.now(timezone.utc).isoformat(), seconds=round(time.monotonic()-start, 3))
(out / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
print(a.name, receipt['status'], receipt['exitCode'])
raise SystemExit(0 if receipt['status'] == 'PASS' else 1)
