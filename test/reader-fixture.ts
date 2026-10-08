// Explicit synthetic display fixtures; never production account/window evidence.
import {dailyReport} from '../src/daily.js';
import {period} from '../src/report.js';
import {responseContext} from '../src/quota-policy.js';
import {initialState,parseLine} from '../src/parser.js';
import type {PriceRule,Quota,Usage} from '../src/types.js';
const from=Date.parse('2026-09-30T16:00:00.000Z');
export const syntheticPrice:PriceRule={id:'synthetic-display-api',kind:'api',model:'gpt-6.1-sol',processing_mode:'standard',effective_from:'2026-09-29T00:00:00Z',effective_to:null,context_min:0,context_max:null,rates:{input:2,cached_input:.1,cache_write:2,output:10},source_url:'https://example.com/synthetic',retrieved_at:'2026-09-29T00:00:00Z',basis:'synthetic fixture only'};
export function syntheticUsage(timestamp:string,tokens:number,model='gpt-6.1-sol'):Usage {
 const row=parseLine(JSON.stringify({timestamp,type:'token_usage_record',payload:{thread_id:'synthetic-display',response_id:timestamp+model,usage:{input_tokens:tokens*.8,cached_input_tokens:tokens*.4,output_tokens:tokens*.2,total_tokens:tokens}}}),initialState()).usage[0];
 return {...row,model,service_tier:'default'};
}
export function syntheticQuota(timestamp:string,used_percent:number,resets_at=(from+10*86400000)/1000):Quota {
 const context=responseContext({accountId:'synthetic-display-account',ordinaryUsageAllowed:true,spendControlReached:false},null,timestamp,'app_server');
 return {id:'synthetic-'+timestamp,timestamp,used_percent,resets_at,source:'app_server',slot:'primary',limit_id:'codex',window_duration_mins:14400,context,raw_json:'{"planType":"synthetic"}'};
}
export function syntheticInput(days=10){
 const quotas:Quota[]=[],rows:Usage[]=[];
 for(let i=0;i<days;i++){
  const start=from+i*86400000;
  for(let n=0;n<3;n++)quotas.push(syntheticQuota(new Date(start+(15+n*15)*60000).toISOString(),i*2+n));
  for(let n=0;n<2;n++)rows.push(syntheticUsage(new Date(start+(20+n*15)*60000).toISOString(),(i+1)*1000));
 }
 const last=new Date(from+(days-1)*86400000).toISOString();
 const range=period('report','Asia/Shanghai','2026-10-01',new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(last)));
 return {rows,quotas,rules:[syntheticPrice],range,at:range.to_exclusive};
}
export function syntheticReport(days=10){const x=syntheticInput(days);return {period:x.range,...dailyReport(x.rows,x.quotas,x.rules,x.range,x.at)};}
export function recoveryReport(){
 const x=syntheticInput(1),start=from+45*60000,newReset=(start+14400*60000)/1000;
 x.quotas=[syntheticQuota(new Date(from+15*60000).toISOString(),10),syntheticQuota(new Date(from+30*60000).toISOString(),11),syntheticQuota(new Date(start).toISOString(),3,newReset),syntheticQuota(new Date(from+60*60000).toISOString(),4,newReset)];
 x.rows=[syntheticUsage(new Date(from+20*60000).toISOString(),10000),syntheticUsage(new Date(from+50*60000).toISOString(),20000)];
 return {period:x.range,...dailyReport(x.rows,x.quotas,x.rules,x.range,x.at)};
}
