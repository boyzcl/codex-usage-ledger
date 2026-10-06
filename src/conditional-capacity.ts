import {createHash} from 'node:crypto';
import {catalogueId,canonicalJson,createPricer} from './pricing.js';
import {quotaContext} from './quota-policy.js';
import {localDay} from './report.js';
import type {PriceRule,Quota,Usage} from './types.js';
import type {Ledger} from './store.js';

export type UsageChannel='included'|'api_key'|'purchased_credits'|'free_auto_review'|'unknown';
export interface ConditionalOptions {
 prices_at?:string;
 account_coverage_declaration?:string;
 channel_declarations?:Record<string,{channel:UsageChannel;source:'machine_evidence'|'user_declaration'}>;
 policy_boundaries?:{timestamp:string;stage:string;plan_tier:string|null;source:string}[];
 reset_events?:{timestamp:string;kind:'full_reset';source:'machine_evidence'|'user_declaration'}[];
 gaps?:{from:string;to:string;reason:string}[];
}
type Point={id:string;timestamp:string;used_percent:number;resets_at:number;ordinary_usage_allowed:boolean|null;spend_control_reached:boolean|null};
type Policy={plan_type:string|null;plan_tier:string|null;stage:string|null;source:string};
type Evidence={id:string;timestamp:string;model:string;service_tier:string;input_tokens:number;cached_input_tokens:number;cache_write_input_tokens:number;uncached_input_tokens:number;output_tokens:number;total_tokens:number;channel:UsageChannel;channel_source:string;attribution:'machine_matched'|'assumed';api_usd:number|null;credits:number|null;api_rule_id:string|null;credit_rule_id:string|null};
export interface Interval {
 id:string;epoch_id:string;date:string;points:Point[];records:Evidence[];percent_points:number;
 publication_lag_possible:boolean;
 from:string;to:string;status:'eligible'|'zero_change'|'unpaired_consumption';
}
type Epoch={id:string;scope:ReturnType<typeof quotaContext>['scope'];limit_id:string;slot:string;window_duration_mins:number;reset_anchor:number;reset_min:number;reset_max:number;policy:Policy;interval_ids:string[]};
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const sum=(rows:Evidence[],field:'api_usd'|'credits')=>rows.reduce((n,r)=>n+(r[field]??0),0);
function totals(intervals:Interval[]){
 const eligible=intervals.filter(i=>i.status==='eligible'),rows=eligible.flatMap(i=>i.records),delta=eligible.reduce((n,i)=>n+i.percent_points,0);
 const tokens=rows.reduce((n,r)=>n+r.total_tokens,0),amount=(field:'api_usd'|'credits')=>{
  const known=rows.filter(r=>r[field]!==null),knownTokens=known.reduce((n,r)=>n+r.total_tokens,0),value=sum(rows,field);
  return {known_amount:value,known_records:known.length,unknown_records:rows.length-known.length,known_tokens:knownTokens,unknown_tokens:tokens-knownTokens,token_coverage:tokens?knownTokens/tokens:null,record_coverage:rows.length?known.length/rows.length:null,coverage:!rows.length?'no_usage':known.length===rows.length?'complete':'known_partial',equivalent_100_percent:delta>0&&known.length>0?100*value/delta:null};
 };
 const keys=[...new Set(rows.map(r=>canonicalJson([r.model,r.service_tier])))];
 const mix=keys.map(key=>{const selected=rows.filter(r=>canonicalJson([r.model,r.service_tier])===key),[model,service_tier]=JSON.parse(key);return {model,service_tier,total_tokens:selected.reduce((n,r)=>n+r.total_tokens,0),input_tokens:selected.reduce((n,r)=>n+r.input_tokens,0),cached_input_tokens:selected.reduce((n,r)=>n+r.cached_input_tokens,0),output_tokens:selected.reduce((n,r)=>n+r.output_tokens,0)};});
 return {percent_points:delta,records:rows.length,total_tokens:tokens,api:amount('api_usd'),credits:amount('credits'),mix,machine_matched_records:rows.filter(r=>r.attribution==='machine_matched').length,assumed_records:rows.filter(r=>r.attribution==='assumed').length,unknown_channel_records:rows.filter(r=>r.channel==='unknown').length,interval_ids:eligible.map(i=>i.id),zero_change_interval_ids:intervals.filter(i=>i.status==='zero_change').map(i=>i.id),zero_change_tokens:intervals.filter(i=>i.status==='zero_change').flatMap(i=>i.records).reduce((n,r)=>n+r.total_tokens,0),unpaired_consumption_interval_ids:intervals.filter(i=>i.status==='unpaired_consumption').map(i=>i.id)};
}
// This is a conditional value conversion. It does not replace strict attribution
// or declare API/credit rates to be subscription allowance weights.
export function conditionalCapacity(usage:Usage[],quotas:Quota[],rules:PriceRule[],range:{from:string;to_exclusive:string;timezone:string},options:ConditionalOptions={}){
 const ruleDates=rules.filter(r=>r.kind==='api'||r.kind==='credit').map(r=>r.effective_from).sort((a,b)=>Date.parse(a)-Date.parse(b));
 const pricesAt=options.prices_at??ruleDates.at(-1)??null;
 if(pricesAt!==null&&!Number.isFinite(Date.parse(pricesAt)))throw Error('invalid_conditional_prices_at');
 const price=createPricer(rules),catalogue=catalogueId(rules);
 const reference=rules.filter(r=>r.kind==='api'&&r.model==='gpt-6.1-sol'&&r.processing_mode==='standard'&&r.context_min===0&&pricesAt!==null&&Date.parse(r.effective_from)<=Date.parse(pricesAt)&&(!r.effective_to||Date.parse(pricesAt)<Date.parse(r.effective_to))&&!rules.some(next=>next.supersedes===r.id&&Date.parse(next.effective_from)<=Date.parse(pricesAt))).sort((a,b)=>a.id.localeCompare(b.id));
 const referenceRate=reference.length===1&&reference[0].rates.input>0?reference[0]:null;
 const qs=quotas.filter(q=>q.source==='app_server'&&q.timestamp>=range.from&&q.timestamp<range.to_exclusive).slice().sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id));
 const rows=usage.filter(r=>r.timestamp>range.from&&r.timestamp<range.to_exclusive).slice().sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id));
 const intervals:Interval[]=[],epochs:Epoch[]=[],boundaries:{from:Point|null;to:Point;reason:string;usage_ids:string[];reset_evidence:string|null}[]=[];
 const points=new Map<string,Point>(),lanes=new Map<string,{epoch:Epoch;chain:Point[];records:Evidence[];last:Quota;high_water:number|null}>();
 const retained=new Set<string>(),exclusions=new Map<string,Set<string>>();let lastScope:string|undefined;
 const point=(q:Quota):Point=>{const availability=quotaContext(q).availability;return {id:q.id,timestamp:q.timestamp,used_percent:q.used_percent,resets_at:q.resets_at!,ordinary_usage_allowed:availability.ordinary_usage_allowed,spend_control_reached:availability.spend_control_reached};};
 const blocked=(q:Quota)=>{const a=quotaContext(q).availability;return a.ordinary_usage_allowed===false||a.ordinary_usage_status==='blocked'||a.spend_control_reached===true;};
 const policy=(q:Quota):Policy=>{
  let raw:any={};try{raw=JSON.parse(q.raw_json);}catch{/* Missing metadata stays unknown. */}
  const declared=options.policy_boundaries?.filter(p=>p.timestamp<=q.timestamp).sort((a,b)=>a.timestamp.localeCompare(b.timestamp)).at(-1);
  return {plan_type:typeof raw.planType==='string'?raw.planType:typeof raw.plan_type==='string'?raw.plan_type:null,plan_tier:declared?.plan_tier??(typeof raw.planTier==='string'?raw.planTier:null),stage:declared?.stage??(typeof raw.policyStage==='string'?raw.policyStage:null),source:declared?.source??'observed_fields_or_unknown'};
 };
 // Binary search avoids rereading all local records for each quota edge.
 const after=(iso:string)=>{let lo=0,hi=rows.length;while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].timestamp<=iso)lo=mid+1;else hi=mid;}return lo;};
 const between=(from:string,to:string)=>rows.slice(after(from),after(to));
 const exclude=(records:Usage[],reason:string)=>{for(const row of records){if(!exclusions.has(row.id))exclusions.set(row.id,new Set());exclusions.get(row.id)!.add(reason);}};
 const close=(lane:{epoch:Epoch;chain:Point[];records:Evidence[]})=>{
  if(lane.chain.length<2)return;
  const first=lane.chain[0],last=lane.chain.at(-1)!,delta=last.used_percent-first.used_percent;
  const lag=lane.chain.some((p,i)=>i>0&&p.used_percent>lane.chain[i-1].used_percent&&!lane.records.some(r=>r.timestamp>lane.chain[i-1].timestamp&&r.timestamp<=p.timestamp));
  const interval:Interval={id:hash([lane.epoch.id,first.id,last.id]),epoch_id:lane.epoch.id,date:localDay(first.timestamp,range.timezone),from:first.timestamp,to:last.timestamp,points:lane.chain,records:lane.records,percent_points:delta,publication_lag_possible:lag,status:delta<=0?'zero_change':lane.records.length?'eligible':'unpaired_consumption'};
  intervals.push(interval);lane.epoch.interval_ids.push(interval.id);for(const r of lane.records)retained.add(r.id);
 };
 const newEpoch=(q:Quota):Epoch=>{const e:Epoch={id:hash([q.id,policy(q)]),scope:quotaContext(q).scope,limit_id:q.limit_id,slot:q.slot,window_duration_mins:q.window_duration_mins!,reset_anchor:q.resets_at!,reset_min:q.resets_at!,reset_max:q.resets_at!,policy:policy(q),interval_ids:[]};epochs.push(e);return e;};
 const evidence=(row:Usage,q:Quota,onlyWindow:boolean):Evidence|null=>{
  const declared=options.channel_declarations?.[row.id],channel=declared??(row.consumption_channel?{channel:row.consumption_channel.kind,source:row.consumption_channel.source}:undefined),kind=channel?.channel??'unknown';
  if(['api_key','purchased_credits','free_auto_review'].includes(kind)||row.repair_status==='source_unavailable')return null;
  const a=row.quota_attribution,s=quotaContext(q).scope;
  if(a&&(a.source!=='source_event'||a.scope.account_ref!==s.account_ref||s.workspace_ref!==null&&a.scope.workspace_ref!==s.workspace_ref||s.billing_source!==null&&a.scope.billing_source!==s.billing_source||a.limit_id!==q.limit_id||a.slot!==q.slot||a.window_duration_mins!==q.window_duration_mins||Math.abs(a.resets_at-q.resets_at!)>1))return null;
  if(!a&&!onlyWindow)return null;
  const priced=pricesAt?price({...row,timestamp:pricesAt}):{...row,api_equivalent_usd:null,credit_equivalent:null,api_rule_id:null,credit_rule_id:null};
  const confirmed=a?.scope.status==='verified'&&s.status==='verified'&&!!s.account_ref&&!!s.workspace_ref&&!!s.billing_source&&a.scope.account_ref===s.account_ref&&a.scope.workspace_ref===s.workspace_ref&&a.scope.billing_source===s.billing_source;
  return {id:row.id,timestamp:row.timestamp,model:row.model,service_tier:row.service_tier,input_tokens:row.input_tokens,cached_input_tokens:row.cached_input_tokens,cache_write_input_tokens:row.cache_write_input_tokens,uncached_input_tokens:row.uncached_input_tokens,output_tokens:row.output_tokens,total_tokens:row.total_tokens,channel:kind,channel_source:channel?.source??'unknown',attribution:confirmed?'machine_matched':'assumed',api_usd:priced.api_equivalent_usd,credits:priced.credit_equivalent,api_rule_id:priced.api_rule_id,credit_rule_id:priced.credit_rule_id};
 };
 for(let i=0;i<qs.length;){
  let end=i+1;while(end<qs.length&&qs[end].timestamp===qs[i].timestamp)end++;
  const frame=qs.slice(i,end),scopeKeys=new Set(frame.map(q=>{const s=quotaContext(q).scope;return canonicalJson([s.account_ref,s.workspace_ref,s.billing_source]);})),scope=[...scopeKeys][0];
  const categories=new Map<string,Quota[]>();for(const q of frame){const key=canonicalJson([q.limit_id,q.slot]);if(!categories.has(key))categories.set(key,[]);categories.get(key)!.push(q);}
  if(scope!==lastScope||scopeKeys.size!==1){for(const lane of lanes.values())close(lane);lanes.clear();}lastScope=scope;
  for(const [key,lane] of lanes)if(!categories.has(key)){close(lane);lanes.delete(key);}
  for(const [key,raw] of categories){
   const unique=[...new Map(raw.map(q=>[canonicalJson([q.used_percent,q.resets_at,q.window_duration_mins,quotaContext(q).scope,quotaContext(q).availability.ordinary_usage_allowed,quotaContext(q).availability.spend_control_reached,policy(q)]),q])).values()];
   const q=unique[0],p=point(q),s=quotaContext(q).scope;for(const candidate of raw)points.set(candidate.id,point(candidate));
   const lane=lanes.get(key);
   const invalid=!s.account_ref||!['partial','verified'].includes(s.status)||quotaContext(q).evidence?.origin==='ambiguous_observations'||scopeKeys.size!==1||unique.length!==1||!Number.isFinite(Date.parse(q.timestamp))||!Number.isFinite(q.used_percent)||q.used_percent<0||q.used_percent>100||!Number.isFinite(q.resets_at)||!Number.isFinite(q.window_duration_mins)||q.window_duration_mins!<=0||Date.parse(q.timestamp)>=q.resets_at!*1000||Date.parse(q.timestamp)<(q.resets_at!-q.window_duration_mins!*60)*1000;
   if(invalid){if(lane){close(lane);const rr=between(lane.last.timestamp,q.timestamp);exclude(rr,'invalid_or_conflicting_snapshot');boundaries.push({from:point(lane.last),to:p,reason:'invalid_or_conflicting_snapshot',usage_ids:rr.map(r=>r.id),reset_evidence:null});}lanes.delete(key);continue;}
   if(!lane){lanes.set(key,{epoch:newEpoch(q),chain:[p],records:[],last:q,high_water:null});continue;}
   const rr=between(lane.last.timestamp,q.timestamp),gap=Date.parse(q.timestamp)-Date.parse(lane.last.timestamp)>30*60000||options.gaps?.some(g=>g.from<=q.timestamp&&g.to>lane!.last.timestamp);
   const drift=Math.abs(q.resets_at!-lane.epoch.reset_anchor)>1||Math.max(lane.epoch.reset_max,q.resets_at!)-Math.min(lane.epoch.reset_min,q.resets_at!)>1;
   const declaredBoundary=options.policy_boundaries?.some(b=>b.timestamp>lane!.last.timestamp&&b.timestamp<=q.timestamp);
   const structural=drift||q.window_duration_mins!==lane.epoch.window_duration_mins||canonicalJson(policy(q))!==canonicalJson(lane.epoch.policy)||declaredBoundary;
   const newStart=(q.resets_at!-q.window_duration_mins!*60)*1000,oldStart=(lane.last.resets_at!-lane.last.window_duration_mins!*60)*1000;
   const resetEvent=options.reset_events?.find(e=>e.kind==='full_reset'&&e.timestamp>lane!.last.timestamp&&e.timestamp<=q.timestamp);
   const resetEvidence=resetEvent?`declared_full_reset:${resetEvent.source}`:structural&&newStart>oldStart+1000&&newStart>=Date.parse(lane.last.timestamp)-1000&&newStart<=Date.parse(q.timestamp)+1000?'new_reported_window_start_in_poll_interval':null;
   const valued=rr.map(r=>evidence(r,q,categories.size===1));
   const excludedChannel=valued.some(v=>v===null);
   const invalidUsage=rr.some(r=>r.data_quality==='inconsistent'||['input_tokens','cached_input_tokens','cache_write_input_tokens','uncached_input_tokens','output_tokens','total_tokens'].some(k=>!Number.isFinite(r[k as keyof Usage])||Number(r[k as keyof Usage])<0)||r.input_tokens!==r.uncached_input_tokens+r.cached_input_tokens+r.cache_write_input_tokens||r.total_tokens!==r.input_tokens+r.output_tokens);
   const reason=structural||resetEvent?'window_or_policy_boundary':gap?'sampling_gap':blocked(q)||blocked(lane.last)?'official_usage_blocked':q.used_percent>=100?'saturated_endpoint':lane.last.used_percent>=100?'saturated':invalidUsage?'inconsistent_usage':excludedChannel?'unmatched_or_excluded_channel':q.used_percent<lane.last.used_percent?'unknown_percent_decrease':lane.high_water!==null?'recovery_quarantine':q.used_percent>lane.last.used_percent&&rr.length===0&&lane.records.length===0?'positive_change_without_local_records':localDay(q.timestamp,range.timezone)!==localDay(lane.last.timestamp,range.timezone)?'day_boundary':null;
   if(reason){
    close(lane);exclude(rr,reason);boundaries.push({from:point(lane.last),to:p,reason,usage_ids:rr.map(r=>r.id),reset_evidence:resetEvidence});
    if(!resetEvidence&&q.used_percent<lane.last.used_percent)lane.high_water=Math.max(lane.high_water??0,lane.last.used_percent);
    if(structural||resetEvent)lane.epoch=newEpoch(q);
    if(resetEvidence)lane.high_water=null;
    if(lane.high_water!==null&&q.used_percent>=lane.high_water)lane.high_water=null;
    lane.chain=[p];lane.records=[];
   }else{
    lane.chain.push(p);lane.records.push(...valued as Evidence[]);
   }
   lane.epoch.reset_min=Math.min(lane.epoch.reset_min,q.resets_at!);lane.epoch.reset_max=Math.max(lane.epoch.reset_max,q.resets_at!);lane.last=q;
  }
  i=end;
 }
 for(const lane of lanes.values())close(lane);
 const summarize=(selected:Interval[])=>{const value=totals(selected);return {...value,reference_tokens:referenceRate&&value.api.equivalent_100_percent!==null?value.api.equivalent_100_percent/referenceRate.rates.input*1e6:null};};
 const windows=epochs.filter(e=>e.interval_ids.length).map(e=>({...e,...summarize(intervals.filter(i=>i.epoch_id===e.id))}));
 const days=[...new Set(intervals.map(i=>i.date))].sort().map(date=>({date,windows:windows.map(w=>({epoch_id:w.id,limit_id:w.limit_id,slot:w.slot,window_duration_mins:w.window_duration_mins,...summarize(intervals.filter(i=>i.epoch_id===w.id&&i.date===date))})).filter(w=>w.interval_ids.length||w.zero_change_interval_ids.length||w.unpaired_consumption_interval_ids.length)}));
 const unmatched=rows.filter(r=>!retained.has(r.id)).map(r=>({id:r.id,timestamp:r.timestamp,total_tokens:r.total_tokens,reasons:[...(exclusions.get(r.id)??new Set(['outside_paired_intervals']))]}));
 return {basis:'fixed_price_conditional_equivalence' as const,status:'descriptive_conditional' as const,strict_capacity:null,formula:'100 * sum(known fixed-price amounts) / sum(eligible percentage points)',price_basis:{at:pricesAt,catalogue_id:catalogue,selection:options.prices_at?'explicit_fixed_date':'catalogue_latest_effective_from',rules},reference:referenceRate?{model:referenceRate.model,token_type:'ordinary_input',processing_mode:referenceRate.processing_mode,rule_id:referenceRate.id,usd_per_million:referenceRate.rates.input,context_min:referenceRate.context_min,context_max:referenceRate.context_max,independent_evidence:false}:null,pairing:{usage_interval:'(start,end]',gap_limit_seconds:1800,deadline_tolerance_seconds:1,deadline_rule:'absolute from first anchor <=1s AND epoch max-min <=1s; analytical tolerance, not official reset evidence',unknown_decrease:'quarantine until prior high water is recovered; recovery edge excluded',aggregation:'sum/sum within each observed epoch only; no addition of window capacities'},account_coverage:{status:'unknown',machine_evidence:'Only complete verified source_event quota attribution establishes machine-matched records',user_declaration:options.account_coverage_declaration??null,assumptions:['Unattributed local usage is assumed to affect the sole observed account/window; unknown channels are conditionally included.','Local records do not establish complete account usage. Missing shared agentic entrypoints and unlabelled free auto-review remain unseparated risks.','Fixed API and purchased-credit prices are value-conversion scales, not proven included-allowance weights.'],policy_tier_or_eligibility_inferred:false},windows,days,intervals,boundaries,unpaired_usage:unmatched,forward_validation:{status:'not_registered',validated:false},observed_points:[...points.values()]};
}

// Read existing gap/error evidence only. No new collection or database writes.
export function conditionalGaps(db:Ledger,range:{from:string;to_exclusive:string}):NonNullable<ConditionalOptions['gaps']>{
 const events=db.db.prepare("SELECT timestamp,kind,raw_json FROM observations INDEXED BY observation_time WHERE timestamp>=? AND timestamp<? AND (kind='observation_gap' OR status='error' AND kind IN ('local_sync','account/rateLimits/read')) ORDER BY timestamp LIMIT 2001").all(range.from,range.to_exclusive);
 if(events.length>2000)return [{from:range.from,to:range.to_exclusive,reason:'gap_evidence_truncated'}];
 return events.map(event=>{const raw=JSON.parse(event.raw_json as string);return {from:raw.from??event.timestamp as string,to:raw.to??new Date(Date.parse(event.timestamp as string)+1).toISOString(),reason:event.kind as string};});
}
