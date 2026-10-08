import test from 'node:test';
import assert from 'node:assert/strict';
import {format,cellWidth} from '../src/display.js';
import {dailyReport} from '../src/daily.js';
import {syntheticReport,syntheticInput,syntheticUsage,recoveryReport} from './reader-fixture.js';
const dollars=(n:number)=>'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
test('ten synthetic days use separate six/five/six-column tables with ordinary single wide rows',()=>{
 const v=syntheticReport(),before=JSON.stringify(v),text=format(v,{command:'report',width:157});
 const usage=text.split('每日用量')[1].split('每日额度')[0],quota=text.split('每日额度')[1].split('区间模型汇总')[0];
 const dayRows=(s:string)=>s.split('\n').filter(l=>/^2026-10-\d\d/.test(l));
 assert.equal(dayRows(usage).length,10);assert.ok(dayRows(usage).every(l=>l.split('│').length===6));
 assert.equal(dayRows(quota).length,10);assert.ok(dayRows(quota).every(l=>l.split('│').length===5));
 assert.match(text,/累计消耗.*≈20/);assert.match(text,/合计/);
 const expected=dollars(v.conditional_capacity.windows[0].api.equivalent_100_percent!);
 assert.ok(text.split('\n').find(l=>l.startsWith('100% API 等效估算'))?.includes(expected));
 assert.doesNotMatch(text,/primary|synthetic-display-account|条件窗口|配对|严格容量|逐日用量 · 模型明细/);
 assert.match(text.replace(/\n/g,''),/仅按本地记录估算，账户覆盖未核实/);
 for(const width of [157,100,80,40]){const s=format(v,{command:'report',width});assert.ok(s.split('\n').every(l=>cellWidth(l)<=width),s);assert.ok(s.includes(expected));}
 assert.equal(JSON.stringify(v),before);
});
test('single-day summary preserves both quota endpoints and estimate marker; only one model table',()=>{
 const v=syntheticReport(1),s=format(v,{command:'report',width:157});
 assert.match(s,/当日首末采样.*100% → 98%/);assert.match(s,/当日消耗估计.*≈2/);
 assert.doesNotMatch(s,/每日用量|每日额度|当前额度/);assert.equal(s.split('gpt-6.1-sol│').length-1,1);
 assert.ok(s.indexOf('100% API 等效估算')<s.indexOf('模型用量'));
});
test('recovery and multiple same-pool epochs show a labelled range without changing consumed points',()=>{
 const v=recoveryReport(),before=JSON.stringify(v),s=format(v,{command:'today',width:157});
 assert.match(s,/回升/);assert.match(s,/≈2/);assert.match(s,/100% API 等效估算.*\$.*～\$/);assert.match(s,/当日分段估算/);assert.match(s,/不是置信区间/);
 assert.doesNotMatch(s,/重置|primary|账号.*synthetic/);assert.equal(JSON.stringify(v),before);
});
test('unrelated old cycles never become summary capacity; distinct accounts or pools do not form ranges',()=>{
 const v=syntheticReport(1),root=v.conditional_capacity.windows[0],expected=dollars(root.api.equivalent_100_percent!);
 const old=structuredClone(root);old.id='unrelated';old.reset_anchor-=20*86400;old.api.equivalent_100_percent=99999;v.conditional_capacity.windows.push(old);
 assert.ok(format(v,{command:'report',width:157}).includes(expected));assert.doesNotMatch(format(v,{command:'report',width:157}),/99,999/);
 for(const account of [true,false]){
  const other=structuredClone(root);other.id='different';if(account)other.scope.account_ref='different-account';else other.limit_id='other-pool';
  const p=structuredClone(v.daily[0].observation[0]);if(account)p.scope.account_ref='different-account';else p.limit_id='other-pool';
  const changed=structuredClone(v);changed.conditional_capacity.windows.push(other);changed.daily[0].observation.push(p);
  changed.conditional_capacity.days[0].windows.push({...changed.conditional_capacity.days[0].windows[0],epoch_id:other.id});
  assert.match(format(changed,{command:'report',width:157}),/100% API 等效估算\s+—/);
 }
});
test('an observed new segment without a conditional value is explicitly left unknown',()=>{
 const v=syntheticReport(1),p=v.daily[0].observation[0];
 p.segments.push({...structuredClone(p.segments[0]),resets_at:p.segments[0].resets_at!+86400,points:[{id:'synthetic-new-single-point',timestamp:'2026-10-01T01:00:00.000Z',used_percent:0,remaining_percent:100}]});
 const s=format(v,{command:'report',width:157});assert.match(s,/当日可估分段（其余 —）/);assert.doesNotMatch(s,/当日观测段估算/);
});
test('partial pricing marks amounts and no data does not turn into zero charges or 100% cache hits',()=>{
 const x=syntheticInput(1);x.rows.push(syntheticUsage(x.rows[0].timestamp,1000,'missing-price'));
 const v={period:x.range,...dailyReport(x.rows,x.quotas,x.rules,x.range,x.at)},s=format(v,{command:'today',width:157});
 assert.match(s,/\$[\d.]+\*/);assert.match(s,/已知计价部分/);assert.match(s,/66\.67%/);assert.match(s,/missing-price.*—/);
 const empty={period:x.range,...dailyReport([],[],x.rules,x.range,x.at)},noData=format(empty,{command:'report',width:157});
 assert.match(noData,/暂无已入账记录/);assert.doesNotMatch(noData,/\$0\.00|100%│/);
});
test('status keeps independent official permission and spend control with unknown values explicit',()=>{
 const today=syntheticReport(1),base={today,quota:[{used_percent:0,timestamp:today.as_of,availability:{ordinary_usage_allowed:false,spend_control_reached:true}}]};
 assert.match(format(base,{command:'status',width:157}),/普通用量 \/ 支出控制.*不允许 \/ 已达限制/);
 assert.match(format({...base,quota:[{used_percent:100,timestamp:today.as_of}]},{command:'status',width:157}),/普通用量 \/ 支出控制.*未知 \/ 未知/);
 assert.match(format(base,{command:'status',width:157}),/当日消耗估计（百分点）\s+—/);
});
test('history counts and per-day models stay in details; default reminder is one short line',()=>{
 const v={...syntheticReport(),legacy_reconciliation:{pending_tokens:987654321,conflict_records:3}},s=format(v,{command:'report',width:157});
 assert.equal(s.split('历史待核对').length-1,1);assert.doesNotMatch(s,/9\.88 亿|987,654,321|争议用量记录/);
 const details=format(v,{command:'report',width:157,details:true});assert.match(details,/987,654,321/);assert.match(details,/逐日用量 · 模型明细/);assert.match(details,/条件配对区间/);
});
