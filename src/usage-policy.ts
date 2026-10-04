import {tokenFields,type Usage} from './types.js';
export type UsageIntent='append'|'reparse'|'repair'|'retain';
export const sameFacts=(a:Usage,b:Usage)=>tokenFields.every(k=>a[k]===b[k]);
export const contextKeys=['thread_id','session_id','turn_id','root_turn_id','timestamp','model','model_source','service_tier','reasoning_effort','project','source','inherited','attribution_quality','data_quality'] as const;
export const sameContext=(a:Usage,b:Usage)=>contextKeys.every(k=>a[k]===b[k]);
// Reliability is a partial order: a child or recovered snapshot cannot downgrade an original.
export function usageDecision(old:Usage,next:Usage,intent:UsageIntent):'keep'|'replace'|'conflict'{
 if(!sameFacts(old,next))return 'conflict';
 const origin=(r:Usage)=>r.origin_thread_id??(r.inherited?null:r.thread_id);
 if(old.source==='token_usage_record'&&next.source!=='token_usage_record')return 'keep';
 if(!old.inherited&&next.inherited)return 'keep';
 if(old.inherited&&!next.inherited)return 'replace';
 if(old.source!=='token_usage_record'&&next.source==='token_usage_record')return 'replace';
 if(sameContext(old,next))return 'keep';
 const sameOwner=origin(old)!==null&&origin(old)===origin(next)&&old.thread_id===next.thread_id;
 const sameSource=!old.origin_source||!next.origin_source||old.origin_source===next.origin_source;
 if(intent==='retain')return 'replace';
 if((intent==='reparse'||intent==='repair')&&sameOwner&&sameSource)return 'replace';
 // Known explicit attribution may enrich unknown/context attribution, but peers need adjudication.
 if(old.model==='unknown'&&next.model!=='unknown')return 'replace';
 if(next.model==='unknown'&&old.model!=='unknown')return 'keep';
 if(old.model_source==='response'&&next.model_source!=='response')return 'keep';
 if(next.model_source==='response'&&old.model_source!=='response')return 'replace';
 return 'conflict';
}
// Unknown turns require concrete adjacent source events, with a boundary reset and equal facts/time.
export function unknownPair(a:Usage,b:Usage){return a.turn_id===null&&b.turn_id===null&&a.thread_id===b.thread_id&&a.timestamp===b.timestamp&&sameFacts(a,b)&&a.source!==b.source&&[a.source,b.source].includes('token_usage_record')&&[a.source,b.source].includes('legacy_token_count');}

export const authorityUpgrade=(old:Usage,next:Usage)=>(old.inherited&&!next.inherited)||(old.source!=='token_usage_record'&&next.source==='token_usage_record');
