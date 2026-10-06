#!/usr/bin/env node
// Offline, immutable parameter registration and later holdout evaluation. No DB.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
const {positionals,values}=parseArgs({allowPositionals:true,options:{input:{type:'string'},epoch:{type:'string'},cutoff:{type:'string'},deadline:{type:'string'},out:{type:'string'},registration:{type:'string'}}});
const digest=s=>createHash('sha256').update(s).digest('hex');
const load=path=>JSON.parse(readFileSync(path,'utf8'));
const conditional=file=>file.conditional_capacity??file;
const requireValue=(ok,reason)=>{if(!ok)throw Error(reason);};
const share=(mix,total)=>Object.fromEntries(mix.map(m=>[JSON.stringify([m.model,m.service_tier]),total?m.total_tokens/total:0]));
const cacheShare=mix=>{const input=mix.reduce((n,m)=>n+m.input_tokens,0);return input?mix.reduce((n,m)=>n+m.cached_input_tokens,0)/input:0;};
const outputShare=(mix,total)=>total?mix.reduce((n,m)=>n+m.output_tokens,0)/total:0;
requireValue(values.input&&values.out,'input_and_new_output_required');
const text=readFileSync(values.input,'utf8'),data=conditional(JSON.parse(text));
requireValue(data.basis==='fixed_price_conditional_equivalence','conditional_report_required');
let result;
if(positionals[0]==='register'){
 const w=data.windows.find(w=>w.id===values.epoch),cutoff=Date.parse(values.cutoff),deadline=Date.parse(values.deadline);
 requireValue(w?.api.equivalent_100_percent>0&&w.percent_points>0,'priced_training_epoch_required');
 const training=data.intervals.filter(i=>w.interval_ids.includes(i.id));
 requireValue(Number.isFinite(cutoff)&&Number.isFinite(deadline)&&deadline>cutoff&&training.every(i=>Date.parse(i.to)<=cutoff),'cutoff_after_training_and_before_deadline_required');
 requireValue(cutoff<=Date.now()&&deadline>Date.now(),'historical_training_and_future_deadline_required');
 result={schema_version:1,kind:'conditional_prediction_registration',registered_at:new Date().toISOString(),training_input_sha256:digest(text),training_epoch_id:w.id,training_cutoff:new Date(cutoff).toISOString(),holdout_not_before:new Date().toISOString(),deadline:new Date(deadline).toISOString(),window:{scope:w.scope,limit_id:w.limit_id,slot:w.slot,window_duration_mins:w.window_duration_mins,reset_anchor:w.reset_anchor,policy:w.policy},price_basis:data.price_basis,api_equivalent_100_percent:w.api.equivalent_100_percent,credit_equivalent_100_percent:w.credits.equivalent_100_percent,api_coverage:w.api.token_coverage,credit_coverage:w.credits.token_coverage,mix:w.mix,total_tokens:w.total_tokens,unknown_channel_fraction:w.records?w.unknown_channel_records/w.records:0,account_coverage:data.account_coverage,reference:data.reference,validation_contract:{mix_tolerance_pp:5,pricing_coverage_tolerance_pp:5,unknown_channel_tolerance_pp:5,same_policy_and_observed_window_required:true,all_usage_after_training_cutoff_and_registration:true,refit_allowed:false},status:'registered_unvalidated',validated:false};
}else if(positionals[0]==='validate'){
 requireValue(values.registration,'registration_required');const reg=load(values.registration);
 requireValue(reg.kind==='conditional_prediction_registration','valid_registration_required');
 requireValue(data.price_basis.catalogue_id===reg.price_basis.catalogue_id&&Date.parse(data.price_basis.at)===Date.parse(reg.price_basis.at),'frozen_prices_required');
 const candidates=data.windows.filter(w=>JSON.stringify(w.scope)===JSON.stringify(reg.window.scope)&&w.limit_id===reg.window.limit_id&&w.slot===reg.window.slot&&w.window_duration_mins===reg.window.window_duration_mins&&Math.abs(w.reset_anchor-reg.window.reset_anchor)<=1&&JSON.stringify(w.policy)===JSON.stringify(reg.window.policy));
 requireValue(candidates.length===1,'same_single_window_and_policy_required');const w=candidates[0],intervals=data.intervals.filter(i=>w.interval_ids.includes(i.id));
 requireValue(intervals.length>0&&intervals.every(i=>i.from>=reg.training_cutoff&&i.from>=reg.holdout_not_before&&i.to<=reg.deadline&&i.records.every(r=>r.timestamp>reg.training_cutoff&&r.timestamp>reg.holdout_not_before)),'future_only_within_deadline_required');
 const a=share(reg.mix,reg.total_tokens),b=share(w.mix,w.total_tokens),keys=new Set([...Object.keys(a),...Object.keys(b)]);
 const mixDrift=Math.max(...[...keys].map(k=>Math.abs((a[k]??0)-(b[k]??0))),Math.abs(cacheShare(reg.mix)-cacheShare(w.mix)),Math.abs(outputShare(reg.mix,reg.total_tokens)-outputShare(w.mix,w.total_tokens)))*100;
 const coverageDrift=Math.abs((w.api.token_coverage??0)-(reg.api_coverage??0))*100;
 const channelDrift=Math.abs((w.records?w.unknown_channel_records/w.records:0)-reg.unknown_channel_fraction)*100;
 const applicable=mixDrift<=reg.validation_contract.mix_tolerance_pp&&coverageDrift<=reg.validation_contract.pricing_coverage_tolerance_pp&&channelDrift<=reg.validation_contract.unknown_channel_tolerance_pp;
 const predicted=w.api.known_amount*100/reg.api_equivalent_100_percent;
 result={kind:'conditional_prediction_evaluation',registration_sha256:digest(readFileSync(values.registration)),future_input_sha256:digest(text),evaluated_at:new Date().toISOString(),training_cutoff:reg.training_cutoff,deadline:reg.deadline,actual_percent_points:w.percent_points,predicted_percent_points:predicted,error_percent_points:w.percent_points-predicted,mix_drift_pp:mixDrift,api_coverage_drift_pp:coverageDrift,unknown_channel_drift_pp:channelDrift,applicable,status:applicable?'evaluated_under_frozen_conditions':'conditions_changed',strict_capacity_verified:false,refit_executed:false};
}else throw Error('use_register_or_validate');
writeFileSync(values.out,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({path:values.out,status:result.status}));
