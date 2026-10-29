"""Read-only tracked-source syntax and bounded secret/generated-file audit."""
import ast
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
root=Path(__file__).resolve().parents[1];out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=False)
files=subprocess.check_output(['git','ls-files'],cwd=root,text=True).splitlines()
syntax=[];findings=[]
for name in files:
    file=root/name
    if name.endswith('.py'):
        try:ast.parse(file.read_text(encoding='utf-8-sig'));syntax.append({'path':name,'status':'PASS'})
        except (SyntaxError,UnicodeError) as e:syntax.append({'path':name,'status':'FAIL','diagnostic':str(e)})
    elif name.endswith(('.js','.mjs','.cjs')) and not '/src/' in name:
        r=subprocess.run(['node','--check',str(file)],cwd=root,capture_output=True,text=True,timeout=15)
        syntax.append({'path':name,'status':'PASS' if r.returncode==0 else 'FAIL','diagnostic':r.stderr[:1000]})
    if file.suffix in ['.js','.jsx','.mjs','.cjs','.py','.env','.json','.md'] and file.stat().st_size<1000000:
        text=file.read_text(encoding='utf-8',errors='replace')
        # Only locations and classifications are emitted; never secret values.
        for pattern,label in [(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----','PRIVATE_KEY'),(r'\b(?:sk-proj-|gsk_)[A-Za-z0-9_-]{24,}','PROVIDER_KEY_PATTERN')]:
            for match in re.finditer(pattern,text):findings.append({'path':name,'line':text[:match.start()].count('\n')+1,'kind':label})
    if any(part in ['node_modules','dist','__pycache__'] for part in file.parts) or name.endswith(('.db','.pyc')):
        findings.append({'path':name,'kind':'TRACKED_GENERATED_ARTIFACT'})
(out/'syntax.json').write_text(json.dumps(syntax,indent=2));(out/'secret-generated-scan.json').write_text(json.dumps(findings,indent=2))
print('Syntax files',len(syntax),'failures',sum(x['status']=='FAIL' for x in syntax),'scan findings',len(findings))
raise SystemExit(1 if findings or any(x['status']=='FAIL' for x in syntax) else 0)
