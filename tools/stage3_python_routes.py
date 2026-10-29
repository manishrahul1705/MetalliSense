"""Extract Python mutation declarations and mounted router paths without imports."""
import ast
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
services = {'AI': root/'MetalliSense_AI_R/MetalliSense_AI/app',
            'AGENT': root/'MetalliSense_Agent_R/MetalliSense_Agent/app',
            'VECTOR': root/'MetalliSense_VectorSearch'}
routes = []
for service, directory in services.items():
    files = [directory/'main.py']
    if service == 'AI':
        files += [directory/'mech_api.py']
    for file in files:
        tree = ast.parse(file.read_text(encoding='utf-8-sig'))
        prefixes = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                if getattr(node.value.func, 'id', '') == 'APIRouter':
                    prefix = next((k.value.value for k in node.value.keywords if k.arg == 'prefix' and isinstance(k.value, ast.Constant)), '')
                    for target in node.targets:
                        if isinstance(target, ast.Name): prefixes[target.id] = prefix
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)): continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute): continue
                method = decorator.func.attr.upper()
                if method not in ['POST','PUT','PATCH','DELETE'] or not decorator.args or not isinstance(decorator.args[0], ast.Constant): continue
                receiver = getattr(decorator.func.value, 'id', '')
                routes.append({'service': service, 'method': method, 'path': prefixes.get(receiver,'') + decorator.args[0].value,
                    'file': str(file.relative_to(root)).replace('\\','/'), 'line': decorator.lineno,
                    'permission': 'Scoped internal service identity required by app HTTP middleware; human roles do not authorize direct service access'})
output = Path(sys.argv[1])
output.parent.mkdir(parents=True, exist_ok=True)
with output.open('x',encoding='utf-8') as f:
    json.dump({'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'routes':routes,
               'counts':{s:sum(r['service']==s for r in routes) for s in services}},f,indent=2)
print('Python mutations:',len(routes))
