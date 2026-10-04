import {responseContext} from '../src/quota-policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/store.js';
import {syncRollouts} from '../src/ingest.js';
import {initialState,parseLine} from '../src/parser.js';
import {dailyReport} from '../src/daily.js';
import {period} from '../src/report.js';
import type {Quota} from '../src/types.js';
const time='2026-10-03T10:00:00.000Z';
const line=(type:string,payload:unknown,timestamp=time)=>JSON.stringify({timestamp,type,payload});
const tokens=(input:number,output=0)=>({input_tokens:input,output_tokens:output,total_tokens:input+output});
const meta=(id:string,parent?:string,extra={})=>line('session_meta',{id,timestamp:'2026-10-03T00:00:00.000Z',forked_from_id:parent,...extra});
const settings=(id:string,model:string,extra={})=>line('event_msg',{type:'thread_settings_applied',thread_id:id,thread_settings:{model,...extra}});
const record=(id:string,total:number)=>line('token_usage_record',{response_id:id,usage:tokens(total)});
const legacy=(last:ReturnType<typeof tokens>,total=last)=>line('event_msg',{type:'token_count',info:{last_token_usage:last,total_token_usage:total}});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cux-round1-'));const source=join(dir,'source');mkdirSync(source);const db=new Ledger(join(dir,'usage.db'));return {dir,source,db,close(){db.close();rmSync(dir,{recursive:true,force:true});}};}
for(const order of ['parent-first','child-first'])test(`R1 fork ${order}, delayed parent and repeat converge to 123`,async()=>{
 const f=fixture();try{const p=join(f.source,'parent.jsonl'),c=join(f.source,'child.jsonl');
 writeFileSync(p,[meta('parent'),legacy(tokens(100,20))].join('\n')+'\n');
 writeFileSync(c,[meta('child','parent'),legacy(tokens(100,20)),legacy(tokens(2,1),tokens(102,21))].join('\n')+'\n');
 for(const file of order==='parent-first'?[p,c]:[c,p])await syncRollouts(f.db,f.source,[],undefined,[file]);
 assert.equal(f.db.records().reduce((n,r)=>n+r.total_tokens,0),123);
 await syncRollouts(f.db,f.source,[],undefined,[p,c]);assert.equal(f.db.records().reduce((n,r)=>n+r.total_tokens,0),123);
 }finally{f.close();}
});
test('R1 same inode growing rewrite imports prefix and resets context',async()=>{
 const f=fixture();try{const path=join(f.source,'rewrite.jsonl');
 const original=[meta('old',undefined,{padding:'x'.repeat(2200)}),settings('old','old-model',{service_tier:'fast'}),record('old-response',100)].join('\n')+'\n';
 writeFileSync(path,original);await syncRollouts(f.db,f.source,[],undefined,[path]);
 const prefix=[meta('new'),settings('new','new-model',{service_tier:'default'}),record('new-prefix',200)].join('\n')+'\n';
 writeFileSync(path,prefix+' '.repeat(Buffer.byteLength(original)-Buffer.byteLength(prefix)-1)+'\n'+record('new-tail',300)+'\n');
 await syncRollouts(f.db,f.source,[],undefined,[path]);
 const rows=f.db.records().filter(r=>r.response_id?.startsWith('new-'));assert.equal(rows.length,2);
 assert.ok(rows.every(r=>r.thread_id==='new'&&r.model==='new-model'&&r.service_tier==='default'));
 }finally{f.close();}
});
test('R1 complete settings omission clears tier and effort; reroute retains unrelated settings',()=>{
 const state=initialState();for(const l of [meta('test'),settings('test','a',{service_tier:'fast',reasoning_effort:'high'}),settings('test','a')])parseLine(l,state);
 const row=parseLine(record('settings-result',100),state).usage[0];assert.equal(row.service_tier,'unknown');assert.equal(row.reasoning_effort,null);
 parseLine(settings('test','a',{service_tier:'fast',reasoning_effort:'high'}),state);parseLine(line('event_msg',{type:'model_rerouted',to_model:'b'}),state);
 assert.equal(state.model,'b');assert.equal(state.service_tier,'fast');assert.equal(state.reasoning_effort,'high');
 parseLine(settings('test','b',{service_tier:null,reasoning_effort:null}),state);assert.equal(state.service_tier,'unknown');assert.equal(state.reasoning_effort,null);
});
test('R1 single snapshot before cross-day decrease invalidates capacity',()=>{
 const context=responseContext({accountId:'synthetic'},null,'2026-10-01T00:00:00.000Z','app_server');context.scope={...context.scope,workspace_ref:'synthetic-workspace',billing_source:'synthetic-included',status:'verified'};
 const range=period('report','UTC','2026-10-01','2026-10-02','2026-10-03T00:00:00.000Z');
 const quota=(timestamp:string,used_percent:number):Quota=>({context,id:timestamp,timestamp,used_percent,source:'app_server',slot:'primary',limit_id:'codex',window_duration_mins:10080,resets_at:Date.parse('2026-10-07T00:00:00Z')/1000,raw_json:'{}'});
 const row=parseLine(line('token_usage_record',{response_id:'q',usage:tokens(100)},'2026-10-02T01:30:00.000Z'),initialState()).usage[0];
 row.quota_attribution={scope:context.scope,limit_id:'codex',slot:'primary',window_duration_mins:10080,resets_at:Date.parse('2026-10-07T00:00:00Z')/1000,source:'source_event'};
 const result=dailyReport([row],[quota('2026-10-01T01:00:00.000Z',90),quota('2026-10-02T01:00:00.000Z',10),quota('2026-10-02T02:00:00.000Z',20)],[],range,'2026-10-03T00:00:00.000Z');
 assert.equal(result.plan_cycles[0].estimated_tokens,null);assert.equal(result.plan_cycles[0].reason,'percent_decrease');
 const experiment=dailyReport([row],[quota('2026-10-01T01:00:00.000Z',90),quota('2026-10-02T01:00:00.000Z',10),quota('2026-10-02T02:00:00.000Z',20)],[],range,'2026-10-03T00:00:00.000Z',{experimentalEmpirical:true});
 assert.equal(experiment.plan_cycles[0].estimated_tokens,null);assert.equal(experiment.plan_cycles[0].reason,'percent_decrease');
 assert.equal(experiment.daily[1].plans[0].estimated_tokens,null);assert.equal(experiment.daily[1].plans[0].reason,'percent_decrease');
});
test('R1 append partial line and archive path remain identity-idempotent',async()=>{
 const f=fixture();try{const p=join(f.source,'a.jsonl');const r=record('one',10);writeFileSync(p,meta('a')+'\n'+r.slice(0,30));await syncRollouts(f.db,f.source,[],undefined,[p]);assert.equal(f.db.records().length,0);
 appendFileSync(p,r.slice(30)+'\n');await syncRollouts(f.db,f.source,[],undefined,[p]);assert.equal(f.db.records().length,1);
 const a=join(f.source,'archive.jsonl');writeFileSync(a,meta('a')+'\n'+r+'\n');await syncRollouts(f.db,f.source,[],undefined,[a]);assert.equal(f.db.records().length,1);
 }finally{f.close();}
});

test('R1 absent parent stays pending; later parent append rechecks every child candidate',async()=>{
 const f=fixture();try{const p=join(f.source,'parent.jsonl'),c=join(f.source,'child.jsonl');
 const a=legacy(tokens(100,20)),b=legacy(tokens(2,1),tokens(102,21));
 writeFileSync(c,[meta('child','parent'),a,b].join('\n')+'\n');await syncRollouts(f.db,f.source,[],undefined,[c]);
 assert.equal(f.db.records().length,0);assert.equal(f.db.get<{pending_tokens:number}>('legacy_reconciliation')?.pending_tokens,123);
 writeFileSync(p,meta('parent')+'\n');await syncRollouts(f.db,f.source,[],undefined,[p]);assert.equal(f.db.records().length,0);
 appendFileSync(p,a+'\n');await syncRollouts(f.db,f.source,[],undefined,[p]);assert.equal(f.db.records().reduce((n,r)=>n+r.total_tokens,0),123);
 await syncRollouts(f.db,f.source,[],undefined,[c,p]);assert.equal(f.db.records().reduce((n,r)=>n+r.total_tokens,0),123);
 }finally{f.close();}
});
test('R1 child-first divergent sequence does not delete later accidental equality',async()=>{
 const f=fixture();try{const p=join(f.source,'parent.jsonl'),c=join(f.source,'child.jsonl');
 const a=legacy(tokens(100,20)),b=legacy(tokens(10,2),tokens(110,22)),d=legacy(tokens(5,1),tokens(105,21));
 writeFileSync(p,[meta('parent'),a,b].join('\n')+'\n');writeFileSync(c,[meta('child','parent'),a,d,b].join('\n')+'\n');
 await syncRollouts(f.db,f.source,[],undefined,[c,p]);assert.equal(f.db.records().reduce((n,r)=>n+r.total_tokens,0),150);
 }finally{f.close();}
});
for(const mode of ['middle','replacement','truncate-grow'])test(`R1 ${mode} rewrite detects context changes and corrects the same response ID`,async()=>{
 const f=fixture();try{const path=join(f.source,'file.jsonl');const padding=line('response_item',{type:'message',content:'PRIVATE_BODY'.repeat(1000)});
 const original=[meta('same'),padding,settings('same','a',{service_tier:'fast'}),padding,record('same-response',100),padding].join('\n')+'\n';
 writeFileSync(path,original);await syncRollouts(f.db,f.source,[],undefined,[path]);
 const changed=original.replace(settings('same','a',{service_tier:'fast'}),settings('same','b',{service_tier:'flex'}))+record('tail',300)+'\n';
 if(mode==='replacement'){const other=path+'.new';writeFileSync(other,changed);const {renameSync}=await import('node:fs');renameSync(other,path);}
 else{if(mode==='truncate-grow')writeFileSync(path,'');writeFileSync(path,changed);}
 const result=await syncRollouts(f.db,f.source,[],undefined,[path]);const row=f.db.records().find(r=>r.response_id==='same-response')!;
 assert.equal(row.model,'b');assert.equal(row.service_tier,'flex');assert.equal(row.total_tokens,100);assert.equal(f.db.records().length,2);
 assert.equal(result.changed_files,1);assert.ok(result.validation_bytes_read>=Buffer.byteLength(changed)*2);
 assert.ok(!JSON.stringify(f.db.db.prepare('SELECT * FROM ingest_files').all()).includes('PRIVATE_BODY'));
 }finally{f.close();}
});
test('R1 file modified during ingest rolls back all rows and checkpoint then retries',async()=>{
 const f=fixture();try{const p=join(f.source,'race.jsonl');writeFileSync(p,[meta('race'),record('first',100)].join('\n')+'\n');
 const insert=f.db.insertUsage.bind(f.db);let mutated=false;
 f.db.insertUsage=(row,correct)=>{const result=insert(row,correct);if(!mutated){mutated=true;appendFileSync(p,record('later',200)+'\n');}return result;};
 const first=await syncRollouts(f.db,f.source,[],undefined,[p]);assert.equal(first.deferred_files,1);assert.equal(first.added_records,0);assert.equal(f.db.records().length,0);assert.equal(f.db.checkpoint(p),undefined);
 await syncRollouts(f.db,f.source,[],undefined,[p]);assert.equal(f.db.records().length,2);
 }finally{f.close();}
});
test('R1 default capacity is unknown and explicit experiment retains strict reason',()=>{
 const range=period('report','UTC','2026-10-01','2026-10-02','2026-10-03T00:00:00.000Z');
 const quota=(timestamp:string,used_percent:number):Quota=>({id:timestamp,timestamp,used_percent,source:'app_server',slot:'primary',limit_id:'codex',window_duration_mins:10080,resets_at:Date.parse('2026-10-07T00:00:00Z')/1000,raw_json:'{}'});
 const row=parseLine(line('token_usage_record',{response_id:'q',usage:tokens(100)},'2026-10-02T01:30:00.000Z'),initialState()).usage[0];
 const qs=[quota('2026-10-02T01:00:00.000Z',10),quota('2026-10-02T02:00:00.000Z',20)];
 const normal=dailyReport([row],qs,[],range,'2026-10-03T00:00:00.000Z');assert.equal(normal.plan_cycles[0].estimated_tokens,null);assert.equal(normal.plan_cycles[0].strict_reason,'unknown_account_identity');
 const experiment=dailyReport([row],qs,[],range,'2026-10-03T00:00:00.000Z',{experimentalEmpirical:true});assert.equal(experiment.plan_cycles[0].estimated_tokens,null);assert.equal(experiment.plan_cycles[0].strict_reason,'unknown_account_identity');
});
test('R1 reparse keeps provider record ahead of its compaction recovery copy',async()=>{
 const f=fixture();try{const p=join(f.source,'copy.jsonl');const usage={response_id:'same',usage:tokens(100)};const ls=[meta('same'),settings('same','a',{service_tier:'fast'}),line('token_usage_record',usage),line('compacted',{compaction_response_id:'same',latest_token_usage_record:usage})];writeFileSync(p,ls.join('\n')+'\n');await syncRollouts(f.db,f.source,[],undefined,[p]);
 writeFileSync(p,ls.join('\n').replace(settings('same','a',{service_tier:'fast'}),settings('same','b'))+'\n');await syncRollouts(f.db,f.source,[],undefined,[p]);
 const r=f.db.records()[0];assert.equal(r.source,'token_usage_record');assert.equal(r.data_quality,'provider_reported');assert.equal(r.model,'b');assert.equal(r.service_tier,'unknown');
 }finally{f.close();}
});
test('R1 rewriting a pending legacy file preserves removed facts without splicing chains',async()=>{
 const f=fixture();try{const p=join(f.source,'pending.jsonl');writeFileSync(p,[meta('child','absent'),legacy(tokens(100,20)),legacy(tokens(2,1),tokens(102,21))].join('\n')+'\n');await syncRollouts(f.db,f.source,[],undefined,[p]);assert.equal(f.db.records().length,0);
 writeFileSync(p,[meta('child','absent'),legacy(tokens(5,1))].join('\n')+'\n');await syncRollouts(f.db,f.source,[],undefined,[p]);
 assert.equal(f.db.records().length,0);assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM legacy_candidates').get()!.n,1);assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM legacy_candidate_history').get()!.n,2);
 const s=f.db.get<{pending_tokens:number;source_unavailable_candidate_tokens:number}>('legacy_reconciliation')!;assert.equal(s.pending_tokens,6);assert.equal(s.source_unavailable_candidate_tokens,123);
 }finally{f.close();}
});
for(const order of ['parent-first','delayed-parent-tail'])test(`R1 explicit fork boundary excludes coincidentally equal future parent usage: ${order}`,async()=>{
 const f=fixture();try{const p=join(f.source,'parent.jsonl'),c=join(f.source,'child.jsonl');const a=legacy(tokens(100,20)),b=legacy(tokens(2,1),tokens(102,21));const ordinal=(l:string,n:number)=>JSON.stringify({...JSON.parse(l),ordinal:n});
 writeFileSync(p,[meta('parent'),ordinal(a,10),...(order==='parent-first'?[ordinal(b,30)]:[])].join('\n')+'\n');
 writeFileSync(c,[meta('child','parent',{forked_from_ordinal_exclusive:20}),ordinal(a,10),ordinal(b,20)].join('\n')+'\n');
 await syncRollouts(f.db,f.source,[],undefined,order==='parent-first'?[p,c]:[c,p]);
 if(order!=='parent-first'){appendFileSync(p,ordinal(b,30)+'\n');await syncRollouts(f.db,f.source,[],undefined,[p]);}
 assert.equal(f.db.records().reduce((n,r)=>n+r.total_tokens,0),126);assert.equal(f.db.records().filter(r=>r.thread_id==='child').reduce((n,r)=>n+r.total_tokens,0),3);
 }finally{f.close();}
});
test('R1 restored mtime cannot hide a same-size in-place rewrite',async()=>{
 const f=fixture();try{const {statSync,utimesSync}=await import('node:fs');const p=join(f.source,'mtime.jsonl');const original=[meta('same'),settings('same','a',{service_tier:'fast'}),record('same-response',100)].join('\n')+'\n';writeFileSync(p,original);await syncRollouts(f.db,f.source,[],undefined,[p]);const before=statSync(p);
 writeFileSync(p,original.replace(settings('same','a',{service_tier:'fast'}),settings('same','b',{service_tier:'flex'})));utimesSync(p,before.atime,before.mtime);
 await syncRollouts(f.db,f.source,[],undefined,[p]);assert.equal(f.db.records()[0].model,'b');assert.equal(f.db.records()[0].service_tier,'flex');
 }finally{f.close();}
});
