// A JSON projection reader: discarded strings/objects are scanned as bytes of text,
// never decoded, retained, logged, or used for usage accounting.
export type Shape={ [key:string]:Shape|true };
const tokens:Shape=Object.fromEntries(['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'].map(k=>[k,true]));
const record:Shape={thread_id:true,turn_id:true,session_id:true,root_turn_id:true,response_id:true,model:true,service_tier:true,reasoning_effort:true,usage:tokens,thread_token_usage:tokens};
const window:Shape={used_percent:true,window_minutes:true,resets_at:true};
const quota:Shape={limit_id:true,limit_name:true,primary:window,secondary:window,credits:{has_credits:true,unlimited:true,balance:true},plan_type:true};
const settings:Shape={model:true,service_tier:true,reasoning_effort:true,cwd:true,model_provider_id:true};
const payload:Shape={...record,id:true,timestamp:true,type:true,cwd:true,effort:true,cli_version:true,forked_from_id:true,
 source:{subagent:{thread_spawn:{parent_thread_id:true},fork:{parent_thread_id:true}}},
 thread_settings:settings, info:{total_token_usage:tokens,last_token_usage:tokens},rate_limits:quota,
 compaction_response_id:true,latest_token_usage_record:record,to_model:true,from_model:true};
const shape:Shape={timestamp:true,ordinal:true,type:true,payload};
export function projectJson(text:string, selected:Shape=shape):any {
 let i=0;
 const ws=()=>{while(i<text.length && /\s/.test(text[i]))i++;};
 function strEnd(){if(text[i++]!=='"')throw Error('invalid_json');while(i<text.length){const c=text[i++];if(c==='"')return;if(c==='\\')i++;}throw Error('invalid_json');}
 function skip(){ws();const c=text[i];if(c==='"'){strEnd();return;}if(c==='{'||c==='['){const end=c==='{'?'}':']';i++;while(i<text.length){ws();if(text[i]===end){i++;return;}if(text[i]===','||text[i]===':'){i++;continue;}skip();}throw Error('invalid_json');}const start=i;while(i<text.length&&!/[\s,}\]]/.test(text[i]))i++;if(i===start)throw Error('invalid_json');}
 function read(s:Shape|true):any {ws();if(s===true){const start=i;skip();return JSON.parse(text.slice(start,i));}if(text[i]!=='{'){skip();return null;}i++;const out:Record<string,unknown>={};while(i<text.length){ws();if(text[i]==='}'){i++;return out;}const start=i;strEnd();const key=JSON.parse(text.slice(start,i)) as string;ws();if(text[i++]!==':')throw Error('invalid_json');if(Object.hasOwn(s,key))out[key]=read(s[key]);else skip();ws();if(text[i]===','){i++;continue;}if(text[i]!=='}')throw Error('invalid_json');}throw Error('invalid_json');}
 const out=read(selected);ws();if(i!==text.length)throw Error('invalid_json');return out;
}
export function relevantLine(line:string):boolean {
 const head=line.slice(0,400);const top=/"type"\s*:\s*"([^"]+)"/.exec(head)?.[1];
 if(!top)throw Error('invalid_header');
 if(['session_meta','turn_context','token_usage_record','compacted'].includes(top))return true;
 if(top!=='event_msg')return false;
 const sub=/"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(head)?.[1];
 return sub!==undefined && ['token_count','thread_settings_applied','task_started','model_rerouted','model/rerouted'].includes(sub);
}
