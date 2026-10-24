import modelFixtures from './model-fixtures.json';
import { beforeAll,afterAll,beforeEach,describe,it,expect } from 'vitest';
import { createRequire } from 'node:module';
import { startMock,dispatch,requirePort,reset } from '../src/mock/server.js';
import { solveCharge } from '../src/mock/handlers/optimizer.js';
import { alloy,anomaly } from '../src/mock/handlers/ai.js';
const saved=new Map();
globalThis.localStorage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
globalThis.sessionStorage={removeItem:()=>{}};
globalThis.window=new EventTarget();window.fetch=globalThis.fetch;window.SpeechRecognition=null;
globalThis.document={addEventListener:()=>{}};globalThis.location={href:'http://static.local/',origin:'http://static.local'};window.location=globalThis.location;
beforeAll(async()=>{await startMock();});
const grade='SG-IRON';
const config={GRADE_SPECS:{[grade]:{C:[3,4],Si:[1.8,2.8],Mn:[.3,1],P:[0,.08],S:[0,.03]}},RESIDUAL_LIMITS:{[grade]:{Cu:.2}}};
const middle={C:3.5,Si:2.3,Mn:.65,P:.02,S:.01,Cu:.05};
const lot=(id,cost=30,kg=1000,comp=middle,status='RELEASED')=>({lotId:id,costPerKg:cost,availableKg:kg,declared:comp,status,chemistrySource:'LAB'});
const chem={lotChemistry:l=>({yield:1,composition:l.declared}),predictMeltdown:lines=>({metalKg:lines.reduce((s,l)=>s+l.kg,0),composition:Object.fromEntries(Object.keys(middle).map(e=>[e,lines.reduce((s,l)=>s+l.kg*l.lot.declared[e],0)/lines.reduce((s,l)=>s+l.kg,0)]))})};
const solve=(lots,options={})=>solveCharge({grade,targetKg:1000,...options},lots,config,chem);
describe('charge optimizer: 12 constraint and input cases',()=>{
 it('finds the cheapest feasible mix',()=>{const r=solve([lot('A'),lot('B',50)]);expect(r.feasible).toBe(true);expect(r.candidates[0].charge[0].lotId).toBe('A');});
 it('preserves exact target mass',()=>expect(solve([lot('A')]).candidates[0].charge.reduce((s,l)=>s+l.kg,0)).toBeCloseTo(1000));
 it('respects stock limits',()=>{const r=solve([lot('A',30,400),lot('B',50)]);expect(r.candidates[0].charge.find(l=>l.lotId==='A').kg).toBeCloseTo(400);});
 it('excludes quarantined lots',()=>expect(solve([lot('A',1,1000,middle,'QUARANTINED'),lot('B')]).candidates[0].charge.every(l=>l.lotId!=='A')).toBe(true));
 it('excludes QA hold lots',()=>expect(solve([lot('A',1,1000,middle,'HOLD')]).feasible).toBe(false));
 it('limits restricted lot share',()=>{const a=lot('A',1,1000,middle,'RESTRICTED');a.restriction={maxSharePct:20};expect(solve([a,lot('B')]).candidates[0].charge.find(l=>l.lotId==='A').kg).toBeCloseTo(200);});
 it('enforces 10 percent safety margin',()=>expect(solve([lot('A',30,1000,{...middle,C:3.01})]).feasible).toBe(false));
 it('enforces residual caps',()=>expect(solve([lot('A',30,1000,{...middle,Cu:.3})]).feasible).toBe(false));
 it('explains insufficient stock',()=>{const r=solve([lot('A',30,10)]);expect(r.feasible).toBe(false);expect(r.blockingConstraint).toMatch(/stock/);});
 it('changes selection when prices change',()=>expect(solve([lot('A',50),lot('B',10)]).candidates[0].charge[0].lotId).toBe('B'));
 it('offers an alternative without the main lot',()=>{const r=solve([lot('A'),lot('B',50)]);expect(r.candidates[2].charge.every(l=>l.lotId!=='A')).toBe(true);});
 it('rejects invalid weight and unknown grade',()=>{expect(()=>solve([lot('A')],{targetKg:-1})).toThrow();expect(()=>solve([lot('A')],{grade:'UNKNOWN'})).toThrow();});
});
describe('gate parity and interlocks',()=>{
 it('matches Node checks and verdict with the same risk assessment for three heats',async()=>{
  const nodeRequire=createRequire(new URL('../../../MetalliSense_Backend_Simple/server.js',import.meta.url));
  const nodeStore=nodeRequire('./premeltGate/store'),nodeGate=nodeRequire('./premeltGate/gateEngine'),nodeAxios=nodeRequire('axios');
  const original=nodeAxios.post;nodeAxios.post=async(u,b)=>{const r=await dispatch('POST','http://local/premelt/assess',b);return {data:r.data};};
  try{for(const charge of [[],[{lotId:'PIG-0901',kg:1000}],[{lotId:'PIG-0901',kg:400},{lotId:'RET-1043',kg:600}]]){
   const data={grade,targetKg:1000,charge,status:'PLANNED',gate:null,gateHistory:[]};const a=nodeStore.heats.add(structuredClone(data)),b=requirePort('premeltGate/store').heats.add(structuredClone(data));
   const real=await nodeGate.runGate(a.heatId),mock=await requirePort('premeltGate/gateEngine').runGate(b.heatId);
   expect(mock.decision).toBe(real.decision);expect(mock.fingerprint).toBe(real.fingerprint);expect(mock.checks).toEqual(real.checks);expect(mock.prediction).toEqual(real.prediction);
  }}finally{nodeAxios.post=original;}
 });
 it('requires a current gate and operator before start',()=>{const st=requirePort('premeltGate/store'),h=st.heats.add({grade,targetKg:1000,charge:[],status:'PLANNED',gate:null,gateHistory:[]});expect(()=>requirePort('premeltGate/gateEngine').startMelting(h.heatId,{})).toThrow(/Operator/);expect(()=>requirePort('premeltGate/gateEngine').startMelting(h.heatId,{operator:'Tester'})).toThrow(/pre-melt/);});
 it('persists mutations, has no 500 event audit cap',async()=>{const st=requirePort('premeltGate/store');for(let i=0;i<550;i++)st.log('TEST','unit','tester','event '+i);await dispatch('GET','http://static.local/api/v2/premelt/audit?limit=9999');expect(st.audit().length).toBeGreaterThan(500);expect(saved.get('metallisense.browser-demo.v1')).toContain('event 549');});
 it('never deducts a planned heat before human approval',async()=>{const st=requirePort('premeltGate/store'),before=st.availableKg('PIG-0901');const r=await dispatch('POST','http://local/api/v2/premelt/heats',{grade,targetKg:1000,charge:[{lotId:'PIG-0901',kg:1000}]});expect(r.status).toBe(200);expect(st.availableKg('PIG-0901')).toBe(before);});
});

describe('exported model numerical parity',()=>{
 for(const sample of modelFixtures)it(sample.grade+' '+sample.case,async()=>{
  const a=await anomaly(sample.grade,sample.composition),c=await alloy(sample.grade,sample.composition);
  expect(a.raw_score).toBeCloseTo(sample.anomaly.raw_score,6);
  expect(a.anomaly_score).toBeCloseTo(sample.anomaly.anomaly_score,6);
  expect(a.severity).toBe(sample.anomaly.severity);
  expect(c.recommended_additions).toEqual(sample.alloy.recommended_additions);
  expect(c.confidence).toBeCloseTo(sample.alloy.confidence,6);
 });
});

describe('stock transaction safeguards',()=>{
 it('prevalidates all deduction lines without partial mutation',async()=>{
  const st=requirePort('premeltGate/store'),before=st.availableKg('ALY-0903');
  const r=await dispatch('POST','http://local/api/v2/premelt/additives/deduct',{lines:[{lotId:'ALY-0903',kg:10},{lotId:'missing',kg:1}]});
  expect(r.status).toBeGreaterThanOrEqual(400);expect(st.availableKg('ALY-0903')).toBe(before);
 });
 it('rejects cumulative duplicate-lot demand and nonpositive kg',async()=>{
  const st=requirePort('premeltGate/store'),before=st.availableKg('ALY-0903');
  const r=await dispatch('POST','http://local/api/v2/premelt/additives/deduct',{lines:[{lotId:'ALY-0903',kg:before*.6},{lotId:'ALY-0903',kg:before*.6}]});expect(r.status).toBe(409);expect(st.availableKg('ALY-0903')).toBe(before);
  const bad=await dispatch('POST','http://local/api/v2/premelt/additives/deduct',{lines:[{lotId:'ALY-0903',kg:-1}]});expect(bad.status).toBe(400);
 });
 it('rejects impossible accepted strategy before stock or learning changes',async()=>{
  const st=requirePort('premeltGate/store'),before=st.availableKg('PIG-0901'),h=st.heats.add({grade,targetKg:1000,status:'MELTING',charge:[],gate:{prediction:{metalKg:1000}},gateHistory:[]});
  const updates=(await dispatch('GET','http://local/rl/policy/status')).data.n_updates;
  const r=await dispatch('POST','http://local/__mock/accept-strategy',{heatId:h.heatId,composition:middle,candidate:{strategy:'balanced',aggressiveness:1,recommended_additions:{Fe:100000}}});
  expect(r.status).toBe(409);expect(st.availableKg('PIG-0901')).toBe(before);expect(h.acceptedStrategy).toBeUndefined();expect((await dispatch('GET','http://local/rl/policy/status')).data.n_updates).toBe(updates);
 });
});

it('RL candidates clamp all negative additions to zero (induction furnace invariant)',async()=>{
 const r=await dispatch('POST','http://local/rl/optimize',{grade:'SG-IRON',composition:{Fe:90,C:4.3,Si:2.9,Mn:.8,P:.03,S:.01}});
 for(const c of r.data.candidates){
  for(const [el,v] of Object.entries(c.recommended_additions)){
   expect(v).toBeGreaterThan(0);
  }
 }
});

it('RL candidates explicitly exclude unsupported impurity additions before approval',async()=>{
 const r=await dispatch('POST','http://local/rl/optimize',{grade:'SG-IRON',composition:{Fe:93,C:2.9,Si:1.7,Mn:.2,P:.035,S:.013}});
 for(const c of r.data.candidates){expect(c.recommended_additions.P||0).toBe(0);expect(c.recommended_additions.S||0).toBe(0);if(c.excluded_additions.S)expect(c.constraint_violations.S).toMatch(/Excluded/);}
});
it('feedback changes persisted reward weights and candidate scores',async()=>{
 const b={grade:'SG-IRON',composition:{Fe:93,C:2.9,Si:1.7,Mn:.2,P:.035,S:.013}},before=(await dispatch('POST','http://local/rl/optimize',b)).data;
 const candidate=before.candidates.find(c=>c.strategy==='balanced'),updates=before.policy_status.n_updates;
 const response=await dispatch('POST','http://local/rl/feedback',{...b,additions:candidate.recommended_additions,aggressiveness:1,outcome:'rejected'});
 expect(response.data.policy_status.n_updates).toBe(updates+1);
 const after=(await dispatch('POST','http://local/rl/optimize',b)).data;
 expect(after.candidates.map(c=>c.predicted_reward)).not.toEqual(before.candidates.map(c=>c.predicted_reward));
 expect(JSON.parse(saved.get('metallisense.browser-demo.v1')).extra.reward.n_updates).toBe(updates+1);
});
