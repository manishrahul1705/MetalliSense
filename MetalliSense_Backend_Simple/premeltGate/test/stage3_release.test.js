const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const helper = require('./testHelper');
helper.initTestDb();
const sec = require('../security');
const { authenticate, csrfProtection } = require('../authMiddleware');
const { router } = require('../routes');
const salesRoutes = require('../salesRoutes');
const db = helper.getDb();
const chemistry = { C:3.5,Si:2.2,Mn:0.5,P:0.02,S:0.015 };
const mechanical = { uts_mpa:450,ys_mpa:280,elongation_pct:12,hardness_hb:200 };
const key = crypto.randomBytes(32).toString('hex');
sec.createServiceCredential({serviceId:'RELEASE-INSTRUMENT',serviceName:'Isolated instrument',serviceType:'SPECTROMETER_SERVICE',apiKey:key,permittedEvidence:['MELT_MEASURED']});
for (const id of ['QA-REVIEWER','OTHER-QA']) sec.createUser({userId:id,username:id.toLowerCase(),email:`${id}@example.invalid`,displayName:id,password:crypto.randomBytes(32).toString('hex'),roles:['QUALITY_MANAGER']});
const heat=helper.createMeltingHeat('H-STAGE3-RELEASE');
const app=express(); app.use(express.json(),authenticate,csrfProtection);app.use('/premelt',router);app.use('/sales',salesRoutes);
function state() { return Object.fromEntries(['heats','evidence','movements','maker_checker_reviews','lots'].map(t=>[t,db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()])); }
async function main() {
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 async function post(route,body,actor='QA-REVIEWER') {
   const headers={'Content-Type':'application/json',...(actor==='instrument'?{Authorization:`Bearer ${key}`}:{'x-test-user-id':actor})};
   const r=await fetch(url+route,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});return {status:r.status,body:await r.json()};
 }
 try {
  let before=state();
  assert.equal((await post(`/sales/heats/${heat.heatId}/complete`,{composition:chemistry,mechanical,approvedBy:'Forged',standard:{}})).status,422);
  assert.deepEqual(state(),before,'Client chemistry/lab cannot manufacture release evidence');
  const sample=await post(`/premelt/heats/${heat.heatId}/evidence`,{evidenceType:'MELT_MEASURED',sampleId:'BOUND-INITIAL',units:'%',values:chemistry},'instrument');assert.equal(sample.status,200);
  before=state();assert.equal((await post(`/sales/heats/${heat.heatId}/complete`,{composition:chemistry,mechanical})).status,422);assert.deepEqual(state(),before);
  const lab=await post(`/premelt/heats/${heat.heatId}/evidence`,{evidenceType:'LAB_MEASURED',sampleId:'BOUND-LAB',units:'MPa, %, HB',values:mechanical});assert.equal(lab.status,200);
  const linked=db.prepare('SELECT * FROM evidence WHERE evidence_id = ?').get(lab.body.data.evidenceId);
  assert.equal(linked.parent_evidence_id,sample.body.data.evidenceId);assert.equal(linked.heat_version,heat.version);
  const newer=await post(`/premelt/heats/${heat.heatId}/evidence`,{evidenceType:'MELT_MEASURED',sampleId:'BOUND-NEWER',units:'%',values:chemistry},'instrument');assert.equal(newer.status,200);
  before=state();assert.equal((await post(`/sales/heats/${heat.heatId}/complete`,{composition:chemistry,mechanical})).status,422);assert.deepEqual(state(),before,'QA on older chemistry cannot release a newer sample');
  console.log('PASS: real HTTP release rejects manufactured physical evidence, missing persisted QA and QA linked to an older sample; exact rows unchanged');
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));helper.closeDb();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
