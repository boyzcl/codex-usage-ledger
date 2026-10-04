import test from 'node:test';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,renameSync,rmSync,readFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialState,parseLine} from '../src/parser.js';
import {projectJson} from '../src/privacy.js';
import {Ledger} from '../src/store.js';
import {syncRollouts} from '../src/ingest.js';
import {priceUsage,validatePrices} from '../src/pricing.js';
import {estimatePoints,quotaEstimates,type Point} from '../src/estimator.js';
import {normalizeQuota} from '../src/quota.js';
import {aggregate,period} from '../src/report.js';
import {assertSeparate} from '../src/config.js';
import {AppServer} from '../src/app-server.js';
import type {PriceRule,Config} from '../src/types.js';
const stamp='2026-10-03T10:00:00.000Z';
const use=(input=100,output=20,cached=40,write=10,reason=5)=>({input_tokens:input,output_tokens:output,cached_input_tokens:cached,cache_write_input_tokens:write,reasoning_output_tokens:reason,total_tokens:input+output});
const line=(type:string,payload:any,timestamp=stamp)=>JSON.stringify({timestamp,ordinal:1,type,payload});
const meta=(id='thread',parent?:string)=>line('session_meta',{id,session_id:id,timestamp:'2026-10-03T00:00:00Z',source:parent?{subagent:{thread_spawn:{parent_thread_id:parent}}}:'cli',base_instructions:{text:'PRIVATE_SENTINEL'}});
const settings=(model='test-model',service_tier='default')=>line('event_msg',{type:'thread_settings_applied',thread_id:'thread',thread_settings:{model,service_tier,cwd:'/private/project'}});
const ctx=(model='test-model',turn_id='turn')=>line('turn_context',{model,turn_id,root_turn_id:'root',effort:'high',developer_instructions:'PRIVATE_SENTINEL'});
const record=(id='resp',usage=use(),extra={})=>line('token_usage_record',{response_id:id,thread_id:'thread',turn_id:'turn',session_id:'session',root_turn_id:'root',usage,...extra});
const count=(usage=use(),total=usage)=>line('event_msg',{type:'token_count',info:{total_token_usage:total,last_token_usage:usage}});
function parsed(lines=[meta(),settings(),ctx(),record()]){const state=initialState();const out=lines.flatMap(l=>parseLine(l,state).usage);return {state,out};}
const rule=(extra:Partial<PriceRule>={}):PriceRule=>({id:'api-1',kind:'api',model:'test-model',processing_mode:'standard',effective_from:'2026-01-01T00:00:00.000Z',effective_to:null,context_min:0,context_max:272000,rates:{input:2,cached_input:.2,cache_write:2.5,output:10},source_url:'https://example.com/official-test-fixture',retrieved_at:stamp,basis:'synthetic',...extra});
const config:Config={codex_home:'/unused',timezone:'Asia/Shanghai',poll_seconds:60,codex_binary:'codex',estimator:{weight_basis:'verified',bucket_models:{codex:['test-model']}}};
function temp(){const dir=mkdtempSync(join(tmpdir(),'cux-test-'));mkdirSync(join(dir,'source','sessions'),{recursive:true});mkdirSync(join(dir,'source','archived_sessions'));const db=new Ledger(join(dir,'ledger.db'));return {dir,db,home:join(dir,'source'),close(){db.close();rmSync(dir,{recursive:true,force:true});}};}

test('ordinary response, cached input and cache write are disjoint; reasoning stays a subset',()=>{const u=parsed().out[0];assert.equal(u.uncached_input_tokens,50);assert.equal(u.total_tokens,120);assert.equal(u.reasoning_output_tokens,5);assert.equal(u.model,'test-model');});
test('JSON projection never retains private bodies or unknown fields',()=>{const s=JSON.stringify(projectJson(meta()));assert.ok(!s.includes('PRIVATE_SENTINEL'));assert.ok(!s.includes('base_instructions'));assert.equal(parseLine(line('response_item',{type:'message',content:'PRIVATE_SENTINEL'}),initialState()).usage.length,0);});
test('reasoning is not billed twice',()=>{const u=priceUsage(parsed().out[0],[rule()]);assert.equal(u.api_equivalent_usd,(50*2+40*.2+10*2.5+20*10)/1e6);});
test('Fast rule selected independently of Standard',()=>{const u=parsed([meta(),settings('test-model','fast'),ctx(),record()]).out[0];assert.equal(priceUsage(u,[rule()]).api_equivalent_usd,null);assert.equal(priceUsage(u,[rule({processing_mode:'fast'})]).api_rule_id,'api-1');});
test('long-context pricing applies to entire request at 272001',()=>{const u=parsed([meta(),settings(),ctx(),record('long',use(272001,20,0,0,0))]).out[0];const r=rule({id:'long',context_min:272001,context_max:null,rates:{input:4,cached_input:.4,cache_write:5,output:15}});assert.equal(priceUsage(u,[rule(),r]).api_equivalent_usd,(272001*4+20*15)/1e6);});
test('mid-session model changes apply at the change event',()=>{const {out}=parsed([meta(),settings(),ctx(),record(),settings('another'),record('next')]);assert.deepEqual(out.map(x=>x.model),['test-model','another']);});
test('mid-session speed changes apply at the change event',()=>{const {out}=parsed([meta(),settings(),ctx(),record(),settings('test-model','fast'),record('next')]);assert.deepEqual(out.map(x=>x.service_tier),['default','fast']);});
test('unknown model and unknown service tier have null prices',()=>{const u=parsed([meta(),record()]).out[0];assert.equal(u.model,'unknown');assert.equal(priceUsage(u,[rule()]).api_equivalent_usd,null);});
test('unknown price periods and ambiguous rule overlaps fail closed',()=>{const u=parsed().out[0];assert.equal(priceUsage(u,[rule({effective_from:'2027-01-01T00:00:00Z'})]).api_equivalent_usd,null);assert.equal(priceUsage(u,[rule(),rule({id:'other'})]).api_equivalent_usd,null);});
test('price schema rejects negative rates and duplicate IDs',()=>{assert.throws(()=>validatePrices([rule({rates:{input:-1,cached_input:0,cache_write:0,output:0}})]));assert.throws(()=>validatePrices([rule(),rule()]));});
test('Codex credits charge cache writes as ordinary input, without the API surcharge',()=>{const r=rule({id:'credits',kind:'credit',rates:{input:50,cached_input:5,cache_write:50,output:250}});assert.equal(priceUsage(parsed().out[0],[r]).credit_equivalent,(60*50+40*5+20*250)/1e6);});
test('duplicate response IDs and inherited copied responses counted once globally',()=>{const t=temp();try{const r=parsed().out[0];assert.equal(t.db.insertUsage(r),true);assert.equal(t.db.insertUsage({...r,inherited:true}),false);assert.equal(t.db.records().length,1);}finally{t.close();}});
test('legacy cumulative delta and unchanged replay counter',()=>{const {out}=parsed([meta(),settings(),ctx(),count(),count(),count(use(50,10,20,5,2),use(150,30,60,15,7))]);assert.equal(out.length,2);assert.equal(aggregate(out).total_tokens,180);});
test('legacy reset uses last usage, auxiliary regression does not lower baseline',()=>{const {out}=parsed([meta(),ctx(),count(use(100,20),use(100,20)),count(use(10,2,0,0,0),use(110,22,0,0,0)),count(use(5,1,0,0,0),use(50,10,0,0,0))]);assert.equal(aggregate(out).total_tokens,138);});
test('new response record suppresses paired token_count',()=>{const {out}=parsed([meta(),settings(),ctx(),record(),count()]);assert.equal(out.length,1);});
test('old compaction gap is explicitly flagged',()=>{const s=initialState();const r=parseLine(line('compacted',{message:'PRIVATE_SENTINEL'}),s);assert.equal(r.issues[0].code,'unrecoverable_usage_gap');});
test('compaction embedded latest record must match compaction response ID',()=>{const s=initialState();const r=parseLine(line('compacted',{compaction_response_id:'comp',latest_token_usage_record:{response_id:'ordinary',usage:use()}}),s);assert.equal(r.usage.length,0);});
test('invalid token counters are not ingested',()=>{const {out}=parsed([meta(),record('bad',use(-5))]);assert.equal(out.length,0);});
test('inconsistent token subsets cannot be priced',()=>{const {out}=parsed([meta(),settings(),ctx(),record('bad',use(10,20,40,10))]);assert.equal(out[0].data_quality,'inconsistent');assert.equal(priceUsage(out[0],[rule()]).api_equivalent_usd,null);});

test('incremental append, active/archive move and repeat sync remain idempotent',async()=>{const t=temp();try{const file=join(t.home,'sessions','rollout-1.jsonl');writeFileSync(file,[meta(),settings(),ctx(),record(),count()].join('\n')+'\n');await syncRollouts(t.db,t.home,[]);assert.equal(t.db.records().length,1);assert.equal((await syncRollouts(t.db,t.home,[])).bytes_read,0);appendFileSync(file,record('new')+'\n');await syncRollouts(t.db,t.home,[]);renameSync(file,join(t.home,'archived_sessions','rollout-1.jsonl'));await syncRollouts(t.db,t.home,[]);assert.equal(t.db.records().length,2);}finally{t.close();}});
test('partial trailing line waits for newline; bad line does not destroy the ledger',async()=>{const t=temp();try{const file=join(t.home,'sessions','rollout-1.jsonl');writeFileSync(file,meta()+'\n'+ctx()+'\n'+record().slice(0,50));await syncRollouts(t.db,t.home,[]);assert.equal(t.db.records().length,0);appendFileSync(file,record().slice(50)+'\n{bad json}\n'+record('second')+'\n');await syncRollouts(t.db,t.home,[]);assert.equal(t.db.records().length,2);assert.ok(t.db.issues().some(x=>x.code==='malformed_line'));}finally{t.close();}});
test('compaction record and embedded snapshot count only once',async()=>{const t=temp();try{const p={response_id:'comp',thread_id:'thread',turn_id:'turn',session_id:'s',root_turn_id:'r',usage:use()};writeFileSync(join(t.home,'sessions','rollout-1.jsonl'),[meta(),ctx(),line('token_usage_record',p),line('compacted',{compaction_response_id:'comp',latest_token_usage_record:p})].join('\n')+'\n');await syncRollouts(t.db,t.home,[]);assert.equal(t.db.records().length,1);assert.equal(t.db.records()[0].source,'token_usage_record');}finally{t.close();}});
test('late exact record replaces provisional legacy for its turn',async()=>{const t=temp();try{const file=join(t.home,'sessions','rollout-1.jsonl');writeFileSync(file,[meta(),ctx(),count()].join('\n')+'\n');await syncRollouts(t.db,t.home,[]);assert.equal(t.db.records()[0].source,'legacy_token_count');appendFileSync(file,record()+'\n');await syncRollouts(t.db,t.home,[]);assert.equal(t.db.records().length,1);assert.equal(t.db.records()[0].source,'token_usage_record');}finally{t.close();}});
test('fork replay with rewritten timestamps matches parent fingerprints',async()=>{const t=temp();try{writeFileSync(join(t.home,'sessions','rollout-1.jsonl'),[meta('parent'),ctx(),count()].join('\n')+'\n');writeFileSync(join(t.home,'sessions','rollout-2.jsonl'),[meta('child','parent'),ctx(),count(),count(use(2,1,0,0,0),use(102,21,40,10,5))].join('\n')+'\n');await syncRollouts(t.db,t.home,[]);assert.equal(aggregate(t.db.records()).total_tokens,123);}finally{t.close();}});
test('projection checkpoint and usage database contain no private sentinel',async()=>{const t=temp();try{writeFileSync(join(t.home,'sessions','rollout-1.jsonl'),[meta(),ctx(),record()].join('\n')+'\n');await syncRollouts(t.db,t.home,[]);const values=t.db.db.prepare('SELECT state_json FROM ingest_files').all();assert.ok(!JSON.stringify(values).includes('PRIVATE_SENTINEL'));assert.ok(!JSON.stringify(t.db.records()).includes('PRIVATE_SENTINEL'));}finally{t.close();}});

function points(count=6):Point[]{return Array.from({length:count+1},(_,i)=>({timestamp:new Date(Date.parse(stamp)+i*60000).toISOString(),percent:10+i*5,units:i*50,raw_tokens:i*1e6,unknown:0,records:i,source:'rollout'}));}
test('synthetic known capacity recovers 1000 with bounds and HIGH confidence',()=>{const r=estimatePoints(points());assert.equal(r.estimated_capacity,1000);assert.ok(r.lower_bound!<1000&&r.upper_bound!>1000);assert.equal(r.confidence,'HIGH');assert.equal(r.clean_span_count,6);});
test('two spans do not satisfy three-span acceptance threshold',()=>{const r=estimatePoints(points(2));assert.equal(r.estimated_capacity,null);assert.equal(r.missing_clean_spans,1);});
test('percentage quantization interval widens for small movement',()=>{const r=estimatePoints(points(3));assert.equal(r.lower_bound,5000/6);assert.equal(r.upper_bound,1250);});
test('external usage is excluded and reduces coverage/confidence',()=>{const p=points(5);p.push({...p.at(-1)!,timestamp:new Date(Date.parse(stamp)+6*60000).toISOString(),percent:40});const r=estimatePoints(p);assert.equal(r.external_usage_detected,true);assert.ok(r.coverage_ratio<1);assert.notEqual(r.confidence,'HIGH');});
test('external jump hidden inside a long span is still detected',()=>{const p=points(0);p.push({...p[0],percent:13,timestamp:'2026-10-03T10:01:00Z'});p.push({...p[0],percent:15,units:50,raw_tokens:1e6,timestamp:'2026-10-03T10:02:00Z'});assert.equal(estimatePoints(p).external_usage_detected,true);});
test('unknown weighted usage prevents point estimation',()=>{const p=points(5).map((x,i)=>({...x,unknown:i}));assert.equal(estimatePoints(p).estimated_capacity,null);});
test('different resets and buckets never combine',()=>{const qs=[...normalizeQuota({limit_id:'codex',primary:{used_percent:10,window_minutes:300,resets_at:1791040000}},stamp,'rollout'),...normalizeQuota({limit_id:'other',primary:{used_percent:80,window_minutes:300,resets_at:1791040001}},stamp,'rollout')];const r=quotaEstimates(qs,[],config,[]);assert.equal(r.length,2);assert.ok(r.every(x=>x.estimated_capacity===null));});
test('missing bucket mapping fails closed even with quota observations',()=>{const qs=normalizeQuota({limit_id:'unmapped',primary:{used_percent:10,window_minutes:300,resets_at:1791040000}},stamp,'rollout');assert.equal(quotaEstimates(qs,[],config,[])[0].reason,'unknown_bucket_model_mapping');});
test('multi-bucket view does not double count legacy rateLimits',()=>{const b={limitId:'codex',primary:{usedPercent:12,windowDurationMins:10080,resetsAt:1791595990}};assert.equal(normalizeQuota({rateLimits:b,rateLimitsByLimitId:{codex:b}},stamp,'app_server').length,1);});
test('date range respects Shanghai inclusive dates and validates invalid input',()=>{const r=period('report','Asia/Shanghai','2026-10-01','2026-10-03');assert.equal(r.from,'2026-09-30T16:00:00.000Z');assert.equal(r.to_exclusive,'2026-10-03T16:00:00.000Z');assert.throws(()=>period('report','UTC','2026-02-30','2026-03-01'));});
test('DST report day has correct 23-hour duration',()=>{const r=period('report','America/New_York','2026-03-08','2026-03-08');assert.equal(Date.parse(r.to_exclusive)-Date.parse(r.from),23*3600000);});
test('source and data paths cannot overlap or escape via symlink',()=>{const t=temp();try{assert.throws(()=>assertSeparate(join(t.home,'ledger'),t.home));symlinkSync(t.home,join(t.dir,'link'));assert.throws(()=>assertSeparate(join(t.dir,'link','ledger'),t.home));}finally{t.close();}});
test('app-server unavailable does not prevent reading existing history',async()=>{const t=temp();try{t.db.insertUsage(parsed().out[0]);const client=new AppServer({...config,codex_home:t.home,codex_binary:'/nonexistent/codex'},join(t.dir,'runtime'),500);await assert.rejects(client.start());client.close();assert.equal(t.db.records().length,1);}finally{t.close();}});
test('app-server mutating RPCs are not allowlisted',async()=>{const client=new AppServer(config,'/unused');await assert.rejects(client.request('account/logout'),/not_allowlisted/);});
test('stored pricing rules are immutable by ID',()=>{const t=temp();try{t.db.savePrices([rule()]);assert.throws(()=>t.db.savePrices([rule({rates:{input:3,cached_input:0,cache_write:0,output:0}})]));}finally{t.close();}});
test('bundled price catalog is valid and contains no invented allowance rules',()=>{const r=validatePrices(JSON.parse(readFileSync(new URL('../../data/prices.json',import.meta.url),'utf8')));assert.ok(r.length>0);assert.ok(r.every(x=>x.kind!=='allowance'));});

test('fork matching stops after divergence; later equal totals are real usage',async()=>{const t=temp();try{
 const a=count(use(100,20,0,0,0));const b=count(use(10,2,0,0,0),use(110,22,0,0,0));const c=count(use(5,1,0,0,0),use(105,21,0,0,0));
 writeFileSync(join(t.home,'sessions','rollout-1.jsonl'),[meta('parent'),ctx(),a,b].join('\n')+'\n');
 writeFileSync(join(t.home,'sessions','rollout-2.jsonl'),[meta('child','parent'),ctx(),a,c,b].join('\n')+'\n');
 await syncRollouts(t.db,t.home,[]);assert.equal(aggregate(t.db.records()).total_tokens,150);
 }finally{t.close();}});
test('latest quota omits expired buckets and removed secondary window',()=>{const t=temp();try{
 const future=Math.floor(Date.now()/1000)+1000;
 for(const q of normalizeQuota({limit_id:'codex',primary:{used_percent:5,window_minutes:300,resets_at:future},secondary:{used_percent:10,window_minutes:10080,resets_at:future}},'2026-01-01T00:00:00Z','rollout'))t.db.insertQuota(q);
 for(const q of normalizeQuota({limit_id:'codex',primary:{used_percent:20,window_minutes:10080,resets_at:future}},'2026-01-02T00:00:00Z','app_server'))t.db.insertQuota(q);
 assert.equal(t.db.latestQuota().length,1);assert.equal(t.db.latestQuota()[0].window_duration_mins,10080);
 }finally{t.close();}});

test('macOS OS sandbox prevents writes through original auth path and isolated auth link',{skip:process.platform!=='darwin'},async()=>{
 const t=temp();try{
  const auth=join(t.home,'auth.json');writeFileSync(auth,'synthetic-secret');
  const binary=join(t.dir,'fake-codex');
  const source=`#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline');
const paths=[${JSON.stringify(auth)},process.env.CODEX_HOME+'/auth.json'];
const denied=paths.map(p=>{try{fs.writeFileSync(p,'changed');return false;}catch{return true;}});
rl.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:{denied}}));});
`;
  writeFileSync(binary,source,{mode:0o700});
  const client=new AppServer({...config,codex_home:t.home,codex_binary:binary},join(t.dir,'runtime'),10000);
  try{await client.start();const r=await client.request('account/read',{refreshToken:false});assert.deepEqual(r.denied,[true,true]);assert.equal(readFileSync(auth,'utf8'),'synthetic-secret');}finally{client.close();}
 }finally{t.close();}
});

test('watch reacts to rollout append and hook marker, then shuts down cleanly',async()=>{
 const t=temp();const data=join(t.dir,'data');mkdirSync(data);
 writeFileSync(join(data,'config.json'),JSON.stringify({...config,codex_home:t.home}));
 const nested=join(t.home,'sessions','2026','10','03');mkdirSync(nested,{recursive:true});
 const file=join(nested,'rollout-watch.jsonl');writeFileSync(file,[meta(),settings(),ctx(),record()].join('\n')+'\n');
 const child=spawn(process.execPath,[new URL('../src/cli.js',import.meta.url).pathname,'watch','--offline','--json','--data-home',data],{stdio:['ignore','pipe','pipe']});
 try{await new Promise<void>((resolve,reject)=>{
  let output='',phase=0;const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('watch_test_timeout: '+output.slice(-2000)));},30000);
  child.stdout.on('data',chunk=>{output+=chunk.toString();const cycles=(output.match(/"synced_at"/g)??[]).length;
   if(phase===0&&cycles>=1){phase=1;setTimeout(()=>appendFileSync(file,record('watch-new')+'\n'),200);}
   else if(phase===1&&cycles>=2){phase=2;writeFileSync(join(data,'refresh.request'),'');}
   else if(phase===2&&cycles>=3){phase=3;child.kill('SIGTERM');}
  });
  child.on('exit',code=>{clearTimeout(timer);if(code===0&&phase===3)resolve();else reject(Error('watch_unexpected_exit'));});
  child.on('error',e=>{clearTimeout(timer);reject(e);});
 });const db=new Ledger(join(data,'usage.db'));try{assert.equal(db.records().length,2);}finally{db.close();}
 }finally{child.kill('SIGKILL');t.close();}
});

test('archived JSONL files can have non-rollout names',async()=>{const t=temp();try{writeFileSync(join(t.home,'archived_sessions','archived.jsonl'),[meta(),ctx(),record()].join('\n')+'\n');await syncRollouts(t.db,t.home,[]);assert.equal(t.db.records().length,1);}finally{t.close();}});

test('missing weight rules do not falsely label observed local tokens as external usage',()=>{
 const p=points(3).map((x,i)=>({...x,units:0,unknown:i}));const r=estimatePoints(p);assert.equal(r.estimated_capacity,null);assert.equal(r.external_usage_detected,false);
});
