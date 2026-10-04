import {discover,lines,stat} from './discovery.js';
import {initialState,parseLine} from './parser.js';
import {priceUsage} from './pricing.js';
import type {ParseState,PriceRule} from './types.js';
import type {Ledger} from './store.js';
export async function syncRollouts(db:Ledger,home:string,rules:PriceRule[],progress?:(files:number,total:number)=>void,paths?:string[]){
 const files=paths??await discover(home);let added=0,changed=0,bad=0,bytes=0,done=0;
 for(const path of files){
  let info;try{info=await stat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
  const unchanged=(cp:any)=>cp&&cp.size===info.size&&cp.mtime===info.mtimeMs&&cp.inode===String(info.ino)&&cp.device===String(info.dev);
  if(unchanged(db.checkpoint(path))){done++;continue;}
  db.db.exec('BEGIN IMMEDIATE');
  const cp=db.checkpoint(path);
  if(unchanged(cp)){db.db.exec('COMMIT');done++;continue;}
  const append=cp&&info.size>=cp.size&&cp.inode===String(info.ino)&&cp.device===String(info.dev)&&!(info.size===cp.size&&cp.mtime!==info.mtimeMs);
  const start=append?cp.offset:0;const state:ParseState=append?JSON.parse(cp.state_json):initialState();let offset=start;
  // Each file commits as one atomic checkpoint. SQLite busy_timeout serializes concurrent syncs.
  try{
   for await(const item of lines(path,start,info.size)){
    offset=item.end;
    if(item.oversize){db.issue(path,offset,'oversized_line_skipped',null);bad++;continue;}
    if(!item.line.trim())continue;
    let parsed;try{parsed=parseLine(item.line,state);}catch{db.issue(path,offset,'malformed_line',null);bad++;continue;}
    for(const issue of parsed.issues)db.issue(path,offset,issue.code,issue.timestamp);
    if(parsed.exactTurn)db.markExact(parsed.exactTurn.thread,parsed.exactTurn.turn);
    for(const row of parsed.usage){
     if(row.source==='legacy_token_count'){
      db.db.prepare('INSERT OR REPLACE INTO legacy_events VALUES (?,?,?)').run(state.thread_id,state.legacy_index,row.fingerprint);
      if(row.inherited){db.issue(path,offset,'inherited_legacy_skipped',row.timestamp);continue;}
      // Exact fingerprint matching of copied parent history also works when fork timestamps were rewritten.
      if(state.parent_thread_id&&!state.replay_done){
       const parent=state.replay_next_index==null
        ?db.db.prepare('SELECT event_index FROM legacy_events WHERE thread_id=? AND fingerprint=? ORDER BY event_index LIMIT 1').get(state.parent_thread_id,row.fingerprint)
        :db.db.prepare('SELECT event_index FROM legacy_events WHERE thread_id=? AND event_index=? AND fingerprint=?').get(state.parent_thread_id,state.replay_next_index,row.fingerprint);
       if(parent){state.replay_next_index=Number(parent.event_index)+1;db.issue(path,offset,'inherited_legacy_skipped',row.timestamp);continue;}
       const parentAvailable=db.db.prepare('SELECT 1 FROM legacy_events WHERE thread_id=?').get(state.parent_thread_id);
       if(!parentAvailable&&state.created_at&&Date.parse(row.timestamp)-Date.parse(state.created_at)<=1000){db.issue(path,offset,'unresolved_fork_history',row.timestamp);continue;}
       // Once the child diverges, equal future counters are not evidence of replay.
       state.replay_done=true;
      }
     }
     if(db.insertUsage(priceUsage(row,rules)))added++;
    }
    for(const q of parsed.quotas)db.insertQuota(q);
   }
   db.saveCheckpoint(path,info,offset,state);db.db.exec('COMMIT');changed++;bytes+=info.size-start;
  }catch(e){db.db.exec('ROLLBACK');throw e;}
  done++;if(done%50===0)progress?.(done,files.length);
 }
 const report={files:files.length,changed_files:changed,added_records:added,malformed_or_oversized_lines:bad,bytes_read:bytes,synced_at:new Date().toISOString()};db.set('last_sync',report);return report;
}
