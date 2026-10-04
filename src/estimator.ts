import type {Quota,Usage,PriceRule,Config} from './types.js';
import {mode,priceUsage} from './pricing.js';
export interface Point {timestamp:string;percent:number;units:number;raw_tokens:number;unknown:number;records:number;source:string;}
export interface Span {from:string;to:string;delta:number;units:number;candidate:number|null;lower:number|null;upper:number|null;external:boolean;unknown:number;locally_explained_delta:number|null;unattributed_delta:number|null;}
export function weightedMedian(rows:{value:number;weight:number}[]):number {
 const sorted=[...rows].sort((a,b)=>a.value-b.value);const half=sorted.reduce((s,x)=>s+x.weight,0)/2;let sum=0;
 for(const r of sorted){sum+=r.weight;if(sum>=half)return r.value;}return 0;
}
export function estimatePoints(points:Point[]){
 const spans:Span[]=[];let anchor=points[0];if(!anchor)return empty('no_observations');let contaminated=false;
 // Adjacent checks catch zero-local movement even inside an otherwise long span.
 for(let i=1;i<points.length;i++){
  const p=points[i],prev=points[i-1],movement=p.percent-prev.percent;
  if(movement<0){anchor=p;contaminated=false;continue;}
  if(movement>1&&p.raw_tokens===prev.raw_tokens)contaminated=true;
  const delta=p.percent-anchor.percent;if(delta<5)continue;
  const units=p.units-anchor.units,unknown=p.unknown-anchor.unknown;
  const external=contaminated||p.raw_tokens===anchor.raw_tokens&&delta>1;
  const valid=!external&&unknown===0&&units>0&&anchor.percent>0&&p.percent<100;
  spans.push({from:anchor.timestamp,to:p.timestamp,delta,units,candidate:valid?100*units/delta:null,lower:valid?100*units/(delta+1):null,upper:valid?100*units/(delta-1):null,external,unknown,locally_explained_delta:null,unattributed_delta:null});
  // Non-overlapping spans: no inflated sample counts from all pairwise combinations.
  anchor=p;contaminated=false;
 }
 let clean=spans.filter(s=>s.candidate!==null);
 if(!clean.length)return {...empty('insufficient_clean_spans'),spans,external_usage_detected:spans.some(x=>x.external)};
 const median=weightedMedian(clean.map(s=>({value:s.candidate!,weight:s.delta})));
 clean=clean.filter(s=>Math.abs(s.candidate!/median-1)<=0.3);
 const capacity=weightedMedian(clean.map(s=>({value:s.candidate!,weight:s.delta})));
 const observed=clean.reduce((s,x)=>s+x.delta,0);const allDelta=spans.reduce((s,x)=>s+x.delta,0);
 const coverage=allDelta?observed/allDelta:0;const external=spans.some(s=>s.external)||clean.length<spans.filter(s=>s.candidate!==null).length;
 const residual=clean.length?Math.sqrt(clean.reduce((s,x)=>s+(100*x.units/capacity-x.delta)**2,0)/clean.length):null;
 const enough=clean.length>=3&&observed>=10&&coverage>=0.8;
 const confidence=enough?(clean.length>=5&&observed>=20&&!external&&residual!==null&&residual<1?'HIGH':'MEDIUM'):'LOW';
 for(const s of spans){s.locally_explained_delta=capacity?100*s.units/capacity:null;s.unattributed_delta=s.locally_explained_delta===null?null:Math.max(0,s.delta-s.locally_explained_delta);}
 return {status:enough?'estimated':'insufficient_data',reason:enough?null:'insufficient_clean_spans_or_coverage',estimated_capacity:enough?capacity:null,lower_bound:Math.min(...clean.map(s=>s.lower!)),upper_bound:Math.max(...clean.map(s=>s.upper!)),interval_kind:'rounding_and_observed_dispersion_not_95_percent_ci',clean_span_count:clean.length,observed_percent_span:observed,missing_clean_spans:Math.max(0,3-clean.length),missing_percent_span:Math.max(0,10-observed),coverage_ratio:coverage,confidence,residual,external_usage_detected:external,spans};
}
function empty(reason:string){return {status:'insufficient_data',reason,estimated_capacity:null,lower_bound:null,upper_bound:null,interval_kind:'rounding_and_observed_dispersion_not_95_percent_ci',clean_span_count:0,observed_percent_span:0,missing_clean_spans:3,missing_percent_span:10,coverage_ratio:0,confidence:'LOW',residual:null,external_usage_detected:false,spans:[] as Span[]};}
export function quotaEstimates(quotas:Quota[],usage:Usage[],config:Config,rules:PriceRule[],now=new Date().toISOString()){
 const groups=new Map<string,Quota[]>();
 for(const q of quotas){if(q.resets_at===null||q.window_duration_mins===null)continue;const key=JSON.stringify([q.limit_id,q.window_duration_mins,q.resets_at,q.slot]);if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(q);}
 const out:any[]=[];
 for(const [key,qs] of groups){
  const q=qs[0];const models=config.estimator.bucket_models[q.limit_id];const experimental=config.estimator.weight_basis==='credit_proxy';
  const sorted=[...qs].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||(a.source==='rollout'?-1:1));
  const observations=sorted.filter((x,i)=>i===0||x.timestamp!==sorted[i-1].timestamp);
  const from=new Date((q.resets_at!-q.window_duration_mins!*60)*1000).toISOString();
  const relevant=usage.filter(x=>x.timestamp>=from&&x.timestamp<=observations.at(-1)!.timestamp);
  const weighted=relevant.map(u=>({u,units:experimental?proxyWeight(u):u.allowance_weight}));
  let cursor=0,units=0,raw=0,unknown=0;const points:Point[]=[];
  for(const ob of observations){while(cursor<weighted.length&&weighted[cursor].u.timestamp<=ob.timestamp){const r=weighted[cursor++];raw+=r.u.total_tokens;if(!models?.includes(r.u.model)||r.units===null||r.u.source!=='token_usage_record'||r.u.data_quality==='inconsistent')unknown++;else units+=r.units;}
   points.push({timestamp:ob.timestamp,percent:ob.used_percent,units,raw_tokens:raw,unknown,records:cursor,source:ob.source});}
  let result=estimatePoints(points);
  if(!models)result={...result,...empty('unknown_bucket_model_mapping'),spans:result.spans,external_usage_detected:result.external_usage_detected};
  else if(!experimental&&!weighted.some(x=>x.units!==null))result={...result,...empty('missing_verified_allowance_weights'),spans:result.spans,external_usage_detected:result.external_usage_detected};
  const cap=result.estimated_capacity;
  const mixes:Record<string,unknown>={};
  if(cap!==null){for(const [name,start] of [['last_7_days',new Date(Date.parse(now)-7*864e5).toISOString()],['last_30_days',new Date(Date.parse(now)-30*864e5).toISOString()],['cycle',from]]){
   const mix=usage.filter(x=>x.timestamp>=start&&x.timestamp<=now&&models?.includes(x.model));let amount=0,total=0,money=0,complete=true;
   for(const r of mix){const w=experimental?proxyWeight(r):r.allowance_weight;if(w===null||r.api_equivalent_usd===null){complete=false;break;}amount+=w;total+=r.total_tokens;money+=r.api_equivalent_usd;}
   mixes[name]=complete&&amount>0?{equivalent_tokens:cap*total/amount,equivalent_api_usd:cap*money/amount}:null;
  }
  // A single model still needs an explicit token-type mixture; use observed mix with tier Standard.
  for(const model of models??[]){const mix=usage.filter(x=>x.model===model&&x.timestamp>=new Date(Date.parse(now)-30*864e5).toISOString());let amount=0,total=0,money=0,valid=mix.length>0;
   for(const u of mix){const priced=priceUsage({...u,timestamp:now,service_tier:'default'},rules);const w=experimental?proxyWeight(priced):priced.allowance_weight;if(w===null||priced.api_equivalent_usd===null){valid=false;break;}amount+=w;total+=u.total_tokens;money+=priced.api_equivalent_usd;}
   mixes[model+'_standard_observed_token_type_mix']=valid&&amount>0?{equivalent_tokens:cap*total/amount,equivalent_api_usd:cap*money/amount}:null;
  }}
  out.push({cycle:key,limit_id:q.limit_id,window_duration_mins:q.window_duration_mins,resets_at:q.resets_at,slot:q.slot,basis:experimental?'experimental_credit_proxy':'verified_allowance',assumption:experimental?'Credit rates proxy included allowance; model mapping is user-supplied, not official.':null,observation_count:observations.length,...result,equivalents:mixes});
 }return out;
}
function proxyWeight(u:Usage):number|null{
 if(u.credit_equivalent===null)return null;const speed=mode(u.service_tier);const adjustment=speed==='fast'?2.5/2:speed==='ultrafast'?8/6:speed==='standard'?1:null;return adjustment===null?null:u.credit_equivalent*adjustment;
}
