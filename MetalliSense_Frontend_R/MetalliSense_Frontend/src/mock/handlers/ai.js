import { scale,evaluate,isolation } from '../models/evaluator.js';
import specs from '../models/grade-model-specs.json';
import thresholds from '../models/thresholds.json';
import { STANDARDS,predictFromChemistry } from './mechanical.js';
const E=['Fe','C','Si','Mn','P','S'];
const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));
const round=v=>Math.round(v*10000)/10000;
let alloyModel,anomalyModel;
export async function alloy(grade,c){
 alloyModel ||= (await import('../models/alloy.json')).default;
 const m=alloyModel,ranges=specs[grade]?.composition_ranges;
 if(!(grade in m.grade_encodings))return {recommended_additions:{},confidence:0,message:'Unknown grade: '+grade,warning:'Grade not in training data: '+grade};
 const out=E.filter(e=>{const [lo,hi]=ranges[e];return c[e]<lo-(hi-lo)*.05||c[e]>hi+(hi-lo)*.05;});
 if(!out.length)return {recommended_additions:{},confidence:1,message:'Composition is within specification. No corrections needed.',warning:null};
 const prediction=evaluate(m.model,scale(m.scaler_X,[m.grade_encodings[grade],...E.map(e=>Number(c[e])||0)]));
 const additions={};E.forEach((e,i)=>{const value=clamp(prediction[i]*m.scaler_y.scale[i]+m.scaler_y.mean[i],0,5);if(value>.01)additions[e]=round(value);});
 if(!Object.keys(additions).length&&out.some(e=>c[e]>ranges[e][1]))return {recommended_additions:{Fe:1},confidence:.7,message:'Elements too high. Dilution recommended.',warning:'Excess elements require blending or re-melting.'};
 const total=Object.values(additions).reduce((s,v)=>s+v,0);
 const deviation=E.reduce((s,e)=>s+Math.abs(c[e]-(ranges[e][0]+ranges[e][1])/2),0);
 const confidence=clamp(.4*(1-Math.min(total/5,1))+.3*(1-Object.keys(additions).length/6)+.3*(1-Math.min(deviation/10,1)));
 return {recommended_additions:additions,confidence,message:!total?'Composition is close to target. No significant additions needed.':confidence>=.8?'High confidence recommendation. Additions should bring composition into spec.':confidence>=.6?'Moderate confidence. Consider verifying with metallurgical expert.':'Low confidence. Large corrections needed. Manual review recommended.',warning:total>3?'Large total addition required (>3%). Consider re-melting or blending.':confidence<.5?'Confidence below threshold (0.5). Use with caution.':null};
}
export async function anomaly(grade,c){
 anomalyModel ||= (await import('../models/anomaly.json')).default;const m=anomalyModel,ranges=specs[grade]?.composition_ranges;
 const x=E.map(e=>Number(c[e])||0);
 if(m.scaler.mean.length>6)for(const e of E){const range=ranges?.[e];x.push(range?(c[e]-(range[0]+range[1])/2)/(range[1]-range[0]||1):0,range&&(c[e]<range[0]||c[e]>range[1])?1:0);}
 const raw=isolation(m.model,scale(m.scaler,x)),score=clamp((m.score_max-raw)/(m.score_max-m.score_min));
 const severity=score<thresholds.MEDIUM?'LOW':score<thresholds.HIGH?'MEDIUM':'HIGH';
 return {raw_score:raw,anomaly_score:score,score,is_anomaly:raw<m.model.offset,severity,message:severity==='LOW'?'Composition appears normal with expected characteristics.':severity==='MEDIUM'?'Moderate anomaly detected. Consider verifying sensor calibration.':'High anomaly detected. Potential sensor drift or unstable melt chemistry.'};
}
// The per-grade uncertainty classifier is approximated by smooth distance to spec.
export function risk(grade,c,uncertainty={}){
 const ranges=specs[grade]?.composition_ranges||{};const drivers=Object.entries(ranges).filter(([e])=>e!=='Fe').map(([e,[lo,hi]])=>{const width=hi-lo||.01,mid=(lo+hi)/2,z=Math.abs((c[e]??mid)-mid)/width;return {element:e,value:c[e]??mid,normal_mean:mid,impact:clamp((z-.3)*2),risk_drop_if_normal:clamp((z-.3)*2),z};}).sort((a,b)=>b.impact-a.impact);
 const z=Math.max(0,...drivers.map(d=>d.z+(uncertainty[d.element]||0)/(ranges[d.element][1]-ranges[d.element][0]||.01)));
 const p=1/(1+Math.exp(-10*(z-.75)));
 return {risk:p,risk_band_p10_p90:[clamp(p-.07),clamp(p+.07)],drivers,approximation:'Distance-to-spec logistic model; not the Python classifier'};
}
const limits={Fe:5,C:1.5,Si:1.5,Mn:1,P:.05,S:.05},costWeights={Fe:1,C:2,Si:3,Mn:4,P:6,S:6};
const cost=a=>Object.entries(a).reduce((s,[e,v])=>s+Math.abs(v)*(costWeights[e]||1),0);
const distance=(grade,c)=>Object.entries(specs[grade]?.composition_ranges||{}).reduce((s,[e,[lo,hi]])=>s+Math.abs((c[e]??(lo+hi)/2)-(lo+hi)/2)/(hi-lo||.000001),0);
export async function createAI(req,state,notify){
 const initial=(await import('../models/reward.json')).default,boot=(await import('../models/reward-state.json')).default;
 state().reward ||= {...structuredClone(initial),known_grades:boot.known_grades,n_updates:boot.n_updates,fitted:boot.fitted,reward_history:[]};
 const status=()=>({fitted:true,n_updates:state().reward.n_updates,known_grades:state().reward.known_grades,avg_reward_last_100:state().reward.reward_history.length?state().reward.reward_history.slice(-100).reduce((s,v)=>s+v,0)/Math.min(100,state().reward.reward_history.length):null,reward_trend:state().reward.reward_history.slice(-50)});
 const deviation=(grade,c)=>Object.fromEntries(E.map(e=>[e,(c[e]||0)-((specs[grade]?.composition_ranges[e]?.[0]||0)+(specs[grade]?.composition_ranges[e]?.[1]||0))/2]));
 const features=(grade,c,a,ag)=>[...E.map(e=>deviation(grade,c)[e]),...E.map(e=>a[e]||0),...state().reward.known_grades.map(g=>g===grade?1:0),ag,Object.values(a).reduce((s,v)=>s+Math.abs(v),0)];
 async function optimize(b){
  const grade=b.grade,c=b.composition,base=await alloy(grade,c);const candidates=[];
  for(const [strategy,aggressiveness]of Object.entries({conservative:.3,balanced:1,aggressive:2})){
   let a=Object.fromEntries(E.map(e=>[e,clamp((base.recommended_additions[e]||0)*aggressiveness,0,limits[e])]));const total=Object.values(a).reduce((s,v)=>s+Math.abs(v),0);if(total>6)a=Object.fromEntries(Object.entries(a).map(([e,v])=>[e,v*6/total]));
   const flags={},excluded_additions={};for(const e of ['P','S'])if(a[e]>0){excluded_additions[e]=round(a[e]);a[e]=0;flags[e]='Excluded: no approved inventory additive for '+e+'; review charge chemistry';}for(const e of E)if(Math.abs(a[e])>=limits[e]-1e-9)flags[e]='Hit max single-pass addition limit ('+limits[e]+'%)';if(total>=6)flags._total='Hit max total addition limit (6%)';
   candidates.push({strategy,aggressiveness,excluded_additions,recommended_additions:Object.fromEntries(Object.entries(a).filter(([,v])=>v>1e-6).map(([e,v])=>[e,round(v)])),predicted_reward:round(evaluate(state().reward,features(grade,c,a,aggressiveness))),estimated_cost:round(cost(a)),constraint_violations:flags,requires_human_approval:true});
  }
  return {grade,deviation:deviation(grade,c),base_recommendation_confidence:base.confidence,candidates:candidates.sort((a,b)=>b.predicted_reward-a.predicted_reward).slice(0,b.top_k||3),policy_status:status(),note:'All candidates are advisory only. A qualified operator must review and approve before any addition is made on the floor.'};
 }
 function feedback(b){
  if(!['accepted','modified','rejected'].includes(b.outcome))throw Object.assign(new Error('Invalid feedback outcome'),{status:422});
  const rewardModel=state().reward,x=features(b.grade,b.composition,b.additions,b.aggressiveness??1),bonus={accepted:.4,modified:0,rejected:-.6}[b.outcome];
  const improvement=b.actual_result?clamp(distance(b.grade,b.composition)-distance(b.grade,b.actual_result),-1,1):bonus*.5,reward=bonus+improvement-.05*cost(b.additions),prediction=evaluate(rewardModel,x),eta=rewardModel.eta0/Math.pow(rewardModel.t,.25);
  rewardModel.coef=rewardModel.coef.map((w,i)=>w*(1-eta*rewardModel.alpha)-eta*(prediction-reward)*x[i]);rewardModel.intercept[0]-=eta*(prediction-reward);rewardModel.t++;rewardModel.n_updates++;rewardModel.reward_history.push(reward);state().feedback.unshift({...b,computed_reward:reward,time:new Date()});req('premeltGate/store').log('RL_FEEDBACK',b.heatId||b.grade,'operator',b.outcome+'; reward '+round(reward));return {accepted:true,computed_reward:round(reward),policy_status:status()};
 }
 function recall(query,limit=5,collection='heats'){
  const docs=collection==='grades'?Object.values(specs).map(g=>({text:JSON.stringify(g),metadata:g})):collection==='training_data'?req('csvDataStore').getAll().map(r=>({text:JSON.stringify(r),metadata:r})):state().memory.concat(req('premeltGate/store').heats.list().map(h=>({text:JSON.stringify(h),metadata:{heatId:h.heatId,grade:h.grade,status:h.status}})));
  const terms=String(query).toLowerCase().match(/[a-z0-9-]+/g)||[];const df=Object.fromEntries(terms.map(t=>[t,docs.filter(d=>d.text.toLowerCase().includes(t)).length]));
  return docs.map((d,i)=>{const lower=d.text.toLowerCase();const score=terms.reduce((s,t)=>s+(lower.includes(t)?Math.log(1+docs.length/(1+(df[t]||0))):0),0);return {id:d.metadata?.heatId||d.metadata?._id||String(i),text:d.text,metadata:d.metadata,score:score/(score+1),similarity:score/(score+1),payload:d.metadata};}).filter(d=>d.score>0).sort((a,b)=>b.score-a.score).slice(0,limit);
 }
 async function chat(message){
  const store=req('premeltGate/store'),text=message.toLowerCase(),id=message.match(/h-\d+/i)?.[0]?.toUpperCase(),h=id?store.heats.get(id):store.heats.list().find(h=>h.status==='MELTING')||store.heats.get('H-1051');
  if(/cheapest|cheaper|cheap fix/.test(text)&&h){
   const {solveCharge}=await import('./optimizer.js'),lots=store.listLots().map(l=>({...l,availableKg:store.availableKg(l.lotId)}));
   const planned= h.charge.reduce((total,l)=>total+l.kg*(store.getLot(l.lotId)?.costPerKg||0),0),result=solveCharge({grade:h.grade,targetKg:h.targetKg,currentPlanCost:planned},lots,req('premeltGate/config'),req('premeltGate/chemistry'));
   const best=result.candidates[0];return best?'Cheapest currently feasible charge for '+h.heatId+': ?'+best.totalCost.toFixed(0)+' ('+best.charge.map(l=>l.lotId+' '+l.kg.toFixed(1)+' kg').join(', ')+'). Estimated savings against the plan: ?'+best.savings.toFixed(0)+'. Review before use. Source: #/charge-optimizer':result.blockingConstraint+' Source: #/charge-optimizer';
  }
  if(/similar|past heat/.test(text)){const matches=recall(message,3);return 'Similar saved heats: '+matches.map(d=>d.metadata.heatId+': '+d.metadata.grade+', '+d.metadata.status).join('; ')+'. Source: #/premelt-gate';}
  if(/stock|inventory|reorder/.test(text))return 'Available inventory: '+store.listLots().filter(l=>!l.history&&store.availableKg(l.lotId)>0).map(l=>l.lotId+' '+l.description+': '+store.availableKg(l.lotId)+' kg ('+l.status+')').join('; ')+'. Source: #/raw-material-stock';
  if(/supplier/.test(text)){const s=req('premeltGate/supplierScorecard').computeScorecard({});return 'Supplier scorecard from recorded deliveries: '+JSON.stringify(s).slice(0,1800)+'. Source: #/supplier-scorecard';}
  if(/energy|carbon|kwh|co2/.test(text))return 'Energy estimates and recorded actuals: '+JSON.stringify(req('premeltGate/energy').summary()).slice(0,1500)+'. Source: #/energy';
  if(/alert|outbox/.test(text))return 'Recent alerts: '+state().outbox.slice(0,4).map(a=>a.subject+': '+a.body).join('; ')+'. Source: Outbox in demo header.';
  if(/spec|grade/.test(text)&&!id)return 'Grade limits: '+JSON.stringify(req('premeltGate/config').GRADE_SPECS[h?.grade||'SG-IRON'])+'. Source: #/grades';
  if(h)return h.heatId+' ('+h.grade+') is '+h.status+'. Gate: '+(h.gate?.decision||'not yet checked')+'. '+(h.gate?.blocking?.concat(h.gate.warnings).join(' ')||'Run a gate check to get the reasons.')+(/fix|cheap/.test(text)?' Change the charge to reduce the largest excess element; additions cannot remove it. Review Charge Optimizer for feasible cost-ranked mixes.':'')+' Source: #/premelt-gate';
  return 'Ask about a heat ID, gate reasons, stock, suppliers, grade specs, energy or recent alerts. Source: #/dashboard';
 }
 async function handle(method,path,b,q){
  try{
   let data;
   if(path==='/health')data={status:'healthy',service:'Browser demo',copilot_available:true,vector_search_available:true};
   else if(path==='/anomaly/predict'){data=await anomaly(b.grade||b.metalGrade,b.composition);if(data.is_anomaly)notify('Anomaly '+data.severity,b.grade,data.message);}
   else if(path==='/alloy/recommend')data=await alloy(b.grade,b.composition);
   else if(path==='/premelt/assess'){
    const ranges=req('premeltGate/config').GRADE_SPECS[b.grade]||{};const adds=Object.fromEntries(['C','Si','Mn'].map(e=>[e,Math.max(0,((ranges[e]?.[0]||0)+(ranges[e]?.[1]||0))/2-(b.composition[e]||0))]).filter(([,v])=>v>.01));
    const after={...b.composition};for(const [e,v]of Object.entries(adds))after[e]+=v;
    data={grade:b.grade,before_correction:risk(b.grade,b.composition,b.uncertainty),after_correction:risk(b.grade,after,b.uncertainty),correction:{recommended_additions:adds,confidence:.85},requires_human_approval:true};
   }else if(path==='/agents/analyze'||path==='/analyze-with-explanation'){const a=await anomaly(b.grade||b.metalGrade,b.composition),c=await alloy(b.grade||b.metalGrade,b.composition);data={anomaly_agent:a,alloy_agent:c,quality_assessment:{issues:[],strengths:['Human review required']},final_recommendation:a.message,suggested_actions:[c.message]};}
   else if(path==='/rl/optimize')data=await optimize(b);
   else if(path==='/rl/feedback')data=method==='GET'?state().feedback:feedback(b);
   else if(path==='/rl/policy/status')data=status();
   else if(path==='/mechanical/predict')data=predictFromChemistry(b.grade,...['C','Si','Mn','P','S'].map(e=>Number(b.composition[e])||0));
   else if(path==='/mechanical/predict/batch')data={results:b.items.map(i=>predictFromChemistry(i.grade,...['C','Si','Mn','P','S'].map(e=>Number(i.composition[e])||0))),count:b.items.length};
   else if(path==='/mechanical/standards')data={standards:STANDARDS};
   else if(path.startsWith('/mechanical/standards/')){const g=path.split('/').at(-1);if(!STANDARDS[g])throw Object.assign(new Error('Unknown grade'),{status:404});data={grade:g,...STANDARDS[g]};}
   else if(path==='/mechanical/model-info')data={status:'formula_only',message:'Browser deterministic formula mode; Python ML mechanical artifacts are not shipped'};
   else if(path==='/mechanical/ce-check'){const ce=Number(b.composition.C)+Number(b.composition.Mn)/6,lim=STANDARDS[b.grade]?.ce_max;data={carbon_equivalent:round(ce),ce_limit:lim,ce_margin:lim?round(lim-ce):null,status:!lim||ce<=lim?'PASS':'FAIL',weldability:ce<=.4?'OK':ce<=.45?'REDUCED':'POOR',budget:[{element:'C',value:b.composition.C,ce_contribution:b.composition.C,share_pct:ce?round(b.composition.C/ce*100):0},{element:'Mn/6',value:b.composition.Mn,ce_contribution:round(b.composition.Mn/6),share_pct:ce?round(b.composition.Mn/6/ce*100):0}]};}
   else if(path.startsWith('/copilot/voice/')){
    if(path.endsWith('status'))data={tts_available:'speechSynthesis' in window,stt_available:!!(window.SpeechRecognition||window.webkitSpeechRecognition),provider:'browser',tts_provider:'browser'};
    else if(path.endsWith('languages'))data={languages:{en:'English',hi:'Hindi',ta:'Tamil'}};
    else return {status:422,data:{detail:'Use the browser voice controls; audio uploads cannot be transcribed offline.'}};
   }else if(path==='/copilot/chat/history'){state().chat=[];data={status:'success'};}
   else if(path==='/copilot/chat'){const response=await chat(b.message);state().chat.push({role:'user',content:b.message},{role:'assistant',content:response});data={response,source:'local plant store'};}
   else if(path==='/copilot/explain'||path==='/copilot/what-if'){const grade=b.grade||b.metalGrade||'SG-IRON',composition=b.composition;if(composition){const a=await anomaly(grade,composition),c=await alloy(grade,composition);data={explanation:grade+': '+a.message+' Score '+a.anomaly_score.toFixed(3)+'. '+c.message+' Recommended percentage additions: '+JSON.stringify(c.recommended_additions)+'. Confidence '+(c.confidence*100).toFixed(1)+'%. Compare to grade specs and review before approval. Source: #/grades',requires_human_approval:true};}else data={explanation:await chat('Explain '+grade+' gate and specs'),requires_human_approval:true};}
   else if(path==='/vector/memory/add'){state().memory.push({text:b.text,metadata:b.metadata});data={status:'success',id:state().memory.length};}
   else if(path==='/vector/memory/recall')data={memories:recall(b.query,b.top_k||3),results:recall(b.query,b.top_k||3)};
   else if(path==='/semantic-search'||path==='/vector/search')data={query:b.query,collection:b.collection,results:recall(b.query,b.limit||b.top_k||5,b.collection||'training_data')};
   else if(path==='/reindex'||path==='/vector/reindex')data={status:'success',indexed:req('csvDataStore').getAll().length};
   else if(path==='/vector/status')data={available:true,backend:'Browser TF-IDF',collections:['training_data','grades','heats']};
   else return null;
   return {status:200,data};
  }catch(e){return {status:e.status||422,data:{detail:e.message,message:e.message}};}
 }
 return {handle,optimize,feedback,recall,chat};
}
