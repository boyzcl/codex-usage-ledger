import {mkdirSync,existsSync,chmodSync,writeFileSync,realpathSync,openSync,closeSync} from 'node:fs';
import {resolve,join,relative,dirname,basename} from 'node:path';
import {DatabaseSync,backup,requireBackupSupport} from './sqlite.js';
import {Ledger} from './store.js';
import {syncRollouts} from './ingest.js';
import {type Usage} from './types.js';
import {priceUsage} from './pricing.js';
import {sameFacts,sameContext} from './usage-policy.js';
import {hash} from './quota.js';
import {localDay} from './report.js';
export const repairVersion=2;
// SQLite's online backup includes committed WAL frames. The input is opened read-only.
export async function consistentBackup(input:string,output:string){
 requireBackupSupport();
 if(existsSync(output))throw Error('repair_output_exists');
 const source=new DatabaseSync(resolve(input),{readOnly:true});
 try{
  try{closeSync(openSync(output,'wx',0o600));}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('repair_output_exists');throw e;}
  await backup(source,resolve(output));chmodSync(output,0o600);
 }finally{source.close();}
}
export async function repairPreview(input:string,codexHome:string,outDir:string,timezone='UTC',progress?:(files:number,total:number)=>void,captured?:{path:string;sync:Awaited<ReturnType<typeof syncRollouts>>;source_scan_started_at:string|null;baseline_captured_at:string|null}){
 requireBackupSupport();
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
 await consistentBackup(input,baseline);const baselineCapturedAt=captured?captured.baseline_captured_at:new Date().toISOString();
 await consistentBackup(baseline,repairedPath);
 if(captured)await consistentBackup(captured.path,parsedPath);
 const corrected=new Ledger(repairedPath),fresh=new Ledger(parsedPath);chmodSync(parsedPath,0o600);
 try{
  const rules=corrected.rules();fresh.savePrices(rules);
  const sourceScanStartedAt=captured?captured.source_scan_started_at:new Date().toISOString();const sync=captured?.sync??await syncRollouts(fresh,codexHome,rules,progress);
  const before=corrected.records(),after=fresh.records(),newById=new Map(after.map(r=>[r.id,r])),beforeIds=new Set(before.map(r=>r.id));
  const candidates=fresh.db.prepare('SELECT raw_json,disposition FROM legacy_candidates').all();
  const decisions=new Map(candidates.map(c=>[(JSON.parse(c.raw_json as string) as Usage).id,c.disposition as string]));
  const summary=new Map<string,{date:string;model:string;issue:string;before_records:number;after_records:number;pending_records:number;before_tokens:number;after_tokens:number;pending_fact_tokens:number}>();
  let changed=0,excluded=0,added=0,retained=0,pending=0,conflicts=0,addedQuota=0;
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
   // Source snapshots collected after the baseline are append-only. Same-ID facts must agree;
   // preserve the original raw payload when only representation or extra metadata differs.
   const quotaConflict=corrected.db.prepare(`SELECT 1 FROM quota_snapshots q JOIN reparsed.quota_snapshots r USING(id)
    WHERE q.timestamp IS NOT r.timestamp OR q.limit_id IS NOT r.limit_id OR q.slot IS NOT r.slot
     OR q.window_duration_mins IS NOT r.window_duration_mins OR q.resets_at IS NOT r.resets_at
     OR q.used_percent IS NOT r.used_percent OR q.source IS NOT r.source LIMIT 1`).get();
   if(quotaConflict)throw Error('repair_quota_fact_conflict');
   addedQuota=Number(corrected.db.prepare('INSERT OR IGNORE INTO quota_snapshots SELECT * FROM reparsed.quota_snapshots').run().changes);
   for(const c of corrected.db.prepare('SELECT raw_json FROM legacy_candidates').all()){
    const row=JSON.parse(c.raw_json as string) as Usage;
    corrected.db.prepare('INSERT OR IGNORE INTO legacy_candidate_history VALUES (?,?,?)').run(row.id,c.raw_json,'source_unavailable');
   }
   // Retained exact facts still support their proven turn or specific event link.
   for(const table of ['ingest_files','legacy_events','legacy_candidates'])corrected.db.exec(`DELETE FROM ${table}; INSERT INTO ${table} SELECT * FROM reparsed.${table}`);
   for(const table of ['exact_turns','exact_legacy_links'])corrected.db.exec(`INSERT OR IGNORE INTO ${table} SELECT * FROM reparsed.${table}`);
   const sourceFacts=new Map(candidates.map(c=>{const r=JSON.parse(c.raw_json as string) as Usage;return [r.id,r];}));
   for(const c of fresh.db.prepare('SELECT raw_json,reason FROM usage_conflicts').all())corrected.recordVariants([JSON.parse(c.raw_json as string)],c.reason as string);
   for(const state of fresh.db.prepare('SELECT * FROM usage_conflict_state').all()){
    if(state.status==='open'){
     const disputed=fresh.db.prepare('SELECT raw_json FROM usage_conflicts WHERE id=?').all(state.id).map(v=>JSON.parse(v.raw_json as string) as Usage);
     for(const row of disputed)corrected.insertUsage(row);
    }else if(!corrected.conflicted(state.id as string))corrected.db.prepare('INSERT OR REPLACE INTO usage_conflict_state VALUES (?,?,?)').run(state.id,state.status,state.reason);
   }
   for(const [id,row] of sourceFacts){
    const old=corrected.db.prepare('SELECT raw_json FROM legacy_candidate_history WHERE id=?').get(id);
    if(old&&!sameFacts(JSON.parse(old.raw_json as string),row))corrected.quarantine([JSON.parse(old.raw_json as string),row]);
   }
   for(const old of before){
    const parsed=newById.get(old.id);newById.delete(old.id);
    const fact=parsed??sourceFacts.get(old.id);
    if(corrected.conflicted(old.id)||fact&&!sameFacts(old,fact)){
     const reason=fact&&!sameFacts(old,fact)?'token_fact_conflict':corrected.db.prepare('SELECT reason FROM usage_conflict_state WHERE id=?').get(old.id)!.reason as string;
     corrected.quarantine(fact?[old,fact]:[old],reason);conflicts++;const status=reason==='token_fact_conflict'?'pending_token_fact_conflict':'pending_attribution_conflict';count(old,null,status);evidence(old,null,status);continue;
    }
    const disposition=decisions.get(old.id);
    const exact=corrected.superseded(old)||fresh.superseded(old)||disposition==='superseded';
    if(disposition==='replayed'||disposition==='pending'||exact){
     corrected.db.prepare('DELETE FROM usage_records WHERE id=?').run(old.id);
     const status=disposition==='pending'?'pending_parent_history':exact?'excluded_superseded_by_exact':'excluded_inherited_history';
     if(disposition==='pending')pending++;else excluded++;count(old,null,status);evidence(old,null,status);continue;
    }
    if(parsed){
     corrected.insertUsage(parsed,'repair');
     const saved=corrected.db.prepare('SELECT raw_json FROM usage_records WHERE id=?').get(old.id);
     const next=saved?JSON.parse(saved.raw_json as string) as Usage:null;
     if(!next){conflicts++;count(old,null,'pending_attribution_conflict');evidence(old,null,'pending_attribution_conflict');}
     else if(!sameContext(old,next)){changed++;count(old,next,'corrected_attribution');evidence(old,next,'corrected_attribution');}
    }else{
     retained++;const next:Usage={...old,repair_status:'source_unavailable'};corrected.insertUsage(next,'retain');count(old,next,'retained_source_unavailable');evidence(old,next,'retained_source_unavailable');
    }
   }
   for(const row of newById.values())if(corrected.insertUsage(row)){
    added++;count(null,row,'recovered_from_source');evidence(null,row,'recovered_from_source');
   }
   // Pending facts not previously in the ledger remain in candidates, never masquerade as confirmed usage.
   for(const c of candidates)if(c.disposition==='pending'){const row=JSON.parse(c.raw_json as string) as Usage;if(!beforeIds.has(row.id)){pending++;const date=localDay(row.timestamp,timezone),key=JSON.stringify([date,row.model,'pending_parent_history']);if(!summary.has(key))summary.set(key,{date,model:row.model,issue:'pending_parent_history',before_records:0,after_records:0,pending_records:0,before_tokens:0,after_tokens:0,pending_fact_tokens:0});const s=summary.get(key)!;s.pending_records++;s.pending_fact_tokens+=row.total_tokens;}}
   corrected.db.exec('INSERT OR IGNORE INTO legacy_candidate_history SELECT * FROM reparsed.legacy_candidate_history');
   corrected.db.exec('INSERT OR IGNORE INTO ingest_issues SELECT * FROM reparsed.ingest_issues');
   for(const c of corrected.db.prepare("SELECT x.raw_json,s.reason FROM usage_conflicts x JOIN usage_conflict_state s USING(id) WHERE s.status='open'").all())corrected.quarantine([JSON.parse(c.raw_json as string)],c.reason as string);
   corrected.reconcileLegacy(undefined,'repair');
   corrected.set('ledger_repair_version',repairVersion);corrected.legacySummary();
   // Persisted capacity estimates may refer to the previous attribution. They must be recomputed.
   corrected.preserveEstimates('invalidated_by_repair');corrected.db.exec('DELETE FROM capacity_estimates');corrected.set('latest_estimates',[]);
  });
  const unavailable=corrected.db.prepare("SELECT h.raw_json FROM legacy_candidate_history h WHERE NOT EXISTS (SELECT 1 FROM usage_conflicts x WHERE x.id=h.id) AND NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.id=h.id) AND h.id NOT IN (SELECT json_extract(raw_json,'$.id') FROM legacy_candidates)").all();
  for(const c of unavailable){const row=JSON.parse(c.raw_json as string) as Usage,date=localDay(row.timestamp,timezone),key=JSON.stringify([date,row.model,'retained_unavailable_candidate_fact']);if(!summary.has(key))summary.set(key,{date,model:row.model,issue:'retained_unavailable_candidate_fact',before_records:0,after_records:0,pending_records:0,before_tokens:0,after_tokens:0,pending_fact_tokens:0});const s=summary.get(key)!;s.pending_records++;s.pending_fact_tokens+=row.total_tokens;}
  const result={projection_recomputed_at:new Date().toISOString(),captured_source_reused:!!captured,version:repairVersion,baseline_captured_at:baselineCapturedAt,source_scan_started_at:sourceScanStartedAt,source_scan_finished_at:sync.synced_at,input_read_only:true,production_overwritten:false,timezone,added_quota_snapshots:addedQuota,changed_attribution_records:changed,excluded_records:excluded,new_records:added,retained_source_unavailable_records:retained,pending_records:pending,retained_unavailable_candidate_records:unavailable.length,affected_prior_conflict_records:conflicts,token_conflicts:corrected.db.prepare("SELECT COUNT(*) n FROM usage_conflict_state WHERE status='open' AND reason='token_fact_conflict'").get()!.n,before:{records:before.length,tokens:before.reduce((n,r)=>n+r.total_tokens,0)},conflict_evidence:{records:corrected.db.prepare("SELECT COUNT(*) n FROM usage_conflict_state WHERE status='open'").get()!.n,resolved_attribution_records:corrected.db.prepare("SELECT COUNT(*) n FROM usage_conflict_state WHERE status='resolved_by_owner'").get()!.n,variants:corrected.db.prepare('SELECT COUNT(*) n FROM usage_conflicts').get()!.n,quantity:null,reason:'Disputed variants are evidence, not additive usage or zero usage.'},after:{records:corrected.records().length,tokens:corrected.records().reduce((n,r)=>n+r.total_tokens,0)},legacy:corrected.get('legacy_reconciliation'),sync,summary:[...summary.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),files:{baseline,reparsed:parsedPath,repaired:repairedPath},limitations:['Account and quota-window identity remain unverified.','Missing source records are retained; unavailable history is not invented.','Re-attribution uses only originally referenced immutable price rules; unavailable pricing remains null.','Sources are read per file after the database backup; new records may include activity after backup.','Concurrent source changes are deferred; retained rows require later recheck.']};
  writeFileSync(join(outDir,'preview.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
 }finally{fresh.close();corrected.close();}
}

// Re-adjudicate an isolated source capture. Retain all candidate facts and history;
// copied exact evidence or quarantined legacy sequences require their source files again.
export async function reconcileCapturedSource(db:Ledger,home:string,progress?:(files:number,total:number)=>void){
 const records=db.records(),variants=db.db.prepare('SELECT raw_json FROM usage_conflicts').all().map(v=>JSON.parse(v.raw_json as string) as Usage);
 const checkpoints=db.db.prepare('SELECT path,state_json FROM ingest_files').all();
 const byHash=new Map(checkpoints.map(c=>[hash(c.path),c.path as string]));
 const disputedIds=new Set(variants.map(v=>v.id));const required=new Set<string>();
 for(const c of checkpoints)if(JSON.parse(c.state_json as string).parent_thread_id)required.add(c.path as string);
 for(const v of [...records,...variants])if(v.inherited||disputedIds.has(v.id)){
  const path=v.origin_source?byHash.get(v.origin_source):undefined;
  if(path)required.add(path);else if(v.source==='legacy_token_count')throw Error('captured_legacy_sequence_incomplete');
 }
 db.transaction(()=>{
  db.db.exec('DELETE FROM usage_records; DELETE FROM usage_conflict_state; DELETE FROM usage_conflicts');
  // Do not reuse old disposition or conflict reason as the current verdict.
  for(const row of [...records,...variants])db.insertUsage(priceUsage(row,db.rules()));
  db.reconcileLegacy();db.legacySummary();
  for(const path of required)db.db.prepare('DELETE FROM ingest_files WHERE path=?').run(path);
 });
 const started=new Date().toISOString();const sync=await syncRollouts(db,home,db.rules(),progress,[...required]);
 return {started_at:started,finished_at:sync.synced_at,original_files:checkpoints.length,reused_candidate_facts:db.db.prepare('SELECT COUNT(*) n FROM legacy_candidates').get()!.n,reconsidered_variants:variants.length,required_source_files:required.size,sync};
}
