import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {format,formatError,cellWidth} from '../src/display.js';
import {aggregate,report} from '../src/report.js';
import {initialState,parseLine} from '../src/parser.js';
const now=Date.parse('2026-10-03T15:19:43.125Z');
const total={records:6289,sessions:100,unique_responses:5917,input_tokens:927696739,cached_input_tokens:891105152,uncached_input_tokens:36591587,cache_write_input_tokens:0,output_tokens:3457563,reasoning_output_tokens:677260,total_tokens:931154302,unclassified_tokens:0,api_equivalent_usd:null,known_api_subtotal_usd:92.07,api_token_coverage:.1036,credit_equivalent:null,known_credit_subtotal:2301.64,credit_token_coverage:.1036};
const current={...total,known_api_subtotal_usd:941.34,api_token_coverage:.8548,at:new Date(now).toISOString()};
const window={limit_id:'codex',slot:'primary',window_duration_mins:10080,used_percent:68,timestamp:'2026-10-03T15:18:10.427Z',resets_at:1791595990,source:'app_server'};
const monitor={running:true,heartbeat_at:'2026-10-03T15:19:31.931Z',active:true,policy:{local_reconcile_seconds:300,quota_idle_seconds:900}};
const value={as_of:new Date(now).toISOString(),account:{plan:'pro'},quota:[window],today:{totals:total,models:{test:total},current_price_valuation:current},monitor,last_sync:{synced_at:'2026-10-03T15:17:51.699Z'},capacity:[{limit_id:'codex',estimated_capacity:null,reason:'unknown_bucket_model_mapping'}],issues:[{code:'unrecoverable_usage_gap',count:1861}]};

test('status highlights remaining quota, local reset time and partial price with coverage',()=>{
 const s=format(value,{now});assert.ok(s.indexOf('剩余 32%')<s.indexOf('今日 Token'));assert.match(s,/2026\/10\/10 09:33/);assert.match(s,/9\.31 亿/);assert.match(s,/\$941\.34/);assert.match(s,/85\.48%/);assert.match(s,/其余 14\.52%/);assert.match(s.replace(/\n/g,''),/不是订阅账单/);assert.match(s,/状态未提供当日消耗及 100% 估算/);assert.doesNotMatch(s,/92\.07|unknown_bucket|unrecoverable_usage_gap|2026-10-03T/);
});
test('details reveal exact counters, price bases and diagnostics without changing the input',()=>{
 const before=JSON.stringify(value),s=format(value,{now,details:true});assert.match(s,/931,154,302/);assert.match(s,/\$92\.07/);assert.match(s,/10\.36%/);assert.match(s,/2,301\.64/);assert.match(s,/unrecoverable_usage_gap/);assert.equal(JSON.stringify(value),before);
});
test('monitor liveness does not hide failed quota collection or stale local and quota data',()=>{
 const s=format({...value,last_sync:{synced_at:'2026-10-02T00:00:00Z'},quota:[{...window,timestamp:'2026-10-02T00:00:00Z'}]},{now,collection:{status:'error',code:'rpc_timeout'}});
 assert.match(s,/后台运行中/);assert.match(s,/最近额度查询失败/);assert.match(s,/额度快照较旧/);assert.match(s,/本地同步时间较旧/);
 const stale=format({...value,monitor:{...monitor,heartbeat_at:'2026-10-03T12:00:00Z'}},{now});assert.match(stale,/监控心跳已过期/);assert.doesNotMatch(stale,/● 后台运行中/);
});
test('empty, zero-valued and unpriced use cases never masquerade as fully known charges',()=>{
 const empty=report([],[]);const s=format(empty,{command:'today',now});assert.match(s,/暂无已入账记录/);assert.match(s,/金额不适用/);assert.doesNotMatch(s,/命中率.*100%/);
 const unknown=format({totals:total,models:{},current_price_valuation:{...current,api_token_coverage:0,known_api_subtotal_usd:0}},{command:'today',now});assert.match(unknown,/暂无可计价用量/);assert.match(unknown,/其余 100%/);
});
test('multiple quota windows, zero and full usage are each rendered independently',()=>{
 const s=format({windows:[{...window,used_percent:0},{...window,slot:'secondary',window_duration_mins:300,used_percent:100}]},{command:'quota',now});assert.match(s,/剩余 100%/);assert.match(s,/剩余 0%/);assert.match(s,/5 小时额度窗口/);assert.match(s,/7 天额度窗口/);
});
test('40-column and 24-column output never overflows including CJK, long models and paths',()=>{
 const reportValue={totals:total,models:{['test-model-'.repeat(12)]:total},current_price_valuation:current};
 for(const width of [24,40,80])for(const [v,command] of [[value,'status'],[reportValue,'models'],[{path:'/very/long/'+('project/'.repeat(25))+'usage.jsonl',records:10},'export']] as const){
  const s=format(v,{command,now,width});assert.ok(s.split('\n').every(line=>cellWidth(line)<=width),s);
 }
});
test('color is opt-in, removable, and terminal escape sequences in data cannot execute',()=>{
 const model='evil\x1b[2J\x1b]0;bad\x07';const v={totals:total,models:{[model]:total},current_price_valuation:current};
 const plain=format(v,{command:'models',now});assert.ok(!plain.includes('\x1b'));assert.ok(format(v,{command:'models',color:true,now}).includes('\x1b[1m'));
});
test('model ranking sorts by token count, explains partial money and expands beyond top five',()=>{
 const models=Object.fromEntries(Array.from({length:7},(_,i)=>['model-'+i,{...total,total_tokens:i*100+100}]));
 const s=format({totals:{...total,total_tokens:2800},models,current_price_valuation:current},{command:'models',now});assert.ok(s.indexOf('model-6')<s.indexOf('model-5'));assert.match(s,/另有 2 个模型/);assert.match(s,/历史 API 已知小计/);
 const full=format({totals:total,models,current_price_valuation:current},{command:'models',details:true,now});assert.match(full,/model-0/);assert.doesNotMatch(full,/另有/);
});
test('precise period endpoints are retained while calendar ranges show inclusive days',()=>{
 const v={totals:aggregate([]),models:{},current_price_valuation:{},period:{from:'2026-09-30T16:00:00Z',to_exclusive:'2026-10-03T16:00:00Z'}};
 assert.match(format(v,{command:'report',now}),/2026\/10\/01 至 2026\/10\/03（含末日）/);
 assert.match(format({...v,period:{...v.period,from:'2026-10-01T04:30:00Z'}},{command:'report',now}),/12:30/);
});
test('diagnostics distinguish historical gaps, intentional deduplication and current failures',()=>{
 const s=format({ok:true,checks:{sqlite:true},monitor,issues:[{code:'inherited_legacy_skipped',count:347},{code:'unrecoverable_usage_gap',count:1861}]},{command:'doctor',now});assert.match(s,/基础检查通过/);assert.match(s,/去重处理/);assert.match(s,/不表示当前采集失败/);assert.match(s,/未检查网络/);
});
test('estimate preserves experimental status and does not label weighted units as raw tokens',()=>{
 const s=format([{limit_id:'codex',estimated_capacity:1000,lower_bound:900,upper_bound:1100,basis:'experimental_credit_proxy',confidence:'MEDIUM',clean_span_count:3,observed_percent_span:15,coverage_ratio:.9}],{command:'estimate',now});assert.match(s,/加权额度单位/);assert.match(s,/不是官方容量/);assert.match(s,/不是 95% 置信区间/);
});
test('sync, export, watch and service have human summaries rather than raw JSON',()=>{
 for(const [command,v,expected] of [
  ['sync',{rollout:{added_records:32,files:10,changed_files:1},account:{status:'skipped'}},'新增记录'],
  ['export',{records:32,path:'/tmp/out.jsonl'},'已保存至'],
  ['watch',{timestamp:new Date(now).toISOString(),kind:'local_sync',status:'ok',data:{added_records:32,changed_files:1}},'新增 32 条'],
  ['service',{running:false,loaded:false,installed:true,login_enabled:false},'已停用']
 ] as const){assert.match(format(v,{command,now}),new RegExp(expected));}
 assert.match(formatError('export_file_already_exists'),/未被覆盖/);
});

test('CLI JSON and JSONL remain parseable; targeted warning filter leaves other warnings intact',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cux-display-')),home=join(dir,'data'),source=join(dir,'source');mkdirSync(home);mkdirSync(source);
 writeFileSync(join(home,'config.json'),JSON.stringify({codex_home:source,timezone:'Asia/Shanghai'}));
 const cli=new URL('../src/cli.js',import.meta.url).pathname;
 const run=(args:string[])=>spawnSync(process.execPath,[cli,...args,'--data-home',home],{encoding:'utf8'});
 try{
  const json=run(['today','--json','--details']);assert.equal(json.status,0,json.stderr);assert.equal(JSON.parse(json.stdout).totals.total_tokens,0);assert.equal(json.stderr,'');
  const plain=run(['today']);assert.equal(plain.status,0);assert.match(plain.stdout,/今日用量/);assert.ok(!plain.stdout.includes('\x1b'));assert.equal(plain.stderr,'');
  const exp=run(['export','usage']);assert.equal(exp.status,0);assert.equal(JSON.parse(exp.stdout.trim()).type,'metadata');
  const path=join(dir,'export.jsonl');const saved=run(['export','usage','--out',path]);assert.match(saved.stdout,/导出完成/);assert.equal(JSON.parse(readFileSync(path,'utf8')).type,'metadata');
  const err=run(['invalid','--json']);assert.equal(err.status,1);assert.deepEqual(JSON.parse(err.stderr),{error:'unknown_command'});
  const badArg=run(['--oops']);assert.equal(badArg.status,1);assert.match(badArg.stderr,/参数有误/);
  const filter=new URL('../src/sqlite.js',import.meta.url).href;
  const warning=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(filter)});process.emitWarning('sentinel warning','ExperimentalWarning')`],{encoding:'utf8'});
  assert.match(warning.stderr,/sentinel warning/);assert.doesNotMatch(warning.stderr,/SQLite is an experimental feature/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('sample source usage still aggregates identically independently of presentation',()=>{
 const p=parseLine(JSON.stringify({timestamp:'2026-10-03T15:00:00Z',type:'token_usage_record',payload:{response_id:'test',thread_id:'t',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:20,total_tokens:120}}}),initialState());
 const t=aggregate(p.usage);assert.equal(t.total_tokens,120);assert.equal(t.cached_input_tokens,40);const before=structuredClone(t);format({totals:t,models:{},current_price_valuation:t},{command:'today'});assert.deepEqual(t,before);
});

test('unresolved conflicts have one brief default reminder and retain exact detail counts',()=>{
 const v={...value,legacy_reconciliation:{conflict_records:2}};assert.match(format(v,{command:'status',now}),/历史待核对.*未确认用量未计入/);assert.match(format(v,{command:'status',now,details:true}),/争议用量记录.*2.*未计入确认用量/);
 const report={...value.today,period:{from:'2026-10-03T00:00:00Z',to_exclusive:'2026-10-04T00:00:00Z',timezone:'UTC'},legacy_reconciliation:{conflict_records:2},daily:[],plan_cycles:[]};assert.match(format(report,{command:'report',now}),/历史待核对.*未确认用量未计入/);
});
