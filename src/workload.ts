import type {Quota,Usage} from './types.js';
import type {Ledger} from './store.js';
import {aggregate} from './report.js';
import {mode} from './pricing.js';
import {quotaCycleKey} from './quota-policy.js';
export function workloadRanges(quotas:Quota[],asOf:string,timezone:string){
 const to_exclusive=new Date(Date.parse(asOf)+1).toISOString();
 const ranges=[7,30].map(days=>({name:`last_${days}_days`,from:new Date(Date.parse(asOf)-days*864e5).toISOString(),to_exclusive,timezone}));
 for(const q of quotas){if(q.resets_at===null||q.window_duration_mins===null||q.window_duration_mins<=0)continue;const from=new Date((q.resets_at-q.window_duration_mins*60)*1000).toISOString();if(from<=asOf)ranges.push({name:quotaCycleKey(q),from,to_exclusive:[new Date(q.resets_at*1000).toISOString(),to_exclusive].sort()[0],timezone});}
 return {ranges,query:{from:ranges.map(r=>r.from).sort()[0],to_exclusive,timezone},as_of:asOf};
}
export function workloadViews(rows:Usage[],quotas:Quota[],asOf:string,timezone:string){
 const request=workloadRanges(quotas,asOf,timezone);
 return {...request,sum_across_windows_allowed:false,windows:request.ranges.map(range=>{
  const records=rows.filter(r=>r.timestamp>=range.from&&r.timestamp<range.to_exclusive);
  const groups=(key:(r:Usage)=>string)=>Object.fromEntries([...new Set(records.map(key))].sort().map(k=>[k,aggregate(records.filter(r=>key(r)===k))]));
  return {...range,kind:range.name.startsWith('last_')?'recent_local_history':'local_activity_during_cycle_time_range',totals:aggregate(records),models:groups(r=>r.model),speeds:groups(r=>mode(r.service_tier)),coverage:{status:'partial_observed_history',requested_from:range.from,requested_to_exclusive:range.to_exclusive,observed_from:records[0]?.timestamp??null,observed_to:records.at(-1)?.timestamp??null,note:'All recorded local facts in the requested range; absent logs or official samples are not proof of zero usage or continuous coverage.'},attribution:'local_workload_not_assigned_to_account_or_quota_windows'};
 })};
}
export function currentWorkload(db:Ledger,quotas:Quota[],asOf:string,timezone:string){
 const range=workloadRanges(quotas,asOf,timezone).query;
 const rows=db.records(range.from,range.to_exclusive);
 return {rows,view:workloadViews(rows,quotas,asOf,timezone)};
}
