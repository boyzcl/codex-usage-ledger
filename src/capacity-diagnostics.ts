import {statSync} from 'node:fs';
import {join} from 'node:path';
import type {Ledger} from './store.js';
import type {Quota,Usage,Config} from './types.js';
import {quotaContext,scopeKey,scopeReason,attributedTo,contextFingerprint,mergeContexts} from './quota-policy.js';
import {mode} from './pricing.js';
import {localDay} from './report.js';

export interface DiagnosticObservation {id:number;timestamp:string;source:string;kind:string;status:string;raw_json:string;}
export interface DiagnosticGap {from:string;to:string;seconds:number;kind:string;}
const iso=(ms:number)=>new Date(ms).toISOString();
const unique=(xs:string[])=>[...new Set(xs)].sort();
// Partial identities can form an observational series, never a verified fit or capacity.
// Missing identities remain separate facts. No deadline tolerance merges cycles.
export function diagnosticSeriesKey(q:Quota){const s=quotaContext(q).scope;return JSON.stringify([scopeKey(s),s.account_ref?null:q.id,q.source,q.limit_id,q.slot,q.window_duration_mins,q.resets_at]);}
function nominalStart(q:Quota){return q.resets_at!==null&&q.window_duration_mins!==null&&q.window_duration_mins>0?(q.resets_at-q.window_duration_mins*60)*1000:null;}
function gaps(points:{timestamp:string}[],threshold:number):DiagnosticGap[]{return points.slice(1).flatMap((p,i)=>{const previous=points[i],seconds=(Date.parse(p.timestamp)-Date.parse(previous.timestamp))/1000;return seconds>threshold?[{from:previous.timestamp,to:p.timestamp,seconds,kind:'successful_sample_gap'}]:[];});}
function reportedGaps(observations:DiagnosticObservation[]):DiagnosticGap[]{return observations.filter(o=>o.kind==='observation_gap').flatMap(o=>{const d=JSON.parse(o.raw_json),from=d.from,to=d.to??o.timestamp;const seconds=(Date.parse(to)-Date.parse(from))/1000;return Number.isFinite(seconds)&&seconds>=0?[{from,to,seconds,kind:'reported_observation_gap'}]:[];});}
function composition(rows:Usage[]){
 const combinations=new Map<string,{model:string;speed:string;records:number;total_tokens:number;uncached_input_tokens:number;cached_input_tokens:number;cache_write_input_tokens:number;output_tokens:number}>();
 for(const r of rows){const speed=mode(r.service_tier),key=JSON.stringify([r.model,speed]);if(!combinations.has(key))combinations.set(key,{model:r.model,speed,records:0,total_tokens:0,uncached_input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0});const v=combinations.get(key)!;v.records++;for(const k of ['total_tokens','uncached_input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens'] as const)v[k]+=r[k];}
 return {records:rows.length,total_tokens:rows.reduce((n,r)=>n+r.total_tokens,0),unknown_model_tokens:rows.filter(r=>r.model==='unknown').reduce((n,r)=>n+r.total_tokens,0),unknown_speed_tokens:rows.filter(r=>mode(r.service_tier)==='unknown').reduce((n,r)=>n+r.total_tokens,0),inconsistent_records:rows.filter(r=>r.data_quality==='inconsistent').length,source_unavailable_records:rows.filter(r=>r.repair_status==='source_unavailable').length,missing_allowance_records:rows.filter(r=>r.allowance_weight===null).length,models:unique(rows.map(r=>r.model)),speeds:unique(rows.map(r=>mode(r.service_tier))),combinations:[...combinations].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v)};
}

export function windowDiagnostics(quotas:Quota[],usage:Usage[],asOf:string,thresholdSeconds:number,reported:DiagnosticGap[]=[]){
 const groups=new Map<string,Quota[]>();
 for(const q of quotas){if(q.timestamp>asOf)continue;const key=diagnosticSeriesKey(q);if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(q);}
 return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([key,qs])=>{
  const sorted=[...qs].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id)||contextFingerprint(quotaContext(a)).localeCompare(contextFingerprint(quotaContext(b)))),q=sorted[0],start=nominalStart(q),end=q.resets_at===null?null:q.resets_at*1000;
  const first=sorted[0].timestamp,last=sorted.at(-1)!.timestamp;
  const scope=quotaContext(q).scope;
  // The store can already quarantine a same-time context as mixed/unknown scope.
  // Keep it as a rejection barrier in a potentially affected series, not as an
  // attributed member; otherwise grouping would silently bridge that conflict.
  const barriers=scope.account_ref?quotas.filter(r=>r.timestamp>=first&&r.timestamp<=last&&r.source===q.source&&r.limit_id===q.limit_id&&r.slot===q.slot&&r.window_duration_mins===q.window_duration_mins&&r.resets_at===q.resets_at&&diagnosticSeriesKey(r)!==key&&scopeReason(r)!==null&&(!quotaContext(r).scope.account_ref||quotaContext(r).scope.account_ref===scope.account_ref)):[];
  const timeline=[...sorted,...barriers].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id)||contextFingerprint(quotaContext(a)).localeCompare(contextFingerprint(quotaContext(b))));
  const local=usage.filter(r=>start!==null&&end!==null&&Date.parse(r.timestamp)>=start&&Date.parse(r.timestamp)<end&&r.timestamp<=asOf);
  const matched=local.filter(r=>attributedTo(r,q)),identityReason=scopeReason(q);
  const points:Quota[]=[];let conflicting=0;const pointConflicts=new Map<string,string[]>();
  for(const stamp of unique(timeline.map(r=>r.timestamp))){
   const at=timeline.filter(r=>r.timestamp===stamp),codes:string[]=[];
   if(barriers.some(r=>r.timestamp===stamp))codes.push('ambiguous_quota_identity');
   if(new Set(at.map(r=>r.used_percent)).size>1)codes.push('conflicting_percent_values');
   if(new Set(at.map(r=>contextFingerprint(quotaContext(r)))).size>1)codes.push('conflicting_quota_contexts');
   if(new Set(at.map(r=>quotaContext(r).availability.ordinary_usage_allowed)).size>1)codes.push('conflicting_permission_states');
   if(codes.length){conflicting++;pointConflicts.set(stamp,codes);let context=quotaContext(at[0]);for(const r of at.slice(1))context=mergeContexts(context,quotaContext(r));points.push({...at[0],used_percent:NaN,context});}else points.push(at[0]);
  }
  const numericalGaps=gaps(points,thresholdSeconds),observedGaps=reported.filter(g=>g.from<last&&g.to>first);
  const spans:{from:string;to:string;from_snapshot_id:string;to_snapshot_id:string;delta_pp:number|null;local_tokens:number;matched_tokens:number;local_composition:ReturnType<typeof composition>;eligible_for_conditional_research:boolean;reasons:string[]}[]=[];
  let anchor:Quota|undefined;
  const span=(a:Quota,b:Quota,extra:string[]=[])=>{
   const rows=local.filter(r=>r.timestamp>a.timestamp&&r.timestamp<=b.timestamp),allocated=rows.filter(r=>attributedTo(r,q)),mix=composition(rows),delta=b.used_percent-a.used_percent;
   const reasons=[...extra,...(identityReason?[identityReason]:[])];
   if(q.source!=='app_server')reasons.push('non_official_quota_source');
   const chain=points.filter(p=>p.timestamp>=a.timestamp&&p.timestamp<=b.timestamp);
   const permission=chain.map(p=>quotaContext(p).availability.ordinary_usage_allowed);
   if(permission.some(v=>v!==true))reasons.push('ordinary_usage_permission_unverified_or_blocked');
   if(permission.some((v,i)=>i>0&&v!==permission[i-1]))reasons.push('official_permission_change');
   if(chain.some((p,i)=>i>0&&p.used_percent<chain[i-1].used_percent))reasons.push('percent_decrease');
   if(chain.some(p=>!Number.isFinite(p.used_percent)))reasons.push('conflicting_snapshots');
   reasons.push(...chain.flatMap(p=>pointConflicts.get(p.timestamp)??[]));
   if(start===null||end===null||Date.parse(a.timestamp)<start||Date.parse(b.timestamp)>=end)reasons.push('invalid_window_boundaries');
   if(chain.some(p=>p.used_percent<=0||p.used_percent>=100))reasons.push('clipped_endpoint');
   if(!Number.isFinite(delta))reasons.push('conflicting_snapshots');else if(delta<5)reasons.push(delta<0?'percent_decrease':'small_percent_change');
   if(!allocated.length)reasons.push('no_matched_tokens');
   if(rows.some(r=>!r.quota_attribution||r.quota_attribution.source!=='source_event'))reasons.push('unverified_local_account_window_attribution');
   if(rows.some(r=>r.quota_attribution&&!attributedTo(r,q)))reasons.push('different_account_or_window_attribution');
   if(!rows.length)reasons.push('no_recorded_local_usage');
   if(mix.unknown_model_tokens)reasons.push('unknown_model');if(mix.unknown_speed_tokens)reasons.push('unknown_speed');
   if(mix.inconsistent_records)reasons.push('inconsistent_tokens');if(mix.source_unavailable_records)reasons.push('source_unavailable');
   if(rows.some(r=>r.source!=='token_usage_record'))reasons.push('non_provider_usage');
   if([...numericalGaps,...observedGaps].some(g=>g.from<b.timestamp&&g.to>a.timestamp))reasons.push('observation_gap');
   const codes=unique(reasons);return {from:a.timestamp,to:b.timestamp,from_snapshot_id:a.id,to_snapshot_id:b.id,delta_pp:Number.isFinite(delta)?delta:null,local_tokens:mix.total_tokens,matched_tokens:allocated.reduce((n,r)=>n+r.total_tokens,0),local_composition:mix,eligible_for_conditional_research:!codes.length,reasons:codes};
  };
  for(const [i,p] of points.entries()){
   const previous=points[i-1];
   // A bad point/adjacent edge ends the current run. Preserve rejected boundaries,
   // then start a fresh run only at a subsequent allowed, unambiguous point.
   if(!Number.isFinite(p.used_percent)||quotaContext(p).availability.ordinary_usage_allowed!==true){spans.push(span(anchor??previous??p,p));anchor=undefined;continue;}
   if(previous&&(!Number.isFinite(previous.used_percent)||quotaContext(previous).availability.ordinary_usage_allowed!==true)){spans.push(span(previous,p));anchor=p;continue;}
   if(previous&&p.used_percent<previous.used_percent){spans.push(span(anchor??previous,p));anchor=p;continue;}
   if(!anchor){anchor=p;continue;}
   const delta=p.used_percent-anchor.used_percent;
   if(delta>=5){spans.push(span(anchor,p));anchor=p;}
  }
  if(anchor&&anchor.timestamp!==last)spans.push(span(anchor,points.at(-1)!));
  const reasons:Record<string,number>={};for(const s of spans)for(const reason of s.reasons)reasons[reason]=(reasons[reason]??0)+1;
  return {key,source:q.source,limit_id:q.limit_id,slot:q.slot,window_duration_mins:q.window_duration_mins,resets_at:q.resets_at,scope,
   evidence_level:scope.status==='verified'?'verified_quota_scope':scope.account_ref?'observed_account_only':scope.status==='mixed'?'conflicting_identity':'unknown_identity',statement_evidence:[] as unknown[],
   identity_reason:identityReason,scope_evidence:quotaContext(q).evidence??null,
   coverage:{status:'partial_observations',nominal_from:start===null?null:iso(start),nominal_to:end===null?null:iso(end),observed_from:first,observed_to:last,cycle_elapsed:end===null?null:Date.parse(asOf)>=end,unobserved_start_seconds:start===null?null:Math.max(0,(Date.parse(first)-start)/1000),last_sample_age_seconds:Math.max(0,(Date.parse(asOf)-Date.parse(last))/1000),complete_cycle_verified:false,note:'Samples do not establish continuous collection, account completeness or a verified reset operation.'},
   point_count:points.length,conflicting_timestamp_count:conflicting,clipped_point_count:points.filter(p=>p.used_percent===0||p.used_percent===100).length,
   own_scope_point_count:unique(sorted.map(r=>r.timestamp)).length,identity_barrier_count:unique(barriers.map(r=>r.timestamp)).length,identity_barriers_are_attributed_members:false,
   point_evidence:points.map(p=>({timestamp:p.timestamp,snapshot_ids:unique(timeline.filter(r=>r.timestamp===p.timestamp).map(r=>r.id)),used_percent:Number.isFinite(p.used_percent)?p.used_percent:null,ordinary_usage_allowed:quotaContext(p).availability.ordinary_usage_allowed,conflict_reasons:pointConflicts.get(p.timestamp)??[],context_refs:unique(timeline.filter(r=>r.timestamp===p.timestamp).flatMap(r=>{const ctx=quotaContext(r);return ctx.evidence?.context_refs.length?ctx.evidence.context_refs:[contextFingerprint(ctx)];})),observation_ids:[...new Set(timeline.filter(r=>r.timestamp===p.timestamp).flatMap(r=>quotaContext(r).evidence?.observation_ids??[]))].sort((a,b)=>a-b)})),
   local_composition:composition(local),matched_records:matched.length,matched_tokens:matched.reduce((n,r)=>n+r.total_tokens,0),unallocated_local_tokens:local.filter(r=>!attributedTo(r,q)).reduce((n,r)=>n+r.total_tokens,0),
   sample_definition:'nonoverlapping >=5pp clean runs plus rejected decrease/permission/conflict boundaries and trailing partial spans; no pairwise sample inflation',eligible_span_count:spans.filter(s=>s.eligible_for_conditional_research).length,rejected_span_count:spans.filter(s=>!s.eligible_for_conditional_research).length,rejection_counts:reasons,spans,gaps:[...numericalGaps,...observedGaps],gap_threshold_seconds:thresholdSeconds,
   capacity_release:'not_authorized',note:'Eligible spans only describe research input quality. They do not verify weights, a target combination, external usage assumptions, held-out predictions or plan capacity.'};
 });
}

export function resetDiagnostics(quotas:Quota[]){
 const categories=new Map<string,Quota[]>();
 for(const q of quotas){const s=quotaContext(q).scope;if(!s.account_ref||s.status==='mixed')continue;const k=JSON.stringify([scopeKey(s),q.source,q.limit_id,q.slot,q.window_duration_mins]);if(!categories.has(k))categories.set(k,[]);categories.get(k)!.push(q);}
 return [...categories.values()].flatMap(rows=>{rows=[...rows].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id));return rows.slice(1).flatMap((b,i)=>{
  const a=rows[i];if(a.resets_at===null||b.resets_at===null||a.resets_at===b.resets_at)return [];
  const jitter=Math.abs(b.resets_at-a.resets_at)<=1;
  return [{kind:jitter?'deadline_jitter_candidate':'reset_or_window_change_candidate',from:a.timestamp,to:b.timestamp,previous_reset:a.resets_at,next_reset:b.resets_at,previous_percent:a.used_percent,next_percent:b.used_percent,observed_drop_pp:a.used_percent-b.used_percent,account_ref:quotaContext(b).scope.account_ref,from_evidence:quotaContext(a).evidence??null,to_evidence:quotaContext(b).evidence??null,cause:'unverified',natural_reset_verified:false,cycles_merged:false}];
 });});
}

export function accountDailyDiagnostics(snapshots:{timestamp:string;raw_json:string}[],truncated=false){
 const versions=new Map<string,Set<number>>();let latest:any=null;
 for(const s of [...snapshots].sort((a,b)=>a.timestamp.localeCompare(b.timestamp))){const d=JSON.parse(s.raw_json);latest={timestamp:s.timestamp,raw:d};for(const b of d.dailyUsageBuckets??[]){if(typeof b.startDate==='string'&&typeof b.tokens==='number'&&Number.isFinite(b.tokens)){if(!versions.has(b.startDate))versions.set(b.startDate,new Set());versions.get(b.startDate)!.add(b.tokens);}}}
 return {status:'unverified_comparison',observed_from:snapshots.map(s=>s.timestamp).sort()[0]??null,observed_to:latest?.timestamp??null,snapshots:snapshots.length,truncated,timezone:null,account_attribution:'not_supplied',local_official_difference:null,latest_bucket_date:latest?.raw?.dailyUsageBuckets?.map((b:any)=>b.startDate).filter((v:unknown)=>typeof v==='string').sort().at(-1)??null,
  revised_days:[...versions].filter(([,v])=>v.size>1).map(([date,v])=>({date,observed_values:[...v].sort((a,b)=>a-b)})).sort((a,b)=>a.date.localeCompare(b.date)),
  reasons:['official_daily_timezone_unknown','unverified_local_account_attribution','official_summary_latency_unbounded'],instantaneous_external_usage_detected:null,
  note:'Bucket revisions describe reporting updates, not usage at the read timestamp. Missing buckets and thread detail are not zero. Difference remains unknown until time/count/account scope and delay are reconciled.'};
}

export function runtimeDailyDiagnostics(observations:DiagnosticObservation[],timezone:string,thresholdSeconds:number){
 const daily=new Map<string,{date:string;local_ok:number;local_error:number;quota_ok:number;quota_error:number;summary_ok:number;summary_error:number;reported_gap_events:number}>();
 for(const o of observations){const date=localDay(o.timestamp,timezone);if(!daily.has(date))daily.set(date,{date,local_ok:0,local_error:0,quota_ok:0,quota_error:0,summary_ok:0,summary_error:0,reported_gap_events:0});const d=daily.get(date)!;
  if(o.kind==='observation_gap')d.reported_gap_events++;
  if(o.kind==='local_sync'){if(o.status==='ok')d.local_ok++;else d.local_error++;}
  if(o.kind==='account/rateLimits/read'){if(o.status==='ok')d.quota_ok++;else d.quota_error++;}
  if(o.kind==='account/usage/read'){if(o.status==='ok')d.summary_ok++;else d.summary_error++;}
 }
 return {timezone,days:[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)),intervals:['local_sync','account/rateLimits/read','account/usage/read'].map(kind=>{
  const points=observations.filter(o=>o.kind===kind&&o.status==='ok').sort((a,b)=>a.timestamp.localeCompare(b.timestamp));const intervals=points.slice(1).map((p,i)=>(Date.parse(p.timestamp)-Date.parse(points[i].timestamp))/1000);
  const limit=kind==='account/usage/read'?Math.max(3600,thresholdSeconds):thresholdSeconds;
  return {kind,successful_observations:points.length,first:points[0]?.timestamp??null,last:points.at(-1)?.timestamp??null,max_interval_seconds:intervals.length?Math.max(...intervals):null,gap_threshold_seconds:limit,gaps:gaps(points,limit)};
 }),note:'Daily counts cover only the queried observation range. An absent success or zero recorded gap count is not proof of zero usage or continuous collection.'};
}

export function storageSnapshot(home:string,sampledAt=new Date().toISOString()){
 const files=['usage.db','usage.db-wal','logs/monitor.jsonl','logs/monitor.jsonl.1','logs/service-error.log'].map(name=>{try{const s=statSync(join(home,name));return {name,status:'observed',bytes:s.size,modified_at:iso(s.mtimeMs)};}catch(e){return {name,status:(e as NodeJS.ErrnoException).code==='ENOENT'?'absent':'unavailable',bytes:null,modified_at:null};}});
 return {sampled_at:sampledAt,files,daily_growth_bytes:null,note:'Current file stat only; no inferred daily growth or database deletion. Monitor log rolling already exists. Save independent daily snapshots to measure growth.'};
}

// Query-only derived diagnostics; no schema changes, cache writes or raw source scans.
export function capacityDiagnostics(db:Ledger,latest:Quota[],asOf:string,config:Config,home?:string){
 const end=iso(Date.parse(asOf)+1),floor=Date.parse(asOf)-8*864e5;
 const starts=latest.map(nominalStart).filter((s):s is number=>s!==null&&s<=Date.parse(asOf));const from=iso(Math.max(floor,starts.length?Math.min(...starts):Date.parse(asOf)-864e5));
 const quotas:Quota[]=[];let quotaTruncated=false;
 const categories=new Map(latest.map(q=>[JSON.stringify([q.limit_id,q.slot]),q]));
 for(const q of categories.values()){
  const args=[q.limit_id,q.slot,from,end];
  const rows=db.db.prepare("SELECT * FROM quota_snapshots INDEXED BY quota_latest WHERE limit_id=? AND slot=? AND timestamp>=? AND timestamp<? AND source='app_server' ORDER BY timestamp LIMIT 5001").all(...args) as unknown as Quota[];
  quotaTruncated ||= rows.length>5000;quotas.push(...rows.slice(0,5000).map(r=>db.quotaProjection(r)));
  const prior=db.db.prepare("SELECT * FROM quota_snapshots INDEXED BY quota_latest WHERE limit_id=? AND slot=? AND timestamp<? AND source='app_server' ORDER BY timestamp DESC LIMIT 1").get(q.limit_id,q.slot,from) as unknown as Quota|undefined;if(prior)quotas.push(db.quotaProjection(prior));
 }
 for(const q of latest)if(q.timestamp>=from&&q.timestamp<=asOf&&!quotas.some(v=>v.id===q.id))quotas.push(q);
 const observationFrom=iso(Math.max(floor,Math.min(Date.parse(from),Date.parse(asOf)-864e5,...quotas.map(q=>Date.parse(q.timestamp)))));
 const obs=db.db.prepare('SELECT id,timestamp,source,kind,status,raw_json FROM observations INDEXED BY observation_time WHERE timestamp>=? AND timestamp<? ORDER BY timestamp LIMIT 10001').all(observationFrom,end) as unknown as DiagnosticObservation[];
 const observations=obs.slice(0,10000),observationsTruncated=obs.length>10000;
 const accounts=db.db.prepare('SELECT timestamp,raw_json FROM account_usage_snapshots WHERE timestamp>=? AND timestamp<? ORDER BY timestamp DESC LIMIT 129').all(iso(Date.parse(asOf)-2*864e5),end) as unknown as {timestamp:string;raw_json:string}[];
 const usage=db.records(from,end),threshold=Math.max(config.monitor?.quota_active_seconds??300,config.monitor?.quota_idle_seconds??900)*2;
 const windows=windowDiagnostics(quotas.filter(q=>q.timestamp>=from),usage,asOf,threshold,reportedGaps(observations));
 if(quotaTruncated||observationsTruncated||starts.some(s=>s<floor))for(const w of windows){for(const s of w.spans){s.eligible_for_conditional_research=false;s.reasons=unique([...s.reasons,'diagnostic_query_truncated']);}w.eligible_span_count=0;w.rejected_span_count=w.spans.length;w.rejection_counts.diagnostic_query_truncated=w.spans.length;}
 return {schema_version:1,status:'diagnostic_only',as_of:asOf,query:{from,to_exclusive:end,maximum_lookback_days:8,cycle_query_clipped:starts.some(s=>s<floor),quota_truncated:quotaTruncated,observations_truncated:observationsTruncated},
  windows,reset_candidates:resetDiagnostics(quotas),
  account_daily:accountDailyDiagnostics(accounts.slice(0,128),accounts.length>128),runtime_daily:runtimeDailyDiagnostics(observations,config.timezone,threshold),storage_snapshot:home?storageSnapshot(home):null,
  capacity_release:'not_authorized',conditions:['source_event account/window attribution is separate from user statements','target functional identifiability and external usage assumptions require separate evidence','freeze fit/holdout before future validation','at least one real complete cycle must be independently accepted'],
  note:'Additive diagnostics do not upgrade strict or experimental estimates. Unknown comparisons and capacity remain null.'};
}
