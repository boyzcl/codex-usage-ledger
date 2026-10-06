import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {normalizeQuota} from '../src/quota.js';
import {planObservations,observationsForDay} from '../src/plan-observation.js';
import {dailyReport} from '../src/daily.js';
import {format,cellWidth} from '../src/display.js';
import {Ledger} from '../src/store.js';
import {exportData} from '../src/export.js';
import type {Quota} from '../src/types.js';
const range={from:'2026-10-06T00:00:00.000Z',to_exclusive:'2026-10-08T00:00:00.000Z',timezone:'UTC'};
const reset=Date.parse('2026-10-09T00:00:00Z')/1000;
function q(minute:number,percent:number,account:string|null='private-A',extra:Partial<Quota>={}):Quota {
 const timestamp=new Date(Date.parse(range.from)+minute*60000).toISOString();
 return {...normalizeQuota({accountId:account,rateLimits:{limitId:'codex',primary:{usedPercent:percent,windowDurationMins:10080,resetsAt:reset}}},timestamp,'app_server')[0],...extra};
}
test('stable partial account displays official endpoints and observed delta by default without capacity or model allocation',()=>{
 const qs=[q(5,40),q(15,50),q(25,75)];const v=dailyReport([],qs,[],range,range.to_exclusive);
 assert.equal(v.daily[0].observation[0].from_percent,40);assert.equal(v.daily[0].observation[0].to_percent,75);assert.equal(v.observation[0].percent_points,35);
 assert.ok(v.plan_cycles.every(p=>p.estimated_tokens===null));
 for(const width of [24,40,64,80,110,140,180]){const s=format(v,{command:'report',width});assert.ok(s.split('\n').every(l=>cellWidth(l)<=width));if(width>=140)assert.match(s,/40% → 75%/);}
 const single=dailyReport([],[q(5,0)],[],range,range.to_exclusive).observation[0];assert.equal(single.from_percent,0);assert.equal(single.to_percent,0);assert.equal(single.percent_points,null);
 assert.match(format(dailyReport([],[q(5,0)],[],range,range.to_exclusive),{command:'report',width:180}),/0%（单点）/);
 assert.deepEqual(planObservations([],range),[]);
 const open=dailyReport([],qs,[],{...range,from:'0001-01-01T00:00:00.000Z'},range.to_exclusive);assert.equal(open.daily[0].date,'2026-10-06');assert.equal(open.daily[0].observation[0].percent_points,35);
});
test('global A B A scope transitions never bridge; parallel buckets and slots stay independent',()=>{
 const qs=[q(1,10),q(2,20,'B'),q(3,30),q(4,35)];const p=planObservations(qs,range);
 assert.deepEqual(p.map(x=>x.percent_points),[null,null,5]);assert.deepEqual(p.map(x=>[x.from_percent,x.to_percent]),[[10,10],[20,20],[30,35]]);
 const parallel=[q(1,10),q(1,50,'private-A',{slot:'secondary'}),q(2,20),q(2,70,'private-A',{slot:'secondary'}),q(1,0,'private-A',{limit_id:'other'}),q(2,3,'private-A',{limit_id:'other'})];
 assert.deepEqual(planObservations(parallel,range).map(x=>x.percent_points).sort((a,b)=>a!-b!),[3,10,20]);
 for(const change of [{limit_id:'other'},{slot:'secondary'}]){const alternating=planObservations([q(1,10),q(2,20,'private-A',change),q(3,30)],range);assert.equal(alternating.length,3);assert.ok(alternating.every(p=>p.percent_points===null));}
 for(const dimension of ['workspace_ref','billing_source'] as const){const b=q(2,20);b.context=structuredClone(b.context);b.context!.scope[dimension]='changed';assert.ok(planObservations([q(1,10),b,q(3,30)],range).every(p=>p.percent_points===null));}
});
test('decreases, zero resets and one-second deadline jitter retain endpoints and valid segment sums',()=>{
 const qs=[q(1,40),q(2,45),q(3,0),q(4,3),q(5,4,'private-A',{resets_at:reset+1}),q(6,9,'private-A',{resets_at:reset+1}),q(7,11),q(8,12)];
 const p=planObservations(qs,range)[0];assert.equal(p.from_percent,40);assert.equal(p.to_percent,12);assert.equal(p.percent_points,14);assert.equal(p.segments.length,4);assert.ok(p.flags.includes('percent_decrease'));assert.ok(p.flags.includes('reset_deadline_change'));
 assert.deepEqual(p.segments.map(s=>s.points[0].used_percent),[40,0,4,11]);
 const saturated=planObservations([q(1,95),q(2,100),q(3,0),q(4,5)],range)[0];assert.equal(saturated.percent_points,10);assert.equal(saturated.to_percent,5);assert.equal(saturated.segments[1].points[0].used_percent,0);
 const duration=planObservations([q(1,10),q(2,20,'private-A',{window_duration_mins:14400}),q(3,30)],range);assert.equal(duration.length,3);assert.ok(duration.every(p=>p.percent_points===null));
});
test('conflicts are barriers; unknown and mixed identity never acquire a consumption delta',()=>{
 const qs=[q(1,10),q(2,20),q(3,25),q(3,26),q(4,40),q(5,45)];const ps=planObservations(qs,range);
 assert.equal(ps.reduce((n,p)=>n+(p.percent_points??0),0),15);assert.equal(ps.flatMap(p=>p.segments).filter(s=>s.flags.includes('conflicting_snapshots')).length,2);
 assert.ok(planObservations([q(1,10,null),q(2,20,null)],range).every(p=>p.percent_points===null));
 const mixed=q(2,20);mixed.context!.scope.status='mixed';assert.ok(planObservations([q(1,10),mixed,q(3,30)],range).every(p=>p.percent_points===null));
 const simultaneous=planObservations([q(1,10),q(2,20),q(2,30,'B'),q(3,40)],range);assert.ok(simultaneous.every(p=>p.percent_points===null));
 const samePercent=planObservations([q(2,20),q(2,20,'B')],range);assert.equal(samePercent.length,2);assert.notEqual(samePercent[0].scope.account_ref,samePercent[1].scope.account_ref);assert.ok(samePercent.every(p=>p.percent_points===null));
});
test('positive jumps are preserved and sampling gaps flagged; midnight pairs are excluded from day and period sums',()=>{
 const p=planObservations([q(1,0),q(60,90)],range)[0];assert.equal(p.percent_points,90);assert.ok(p.flags.includes('sampling_gap'));
 const series=planObservations([q(1430,10),q(1440,20),q(1450,25)],range);assert.equal(series[0].percent_points,5);assert.equal(observationsForDay(series,'2026-10-06')[0].percent_points,null);assert.equal(observationsForDay(series,'2026-10-07')[0].percent_points,5);
 const days=dailyReport([],[q(1,0),q(2,5),q(1440,7),q(1450,12)],[],range,range.to_exclusive);assert.equal(days.observation[0].percent_points,10);assert.equal(days.daily.reduce((n,d)=>n+(d.observation[0].percent_points??0),0),10);
 assert.equal(planObservations([q(1,0),q(1,0),q(2,0)],range)[0].percent_points,0);
 const invalid=planObservations([q(1,10,'private-A',{resets_at:null}),q(2,20,'private-A',{resets_at:null})],range)[0];assert.equal(invalid.from_percent,10);assert.equal(invalid.to_percent,20);assert.equal(invalid.percent_points,null);assert.ok(invalid.flags.includes('invalid_window'));
 const cutoff=dailyReport([],[q(1,10),q(3,30)],[],range,q(2,0).timestamp);assert.equal(cutoff.observation[0].observation_count,1);
});
test('derived observation export matches report schema and values while preserving redacted raw exports',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cux-observation-')),db=new Ledger(join(dir,'usage.db'));
 try{for(const quota of [q(1,40),q(2,45),q(3,0),q(4,5)])db.insertQuota(quota);
  const path=join(dir,'observation.jsonl');await exportData(db,'plan-observations',range,path);
  const lines=readFileSync(path,'utf8').trim().split('\n').map(l=>JSON.parse(l));assert.equal(lines[0].kind,'plan-observations');
  assert.deepEqual(lines.slice(1).map(l=>l.data),dailyReport([],db.officialQuotas(range.from,range.to_exclusive),[],range,range.to_exclusive).observation);
  assert.doesNotMatch(readFileSync(path,'utf8'),/private-A|"accountId":|estimated_tokens|matched_tokens/);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
