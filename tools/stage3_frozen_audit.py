"""Read-only audit of an exact commit; all outputs go to a disposable checkout.
No application source/Git history is edited after candidate freeze.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

p=argparse.ArgumentParser();p.add_argument('--commit',required=True);p.add_argument('--evidence',required=True);a=p.parse_args()
source=Path(__file__).resolve().parents[1];out=Path(a.evidence).resolve();out.mkdir(parents=True,exist_ok=False)
checkout=out/'checkout';results=[]
def run(name,command,cwd=None,timeout=300,env=None):
    start=time.monotonic();r={'name':name,'command':command,'started':datetime.now(timezone.utc).isoformat()}
    with (out/f'{name}.log').open('x',encoding='utf-8') as log:
        try:
            x=subprocess.run(command,cwd=cwd or checkout,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=timeout)
            r.update(status='PASS' if x.returncode==0 else 'FAIL',exitCode=x.returncode)
        except subprocess.TimeoutExpired:r.update(status='TIMEOUT',exitCode=None)
    r['seconds']=round(time.monotonic()-start,3);results.append(r)
    (out/'audit-results.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(name,r['status'],flush=True)
    return r['status']=='PASS'
if not run('clone',['git','clone','--no-hardlinks','--no-checkout',str(source),str(checkout)],source):raise SystemExit(1)
if not run('checkout',['git','checkout','--detach',a.commit]):raise SystemExit(1)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=checkout,text=True).strip()
assert head==a.commit
tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=checkout,text=True).strip()
(out/'frozen-candidate.json').write_text(json.dumps({'head':head,'tree':tree,'frozen':datetime.now(timezone.utc).isoformat()},indent=2))
backend=checkout/'MetalliSense_Backend_Simple';frontend=checkout/'MetalliSense_Frontend_R/MetalliSense_Frontend'
node_ok=run('npm-ci-backend',['cmd','/c','npm','ci','--no-audit','--no-fund'],backend,600)
node_ok=run('npm-ci-frontend',['cmd','/c','npm','ci','--no-audit','--no-fund'],frontend,600) and node_ok
manifest={}
for relative in ['MetalliSense_Backend_Simple/package-lock.json','MetalliSense_Frontend_R/MetalliSense_Frontend/package-lock.json',
                 'MetalliSense_AI_R/MetalliSense_AI/requirements.txt','MetalliSense_Agent_R/MetalliSense_Agent/requirements.txt','MetalliSense_VectorSearch/requirements.txt']:
    manifest[relative]=hashlib.sha256((checkout/relative).read_bytes()).hexdigest()
(out/'dependency-input-hashes.json').write_text(json.dumps(manifest,indent=2))
environments={}
for service,relative in [('AGENT','MetalliSense_Agent_R/MetalliSense_Agent'),('AI','MetalliSense_AI_R/MetalliSense_AI'),('VECTOR','MetalliSense_VectorSearch')]:
    venv=out/f'python-{service.lower()}';exe=venv/'Scripts/python.exe'
    ok=run(f'venv-{service}',[sys.executable,'-m','venv',str(venv)],timeout=120)
    if ok:ok=run(f'pip-{service}',[str(exe),'-m','pip','install','--disable-pip-version-check','-r',str(checkout/relative/'requirements.txt')],timeout=900)
    if ok:
        ok=run(f'pip-check-{service}',[str(exe),'-m','pip','check'],timeout=60)
        run(f'packages-{service}',[str(exe),'-m','pip','list','--format=json'],timeout=60)
    environments[service]=str(exe) if ok else None
if node_ok:
    run('express-route-extraction',['node','tools/stage3_routes.cjs',str(out/'express-routes.json')])
    run('python-route-extraction',[sys.executable,'tools/stage3_python_routes.py',str(out/'python-routes.json')])
    run('tracked-static-audit',[sys.executable,'tools/stage3_static_audit.py',str(out/'static-audit')],timeout=300)
    run('express-authorization',['node','tools/stage3_authorization.cjs',str(out/'express-authorization'),str(out/'express-routes.json')],timeout=300)
    for service,exe in environments.items():
        if exe:run(f'python-authorization-{service}',[exe,'tools/stage3_python_auth.py','--service',service,'--routes',str(out/'python-routes.json'),'--output',str(out/f'python-authorization-{service}')],timeout=300)
    command=[sys.executable,'tools/stage2_checks.py','--evidence',str(out/'regressions')]
    if environments['AGENT']:command+=['--agent-python',environments['AGENT']]
    tests=['stage3_mass.test.js','stage3_release.test.js','stage1_dri_regression.test.js','stage1_composition.test.js','stage2_context.test.js','stage2_evidence.test.js',
           'stage1b_security_suite.js','stateMachine.test.js','inventory.test.js','evidence.test.js','materialBalance.test.js','durability.test.js',
           'deduction_approval_enforcement.test.js','correction_feasibility.test.js','concurrency.test.js','remediation_security.test.js','narrow_error_handling.test.js','frontend-tests','frontend-lint']
    if environments['AGENT']:tests+=['stage1_proxy.test.js']
    for name in tests:command+=['--check',name]
    run('regressions',command,timeout=1000)
    run('mock-build',['cmd','/c','npm','run','build:mock'],frontend,180)
    if environments['AGENT']:run('real-browser-lifecycle',[sys.executable,'tools/stage2_ui.py','--evidence',str(out/'ui'),'--agent-python',environments['AGENT']],timeout=900)
run('final-checkout-status',['git','status','--porcelain'])
if (out/'final-checkout-status.log').read_text().strip():results.append({'name':'clean-checkout','status':'FAIL','exitCode':1})
(out/'audit-results.json').write_text(json.dumps(results,indent=2))
raise SystemExit(0 if all(r['status']=='PASS' for r in results) else 1)
