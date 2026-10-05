import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {normalizeQuota} from '../src/quota.js';
import {quotaContext,identityRef} from '../src/quota-policy.js';
import {capacityView} from '../src/capacity-policy.js';
import {windowDiagnostics,resetDiagnostics,accountDailyDiagnostics,runtimeDailyDiagnostics,capacityDiagnostics,storageSnapshot,type DiagnosticObservation} from '../src/capacity-diagnostics.js';
import {initialState,parseLine} from '../src/parser.js';
import {Ledger} from '../src/store.js';
import {format,cellWidth} from '../src/display.js';
import type {Usage,Quota,Config} from '../src/types.js';
const at='2026-10-03T01:10:00.000Z',reset=Date.parse('2026-10-03T05:00:00.000Z')/1000;
const config:Config={codex_home:'/unused',timezone:'UTC',poll_seconds:60,codex_binary:'/unused',estimator:{weight_basis:'verified',bucket_models:{}}};
function quota(timestamp:string,usedPercent:number,account='private-A'){
 const q=normalizeQuota({accountId:account,ordinaryUsageAllowed:true,rateLimits:{limitId:'codex',primary:{usedPercent,windowDurationMins:300,resetsAt:reset}}},timestamp,'app_server')[0];
 q.context!.scope={...q.context!.scope,status:'verified',workspace_ref:identityRef('fixture-workspace'),billing_source:'fixture-included'};return q;
}
function usage(timestamp:string,tokens=100):Usage{return parseLine(JSON.stringify({timestamp,type:'token_usage_record',payload:{response_id:timestamp,model:'fixture',service_tier:'default',usage:{input_tokens:tokens-10,cached_input_tokens:20,output_tokens:10,total_tokens:tokens}}}),initialState()).usage[0];}
function attach(u:Usage,q:Quota):Usage{return {...u,quota_attribution:{scope:quotaContext(q).scope,limit_id:q.limit_id,slot:q.slot,window_duration_mins:q.window_duration_mins!,resets_at:q.resets_at!,source:'source_event'}};}
const first=quota('2026-10-03T01:00:00.000Z',10),last=quota('2026-10-03T01:05:00.000Z',15);
function observation(id:number,timestamp:string,kind:string,raw:unknown={},status='ok'):DiagnosticObservation{return {id,timestamp,source:kind==='local_sync'?'monitor':'app_server',kind,status,raw_json:JSON.stringify(raw)};}
test('D1 research eligibility does not release capacity and repeatable inputs stay unchanged',()=>{
 const rows=[attach(usage('2026-10-03T01:03:00.000Z'),first)],input=JSON.stringify({qs:[first,last],rows});
 const a=windowDiagnostics([last,first],rows,at,900);assert.equal(a[0].eligible_span_count,1);assert.equal(a[0].matched_tokens,100);assert.equal(a[0].capacity_release,'not_authorized');assert.equal(a[0].coverage.complete_cycle_verified,false);
 assert.equal(a[0].spans[0].from_snapshot_id,first.id);assert.deepEqual(a[0].point_evidence[1].snapshot_ids,[last.id]);assert.equal(a[0].local_composition.combinations[0].total_tokens,100);
 assert.deepEqual(a,windowDiagnostics([first,last],rows,at,900));assert.equal(JSON.stringify({qs:[first,last],rows}),input);
 for(const experimental of [false,true]){const view=capacityView({estimated_capacity:null,diagnostics:a},experimental);assert.notEqual(view.status,'verified');assert.equal(view.estimated_capacity,null);}
});
test('D1 exact deadlines, accounts, workspaces, billing and sources are never merged',()=>{
 const oneSecond={...last,id:'jitter',resets_at:reset+1};const other=quota(last.timestamp,15,'private-B');
 for(const otherQ of [oneSecond,other,{...last,id:'rollout',source:'rollout'}]){const a=windowDiagnostics([first,otherQ],[],at,900);assert.equal(a.length,2);assert.ok(a.every(w=>w.eligible_span_count===0));}
 for(const dimension of ['workspace_ref','billing_source'] as const){const otherQ=structuredClone(last);otherQ.context!.scope[dimension]='other';assert.equal(windowDiagnostics([first,otherQ],[],at,900).length,2);}
 const jitter=resetDiagnostics([first,oneSecond,other]);assert.equal(jitter.length,1);assert.equal(jitter[0].kind,'deadline_jitter_candidate');assert.equal(jitter[0].cycles_merged,false);
 const resetQ={...last,id:'reset',used_percent:0,resets_at:reset+86400};const change=resetDiagnostics([first,resetQ]);assert.equal(change[0].kind,'reset_or_window_change_candidate');assert.equal(change[0].cause,'unverified');assert.equal(change[0].natural_reset_verified,false);
 const mismatch=windowDiagnostics([first,last],[attach(usage('2026-10-03T01:03:00.000Z'),other)],at,900)[0];assert.equal(mismatch.matched_tokens,0);assert.ok(mismatch.spans[0].reasons.includes('different_account_or_window_attribution'));
});
test('D1 unknown speed/scope, clipped points, decreases, conflicts, gaps and blocked permission reject',()=>{
 const u=attach(usage('2026-10-03T01:03:00.000Z'),first);
 const cases:[Quota[],Usage[],string][]=[
  [[first,last],[{...u,service_tier:'unknown'}],'unknown_speed'],
  [[first,last],[{...u,quota_attribution:undefined}],'unverified_local_account_window_attribution'],
  [[{...first,used_percent:0},{...last,used_percent:5}],[u],'clipped_endpoint'],
  [[{...first,used_percent:95},{...last,used_percent:100}],[u],'clipped_endpoint'],
  [[{...first,used_percent:15},{...last,used_percent:10}],[u],'percent_decrease'],
  [[first,last,{...last,id:'contradiction',used_percent:16}],[u],'conflicting_snapshots'],
  [[first,{...last,timestamp:'2026-10-03T01:30:00.000Z'}],[u],'observation_gap'],
 ];
 for(const [qs,rows,reason] of cases){const d=windowDiagnostics(qs,rows,'2026-10-03T02:00:00.000Z',900)[0];assert.equal(d.eligible_span_count,0,reason);assert.ok(d.spans.some(s=>s.reasons.includes(reason)),reason);}
 const partial=structuredClone(first);partial.context!.scope.status='partial';partial.context!.scope.workspace_ref=null;const partialLast={...partial,id:'partial-last',timestamp:last.timestamp,used_percent:15};const d=windowDiagnostics([partial,partialLast],[u],at,900)[0];assert.equal(d.evidence_level,'observed_account_only');assert.ok(d.spans[0].reasons.includes('unverified_workspace_billing_identity'));
 const blocked=structuredClone(last);blocked.context!.availability.ordinary_usage_allowed=false;assert.ok(windowDiagnostics([first,blocked],[u],at,900)[0].spans[0].reasons.includes('official_permission_change'));
 const gap=windowDiagnostics([first,last],[u],at,900,[{from:'2026-10-03T01:01:00.000Z',to:'2026-10-03T01:02:00.000Z',seconds:60,kind:'reported_observation_gap'}])[0];assert.equal(gap.eligible_span_count,0);assert.equal(gap.gaps.length,1);
});
test('D1 bucket revisions never become an instantaneous account residual or zero unknown',()=>{
 const d=accountDailyDiagnostics([{timestamp:first.timestamp,raw_json:JSON.stringify({summary:{lifetimeTokens:10},dailyUsageBuckets:[{startDate:'2026-10-02',tokens:10}],threadUsage:null})},{timestamp:last.timestamp,raw_json:JSON.stringify({summary:{lifetimeTokens:10000},dailyUsageBuckets:[{startDate:'2026-10-02',tokens:10000}],threadUsage:null})}]);
 assert.equal(d.revised_days.length,1);assert.equal(d.timezone,null);assert.equal(d.local_official_difference,null);assert.equal(d.instantaneous_external_usage_detected,null);
 const empty=accountDailyDiagnostics([]);assert.equal(empty.observed_to,null);assert.equal(empty.latest_bucket_date,null);assert.ok(empty.reasons.includes('official_summary_latency_unbounded'));
 assert.equal(runtimeDailyDiagnostics([],'UTC',900).intervals[0].max_interval_seconds,null);
 const daily=runtimeDailyDiagnostics([observation(1,first.timestamp,'local_sync'),observation(2,last.timestamp,'local_sync',{},'error'),observation(3,'2026-10-03T02:00:00.000Z','local_sync')],'UTC',900);
 assert.equal(daily.days[0].local_ok,2);assert.equal(daily.days[0].local_error,1);assert.equal(daily.intervals[0].gaps.length,1);
});
test('D1 indexed derivation is read-only, bounded and gives daily collection counts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cux-D1-')),db=new Ledger(join(dir,'usage.db'));
 try{
  db.insertQuota(first);db.insertQuota(last);db.insertUsage(attach(usage('2026-10-03T01:03:00.000Z'),first));
  db.observe('monitor','local_sync','ok',{},first.timestamp);db.observe('app_server','account/rateLimits/read','error',{},last.timestamp);db.insertAccount(first.timestamp,{dailyUsageBuckets:null});
  db.db.exec('PRAGMA query_only=ON');const before=db.db.prepare('SELECT * FROM quota_snapshots ORDER BY id').all();const d=capacityDiagnostics(db,[last],at,config);
  assert.deepEqual(d,capacityDiagnostics(db,[last],at,config));assert.equal(d.runtime_daily.days[0].local_ok,1);assert.equal(d.runtime_daily.days[0].quota_error,1);assert.equal(d.windows[0].matched_tokens,100);assert.equal(d.storage_snapshot,null);assert.deepEqual(db.db.prepare('SELECT * FROM quota_snapshots ORDER BY id').all(),before);
  const clipped=capacityDiagnostics(db,[{...last,window_duration_mins:30*1440}],at,config);assert.equal(clipped.query.cycle_query_clipped,true);assert.ok(clipped.windows.every(w=>w.eligible_span_count===0));
  const missing=storageSnapshot(join(dir,'missing'),at);assert.ok(missing.files.every(f=>f.bytes===null));assert.equal(missing.daily_growth_bytes,null);
  const view=[{limit_id:'codex',estimated_capacity:null,reason:'unverified_account_window_attribution',diagnostics:d}];
  for(const width of [40,80]){const text=format(view,{command:'estimate',details:true,width,now:Date.parse(at),timezone:'UTC'});assert.match(text,/资格与覆盖/);assert.match(text,/官方与本地差额/);assert.match(text,/未知/);assert.doesNotMatch(text,/private-A/);assert.ok(text.split('\n').every(line=>cellWidth(line)<=width));}
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('D1 CLI JSON and details attach diagnostics while default/experimental capacity remains unknown',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cux-D1-cli-')),now=new Date().toISOString(),q=quota(now,5);q.resets_at=Math.floor(Date.now()/1000)+3600;q.context!.scope.status='partial';q.context!.scope.workspace_ref=null;
 const db=new Ledger(join(dir,'usage.db'));db.insertQuota(q);db.close();
 try{
  for(const experimental of [false,true]){const run=spawnSync(process.execPath,['dist/src/cli.js','estimate','--json','--data-home',dir,...(experimental?['--experimental-empirical']:[])],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);const v=JSON.parse(run.stdout);assert.ok(v[0].diagnostics);assert.equal(v[0].estimated_capacity,null);assert.notEqual(v[0].status,'verified');assert.equal(v[0].diagnostics.account_daily.local_official_difference,null);}
  const run=spawnSync(process.execPath,['dist/src/cli.js','estimate','--details','--data-home',dir],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/资格与覆盖/);assert.match(run.stdout,/每日采集/);assert.equal(readFileSync(join(dir,'config.json'),'utf8').includes('private-A'),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
