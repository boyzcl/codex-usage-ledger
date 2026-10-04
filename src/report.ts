import {tokenFields,type Usage,type PriceRule,type TokenField} from './types.js';
import {createPricer,catalogueId} from './pricing.js';
export function aggregate(rows:Usage[]){
 const total=Object.fromEntries([...tokenFields,'uncached_input_tokens'].map(k=>[k,0])) as Record<TokenField|'uncached_input_tokens',number>;
 let api=0,credit=0,apiCount=0,creditCount=0,apiTokens=0,creditTokens=0;const sources:Record<string,number>={};
 for(const r of rows){for(const k of [...tokenFields,'uncached_input_tokens'] as const)total[k]+=r[k];if(r.api_equivalent_usd!==null){api+=r.api_equivalent_usd;apiCount++;apiTokens+=r.total_tokens;}if(r.credit_equivalent!==null){credit+=r.credit_equivalent;creditCount++;creditTokens+=r.total_tokens;}sources[r.source]=(sources[r.source]??0)+1;}
 return {records:rows.length,sessions:new Set(rows.map(x=>x.thread_id)).size,unique_responses:new Set(rows.map(x=>x.response_id).filter(Boolean)).size,...total,unclassified_tokens:total.total_tokens-total.input_tokens-total.output_tokens,api_equivalent_usd:apiCount===rows.length?api:null,known_api_subtotal_usd:api,api_priced_records:apiCount,api_token_coverage:total.total_tokens?apiTokens/total.total_tokens:1,credit_equivalent:creditCount===rows.length?credit:null,known_credit_subtotal:credit,credit_priced_records:creditCount,credit_token_coverage:total.total_tokens?creditTokens/total.total_tokens:1,sources,source_unavailable_records:rows.filter(r=>r.repair_status==='source_unavailable').length,source_unavailable_tokens:rows.filter(r=>r.repair_status==='source_unavailable').reduce((n,r)=>n+r.total_tokens,0)};
}
export function report(rows:Usage[],rules:PriceRule[],at=new Date().toISOString()){
 const models:Record<string,ReturnType<typeof aggregate>>={};for(const model of [...new Set(rows.map(r=>r.model))].sort())models[model]=aggregate(rows.filter(r=>r.model===model));
 const price=createPricer(rules),repriced=rows.map(r=>price({...r,timestamp:at}));
 return {totals:aggregate(rows),models,current_price_valuation:{at,basis:'current_at',catalogue_id:catalogueId(rules),description:'Hypothetical revaluation at current observed prices, not historical charges or subscription expenditure',...aggregate(repriced)}};
}
export function localDay(iso:string,timeZone:string):string{return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));}
export function shiftDay(day:string,n:number){const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
export function midnight(day:string,timeZone:string):string{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw Error('invalid_date');
 const desired=Date.parse(day+'T00:00:00Z');let guess=desired;
 for(let i=0;i<5;i++){const parts=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));const v=Object.fromEntries(parts.map(p=>[p.type,p.value]));const wall=Date.parse(`${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}Z`);const delta=desired-wall;if(!delta)return new Date(guess).toISOString();guess+=delta;}
 throw Error('unresolvable_local_midnight');
}
export function period(command:string,timeZone:string,from?:string,to?:string,now=new Date().toISOString()){
 const today=localDay(now,timeZone);let first=today,last=shiftDay(today,1);
 if(command==='week'){const dow=new Date(today+'T12:00:00Z').getUTCDay();first=shiftDay(today,-((dow+6)%7));}
 if(command==='month')first=today.slice(0,8)+'01';
 if(command==='report'){first=from??'0001-01-01';last=to&&/^\d{4}-\d{2}-\d{2}$/.test(to)?shiftDay(to,1):to??'9998-12-31';}
 const convert=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)?midnight(s,timeZone):new Date(s).toISOString();
 if(from&&/^\d{4}-\d{2}-\d{2}$/.test(from))midnight(from,timeZone);if(to&&/^\d{4}-\d{2}-\d{2}$/.test(to))midnight(to,timeZone);
 const range={from:convert(first),to_exclusive:convert(last),timezone:timeZone};if(range.from>=range.to_exclusive)throw Error('invalid_date_range');return range;
}
