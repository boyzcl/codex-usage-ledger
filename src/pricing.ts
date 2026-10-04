import type {PriceRule,Usage} from './types.js';
export function mode(tier:string):string{return ({default:'standard',standard:'standard',priority:'fast',fast:'fast',ultrafast:'ultrafast',flex:'flex',batch:'batch'} as Record<string,string>)[tier]??'unknown';}
export function validatePrices(value:unknown):PriceRule[]{
 if(!Array.isArray(value))throw Error('invalid_prices');const ids=new Set<string>();
 for(const r of value){
  if(!r||!['api','credit','allowance'].includes(r.kind)||typeof r.id!=='string'||ids.has(r.id)||typeof r.model!=='string'||!['standard','fast','ultrafast','flex','batch'].includes(r.processing_mode)||!Number.isFinite(Date.parse(r.effective_from))||r.effective_to!==null&&(!Number.isFinite(Date.parse(r.effective_to))||r.effective_to<=r.effective_from)||!Number.isFinite(Date.parse(r.retrieved_at))||typeof r.source_url!=='string'||!r.source_url.startsWith('https://')||typeof r.basis!=='string'||!Number.isInteger(r.context_min)||r.context_min<0||r.context_max!==null&&r.context_max<r.context_min)throw Error('invalid_price_rule');
  for(const k of ['input','cached_input','output','cache_write'])if(!(k==='cache_write'&&r.rates?.[k]===null)&&(!Number.isFinite(r.rates?.[k])||r.rates[k]<0))throw Error('invalid_price_rate');
  ids.add(r.id);
 }
 return value as PriceRule[];
}
export function priceUsage(u:Usage,rules:PriceRule[]):Usage{
 const row={...u,api_equivalent_usd:null,credit_equivalent:null,allowance_weight:null,api_rule_id:null,credit_rule_id:null,allowance_rule_id:null} as Usage;
 if(u.data_quality==='inconsistent'||u.model==='unknown'||mode(u.service_tier)==='unknown')return row;
 for(const kind of ['api','credit','allowance'] as const){
  const matches=rules.filter(r=>r.kind===kind&&r.model===u.model&&r.processing_mode===mode(u.service_tier)&&r.effective_from<=u.timestamp&&(!r.effective_to||u.timestamp<r.effective_to)&&u.input_tokens>=r.context_min&&(r.context_max===null||u.input_tokens<=r.context_max));
  if(matches.length!==1)continue;
  const r=matches[0],p=r.rates;
  if(p.cache_write===null&&u.cache_write_input_tokens>0)continue;
  // Codex credits: cache writes are ordinary noncached input, with no extra surcharge.
  const val=(u.uncached_input_tokens*p.input+u.cached_input_tokens*p.cached_input+u.cache_write_input_tokens*(p.cache_write??0)+u.output_tokens*p.output)/1e6;
  if(kind==='api'){row.api_equivalent_usd=val;row.api_rule_id=r.id;}
  if(kind==='credit'){row.credit_equivalent=val;row.credit_rule_id=r.id;}
  if(kind==='allowance'){row.allowance_weight=val;row.allowance_rule_id=r.id;}
 }return row;
}
