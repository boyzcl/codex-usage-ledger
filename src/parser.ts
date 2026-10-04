import {hash,normalizeQuota} from './quota.js';
import {tokenFields,type Tokens,type Usage,type ParseState,type ParseOutput,type Context} from './types.js';
import {projectJson,relevantLine} from './privacy.js';
export function initialState():ParseState{return {thread_id:'unknown',session_id:'unknown',parent_thread_id:null,fork_ordinal_exclusive:null,created_at:null,turn_id:null,root_turn_id:null,previous:null,exact_turns:[],contexts:{},legacy_index:0,has_exact:false,replay_done:false,replay_next_index:null,model:'unknown',model_source:'unknown',service_tier:'unknown',reasoning_effort:null,project:null};}
export function tokens(raw:any):Tokens|null {
 if(!raw||typeof raw.input_tokens!=='number'||typeof raw.output_tokens!=='number')return null;
 const t=Object.fromEntries(tokenFields.map(k=>[k,raw[k]??0])) as Tokens;
 if(tokenFields.some(k=>!Number.isSafeInteger(t[k])||t[k]<0))return null;
 if(raw.total_tokens===undefined)t.total_tokens=t.input_tokens+t.output_tokens;
 return t;
}
function context(s:ParseState):Context{return {model:s.model,model_source:s.model_source,service_tier:s.service_tier,reasoning_effort:s.reasoning_effort,project:s.project};}
function applyContext(s:ParseState,p:any,source:string){
 if(typeof p.model==='string'){s.model=p.model;s.model_source=source;}
 if(Object.hasOwn(p,'service_tier'))s.service_tier=typeof p.service_tier==='string'?p.service_tier:'unknown';
 if(Object.hasOwn(p,'effort')||Object.hasOwn(p,'reasoning_effort'))s.reasoning_effort=p.effort??p.reasoning_effort??null;
 if(typeof p.cwd==='string')s.project=p.cwd;
}
export function parseLine(line:string,s:ParseState):ParseOutput {
 const out:ParseOutput={usage:[],quotas:[],issues:[]};if(!relevantLine(line))return out;
 const e=projectJson(line);const p=e.payload??{};const typ=e.type==='event_msg'?p.type:e.type;
 const stamp=typeof e.timestamp==='string'&&Number.isFinite(Date.parse(e.timestamp))?new Date(e.timestamp).toISOString():null;
 const issue=(code:string)=>out.issues.push({code,timestamp:stamp});
 if(typ==='session_meta'){
  s.thread_id=p.id??s.thread_id;s.session_id=p.session_id??p.id??s.session_id;s.created_at=p.timestamp??stamp;
  s.parent_thread_id=p.forked_from_id??p.source?.subagent?.thread_spawn?.parent_thread_id??p.source?.subagent?.fork?.parent_thread_id??null;
  s.fork_ordinal_exclusive=Number.isSafeInteger(p.forked_from_ordinal_exclusive)&&p.forked_from_ordinal_exclusive>=0?p.forked_from_ordinal_exclusive:null;
  if(typeof p.cwd==='string')s.project=p.cwd;return out;
 }
 if(typ==='task_started'){s.turn_id=p.turn_id??null;s.root_turn_id=p.root_turn_id??null;return out;}
 if(typ==='turn_context'){
  s.turn_id=p.turn_id??s.turn_id;s.root_turn_id=p.root_turn_id??s.root_turn_id;applyContext(s,p,'turn_context');
  if(s.turn_id)s.contexts[s.turn_id]=context(s);return out;
 }
 if(typ==='thread_settings_applied'){
  // Copied settings retain their owner. Never let parent's settings overwrite child settings.
  if(p.thread_id&&p.thread_id!==s.thread_id)return out;
  // This event carries the complete persisted settings, unlike reroute patches.
  s.model='unknown';s.model_source='unknown';s.service_tier='unknown';s.reasoning_effort=null;
  applyContext(s,p.thread_settings??{},'thread_settings_applied');if(s.turn_id)s.contexts[s.turn_id]=context(s);return out;
 }
 if(typ==='model_rerouted'||typ==='model/rerouted'){applyContext(s,{...p,model:p.to_model??p.model},'model_rerouted');if(s.turn_id)s.contexts[s.turn_id]=context(s);return out;}
 if(!stamp){issue('missing_timestamp');return out;}
 function make(t:Tokens,payload:any,source:string,identity:string):Usage{
  const turn=payload.turn_id??s.turn_id;const owner=payload.thread_id??s.thread_id;
  const c=turn&&s.contexts[turn]?s.contexts[turn]:context(s);
  const inherited=owner!==s.thread_id||(!!s.created_at&&Date.parse(stamp!)<Date.parse(s.created_at));
  const inconsistent=t.cached_input_tokens+t.cache_write_input_tokens>t.input_tokens||t.reasoning_output_tokens>t.output_tokens||t.total_tokens!==t.input_tokens+t.output_tokens;
  if(inconsistent)issue('inconsistent_token_components');
  return {...t,id:identity,response_id:payload.response_id??null,session_id:payload.session_id??s.session_id,thread_id:owner,turn_id:turn,root_turn_id:payload.root_turn_id??s.root_turn_id,timestamp:stamp!,model:payload.model??c.model,model_source:payload.model?'response':c.model_source,reasoning_effort:payload.reasoning_effort??c.reasoning_effort,service_tier:payload.service_tier??c.service_tier,project:c.project,uncached_input_tokens:Math.max(t.input_tokens-t.cached_input_tokens-t.cache_write_input_tokens,0),source,attribution_quality:payload.model?'explicit':c.model==='unknown'?'unknown':owner===s.thread_id?'context':'inherited',data_quality:inconsistent?'inconsistent':source==='token_usage_record'?'provider_reported':source==='compaction_recovered'?'recovered_timestamp':'legacy_estimated',inherited,parent_thread_id:s.parent_thread_id,fork_ordinal_exclusive:s.fork_ordinal_exclusive,fingerprint:null,ordinal:e.ordinal??null,api_equivalent_usd:null,credit_equivalent:null,allowance_weight:null,api_rule_id:null,credit_rule_id:null,allowance_rule_id:null};
 }
 if(typ==='token_usage_record'){
  const t=tokens(p.usage);if(!t||!p.response_id){issue('invalid_usage_record');return out;}
  const r=make(t,p,'token_usage_record','response:'+p.response_id);out.usage.push(r);
  if(r.thread_id===s.thread_id){s.has_exact=true;if(r.turn_id&&!s.exact_turns.includes(r.turn_id))s.exact_turns.push(r.turn_id);out.exactTurn={thread:r.thread_id,turn:r.turn_id??''};}
  return out;
 }
 if(typ==='compacted'){
  // Embedded latest usage is a resume snapshot, not necessarily the compaction request.
  // Only recover it when its response ID matches the explicit compaction ID.
  if(p.compaction_response_id&&p.latest_token_usage_record?.response_id===p.compaction_response_id){
   const t=tokens(p.latest_token_usage_record.usage);if(t)out.usage.push(make(t,p.latest_token_usage_record,'compaction_recovered','response:'+p.compaction_response_id));
  }else if(!s.has_exact)issue('unrecoverable_usage_gap');return out;
 }
 if(typ!=='token_count')return out;
 if(p.rate_limits)out.quotas=normalizeQuota(p.rate_limits,stamp,'rollout');
 const current=tokens(p.info?.total_token_usage),last=tokens(p.info?.last_token_usage),prev=s.previous;
 let delta:Tokens|null=null;
 if(current){
  const reset=prev&&current.total_tokens<prev.total_tokens&&current.input_tokens<prev.input_tokens;
  const high=prev&&!reset?Object.fromEntries(tokenFields.map(k=>[k,Math.max(current[k],prev[k])])) as Tokens:current;
  const advanced=!prev||reset||high.total_tokens>prev.total_tokens;
  if(advanced)delta=last??(prev&&!reset?Object.fromEntries(tokenFields.map(k=>[k,high[k]-prev[k]])) as Tokens:current);
  s.previous=high;
 }else delta=last;
 if(!delta||delta.total_tokens===0)return out;
 s.legacy_index++;
 if(s.turn_id?s.exact_turns.includes(s.turn_id):s.has_exact)return out;
 const fp=hash([current,last]);const id='legacy:'+hash([s.thread_id,s.turn_id,stamp,current,last]);
 const r=make(delta,{},'legacy_token_count',id);r.fingerprint=fp;out.usage.push(r);
 if(!prev&&current&&last&&current.total_tokens>last.total_tokens)issue('legacy_initial_baseline_gap');
 return out;
}
