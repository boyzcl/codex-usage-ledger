import {DatabaseSync} from './sqlite.js';
import type {Usage,Quota,PriceRule,ParseState} from './types.js';
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
  `);
 }
 close(){this.db.close();}
 transaction<T>(f:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=f();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 set(key:string,value:unknown){this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key,JSON.stringify(value));}
 get<T>(key:string):T|null{const r=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value as string):null;}
 observe(source:string,kind:string,status:string,raw:unknown,timestamp=new Date().toISOString()){
  this.db.prepare('INSERT INTO observations(timestamp,source,kind,status,raw_json) VALUES (?,?,?,?,?)').run(timestamp,source,kind,status,JSON.stringify(raw));
 }
 markExact(thread:string,turn:string){this.db.prepare('INSERT OR IGNORE INTO exact_turns VALUES (?,?)').run(thread,turn);this.db.prepare("DELETE FROM usage_records WHERE thread_id=? AND COALESCE(turn_id,'')=? AND source='legacy_token_count'").run(thread,turn);}
 insertUsage(row:Usage):boolean{
  if(row.source==='legacy_token_count'&&this.db.prepare('SELECT 1 FROM exact_turns WHERE thread_id=? AND turn_id=?').get(row.thread_id,row.turn_id??''))return false;
  const old=this.db.prepare('SELECT raw_json FROM usage_records WHERE id=?').get(row.id);
  if(old){const prior=JSON.parse(old.raw_json as string) as Usage;
   const quality=(x:Usage)=>(x.source==='token_usage_record'?4:0)+(x.inherited?0:2)+(x.model==='unknown'?0:1);
   if(quality(row)<=quality(prior))return false;
  }
  this.db.prepare('INSERT OR REPLACE INTO usage_records VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.response_id,row.thread_id,row.session_id,row.turn_id,row.timestamp,row.model,row.source,row.total_tokens,JSON.stringify(row));return !old;
 }
 insertQuota(q:Quota){this.db.prepare('INSERT OR IGNORE INTO quota_snapshots VALUES (?,?,?,?,?,?,?,?,?)').run(q.id,q.timestamp,q.limit_id,q.slot,q.window_duration_mins,q.resets_at,q.used_percent,q.source,q.raw_json);}
 insertAccount(timestamp:string,raw:unknown){this.db.prepare('INSERT OR REPLACE INTO account_usage_snapshots VALUES (?,?,?)').run(hash([timestamp,raw]),timestamp,JSON.stringify(raw));}
 issue(path:string,offset:number,code:string,timestamp:string|null){this.db.prepare('INSERT OR IGNORE INTO ingest_issues VALUES (?,?,?,?,?)').run(hash([path,offset,code]),hash(path),offset,code,timestamp);}
 checkpoint(path:string):any{return this.db.prepare('SELECT * FROM ingest_files WHERE path=?').get(path);}
 saveCheckpoint(path:string,stat:{dev:number;ino:number;size:number;mtimeMs:number},offset:number,state:ParseState){this.db.prepare('INSERT OR REPLACE INTO ingest_files VALUES (?,?,?,?,?,?,?,?)').run(path,String(stat.dev),String(stat.ino),stat.size,stat.mtimeMs,offset,JSON.stringify(state),new Date().toISOString());}
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
