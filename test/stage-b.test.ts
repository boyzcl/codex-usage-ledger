import {backup} from '../src/sqlite.js';
import {repairPreview} from '../src/repair.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/store.js';
import {normalizeQuota,legacyQuotaId} from '../src/quota.js';
import {quotaContext,quotaCycleKey,identityRef,officialSnapshot} from '../src/quota-policy.js';
import {empiricalPlans,dailyReport} from '../src/daily.js';
import {quotaEstimates} from '../src/estimator.js';
import {workloadRanges,workloadViews,currentWorkload} from '../src/workload.js';
import {initialState,parseLine} from '../src/parser.js';
import {collectAccount} from '../src/app-server.js';
import {exportData} from '../src/export.js';
import {format,cellWidth} from '../src/display.js';
import type {Usage,Quota,Config,PriceRule} from '../src/types.js';
const from='2026-10-03T00:00:00.000Z',end='2026-10-03T05:00:00.000Z',reset=Date.parse(end)/1000;
const range={from,to_exclusive:end,timezone:'UTC'};
const config:Config={codex_home:'/unused',timezone:'UTC',poll_seconds:60,codex_binary:'/unused',estimator:{weight_basis:'verified',bucket_models:{codex:['a'],other:['b']}}};
function q(timestamp:string,percent:number,account:string|null='account-A',limit='codex'){
 const quota=normalizeQuota({accountId:account,ordinaryUsageAllowed:true,rateLimits:{limitId:limit,primary:{usedPercent:percent,windowDurationMins:300,resetsAt:reset}}},timestamp,'app_server')[0];if(account)quota.context!.scope={...quota.context!.scope,status:'verified',workspace_ref:identityRef('synthetic-workspace'),billing_source:'synthetic-included'};return quota;
}
function usage(timestamp:string,tokens:number,model='a'):Usage {return {...parseLine(JSON.stringify({timestamp,type:'token_usage_record',payload:{response_id:timestamp+model,usage:{input_tokens:tokens,output_tokens:0,total_tokens:tokens}}}),initialState()).usage[0],model,allowance_weight:tokens,api_equivalent_usd:tokens/1e6};}
function attach(row:Usage,quota:Quota):Usage {return {...row,quota_attribution:{scope:quotaContext(quota).scope,limit_id:quota.limit_id,slot:quota.slot,window_duration_mins:quota.window_duration_mins!,resets_at:quota.resets_at!,source:'source_event'}};}
function temp(){const dir=mkdtempSync(join(tmpdir(),'cux-B-')),path=join(dir,'usage.db'),db=new Ledger(path);return {dir,path,db,close(){this.db.close();rmSync(dir,{recursive:true,force:true});}};}
test('B isolates same-cycle accounts, workspaces, billing and missing identity',()=>{
 const first=q('2026-10-03T01:00:00.000Z',10),last=q('2026-10-03T02:00:00.000Z',20,'account-B');
 const rows=[usage('2026-10-03T01:30:00.000Z',400)];
 assert.notEqual(quotaCycleKey(first),quotaCycleKey(last));assert.equal(empiricalPlans(rows,[first,last],range).length,2);
 assert.notEqual(q('2026-10-03T01:00:00.000Z',10,'account-A').id,q('2026-10-03T01:00:00.000Z',10,'account-B').id);
 const unknown=[q(first.timestamp,10,null),q(last.timestamp,20,null)];assert.equal(empiricalPlans(rows,unknown,range).length,2);assert.ok(empiricalPlans(rows,unknown,range).every(p=>p.estimated_tokens===null&&p.attribution_reason==='unknown_account_identity'));
 for(const dimension of ['workspace_ref','billing_source'] as const){const other=structuredClone(first);other.context!.scope[dimension]='different';assert.notEqual(quotaCycleKey(first),quotaCycleKey(other));assert.ok(empiricalPlans([attach(rows[0],first)],[other,{...other,id:'last',timestamp:last.timestamp,used_percent:20}],range).every(p=>p.matched_tokens===0));}
});
test('B does not let two windows claim all 400 local tokens; direct facts match only their window',()=>{
 const qs=[q('2026-10-03T01:00:00.000Z',10),q('2026-10-03T02:00:00.000Z',20)];
 const other=qs.map(x=>({...x,id:x.id+'other',limit_id:'other'}));const rows=[usage('2026-10-03T01:30:00.000Z',400)];
 const unknown=empiricalPlans(rows,[...qs,...other],range);assert.equal(unknown.length,2);assert.ok(unknown.every(p=>p.matched_tokens===0&&p.unallocated_tokens===400&&p.estimated_tokens===null));
 const attributed=empiricalPlans([attach(rows[0],qs[0])],[...qs,...other],range);assert.equal(attributed.find(p=>p.limit_id==='codex')!.matched_tokens,400);assert.equal(attributed.find(p=>p.limit_id==='other')!.matched_tokens,0);
 const partial=empiricalPlans([attach(rows[0],qs[0]),usage('2026-10-03T01:40:00.000Z',200)],qs,range)[0];assert.equal(partial.estimated_tokens,null);assert.equal(partial.attribution_reason,'partial_local_account_window_attribution');
 const daily=dailyReport(rows,[...qs,...other],[],range,end,{experimentalEmpirical:true});assert.ok(daily.plan_cycles.every(p=>p.estimated_tokens===null&&p.strict_reason));
 const caps=quotaEstimates([...qs,...other],rows,config,[],end);assert.ok(caps.every(p=>p.estimated_capacity===null&&p.attribution_reason==='unverified_local_account_window_attribution'));
});
test('B official permission and spend control survive percentage contradictions, missing fields and no windows',async()=>{
 const t=temp();try{
  for(const [allowed,percent,spend] of [[true,100,true],[false,20,false],[null,0,null]] as const){const raw={accountId:'PRIVATE_ACCOUNT',ordinaryUsageAllowed:allowed,rateLimits:{limitId:'codex',spendControlReached:spend,primary:{usedPercent:percent,windowDurationMins:300,resetsAt:reset}}};const c=quotaContext(normalizeQuota(raw,from,'app_server')[0]);assert.equal(c.availability.ordinary_usage_allowed,allowed);assert.equal(c.availability.spend_control_reached,spend);assert.equal(c.scope.account_ref,identityRef('PRIVATE_ACCOUNT'));}
  const client={async start(){},async request(){return {accountId:'PRIVATE_ACCOUNT',ordinaryUsageAllowed:false,rateLimits:{primary:null,secondary:null}};},close(){}};
  await collectAccount(t.db,client,['account/rateLimits/read']);assert.equal(t.db.latestQuota().length,0);
  const snapshot=t.db.get<ReturnType<typeof officialSnapshot>>('official_availability')!;assert.equal(snapshot.availability.ordinary_usage_status,'blocked');
  const human=format({official_availability:snapshot,windows:[]},{command:'quota'});assert.match(human,/官方不允许/);assert.match(human,/不保证恢复/);assert.doesNotMatch(human,/PRIVATE_ACCOUNT/);
 }finally{t.close();}
});
test('B additive migration recovers only exact same-response facts, preserves raw/history and is repeatable',()=>{
 const t=temp();try{
  const raw={accountId:'PRIVATE_ACCOUNT',ordinaryUsageAllowed:false,rateLimits:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:reset}}};const normalized=normalizeQuota(raw,from,'app_server')[0];const old={...normalized,id:legacyQuotaId(normalized)};delete old.context;t.db.insertQuota(old);
  const missing={...old,id:'missing',timestamp:'2026-10-02T00:00:00.000Z'};t.db.insertQuota(missing);
  t.db.observe('app_server','account/rateLimits/read','ok',{response:raw},from);t.db.set('latest_estimates',[{estimated_capacity:99}]);t.db.db.prepare('DELETE FROM settings WHERE key=?').run('quota_context_version');
  const before=t.db.db.prepare('SELECT * FROM quota_snapshots ORDER BY id').all();t.db.close();
  const reopened=t.db=new Ledger(t.path);assert.deepEqual(reopened.db.prepare('SELECT * FROM quota_snapshots ORDER BY id').all(),before);assert.equal(reopened.officialQuotas().find(v=>v.id===old.id)!.context!.scope.account_ref,identityRef('PRIVATE_ACCOUNT'));assert.equal(reopened.officialQuotas().find(v=>v.id==='missing')!.context!.scope.account_ref,null);assert.equal(reopened.get<ReturnType<typeof officialSnapshot>>('official_availability')!.availability.ordinary_usage_status,'blocked');assert.ok(reopened.db.prepare('SELECT * FROM capacity_estimate_history').all().some(x=>String(x.raw_json).includes('99')));
  reopened.insertQuota(normalized);assert.equal(reopened.quotas().length,2);
  const contexts=reopened.db.prepare('SELECT * FROM quota_context ORDER BY id').all();reopened.close();const again=t.db=new Ledger(t.path);assert.deepEqual(again.db.prepare('SELECT * FROM quota_context ORDER BY id').all(),contexts);again.close();t.db=new Ledger(t.path);
 }finally{t.close();}
});
test('B short cycle reads union of 7/30-day history, independent models/speeds/cache and exact boundaries',()=>{
 const at='2026-10-04T05:00:00.000Z';const latest=[{...q(from,10),resets_at:Date.parse('2026-10-04T10:00:00Z')/1000}];const ranges=workloadRanges(latest,at,'Asia/Shanghai');assert.equal(ranges.query.from,'2026-09-04T05:00:00.000Z');
 const rows=[usage('2026-09-04T04:59:59.999Z',1),{...usage('2026-09-04T05:00:00.000Z',100,'older'),service_tier:'fast',cached_input_tokens:50},usage('2026-09-27T04:59:59.999Z',200,'middle'),{...usage('2026-09-27T05:00:00.000Z',300,'recent'),cached_input_tokens:100},usage(at,400),usage('2026-10-04T05:00:00.001Z',500)];
 const t=temp();try{for(const u of rows)t.db.insertUsage(u);const present={...latest[0],timestamp:at,id:'at-boundary'},future={...present,timestamp:'2026-10-04T05:00:00.001Z',id:'future'};t.db.insertQuota(present);t.db.insertQuota(future);assert.deepEqual(t.db.latestQuota(at).map(q=>q.id),['at-boundary']);assert.equal(quotaEstimates([future],rows,config,[],at).length,0);const data=currentWorkload(t.db,latest,at,'Asia/Shanghai');assert.equal(data.rows.length,4);const view=workloadViews(data.rows,latest,at,'Asia/Shanghai');const seven=view.windows.find(w=>w.name==='last_7_days')!,thirty=view.windows.find(w=>w.name==='last_30_days')!;assert.equal(seven.totals.total_tokens,700);assert.equal(thirty.totals.total_tokens,1000);assert.equal(thirty.models.older.total_tokens,100);assert.equal(thirty.speeds.fast.cached_input_tokens,50);assert.equal(seven.totals.cached_input_tokens,100);assert.equal(seven.coverage.status,'partial_observed_history');assert.equal(seven.timezone,'Asia/Shanghai');assert.equal(view.windows.at(-1)!.totals.total_tokens,400);}finally{t.close();}
});
test('B quota/observation JSONL gives the same normalized scope and availability without private identity',async()=>{
 const t=temp();try{const raw={accountId:'PRIVATE_ACCOUNT',ordinaryUsageAllowed:false,rateLimits:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:reset}}};const quota=normalizeQuota(raw,from,'app_server')[0];t.db.insertQuota(quota);t.db.insertQuota(quota);assert.equal(t.db.quotas().length,1);t.db.observe('app_server','account/rateLimits/read','ok',{response:raw},from);
  for(const kind of ['quota','observations']){const path=join(t.dir,kind+'.jsonl');await exportData(t.db,kind,range,path);const text=readFileSync(path,'utf8');assert.doesNotMatch(text,/PRIVATE_ACCOUNT/);const lines=text.trim().split('\n').map(l=>JSON.parse(l));assert.equal(lines[0].schema_version,3);const context=kind==='quota'?lines[1].data.context:lines[1].data.official_snapshot;assert.equal(context.scope.account_ref,quota.context!.scope.account_ref);assert.equal(context.availability.ordinary_usage_allowed,false);}
 }finally{t.close();}
});

test('B ambiguous recovery has no first/last identity winner and never enriches rollout facts',()=>{
 const t=temp();try{
  const raw=(accountId:string)=>({accountId,ordinaryUsageAllowed:true,rateLimits:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:reset}}});
  const a=normalizeQuota(raw('PRIVATE_A'),from,'app_server')[0],old={...a,id:legacyQuotaId(a)};delete old.context;t.db.insertQuota(old);
  const log=normalizeQuota(raw('PRIVATE_A').rateLimits,from,'rollout')[0];t.db.insertQuota(log);
  t.db.observe('app_server','account/rateLimits/read','ok',{response:raw('PRIVATE_A')},from);t.db.observe('app_server','account/rateLimits/read','ok',{response:raw('PRIVATE_B')},from);t.db.db.prepare('DELETE FROM settings WHERE key=?').run('quota_context_version');t.db.close();t.db=new Ledger(t.path);
  const context=t.db.officialQuotas()[0].context!;assert.equal(context.scope.status,'mixed');assert.equal(context.scope.account_ref,null);assert.equal(context.availability.ordinary_usage_allowed,null);assert.equal(context.evidence!.origin,'ambiguous_observations');assert.equal(context.evidence!.observation_ids.length,2);assert.equal(context.evidence!.context_refs.length,2);assert.equal(t.db.get<ReturnType<typeof officialSnapshot>>('official_availability')!.scope.status,'mixed');assert.equal(t.db.quotas().find(q=>q.source==='rollout')!.context!.scope.status,'unknown');assert.equal(t.db.db.prepare('SELECT raw_json FROM quota_snapshots WHERE id=?').get(old.id)!.raw_json,old.raw_json);
 }finally{t.close();}
});

test('B repair rejects conflicting same-fact contexts atomically',{skip:typeof backup!=='function'?'requires sqlite.backup':false},async()=>{
 const t=temp();try{
  const home=join(t.dir,'source');mkdirSync(home);const captured=join(t.dir,'captured.db');const source=new Ledger(captured);
  const original=q(from,10),variant={...q(from,10,'account-B'),id:original.id};t.db.insertQuota(original);source.insertQuota(variant);source.close();
  await assert.rejects(repairPreview(t.path,home,join(t.dir,'failed'),'UTC',undefined,{path:captured,source_scan_started_at:null,baseline_captured_at:null,sync:{files:0,changed_files:0,added_records:0,malformed_or_oversized_lines:0,bytes_read:0,validation_bytes_read:0,validation_ms:0,deferred_files:0,synced_at:end}}),/repair_quota_context_conflict/);
  assert.equal(t.db.quotas().length,1);assert.equal(t.db.quotas()[0].context!.scope.account_ref,original.context!.scope.account_ref);assert.equal(t.db.get('ledger_repair_version'),null);
  const failed=new Ledger(join(t.dir,'failed','repaired.db'));assert.equal(failed.get('ledger_repair_version'),null);assert.equal(failed.quotas()[0].context!.scope.account_ref,original.context!.scope.account_ref);failed.close();
 }finally{t.close();}
});

test('B historical equivalents use proven same-category past cycles while current capacity stays exact-window',()=>{
 const at='2026-10-04T04:30:00.000Z',currentReset=Date.parse('2026-10-04T05:00:00.000Z')/1000;
 const qs=[1,2,3,4].map((hour,i)=>({...q(`2026-10-04T0${hour}:00:00.000Z`,10*(i+1)),resets_at:currentReset}));
 const current=[1,2,3].map(hour=>attach({...usage(`2026-10-04T0${hour}:30:00.000Z`,100),service_tier:'default'},qs[0]));
 const oldQuota=q('2026-10-03T02:00:00.000Z',20);
 const old=attach({...usage('2026-10-03T02:30:00.000Z',3000),service_tier:'default',cached_input_tokens:3000,uncached_input_tokens:0,allowance_weight:300,api_equivalent_usd:.0006},oldQuota);
 const rule:PriceRule={id:'mix-api',kind:'api',model:'a',processing_mode:'standard',effective_from:'2026-01-01T00:00:00.000Z',effective_to:null,context_min:0,context_max:null,rates:{input:1,cached_input:.2,cache_write:1,output:1},source_url:'https://example.com/synthetic',retrieved_at:at,basis:'synthetic'};
 const rules=[rule,{...rule,id:'mix-allowance',kind:'allowance' as const,rates:{input:1e6,cached_input:1e5,cache_write:1e6,output:1e6}}];
 const estimate=(extra:Usage[])=>quotaEstimates(qs,[...current,...extra],config,rules,at)[0];
 const result=estimate([old]);assert.equal(result.estimated_capacity,1000);assert.equal(result.attribution_reason,null);
 assert.equal((result.equivalents.cycle as any).equivalent_tokens,1000);
 for(const key of ['last_7_days','last_30_days','a_standard_observed_token_type_mix']){
  assert.equal((result.equivalents[key] as any).equivalent_tokens,5500,key);assert.equal(result.equivalent_reasons[key],null);
  assert.ok(Math.abs((result.equivalents[key] as any).equivalent_api_usd-.0015)<1e-12,key);
 }
 // Proven other identities/categories must not enter this mix; future and pre-30-day facts do not enter it either.
 for(const dimension of ['account_ref','workspace_ref','billing_source'] as const){const other=structuredClone(old);other.quota_attribution!.scope[dimension]='other';assert.equal((estimate([old,other]).equivalents.last_30_days as any).equivalent_tokens,5500,dimension);}
 for(const dimension of ['limit_id','slot','window_duration_mins'] as const){const other=structuredClone(old);if(dimension==='window_duration_mins')other.quota_attribution![dimension]=10080;else other.quota_attribution![dimension]='other';assert.equal((estimate([old,other]).equivalents.last_30_days as any).equivalent_tokens,5500,dimension);}
 const outside={...old,timestamp:'2026-09-01T02:30:00.000Z'},future={...old,timestamp:'2026-10-04T04:30:00.001Z'};
 assert.equal((estimate([old,outside,future]).equivalents.last_30_days as any).equivalent_tokens,5500);
 const eightDaysAgo=attach({...old,timestamp:'2026-09-26T02:30:00.000Z'}, {...oldQuota,resets_at:Date.parse('2026-09-26T05:00:00.000Z')/1000});
 assert.equal((estimate([eightDaysAgo]).equivalents.last_7_days as any).equivalent_tokens,1000);assert.equal((estimate([eightDaysAgo]).equivalents.last_30_days as any).equivalent_tokens,5500);
 for(const bad of [{...old,quota_attribution:undefined},{...old,allowance_weight:null},{...old,api_equivalent_usd:null},{...old,quota_attribution:{...old.quota_attribution!,resets_at:currentReset}}]){
  const invalid=estimate([bad]);assert.equal(invalid.estimated_capacity,1000);assert.equal((invalid.equivalents.cycle as any).equivalent_tokens,1000);
  assert.equal(invalid.equivalents.last_7_days,null);assert.equal(invalid.equivalents.last_30_days,null);assert.ok(invalid.equivalent_reasons.last_30_days);
 }
 const unmapped=estimate([{...old,quota_attribution:undefined}]);assert.equal(unmapped.equivalents.a_standard_observed_token_type_mix,null);assert.equal(unmapped.equivalent_reasons.a_standard_observed_token_type_mix,'partial_local_account_window_attribution');
 const incomplete=estimate([{...old,quota_attribution:{...old.quota_attribution!,limit_id:''}}]);assert.equal(incomplete.equivalents.last_30_days,null);assert.equal(incomplete.equivalent_reasons.last_30_days,'partial_local_account_window_attribution');
});

test('B ambiguous recovery replays both original contexts without new facts and preserves genuinely new evidence',()=>{
 const t=temp();try{
  const raw=(accountId:string,usedPercent=20)=>({accountId,ordinaryUsageAllowed:true,rateLimits:{limitId:'codex',primary:{usedPercent,windowDurationMins:300,resetsAt:reset}}});
  const a=normalizeQuota(raw('PRIVATE_A'),from,'app_server')[0],old={...a,id:legacyQuotaId(a)};delete old.context;t.db.insertQuota(old);
  for(const account of ['PRIVATE_A','PRIVATE_B'])t.db.observe('app_server','account/rateLimits/read','ok',{response:raw(account)},from);
  t.db.db.prepare('DELETE FROM settings WHERE key=?').run('quota_context_version');t.db.close();t.db=new Ledger(t.path);
  const facts=t.db.db.prepare('SELECT * FROM quota_snapshots').all(),contexts=t.db.db.prepare('SELECT * FROM quota_context').all();
  for(let i=0;i<2;i++)for(const account of ['PRIVATE_A','PRIVATE_B'])t.db.insertQuota(normalizeQuota(raw(account),from,'app_server')[0]);
  assert.deepEqual(t.db.db.prepare('SELECT * FROM quota_snapshots').all(),facts);assert.deepEqual(t.db.db.prepare('SELECT * FROM quota_context').all(),contexts);
  assert.equal(t.db.quotas()[0].context!.scope.status,'mixed');assert.equal(t.db.quotas()[0].context!.scope.account_ref,null);
  for(const next of [raw('PRIVATE_C'),raw('PRIVATE_A',21),{...raw('PRIVATE_A'),ordinaryUsageAllowed:false}])t.db.insertQuota(normalizeQuota(next,from,'app_server')[0]);
  assert.equal(t.db.quotas().length,4);assert.deepEqual(t.db.db.prepare('SELECT * FROM quota_context WHERE id=?').get(old.id),contexts[0]);
  t.db.close();t.db=new Ledger(t.path);assert.equal(t.db.quotas().length,4);assert.equal(t.db.quotas().find(q=>q.id===old.id)!.context!.scope.status,'mixed');
 }finally{t.close();}
});

test('B human daily report summarizes unknown-scope observations by date and bucket without capacity cycles',()=>{
 const qs=Array.from({length:100},(_,i)=>{const value=q(`2026-10-03T01:${String(Math.floor(i/2)).padStart(2,'0')}:00.000Z`,i%100,null);value.id+='-'+i;value.context!.scope={...value.context!.scope,status:'partial',workspace_ref:null,billing_source:null};if(i%2)value.slot='secondary';return value;});
 const report=dailyReport([],qs,[],range,end,{experimentalEmpirical:true});assert.equal(report.plan_cycles.length,100);
 const before=JSON.stringify(report);
 for(const width of [40,80,180])for(const details of [false,true]){
  const human=format(report,{command:'report',width,details,timezone:'UTC',now:Date.parse(end)});
  assert.doesNotMatch(human,/窗口 \d|区间分段|周期重置|原始变化/);assert.match(human,/观测摘要/);assert.match(human,/50 条/);
  assert.equal((human.match(/观测摘要/g)??[]).length,2);assert.ok(human.split('\n').every(line=>cellWidth(line)<=width));
 }
 assert.equal(JSON.stringify(report),before);assert.ok(report.plan_cycles.every(p=>p.estimated_tokens===null&&p.percent_points===null));
});
