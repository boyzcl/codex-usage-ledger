import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/store.js';
import {backup} from '../src/sqlite.js';
import {initialState,parseLine} from '../src/parser.js';
import {repairPreview,consistentBackup} from '../src/repair.js';
import type {Usage,PriceRule} from '../src/types.js';
const timestamp='2026-10-03T10:00:00.000Z';
const line=(type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload});
const meta=(id:string,parent?:string)=>line('session_meta',{id,timestamp:'2026-10-03T00:00:00Z',forked_from_id:parent});
const usage=(id:string,n:number)=>line('token_usage_record',{response_id:id,usage:{input_tokens:n,output_tokens:0,total_tokens:n}});
const count=(input:number,output:number,totalInput=input,totalOutput=output)=>line('event_msg',{type:'token_count',info:{last_token_usage:{input_tokens:input,output_tokens:output,total_tokens:input+output},total_token_usage:{input_tokens:totalInput,output_tokens:totalOutput,total_tokens:totalInput+totalOutput}}});
const rows=(ls:string[])=>{const state=initialState();return ls.flatMap(l=>parseLine(l,state).usage);};
const rule:PriceRule={id:'pinned-old',kind:'api',model:'old',processing_mode:'fast',effective_from:'2026-01-01T00:00:00Z',effective_to:null,context_min:0,context_max:null,rates:{input:1,cached_input:1,cache_write:1,output:1},source_url:'https://example.com',retrieved_at:timestamp,basis:'synthetic'};
test('R1 repair backup, same-ID correction, inherited removal, missing source, repeat and rollback',{skip:typeof backup!=='function'?'requires sqlite.backup':false},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cux-repair-'));try{
  const home=join(dir,'source');mkdirSync(join(home,'sessions'),{recursive:true});const dbPath=join(dir,'old.db'),db=new Ledger(dbPath);
  const parent=[meta('parent'),count(100,20)],child=[meta('child','parent'),count(100,20),count(2,1,102,21)];
  const exact=[meta('exact'),line('event_msg',{type:'thread_settings_applied',thread_id:'exact',thread_settings:{model:'new'}}),usage('same-id',100)];
  const parsed=rows(exact)[0];const wrong:Usage={...parsed,model:'old',service_tier:'fast',reasoning_effort:'high',api_rule_id:rule.id,api_equivalent_usd:.0001};
  db.savePrices([rule]);for(const row of [...rows(parent),...rows(child),wrong,...rows([meta('missing'),usage('missing-source',99)])])db.insertUsage(row);
  const before=db.records();assert.equal(before.reduce((n,r)=>n+r.total_tokens,0),442);db.close();
  for(const [name,ls] of [['parent',parent],['child',child],['exact',exact]] as const)writeFileSync(join(home,'sessions','rollout-'+name+'.jsonl'),ls.join('\n')+'\n');
  const first=await repairPreview(dbPath,home,join(dir,'preview'),'UTC');assert.equal(first.changed_attribution_records,1);assert.equal(first.excluded_records,1);assert.equal(first.retained_source_unavailable_records,1);assert.equal(first.after.tokens,322);
  const repaired=new Ledger(first.files.repaired);const fixed=repaired.records().find(r=>r.response_id==='same-id')!;assert.equal(fixed.model,'new');assert.equal(fixed.service_tier,'unknown');assert.equal(fixed.reasoning_effort,null);assert.equal(fixed.api_equivalent_usd,null);assert.equal(fixed.total_tokens,100);
  assert.equal(repaired.records().find(r=>r.response_id==='missing-source')?.repair_status,'source_unavailable');const repairedRows=repaired.records();repaired.close();
  const original=new Ledger(dbPath);assert.deepEqual(original.records(),before);original.close();
  const second=await repairPreview(first.files.repaired,home,join(dir,'again'),'UTC');assert.equal(second.changed_attribution_records,0);assert.equal(second.excluded_records,0);assert.equal(second.new_records,0);assert.equal(second.after.tokens,322);
  const repeated=new Ledger(second.files.repaired);assert.deepEqual(repeated.records(),repairedRows);repeated.close();
  const restoredPath=join(dir,'rollback.db');await consistentBackup(first.files.baseline,restoredPath);const restored=new Ledger(restoredPath);assert.deepEqual(restored.records(),before);restored.close();
  await assert.rejects(consistentBackup(dbPath,restoredPath),/output_exists/);
  const race=await Promise.allSettled([consistentBackup(dbPath,join(dir,'concurrent.db')),consistentBackup(dbPath,join(dir,'concurrent.db'))]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.filter(r=>r.status==='rejected').length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('R1 repair preserves conflicting token facts and reports pending instead of overwriting',{skip:typeof backup!=='function'?'requires sqlite.backup':false},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cux-repair-conflict-'));try{const home=join(dir,'source');mkdirSync(join(home,'sessions'),{recursive:true});const dbPath=join(dir,'old.db'),db=new Ledger(dbPath);db.insertUsage(rows([meta('a'),usage('conflict',99)])[0]);db.close();writeFileSync(join(home,'sessions','rollout-a.jsonl'),[meta('a'),usage('conflict',100)].join('\n')+'\n');
 const preview=await repairPreview(dbPath,home,join(dir,'preview'));assert.equal(preview.token_conflicts,1);assert.equal(preview.after.tokens,99);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('R1 interrupted correction rolls back data and repair version, then fresh preview succeeds',{skip:typeof backup!=='function'?'requires sqlite.backup':false},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cux-repair-interrupt-'));const transaction=Ledger.prototype.transaction;
 try{const home=join(dir,'source');mkdirSync(join(home,'sessions'),{recursive:true});const dbPath=join(dir,'old.db'),db=new Ledger(dbPath);
 const source=[meta('same'),line('event_msg',{type:'thread_settings_applied',thread_id:'same',thread_settings:{model:'new'}}),usage('same-id',100)];const old={...rows(source)[0],model:'old'};db.insertUsage(old);db.close();writeFileSync(join(home,'sessions','rollout-same.jsonl'),source.join('\n')+'\n');
 Ledger.prototype.transaction=function<T>(fn:()=>T):T{return transaction.call(this,()=>{fn();throw Error('simulated_interruption');}) as T;};
 await assert.rejects(repairPreview(dbPath,home,join(dir,'failed')),/simulated_interruption/);Ledger.prototype.transaction=transaction;
 const failed=new Ledger(join(dir,'failed','repaired.db'));assert.deepEqual(failed.records(),[old]);assert.equal(failed.get('ledger_repair_version'),null);failed.close();
 const good=await repairPreview(dbPath,home,join(dir,'retry'));assert.equal(good.changed_attribution_records,1);
 }finally{Ledger.prototype.transaction=transaction;rmSync(dir,{recursive:true,force:true});}
});
test('R1 repair retains missing pending candidate facts through repeated rebuilding',{skip:typeof backup!=='function'?'requires sqlite.backup':false},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cux-repair-pending-'));try{const home=join(dir,'source');mkdirSync(join(home,'sessions'),{recursive:true});const dbPath=join(dir,'old.db'),db=new Ledger(dbPath);const path=join(home,'sessions','rollout-child.jsonl');writeFileSync(path,[meta('child','absent'),count(100,20)].join('\n')+'\n');
 const {syncRollouts}=await import('../src/ingest.js');await syncRollouts(db,home,[]);assert.equal(db.records().length,0);db.close();rmSync(path);
 const first=await repairPreview(dbPath,home,join(dir,'first'));assert.equal(first.retained_unavailable_candidate_records,1);assert.equal((first.legacy as {source_unavailable_candidate_tokens:number}).source_unavailable_candidate_tokens,120);assert.equal(first.after.tokens,0);
 const repeated=await repairPreview(first.files.repaired,home,join(dir,'repeat'));assert.equal(repeated.retained_unavailable_candidate_records,1);assert.equal((repeated.legacy as {source_unavailable_candidate_tokens:number}).source_unavailable_candidate_tokens,120);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
