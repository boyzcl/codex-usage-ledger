import {quotaContext} from './quota-policy.js';
import type {QuotaScope} from './quota-policy.js';
import type {Quota} from './types.js';
export interface ObservationPoint {id:string;timestamp:string;used_percent:number;remaining_percent:number;}
export interface RemainingPoint extends ObservationPoint {event:'start'|'before_recovery'|'recovery'|'end';}
export interface ObservationBoundary {reason:string;from:ObservationPoint;to:ObservationPoint;positive_percent_points:number;}
export interface ObservationSegment {
 date:string;resets_at:number|null;split_reason:string;flags:string[];points:ObservationPoint[];
}
export interface PlanObservation {
 basis:'official_percentage_observation';scope:QuotaScope;limit_id:string;slot:string;window_duration_mins:number|null;
 observed_from:string;observed_to:string;from_percent:number;to_percent:number;observation_count:number;
 remaining:{basis:'100_minus_official_used_percent';from_percent:number;to_percent:number;trajectory:RemainingPoint[]};
 boundary_positive_percent_points:number|null;boundary_changes:ObservationBoundary[];
 percent_points:number|null;paired_changes:number;flags:string[];segments:ObservationSegment[];
}
function summarize(p:PlanObservation,segments:ObservationSegment[]):PlanObservation {
 const points=segments.flatMap(s=>s.points),paired=segments.reduce((n,s)=>n+(s.flags.includes('conflicting_snapshots')||s.flags.includes('unknown_identity')||s.flags.includes('invalid_window')?0:Math.max(0,s.points.length-1)),0);
 const trajectory:RemainingPoint[]=[{...points[0],event:'start'}];
 for(let i=1;i<points.length;i++)if(points[i].timestamp>points[i-1].timestamp&&points[i].used_percent<points[i-1].used_percent){
  if(trajectory.at(-1)!.used_percent!==points[i-1].used_percent)trajectory.push({...points[i-1],event:'before_recovery'});
  trajectory.push({...points[i],event:'recovery'});
 }
 const last=points.at(-1)!;
 if(last.id!==trajectory.at(-1)!.id&&(trajectory.length===1||last.used_percent!==trajectory.at(-1)!.used_percent))trajectory.push({...last,event:'end'});
 const known=!!p.scope.account_ref&&p.scope.status!=='mixed'&&!segments.some(s=>s.flags.includes('unknown_identity')||s.flags.includes('conflicting_snapshots'));
 const boundaries=known?segments.slice(1).flatMap((s,i)=>{const from=segments[i].points.at(-1)!,to=s.points[0],delta=to.used_percent-from.used_percent;return delta>0?[{reason:s.split_reason,from,to,positive_percent_points:delta}]:[];}):[];
 return {...p,segments,remaining:{basis:'100_minus_official_used_percent',from_percent:100-points[0].used_percent,to_percent:100-last.used_percent,trajectory},boundary_changes:boundaries,boundary_positive_percent_points:known?boundaries.reduce((n,b)=>n+b.positive_percent_points,0):null,observed_from:points[0].timestamp,observed_to:points.at(-1)!.timestamp,from_percent:points[0].used_percent,to_percent:points.at(-1)!.used_percent,observation_count:points.length,paired_changes:paired,
  percent_points:paired?segments.reduce((n,s)=>n+(s.flags.includes('conflicting_snapshots')||s.flags.includes('unknown_identity')||s.flags.includes('invalid_window')?0:s.points.at(-1)!.used_percent-s.points[0].used_percent),0):null,
  flags:[...new Set(segments.flatMap(s=>[...s.flags,...(s.split_reason==='start'?[]:[s.split_reason])]))]};
}
export function observationsForDay(plans:PlanObservation[],date:string):PlanObservation[]{
 return plans.flatMap(p=>{const segments=p.segments.filter(s=>s.date===date);return segments.length?[summarize(p,segments)]:[];});
}
// Traverse timestamp frames globally before maintaining parallel bucket/slot lanes.
// A scope A -> B -> A transition closes every lane; grouping by identity first would bridge it.
export function planObservations(quotas:Quota[],range:{from:string;to_exclusive:string;timezone:string}):PlanObservation[]{
 const qs=quotas.filter(q=>q.source==='app_server'&&q.timestamp>=range.from&&q.timestamp<range.to_exclusive&&Number.isFinite(q.used_percent)&&q.used_percent>=0&&q.used_percent<=100).slice().sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id));
 const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:range.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
 const result:PlanObservation[]=[],lanes=new Map<string,PlanObservation>();let lastScope:string|undefined;
 for(let i=0;i<qs.length;){
  let end=i+1;while(end<qs.length&&qs[end].timestamp===qs[i].timestamp)end++;
  const frame=qs.slice(i,end),identities=new Set(frame.map(q=>{const s=quotaContext(q).scope;return JSON.stringify([s.account_ref,s.workspace_ref,s.billing_source]);}));
  const frameScope=[...identities][0],ambiguous=identities.size>1||frame.some(q=>quotaContext(q).scope.status==='mixed'||quotaContext(q).evidence?.origin==='ambiguous_observations');
  const scopeChange=frameScope!==lastScope;
  if(scopeChange||ambiguous)lanes.clear();
  const categories=new Map<string,Quota[]>();for(const q of frame){const key=JSON.stringify([q.limit_id,q.slot]);if(!categories.has(key))categories.set(key,[]);categories.get(key)!.push(q);}
  // An absent category is also a boundary: A -> B -> A must not revive A's old anchor.
  for(const lane of lanes.keys())if(!categories.has(lane))lanes.delete(lane);
  for(const [lane,raw] of categories){
   const values=[...new Map(raw.map(q=>[JSON.stringify([q.used_percent,q.window_duration_mins,q.resets_at,quotaContext(q).scope.account_ref,quotaContext(q).scope.workspace_ref,quotaContext(q).scope.billing_source]),q])).values()];
   const conflict=ambiguous||values.length>1;
   for(const q of values){
    const scope=quotaContext(q).scope,known=!!scope.account_ref&&scope.status!=='mixed'&&!ambiguous;
    let p=lanes.get(lane);const durationChange=!!p&&p.window_duration_mins!==q.window_duration_mins;
    if(!p||durationChange||conflict){p={basis:'official_percentage_observation',scope,limit_id:q.limit_id,slot:q.slot,window_duration_mins:q.window_duration_mins,observed_from:q.timestamp,observed_to:q.timestamp,from_percent:q.used_percent,to_percent:q.used_percent,observation_count:0,percent_points:null,paired_changes:0,remaining:{basis:'100_minus_official_used_percent',from_percent:100-q.used_percent,to_percent:100-q.used_percent,trajectory:[]},boundary_positive_percent_points:null,boundary_changes:[],flags:[],segments:[]};result.push(p);lanes.set(lane,p);}
    const date=dayFormat.format(new Date(q.timestamp)),previous=p.segments.at(-1),point=previous?.points.at(-1);
    const invalid=!Number.isFinite(q.resets_at)||!Number.isFinite(q.window_duration_mins)||q.resets_at===null||q.window_duration_mins===null||q.window_duration_mins<=0||Date.parse(q.timestamp)>=q.resets_at*1000||Date.parse(q.timestamp)<(q.resets_at-q.window_duration_mins*60)*1000;
    const reason=conflict?'conflicting_snapshots':!known?'unknown_identity':invalid?'invalid_window':durationChange?'window_change':!previous?(scopeChange&&lastScope!==undefined?'scope_change':'start'):previous.flags.includes('conflicting_snapshots')?'after_conflict':previous.flags.includes('invalid_window')?'after_invalid_window':previous.date!==date?'day_boundary':previous.resets_at!==q.resets_at?'reset_deadline_change':q.used_percent<point!.used_percent?'percent_decrease':null;
    const flags=[...(conflict?['conflicting_snapshots']:[]),...(!known?['unknown_identity']:[]),...(invalid?['invalid_window']:[])];
    if(reason)p.segments.push({date,resets_at:q.resets_at,split_reason:reason,flags,points:[]});
    const segment=p.segments.at(-1)!;
    if(!reason&&Date.parse(q.timestamp)-Date.parse(point!.timestamp)>30*60000)segment.flags.push('sampling_gap');
    segment.points.push({id:q.id,timestamp:q.timestamp,used_percent:q.used_percent,remaining_percent:100-q.used_percent});
   }
   if(conflict)lanes.delete(lane);
  }
  if(ambiguous)lanes.clear();lastScope=ambiguous?undefined:frameScope;i=end;
 }
 return result.map(p=>summarize(p,p.segments));
}
