import {open} from 'node:fs/promises';
import {discover,lines,stat,digests} from './discovery.js';
import {initialState,parseLine} from './parser.js';
import {priceUsage} from './pricing.js';
import {hash} from './quota.js';
import type {ParseState,PriceRule} from './types.js';
import type {Ledger} from './store.js';
export async function syncRollouts(db:Ledger,home:string,rules:PriceRule[],progress?:(files:number,total:number)=>void,paths?:string[]){
 const files=paths??await discover(home);let added=0,changed=0,bad=0,bytes=0,hashBytes=0,hashMs=0,deferred=0,done=0;
 for(const path of files){
  let f;try{f=await open(path,'r');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
  try{
   const info=await f.stat();
   const unchanged=(cp:any)=>cp?.parser_version===3&&cp.prefix_hash&&cp.size===info.size&&cp.mtime===info.mtimeMs&&cp.ctime===info.ctimeMs&&cp.inode===String(info.ino)&&cp.device===String(info.dev);
   if(unchanged(db.checkpoint(path))){done++;continue;}
   db.db.exec('BEGIN IMMEDIATE');
   try{
    let fileAdded=0,fileBad=0;const cp=db.checkpoint(path);if(unchanged(cp)){db.db.exec('COMMIT');done++;continue;}
    let tick=performance.now();const before=await digests(f,info.size,Math.min(cp?.offset??0,info.size));hashMs+=performance.now()-tick;hashBytes+=before.bytes;
    const append=cp?.parser_version===3&&cp.prefix_hash===before.prefix&&info.size>=cp.offset&&cp.inode===String(info.ino)&&cp.device===String(info.dev);
    const start=append?cp.offset:0;const state:ParseState=append?JSON.parse(cp.state_json):initialState();let offset=start,replayStarted=false;
    for await(const item of lines(path,start,info.size,f)){
     offset=item.end;
     if(item.oversize){db.issue(path,offset,'oversized_line_skipped',null);fileBad++;continue;}
     if(!item.line.trim())continue;
     let parsed;try{parsed=parseLine(item.line,state);}catch{db.issue(path,offset,'malformed_line',null);fileBad++;continue;}
     if(cp&&!append&&!replayStarted&&state.thread_id!=='unknown'){db.beginLegacyReplay(state.thread_id);replayStarted=true;}
     for(const issue of parsed.issues)db.issue(path,offset,issue.code,issue.timestamp);
     for(const row of parsed.usage){
      const priced=priceUsage({...row,origin_source:hash(path)},rules);
      if(row.source==='legacy_token_count')db.saveLegacy(priced,state.legacy_index);
      else if(db.insertUsage(priced,cp&&!append?'reparse':'append'))fileAdded++;
     }
     if(parsed.exactLink)db.linkExact(parsed.exactLink.legacy,parsed.exactLink.response);
     for(const q of parsed.quotas)db.insertQuota(q);
    }
    tick=performance.now();const after=await digests(f,info.size,offset);hashMs+=performance.now()-tick;hashBytes+=after.bytes;
    const final=await f.stat(),atPath=await stat(path);
    const stable=(x:typeof info)=>x.dev===info.dev&&x.ino===info.ino&&x.size===info.size&&x.mtimeMs===info.mtimeMs&&x.ctimeMs===info.ctimeMs;
    if(before.full!==after.full||!stable(final)||!stable(atPath))throw Error('source_changed_during_read');
    fileAdded+=db.reconcileLegacy([state.thread_id],cp&&!append?'reparse':'append');db.saveCheckpoint(path,info,offset,state,after.prefix);db.db.exec('COMMIT');changed++;added+=fileAdded;bad+=fileBad;bytes+=info.size-start;
   }catch(e){db.db.exec('ROLLBACK');if((e as Error).message==='source_changed_during_read'||(e as NodeJS.ErrnoException).code==='ENOENT'){deferred++;}else throw e;}
  }finally{await f.close();}
  done++;if(done%50===0)progress?.(done,files.length);
 }
 db.legacySummary();
 const report={files:files.length,changed_files:changed,added_records:added,malformed_or_oversized_lines:bad,bytes_read:bytes,validation_bytes_read:hashBytes,validation_ms:hashMs,deferred_files:deferred,synced_at:new Date().toISOString()};db.set('last_sync',report);return report;
}
