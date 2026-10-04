import {createHash} from 'node:crypto';
import type {PriceRule,Usage} from './types.js';
export function canonicalJson(value:any):string {
 const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,sorted(v[k])])):v;
 return JSON.stringify(sorted(value));
}
export const catalogueId=(rules:PriceRule[])=>createHash('sha256').update(canonicalJson([...rules].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0))).digest('hex');
export function mode(tier:string):string{return ({default:'standard',standard:'standard',priority:'fast',fast:'fast',ultrafast:'ultrafast',flex:'flex',batch:'batch'} as Record<string,string>)[tier]??'unknown';}
export function validatePrices(value:unknown):PriceRule[]{
 if(!Array.isArray(value))throw Error('invalid_prices');const ids=new Set<string>();
 for(const r of value){
  if(!r||!['api','credit','allowance'].includes(r.kind)||typeof r.id!=='string'||!r.id||ids.has(r.id)||typeof r.model!=='string'||!['standard','fast','ultrafast','flex','batch'].includes(r.processing_mode)||!Number.isFinite(Date.parse(r.effective_from))||r.effective_to!==null&&(!Number.isFinite(Date.parse(r.effective_to))||Date.parse(r.effective_to)<=Date.parse(r.effective_from))||!Number.isFinite(Date.parse(r.retrieved_at))||typeof r.source_url!=='string'||!r.source_url.startsWith('https://')||typeof r.basis!=='string'||!Number.isInteger(r.context_min)||r.context_min<0||r.context_max!==null&&(!Number.isInteger(r.context_max)||r.context_max<r.context_min))throw Error('invalid_price_rule');
  for(const k of ['input','cached_input','output','cache_write'])if(!(k==='cache_write'&&r.rates?.[k]===null)&&(!Number.isFinite(r.rates?.[k])||r.rates[k]<0))throw Error('invalid_price_rate');
  if(r.supersedes!==undefined&&(typeof r.supersedes!=='string'||!r.supersedes||r.supersedes===r.id))throw Error('invalid_price_supersession');
  ids.add(r.id);
 }
 return value as PriceRule[];
}
export function validateCatalogue(rules:PriceRule[]):PriceRule[]{
 validatePrices(rules);const byId=new Map(rules.map(r=>[r.id,r])),successors=new Set<string>();
 for(const next of rules){if(!next.supersedes)continue;const old=byId.get(next.supersedes);
  if(!old||successors.has(old.id)||Date.parse(next.effective_from)<=Date.parse(old.effective_from)||['kind','model','processing_mode','context_min','context_max'].some(k=>next[k as keyof PriceRule]!==old[k as keyof PriceRule]))throw Error('invalid_price_supersession');
  successors.add(old.id);
 }return rules;
}
export function createPricer(rules:PriceRule[]):(u:Usage)=>Usage {
 const ends=new Map<string,number>();
 for(const rule of rules)if(rule.supersedes)ends.set(rule.supersedes,Math.min(ends.get(rule.supersedes)??Infinity,Date.parse(rule.effective_from)));
 const compiled=rules.map(rule=>({rule,from:Date.parse(rule.effective_from),to:Math.min(rule.effective_to?Date.parse(rule.effective_to):Infinity,ends.get(rule.id)??Infinity)}));
 return (u:Usage):Usage=>{
 const row={...u,api_equivalent_usd:null,credit_equivalent:null,allowance_weight:null,api_rule_id:null,credit_rule_id:null,allowance_rule_id:null} as Usage;
 if(u.data_quality==='inconsistent'||u.model==='unknown'||mode(u.service_tier)==='unknown'||['input_tokens','uncached_input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens'].some(k=>!Number.isFinite(u[k as keyof Usage])||Number(u[k as keyof Usage])<0))return row;
 const timestamp=Date.parse(u.timestamp);
 for(const kind of ['api','credit','allowance'] as const){
  const matches=compiled.filter(({rule:r,from,to})=>r.kind===kind&&r.model===u.model&&r.processing_mode===mode(u.service_tier)&&from<=timestamp&&timestamp<to&&u.input_tokens>=r.context_min&&(r.context_max===null||u.input_tokens<=r.context_max));
  if(matches.length!==1)continue;
  const r=matches[0].rule,p=r.rates;
  if(p.cache_write===null&&u.cache_write_input_tokens>0)continue;
  // Codex credits: cache writes are ordinary noncached input, with no extra surcharge.
  const val=(u.uncached_input_tokens*p.input+u.cached_input_tokens*p.cached_input+u.cache_write_input_tokens*(p.cache_write??0)+u.output_tokens*p.output)/1e6;
  if(!Number.isFinite(val))continue;
  if(kind==='api'){row.api_equivalent_usd=val;row.api_rule_id=r.id;}
  if(kind==='credit'){row.credit_equivalent=val;row.credit_rule_id=r.id;}
  if(kind==='allowance'){row.allowance_weight=val;row.allowance_rule_id=r.id;}
 }return row;
 };
}
export const priceUsage=(u:Usage,rules:PriceRule[])=>createPricer(rules)(u);
