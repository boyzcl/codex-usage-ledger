import {DatabaseSync} from './sqlite.js';
import {tokenFields,type Usage,type Quota,type PriceRule,type ParseState} from './types.js';
import {hash,normalizeQuota,legacyQuotaId} from './quota.js';
import {quotaContext,quotaCycleKey,scopeKey,redactIdentity,officialSnapshot,recoveredContext,mergeContexts,contextFingerprint,type QuotaContext} from './quota-policy.js';
import {sameFacts,sameContext,authorityUpgrade,contextKeys,usageDecision,type UsageIntent} from './usage-policy.js';
import {priceUsage,validatePrices,validateCatalogue,canonicalJson,catalogueId} from './pricing.js';
export class Ledger {
 db:DatabaseSync;
 constructor(path:string){
  this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS usage_records(id TEXT PRIMARY KEY,response_id TEXT,thread_id TEXT,session_id TEXT,turn_id TEXT,timestamp TEXT,model TEXT,source TEXT,total_tokens INTEGER,raw_json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS usage_time ON usage_records(timestamp);
   CREATE INDEX IF NOT EXISTS usage_totals ON usage_records(total_tokens);
   CREATE INDEX IF NOT EXISTS usage_thread_turn ON usage_records(thread_id,turn_id);
   CREATE INDEX IF NOT EXISTS usage_exact_scope ON usage_records(thread_id,turn_id) WHERE source='token_usage_record';
   CREATE TABLE IF NOT EXISTS quota_snapshots(id TEXT PRIMARY KEY,timestamp TEXT,limit_id TEXT,slot TEXT,window_duration_mins INTEGER,resets_at INTEGER,used_percent REAL,source TEXT,raw_json TEXT);
   CREATE TABLE IF NOT EXISTS quota_context(id TEXT PRIMARY KEY,context_json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS quota_cycle ON quota_snapshots(limit_id,window_duration_mins,resets_at,timestamp);
   CREATE INDEX IF NOT EXISTS quota_latest ON quota_snapshots(limit_id,slot,timestamp DESC);
   CREATE TABLE IF NOT EXISTS account_usage_snapshots(id TEXT PRIMARY KEY,timestamp TEXT,raw_json TEXT);
   CREATE TABLE IF NOT EXISTS ingest_files(path TEXT PRIMARY KEY,device TEXT,inode TEXT,size INTEGER,mtime REAL,offset INTEGER,state_json TEXT,updated_at TEXT);
   CREATE TABLE IF NOT EXISTS pricing_rules(id TEXT PRIMARY KEY,raw_json TEXT);
   CREATE TABLE IF NOT EXISTS valuation_runs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,raw_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS valuation_results(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,usage_id TEXT NOT NULL,timestamp TEXT NOT NULL,raw_json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS valuation_result_run ON valuation_results(run_id);
   CREATE TABLE IF NOT EXISTS capacity_estimates(id TEXT PRIMARY KEY,created_at TEXT,raw_json TEXT);
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
   CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp TEXT NOT NULL,source TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,raw_json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS observation_time ON observations(timestamp);
   CREATE TABLE IF NOT EXISTS ingest_issues(id TEXT PRIMARY KEY,file_key TEXT,offset INTEGER,code TEXT,timestamp TEXT);
   CREATE TABLE IF NOT EXISTS exact_turns(thread_id TEXT,turn_id TEXT,PRIMARY KEY(thread_id,turn_id));
   CREATE TABLE IF NOT EXISTS legacy_events(thread_id TEXT,event_index INTEGER,fingerprint TEXT,PRIMARY KEY(thread_id,event_index));
   CREATE INDEX IF NOT EXISTS legacy_parent_fingerprint ON legacy_events(thread_id,fingerprint);
   CREATE TABLE IF NOT EXISTS legacy_candidates(thread_id TEXT,event_index INTEGER,parent_thread_id TEXT,fingerprint TEXT,raw_json TEXT NOT NULL,disposition TEXT NOT NULL,PRIMARY KEY(thread_id,event_index));
   CREATE TABLE IF NOT EXISTS legacy_candidate_history(id TEXT PRIMARY KEY,raw_json TEXT NOT NULL,disposition TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS legacy_candidate_identity ON legacy_candidates(json_extract(raw_json,'$.id'));
   CREATE INDEX IF NOT EXISTS legacy_candidate_parent ON legacy_candidates(parent_thread_id);
   CREATE TABLE IF NOT EXISTS exact_legacy_links(legacy_id TEXT,response_id TEXT,PRIMARY KEY(legacy_id,response_id));
   CREATE INDEX IF NOT EXISTS exact_link_response ON exact_legacy_links(response_id,legacy_id);
   CREATE TABLE IF NOT EXISTS usage_conflicts(id TEXT,variant TEXT,reason TEXT,timestamp TEXT,raw_json TEXT NOT NULL,PRIMARY KEY(id,variant));
   CREATE TABLE IF NOT EXISTS usage_conflict_state(id TEXT PRIMARY KEY,status TEXT NOT NULL,reason TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS capacity_estimate_history(id TEXT PRIMARY KEY,cycle_id TEXT,created_at TEXT,status TEXT,raw_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS repair_evidence(id TEXT PRIMARY KEY,version INTEGER,status TEXT NOT NULL,raw_json TEXT NOT NULL);

  `);
  const columns=this.db.prepare('PRAGMA table_info(ingest_files)').all().map(x=>x.name);
  if(!columns.includes('prefix_hash'))this.db.exec('ALTER TABLE ingest_files ADD COLUMN prefix_hash TEXT');
  if(!columns.includes('parser_version'))this.db.exec('ALTER TABLE ingest_files ADD COLUMN parser_version INTEGER');
  if(!columns.includes('ctime'))this.db.exec('ALTER TABLE ingest_files ADD COLUMN ctime REAL');
  if(!this.get('quota_context_version'))this.transaction(()=>{this.recoverQuotaContexts();this.preserveEstimates('scope_migration');this.set('quota_context_version',1);});
 }
 close(){this.db.close();}
 transaction<T>(f:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=f();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 set(key:string,value:unknown){this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key,JSON.stringify(value));}
 get<T>(key:string):T|null{const r=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value as string):null;}
 observe(source:string,kind:string,status:string,raw:unknown,timestamp=new Date().toISOString()){
  return Number(this.db.prepare('INSERT INTO observations(timestamp,source,kind,status,raw_json) VALUES (?,?,?,?,?)').run(timestamp,source,kind,status,JSON.stringify(raw)).lastInsertRowid);
 }
 markExact(thread:string,turn:string){if(turn)this.db.prepare('INSERT OR IGNORE INTO exact_turns VALUES (?,?)').run(thread,turn);}
 linkExact(legacy:string,response:string){this.db.prepare('INSERT OR IGNORE INTO exact_legacy_links VALUES (?,?)').run(legacy,response);}
 superseded(row:Usage):boolean{
  if(row.source!=='legacy_token_count')return false;
  if(row.turn_id)return !!this.db.prepare("SELECT 1 FROM usage_records WHERE source='token_usage_record' AND thread_id=? AND turn_id=? LIMIT 1").get(row.thread_id,row.turn_id);
  return !!this.db.prepare("SELECT 1 FROM exact_legacy_links l JOIN usage_records u ON u.id=l.response_id WHERE l.legacy_id=? AND u.source='token_usage_record' AND u.thread_id=? AND NOT EXISTS (SELECT 1 FROM exact_legacy_links other JOIN legacy_candidates c ON json_extract(c.raw_json,'$.id')=+other.legacy_id WHERE other.response_id=l.response_id AND other.legacy_id<>l.legacy_id) LIMIT 1").get(row.id,row.thread_id);
 }
 conflicted(id:string){return this.db.prepare('SELECT status FROM usage_conflict_state WHERE id=?').get(id)?.status==='open';}
 recordVariants(rows:Usage[],reason:string){
  for(const row of rows)this.db.prepare('INSERT OR IGNORE INTO usage_conflicts VALUES (?,?,?,?,?)').run(row.id,hash([row.id,...tokenFields.map(k=>row[k]),...contextKeys.map(k=>row[k]),row.api_rule_id,row.credit_rule_id,row.allowance_rule_id,row.api_equivalent_usd,row.credit_equivalent,row.allowance_weight]),reason,row.timestamp,JSON.stringify(row));
 }
 quarantine(rows:Usage[],reason?:string){
  for(const id of new Set(rows.map(r=>r.id))){
   const prior=this.db.prepare('SELECT reason FROM usage_conflict_state WHERE id=?').get(id);
   const group=rows.filter(r=>r.id===id),known=this.db.prepare('SELECT raw_json FROM usage_conflicts WHERE id=?').all(id).map(v=>JSON.parse(v.raw_json as string) as Usage);
   const facts=[...known,...group],numeric=facts.some(v=>!sameFacts(facts[0],v));
   const selected=numeric||prior?.reason==='token_fact_conflict'?'token_fact_conflict':reason??prior?.reason as string??'attribution_conflict';
   this.recordVariants(group,selected);
   this.db.prepare('INSERT OR REPLACE INTO usage_conflict_state VALUES (?,?,?)').run(id,'open',selected);
   this.db.prepare("DELETE FROM legacy_events WHERE (thread_id,event_index) IN (SELECT thread_id,event_index FROM legacy_candidates WHERE json_extract(raw_json,'$.id')=?)").run(id);
   this.db.prepare("DELETE FROM legacy_candidates WHERE json_extract(raw_json,'$.id')=?").run(id);
   this.db.prepare('DELETE FROM usage_records WHERE id=?').run(id);
  }
 }
 insertUsage(row:Usage,intent:UsageIntent='append'):boolean{
  if(this.conflicted(row.id)){
   const state=this.db.prepare('SELECT reason FROM usage_conflict_state WHERE id=?').get(row.id)!;
   const variants=this.db.prepare('SELECT raw_json FROM usage_conflicts WHERE id=?').all(row.id).map(v=>JSON.parse(v.raw_json as string) as Usage);
   if(state.reason==='token_fact_conflict'||variants.some(v=>!sameFacts(v,row))){this.quarantine([row],'token_fact_conflict');return false;}
   // Only a strictly more reliable original can adjudicate copied attribution evidence.
   const owner=!row.inherited&&row.source==='token_usage_record'&&(row.origin_thread_id??row.thread_id)===row.thread_id;
   if(!owner||!variants.every(v=>usageDecision(v,row,'append')==='replace'||sameContext(v,row))){this.quarantine([row],'attribution_conflict');return false;}
   this.recordVariants([row],'attribution_conflict');this.db.prepare('UPDATE usage_conflict_state SET status=? WHERE id=?').run('resolved_by_owner',row.id);
  }
  const saved=this.db.prepare('SELECT raw_json FROM usage_records WHERE id=?').get(row.id);
  const prior=saved?JSON.parse(saved.raw_json as string) as Usage:null;
  if(prior){
   const decision=usageDecision(prior,row,intent);
   if(decision==='conflict'){this.quarantine([prior,row],sameFacts(prior,row)?'attribution_conflict':'token_fact_conflict');return false;}
   if(!sameContext(prior,row)&&((!prior.inherited&&row.inherited)||(prior.inherited&&!row.inherited)||prior.source!==row.source)){
    this.recordVariants([prior,row],'attribution_conflict');this.db.prepare('INSERT OR REPLACE INTO usage_conflict_state VALUES (?,?,?)').run(row.id,'resolved_by_owner','attribution_conflict');
   }
   if(decision==='keep'&&intent!=='retain'){
    if(intent==='repair'||intent==='reparse')row={...prior,repair_status:undefined,origin_source:prior.origin_source??row.origin_source,origin_thread_id:prior.origin_thread_id??row.origin_thread_id};
    else return false;
   }else if(intent!=='retain'&&!authorityUpgrade(prior,row)){
    const pinned=new Set([prior.api_rule_id,prior.credit_rule_id,prior.allowance_rule_id].filter(Boolean));
    if(row.model===prior.model&&row.service_tier===prior.service_tier)row={...row,api_equivalent_usd:prior.api_equivalent_usd,credit_equivalent:prior.credit_equivalent,allowance_weight:prior.allowance_weight,api_rule_id:prior.api_rule_id,credit_rule_id:prior.credit_rule_id,allowance_rule_id:prior.allowance_rule_id};
    else row=priceUsage(row,this.rules().filter(r=>pinned.has(r.id)));
   }
  }
  if(prior&&JSON.stringify(row)===JSON.stringify(prior))return false;
  if(this.superseded(row))return false;
  this.db.prepare('INSERT OR REPLACE INTO usage_records VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.response_id,row.thread_id,row.session_id,row.turn_id,row.timestamp,row.model,row.source,row.total_tokens,JSON.stringify(row));
  if(row.source==='token_usage_record'&&row.turn_id)this.markExact(row.thread_id,row.turn_id);
  return !saved;
 }
 insertQuota(q:Quota){
  const legacy=q.context?this.db.prepare('SELECT * FROM quota_snapshots WHERE id=?').get(legacyQuotaId(q)):undefined;
  if(legacy&&q.context&&legacy.id!==q.id){const old=this.quotaProjection(legacy as unknown as Quota);
   if(['timestamp','limit_id','slot','window_duration_mins','resets_at','used_percent','source','raw_json'].every(k=>legacy[k]===q[k as keyof Quota])){
    const context=quotaContext(old);
    // A mixed recovery still represents every referenced original response. Replaying one must not split it into new facts.
    if(context.evidence?.context_refs.includes(contextFingerprint(q.context)))return;
    if(scopeKey(context.scope)===scopeKey(q.context.scope))q={...q,id:old.id};
   }
  }
  this.db.prepare('INSERT OR IGNORE INTO quota_snapshots VALUES (?,?,?,?,?,?,?,?,?)').run(q.id,q.timestamp,q.limit_id,q.slot,q.window_duration_mins,q.resets_at,q.used_percent,q.source,q.raw_json);if(q.context)this.saveQuotaContext(q.id,q.context);}
 private saveQuotaContext(id:string,context:QuotaContext){
  const prior=this.db.prepare('SELECT context_json FROM quota_context WHERE id=?').get(id);
  context=mergeContexts(prior?JSON.parse(prior.context_json as string):undefined,context);
  this.db.prepare('INSERT OR REPLACE INTO quota_context VALUES (?,?)').run(id,JSON.stringify(context));
 }
 private recoverQuotaContexts(){
  const observations=this.db.prepare("SELECT id,timestamp,raw_json FROM observations WHERE source='app_server' AND kind='account/rateLimits/read' AND status='ok' ORDER BY timestamp,id").all();
  let latest:ReturnType<typeof officialSnapshot>|undefined;
  for(const ob of observations){const response=JSON.parse(ob.raw_json as string).response;if(!response)continue;
   for(const q of normalizeQuota(response,ob.timestamp as string,'app_server')){
    const old=this.db.prepare('SELECT * FROM quota_snapshots WHERE id=?').get(legacyQuotaId(q));
    if(old&&['timestamp','limit_id','slot','window_duration_mins','resets_at','used_percent','source','raw_json'].every(k=>old[k]===q[k as keyof Quota])&&q.context)this.saveQuotaContext(old.id as string,recoveredContext(q.context,Number(ob.id)));
   }
   const snapshot=officialSnapshot(response,ob.timestamp as string);const recovered=recoveredContext(snapshot,Number(ob.id));
   const previous=latest?.availability.sampled_at===ob.timestamp?latest:undefined;
   const context=mergeContexts(previous,recovered);
   latest={...snapshot,...context,buckets:snapshot.buckets.map(b=>({...b,...mergeContexts(previous?.buckets.find(p=>p.limit_id===b.limit_id),recoveredContext(b,Number(ob.id)))}))};
  }
  if(latest)this.set('official_availability',latest);
 }
 quotaProjection(q:Quota):Quota {const meta=this.db.prepare('SELECT context_json FROM quota_context WHERE id=?').get(q.id);return {...q,context:meta?JSON.parse(meta.context_json as string):quotaContext(q)};}
 quotaOutput(q:Quota){const projected=this.quotaProjection(q);const {raw_json,...row}=projected;return {...row,raw:redactIdentity(JSON.parse(raw_json))};}
 insertAccount(timestamp:string,raw:unknown){this.db.prepare('INSERT OR REPLACE INTO account_usage_snapshots VALUES (?,?,?)').run(hash([timestamp,raw]),timestamp,JSON.stringify(raw));}
 issue(path:string,offset:number,code:string,timestamp:string|null){this.db.prepare('INSERT OR IGNORE INTO ingest_issues VALUES (?,?,?,?,?)').run(hash([path,offset,code]),hash(path),offset,code,timestamp);}
 checkpoint(path:string):any{return this.db.prepare('SELECT * FROM ingest_files WHERE path=?').get(path);}
 saveCheckpoint(path:string,stat:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number},offset:number,state:ParseState,prefixHash:string){this.db.prepare('INSERT OR REPLACE INTO ingest_files(path,device,inode,size,mtime,offset,state_json,updated_at,prefix_hash,parser_version,ctime) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(path,String(stat.dev),String(stat.ino),stat.size,stat.mtimeMs,offset,JSON.stringify(state),new Date().toISOString(),prefixHash,3,stat.ctimeMs);}
 beginLegacyReplay(thread:string){
  // A rewritten sequence must not splice new counters into the old sequence.
  // Preserve removed pending facts outside the active chain; existing history stays visible and marked.
  for(const c of this.db.prepare('SELECT * FROM legacy_candidates WHERE thread_id=?').all(thread)){
   const row=JSON.parse(c.raw_json as string) as Usage;
   this.db.prepare('INSERT OR REPLACE INTO legacy_candidate_history VALUES (?,?,?)').run(row.id,c.raw_json,'source_unavailable');
   const old=this.db.prepare('SELECT raw_json FROM usage_records WHERE id=?').get(row.id);
   if(old)this.insertUsage({...JSON.parse(old.raw_json as string),repair_status:'source_unavailable'},'retain');
  }
  this.db.prepare('DELETE FROM legacy_candidates WHERE thread_id=?').run(thread);
  this.db.prepare('DELETE FROM legacy_events WHERE thread_id=?').run(thread);
 }
 saveLegacy(row:Usage,index:number){
  const stored=this.db.prepare('SELECT raw_json FROM legacy_candidate_history WHERE id=?').get(row.id)??this.db.prepare('SELECT raw_json FROM usage_records WHERE id=?').get(row.id)??this.db.prepare("SELECT raw_json FROM legacy_candidates WHERE json_extract(raw_json,'$.id')=? LIMIT 1").get(row.id);
  if(this.conflicted(row.id)){this.quarantine([row]);return;}
  if(stored){const old=JSON.parse(stored.raw_json as string) as Usage;if(!sameFacts(old,row)){this.quarantine([old,row]);return;}}
  this.db.prepare('DELETE FROM legacy_candidate_history WHERE id=?').run(row.id);
  this.db.prepare('INSERT OR REPLACE INTO legacy_events VALUES (?,?,?)').run(row.thread_id,index,row.fingerprint);
  this.db.prepare('INSERT OR REPLACE INTO legacy_candidates VALUES (?,?,?,?,?,?)').run(row.thread_id,index,row.parent_thread_id,row.fingerprint,JSON.stringify(row),'pending');
 }
 reconcileLegacy(threads?:string[],intent:UsageIntent='append'){
  const affected=new Set(threads);
  if(threads){const queue=[...threads];for(let i=0;i<queue.length;i++)for(const c of this.db.prepare('SELECT DISTINCT thread_id FROM legacy_candidates WHERE parent_thread_id=?').all(queue[i]))if(!affected.has(c.thread_id as string)){affected.add(c.thread_id as string);queue.push(c.thread_id as string);}}
  const candidates=threads?[...affected].flatMap(id=>this.db.prepare('SELECT * FROM legacy_candidates WHERE thread_id=? ORDER BY event_index').all(id)):this.db.prepare('SELECT * FROM legacy_candidates ORDER BY thread_id,event_index').all();
  const groups=new Map<string,typeof candidates>();for(const c of candidates){const id=c.thread_id as string;if(!groups.has(id))groups.set(id,[]);groups.get(id)!.push(c);}

  let added=0;
  for(const chain of groups.values()){
   let diverged=false,unanchored=false,next:number|null=null;
   const boundary=(JSON.parse(chain[0].raw_json as string) as Usage).fork_ordinal_exclusive;
   const parent=(chain[0].parent_thread_id?this.db.prepare('SELECT event_index,fingerprint,raw_json FROM legacy_candidates WHERE thread_id=? ORDER BY event_index').all(chain[0].parent_thread_id):[]).filter(p=>{if(boundary==null)return true;const ordinal=(JSON.parse(p.raw_json as string) as Usage).ordinal;return ordinal!==null&&ordinal<boundary;});
   const parentByIndex=new Map(parent.map(p=>[Number(p.event_index),p]));const parentByFingerprint=new Map<string,typeof parent[number]>();
   for(const p of parent)if(!parentByFingerprint.has(p.fingerprint as string))parentByFingerprint.set(p.fingerprint as string,p);
   for(const c of chain){const row=JSON.parse(c.raw_json as string) as Usage;let disposition='confirmed';
    if(this.conflicted(row.id))continue;
    if(c.parent_thread_id&&!diverged){
     if(!parent.length||unanchored)disposition='pending';
     else {
      const match:Record<string,unknown>|undefined=next===null?parentByFingerprint.get(c.fingerprint as string):parentByIndex.get(next);
      if(match&&match.fingerprint===c.fingerprint){next=Number(match.event_index)+1;disposition='replayed';}
      else if(next===null){unanchored=true;disposition='pending';}
      else diverged=true; // Only a contiguous replay prefix is excluded. Later equality is real usage.
     }
    }
    if(row.inherited)disposition='replayed';
    if(this.superseded(row))disposition='superseded';
    this.db.prepare('UPDATE legacy_candidates SET disposition=? WHERE thread_id=? AND event_index=?').run(disposition,c.thread_id,c.event_index);
    if(disposition==='confirmed'){if(this.insertUsage(row,intent))added++;}
    else {this.db.prepare("DELETE FROM usage_records WHERE id=? AND source='legacy_token_count'").run(row.id);}
   }
  }
  return added;
 }
 legacySummary(){
  const summary=this.db.prepare("SELECT disposition,COUNT(*) AS count,COALESCE(SUM(json_extract(raw_json,'$.total_tokens')),0) AS tokens FROM legacy_candidates GROUP BY disposition").all();
  this.set('legacy_reconciliation',{version:2,conflict_records:this.db.prepare("SELECT COUNT(*) n FROM usage_conflict_state WHERE status='open'").get()!.n,resolved_attribution_records:this.db.prepare("SELECT COUNT(*) n FROM usage_conflict_state WHERE status='resolved_by_owner'").get()!.n,pending_tokens:summary.find(s=>s.disposition==='pending')?.tokens??0,replayed_tokens:summary.find(s=>s.disposition==='replayed')?.tokens??0,confirmed_events:summary.find(s=>s.disposition==='confirmed')?.count??0,source_unavailable_candidate_tokens:this.db.prepare("SELECT COALESCE(SUM(json_extract(h.raw_json,'$.total_tokens')),0) AS total FROM legacy_candidate_history h WHERE NOT EXISTS (SELECT 1 FROM usage_conflicts x WHERE x.id=h.id) AND NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.id=h.id) AND h.id NOT IN (SELECT json_extract(raw_json,'$.id') FROM legacy_candidates)").get()!.total});
 }
 preserveEstimates(status:string){
  for(const r of this.db.prepare('SELECT * FROM capacity_estimates').all())this.db.prepare('INSERT OR IGNORE INTO capacity_estimate_history VALUES (?,?,?,?,?)').run(hash([r.id,r.created_at,r.raw_json]),r.id,r.created_at,status,r.raw_json);
  const latest=this.get<unknown[]>('latest_estimates');if(latest?.length)this.db.prepare('INSERT OR IGNORE INTO capacity_estimate_history VALUES (?,?,?,?,?)').run(hash(['latest_estimates',latest]),'latest_estimates',new Date().toISOString(),status,JSON.stringify(latest));
 }
 records(from='0000',to='9999'):Usage[]{return this.db.prepare('SELECT raw_json FROM usage_records WHERE timestamp>=? AND timestamp<? ORDER BY timestamp').all(from,to).map(x=>JSON.parse(x.raw_json as string));}
 officialQuotas(from='0000',to='9999'):Quota[]{return (this.db.prepare("SELECT * FROM quota_snapshots WHERE source='app_server' AND timestamp>=? AND timestamp<? ORDER BY timestamp").all(from,to) as unknown as Quota[]).map(q=>this.quotaProjection(q));}
 quotas():Quota[]{return (this.db.prepare('SELECT * FROM quota_snapshots ORDER BY timestamp,source').all() as unknown as Quota[]).map(q=>this.quotaProjection(q));}
 latestQuota(asOf=new Date().toISOString()):Quota[]{
  const official=this.get<{availability:{sampled_at:string}}>('official_availability');
  const timestamp=official?.availability.sampled_at&&official.availability.sampled_at<=asOf?official.availability.sampled_at:this.db.prepare("SELECT MAX(timestamp) AS latest FROM quota_snapshots WHERE source='app_server' AND timestamp<=?").get(asOf)?.latest;
  const rows=timestamp?this.db.prepare("SELECT * FROM quota_snapshots WHERE source='app_server' AND timestamp=?").all(timestamp):this.db.prepare('SELECT * FROM quota_snapshots WHERE timestamp=(SELECT MAX(timestamp) FROM quota_snapshots WHERE timestamp<=?)').all(asOf);
  return (rows as unknown as Quota[]).filter(q=>q.resets_at===null||q.resets_at>Date.parse(asOf)/1000).map(q=>this.quotaProjection(q));
 }
 cycleQuotas(cycles:Quota[]):Quota[]{return cycles.flatMap(q=>(this.db.prepare('SELECT * FROM quota_snapshots WHERE source=? AND limit_id=? AND slot=? AND window_duration_mins=? AND resets_at=? ORDER BY timestamp').all(q.source,q.limit_id,q.slot,q.window_duration_mins,q.resets_at) as unknown as Quota[]).map(r=>this.quotaProjection(r)).filter(r=>quotaCycleKey(r)===quotaCycleKey(q)));}

 latestAccount():any{const r=this.db.prepare('SELECT timestamp,raw_json FROM account_usage_snapshots ORDER BY timestamp DESC LIMIT 1').get();return r?{timestamp:r.timestamp,...JSON.parse(r.raw_json as string)}:null;}
 savePrices(rules:PriceRule[]){
  validatePrices(rules);this.db.exec('SAVEPOINT price_import');try{
   // Read and validate the same SQLite snapshot that receives the append.
   const existing=this.rules(),combined=new Map(existing.map(r=>[r.id,r]));
   for(const rule of rules){const old=combined.get(rule.id);if(old&&canonicalJson(old)!==canonicalJson(rule))throw Error('immutable_price_rule_changed');combined.set(rule.id,rule);}
   const catalogue=validateCatalogue([...combined.values()]);let added=0;
   for(const r of rules)added+=Number(this.db.prepare('INSERT OR IGNORE INTO pricing_rules VALUES (?,?)').run(r.id,JSON.stringify(r)).changes);
   this.db.exec('RELEASE price_import');return {added,rules:catalogue.length,catalogue_id:catalogueId(catalogue)};
  }catch(e){this.db.exec('ROLLBACK TO price_import; RELEASE price_import');throw e;}
 }
 rules():PriceRule[]{return this.db.prepare('SELECT raw_json FROM pricing_rules').all().map(x=>JSON.parse(x.raw_json as string));}
 issues(){return this.db.prepare('SELECT code,COUNT(*) AS count FROM ingest_issues GROUP BY code').all();}
}
