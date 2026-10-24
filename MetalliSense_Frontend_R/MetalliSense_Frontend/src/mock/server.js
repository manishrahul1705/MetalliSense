import { sha1 } from './sha1.js';
import axios from 'axios';
import { trainingSeed } from './seed.js';
import { createAI } from './handlers/ai.js';
import { createInstruments, parseCSV } from './handlers/instruments.js';
import { loadState, saveState, clearState } from './db.js';
const factories = import.meta.glob(['./handlers/**/*.js', '!./handlers/ai.js', '!./handlers/mechanical.js', '!./handlers/instruments.js', '!./handlers/optimizer.js'], { eager: true, import: 'default' });
const cache = new Map();
let application, ai, instruments, extra, saving;
function Router() {
 const routes=[];
 const router={routes};
 for(const method of ['get','post','put','patch','delete']) router[method]=(path,...handlers)=>{routes.push({method:method.toUpperCase(),path,handler:handlers.at(-1)});return router;};
 router.use=(prefix,child)=>{if(typeof prefix==='string' && child?.routes)for(const r of child.routes) routes.push({...r,path:prefix+(r.path==='/'?'':r.path)});return router;};
 return router;
}
const express=Object.assign(()=>Router(),{Router,json:()=>()=>{},text:()=>()=>{}});
function resolve(from,name){
 if(!name.startsWith('.'))return name;
 const parts=from.split('/');parts.pop();
 for(const part of name.split('/')){if(part==='..')parts.pop();else if(part!=='.')parts.push(part);}
 return parts.join('/').replace(/\.js$/,'');
}
export function requirePort(name,from=''){
 const id=resolve(from,name);
 if(id==='express')return express;
 if(id==='seed')return {trainingSeed};
 if(id==='csv-parse/sync')return {parse:parseCSV};
 if(id==='axios')return Object.assign(async c=>internalRequest(c.method,c.url,c.data),{get:(u)=>internalRequest('GET',u),post:(u,b)=>internalRequest('POST',u,b)});
 if(id==='crypto')return {createHash:()=>({update(raw){this.raw=raw;return this;},digest(){return sha1(this.raw);}})};
 if(id==='opcuaService')return instruments.spectrometer;
 if(id==='premeltGate/gunService')return instruments.gun;
 if(id==='emailService')return {isConfigured:()=>false,shouldTriggerEmail:s=>['MEDIUM','HIGH','moderate','severe'].includes(s),sendDeviationAlertEmail:async b=>{outbox('Deviation '+b.severity,b.batchId||b.grade,JSON.stringify(b));return {sent:false,queued:true,reason:'Saved to browser demo Outbox; no email sent'};}};
 if(cache.has(id))return cache.get(id).exports;
 const factory=factories['./handlers/'+id+'.js'];
 if(!factory)throw new Error('Browser module missing: '+id);
 const module={exports:{}};cache.set(id,module);factory(module,n=>requirePort(n,id));return module.exports;
}
export function outbox(subject,ref,body){
 const message={id:crypto.randomUUID(),recipient:'Demo plant supervisor',subject,body,ref,time:new Date().toISOString()};extra.outbox.unshift(message);
 window.dispatchEvent(new CustomEvent('mock-alert',{detail:message}));return message;
}
function pathMatch(pattern,path){
 const keys=[];const expression=pattern.split('/').map(part=>{
  if(part.startsWith(':')){const wild=part.includes('(*)');keys.push(part.slice(1).replace('(*)',''));return wild?'(.+)':'([^/]+)';}
  return part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 }).join('/');
 const match=path.match(new RegExp('^'+expression+'/?$'));
 return match?Object.fromEntries(keys.map((k,i)=>[k,decodeURIComponent(match[i+1])])):null;
}
export async function dispatch(method,url,body){
 const u=new URL(url,globalThis.location?.href||'http://browser/');const path=u.pathname;method=method.toUpperCase();
 if(path==='/__mock/optimize'){
  try { const {solveCharge}=await import('./handlers/optimizer.js');const st=requirePort('premeltGate/store'),plan=st.heats.list().find(h=>h.grade===body.grade&&h.status==='PLANNED'),baseline=plan?plan.charge.reduce((s,l)=>s+l.kg*(st.getLot(l.lotId)?.costPerKg||0),0)*Number(body.targetKg)/plan.targetKg:0;st.log('CHARGE_RECOMMENDATION',body.grade,'demo planner','Optimized '+body.targetKg+' kg charge');const response={status:200,data:{status:'success',data:solveCharge({...body,currentPlanCost:body.currentPlanCost??baseline},st.listLots().map(l=>({...l,availableKg:st.availableKg(l.lotId)})),requirePort('premeltGate/config'),requirePort('premeltGate/chemistry'))}};await persist();return response; } catch(e) {return {status:422,data:{message:e.message}};}
 }
 if(path==='/__mock/accept-strategy'){
  const st=requirePort('premeltGate/store'),h=st.heats.get(body.heatId),b=body;
  if(!h||h.status!=='MELTING')return {status:409,data:{message:'A melting heat is required'}};
  if(h.acceptedStrategy){if(h.acceptedStrategy.strategy!==b.candidate.strategy)return {status:409,data:{message:'A strategy was already applied to this heat'}};return {status:200,data:{status:'success',data:h.acceptedStrategy}};}
  const additions=b.candidate.recommended_additions||{},mass=h.gate.prediction.metalKg;
  if(Object.entries(additions).some(([e,v])=>!['Fe','C','Si','Mn','P','S'].includes(e)||!Number.isFinite(v)||v<0))return {status:422,data:{message:'Strategy additions must be finite nonnegative element percentages'}};
  if(Object.entries(additions).some(([e,v])=>['P','S'].includes(e)&&v>0))return {status:409,data:{message:'No approved inventory source for adding phosphorus or sulfur'}};
  const lines=requirePort('premeltGate/additives').suggest(additions,mass);
  if(additions.Fe>0){const lot=st.listLots().find(l=>l.materialType==='PIG_IRON'&&l.status==='RELEASED'&&st.availableKg(l.lotId)>0);if(!lot)return {status:409,data:{message:'No released pig iron available for the accepted Fe addition'}};const kg=mass*additions.Fe/100/((requirePort('premeltGate/chemistry').lotChemistry(lot).composition.Fe||94)/100);lines.push({lotId:lot?.lotId,kg,inStock:!!lot&&kg<=st.availableKg(lot.lotId),element:'Fe'});}
  if(lines.some(l=>!l.lotId||!l.inStock||!Number.isFinite(l.kg)||l.kg<=0||l.kg>st.availableKg(l.lotId)))return {status:409,data:{message:'Accepted strategy cannot be applied: insufficient released additive stock'}};
  const before=structuredClone(st.snapshot()),oldExtra=structuredClone(extra);
  try {
   for(const l of lines)st.addMovement({lotId:l.lotId,kg:-l.kg,type:'ADDITION',heatId:h.heatId,by:'operator',note:'Accepted '+b.candidate.strategy});
   h.acceptedStrategy={...b.candidate,deductedLines:lines};h.correctionReading=b.composition;h.currentComposition={...b.composition};h.postCorrectionTicks=0;
   ai.feedback({grade:h.grade,composition:b.composition,additions,aggressiveness:b.candidate.aggressiveness,outcome:'accepted',heatId:h.heatId});
   st.log('STRATEGY_ACCEPTED',h.heatId,'operator',b.candidate.strategy+'; accepted candidate quantities deducted');await persist();return {status:200,data:{status:'success',data:h.acceptedStrategy}};
  } catch(e){st.restore(before);extra=oldExtra;return {status:409,data:{message:e.message}};}
 }
 if(path==='/api/v2/auth/me'){const user=extra.currentUser||{id:'operator1',username:'operator1',email:'operator1@metallisense.local',role:'OPERATOR',fullName:'Furnace Operator 1',roles:['OPERATOR']};return {status:200,data:{status:'success',data:{user}}};}
 if(path==='/api/v2/auth/login'){const uName=body?.username||'operator1';const r=uName.includes('qm')?'QUALITY_MANAGER':(uName.includes('admin')?'ADMIN':(uName.includes('metallurgist')?'METALLURGIST':(uName.includes('inventory')?'INVENTORY_MANAGER':'OPERATOR')));const user={id:uName,username:uName,email:uName+'@metallisense.local',role:r,fullName:'Demo '+r,roles:[r]};extra.currentUser=user;await persist();return {status:200,data:{status:'success',data:{user,message:'Logged in successfully'}}};}
 if(path==='/api/v2/auth/logout'){extra.currentUser=null;await persist();return {status:200,data:{status:'success',data:{message:'Logged out successfully'}}};}
 if(path==='/api/v2/auth/csrf'){return {status:200,data:{status:'success',data:{csrfToken:'mock-csrf-token'}}};}
 if(path==='/api/v2/sales/orders')return {status:200,data:{status:'success',data:extra.orders}};
 if(path==='/api/v2/alerts/send-email'){const message=outbox('Deviation '+body.severity,body.batchId||body.grade,JSON.stringify(body));await persist();return {status:200,data:{status:'success',data:{sent:false,queued:true,message}}};}
 if(path==='/__mock/state')return {status:200,data:{store:requirePort('premeltGate/store').snapshot(),extra}};
 if(path==='/__mock/reset'||path==='/api/v2/premelt/demo/reset'){await reset();return {status:200,data:{status:'success',data:{reset:true}}};}
 // The browser reads instrument downloads with fetch, never a remote navigation.
 let route=application.routes.find(r=>r.method===method&&pathMatch(r.path,path));
 let result;
 if(route){
  const req={body:body??{},params:pathMatch(route.path,path),query:Object.fromEntries(u.searchParams),headers:{},get:()=>''};
  const res={statusCode:200,headers:{},headersSent:false,status(n){this.statusCode=n;return this;},set(k,v){this.headers[k]=v;return this;},header(k,v){return this.set(k,v);},type(t){this.headers['Content-Type']=t;return this;},attachment(n){this.headers['Content-Disposition']='attachment; filename="'+n+'"';return this;},json(data){this.data=data;this.headersSent=true;return this;},send(data){this.data=data;this.headersSent=true;return this;},end(){this.headersSent=true;return this;}};
  try{await route.handler(req,res);result={status:res.statusCode,data:res.data,headers:res.headers};}catch(e){result={status:e.status||500,data:{status:'error',message:e.message}};}
 }else result=await ai.handle(method,path,body??{},Object.fromEntries(u.searchParams));
 if(!result)result={status:404,data:{status:'fail',message:'Unimplemented browser route: '+method+' '+path}};
 if(result.status<400 && method!=='GET') {
  const store=requirePort('premeltGate/store');
  if(/analyze|predict|optimize|recommend|explain/.test(path))store.log('RECOMMENDATION',body?.heatId||body?.grade||body?.metalGrade||path,'demo decision support',method+' '+path);
  if(path==='/api/v2/sales/invoices'){const order=extra.orders.find(o=>o.id===body.poNumber);if(order){order.status='INVOICED';order.heatId=body.heatId;order.invoiceId=result.data?.data?.invoiceId;}}
  if(path==='/api/v2/alerts/simulate'){const a=result.data?.data;if(a)outbox(a.subject,body.batchId||body.grade,a.body);}
  if(path.includes('gate-check')){const g=result.data?.data;if(g?.decision==='HOLD')outbox('Heat HOLD',g.heatId,g.blocking.join('\n'));}
  for(const lot of store.listLots())if(lot.status==='QUARANTINED'&&!extra.notifiedLots.includes(lot.lotId)){extra.notifiedLots.push(lot.lotId);outbox('Lot quarantined',lot.lotId,lot.statusReason);}
 }
 // Reads may mutate lazy energy/cache state, so persist after every settled call.
 await persist();return result;
}
async function internalRequest(method,url,body){const r=await dispatch(method,url,body);if(r.status>=400)throw Object.assign(new Error(r.data?.message||r.data?.detail||'Request failed'),{response:{status:r.status,data:r.data}});return {status:r.status,data:r.data};}
export async function persist(){
 if(!extra)return;
 const modules={};for(const [id,m] of cache)if(m.exports.snapshot)modules[id]=m.exports.snapshot();
 const state={modules,extra};saving=saveState(state);await saving;
 window.dispatchEvent(new Event('mock-state'));
}
export async function reset(){
 instruments?.stop();await clearState();cache.clear();extra={outbox:[],notifiedLots:[],memory:[],chat:[],feedback:[],reward:null,activeHeat:null,readings:[],orders:[{id:'SO-1001',customerId:'CUST-01',grade:'SG-IRON',qtyKg:650,status:'OPEN'}]};
 instruments=createInstruments(requirePort,()=>extra,persist,outbox);ai=await createAI(requirePort,()=>extra,outbox);application=requirePort('server');instruments.start();
 sessionStorage.removeItem('metallisense.meltFlow.v1');localStorage.removeItem('metallisense.demo.chat');await persist();
}
export function demoState(){return extra;}
export async function startMock(){
 const stored=await loadState();extra=stored?.extra||{outbox:[],notifiedLots:[],memory:[],chat:[],feedback:[],reward:null,activeHeat:null,readings:[],orders:[{id:'SO-1001',customerId:'CUST-01',grade:'SG-IRON',qtyKg:650,status:'OPEN'}]};
 instruments=createInstruments(requirePort,()=>extra,persist,outbox);ai=await createAI(requirePort,()=>extra,outbox);application=requirePort('server');
 if(stored)for(const [id,s]of Object.entries(stored.modules)){requirePort(id).restore?.(s);}
 instruments.start();
 const originalFetch=window.fetch.bind(window);
 const intercepted=async(input,init={})=>{
  const url=typeof input==='string'?input:input.url;const u=new URL(url,location.href);
  const api=/^\/(api\/|copilot\/|rl\/|vector\/|premelt\/|anomaly\/|alloy\/|agents\/|mechanical\/|semantic-search|health|reindex|__mock\/|analyze-with-explanation)/.test(u.pathname);
  if(!api && u.origin===location.origin)return originalFetch(input,init);
  if(!api)throw new TypeError('Demo mode blocks external request: '+u.pathname);
  if(init.signal?.aborted)throw new DOMException('Aborted','AbortError');
  await new Promise(r=>setTimeout(r,150+Math.random()*450));
  let body=init.body;if(typeof body==='string' && body.trim().startsWith('{')){try{body=JSON.parse(body);}catch{/* CSV handled as text */}}
  const r=await dispatch(init.method||input.method||'GET',u.href,body);
  const headers={'Content-Type':'application/json',...r.headers};
  return new Response(r.status===204?null:typeof r.data==='string'?r.data:JSON.stringify(r.data),{status:r.status,headers});
 };
 window.fetch=intercepted;
 axios.defaults.adapter=async config=>{
  const base=(config.baseURL||'').replace(/\/$/,'');let url=/^https?:/.test(config.url)?config.url:base+'/'+config.url.replace(/^\//,'');
  const u=new URL(url,location.href);for(const [k,v]of Object.entries(config.params||{}))if(v!=null)u.searchParams.set(k,v);
  const response=await intercepted(u.href,{method:config.method,body:config.data,signal:config.signal});
  const data=response.status===204?null:config.responseType==='blob'?await response.blob():await response.json();
  const result={data,status:response.status,statusText:response.statusText,headers:Object.fromEntries(response.headers),config,request:{mock:true}};
  if(!(config.validateStatus||((s)=>s>=200&&s<300))(result.status))throw new axios.AxiosError(data.message||data.detail||'Mock request failed',null,config,result.request,result);
  return result;
 };
 window.__METALLISENSE_MOCK__={dispatch,reset,requirePort,state:demoState,persist};
 window.addEventListener('pagehide',()=>{instruments.stop();});
 await persist();
 document.addEventListener('click',async e=>{const a=e.target.closest('a');if(a?.href.includes('/gun/sessions/')&&a.href.endsWith('/csv')){e.preventDefault();const r=await intercepted(a.href);const url=URL.createObjectURL(await r.blob());const link=document.createElement('a');link.href=url;link.download='inspection.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}});
}
