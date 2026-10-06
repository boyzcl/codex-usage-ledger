import test from 'node:test';
import assert from 'node:assert/strict';
import {conditionalCapacity} from '../src/conditional-capacity.js';
import {normalizeQuota} from '../src/quota.js';
import {parseLine,initialState} from '../src/parser.js';
import {dailyReport} from '../src/daily.js';
import {format,cellWidth} from '../src/display.js';
import type {Usage,Quota,PriceRule} from '../src/types.js';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const range={from:'2026-10-06T00:00:00.000Z',to_exclusive:'2026-10-09T00:00:00.000Z',timezone:'UTC'};
const reset=Date.parse('2026-10-12T00:00:00Z')/1000,model='gpt-6.1-sol';
const time=(minute:number)=>new Date(Date.parse(range.from)+minute*60000).toISOString();
function q(minute:number,used:number,extra:Partial<Quota>={},account='test-account'):Quota{return {...normalizeQuota({accountId:account,rateLimits:{limitId:'codex',primary:{usedPercent:used,windowDurationMins:10080,resetsAt:reset}}},time(minute),'app_server')[0],...extra};}
function u(minute:number,tokens=100,extra:Partial<Usage>={}):Usage{
 const row=parseLine(JSON.stringify({timestamp:time(minute),type:'token_usage_record',payload:{response_id:String(minute),thread_id:'conditional',usage:{input_tokens:tokens,output_tokens:0,total_tokens:tokens,cached_input_tokens:0}}}),initialState()).usage[0];
 return {...row,model,service_tier:'standard',...extra};
}
const api:PriceRule={id:'api-test',kind:'api',model,processing_mode:'standard',effective_from:'2026-10-01T00:00:00Z',effective_to:null,context_min:0,context_max:null,rates:{input:2,cached_input:.2,cache_write:2.5,output:10},source_url:'https://example.com/price',retrieved_at:'2026-10-01T00:00:00Z',basis:'test-fixed'};
const credit:PriceRule={...api,id:'credit-test',kind:'credit',rates:{input:50,cached_input:5,cache_write:50,output:250}};
const rules=[api,credit];
const run=(rows:Usage[],qs:Quota[],options:Parameters<typeof conditionalCapacity>[4]={})=>conditionalCapacity(rows,qs,rules,range,options);
test('E plateau keeps every record, includes a delayed empty jump, and never divides a zero-only span',()=>{
 const value=run([u(.5),u(1.5),u(2.5)],[q(0,10),q(1,10),q(2,10),q(3,11)]),w=value.windows[0];
 assert.equal(w.percent_points,1);assert.equal(w.total_tokens,300);assert.ok(Math.abs(w.api.equivalent_100_percent!-.06)<1e-12);assert.ok(Math.abs(w.reference_tokens!-30000)<1e-8);
 const lag=run([u(.5)],[q(0,10),q(1,10),q(2,11)]);assert.equal(lag.windows[0].total_tokens,100);assert.equal(lag.windows[0].percent_points,1);assert.equal(lag.intervals[0].publication_lag_possible,true);
 const zero=run([u(.5)],[q(0,10),q(1,10)]);assert.equal(zero.windows[0].api.equivalent_100_percent,null);assert.equal(zero.windows[0].zero_change_tokens,100);
 const noLocal=run([u(1.5)],[q(0,10),q(1,11),q(2,12)]);assert.equal(noLocal.windows[0].percent_points,1);assert.ok(noLocal.boundaries.some(b=>b.reason==='positive_change_without_local_records'));
});
test('E unknown regression quarantines recovery instead of adding 39 to 41 as 2pp',()=>{
 const value=run([u(.5),u(1.5),u(2.5)],[q(0,40),q(1,39),q(2,41),q(3,42)]);
 assert.equal(value.windows[0].percent_points,1);assert.deepEqual(value.intervals[0].records.map(r=>r.id),[u(2.5).id]);
 assert.equal(run([u(.5),u(1.5)],[q(0,40),q(1,39),q(2,41)]).windows.length,0);
 assert.deepEqual(value.boundaries.map(b=>b.reason),['unknown_percent_decrease','recovery_quarantine']);
});
test('E jitter has a fixed bound, slow drift creates a new epoch and raw deadlines survive',()=>{
 const value=run([u(.5),u(1.5)],[q(0,10),q(1,11,{resets_at:reset+1}),q(2,12)]);
 assert.equal(value.windows[0].percent_points,2);assert.equal(value.windows.length,1);assert.deepEqual(value.intervals[0].points.map(p=>p.resets_at),[reset,reset+1,reset]);
 const creep=run([u(.5),u(1.5),u(2.5),u(3.5)],[q(0,10),q(1,11,{resets_at:reset+1}),q(2,12,{resets_at:reset+2}),q(3,13,{resets_at:reset+3}),q(4,14,{resets_at:reset+4})]);
 assert.equal(creep.windows.length,2);assert.ok(creep.windows.every(w=>w.reset_max-w.reset_min<=1));assert.equal(creep.boundaries.filter(b=>b.reason==='window_or_policy_boundary').length,2);
 const renewal=run([u(.5),u(1.5),u(2.5)],[q(0,50),q(1,51),q(2,0,{resets_at:Math.floor(Date.parse(time(2))/1000)+10080*60}),q(3,1,{resets_at:Math.floor(Date.parse(time(2))/1000)+10080*60})]);assert.equal(renewal.windows.length,2);assert.ok(renewal.windows.every(w=>w.percent_points===1));
});
test('E drift beyond tolerance does not prove a reset or clear rollback quarantine',()=>{
 const value=run([u(.5),u(1.5)],[q(0,40),q(1,39,{resets_at:reset+2}),q(2,41,{resets_at:reset+2})]);
 assert.equal(value.windows.length,0);assert.equal(value.boundaries[0].reset_evidence,null);
 const declared=run([u(.5),u(1.5)],[q(0,40),q(1,0,{resets_at:reset+2}),q(2,1,{resets_at:reset+2})],{reset_events:[{timestamp:time(1),kind:'full_reset',source:'user_declaration'}]});
 assert.equal(declared.windows[0].percent_points,1);assert.equal(declared.boundaries[0].reset_evidence,'declared_full_reset:user_declaration');
});
test('E account A B A, category disappearance, duration and conflicts are barriers with full raw evidence',()=>{
 const rows=[u(.5),u(1.5),u(2.5)];
 assert.equal(run(rows,[q(0,10),q(1,20,{},'B'),q(2,30)]).windows.length,0);
 for(const extra of [{limit_id:'other'},{slot:'secondary'},{window_duration_mins:14400}])assert.equal(run(rows,[q(0,10),q(1,20,extra),q(2,30)]).windows.length,0);
 const qs=[q(0,10),q(1,11),q(1,12),q(2,13),q(3,14)],value=run(rows,qs);
 assert.equal(value.windows[0].percent_points,1);assert.equal(value.observed_points.length,5);assert.ok(qs.every(q=>value.observed_points.some(p=>p.id===q.id)));
});
test('E gaps, inconsistent usage and saturation exclude matching numerator and denominator only',()=>{
 const qs=[q(0,10),q(1,11),q(2,12),q(3,13)],rows=[u(.5),u(1.5),u(2.5)];
 const broken=run(rows.map((r,i)=>i===1?{...r,data_quality:'inconsistent'}:r),qs);assert.equal(broken.windows[0].percent_points,2);assert.equal(broken.windows[0].total_tokens,200);assert.ok(broken.boundaries.some(b=>b.reason==='inconsistent_usage'));
 const gap=run(rows,qs,{gaps:[{from:time(1.2),to:time(1.8),reason:'test-gap'}]});assert.equal(gap.windows[0].percent_points,2);assert.equal(gap.windows[0].total_tokens,200);
 const sparse=run([u(20)],[q(0,10),q(40,11)]);assert.equal(sparse.windows.length,0);
 const capped=run(rows,[q(0,95),q(1,96),q(2,100),q(3,100)]);assert.equal(capped.windows[0].percent_points,1);assert.equal(capped.windows[0].total_tokens,100);assert.ok(capped.boundaries.some(b=>b.reason==='saturated_endpoint'));
});
test('E official allowed blocked allowed transitions reject both sides and recovery can resume',()=>{
 const status=(minute:number,used:number,allowed:boolean|null,spend:boolean|null=null)=>{const quota=q(minute,used);quota.context=structuredClone(quota.context);quota.context!.availability.ordinary_usage_allowed=allowed;quota.context!.availability.ordinary_usage_status=allowed===null?'unknown':allowed?'allowed':'blocked';quota.context!.availability.spend_control_reached=spend;return quota;};
 for(const blocked of [status(1,11,false),status(1,11,true,true)]){
  const value=run([u(.5),u(1.5),u(2.5)],[status(0,10,true),blocked,status(2,12,true),status(3,13,true)]);
  assert.equal(value.windows[0].percent_points,1);assert.equal(value.windows[0].total_tokens,100);assert.equal(value.boundaries.filter(b=>b.reason==='official_usage_blocked').length,2);assert.ok(value.intervals[0].points.every(p=>p.ordinary_usage_allowed===true));
 }
 assert.equal(run([u(.5)],[status(0,10,null),status(1,11,null)]).windows[0].percent_points,1);
});
test('E channel exclusion is whole-edge and partial attribution is an assumption',()=>{
 const qs=[q(0,10),q(1,11),q(2,12),q(3,13)],rows=[u(.5),u(1.5),u(2.5)];
 for(const kind of ['api_key','purchased_credits','free_auto_review'] as const){const value=run(rows.map((r,i)=>i===1?{...r,consumption_channel:{kind,source:'source_event'}}:r),qs);assert.equal(value.windows[0].total_tokens,200);assert.equal(value.windows[0].percent_points,2);}
 const scope=qs[0].context!.scope,partial={scope,limit_id:'codex',slot:'primary',window_duration_mins:10080,resets_at:reset,source:'source_event' as const};
 const assumed=run([u(.5,100,{quota_attribution:partial})],qs.slice(0,2));assert.equal(assumed.windows[0].machine_matched_records,0);assert.equal(assumed.windows[0].assumed_records,1);
 const verified={...partial,scope:{...scope,status:'verified' as const,workspace_ref:'W',billing_source:'included'}};
 assert.equal(run([u(.5,100,{quota_attribution:verified})],qs.slice(0,2)).windows[0].machine_matched_records,0);
 const matched=qs.slice(0,2).map(q=>({...q,context:{...q.context!,scope:verified.scope}}));
 assert.equal(run([u(.5,100,{quota_attribution:verified})],matched).windows[0].machine_matched_records,1);
});
test('E partial prices disclose two independent coverages without scaling up missing usage',()=>{
 const rows=[u(.3),u(.7,100,{model:'other'})],qs=[q(0,10),q(1,12)];
 const value=run(rows,qs);assert.equal(value.windows[0].api.coverage,'known_partial');assert.equal(value.windows[0].api.token_coverage,.5);assert.equal(value.windows[0].api.equivalent_100_percent,.01);
 const other={...api,id:'api-other',model:'other',rates:{...api.rates,input:4}};
 const different=conditionalCapacity(rows,qs,[...rules,other],range).windows[0];assert.equal(different.api.token_coverage,1);assert.equal(different.credits.token_coverage,.5);assert.ok(Math.abs(different.api.known_amount-.0006)<1e-12);assert.equal(different.credits.known_amount,.005);
});
test('E fixed version revalues model/cache/output variants with the same API and credit date',()=>{
 const row=u(.5,100,{cached_input_tokens:50,uncached_input_tokens:30,cache_write_input_tokens:20,output_tokens:10,total_tokens:110});
 const value=run([row],[q(0,10),q(1,11)]),record=value.intervals[0].records[0];
 assert.equal(record.api_usd,(30*2+50*.2+20*2.5+10*10)/1e6);assert.equal(record.credits,(30*50+50*5+20*50+10*250)/1e6);
 const successor={...api,id:'next',supersedes:api.id,effective_from:'2026-10-07T00:00:00Z',rates:{...api.rates,input:4}};
 const old=conditionalCapacity([u(.5)],[q(0,10),q(1,11)],[...rules,successor],range,{prices_at:'2026-10-06T00:00:00.000Z'}),next=conditionalCapacity([u(.5)],[q(0,10),q(1,11)],[...rules,successor],range);
 assert.equal(old.windows[0].api.known_amount,.0002);assert.equal(next.windows[0].api.known_amount,.0004);assert.equal(old.price_basis.at,'2026-10-06T00:00:00.000Z');assert.ok(old.reference);assert.equal(old.reference!.independent_evidence,false);
});
test('E day/epoch uses ratio of sums, isolates policy stages, and never guesses Pro tier',()=>{
 const qs=[q(0,10),q(1,11),q(1440,11),q(1441,20)],rows=[u(.5,1e6),u(1440.5,1e6)];
 const value=run(rows,qs),w=value.windows[0];assert.equal(w.percent_points,10);assert.equal(w.api.equivalent_100_percent,40);assert.equal(value.days.reduce((n,d)=>n+d.windows[0].api.known_amount,0),w.api.known_amount);
 const split=run([u(.5),u(1.5),u(2.5)],[q(0,10,{raw_json:'{"planType":"pro"}'}),q(1,11,{raw_json:'{"planType":"pro"}'}),q(2,12,{raw_json:'{"planType":"pro"}'}),q(3,13,{raw_json:'{"planType":"pro"}'})],{policy_boundaries:[{timestamp:time(1.5),stage:'known-new-policy',plan_tier:null,source:'test-policy'}]});
 assert.equal(split.windows.length,2);assert.ok(split.windows.every(w=>w.policy.plan_tier===null));assert.equal(split.windows[1].policy.stage,'known-new-policy');
});
test('E simultaneous windows require direct matching and capacities remain separate',()=>{
 const primary=[q(0,10),q(1,11)],secondary=[q(0,20,{slot:'secondary',window_duration_mins:1440}),q(1,21,{slot:'secondary',window_duration_mins:1440})],qs=[...primary,...secondary];
 assert.equal(run([u(.5)],qs).windows.length,0);
 const a={scope:{...primary[0].context!.scope,status:'verified' as const,workspace_ref:'W',billing_source:'included'},limit_id:'codex',slot:'primary',window_duration_mins:10080,resets_at:reset,source:'source_event' as const};
 const value=run([u(.5,100,{quota_attribution:a})],qs);assert.equal(value.windows.length,1);assert.equal(value.windows[0].slot,'primary');
});
test('E daily display separates raw observations, partial equivalent and reference units, preserves protections',()=>{
 const rows=[u(.3),u(.7,100,{model:'other'})],qs=[q(0,10),q(1,12)],value=dailyReport(rows,qs,rules,range,time(10));
 assert.ok(value.plan_cycles.every(p=>p.estimated_tokens===null));assert.ok(Object.values(value.models).every(m=>m.plan_percent_points===null));assert.equal(value.observation[0].percent_points,2);
 const before=JSON.stringify(value);
 for(const width of [40,80,180]){const text=format(value,{command:'report',width,timezone:'UTC'});assert.ok(text.split('\n').every(line=>cellWidth(line)<=width));if(width===180){assert.match(text,/已知部分/);assert.match(text,/配对有效 2/);assert.match(text,/参考单位/);assert.match(text,/不是条件容量分母/);}}
 const detail=format(value,{command:'report',width:180,timezone:'UTC',details:true});assert.match(detail,/固定分子/);assert.match(detail,/价格目录 SHA/);assert.equal(JSON.stringify(value),before);
});
test('E immutable prediction command freezes inputs and refuses training leakage or changed prices',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cux-e-prediction-')),script=fileURLToPath(new URL('../../bin/conditional-prediction.mjs',import.meta.url));
 try{
  const now=Date.now(),iso=(seconds:number)=>new Date(now+seconds*1000).toISOString(),r={from:iso(-180),to_exclusive:iso(180),timezone:'UTC'},deadline='2099-01-01T00:00:00.000Z';
  const quota=(seconds:number,percent:number)=>({...q(0,percent),timestamp:iso(seconds),resets_at:Math.floor(now/1000)+6*86400}),use=(seconds:number)=>({...u(.5),timestamp:iso(seconds)});
  const training=conditionalCapacity([use(-90)],[quota(-120,10),quota(-60,11)],rules,r),future=conditionalCapacity([use(90)],[quota(60,11),quota(120,12)],rules,r),input=join(dir,'training.json'),next=join(dir,'future.json'),reg=join(dir,'registered.json'),result=join(dir,'result.json');
  writeFileSync(input,JSON.stringify(training));writeFileSync(next,JSON.stringify(future));
  const register=[script,'register','--input',input,'--epoch',training.windows[0].id,'--cutoff',iso(-60),'--deadline',deadline,'--out',reg];
  execFileSync(process.execPath,register);assert.equal(spawnSync(process.execPath,register).status,1);
  execFileSync(process.execPath,[script,'validate','--input',next,'--registration',reg,'--out',result]);
  const evaluated=JSON.parse(readFileSync(result,'utf8'));assert.equal(evaluated.predicted_percent_points,1);assert.equal(evaluated.error_percent_points,0);assert.equal(evaluated.refit_executed,false);
  assert.equal(spawnSync(process.execPath,[script,'validate','--input',input,'--registration',reg,'--out',join(dir,'leak.json')]).status,1);
  future.price_basis.at='2026-10-08T00:00:00Z';writeFileSync(next,JSON.stringify(future));
  assert.equal(spawnSync(process.execPath,[script,'validate','--input',next,'--registration',reg,'--out',join(dir,'price-change.json')]).status,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
