import {DatabaseSync} from './sqlite.js';
import {tokenFields,type Usage,type Quota,type PriceRule,type ParseState} from './types.js';
import {hash} from './quota.js';
export class Ledger {
 db:DatabaseSync;
 constructor(path:string){
  this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS usage_records(id TEXT PRIMARY KEY,response_id TEXT,thread_id TEXT,session_id TEXT,turn_id TEXT,timestamp TEXT,model TEXT,source TEXT,total_tokens INTEGER,raw_json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS usage_time ON usage_records(timestamp);
   CREATE INDEX IF NOT EXISTS usage_totals ON usage_records(total_tokens);
   CREATE INDEX IF NOT EXISTS usage_thread_turn ON usage_records(thread_id,turn_id);
   CREATE TABLE IF NOT EXISTS quota_snapshots(id TEXT PRIMARY KEY,timestamp TEXT,limit_id TEXT,slot TEXT,window_duration_mins INTEGER,resets_at INTEGER,used_percent REAL,source TEXT,raw_json TEXT);
   CREATE INDEX IF NOT EXISTS quota_cycle ON quota_snapshots(limit_id,window_duration_mins,resets_at,timestamp);
   CREATE INDEX IF NOT EXISTS quota_latest ON quota_snapshots(limit_id,slot,timestamp DESC);
   CREATE TABLE IF NOT EXISTS account_usage_snapshots(id TEXT PRIMARY KEY,timestamp TEXT,raw_json TEXT);
   CREATE TABLE IF NOT EXISTS ingest_files(path TEXT PRIMARY KEY,device TEXT,inode TEXT,size INTEGER,mtime REAL,offset INTEGER,state_json TEXT,updated_at TEXT);
   CREATE TABLE IF NOT EXISTS pricing_rules(id TEXT PRIMARY KEY,raw_json TEXT);
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
   CREATE TABLE IF NOT EXISTS repair_evidence(id TEXT PRIMARY KEY,version INTEGER,status TEXT NOT NULL,raw_json TEXT NOT NULL);

  `);
  const columns=this.db.prepare('PRAGMA table_info(ingest_files)').all().map(x=>x.name);
  if(!columns.includes('prefix_hash'))this.db.exec('ALTER TABLE ingest_files ADD COLUMN prefix_hash TEXT');
  if(!columns.includes('parser_version'))this.db.exec('ALTER TABLE ingest_files ADD COLUMN parser_version INTEGER');
  if(!columns.includes('ctime'))this.db.exec('ALTER TABLE ingest_files ADD COLUMN ctime REAL');
 }
 close(){this.db.close();}
 transaction<T>(f:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=f();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 set(key:string,value:unknown){this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key,JSON.stringify(value));}
 get<T>(key:string):T|null{const r=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value as string):null;}
 observe(source:string,kind:string,status:string,raw:unknown,timestamp=new Date().toISOString()){
  this.db.prepare('INSERT INTO observations(timestamp,source,kind,status,raw_json) VALUES (?,?,?,?,?)').run(timestamp,source,kind,status,JSON.stringify(raw));
 }
 markExact(thread:string,turn:string){this.db.prepare('INSERT OR IGNORE INTO exact_turns VALUES (?,?)').run(thread,turn);this.db.prepare("DELETE FROM usage_records WHERE thread_id=? AND COALESCE(turn_id,'')=? AND source='legacy_token_count'").run(thread,turn);}
 insertUsage(row:Usage,correct=false):boolean{
  if(row.source==='legacy_token_count'&&this.db.prepare('SELECT 1 FROM exact_turns WHERE thread_id=? AND turn_id=?').get(row.thread_id,row.turn_id??''))return false;
  const old=this.db.prepare('SELECT raw_json FROM usage_records WHERE id=?').get(row.id);
  if(old){const prior=JSON.parse(old.raw_json as string) as Usage;
   const quality=(x:Usage)=>(x.source==='token_usage_record'?4:0)+(x.inherited?0:2)+(x.model==='unknown'?0:1);
   if(correct&&prior.source==='token_usage_record'&&row.source!=='token_usage_record')return false;
   if(correct&&tokenFields.some(k=>row[k]!==prior[k]))throw Error('usage_token_fact_conflict');
   if(!correct&&quality(row)<=quality(prior))return false;
   if(JSON.stringify(row)===JSON.stringify(prior))return false;
  }
  this.db.prepare('INSERT OR REPLACE INTO usage_records VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.response_id,row.thread_id,row.session_id,row.turn_id,row.timestamp,row.model,row.source,row.total_tokens,JSON.stringify(row));return !old;
 }
 insertQuota(q:Quota){this.db.prepare('INSERT OR IGNORE INTO quota_snapshots VALUES (?,?,?,?,?,?,?,?,?)').run(q.id,q.timestamp,q.limit_id,q.slot,q.window_duration_mins,q.resets_at,q.used_percent,q.source,q.raw_json);}
 insertAccount(timestamp:string,raw:unknown){this.db.prepare('INSERT OR REPLACE INTO account_usage_snapshots VALUES (?,?,?)').run(hash([timestamp,raw]),timestamp,JSON.stringify(raw));}
 issue(path:string,offset:number,code:string,timestamp:string|null){this.db.prepare('INSERT OR IGNORE INTO ingest_issues VALUES (?,?,?,?,?)').run(hash([path,offset,code]),hash(path),offset,code,timestamp);}
 checkpoint(path:string):any{return this.db.prepare('SELECT * FROM ingest_files WHERE path=?').get(path);}
 saveCheckpoint(path:string,stat:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number},offset:number,state:ParseState,prefixHash:string){this.db.prepare('INSERT OR REPLACE INTO ingest_files(path,device,inode,size,mtime,offset,state_json,updated_at,prefix_hash,parser_version,ctime) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(path,String(stat.dev),String(stat.ino),stat.size,stat.mtimeMs,offset,JSON.stringify(state),new Date().toISOString(),prefixHash,2,stat.ctimeMs);}
 beginLegacyReplay(thread:string){
  // A rewritten sequence must not splice new counters into the old sequence.
  // Preserve removed pending facts outside the active chain; existing history stays visible and marked.
  for(const c of this.db.prepare('SELECT * FROM legacy_candidates WHERE thread_id=?').all(thread)){
   const row=JSON.parse(c.raw_json as string) as Usage;
   this.db.prepare('INSERT OR REPLACE INTO legacy_candidate_history VALUES (?,?,?)').run(row.id,c.raw_json,'source_unavailable');
   const old=this.db.prepare('SELECT raw_json FROM usage_records WHERE id=?').get(row.id);
   if(old)this.insertUsage({...JSON.parse(old.raw_json as string),repair_status:'source_unavailable'},true);
  }
  this.db.prepare('DELETE FROM legacy_candidates WHERE thread_id=?').run(thread);
  this.db.prepare('DELETE FROM legacy_events WHERE thread_id=?').run(thread);
 }
 saveLegacy(row:Usage,index:number){
  const old=this.db.prepare('SELECT raw_json FROM legacy_candidate_history WHERE id=?').get(row.id);
  if(old&&tokenFields.some(k=>row[k]!==JSON.parse(old.raw_json as string)[k]))throw Error('usage_token_fact_conflict');
  this.db.prepare('DELETE FROM legacy_candidate_history WHERE id=?').run(row.id);
  this.db.prepare('INSERT OR REPLACE INTO legacy_events VALUES (?,?,?)').run(row.thread_id,index,row.fingerprint);
  this.db.prepare('INSERT OR REPLACE INTO legacy_candidates VALUES (?,?,?,?,?,?)').run(row.thread_id,index,row.parent_thread_id,row.fingerprint,JSON.stringify(row),'pending');
 }
 reconcileLegacy(threads?:string[]){
  const affected=new Set(threads);
  if(threads){const queue=[...threads];for(let i=0;i<queue.length;i++)for(const c of this.db.prepare('SELECT DISTINCT thread_id FROM legacy_candidates WHERE parent_thread_id=?').all(queue[i]))if(!affected.has(c.thread_id as string)){affected.add(c.thread_id as string);queue.push(c.thread_id as string);}}
  const candidates=threads?[...affected].flatMap(id=>this.db.prepare('SELECT * FROM legacy_candidates WHERE thread_id=? ORDER BY event_index').all(id)):this.db.prepare('SELECT * FROM legacy_candidates ORDER BY thread_id,event_index').all();
  const groups=new Map<string,typeof candidates>();for(const c of candidates){const id=c.thread_id as string;if(!groups.has(id))groups.set(id,[]);groups.get(id)!.push(c);}

  let added=0;
  for(const chain of groups.values()){
   let diverged=false,unanchored=false,next:number|null=null;
   const boundary=(JSON.parse(chain[0].raw_json as string) as Usage).fork_ordinal_exclusive;
   const parent=(chain[0].parent_thread_id?this.db.prepare('SELECT event_index,fingerprint,raw_json FROM legacy_candidates WHERE thread_id=? ORDER BY event_index').all(chain[0].parent_thread_id):[]).filter(p=>{if(boundary==null)return true;const ordinal=(JSON.parse(p.raw_json as string) as Usage).ordinal;return ordinal!==null&&ordinal<boundary;});
   for(const c of chain){const row=JSON.parse(c.raw_json as string) as Usage;let disposition='confirmed';
    if(this.db.prepare('SELECT 1 FROM exact_turns WHERE thread_id=? AND turn_id=?').get(row.thread_id,row.turn_id??''))disposition='superseded';
    else if(row.inherited)disposition='replayed';
    else if(c.parent_thread_id&&!diverged){
     if(!parent.length||unanchored)disposition='pending';
     else {
      const match:Record<string,unknown>|undefined=next===null?parent.find(p=>p.fingerprint===c.fingerprint):parent.find(p=>Number(p.event_index)===next&&p.fingerprint===c.fingerprint);
      if(match){next=Number(match.event_index)+1;disposition='replayed';}
      else if(next===null){unanchored=true;disposition='pending';}
      else diverged=true; // Only a contiguous replay prefix is excluded. Later equality is real usage.
     }
    }
    this.db.prepare('UPDATE legacy_candidates SET disposition=? WHERE thread_id=? AND event_index=?').run(disposition,c.thread_id,c.event_index);
    if(disposition==='confirmed'){if(this.insertUsage(row,true))added++;}
    else {this.db.prepare("DELETE FROM usage_records WHERE id=? AND source='legacy_token_count'").run(row.id);}
   }
  }
  return added;
 }
 legacySummary(){
  const summary=this.db.prepare("SELECT disposition,COUNT(*) AS count,COALESCE(SUM(json_extract(raw_json,'$.total_tokens')),0) AS tokens FROM legacy_candidates GROUP BY disposition").all();
  this.set('legacy_reconciliation',{version:1,pending_tokens:summary.find(s=>s.disposition==='pending')?.tokens??0,replayed_tokens:summary.find(s=>s.disposition==='replayed')?.tokens??0,confirmed_events:summary.find(s=>s.disposition==='confirmed')?.count??0,source_unavailable_candidate_tokens:this.db.prepare("SELECT COALESCE(SUM(json_extract(h.raw_json,'$.total_tokens')),0) AS total FROM legacy_candidate_history h WHERE NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.id=h.id) AND NOT EXISTS (SELECT 1 FROM legacy_candidates c WHERE json_extract(c.raw_json,'$.id')=h.id)").get()!.total});
 }
 records(from='0000',to='9999'):Usage[]{return this.db.prepare('SELECT raw_json FROM usage_records WHERE timestamp>=? AND timestamp<? ORDER BY timestamp').all(from,to).map(x=>JSON.parse(x.raw_json as string));}
 officialQuotas(from='0000',to='9999'):Quota[]{return this.db.prepare("SELECT * FROM quota_snapshots WHERE source='app_server' AND timestamp>=? AND timestamp<? ORDER BY timestamp").all(from,to) as unknown as Quota[];}
 quotas():Quota[]{return this.db.prepare('SELECT * FROM quota_snapshots ORDER BY timestamp,source').all() as unknown as Quota[];}
 latestQuota():Quota[]{
  const rows=this.db.prepare(`SELECT q.* FROM quota_snapshots q JOIN (SELECT limit_id,slot,MAX(timestamp) AS latest FROM quota_snapshots GROUP BY limit_id,slot) t ON q.limit_id=t.limit_id AND q.slot=t.slot AND q.timestamp=t.latest`).all() as unknown as Quota[];
  const bucketTime=new Map<string,string>();for(const r of rows)if(r.timestamp>(bucketTime.get(r.limit_id)??''))bucketTime.set(r.limit_id,r.timestamp);
  return rows.filter(r=>r.timestamp===bucketTime.get(r.limit_id)&&(r.resets_at===null||r.resets_at>Date.now()/1000));
 }
 cycleQuotas(cycles:Quota[]):Quota[]{return cycles.flatMap(q=>this.db.prepare('SELECT * FROM quota_snapshots WHERE limit_id=? AND slot=? AND window_duration_mins=? AND resets_at=? ORDER BY timestamp').all(q.limit_id,q.slot,q.window_duration_mins,q.resets_at)) as unknown as Quota[];}

 latestAccount():any{const r=this.db.prepare('SELECT timestamp,raw_json FROM account_usage_snapshots ORDER BY timestamp DESC LIMIT 1').get();return r?{timestamp:r.timestamp,...JSON.parse(r.raw_json as string)}:null;}
 savePrices(rules:PriceRule[]){for(const r of rules){const old=this.db.prepare('SELECT raw_json FROM pricing_rules WHERE id=?').get(r.id);if(old&&old.raw_json!==JSON.stringify(r))throw Error('immutable_price_rule_changed');this.db.prepare('INSERT OR IGNORE INTO pricing_rules VALUES (?,?)').run(r.id,JSON.stringify(r));}}
 rules():PriceRule[]{return this.db.prepare('SELECT raw_json FROM pricing_rules').all().map(x=>JSON.parse(x.raw_json as string));}
 issues(){return this.db.prepare('SELECT code,COUNT(*) AS count FROM ingest_issues GROUP BY code').all();}
}
