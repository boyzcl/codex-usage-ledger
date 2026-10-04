import {quotaCycleKey,quotaContext,attributedTo,allocationReason} from './quota-policy.js';
import {capacityView} from './capacity-policy.js';
import type {Quota,Usage,PriceRule} from './types.js';
import {aggregate,report,localDay,midnight,shiftDay} from './report.js';
import {createPricer} from './pricing.js';
export interface Range {from:string;to_exclusive:string;timezone:string;}
export const cycleKey=quotaCycleKey;
export interface Empirical {
 cycle:string;limit_id:string;slot:string;window_duration_mins:number;resets_at:number;
 scope:ReturnType<typeof quotaContext>['scope'];attribution_reason:string|null;unallocated_tokens:number;availability:ReturnType<typeof quotaContext>['availability'];
 basis:'observed_mix_extrapolation';observed_from:string|null;observed_to:string|null;observation_count:number;
 percent_points:number|null;matched_tokens:number;matched_api_known_usd:number;priced_tokens:number;
 model_tokens:Record<string,number>;segments:{from:string;to:string;percent_points:number;tokens:number;from_percent:number;to_percent:number}[];
 snapshots?:{timestamp:string;used_percent:number}[];strict_reason?:string;experimental?:boolean;flags:string[];partial:boolean;estimated_tokens:number|null;estimated_api_known_usd:number|null;api_token_coverage:number|null;
 rounding_only_lower:number|null;rounding_only_upper:number|null;reason:string|null;
}
function finish(p:Empirical):Empirical {
 const delta=p.percent_points??0;
 p.api_token_coverage=p.matched_tokens>0?p.priced_tokens/p.matched_tokens:null;
 p.reason=p.flags.includes('conflicting_snapshots')?'conflicting_snapshots':p.flags.includes('percent_decrease')?'percent_decrease':p.percent_points===null?'no_observations':p.attribution_reason??(p.flags.includes('external_usage_suspected')?'external_usage_suspected':p.flags.includes('inconsistent_tokens')?'inconsistent_tokens':p.flags.includes('saturated')?'saturated':delta<5?'small_percent_change':p.matched_tokens<=0?'no_matched_tokens':null);
 if(!p.reason){p.estimated_tokens=p.matched_tokens*100/delta;p.estimated_api_known_usd=p.api_token_coverage? p.matched_api_known_usd*100/delta:null;
  const error=p.segments.length;p.rounding_only_lower=p.matched_tokens*100/(delta+error);p.rounding_only_upper=delta>error?p.matched_tokens*100/(delta-error):null;
 }
 return p;
}
// Use one consistent provenance for account-wide empirical estimates. Rollout quotas
// remain available in the ledger, but are not silently mixed with polled account data.
export function empiricalPlans(rows:Usage[],quotas:Quota[],range:Range):Empirical[]{
 const groups=new Map<string,Quota[]>();
 for(const q of quotas){if(q.source!=='app_server'||!q.resets_at||!q.window_duration_mins||q.timestamp<range.from||q.timestamp>=range.to_exclusive)continue;
  if(Date.parse(q.timestamp)>=q.resets_at*1000||Date.parse(q.timestamp)<(q.resets_at-q.window_duration_mins*60)*1000)continue;
  const key=cycleKey(q);if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(q);
 }
 const result:Empirical[]=[];
 for(const [cycle,raw] of groups){
  const qs=raw.sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
  const unique=qs.filter((q,i)=>i===0||q.timestamp!==qs[i-1].timestamp);
  const q=qs[0],flags:string[]=[];
  if(qs.some((r,i)=>i&&r.timestamp===qs[i-1].timestamp&&r.used_percent!==qs[i-1].used_percent))flags.push('conflicting_snapshots');
  const eligible=rows.filter(r=>attributedTo(r,q));
  const p:Empirical={scope:quotaContext(q).scope,availability:quotaContext(unique.at(-1)!).availability,attribution_reason:allocationReason(q,rows.filter(r=>r.timestamp>(unique[0]?.timestamp??'')&&r.timestamp<=(unique.at(-1)?.timestamp??''))),unallocated_tokens:0,cycle,limit_id:q.limit_id,slot:q.slot,window_duration_mins:q.window_duration_mins!,resets_at:q.resets_at!,basis:'observed_mix_extrapolation',observed_from:unique[0]?.timestamp??null,observed_to:unique.at(-1)?.timestamp??null,observation_count:unique.length,percent_points:null,matched_tokens:0,matched_api_known_usd:0,priced_tokens:0,model_tokens:{},segments:[],snapshots:unique.map(({timestamp,used_percent})=>({timestamp,used_percent})),flags,partial:true,estimated_tokens:null,estimated_api_known_usd:null,api_token_coverage:null,rounding_only_lower:null,rounding_only_upper:null,reason:null};
  let anchor=unique[0],last=anchor;
  const close=()=>{if(!anchor||!last||anchor===last)return;
   const observed=rows.filter(r=>r.timestamp>anchor.timestamp&&r.timestamp<=last.timestamp);
   const matched=observed.filter(r=>attributedTo(r,q));p.unallocated_tokens+=aggregate(observed.filter(r=>!attributedTo(r,q))).total_tokens;
   const total=aggregate(matched),delta=last.used_percent-anchor.used_percent;
   p.percent_points=(p.percent_points??0)+delta;p.matched_tokens+=total.total_tokens;p.matched_api_known_usd+=total.known_api_subtotal_usd;
   p.priced_tokens+=matched.reduce((n,r)=>n+(r.api_equivalent_usd===null?0:r.total_tokens),0);
   for(const r of matched)p.model_tokens[r.model]=(p.model_tokens[r.model]??0)+r.total_tokens;
   if(matched.some(r=>r.data_quality==='inconsistent'))p.flags.push('inconsistent_tokens');
   if(last.used_percent>=100)p.flags.push('saturated');
   p.segments.push({from:anchor.timestamp,to:last.timestamp,percent_points:delta,tokens:total.total_tokens,from_percent:anchor.used_percent,to_percent:last.used_percent});
  };
  for(let i=1;i<unique.length;i++){
   const next=unique[i];
   if(next.used_percent<last.used_percent){close();p.flags.push('percent_decrease');anchor=next;last=next;continue;}
   if(!p.attribution_reason&&next.used_percent-last.used_percent>1&&!eligible.some(r=>r.total_tokens>0&&r.timestamp>last.timestamp&&r.timestamp<=next.timestamp))p.flags.push('external_usage_suspected');
   if(Date.parse(next.timestamp)-Date.parse(last.timestamp)>30*60000)p.flags.push('sampling_gap');
   last=next;
  }
  close();p.flags=[...new Set(p.flags)];
  // No interpolation or invented midnight sample: partial intervals are disclosed.
  p.partial=p.observed_from!==range.from||Date.parse(p.observed_to??'')<Date.parse(range.to_exclusive)-1||p.flags.length>0;
  if(p.flags.includes('conflicting_snapshots'))p.percent_points=null;
  result.push(finish(p));
 }
 return result.sort((a,b)=>a.cycle.localeCompare(b.cycle));
}
export function combinePlans(plans:Empirical[]):Empirical[]{
 const map=new Map<string,Empirical>();
 for(const p of plans){
  const old=map.get(p.cycle);if(!old){map.set(p.cycle,structuredClone(p));continue;}
  old.observed_from=[old.observed_from,p.observed_from].filter(Boolean).sort()[0]??null;
  old.observed_to=[old.observed_to,p.observed_to].filter(Boolean).sort().at(-1)??null;
  old.observation_count+=p.observation_count;old.percent_points=old.percent_points===null&&p.percent_points===null?null:(old.percent_points??0)+(p.percent_points??0);
  old.unallocated_tokens+=p.unallocated_tokens;old.attribution_reason??=p.attribution_reason;old.matched_tokens+=p.matched_tokens;old.matched_api_known_usd+=p.matched_api_known_usd;old.priced_tokens+=p.priced_tokens;
  for(const [model,tokens] of Object.entries(p.model_tokens))old.model_tokens[model]=(old.model_tokens[model]??0)+tokens;
  old.snapshots=[...(old.snapshots??[]),...(p.snapshots??[])];old.segments.push(...p.segments);old.flags=[...new Set([...old.flags,...p.flags])];old.partial||=p.partial;
 }
 return [...map.values()].map(p=>{
  const chain=(p.snapshots??[]).slice().sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
  if(chain.some((s,i)=>i>0&&s.used_percent<chain[i-1].used_percent))p.flags=[...new Set([...p.flags,'percent_decrease'])];
  if(chain.some((s,i)=>i>0&&s.timestamp===chain[i-1].timestamp&&s.used_percent!==chain[i-1].used_percent))p.flags=[...new Set([...p.flags,'conflicting_snapshots'])];
  const ordered=p.segments.slice().sort((a,b)=>a.from.localeCompare(b.from));
  if(ordered.some((s,i)=>i>0&&s.from_percent<ordered[i-1].to_percent))p.flags=[...new Set([...p.flags,'percent_decrease'])];
  if(p.flags.includes('conflicting_snapshots'))p.percent_points=null;
  return finish({...p,estimated_tokens:null,estimated_api_known_usd:null,rounding_only_lower:null,rounding_only_upper:null});
 });
}
export function dailyReport(rows:Usage[],quotas:Quota[],rules:PriceRule[],range:Range,at=new Date().toISOString(),options:{experimentalEmpirical?:boolean}={}){
 const base=report(rows,rules,at),price=createPricer(rules),priced=rows.map(r=>price({...r,timestamp:at})).map((r,i)=>({...r,timestamp:rows[i].timestamp}));
 const rowGroups=new Map<string,Usage[]>(),priceGroups=new Map<string,Usage[]>();
 // Reuse the formatter: a large historical report must not build one Intl formatter per record.
 const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:range.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
 for(let i=0;i<rows.length;i++){const day=dayFormat.format(new Date(rows[i].timestamp));if(!rowGroups.has(day)){rowGroups.set(day,[]);priceGroups.set(day,[]);}rowGroups.get(day)!.push(rows[i]);priceGroups.get(day)!.push(priced[i]);}
 // Open-ended report defaults cover the observed history, not ten thousand empty years.
 const first=Number(range.from.slice(0,4))<=1?(rows[0]?.timestamp??at):range.from;
 const last=Number(range.to_exclusive.slice(0,4))>=9998?new Date(Date.parse(at)+1).toISOString():range.to_exclusive;
 const firstDay=localDay(first,range.timezone),lastDay=localDay(new Date(Date.parse(last)-1).toISOString(),range.timezone);
 const daily=[];
 for(let date=firstDay;date<=lastDay;date=shiftDay(date,1)){
  if(daily.length>=3660)throw Error('report_range_too_large');
  const from=[midnight(date,range.timezone),range.from].sort().at(-1)!;
  const to=[midnight(shiftDay(date,1),range.timezone),range.to_exclusive,new Date(Date.parse(at)+1).toISOString()].sort()[0];
  const group=rowGroups.get(date)??[],pg=priceGroups.get(date)??[];
  const models=Object.fromEntries([...new Set(group.map(r=>r.model))].sort().map(model=>[model,{...aggregate(group.filter(r=>r.model===model)),current_price_valuation:aggregate(pg.filter(r=>r.model===model)),plan_percent_points:null,estimated_plan_tokens:null}]));
  daily.push({date,from,to_exclusive:to,ongoing:date===localDay(at,range.timezone)&&range.to_exclusive>at,totals:aggregate(group),models,current_price_valuation:aggregate(pg),plans:from<to?empiricalPlans(pg,quotas,{...range,from,to_exclusive:to}):[]});
 }
 const modelsCurrent=Object.fromEntries(Object.keys(base.models).map(model=>[model,{...base.models[model],current_price_valuation:aggregate(priced.filter(r=>r.model===model)),plan_percent_points:null,estimated_plan_tokens:null}]));
 const cycles=combinePlans(daily.flatMap(d=>d.plans));
 const restrict=(p:Empirical)=>{p.strict_reason=p.attribution_reason??'unverified_account_window_attribution';p.experimental=!!options.experimentalEmpirical;
  if(!options.experimentalEmpirical){p.estimated_tokens=null;p.estimated_api_known_usd=null;p.rounding_only_lower=null;p.rounding_only_upper=null;p.reason??=p.strict_reason;}return capacityView(p,!!options.experimentalEmpirical);};
 for(const d of daily)d.plans=d.plans.map(p=>{
  const invalid=cycles.find(c=>c.cycle===p.cycle)?.flags.filter(f=>f==='percent_decrease'||f==='conflicting_snapshots')??[];
  if(invalid.length){p.flags=[...new Set([...p.flags,...invalid])];p=finish({...p,estimated_tokens:null,estimated_api_known_usd:null,rounding_only_lower:null,rounding_only_upper:null});}
  return restrict(p);
 });
 return {...base,as_of:at,observation_coverage:{status:'partial',from:quotas[0]?.timestamp??null,to:quotas.at(-1)?.timestamp??null,samples:quotas.length,note:'Observed samples do not establish continuous account history.'},display_period:{from:first,to_exclusive:last,timezone:range.timezone},models:modelsCurrent,daily,plan_cycles:cycles.map(restrict),daily_basis:{timezone:range.timezone,prices_at:at,quota_source:'app_server',minimum_percent_points:5,experimental_empirical:!!options.experimentalEmpirical,strict_reason:'unverified_account_window_attribution',allocation:'Model quota columns are unallocated; empirical capacity uses matched observed usage and assumes no unrecorded account use.'}};
}
