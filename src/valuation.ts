import {createHash} from 'node:crypto';
import type {Ledger} from './store.js';
import {tokenFields,type Usage} from './types.js';
import {canonicalJson,catalogueId,createPricer} from './pricing.js';
import {hash} from './quota.js';
const quoteFields=['api_equivalent_usd','credit_equivalent','allowance_weight','api_rule_id','credit_rule_id','allowance_rule_id'] as const;
const quote=(usage:Usage)=>Object.fromEntries(quoteFields.map(key=>[key,usage[key]]));
export function revalue(ledger:Ledger,range:{from:string;to_exclusive:string;timezone:string},basis:'event'|'current'='event',at?:string){
 if(!['event','current'].includes(basis))throw Error('invalid_valuation_basis');
 if(basis==='current'&&(!at||!Number.isFinite(Date.parse(at))))throw Error('valuation_requires_at');
 if(basis==='event'&&at!==undefined)throw Error('event_valuation_has_no_at');
 const valuationAt=basis==='current'?new Date(at!).toISOString():null;
 return ledger.transaction(()=>{
  const rules=ledger.rules(),catalogue=catalogueId(rules),price=createPricer(rules),inputHash=createHash('sha256');
  const query=ledger.db.prepare('SELECT raw_json FROM usage_records WHERE timestamp>=? AND timestamp<? ORDER BY timestamp,id');
  for(const row of query.iterate(range.from,range.to_exclusive))inputHash.update(canonicalJson(JSON.parse(row.raw_json as string))+'\n');
  const input=inputHash.digest('hex'),id=hash(canonicalJson(['valuation_v1',catalogue,input,range,basis,valuationAt]));
  const existing=ledger.db.prepare('SELECT raw_json FROM valuation_runs WHERE id=?').get(id);
  if(existing)return {...JSON.parse(existing.raw_json as string),reused:true};
  let records=0,tokens=0,api=0,credit=0,allowance=0,apiTokens=0,creditTokens=0,allowanceTokens=0,apiCount=0,creditCount=0,allowanceCount=0;
  for(const row of query.iterate(range.from,range.to_exclusive)){
   const usage=JSON.parse(row.raw_json as string) as Usage,priced=price({...usage,timestamp:valuationAt??usage.timestamp});records++;tokens+=usage.total_tokens;
   if(priced.api_equivalent_usd!==null){api+=priced.api_equivalent_usd;apiCount++;apiTokens+=usage.total_tokens;}
   if(priced.credit_equivalent!==null){credit+=priced.credit_equivalent;creditCount++;creditTokens+=usage.total_tokens;}
   if(priced.allowance_weight!==null){allowance+=priced.allowance_weight;allowanceCount++;allowanceTokens+=usage.total_tokens;}
   const facts=Object.fromEntries(['id','timestamp','model','service_tier','source','data_quality','uncached_input_tokens',...tokenFields].map(key=>[key,usage[key as keyof Usage]]));
   const result={run_id:id,usage_id:usage.id,timestamp:usage.timestamp,input_snapshot_fingerprint:hash(canonicalJson(usage)),facts,stored_quote:quote(usage),recomputed_quote:quote(priced)};
   ledger.db.prepare('INSERT INTO valuation_results VALUES (?,?,?,?,?)').run(hash([id,usage.id]),id,usage.id,usage.timestamp,JSON.stringify(result));
  }
  const run={run_id:id,created_at:new Date().toISOString(),algorithm_version:'valuation_v1',catalogue_id:catalogue,catalogue_rules:rules,input_snapshot_hash:input,range,basis:basis==='event'?'event_time':'current_at',valuation_at:valuationAt,records,total_tokens:tokens,api_equivalent_usd:apiCount===records?api:null,known_api_subtotal_usd:api,api_token_coverage:tokens?apiTokens/tokens:1,credit_equivalent:creditCount===records?credit:null,known_credit_subtotal:credit,credit_token_coverage:tokens?creditTokens/tokens:1,allowance_weight:allowanceCount===records?allowance:null,known_allowance_subtotal:allowance,allowance_token_coverage:tokens?allowanceTokens/tokens:1,note:'Derived valuation of accepted local facts, not a bill or verified plan capacity. Original Usage, stored quotes and pricing rules remain unchanged.'};
  ledger.db.prepare('INSERT INTO valuation_runs VALUES (?,?,?)').run(id,run.created_at,JSON.stringify(run));return {...run,reused:false};
 });
}
