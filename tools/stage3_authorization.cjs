// Real Express application authorization audit. Valid domain workflows are
// assessed by separate lifecycle receipts; handler validation is acceptance only.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: false });
process.env.NODE_ENV = 'test';
process.env.METALLISENSE_DB_PATH = path.join(output, 'authorization.db');
process.env.SEED_DEV_ACCOUNTS = 'false';
process.env.ENABLE_DEMO_RESET = 'false';
for (const scope of ['AI','AGENT','VECTOR']) process.env[`METALLISENSE_${scope}_SERVICE_KEY`] = crypto.randomBytes(32).toString('hex');
const base = path.join(root, 'MetalliSense_Backend_Simple');
const fixtureCsv = fs.readFileSync(path.join(base,'dataset.csv'),'utf8').split(/\r?\n/).slice(0,8).join('\n');
process.env.DATA_CSV = path.join(output,'isolated-training.csv');
fs.writeFileSync(process.env.DATA_CSV,fixtureCsv);
const db = require(path.join(base, 'premeltGate/db')).getDb();
const sec = require(path.join(base, 'premeltGate/security'));
const { H, policy, permitted } = require('./stage3_policy.cjs');
const inventory = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const principals = [{ name:'ANONYMOUS',kind:'anonymous' },{name:'INVALID_SERVICE',kind:'invalid',token:crypto.randomBytes(32).toString('hex')}];
for (const role of H) {
  const id = `AUDIT-${role}`;
  sec.createUser({userId:id,username:id.toLowerCase(),email:`${id}@example.invalid`,displayName:id,password:crypto.randomBytes(32).toString('hex'),roles:[role]});
  principals.push({name:role,kind:'human',role,userId:id});
}
for (const role of ['SPECTROMETER_SERVICE','LAB_SERVICE','GUN_SERVICE','UNRELATED_SERVICE']) {
  const token = crypto.randomBytes(32).toString('hex');
  sec.createServiceCredential({serviceId:`AUDIT-${role}`,serviceName:role,serviceType:role,apiKey:token,permittedEvidence:['MELT_MEASURED','POST_CORRECTION_MEASURED','LAB_MEASURED']});
  principals.push({name:role,kind:'service',role,token});
}
let downstream = 0;
const axios = require(path.join(base, 'node_modules/axios'));
axios.defaults.adapter = async config => { downstream++; return {status:503,data:{detail:'ISOLATED_DOWNSTREAM_UNAVAILABLE'},headers:{},config}; };
const email = require(path.join(base,'emailService'));
email.sendDeviationAlertEmail = async () => { downstream++; return {sent:false,reason:'ISOLATED_EMAIL_DISABLED'}; };
const { app } = require(path.join(base,'server'));
const store = require(path.join(base,'premeltGate/store'));
const evidenceHeat = store.heats.add({grade:'SG-IRON',targetKg:1000,charge:[],plannedBy:'AUDIT-OPERATOR'});
const csv = require(path.join(base,'csvDataStore'));
const grades = require(path.join(base,'gradeSpecStore'));
function snapshot() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name)
    .filter(n=>!['security_events','audit_events','sessions','users','service_credentials'].includes(n));
  return { tables:Object.fromEntries(tables.map(t=>[t,db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()])),
    csv:JSON.parse(JSON.stringify(csv.getAll())), grades:JSON.parse(JSON.stringify(grades.getAllSpecs())) };
}
const cases = [], deadline = setTimeout(()=>{ fs.writeFileSync(path.join(output,'timeout.json'),JSON.stringify({cases:cases.length})); process.exit(1); },240000);
async function main() {
  const server = app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of inventory.mutations) {
      const variants = route.path.endsWith('/heats/:heatId/evidence') ? ['chemistry','laboratory'] : ['default'];
      for (const variant of variants) {
        const roles = policy(route,variant);
        for (const principal of principals) {
          if (principal.kind === 'human') principal.token = sec.createSession(principal.userId,'127.0.0.1','Stage3 audit per-cell session').sessionId;
          const expected = permitted(roles,principal);
          const requestPath = route.path.endsWith('/heats/:heatId/evidence') ? route.path.replace(':heatId',evidenceHeat.heatId)
            : route.path.replace(/:[A-Za-z]+(?:\([^)]*\))?/g,'AUDIT-NONEXISTENT');
          const body = variant === 'chemistry' ? {evidenceType:'MELT_MEASURED',values:{C:3.5,Si:2.2,Mn:0.5,P:0.02,S:0.015},units:'%'}
            : variant === 'laboratory' ? {evidenceType:'LAB_MEASURED',values:{uts_mpa:450,ys_mpa:280,elongation_pct:12,hardness_hb:200},units:'MPa, %, HB'} : {};
          const before = snapshot(), calls = downstream;
          const response = await fetch(url+requestPath,{method:route.method,headers:{'Content-Type':'application/json',...(principal.token?{Authorization:`Bearer ${principal.token}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
          const text = await response.text(); let payload; try {payload=JSON.parse(text);} catch {payload={message:text.slice(0,200)};}
          const denial = [401,403].includes(response.status);
          // Public login validates credentials (401); public logout is idempotent.
          const publicAuth = route.path === '/api/v2/auth/login' || route.path === '/api/v2/auth/logout';
          const environmentDenied = route.path === '/api/v2/premelt/demo/reset' && expected && response.status === 403 && /Demo reset is disabled/.test(payload.message || '');
          const pass = expected ? (!denial || publicAuth || environmentDenied) : denial;
          const stable = expected ? null : JSON.stringify(snapshot()) === JSON.stringify(before);
          const zeroDispatch = expected ? null : downstream === calls;
          cases.push({method:route.method,path:route.path,source:`${route.file}:${route.line}`,variant,principal:principal.name,expected:expected?'AUTHORIZATION_ACCEPTANCE':'DENY',status:response.status,code:payload.code||null,result:pass&&stable!==false&&zeroDispatch!==false?'PASS':'FAIL',unchangedBusinessValues:stable,zeroDownstreamCalls:zeroDispatch,functionality:expected?'NOT_ESTABLISHED_BY_AUTHORIZATION_PROBE':'N/A — denied principal'});
        }
      }
    }
  } finally {
    server.closeAllConnections(); await new Promise(r=>server.close(r)); clearTimeout(deadline);
    fs.writeFileSync(path.join(output,'permission-matrix.json'),JSON.stringify({cases,failures:cases.filter(c=>c.result==='FAIL'),policySource:'tools/stage3_policy.cjs; independently encoded expected responsibility map',limitations:'Positive probes establish authorization acceptance only; valid functional workflows require separate receipts.'},null,2));
  }
  const failed=cases.filter(c=>c.result==='FAIL'); console.log(`${cases.length} authorization cells, ${failed.length} failures`);
  process.exit(failed.length?1:0);
}
main().catch(e=>{console.error(e);fs.writeFileSync(path.join(output,'runner-error.txt'),e.stack);process.exit(1);});
