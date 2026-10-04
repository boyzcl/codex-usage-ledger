import {responseContext,scopeKey} from './quota-policy.js';
import {createHash} from 'node:crypto';
import type {Quota} from './types.js';
export const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
// Only account quota/usage RPCs reach this function; auth and transcript RPCs are never requested.
export function normalizeQuota(raw:any,timestamp:string,source:string):Quota[]{
 const result:Quota[]=[];
 const buckets=raw?.rateLimitsByLimitId?Object.entries(raw.rateLimitsByLimitId):[[raw?.limit_id??raw?.limitId??raw?.rateLimits?.limitId??'unknown',raw?.rateLimits??raw]];
 for(const [key,b] of buckets as [string,any][]){if(!b)continue;for(const slot of ['primary','secondary']){
  const w=b[slot];if(!w)continue;const used=w.usedPercent??w.used_percent;
  if(typeof used!=='number'||!Number.isFinite(used)||used<0||used>100)continue;
  const row={timestamp,limit_id:b.limitId??b.limit_id??key,slot,window_duration_mins:w.windowDurationMins??w.window_minutes??null,resets_at:w.resetsAt??w.resets_at??null,used_percent:used,source,raw_json:JSON.stringify(b)};
  const context=source==='app_server'&&(raw?.accountId!=null||raw?.ordinaryUsageAllowed!=null||b.spendControlReached!=null||b.individualLimit!=null)?responseContext(raw,b,timestamp,source):undefined;
  const base=[timestamp,row.limit_id,slot,row.window_duration_mins,row.resets_at,used,source];
  result.push({id:hash(context?.scope.account_ref?[...base,scopeKey(context.scope)]:base),...row,...(context?{context}:{})});
 }}return result;
}

export const legacyQuotaId=(q:Quota)=>hash([q.timestamp,q.limit_id,q.slot,q.window_duration_mins,q.resets_at,q.used_percent,q.source]);
