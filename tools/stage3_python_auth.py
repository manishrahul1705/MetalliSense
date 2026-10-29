"""Real ASGI middleware/route authorization probes in a disposable service copy.

Run each service under its own declared-requirements environment. Lifespan/model
startup is intentionally absent for authorization-only probes; no 422/503 is
reported as successful model/provider functionality.
"""
import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import sys

# Imported service modules log Unicode symbols during initialization. Explicitly
# encode redirected Windows logs as UTF-8; do not change probe expectations.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')

p=argparse.ArgumentParser()
p.add_argument('--service',choices=['AI','AGENT','VECTOR'],required=True)
p.add_argument('--routes',required=True)
p.add_argument('--output',required=True)
a=p.parse_args()
route_manifest=Path(a.routes).resolve()
root=Path(__file__).resolve().parents[1]
out=Path(a.output).resolve();out.mkdir(parents=True,exist_ok=False)
relative={'AI':'MetalliSense_AI_R/MetalliSense_AI','AGENT':'MetalliSense_Agent_R/MetalliSense_Agent','VECTOR':'MetalliSense_VectorSearch'}[a.service]
runtime=out/'runtime'
shutil.copytree(root/relative,runtime,ignore=shutil.ignore_patterns('node_modules','venv','.venv','__pycache__','*.pyc'))
scope=f'METALLISENSE_{a.service}_SERVICE_KEY'
valid=secrets.token_hex(32);wrong=secrets.token_hex(32)
os.environ.update({scope:valid,'METALLISENSE_INTERNAL_SERVICE_KEY':'','JOBLIB_MULTIPROCESSING':'0','HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','GROQ_API_KEY':'','GEMINI_API_KEY':'','ANTHROPIC_API_KEY':''})
sys.dont_write_bytecode=True
os.chdir(runtime)
if a.service=='VECTOR':
    sys.path.insert(0,str(runtime))
    spec=importlib.util.spec_from_file_location('stage3_vector_main',runtime/'main.py')
else:
    sys.path.insert(0,str(runtime));sys.path.insert(0,str(runtime/'app'))
    spec=importlib.util.spec_from_file_location('stage3_service_main',runtime/'app/main.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
app=module.app
import httpx
def snapshot():
    return {str(f.relative_to(runtime)):hashlib.sha256(f.read_bytes()).hexdigest() for f in runtime.rglob('*') if f.is_file() and '__pycache__' not in str(f)}
async def main():
    rows=[]
    transport=httpx.ASGITransport(app=app,raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport,base_url='http://isolated-service',timeout=8) as client:
        for route in json.loads(route_manifest.read_text())['routes']:
            if route['service']!=a.service:continue
            for principal,headers,expected in [
                ('ANONYMOUS',{},401),('WRONG_SERVICE_KEY',{'X-Internal-Service-Key':wrong},403),
                ('HUMAN_SESSION_IS_NOT_SERVICE',{'Authorization':'Bearer '+secrets.token_hex(32)},403),
                ('CROSS_SERVICE_KEY',{'X-Internal-Service-Key':secrets.token_hex(32)},403),
                ('VALID_HEADER',{'X-Internal-Service-Key':valid},None),('VALID_BEARER',{'Authorization':'Bearer '+valid},None)]:
                before=snapshot()
                r=await client.request(route['method'],route['path'],headers=headers,json={})
                try:body=r.json()
                except ValueError:body={'format':'non-JSON'}
                unchanged=snapshot()==before
                passed=(r.status_code==expected and unchanged) if expected else r.status_code not in [401,403]
                rows.append({**route,'principal':principal,'status':r.status_code,'expected':expected or 'AUTH_ACCEPTANCE_ONLY',
                    'result':'PASS' if passed else 'FAIL','unchangedRuntimeFiles':unchanged,'responseCode':body.get('code'),
                    'functionality':'UNEXECUTED — authorization probe, no model/provider lifespan startup'})
    (out/'permission-matrix.json').write_text(json.dumps({'service':a.service,'rows':rows,'limitations':'Filesystem values/hashes compared; full in-memory side-effect instrumentation is not established. No positive functional claim from validation/unavailable responses.'},indent=2))
    print(a.service,len(rows),'cells',sum(r['result']=='FAIL' for r in rows),'failures')
    return 1 if any(r['result']=='FAIL' for r in rows) else 0
raise SystemExit(asyncio.run(main()))
