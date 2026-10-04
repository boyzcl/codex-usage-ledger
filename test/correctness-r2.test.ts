import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/store.js';
import {syncRollouts} from '../src/ingest.js';
import {initialState,parseLine} from '../src/parser.js';
import {repairPreview,reconcileCapturedSource} from '../src/repair.js';
import {backup} from '../src/sqlite.js';
import {exportData} from '../src/export.js';
import {capacityView} from '../src/capacity-policy.js';
import {tokenFields} from '../src/types.js';
const t='2026-10-03T10:00:00.000Z',later='2026-10-03T10:02:00.000Z';
const line=(type:string,payload:unknown,time=t,ordinal?:number)=>JSON.stringify({type,payload,timestamp:time,...(ordinal===undefined?{}:{ordinal})});
const meta=(id:string,parent?:string,created='2026-10-03T00:00:00.000Z',boundary?:number)=>line('session_meta',{id,timestamp:created,forked_from_id:parent,forked_from_ordinal_exclusive:boundary});
const settings=(thread:string,model:string)=>line('event_msg',{type:'thread_settings_applied',thread_id:thread,thread_settings:{model}});
const use=(n:number,cached=0)=>({input_tokens:n,cached_input_tokens:cached,output_tokens:0,total_tokens:n});
const record=(id:string,n:number,extra={},time=t)=>line('token_usage_record',{response_id:id,usage:use(n),...extra},time);
const count=(n:number,total=n,time=t,ordinal?:number)=>line('event_msg',{type:'token_count',info:{last_token_usage:use(n),total_token_usage:use(total)}},time,ordinal);
const started=(turn_id?:string,time=t)=>line('event_msg',{type:'task_started',turn_id},time);
function rows(ls:string[]){const s=initialState();return ls.flatMap(l=>parseLine(l,s).usage);}
function f(){const dir=mkdtempSync(join(tmpdir(),'cux-r2-')),home=join(dir,'source');mkdirSync(join(home,'sessions'),{recursive:true});const path=join(dir,'input.db'),db=new Ledger(path);return {dir,home,path,db,file(name:string,ls:string[]){const p=join(home,'sessions','rollout-'+name+'.jsonl');writeFileSync(p,ls.join('\n')+'\n');return p;},close(){db.close();rmSync(dir,{recursive:true,force:true});}};}
const projection=(db:Ledger)=>db.records().map(r=>Object.fromEntries(['id',...tokenFields,'thread_id','model','service_tier','reasoning_effort','source','inherited','api_equivalent_usd','credit_equivalent','allowance_weight','api_rule_id','credit_rule_id','allowance_rule_id'].map(k=>[k,r[k as keyof typeof r]]))).sort((a,b)=>String(a.id).localeCompare(String(b.id)));

test('R2 original parent survives inherited child rewrite; fresh and repaired projections agree',{skip:typeof backup!=='function'?'requires sqlite.backup':false},async()=>{
 const a=f();try{
 const parent=a.file('parent',[meta('parent'),settings('parent','parent-model'),record('same',100)]),child=a.file('child',[meta('child','parent'),settings('child','initial-model')]);
 await syncRollouts(a.db,a.home,[],undefined,[parent,child]);
 writeFileSync(child,[meta('child','parent'),settings('child','other-model'),record('same',100,{thread_id:'parent'})].join('\n')+'\n');
 await syncRollouts(a.db,a.home,[],undefined,[child]);await syncRollouts(a.db,a.home,[],undefined,[child,parent]);
 const original=a.db.records()[0];assert.equal(original.model,'parent-model');assert.equal(original.inherited,false);
 const expected=projection(a.db);
 const fresh=new Ledger(join(a.dir,'fresh.db'));await syncRollouts(fresh,a.home,[],undefined,[child,parent]);assert.deepEqual(projection(fresh),expected);fresh.close();
 const p=await repairPreview(a.path,a.home,join(a.dir,'repair'));const repaired=new Ledger(p.files.repaired);assert.deepEqual(projection(repaired),expected);repaired.close();
 }finally{a.close();}
});
for(const boundary of [undefined,5])for(const order of ['parent-first','child-first'])test(`R2 inherited prefix advances matching; boundary=${boundary??'none'} ${order}`,async()=>{
 const a=f();try{
 const parent=a.file('parent',[meta('parent'),count(120,120,t,0)]),child=a.file('child',[meta('child','parent','2026-10-03T10:01:00.000Z',boundary),count(120,120,t,0),count(3,123,later,6),count(4,127,'2026-10-03T10:03:00.000Z',7)]);
 for(const p of order==='parent-first'?[parent,child]:[child,parent])await syncRollouts(a.db,a.home,[],undefined,[p]);
 assert.equal(a.db.records().reduce((n,r)=>n+r.total_tokens,0),127);assert.equal(a.db.get<{pending_tokens:number}>('legacy_reconciliation')!.pending_tokens,0);
 const expected=projection(a.db);await syncRollouts(a.db,a.home,[],undefined,[child,parent]);assert.deepEqual(projection(a.db),expected);
 }finally{a.close();}
});
test('R2 null-turn specific exact pairing agrees between fresh/repair/repeat; later unknown segment stays visible',{skip:typeof backup!=='function'?'requires sqlite.backup':false},async()=>{
 const a=f();try{
 const oldLines=[meta('same'),count(100)];a.db.insertUsage(rows(oldLines)[0]);
 a.file('same',[...oldLines,record('exact',100),started(undefined,later),count(7,107,later)]);
 const fresh=new Ledger(join(a.dir,'fresh.db'));await syncRollouts(fresh,a.home,[]);assert.equal(fresh.records().reduce((n,r)=>n+r.total_tokens,0),107);const expected=projection(fresh);fresh.close();
 const p=await repairPreview(a.path,a.home,join(a.dir,'repair'));assert.equal(p.after.tokens,107);const repaired=new Ledger(p.files.repaired);assert.deepEqual(projection(repaired),expected);repaired.close();
 const again=await repairPreview(p.files.repaired,a.home,join(a.dir,'repeat'));assert.equal(again.after.tokens,107);assert.equal(again.new_records,0);
 }finally{a.close();}
});
test('R2 retained known-turn exact supports only its own turn after rewrite',async()=>{
 const a=f();try{
 const path=a.file('same',[meta('same'),started('old'),record('exact',100)]);await syncRollouts(a.db,a.home,[]);
 writeFileSync(path,[meta('same'),started('old'),count(100),started('new',later),count(7,107,later)].join('\n')+'\n');await syncRollouts(a.db,a.home,[]);
 assert.equal(a.db.records().reduce((n,r)=>n+r.total_tokens,0),107);assert.equal(a.db.records().filter(r=>r.source==='legacy_token_count').length,1);
 }finally{a.close();}
});
test('R2 exact with known different turn does not erase unknown legacy',async()=>{
 const a=f();try{a.file('same',[meta('same'),count(100),record('different',100,{turn_id:'different'}),started(undefined,later),count(7,107,later)]);await syncRollouts(a.db,a.home,[]);assert.equal(a.db.records().reduce((n,r)=>n+r.total_tokens,0),207);}finally{a.close();}
});
test('R2 repaired legacy fact conflict allows legal append and two continuous syncs',{skip:typeof backup!=='function'?'requires sqlite.backup':false},async()=>{
 const a=f();try{
 const source=[meta('same'),count(100)],old={...rows(source)[0],...use(99),uncached_input_tokens:99};a.db.insertUsage(old);const path=a.file('same',source);
 const p=await repairPreview(a.path,a.home,join(a.dir,'repair'));const repaired=new Ledger(p.files.repaired);
 try{appendFileSync(path,count(2,102,later)+'\n');await assert.doesNotReject(syncRollouts(repaired,a.home,[]));const expected=projection(repaired);await assert.doesNotReject(syncRollouts(repaired,a.home,[]));assert.deepEqual(projection(repaired),expected);assert.equal(repaired.records().reduce((n,r)=>n+r.total_tokens,0),2);
 const variants=repaired.db.prepare('SELECT raw_json FROM usage_conflicts WHERE id=?').all(old.id).map(r=>JSON.parse(r.raw_json as string).total_tokens).sort((x,y)=>x-y);assert.deepEqual(variants,[99,100]);assert.equal(repaired.db.prepare("SELECT COUNT(*) n FROM legacy_candidates WHERE json_extract(raw_json,'$.id')=?").get(old.id)!.n,0);
 assert.equal(repaired.checkpoint(path).offset,repaired.checkpoint(path).size);
 }finally{repaired.close();}
 }finally{a.close();}
});
test('R2 ordinary append isolates equal-total cached-split conflict without blocking other response',async()=>{
 const a=f();try{
 const first=record('conflict',100,{usage:use(100,10)}),path=a.file('same',[meta('same'),first]);await syncRollouts(a.db,a.home,[]);
 appendFileSync(path,record('conflict',100,{usage:use(100,20)})+'\n'+record('good',2,{},later)+'\n');await syncRollouts(a.db,a.home,[]);assert.equal(a.db.records().reduce((n,r)=>n+r.total_tokens,0),2);
 const variants=a.db.db.prepare('SELECT raw_json FROM usage_conflicts WHERE id=?').all('response:conflict').map(r=>JSON.parse(r.raw_json as string).cached_input_tokens).sort((x,y)=>x-y);assert.deepEqual(variants,[10,20]);await syncRollouts(a.db,a.home,[]);assert.equal(a.db.records().length,1);
 }finally{a.close();}
});

test('R2 unknown exact cannot substitute equal counters across task boundaries',async()=>{
 const a=f();try{a.file('same',[meta('same'),count(100),started(),record('unrelated',100),started(undefined,later),count(7,107,later)]);await syncRollouts(a.db,a.home,[]);assert.equal(a.db.records().reduce((n,r)=>n+r.total_tokens,0),207);}finally{a.close();}
});
test('R2 unknown specific pairing is consumed once, not reused on both sides',async()=>{
 const a=f();try{a.file('same',[meta('same'),count(100),record('one',100),count(100,200)]);await syncRollouts(a.db,a.home,[]);assert.equal(a.db.records().reduce((n,r)=>n+r.total_tokens,0),200);assert.equal(a.db.db.prepare('SELECT COUNT(*) n FROM exact_legacy_links').get()!.n,1);}finally{a.close();}
});
test('R2 conflict evidence and checkpoint roll back together on interruption; retry advances',async()=>{
 const a=f();try{const path=a.file('same',[meta('same'),record('bad',100)]);await syncRollouts(a.db,a.home,[]);const prior=a.db.checkpoint(path);
 appendFileSync(path,record('bad',99)+'\n'+record('legal',2,{},later)+'\n');const save=a.db.saveCheckpoint.bind(a.db);a.db.saveCheckpoint=()=>{throw Error('injected_before_checkpoint');};
 await assert.rejects(syncRollouts(a.db,a.home,[]),/injected_before_checkpoint/);assert.equal(a.db.records()[0].total_tokens,100);assert.equal(a.db.db.prepare('SELECT COUNT(*) n FROM usage_conflicts').get()!.n,0);assert.deepEqual(a.db.checkpoint(path),prior);
 a.db.saveCheckpoint=save;await syncRollouts(a.db,a.home,[]);await syncRollouts(a.db,a.home,[]);assert.equal(a.db.records()[0].total_tokens,2);assert.equal(a.db.db.prepare('SELECT COUNT(*) n FROM usage_conflicts').get()!.n,2);
 }finally{a.close();}
});
test('R2 same-source complete legacy context rewrite is a bounded correction',async()=>{
 const a=f();try{const path=a.file('same',[meta('same'),settings('same','before'),count(100)]);await syncRollouts(a.db,a.home,[]);writeFileSync(path,[meta('same'),settings('same','after'),count(100)].join('\n')+'\n');await syncRollouts(a.db,a.home,[]);assert.equal(a.db.records()[0].model,'after');assert.equal(a.db.db.prepare('SELECT COUNT(*) n FROM usage_conflicts').get()!.n,0);}finally{a.close();}
});
test('R2 equally trusted attribution disagreement is isolated independent of arrival order',async()=>{
 for(const models of [['a','b'],['b','a']]){const a=f();try{a.file('same',[meta('same'),record('same',100,{model:models[0]}),record('same',100,{model:models[1]})]);await syncRollouts(a.db,a.home,[]);assert.equal(a.db.records().length,0);assert.deepEqual(a.db.db.prepare('SELECT reason FROM usage_conflicts').all().map(r=>r.reason),['attribution_conflict','attribution_conflict']);}finally{a.close();}}
});
test('R2 repair preserves existing derived history and conflicts export both original priced variants',{skip:typeof backup!=='function'?'requires sqlite.backup':false},async()=>{
 const a=f();try{const old={...rows([meta('same'),record('bad',99)])[0],api_rule_id:'historic-reference',api_equivalent_usd:0.12};a.db.insertUsage(old);a.file('same',[meta('same'),record('bad',100)]);
 const raw={status:'ok',estimated_capacity:1000,lower_bound:900,upper_bound:1100,equivalents:{tokens:1000},reason:null};a.db.db.prepare('INSERT INTO capacity_estimates VALUES (?,?,?)').run('historic',t,JSON.stringify(raw));a.db.set('latest_estimates',[raw]);
 const range={from:'0000',to_exclusive:'9999',timezone:'UTC'},out=join(a.dir,'estimates.jsonl');await exportData(a.db,'estimates',range,out);const exported=JSON.parse(readFileSync(out,'utf8').trim().split('\n')[1]).data.raw;assert.equal(exported.status,'unverified');assert.equal(exported.estimated_capacity,null);assert.ok(exported.source);assert.ok(exported.limitations.length);
 const p=await repairPreview(a.path,a.home,join(a.dir,'repair')),repaired=new Ledger(p.files.repaired);try{
 assert.deepEqual(JSON.parse(repaired.db.prepare("SELECT raw_json FROM capacity_estimate_history WHERE cycle_id='historic'").get()!.raw_json as string),raw);
 const conflicts=join(a.dir,'conflicts.jsonl');await exportData(repaired,'conflicts',range,conflicts);const variants=readFileSync(conflicts,'utf8').trim().split('\n').slice(1).map(l=>JSON.parse(l).data);assert.equal(variants.length,2);assert.equal(variants.find(v=>v.raw.total_tokens===99).raw.api_rule_id,'historic-reference');assert.equal(variants.find(v=>v.raw.total_tokens===99).raw.api_equivalent_usd,0.12);assert.ok(variants.every(v=>v.quantity===null&&v.confirmed===false));
 const history=join(a.dir,'history.jsonl');await exportData(repaired,'estimate-history',range,history);assert.ok(readFileSync(history,'utf8').includes('historical_unverified'));
 }finally{repaired.close();}
 const experimental=capacityView(raw,true);assert.equal(experimental.status,'experimental_unverified');assert.equal(experimental.estimated_capacity,1000);
 }finally{a.close();}
});

test('R2 original owner resolves copied attribution disputes in every order, repeat and repair-forward',{skip:typeof backup!=='function'?'requires sqlite.backup':false},async()=>{
 let expected:unknown;
 for(const order of [[0,1,2],[1,2,0],[2,0,1],[1,0,2]]){const a=f();try{
 a.db.savePrices(['real','copy-a','copy-b'].flatMap((model,i)=>(['api','credit','allowance'] as const).map(kind=>({id:(kind==='api'?'rule-':kind+'-')+model,kind,model,processing_mode:'standard',effective_from:'2026-01-01T00:00:00Z',effective_to:null,context_min:0,context_max:null,rates:{input:i+1,cached_input:i+1,cache_write:i+1,output:i+1},source_url:'https://example.com/synthetic',retrieved_at:t,basis:'synthetic'}))));
 const standard=(thread_id:string,model:string)=>line('event_msg',{type:'thread_settings_applied',thread_id,thread_settings:{model,service_tier:'default'}});
 const files=[a.file('parent',[meta('parent'),standard('parent','real'),record('shared',100)]),a.file('c1',[meta('c1','parent'),standard('c1','copy-a'),record('shared',100,{thread_id:'parent'})]),a.file('c2',[meta('c2','parent'),standard('c2','copy-b'),record('shared',100,{thread_id:'parent'})])];
 for(const i of order)await syncRollouts(a.db,a.home,a.db.rules(),undefined,[files[i]]);
 await syncRollouts(a.db,a.home,a.db.rules());assert.equal(a.db.records()[0].model,'real');assert.equal(a.db.records()[0].api_equivalent_usd,0.0001);assert.equal(a.db.records()[0].api_rule_id,'rule-real');assert.equal(a.db.records()[0].credit_equivalent,0.0001);assert.equal(a.db.records()[0].credit_rule_id,'credit-real');assert.equal(a.db.records()[0].allowance_weight,0.0001);assert.equal(a.db.records()[0].allowance_rule_id,'allowance-real');assert.equal(a.db.get<any>('legacy_reconciliation').conflict_records,0);
 const state=()=>({projection:projection(a.db),states:a.db.db.prepare('SELECT * FROM usage_conflict_state ORDER BY id').all(),variants:a.db.db.prepare('SELECT id,variant,reason FROM usage_conflicts ORDER BY id,variant').all()});
 const selected=state();if(!expected)expected=selected;else assert.deepEqual(selected,expected);
 const p=await repairPreview(a.path,a.home,join(a.dir,'repair')),repaired=new Ledger(p.files.repaired);try{
 assert.deepEqual(projection(repaired),projection(a.db));assert.equal(repaired.db.prepare("SELECT COUNT(*) n FROM usage_conflict_state WHERE status='open'").get()!.n,0);
 appendFileSync(files[0],record('legal-owner',2,{},later)+'\n');await syncRollouts(repaired,a.home,[]);await syncRollouts(repaired,a.home,[]);assert.equal(repaired.records().reduce((n,r)=>n+r.total_tokens,0),102);assert.equal(repaired.records().find(r=>r.response_id==='shared')!.model,'real');
 }finally{repaired.close();}
 }finally{a.close();}}
});
test('R2 same-source unknown pair time rewrite uses active candidates and preserves historical links',async()=>{
 const a=f();try{const path=a.file('same',[meta('same'),count(100),record('r',100)]);await syncRollouts(a.db,a.home,[]);assert.equal(a.db.records().reduce((n,r)=>n+r.total_tokens,0),100);
 writeFileSync(path,[meta('same'),count(100,100,later),record('r',100,{},later)].join('\n')+'\n');await syncRollouts(a.db,a.home,[]);assert.equal(a.db.records().reduce((n,r)=>n+r.total_tokens,0),100);assert.equal(a.db.db.prepare('SELECT COUNT(*) n FROM exact_legacy_links').get()!.n,2);
 const fresh=new Ledger(join(a.dir,'fresh.db'));try{await syncRollouts(fresh,a.home,[]);assert.deepEqual(projection(a.db),projection(fresh));}finally{fresh.close();}
 await syncRollouts(a.db,a.home,[]);assert.equal(a.db.records().length,1);
 if(typeof backup==='function'){const p=await repairPreview(a.path,a.home,join(a.dir,'repair'));assert.equal(p.after.tokens,100);const again=await repairPreview(p.files.repaired,a.home,join(a.dir,'again'));assert.equal(again.after.tokens,100);}
 }finally{a.close();}
});

test('R2 captured old copied-conflict and historical-link evidence adjudicate like corrected fresh source',async()=>{
 const a=f();try{
 const source=[a.file('parent',[meta('parent'),settings('parent','real'),record('shared',100)]),a.file('c1',[meta('c1','parent'),settings('c1','copy-a'),record('shared',100,{thread_id:'parent'})]),a.file('c2',[meta('c2','parent'),settings('c2','copy-b'),record('shared',100,{thread_id:'parent'})])];
 await syncRollouts(a.db,a.home,[],undefined,source);
 // Model the old capture: all variants exist, but the owner was locked out and reason mislabeled.
 const variants=a.db.db.prepare('SELECT raw_json FROM usage_conflicts').all().map(v=>JSON.parse(v.raw_json as string));a.db.quarantine(variants,'token_fact_conflict');
 const path=a.file('null',[meta('null'),count(100),record('r',100)]);await syncRollouts(a.db,a.home,[],undefined,[path]);writeFileSync(path,[meta('null'),count(100,100,later),record('r',100,{},later)].join('\n')+'\n');await syncRollouts(a.db,a.home,[],undefined,[path]);
 // Model the historical uniqueness defect's wrong visible legacy.
 const active=a.db.db.prepare("SELECT raw_json FROM legacy_candidates WHERE thread_id='null'").get()!;const legacy=JSON.parse(active.raw_json as string);a.db.db.prepare('INSERT OR REPLACE INTO usage_records VALUES (?,?,?,?,?,?,?,?,?,?)').run(legacy.id,legacy.response_id,legacy.thread_id,legacy.session_id,legacy.turn_id,legacy.timestamp,legacy.model,legacy.source,legacy.total_tokens,JSON.stringify(legacy));
 await reconcileCapturedSource(a.db,a.home);const fresh=new Ledger(join(a.dir,'fresh.db'));try{await syncRollouts(fresh,a.home,[]);assert.deepEqual(projection(a.db),projection(fresh));assert.deepEqual(a.db.db.prepare('SELECT * FROM usage_conflict_state ORDER BY id').all(),fresh.db.prepare('SELECT * FROM usage_conflict_state ORDER BY id').all());assert.deepEqual(a.db.db.prepare('SELECT id,variant,reason FROM usage_conflicts ORDER BY id,variant').all(),fresh.db.prepare('SELECT id,variant,reason FROM usage_conflicts ORDER BY id,variant').all());}finally{fresh.close();}
 }finally{a.close();}
});

test('R2 captured quarantined legacy sequence restores indexes through necessary source re-read',async()=>{
 const a=f();try{a.file('same',[meta('same'),count(100),count(2,102,later)]);await syncRollouts(a.db,a.home,[]);const original=a.db.records()[0],wrong={...original,input_tokens:99,total_tokens:99,uncached_input_tokens:99};a.db.quarantine([original,wrong]);assert.equal(a.db.db.prepare('SELECT MIN(event_index) n FROM legacy_candidates').get()!.n,2);
 const normalized=await reconcileCapturedSource(a.db,a.home);assert.equal(normalized.required_source_files,1);
 const fresh=new Ledger(join(a.dir,'fresh.db'));try{fresh.insertUsage(wrong);await syncRollouts(fresh,a.home,[]);assert.deepEqual(projection(a.db),projection(fresh));assert.deepEqual(a.db.db.prepare('SELECT thread_id,event_index,disposition FROM legacy_candidates').all(),fresh.db.prepare('SELECT thread_id,event_index,disposition FROM legacy_candidates').all());assert.deepEqual(a.db.db.prepare('SELECT * FROM usage_conflict_state').all(),fresh.db.prepare('SELECT * FROM usage_conflict_state').all());}finally{fresh.close();}
 }finally{a.close();}
});

test('R2 retained original owner still adjudicates current copied disputes in repair',{skip:typeof backup!=='function'?'requires sqlite.backup':false},async()=>{
 const a=f();try{a.db.insertUsage(rows([meta('parent'),settings('parent','real'),record('shared',100)])[0]);a.file('c1',[meta('c1','parent'),settings('c1','copy-a'),record('shared',100,{thread_id:'parent'})]);a.file('c2',[meta('c2','parent'),settings('c2','copy-b'),record('shared',100,{thread_id:'parent'})]);const p=await repairPreview(a.path,a.home,join(a.dir,'repair'));assert.equal(p.after.tokens,100);const db=new Ledger(p.files.repaired);try{assert.equal(db.records()[0].model,'real');assert.equal(db.get<any>('legacy_reconciliation').conflict_records,0);assert.ok(db.db.prepare('SELECT reason FROM usage_conflicts').all().every(v=>v.reason==='attribution_conflict'));}finally{db.close();}
 }finally{a.close();}
});
