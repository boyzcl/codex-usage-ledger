import {redactIdentity,officialSnapshot} from './quota-policy.js';
import {capacityView} from './capacity-policy.js';
import {createWriteStream,existsSync,unlinkSync} from 'node:fs';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {resolve} from 'node:path';
import type {Ledger} from './store.js';
export const exportKinds=['usage','quota','account','observations','prices','estimates','estimate-history','conflicts','issues','valuations','valuation-runs'] as const;
export async function exportData(db:Ledger,kind:string,range:{from:string;to_exclusive:string;timezone:string},out?:string,runId?:string){
 if(!(exportKinds as readonly string[]).includes(kind))throw Error('unknown_export_kind');
 const table:Record<string,string>={usage:'usage_records',quota:'quota_snapshots',account:'account_usage_snapshots',observations:'observations',prices:'pricing_rules',estimates:'capacity_estimates','estimate-history':'capacity_estimate_history',conflicts:'usage_conflicts',issues:'ingest_issues',valuations:'valuation_results','valuation-runs':'valuation_runs'};
 const undated=kind==='prices'||kind==='issues';const time=(kind==='estimates'||kind==='estimate-history'||kind==='valuation-runs')?'created_at':'timestamp';
 if(runId&&!['valuations','valuation-runs'].includes(kind))throw Error('export_run_requires_valuation');
 const params=undated?[]:[range.from,range.to_exclusive];if(runId)params.push(runId);
 const sql=`SELECT * FROM ${table[kind]} ${undated?'':`WHERE ${time}>=? AND ${time}<?${runId?` AND ${kind==='valuation-runs'?'id':'run_id'}=?`:''} ORDER BY ${time},id`}`;
 const path=out?resolve(out):null;if(path&&existsSync(path))throw Error('export_file_already_exists');
 const stream=path?createWriteStream(path,{flags:'wx',mode:0o600}):process.stdout;let streamError:Error|undefined;
 const onError=(e:Error)=>{streamError=e;};stream.on('error',onError);
 let created=false,count=0;
 async function write(value:unknown){if(streamError)throw streamError;if(!stream.write(JSON.stringify(value)+'\n'))await once(stream,'drain');}
 try{
  if(path){await once(stream,'open');created=true;}
  db.db.exec('BEGIN');
  await write({type:'metadata',schema_version:3,kind,exported_at:new Date().toISOString(),range:undated?null:range,run_id:runId??null,notes:kind==='usage'?'Normalized source counters and stored derived amounts; project paths omitted. Original conversation text is never included.':kind==='estimates'?'Unverified capacity view. Preserved raw revisions are available via estimate-history.':kind==='valuations'?'Derived quotes with input fingerprints and stored originals. Export valuation-runs with the same run_id for the immutable catalogue snapshot and basis.':null});
  for(const row of db.db.prepare(sql).iterate(...params)){
   let data:any=row;
   if(kind==='usage'){data=JSON.parse(row.raw_json as string);delete data.project;}
   else if(kind==='quota')data=db.quotaOutput(row as any);
   else if(kind==='conflicts'){const state=db.db.prepare('SELECT * FROM usage_conflict_state WHERE id=?').get(row.id);data={...row,raw:JSON.parse(row.raw_json as string),raw_json:undefined,dispute_status:state?.status??'open',confirmed:false,quantity:null};delete data.raw.project;}
   else if(kind==='estimates')data={...row,raw:capacityView(JSON.parse(row.raw_json as string)),raw_json:undefined};
   else if(kind==='estimate-history')data={...row,raw:JSON.parse(row.raw_json as string),raw_json:undefined,status:'historical_unverified',history_status:row.status,confirmed:false,limitations:['Original derived values preserved for audit; not verified capacity.']};
   else if(kind==='prices'||kind==='valuations'||kind==='valuation-runs')data=JSON.parse(row.raw_json as string);
   else if(row.raw_json)data={...row,raw:JSON.parse(row.raw_json as string),raw_json:undefined};
   if(kind==='observations'&&row.source==='app_server'&&row.kind==='account/rateLimits/read'&&row.status==='ok'){data.official_snapshot=officialSnapshot(JSON.parse(row.raw_json as string).response,row.timestamp as string);data.official_snapshot.evidence.observation_ids=[row.id];}
   await write({type:kind,data:redactIdentity(data)});count++;
  }
  db.db.exec('COMMIT');
  if(path){stream.end();await finished(stream);}
  return {kind,records:count,path,format:'jsonl',range:undated?null:range};
 }catch(e){try{db.db.exec('ROLLBACK');}catch{/* No read transaction may have started. */}if(path){stream.destroy();if(created)try{unlinkSync(path);}catch{/* Preserve original error. */}}throw e;}
 finally{stream.removeListener('error',onError);}
}
