// AUDIT-CSRF-001: exercise real authentication, route guards and persisted stores.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helper = require('./testHelper');
helper.initTestDb();
const db = helper.getDb();
const sec = require('../security');
const auth = require('../authMiddleware');
let downstreamCalls = 0;
require('axios').defaults.adapter = async () => { downstreamCalls++; throw new Error('Prohibited downstream dispatch'); };
require('../../emailService').sendDeviationAlertEmail = async () => { downstreamCalls++; throw new Error('Prohibited email dispatch'); };
const { router } = require('../routes');
sec.createUser({userId:'CSRF-INV',username:'csrf-inventory',email:'csrf@example.invalid',displayName:'CSRF inventory',roles:['INVENTORY_CONTROLLER'],password:crypto.randomBytes(32).toString('hex')});
const session = sec.createSession('CSRF-INV');
const serviceKey = crypto.randomBytes(32).toString('hex');
sec.createServiceCredential({serviceId:'CSRF-INSTRUMENT',serviceName:'Isolated instrument',serviceType:'SPECTROMETER_SERVICE',apiKey:serviceKey,permittedEvidence:['MELT_MEASURED']});
const heat = helper.createMeltingHeat('H-CSRF');
const csrf = crypto.randomBytes(24).toString('hex');
const cookie = `metallisense_session=${session.sessionId}; metallisense_csrf=${csrf}`;
const lot = {materialType:'PIG_IRON',receivedKg:5,description:'CSRF regression',supplier:'Isolated test',declared:{C:3.5,Si:2.2,Mn:0.5,P:0.02,S:0.015}};
const app = express();app.use(express.json(),auth.authenticate,auth.csrfProtection);app.use('/premelt',router);
function snapshot() {
  const excluded = ['security_events','audit_events','sessions','users','service_credentials'];
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(r => !excluded.includes(r.name)).map(r => [r.name,db.prepare(`SELECT * FROM "${r.name}" ORDER BY rowid`).all()]));
}
async function main() {
  const rows = [], server = app.listen(0,'127.0.0.1');await new Promise(r => server.once('listening',r));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function check(name,headers,expected,route='/premelt/lots',body=lot) {
    const before = snapshot(), calls = downstreamCalls;
    const response = await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
    const payload = await response.json(), after = snapshot();
    const unchanged = JSON.stringify(before)===JSON.stringify(after);
    const zeroDownstream = calls===downstreamCalls;
    rows.push({name,status:response.status,expected,code:payload.code || null,unchangedBusinessValues:unchanged,zeroDownstreamCalls:zeroDownstream,before,after});
    assert.equal(response.status,expected,name);
    assert.equal(zeroDownstream,true,`${name}: no downstream dispatch`);
    if (expected>=400) assert.deepEqual(after,before,`${name}: rejected business mutation`);
    return payload;
  }
  try {
    await check('valid cookie, no CSRF',{Cookie:cookie},403);
    await check('cookie plus invalid Bearer, no CSRF',{Cookie:cookie,Authorization:'Bearer '+crypto.randomBytes(32).toString('hex')},403);
    await check('cookie plus valid service Bearer, no CSRF',{Cookie:cookie,Authorization:'Bearer '+serviceKey},403);
    await check('cookie plus valid human Bearer, no CSRF',{Cookie:cookie,Authorization:'Bearer '+session.sessionId},403);
    await check('cookie, incorrect CSRF',{Cookie:cookie,'X-CSRF-Token':'incorrect'},403);
    await check('cookie plus valid Bearer, incorrect CSRF',{Cookie:cookie,Authorization:'Bearer '+serviceKey,'X-CSRF-Token':'incorrect'},403);
    await check('cookie, correct CSRF',{Cookie:cookie,'X-CSRF-Token':csrf},200);
    await check('cookie plus service Bearer, correct CSRF retains human precedence',{Cookie:cookie,Authorization:'Bearer '+serviceKey,'X-CSRF-Token':csrf},200);
    await check('permitted bearer-only instrument action',{Authorization:'Bearer '+serviceKey},200,`/premelt/heats/${heat.heatId}/evidence`,{evidenceType:'MELT_MEASURED',sampleId:'CSRF-SAMPLE',units:'%',values:lot.declared});
    await check('invalid bearer-only',{Authorization:'Bearer '+crypto.randomBytes(32).toString('hex')},401);
    await check('service identity cannot create human inventory',{Authorization:'Bearer '+serviceKey},403);
    console.log(`PASS: ${rows.length} CSRF/authentication-method cases, exact rejected business values unchanged, zero downstream calls`);
  } finally {
    if (process.env.EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.EVIDENCE_DIR,'csrf-auth-method-results.json'),JSON.stringify({rows,downstreamCalls,credentials:'omitted'},null,2));
    server.closeAllConnections();await new Promise(r => server.close(r));helper.closeDb();
  }
}
main().catch(e => {console.error(e);process.exitCode=1;});
