import {mkdirSync,existsSync,chmodSync,writeFileSync,realpathSync,openSync,closeSync} from 'node:fs';
import {resolve,join,relative,dirname,basename} from 'node:path';
import {DatabaseSync,backup} from './sqlite.js';
import {Ledger} from './store.js';
import {syncRollouts} from './ingest.js';
import {tokenFields,type Usage} from './types.js';
import {priceUsage} from './pricing.js';
import {hash} from './quota.js';
import {localDay} from './report.js';
export const repairVersion=1;
// SQLite's online backup includes committed WAL frames. The input is opened read-only.
export async function consistentBackup(input:string,output:string){
 if(existsSync(output))throw Error('repair_output_exists');
 const source=new DatabaseSync(resolve(input),{readOnly:true});
 try{
  try{closeSync(openSync(output,'wx',0o600));}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('repair_output_exists');throw e;}
  await backup(source,resolve(output));chmodSync(output,0o600);
 }finally{source.close();}
}
const sameFacts=(a:Usage,b:Usage)=>tokenFields.every(k=>a[k]===b[k]);
const contextKeys=['thread_id','session_id','turn_id','root_turn_id','timestamp','model','model_source','service_tier','reasoning_effort','project','source','inherited','attribution_quality','data_quality'] as const;
const sameContext=(a:Usage,b:Usage)=>contextKeys.every(k=>a[k]===b[k]);
export async function repairPreview(input:string,codexHome:string,outDir:string,timezone='UTC',progress?:(files:number,total:number)=>void){
 const canonical=(p:string):string=>existsSync(p)?realpathSync(p):join(canonical(dirname(p)),basename(p));
 input=realpathSync(input);codexHome=realpathSync(codexHome);outDir=canonical(resolve(outDir));
 new Intl.DateTimeFormat('en',{timeZone:timezone});
 // All outputs must be new, outside the read-only source trees.
 if(existsSync(outDir))throw Error('repair_output_exists');
 const within=(a:string,b:string)=>{const r=relative(a,b);return !r||(!r.startsWith('..')&&!r.startsWith('/'));};
 if(within(codexHome,outDir)||within(outDir,codexHome))throw Error('repair_output_overlaps_source');
 mkdirSync(dirname(outDir),{recursive:true,mode:0o700});
 try{mkdirSync(outDir,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('repair_output_exists');throw e;}
 outDir=realpathSync(outDir);
 if(within(codexHome,outDir)||within(outDir,codexHome))throw Error('repair_output_overlaps_source');
 const baseline=join(outDir,'baseline.db'),parsedPath=join(outDir,'reparsed.db'),repairedPath=join(outDir,'repaired.db');
 await consistentBackup(input,baseline);const baselineCapturedAt=new Date().toISOString();
 await consistentBackup(baseline,repairedPath);
 const corrected=new Ledger(repairedPath),fresh=new Ledger(parsedPath);chmodSync(parsedPath,0o600);
 try{
  const rules=corrected.rules();fresh.savePrices(rules);
  const sourceScanStartedAt=new Date().toISOString();const sync=await syncRollouts(fresh,codexHome,rules,progress);
  const before=corrected.records(),after=fresh.records(),newById=new Map(after.map(r=>[r.id,r])),beforeIds=new Set(before.map(r=>r.id));
  const candidates=fresh.db.prepare('SELECT raw_json,disposition FROM legacy_candidates').all();
  const decisions=new Map(candidates.map(c=>[(JSON.parse(c.raw_json as string) as Usage).id,c.disposition as string]));
  const summary=new Map<string,{date:string;model:string;issue:string;before_records:number;after_records:number;pending_records:number;before_tokens:number;after_tokens:number;pending_fact_tokens:number}>();
  let changed=0,excluded=0,added=0,retained=0,pending=0,conflicts=0;
  const count=(old:Usage|null,next:Usage|null,issue:string)=>{
   for(const [row,side] of [[old,'before_tokens'],[next,'after_tokens']] as const){if(!row)continue;const date=localDay(row.timestamp,timezone),key=JSON.stringify([date,row.model,issue]);
    if(!summary.has(key))summary.set(key,{date,model:row.model,issue,before_records:0,after_records:0,pending_records:0,before_tokens:0,after_tokens:0,pending_fact_tokens:0});const s=summary.get(key)!;s[side]+=row.total_tokens;if(side==='before_tokens')s.before_records++;else s.after_records++;
   }
  };
  const evidence=(old:Usage|null,next:Usage|null,status:string)=>{
   const id=(old??next!).id;const prior=corrected.db.prepare('SELECT raw_json FROM repair_evidence WHERE id=?').get(id);
   const initial=prior?JSON.parse(prior.raw_json as string).before:old;
   corrected.db.prepare('INSERT OR REPLACE INTO repair_evidence VALUES (?,?,?,?)').run(id,repairVersion,status,JSON.stringify({before:initial,after:next,evidence:hash([next,decisions.get(id)??null]),version:repairVersion}));
  };
  // One commit applies the corrected view, source evidence and version. Interruption rolls it all back.
  corrected.db.prepare('ATTACH DATABASE ? AS reparsed').run(parsedPath);
  corrected.transaction(()=>{
   for(const c of corrected.db.prepare('SELECT raw_json FROM legacy_candidates').all()){
    const row=JSON.parse(c.raw_json as string) as Usage;
    corrected.db.prepare('INSERT OR IGNORE INTO legacy_candidate_history VALUES (?,?,?)').run(row.id,c.raw_json,'source_unavailable');
   }
   for(const old of before){
    const parsed=newById.get(old.id);newById.delete(old.id);
    if(parsed){
     if(!sameFacts(old,parsed)){conflicts++;count(old,old,'pending_token_fact_conflict');evidence(old,old,'pending_token_fact_conflict');continue;}
     if(sameContext(old,parsed)){if(old.repair_status)corrected.insertUsage({...old,repair_status:undefined},true);continue;}
     // Re-evaluate only historically referenced immutable prices; do not introduce today's prices.
     const pinned=new Set([old.api_rule_id,old.credit_rule_id,old.allowance_rule_id].filter(Boolean));
     const next=priceUsage({...parsed,source:old.source==='token_usage_record'?old.source:parsed.source,data_quality:old.source==='token_usage_record'?old.data_quality:parsed.data_quality},rules.filter(r=>pinned.has(r.id)));
     corrected.insertUsage(next,true);changed++;count(old,next,'corrected_attribution');evidence(old,next,'corrected_attribution');
    }else{
     const disposition=decisions.get(old.id);
     const exact=old.source==='legacy_token_count'&&old.turn_id!==null&&fresh.db.prepare('SELECT 1 FROM exact_turns WHERE thread_id=? AND turn_id=?').get(old.thread_id,old.turn_id??'');
     if(disposition==='replayed'||disposition==='pending'||exact){
      corrected.db.prepare('DELETE FROM usage_records WHERE id=?').run(old.id);
      const status=disposition==='pending'?'pending_parent_history':exact?'excluded_superseded_by_exact':'excluded_inherited_history';
      if(disposition==='pending')pending++;else excluded++;
      count(old,null,status);evidence(old,null,status);
     }else{retained++;const next:Usage={...old,repair_status:'source_unavailable'};corrected.insertUsage(next,true);count(old,next,'retained_source_unavailable');evidence(old,next,'retained_source_unavailable');}
    }
   }
   for(const row of newById.values()){corrected.insertUsage(row);added++;count(null,row,'recovered_from_source');evidence(null,row,'recovered_from_source');}
   // Pending facts not previously in the ledger remain in candidates, never masquerade as confirmed usage.
   for(const c of candidates)if(c.disposition==='pending'){const row=JSON.parse(c.raw_json as string) as Usage;if(!beforeIds.has(row.id)){pending++;const date=localDay(row.timestamp,timezone),key=JSON.stringify([date,row.model,'pending_parent_history']);if(!summary.has(key))summary.set(key,{date,model:row.model,issue:'pending_parent_history',before_records:0,after_records:0,pending_records:0,before_tokens:0,after_tokens:0,pending_fact_tokens:0});const s=summary.get(key)!;s.pending_records++;s.pending_fact_tokens+=row.total_tokens;}}
   for(const table of ['ingest_files','legacy_events','legacy_candidates','exact_turns']){corrected.db.exec(`DELETE FROM ${table}; INSERT INTO ${table} SELECT * FROM reparsed.${table}`);}
   corrected.db.exec('INSERT OR IGNORE INTO legacy_candidate_history SELECT * FROM reparsed.legacy_candidate_history');
   corrected.db.exec('INSERT OR IGNORE INTO ingest_issues SELECT * FROM reparsed.ingest_issues');
   corrected.set('ledger_repair_version',repairVersion);corrected.legacySummary();
   // Persisted capacity estimates may refer to the previous attribution. They must be recomputed.
   corrected.db.exec('DELETE FROM capacity_estimates');corrected.set('latest_estimates',[]);
  });
  const unavailable=corrected.db.prepare("SELECT h.raw_json FROM legacy_candidate_history h WHERE NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.id=h.id) AND NOT EXISTS (SELECT 1 FROM legacy_candidates c WHERE json_extract(c.raw_json,'$.id')=h.id)").all();
  for(const c of unavailable){const row=JSON.parse(c.raw_json as string) as Usage,date=localDay(row.timestamp,timezone),key=JSON.stringify([date,row.model,'retained_unavailable_candidate_fact']);if(!summary.has(key))summary.set(key,{date,model:row.model,issue:'retained_unavailable_candidate_fact',before_records:0,after_records:0,pending_records:0,before_tokens:0,after_tokens:0,pending_fact_tokens:0});const s=summary.get(key)!;s.pending_records++;s.pending_fact_tokens+=row.total_tokens;}
  const result={version:repairVersion,baseline_captured_at:baselineCapturedAt,source_scan_started_at:sourceScanStartedAt,source_scan_finished_at:sync.synced_at,input_read_only:true,production_overwritten:false,timezone,changed_attribution_records:changed,excluded_records:excluded,new_records:added,retained_source_unavailable_records:retained,pending_records:pending,retained_unavailable_candidate_records:unavailable.length,token_conflicts:conflicts,before:{records:before.length,tokens:before.reduce((n,r)=>n+r.total_tokens,0)},after:{records:corrected.records().length,tokens:corrected.records().reduce((n,r)=>n+r.total_tokens,0)},legacy:corrected.get('legacy_reconciliation'),sync,summary:[...summary.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),files:{baseline,reparsed:parsedPath,repaired:repairedPath},limitations:['Account and quota-window identity remain unverified.','Missing source records are retained; unavailable history is not invented.','Re-attribution uses only originally referenced immutable price rules; unavailable pricing remains null.','Sources are read per file after the database backup; new records may include activity after backup.','Concurrent source changes are deferred; retained rows require later recheck.']};
  writeFileSync(join(outDir,'preview.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
 }finally{fresh.close();corrected.close();}
}
