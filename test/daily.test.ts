import {responseContext} from '../src/quota-policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyReport as rawDailyReport,empiricalPlans,combinePlans} from '../src/daily.js';
import {period,report} from '../src/report.js';
import {format,cellWidth} from '../src/display.js';
import {initialState,parseLine} from '../src/parser.js';
import type {Usage,Quota,PriceRule} from '../src/types.js';
const dailyReport:typeof rawDailyReport=(rows,quotas,rules,range,at)=>rawDailyReport(rows,quotas,rules,range,at,{experimentalEmpirical:true});
const syntheticContext=responseContext({accountId:'synthetic-account'},null,'2026-10-01T00:00:00.000Z','app_server');
syntheticContext.scope={...syntheticContext.scope,workspace_ref:'synthetic-workspace',billing_source:'synthetic-included',status:'verified'};
const syntheticAttribution={scope:syntheticContext.scope,limit_id:'codex',slot:'primary',window_duration_mins:10080,resets_at:Date.parse('2026-10-07T00:00:00Z')/1000,source:'source_event' as const};
const at='2026-10-04T10:00:00.000Z';
const range=period('report','Asia/Shanghai','2026-10-01','2026-10-03',at);
function use(timestamp:string,tokens:number,model='a',cached=0):Usage{
 const r=parseLine(JSON.stringify({timestamp,type:'token_usage_record',payload:{response_id:timestamp+model,thread_id:'test',usage:{input_tokens:tokens*.9,output_tokens:tokens*.1,total_tokens:tokens,cached_input_tokens:cached}}}),initialState()).usage[0];
 return {...r,quota_attribution:syntheticAttribution,model,service_tier:'default',api_equivalent_usd:tokens/1e6};
}
function quota(timestamp:string,used_percent:number,extra:Partial<Quota>={}):Quota{return {context:syntheticContext,id:timestamp,timestamp,used_percent,source:'app_server',slot:'primary',limit_id:'codex',window_duration_mins:10080,resets_at:Date.parse('2026-10-07T00:00:00Z')/1000,raw_json:'{}',...extra};}
const rule:PriceRule={id:'test',kind:'api',model:'a',processing_mode:'standard',effective_from:at,effective_to:null,context_min:0,context_max:null,rates:{input:2,cached_input:.2,cache_write:2,output:10},source_url:'https://example.com',retrieved_at:at,basis:'synthetic'};
const sample=()=>{
 const rows=[use('2026-10-01T01:30:00.000Z',400e6),use('2026-10-02T01:30:00.000Z',360e6,'b'),use('2026-10-03T01:30:00.000Z',240e6)];
 const qs=[quota('2026-10-01T01:00:00.000Z',0),quota('2026-10-01T02:00:00.000Z',20),quota('2026-10-02T01:00:00.000Z',20),quota('2026-10-02T02:00:00.000Z',38),quota('2026-10-03T01:00:00.000Z',38),quota('2026-10-03T02:00:00.000Z',53)];
 return {rows,qs};
};
test('daily capacity divides matching tokens by observed points; interval uses ratio of sums',()=>{
 const {rows,qs}=sample(),v=dailyReport(rows,qs,[rule],range,at);
 assert.deepEqual(v.daily.map(d=>d.plans[0].estimated_tokens),[2e9,2e9,1.6e9]);
 assert.equal(v.plan_cycles[0].estimated_tokens,1e9*100/53);
 assert.equal(v.plan_cycles[0].percent_points,53);
 assert.equal(v.totals.total_tokens,v.daily.reduce((n,d)=>n+d.totals.total_tokens,0));
 assert.equal(v.totals.total_tokens,Object.values(v.models).reduce((n,m)=>n+m.total_tokens,0));
 assert.ok(Object.values(v.models).every(m=>m.plan_percent_points===null&&m.estimated_plan_tokens===null));
 assert.deepEqual(v.totals,report(rows,[rule],at).totals);
});
test('partial-day estimate excludes tokens before first and after last observation',()=>{
 const rows=[use('2026-10-01T00:30:00.000Z',1e9),use('2026-10-01T01:00:00.000Z',1e9),use('2026-10-01T02:00:00.000Z',400e6),use('2026-10-01T02:01:00.000Z',1e9)];
 const qs=[quota('2026-10-01T01:00:00.000Z',10),quota('2026-10-01T02:00:00.000Z',30)];
 const v=dailyReport(rows,qs,[rule],range,at),p=v.daily[0].plans[0];
 assert.equal(p.matched_tokens,400e6);assert.equal(p.estimated_tokens,2e9);assert.equal(p.partial,true);assert.equal(v.daily[0].totals.total_tokens,3.4e9);
});
test('unsafe or insufficient observations keep capacity null, including combined conflicting days',()=>{
 const rows=[use('2026-10-01T01:30:00.000Z',100)];
 const start=quota('2026-10-01T01:00:00.000Z',20),end=quota('2026-10-01T02:00:00.000Z',30);
 for(const [qs,data,reason] of [
  [[start],rows,'no_observations'],[[start,{...end,used_percent:24}],rows,'small_percent_change'],
  [[start,{...end,used_percent:20}],rows,'small_percent_change'],[[start,end],[],'unverified_local_account_window_attribution'],
  [[start,{...end,used_percent:100}],rows,'saturated'],[[start,{...end,used_percent:10}],rows,'percent_decrease'],
  [[start,end],rows.map(r=>({...r,data_quality:'inconsistent'})),'inconsistent_tokens'],
  [[start,end,{...end,used_percent:31}],rows,'conflicting_snapshots']
 ] as [Quota[],Usage[],string][]){const p=empiricalPlans(data,qs,range)[0];assert.equal(p.estimated_tokens,null,reason);assert.equal(p.reason,reason);if(reason==='conflicting_snapshots')assert.equal(combinePlans([p,p])[0].estimated_tokens,null);}
});
test('reset, slot and window identity remain separate; source and cycle bounds are enforced',()=>{
 const {rows,qs}=sample();
 const variants=[{},{slot:'secondary'},{resets_at:Date.parse('2026-10-08T00:00:00Z')/1000},{window_duration_mins:14400}];
 const all=variants.flatMap(v=>qs.slice(0,2).map(q=>({...q,...v})));
 const plans=empiricalPlans(rows,[...all,quota('2026-09-29T00:00:00.000Z',1),quota('2026-10-07T00:00:00.000Z',99)],{...range,from:'2026-09-28T00:00:00.000Z',to_exclusive:'2026-10-08T00:00:00.000Z'});
 assert.equal(plans.length,4);assert.ok(plans.every(p=>p.observation_count===2));assert.equal(combinePlans(plans).length,4);
 assert.equal(empiricalPlans(rows,qs.map(q=>({...q,source:'rollout'})),range).length,0);
});
test('a decrease between daily segments invalidates interval extrapolation',()=>{
 const {rows,qs}=sample();qs[2].used_percent=10;qs[3].used_percent=28;
 const v=dailyReport(rows,qs,[rule],range,at);assert.equal(v.plan_cycles[0].estimated_tokens,null);assert.equal(v.plan_cycles[0].reason,'percent_decrease');
});
test('current repricing preserves dates and correctly weights aggregate cache and pricing coverage',()=>{
 const rows=[use('2026-10-01T15:59:59.999Z',100,'a',45),use('2026-10-01T16:00:00.000Z',300,'b',270)];
 const v=dailyReport(rows,[],[rule],range,at);
 assert.deepEqual(v.daily.map(d=>d.totals.total_tokens),[100,300,0]);
 assert.equal(v.current_price_valuation.api_token_coverage,.25);assert.equal(v.totals.cached_input_tokens/v.totals.input_tokens,.875);
 assert.equal(v.daily[0].current_price_valuation.known_api_subtotal_usd,(45*2+45*.2+10*10)/1e6);
 assert.equal(v.daily[1].current_price_valuation.api_token_coverage,0);
});
test('snapshots at exclusive midnight stay on the next day and never interpolate missing boundaries',()=>{
 const rows=[use('2026-10-01T15:59:00.000Z',100),use('2026-10-01T16:00:00.000Z',200),use('2026-10-01T16:30:00.000Z',300)];
 const qs=[quota('2026-10-01T15:00:00.000Z',10),quota('2026-10-01T16:00:00.000Z',20),quota('2026-10-01T17:00:00.000Z',30)];
 const v=dailyReport(rows,qs,[rule],range,at);assert.equal(v.daily[0].plans[0].percent_points,null);assert.equal(v.daily[1].plans[0].matched_tokens,300);assert.equal(v.plan_cycles[0].percent_points,10);
});
test('ongoing day, empty ranges and open-ended reports have bounded honest calendar rows',()=>{
 const today=period('today','Asia/Shanghai',undefined,undefined,at);
 assert.equal(dailyReport([],[],[],today,at).daily[0].ongoing,true);
 assert.equal(dailyReport([],[],[],{...today,to_exclusive:'2026-10-04T09:00:00.000Z'},at).daily[0].ongoing,false);
 const v=dailyReport(sample().rows,[],[],period('report','Asia/Shanghai',undefined,undefined,at),at);
 assert.equal(v.daily.length,4);assert.ok(v.display_period.from.startsWith('2026-'));
 const dst=dailyReport([],[],[],period('report','America/New_York','2026-03-08','2026-03-08',at),at);
 assert.equal(Date.parse(dst.daily[0].to_exclusive)-Date.parse(dst.daily[0].from),23*3600000);
});
test('all twelve columns and all models survive wide and narrow rendering, with dashed model quota cells',()=>{
 const {rows,qs}=sample();rows.push(...Array.from({length:7},(_,i)=>use('2026-10-01T01:40:00.000Z',100,'model-'+i)));
 const v={period:range,...dailyReport(rows,qs,[rule],range,at)};
 for(const width of [24,40,64,80,110,140,180]){
  const s=format(v,{command:'report',width,now:Date.parse(at)});assert.ok(s.split('\n').every(l=>cellWidth(l)<=width),s);
  assert.doesNotMatch(s,/暂不可归因|暂不可独立估算/);const columns=width<64?s:Array.from({length:12},(_,i)=>s.split('\n').filter(l=>l.includes('│')).map(l=>l.split('│')[i].replace(/\s/g,'')).join('')).join('\n');assert.match(columns,/区间合计/);assert.match(columns,/model-0/);
 }
 const wide=format(v,{command:'report',width:180});const model=wide.split('\n').find(l=>l.includes('model-0'))!.split('│');assert.equal(model.length,12);assert.equal(model[6].trim(),'—');assert.equal(model[7].trim(),'—');assert.equal(model[8].trim(),'—');
});
test('multiple observed windows keep twelve cells and distinct observations',()=>{
 const {rows,qs}=sample();const v={period:range,...dailyReport(rows,[...qs,...qs.map(q=>({...q,slot:'secondary'}))],[rule],range,at)};
 const text=format(v,{command:'report',width:180});const lines=text.split('\n').filter(l=>l.includes('│'));assert.ok(lines.every(l=>l.split('│').length===12));assert.match(text,/观测 2/);
});
