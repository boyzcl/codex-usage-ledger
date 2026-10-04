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
import {format} from '../src/display.js';
import type {Usage,Quota,Config} from '../src/types.js';
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
