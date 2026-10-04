import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/store.js';
import {priceUsage,validateCatalogue,catalogueId} from '../src/pricing.js';
import {revalue} from '../src/valuation.js';
import {exportData} from '../src/export.js';
import {report} from '../src/report.js';
import {initialState,parseLine} from '../src/parser.js';
import type {PriceRule,Usage} from '../src/types.js';
const boundary='2026-10-04T00:00:00.000Z',range={from:'2026-10-03T00:00:00.000Z',to_exclusive:'2026-10-05T00:00:00.000Z',timezone:'UTC'};
const rule=(extra:Partial<PriceRule>={}):PriceRule=>({id:'old',kind:'api',model:'m',processing_mode:'standard',effective_from:'2026-10-03T00:00:00Z',effective_to:null,context_min:0,context_max:null,rates:{input:2,cached_input:.2,cache_write:3,output:10},source_url:'https://example.com/synthetic',retrieved_at:boundary,basis:'synthetic',...extra});
const next=(old=rule(),extra:Partial<PriceRule>={}):PriceRule=>({...old,id:old.id+'-next',supersedes:old.id,effective_from:boundary,rates:{input:4,cached_input:.4,cache_write:6,output:20},...extra});
function usage(timestamp=boundary,id=timestamp):Usage {return {...parseLine(JSON.stringify({timestamp,type:'token_usage_record',payload:{response_id:id,model:'m',service_tier:'default',usage:{input_tokens:100,cached_input_tokens:40,cache_write_input_tokens:10,output_tokens:20,total_tokens:120}}}),initialState()).usage[0],project:'PRIVATE_PROJECT'};}
function temp(){const dir=mkdtempSync(join(tmpdir(),'cux-C-')),db=new Ledger(join(dir,'usage.db'));return {dir,db,close(){db.close();rmSync(dir,{recursive:true,force:true});}};}
test('C explicit successor quotes before/at/after exact boundary, with immutable originals and independent dimensions',()=>{
 const old=rule(),newer=next(old),last=next(newer,{id:'last',effective_from:'2026-10-05T00:00:00.000Z',rates:{input:8,cached_input:.8,cache_write:12,output:40}}),frozen=JSON.stringify(old);
 const credit=rule({id:'credit',kind:'credit'}),allowance=rule({id:'allowance',kind:'allowance'}),fast=rule({id:'fast',processing_mode:'fast'}),other=rule({id:'other',model:'other'}),long=rule({id:'long',context_min:201});
 const rules=validateCatalogue([{...old,context_max:200},{...newer,context_max:200},{...last,context_max:200},credit,allowance,fast,other,long]);
 for(const [time,id,multiplier] of [['2026-10-03T23:59:59.999Z','old',1],[boundary,'old-next',2],['2026-10-04T00:00:00.001Z','old-next',2],['2026-10-05T00:00:00.000Z','last',4]] as const){const priced=priceUsage(usage(time),rules);assert.equal(priced.api_rule_id,id);assert.ok(Math.abs(priced.api_equivalent_usd!-.000338*multiplier)<1e-12);assert.equal(priced.credit_rule_id,'credit');assert.equal(priced.allowance_rule_id,'allowance');}
 assert.equal(priceUsage({...usage(),service_tier:'fast'},rules).api_rule_id,'fast');assert.equal(priceUsage({...usage(),model:'other'},rules).api_rule_id,'other');assert.equal(JSON.stringify(old),frozen);
 assert.equal(priceUsage(usage(),[old]).api_equivalent_usd,.000338);assert.equal(priceUsage(usage(),[newer,old]).api_rule_id,newer.id);
 const ended=rule({effective_to:boundary});assert.equal(priceUsage(usage(),[ended]).api_equivalent_usd,null);
 for(const kind of ['credit','allowance'] as const){const oldKind=rule({id:kind,kind}),newKind=next(oldKind),priced=priceUsage(usage(),validateCatalogue([oldKind,newKind]));assert.equal(priced[kind==='credit'?'credit_rule_id':'allowance_rule_id'],newKind.id);}
 assert.equal(priceUsage(usage(),[credit,next(credit)]).allowance_weight,null);
});
test('C immutable atomic import accepts reordered equivalent facts, rejects broken chains and rolls back interrupted batches',()=>{
 const t=temp();try{
  assert.equal(t.db.savePrices([rule()]).added,1);const original=t.db.db.prepare('SELECT * FROM pricing_rules').all();
  const reordered=Object.fromEntries(Object.entries(rule()).reverse()) as unknown as PriceRule;assert.equal(t.db.savePrices([reordered]).added,0);assert.deepEqual(t.db.db.prepare('SELECT * FROM pricing_rules').all(),original);
  assert.throws(()=>t.db.savePrices([rule({id:'new-independent',model:'other'}),rule({rates:{input:9,cached_input:1,cache_write:1,output:1}})]),/immutable_price_rule_changed/);assert.deepEqual(t.db.db.prepare('SELECT * FROM pricing_rules').all(),original);
  for(const invalid of [next(rule(),{supersedes:'missing'}),next(rule(),{kind:'credit'}),next(rule(),{processing_mode:'fast'}),next(rule(),{model:'other'}),next(rule(),{context_min:1}),next(rule(),{effective_from:rule().effective_from})])assert.throws(()=>t.db.savePrices([invalid]),/invalid_price_supersession/);
  t.db.db.exec("CREATE TRIGGER fail_price BEFORE INSERT ON pricing_rules WHEN NEW.id='bad' BEGIN SELECT RAISE(ABORT,'injected_price_interrupt'); END");
  assert.throws(()=>t.db.savePrices([rule({id:'good',model:'other'}),rule({id:'bad',model:'other2'})]),/injected_price_interrupt/);assert.deepEqual(t.db.db.prepare('SELECT * FROM pricing_rules').all(),original);t.db.db.exec('DROP TRIGGER fail_price');
  assert.equal(t.db.savePrices([next()]).added,1);assert.equal(t.db.savePrices([next()]).added,0);assert.throws(()=>t.db.savePrices([next(rule(),{id:'fork',effective_from:'2026-10-06T00:00:00.000Z'})]),/invalid_price_supersession/);
 }finally{t.close();}
});
test('C undeclared overlap, unknown model/tier/cache price or cache counts stay unknown',()=>{
 const old=rule(),unrelated=next(old);delete unrelated.supersedes;
 assert.equal(priceUsage(usage(),[old,unrelated]).api_equivalent_usd,null);
 for(const input of [{...usage(),model:'unknown'},{...usage(),service_tier:'unknown'},{...usage(),cached_input_tokens:undefined as unknown as number}])assert.equal(priceUsage(input,[old]).api_equivalent_usd,null);
 assert.equal(priceUsage(usage(),[rule({rates:{...old.rates,cache_write:null}})]).api_equivalent_usd,null);
 const t=temp();try{t.db.savePrices([old,unrelated]);assert.equal(priceUsage(usage(),t.db.rules()).api_rule_id,null);}finally{t.close();}
});
test('C concurrent importer cannot append a fork validated against a stale catalogue',()=>{
 const t=temp(),other=new Ledger(join(t.dir,'usage.db'));try{
  t.db.savePrices([rule()]);const read=t.db.rules.bind(t.db),winner=next(rule(),{id:'winner'}),loser=next(rule(),{id:'loser'});
  // Commit another writer after this import reads its snapshot, before its append.
  t.db.rules=()=>{const snapshot=read();other.savePrices([winner]);return snapshot;};
  assert.throws(()=>t.db.savePrices([loser]),/locked|busy/i);t.db.rules=read;
  assert.deepEqual(t.db.rules().map(r=>r.id).sort(),['old','winner']);
  assert.throws(()=>t.db.savePrices([loser]),/invalid_price_supersession/);
 }finally{other.close();t.close();}
});
test('C event/current valuation snapshots preserve source and old quotes, repeat idempotently and expose catalogue provenance',async()=>{
 const t=temp();try{
  t.db.savePrices([rule()]);for(const time of ['2026-10-03T23:59:59.999Z',boundary])t.db.insertUsage(priceUsage(usage(time),t.db.rules()));
  const original=t.db.db.prepare('SELECT * FROM usage_records ORDER BY id').all(),oldRules=t.db.db.prepare('SELECT * FROM pricing_rules').all();t.db.savePrices([next()]);
  const event=revalue(t.db,range),again=revalue(t.db,{timezone:range.timezone,to_exclusive:range.to_exclusive,from:range.from}),current=revalue(t.db,range,'current',boundary);
  assert.equal(event.basis,'event_time');assert.equal(current.basis,'current_at');assert.equal(again.run_id,event.run_id);assert.equal(again.reused,true);assert.notEqual(event.run_id,current.run_id);
  assert.ok(Math.abs(event.known_api_subtotal_usd-.001014)<1e-12);assert.ok(Math.abs(current.known_api_subtotal_usd-.001352)<1e-12);
  assert.equal(event.allowance_weight,null);assert.equal(event.allowance_token_coverage,0);assert.deepEqual(t.db.db.prepare('SELECT * FROM usage_records ORDER BY id').all(),original);assert.deepEqual(t.db.db.prepare("SELECT * FROM pricing_rules WHERE id='old'").all(),oldRules);
  assert.equal(t.db.db.prepare('SELECT COUNT(*) n FROM valuation_runs').get()!.n,2);assert.equal(t.db.db.prepare('SELECT COUNT(*) n FROM valuation_results').get()!.n,4);
  const results=t.db.db.prepare('SELECT raw_json FROM valuation_results WHERE run_id=? ORDER BY timestamp').all(event.run_id).map(row=>JSON.parse(row.raw_json as string));assert.equal(results[1].stored_quote.api_rule_id,'old');assert.equal(results[1].recomputed_quote.api_rule_id,'old-next');assert.equal(priceUsage(usage(),t.db.rules().filter(r=>r.id==='old')).api_equivalent_usd,results[1].stored_quote.api_equivalent_usd);
  assert.equal(report(t.db.records(),t.db.rules(),boundary).current_price_valuation.catalogue_id,event.catalogue_id);assert.equal(event.catalogue_id,catalogueId(t.db.rules()));
  for(const kind of ['valuations','valuation-runs']){const path=join(t.dir,kind+'.jsonl');await exportData(t.db,kind,{...range,to_exclusive:'9999'},path,event.run_id);const text=readFileSync(path,'utf8');assert.doesNotMatch(text,/PRIVATE_PROJECT/);const rows=text.trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows[0].schema_version,3);assert.ok(rows.slice(1).every(row=>row.data.run_id===event.run_id));if(kind==='valuation-runs'){assert.equal(rows[1].data.catalogue_rules.length,2);assert.equal(rows[1].data.algorithm_version,'valuation_v1');}}
  t.db.insertUsage(priceUsage(usage('2026-10-04T01:00:00.000Z'),t.db.rules()));assert.notEqual(revalue(t.db,range).run_id,event.run_id);
 }finally{t.close();}
});
test('C injected valuation interruption leaves no partial run/results and no changes to original quotes',()=>{
 const t=temp();try{
  t.db.savePrices([rule(),next()]);for(const id of ['one','two'])t.db.insertUsage(priceUsage(usage(boundary,id),t.db.rules()));const original=t.db.db.prepare('SELECT * FROM usage_records ORDER BY id').all();
  t.db.db.exec("CREATE TRIGGER interrupt_valuation BEFORE INSERT ON valuation_results WHEN (SELECT COUNT(*) FROM valuation_results)=1 BEGIN SELECT RAISE(ABORT,'injected_valuation_interrupt'); END");
  assert.throws(()=>revalue(t.db,range),/injected_valuation_interrupt/);assert.equal(t.db.db.prepare('SELECT COUNT(*) n FROM valuation_runs').get()!.n,0);assert.equal(t.db.db.prepare('SELECT COUNT(*) n FROM valuation_results').get()!.n,0);assert.deepEqual(t.db.db.prepare('SELECT * FROM usage_records ORDER BY id').all(),original);
  t.db.db.exec('DROP TRIGGER interrupt_valuation');assert.equal(revalue(t.db,range).records,2);assert.equal(revalue(t.db,range).reused,true);assert.throws(()=>revalue(t.db,range,'current'),/valuation_requires_at/);assert.throws(()=>revalue(t.db,range,'event',boundary),/event_valuation_has_no_at/);
 }finally{t.close();}
});
test('C actual CLI imports successor once, revalues/exports and starts offline monitor with original seed unchanged',()=>{
 const t=temp(),source=mkdtempSync(join(tmpdir(),'cux-C-source-'));try{
  mkdirSync(join(source,'sessions'),{recursive:true});mkdirSync(join(source,'archived_sessions'));
  writeFileSync(join(t.dir,'config.json'),JSON.stringify({codex_home:source,timezone:'UTC',poll_seconds:60,codex_binary:'/nonexistent',estimator:{weight_basis:'verified',bucket_models:{}}}));
  const seed=JSON.stringify([rule()]);writeFileSync(join(t.dir,'prices.json'),seed);t.db.savePrices([rule()]);t.db.insertUsage(priceUsage(usage(),[rule()]));const patch=join(t.dir,'update.json');writeFileSync(patch,JSON.stringify([next()]));
  const cli=(args:string[],json=true)=>execFileSync(process.execPath,[new URL('../src/cli.js',import.meta.url).pathname,...args,...(json?['--json']:[]),'--data-home',t.dir],{encoding:'utf8'});
  assert.equal(JSON.parse(cli(['prices','import','--input',patch])).added,1);assert.equal(JSON.parse(cli(['prices','import','--input',patch])).added,0);assert.equal(readFileSync(join(t.dir,'prices.json'),'utf8'),seed);
  const result=JSON.parse(cli(['revalue','--basis','event','--from','2026-10-03','--to','2026-10-04']));assert.equal(result.records,1);assert.equal(JSON.parse(cli(['revalue','--basis','event','--from','2026-10-03','--to','2026-10-04'])).run_id,result.run_id);
  const exported=cli(['export','valuations','--run',result.run_id],false).trim().split('\n').map(line=>JSON.parse(line));assert.equal(exported[1].data.recomputed_quote.api_rule_id,'old-next');assert.match(cli(['prices'],false),/价格目录/);assert.match(cli(['revalue','--basis','current','--at',boundary],false),/指定时刻假设重估/);
  const watch=cli(['watch','--offline','--once']);assert.match(watch,/"kind": "local_sync",\s*"status": "ok"/);assert.doesNotMatch(watch,/immutable_price_rule_changed|rollout_directory_unreadable/);
  assert.equal(JSON.parse(cli(['today'])).current_price_valuation.catalogue_id,catalogueId(t.db.rules()));assert.match(cli(['--help'],false),/valuation-runs/);
 }finally{t.close();rmSync(source,{recursive:true,force:true});}
});
