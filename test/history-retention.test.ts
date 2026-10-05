import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/store.js';
import {syncRollouts} from '../src/ingest.js';
import {initialState,parseLine} from '../src/parser.js';
import {priceUsage} from '../src/pricing.js';
import type {Usage,PriceRule} from '../src/types.js';
const at='2026-10-03T13:00:00.000Z',later='2026-10-03T13:00:01.000Z';
const line=(type:string,payload:unknown,time=at)=>JSON.stringify({type,payload,timestamp:time});
const meta=(id:string,parent?:string)=>line('session_meta',{id,timestamp:'2026-10-03T00:00:00.000Z',forked_from_id:parent});
const settings=(id:string)=>line('event_msg',{type:'thread_settings_applied',thread_id:id,thread_settings:{model:'m',service_tier:'default'}});
const start=(turn:string)=>line('event_msg',{type:'task_started',turn_id:turn});
const use=(n:number)=>({input_tokens:n,output_tokens:0,total_tokens:n});
const count=(n:number,time=at)=>line('event_msg',{type:'token_count',info:{total_token_usage:use(n),last_token_usage:use(n)}},time);
const rules:PriceRule[]=[{id:'synthetic-old-price',kind:'api',model:'m',processing_mode:'standard',effective_from:'2026-10-03T00:00:00Z',effective_to:null,context_min:0,context_max:null,rates:{input:2,cached_input:.2,cache_write:3,output:10},source_url:'https://example.com/synthetic',retrieved_at:at,basis:'synthetic test'}];
const parsed=(lines:string[])=>{const state=initialState();return lines.flatMap(l=>parseLine(l,state).usage).map(r=>priceUsage(r,rules));};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cux-history-')),home=join(dir,'source');mkdirSync(join(home,'sessions'),{recursive:true});const db=new Ledger(join(dir,'tiny.db'));db.savePrices(rules);return {db,home,file(name:string,lines:string[]){const path=join(home,'sessions','rollout-'+name+'.jsonl');writeFileSync(path,lines.join('\n')+'\n');return path;},reparse(path:string){db.db.prepare('UPDATE ingest_files SET device=? WHERE path=?').run('synthetic-other-device',path);},close(){db.close();rmSync(dir,{recursive:true,force:true});}};}
function retained(db:Ledger,row:Usage){const old={...row,repair_status:'source_unavailable' as const};db.insertUsage(old,'retain');db.db.prepare('INSERT INTO repair_evidence VALUES (?,?,?,?)').run(old.id,3,'retained_source_unavailable',JSON.stringify({before:row,after:old,version:3}));return old;}
test('history first raw and original quote survive same facts, attribution enrichment and repeated replay without adding usage',()=>{
 const f=fixture();try{
  const old=parsed([meta('thread'),settings('thread'),start('turn'),count(100)])[0];delete old.origin_thread_id;
  f.db.insertUsage(old);f.db.saveLegacy(old,1);const raw=JSON.stringify(old);f.db.db.prepare('INSERT INTO legacy_candidate_history VALUES (?,?,?)').run(old.id,raw,'source_unavailable');
  for(let i=0;i<2;i++){f.db.beginLegacyReplay('thread');f.db.saveLegacy({...old,origin_thread_id:'thread',origin_source:'synthetic-source',model_source:'response',attribution_quality:'explicit'},1);f.db.reconcileLegacy(['thread'],'reparse');}
  assert.equal(f.db.db.prepare('SELECT raw_json FROM legacy_candidate_history WHERE id=?').get(old.id)!.raw_json,raw);assert.equal(f.db.records().length,1);assert.equal(f.db.records()[0].total_tokens,100);assert.equal(f.db.records()[0].api_rule_id,old.api_rule_id);assert.equal(f.db.records()[0].api_equivalent_usd,old.api_equivalent_usd);
  f.db.legacySummary();assert.equal(f.db.get<{source_unavailable_candidate_tokens:number}>('legacy_reconciliation')!.source_unavailable_candidate_tokens,0);
 }finally{f.close();}
});
test('history true Token conflict still quarantines both variants and preserves the archived original',()=>{
 const f=fixture();try{
  const old=parsed([meta('thread'),settings('thread'),count(100)])[0],raw=JSON.stringify(old);f.db.insertUsage(old);f.db.db.prepare('INSERT INTO legacy_candidate_history VALUES (?,?,?)').run(old.id,raw,'source_unavailable');
  f.db.saveLegacy({...old,input_tokens:99,uncached_input_tokens:99,total_tokens:99},1);assert.equal(f.db.records().length,0);assert.equal(f.db.db.prepare('SELECT reason FROM usage_conflict_state WHERE id=?').get(old.id)!.reason,'token_fact_conflict');assert.equal(f.db.db.prepare('SELECT raw_json FROM legacy_candidate_history WHERE id=?').get(old.id)!.raw_json,raw);assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM usage_conflicts WHERE id=?').get(old.id)!.n,2);
 }finally{f.close();}
});
test('retained after survives ordinary sync, pending candidate, same-thread path slot replacement and repeated forced reparses',async()=>{
 const f=fixture();try{
  const firstLines=[meta('child','missing-parent'),settings('child'),start('old-turn'),count(100)],old=retained(f.db,parsed(firstLines)[0]);
  const first=f.file('first',firstLines);await syncRollouts(f.db,f.home,rules,undefined,[first]);assert.equal(f.db.records().find(r=>r.id===old.id)?.repair_status,'source_unavailable');
  appendFileSync(first,count(107,'2026-10-03T13:00:02.000Z')+'\n');await syncRollouts(f.db,f.home,rules,undefined,[first]);assert.equal(f.db.records().length,1);assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM legacy_candidates').get()!.n,2);
  const candidate=f.db.db.prepare("SELECT raw_json FROM legacy_candidates WHERE json_extract(raw_json,'$.id')=?").get(old.id)!.raw_json;
  const second=f.file('second',[meta('child','missing-parent'),settings('child'),start('other-turn'),count(7,later)]);await syncRollouts(f.db,f.home,rules,undefined,[second]);
  assert.equal(f.db.db.prepare('SELECT raw_json FROM legacy_candidate_history WHERE id=?').get(old.id)!.raw_json,candidate);
  for(const paths of [[first,second],[second,first]]){for(const path of paths){f.reparse(path);await syncRollouts(f.db,f.home,rules,undefined,[path]);}}
  assert.equal(f.db.records().length,1);assert.equal(f.db.records()[0].id,old.id);assert.equal(f.db.records()[0].total_tokens,100);assert.equal(f.db.records()[0].api_rule_id,old.api_rule_id);assert.equal(f.db.records()[0].api_equivalent_usd,old.api_equivalent_usd);
  assert.deepEqual(JSON.parse(f.db.db.prepare('SELECT raw_json FROM repair_evidence WHERE id=?').get(old.id)!.raw_json as string).after,old);
 }finally{f.close();}
});
test('retained confirmation still leaves usage on a true Token conflict while original after and both facts remain',()=>{
 const f=fixture();try{
  const old=retained(f.db,parsed([meta('child','missing-parent'),settings('child'),count(100)])[0]);
  f.db.saveLegacy({...old,input_tokens:99,uncached_input_tokens:99,total_tokens:99},1);f.db.reconcileLegacy(['child']);
  assert.equal(f.db.records().length,0);assert.equal(f.db.db.prepare('SELECT reason FROM usage_conflict_state WHERE id=?').get(old.id)!.reason,'token_fact_conflict');assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM usage_conflicts WHERE id=?').get(old.id)!.n,2);
  assert.deepEqual(JSON.parse(f.db.db.prepare('SELECT raw_json FROM repair_evidence WHERE id=?').get(old.id)!.raw_json as string).after,old);
 }finally{f.close();}
});
test('retained legacy is still excluded by proven same-turn exact substitution',async()=>{
 const f=fixture();try{
  const ls=[meta('child','missing-parent'),settings('child'),start('turn'),count(100)],old=retained(f.db,parsed(ls)[0]),path=f.file('child',ls);await syncRollouts(f.db,f.home,rules,undefined,[path]);
  appendFileSync(path,line('token_usage_record',{response_id:'synthetic-exact',thread_id:'child',turn_id:'turn',usage:use(100)},later)+'\n');await syncRollouts(f.db,f.home,rules,undefined,[path]);
  assert.equal(f.db.records().length,1);assert.equal(f.db.records()[0].source,'token_usage_record');assert.equal(f.db.records().some(r=>r.id===old.id),false);assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM repair_evidence WHERE id=?').get(old.id)!.n,1);
 }finally{f.close();}
});
test('retained child is still excluded by proved inherited prefix with either parent arrival order',async()=>{
 for(const parentFirst of [true,false]){const f=fixture();try{
  const ls=[meta('child','parent'),settings('child'),start('turn'),count(100)],old=retained(f.db,parsed(ls)[0]);const child=f.file('child',ls),parent=f.file('parent',[meta('parent'),settings('parent'),start('parent-turn'),count(100)]);
  for(const path of parentFirst?[parent,child]:[child,parent])await syncRollouts(f.db,f.home,rules,undefined,[path]);
  assert.equal(f.db.records().reduce((n,r)=>n+r.total_tokens,0),100);assert.equal(f.db.records().some(r=>r.id===old.id),false);assert.equal(f.db.db.prepare("SELECT disposition FROM legacy_candidates WHERE json_extract(raw_json,'$.id')=?").get(old.id)!.disposition,'replayed');
 }finally{f.close();}}
});
