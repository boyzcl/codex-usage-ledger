import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Schedule,acquireMonitorLock,sourceEventPath} from '../src/monitor.js';
import {Ledger} from '../src/store.js';
import {collectAccount} from '../src/app-server.js';
import {exportData} from '../src/export.js';
import {servicePlist} from '../src/service.js';
import {syncRollouts} from '../src/ingest.js';
const start=Date.parse('2026-10-03T10:00:00Z');
function temp(){const dir=mkdtempSync(join(tmpdir(),'cux-monitor-'));const db=new Ledger(join(dir,'usage.db'));return {dir,db,close(){db.close();rmSync(dir,{recursive:true,force:true});}};}

test('local activity never ties every file event to a remote request; active and idle cadence differ',()=>{
 const s=new Schedule(undefined);s.activity(start);s.localDone(start);s.quotaDone(start,true);s.summaryDone(start,true);
 s.activity(start+3000);assert.equal(s.due(start+3000).quota,false);assert.equal(s.due(start+300000).quota,true);
 s.quotaDone(start+900000,true);assert.equal(s.quotaAt,start+1800000);assert.equal(s.summaryAt,start+1800000);
 s.activity(start+910000);assert.equal(s.quotaAt,start+1200000);
});
test('quota reset gets one sample before and after with no rapid retry loop',()=>{
 const s=new Schedule(undefined),reset=start+600000;s.quotaDone(start,true);
 const before=s.due(reset-50000,[reset]);assert.equal(before.quota,true);s.quotaDone(reset-50000,true,before.boundary);
 assert.equal(s.due(reset-40000,[reset]).quota,false);assert.equal(s.due(reset+5000,[reset]).quota,false);
 const after=s.due(reset+10000,[reset]);assert.equal(after.quota,true);s.quotaDone(reset+10000,true,after.boundary);
 assert.equal(s.due(reset+20000,[reset]).quota,false);
});
test('failures back off and activity cannot bypass retries; resume schedules reconciliation',()=>{
 const s=new Schedule(undefined);s.quotaDone(start,false);assert.equal(s.quotaAt,start+60000);
 s.quotaDone(start+60000,false);assert.equal(s.quotaAt,start+180000);s.activity(start+60001);assert.equal(s.quotaAt,start+180000);
 s.quotaDone(start+180000,false);assert.equal(s.quotaAt,start+420000);s.quotaDone(start+420000,false);assert.equal(s.quotaAt,start+720000);
 s.summaryDone(start,true);s.localDone(start);s.resume();assert.deepEqual({...s.due(start),boundary:undefined},{local:true,quota:true,summary:true,boundary:undefined});
});
test('selective quota requests preserve unchanged successful reads, failures, timestamps and raw response',async()=>{
 const t=temp();try{
  const calls:string[]=[];const response={rateLimits:{limitId:'codex',primary:{usedPercent:12,windowDurationMins:10080,resetsAt:1900000000}},rateLimitsByLimitId:null};let fail=false;
  const client={async start(){},async request(method:string){calls.push(method);if(fail)throw Error('rpc_timeout');return response;},close(){}};
  await collectAccount(t.db,client,['account/rateLimits/read']);await collectAccount(t.db,client,['account/rateLimits/read']);fail=true;await collectAccount(t.db,client,['account/rateLimits/read']);
  assert.deepEqual(calls,Array(3).fill('account/rateLimits/read'));
  const rows=t.db.db.prepare('SELECT * FROM observations ORDER BY id').all();assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>r.status),['ok','ok','error']);assert.deepEqual(JSON.parse(rows[0].raw_json as string).response,response);
  assert.equal(t.db.latestAccount(),null);
 }finally{t.close();}
});
test('account identity projection and startup failures retain no email or arbitrary error text',async()=>{
 const t=temp();try{
  const client={async start(){},async request(){return {account:{type:'chatgpt',planType:'pro',email:'PRIVATE_SENTINEL'}};},close(){}};
  await collectAccount(t.db,client,['account/read']);
  await collectAccount(t.db,{...client,async start(){throw Error('PRIVATE SECRET /path');}},['account/usage/read']);
  const rows=t.db.db.prepare('SELECT * FROM observations').all();assert.ok(!JSON.stringify(rows).includes('PRIVATE'));assert.equal(rows[1].status,'error');
 }finally{t.close();}
});
test('export JSONL is range-filtered, parseable and refuses to overwrite existing files',async()=>{
 const t=temp();try{
  t.db.observe('app_server','account/rateLimits/read','ok',{response:{usedPercent:10}},'2026-10-03T10:00:00.000Z');
  t.db.observe('app_server','account/rateLimits/read','error',{code:'rpc_timeout'},'2026-10-04T10:00:00.000Z');
  const path=join(t.dir,'facts.jsonl'),range={from:'2026-10-03T00:00:00.000Z',to_exclusive:'2026-10-04T00:00:00.000Z',timezone:'UTC'};
  const result=await exportData(t.db,'observations',range,path);assert.equal(result.records,1);
  const rows=readFileSync(path,'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.equal(rows[0].type,'metadata');assert.equal(rows[1].data.raw.response.usedPercent,10);
  await assert.rejects(exportData(t.db,'observations',range,path),/already_exists/);
 }finally{t.close();}
});
test('targeted ingest leaves unrelated files untouched and cannot follow watcher symlinks',async()=>{
 const t=temp();try{
  const home=join(t.dir,'source'),sessions=join(home,'sessions');mkdirSync(sessions,{recursive:true});
  const a=join(sessions,'rollout-a.jsonl'),b=join(sessions,'rollout-b.jsonl');writeFileSync(a,'{}\n');writeFileSync(b,'{}\n');
  const r=await syncRollouts(t.db,home,[],undefined,[a]);assert.equal(r.files,1);assert.ok(t.db.checkpoint(a));assert.equal(t.db.checkpoint(b),undefined);
  symlinkSync(b,join(sessions,'rollout-link.jsonl'));assert.equal(sourceEventPath(home,'sessions','rollout-link.jsonl'),null);assert.equal(sourceEventPath(home,'sessions','../rollout-other.jsonl'),null);assert.equal(sourceEventPath(home,'sessions','rollout-a.jsonl'),a);
 }finally{t.close();}
});
test('monitor singleton lock prevents duplicate background collectors and can be released',()=>{
 const t=temp();try{const release=acquireMonitorLock(t.dir);assert.throws(()=>acquireMonitorLock(t.dir),/already_running/);release();acquireMonitorLock(t.dir)();}finally{t.close();}
});
test('launchd configuration uses absolute executable arguments and escapes XML paths',()=>{
 const xml=servicePlist('/tmp/a & b','test','/absolute/node','/absolute/cli.js');assert.ok(xml.includes('a &amp; b'));assert.ok(xml.includes('<string>/absolute/node</string>'));assert.ok(xml.includes('<key>KeepAlive</key><true/>'));assert.ok(!xml.includes('/bin/sh'));
});
