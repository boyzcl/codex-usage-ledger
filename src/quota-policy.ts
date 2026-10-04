import {createHash} from 'node:crypto';
import type {Quota,Usage} from './types.js';
export interface QuotaScope {
 account_ref:string|null;workspace_ref:string|null;billing_source:string|null;
 status:'verified'|'partial'|'unknown'|'mixed';source:string;
}
export interface Availability {
 ordinary_usage_allowed:boolean|null;ordinary_usage_status:'allowed'|'blocked'|'unknown';
 spend_control_reached:boolean|null;individual_limit:unknown;rate_limit_reached_type:unknown;
 source:string;sampled_at:string;note:string;
}
export interface QuotaContext {scope:QuotaScope;availability:Availability;evidence?:{source:string;method:string|null;origin:'direct_response'|'recovered_observation'|'ambiguous_observations'|'missing';observation_ids:number[];context_refs:string[]};}
const bool=(v:unknown)=>typeof v==='boolean'?v:null;
export const identityRef=(id:string)=>createHash('sha256').update('codex-backend-account\0'+id).digest('hex');
export function responseContext(raw:any,bucket:any,timestamp:string,source:string):QuotaContext {
 const account=source==='app_server'&&typeof raw?.accountId==='string'&&raw.accountId.length?identityRef(raw.accountId):null;
 // accountId is the backend account associated with this read, not a user ID or a workspace field.
 const scope:QuotaScope={account_ref:account,workspace_ref:null,billing_source:null,status:account?'partial':'unknown',source:account?'account/rateLimits/read.accountId':'unavailable'};
 const allowed=source==='app_server'?bool(raw?.ordinaryUsageAllowed):null;
 return {scope,evidence:{source,method:source==='app_server'?'account/rateLimits/read':null,origin:raw?'direct_response':'missing',observation_ids:[],context_refs:[]},availability:{ordinary_usage_allowed:allowed,ordinary_usage_status:allowed===null?'unknown':allowed?'allowed':'blocked',spend_control_reached:bool(bucket?.spendControlReached),individual_limit:bucket?.individualLimit??null,rate_limit_reached_type:bucket?.rateLimitReachedType??null,source,sampled_at:timestamp,note:'Official permission and spend control are independent of percentages; reset time does not promise recovery.'}};
}
export function quotaContext(q:Quota):QuotaContext {return q.context??responseContext(null,JSON.parse(q.raw_json),q.timestamp,q.source);}
export function scopeKey(scope:QuotaScope):string {return JSON.stringify([scope.account_ref,scope.workspace_ref,scope.billing_source,scope.status]);}
export function quotaCycleKey(q:Quota):string {
 const scope=quotaContext(q).scope;
 // Missing identity never makes distinct observations a proven common account.
 return JSON.stringify([scopeKey(scope),scope.status==='verified'&&scope.account_ref&&scope.workspace_ref&&scope.billing_source?null:q.id,q.source,q.limit_id,q.slot,q.window_duration_mins,q.resets_at]);
}
export function scopeReason(q:Quota):string|null {
 const scope=quotaContext(q).scope;
 return scope.status==='mixed'?'mixed_account_identity':!scope.account_ref?'unknown_account_identity':scope.status!=='verified'||!scope.workspace_ref||!scope.billing_source?'unverified_workspace_billing_identity':null;
}
export function attributedTo(u:Usage,q:Quota):boolean {
 return attributedToCategory(u,q)&&u.quota_attribution!.resets_at===q.resets_at;
}
export function attributedToCategory(u:Usage,q:Quota):boolean {
 const a=u.quota_attribution;if(!a||a.source!=='source_event'||scopeReason(q))return false;
 return scopeKey(a.scope)===scopeKey(quotaContext(q).scope)&&a.limit_id===q.limit_id&&a.slot===q.slot&&a.window_duration_mins===q.window_duration_mins;
}
export function historicalAllocationReason(q:Quota,rows:Usage[]):string|null {
 const identity=scopeReason(q);if(identity)return identity;
 for(const row of rows){
  const a=row.quota_attribution;
  if(!a||a.source!=='source_event'||a.scope.status!=='verified'||!a.scope.account_ref||!a.scope.workspace_ref||!a.scope.billing_source||!a.limit_id||!a.slot||!Number.isFinite(a.window_duration_mins)||a.window_duration_mins<=0||!Number.isFinite(a.resets_at))return 'partial_local_account_window_attribution';
  // Each source event must belong to its own declared historical cycle, rather than the current reset.
  if(attributedToCategory(row,q)&&(!Number.isFinite(a.resets_at)||Date.parse(row.timestamp)<(a.resets_at-a.window_duration_mins*60)*1000||Date.parse(row.timestamp)>=a.resets_at*1000))return 'invalid_historical_window_attribution';
 }
 return null;
}
export function allocationReason(q:Quota,rows:Usage[]):string|null {
 const identity=scopeReason(q);if(identity)return identity;
 if(!rows.some(r=>attributedTo(r,q)))return 'unverified_local_account_window_attribution';
 if(rows.some(r=>!r.quota_attribution||r.quota_attribution.source!=='source_event'||r.quota_attribution.scope.status!=='verified'||!r.quota_attribution.scope.account_ref||!r.quota_attribution.scope.workspace_ref||!r.quota_attribution.scope.billing_source))return 'partial_local_account_window_attribution';
 return null;
}
// Raw private evidence stays in SQLite; output identity only as the normalized namespace hash.
export function redactIdentity(value:any):any {
 if(Array.isArray(value))return value.map(redactIdentity);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['accountId','account_id','userId','user_id','workspaceId','workspace_id','email'].includes(key)).map(([k,v])=>[k,redactIdentity(v)]));
 return value;
}

export function officialSnapshot(raw:any,timestamp:string){
 const context=responseContext(raw,raw?.rateLimits,timestamp,'app_server');
 return {...context,buckets:Object.entries(raw?.rateLimitsByLimitId??{default:raw?.rateLimits}).filter(([,b])=>b).map(([key,b]:[string,any])=>({limit_id:b.limitId??key,...responseContext(raw,b,timestamp,'app_server')}))};
}

export function recoveredContext(context:QuotaContext,id:number):QuotaContext {
 return {...context,evidence:{source:'app_server',method:'account/rateLimits/read',origin:'recovered_observation',observation_ids:[id],context_refs:[]}};
}
export const contextFingerprint=(c:QuotaContext)=>createHash('sha256').update(JSON.stringify([c.scope,c.availability])).digest('hex');
export function mergeContexts(old:QuotaContext|undefined,next:QuotaContext):QuotaContext {
 const references=[...new Set([...(old?.evidence?.context_refs??[]),...(old&&!old.evidence?.context_refs.length?[contextFingerprint(old)]:[]),...(next.evidence?.context_refs.length?next.evidence.context_refs:[contextFingerprint(next)])])].sort();
 const ids=[...new Set([...(old?.evidence?.observation_ids??[]),...(next.evidence?.observation_ids??[])])].sort((a,b)=>a-b);
 const ambiguous=old?.scope.status==='mixed'||references.length>1;
 const evidence:QuotaContext['evidence']={source:next.availability.source,method:next.evidence?.method??null,origin:ambiguous?'ambiguous_observations':old?.evidence?.origin==='recovered_observation'||next.evidence?.origin==='recovered_observation'?'recovered_observation':next.evidence?.origin??'missing',observation_ids:ids,context_refs:references};
 if(!ambiguous)return {...next,evidence};
 return {scope:{...next.scope,account_ref:null,workspace_ref:null,billing_source:null,status:'mixed'},availability:{...next.availability,ordinary_usage_allowed:null,ordinary_usage_status:'unknown',spend_control_reached:null,individual_limit:null,rate_limit_reached_type:null,note:'Ambiguous source contexts; inspect referenced private observations. No identity or permission chosen.'},evidence};
}
