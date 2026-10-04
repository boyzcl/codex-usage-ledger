import {watch,existsSync,readFileSync,writeFileSync,unlinkSync,appendFileSync,renameSync,statSync,lstatSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import type {Config} from './types.js';
import type {Ledger} from './store.js';
import {AppServer,collectAccount,errorCode,type AccountMethod} from './app-server.js';
import {syncRollouts} from './ingest.js';
import {monitorDefaults} from './config.js';

export class Schedule {
 readonly config;lastActivity=-Infinity;localAt=0;quotaAt=0;summaryAt=0;
 private quotaFailures=0;private summaryFailures=0;
 private resetDone=new Set<string>();
 constructor(config:Config['monitor']){this.config={...monitorDefaults,...config};}
 get activeInterval(){return this.config.quota_active_seconds*1000;}
 active(now:number){return now-this.lastActivity<this.config.activity_seconds*1000;}
 due(now:number,resets:number[]=[]){
  const boundary=resets.flatMap(r=>[{key:r+':before',at:r-60000,end:r},{key:r+':after',at:r+5000,end:r+300000}])
   .find(b=>now>=b.at&&now<b.end&&!this.resetDone.has(b.key));
  return {local:now>=this.localAt,quota:now>=this.quotaAt||(!!boundary&&this.quotaFailures===0&&now>=this.lastQuota+60000),summary:now>=this.summaryAt,boundary:boundary?.key};
 }
 lastQuota=-Infinity;
 activity(now:number){this.lastActivity=Math.max(this.lastActivity,now);if(this.quotaFailures===0)this.quotaAt=Math.min(this.quotaAt,this.lastQuota+this.activeInterval);}
 localDone(now:number){this.localAt=now+this.config.local_reconcile_seconds*1000;}
 quotaDone(now:number,ok:boolean,boundary?:string){
  this.lastQuota=now;this.quotaFailures=ok?0:this.quotaFailures+1;
  this.quotaAt=now+(ok?(this.active(now)?this.config.quota_active_seconds:this.config.quota_idle_seconds)*1000:this.retry(this.quotaFailures));
  if(boundary)this.resetDone.add(boundary);
 }
 summaryDone(now:number,ok:boolean){this.summaryFailures=ok?0:this.summaryFailures+1;this.summaryAt=now+(ok?this.config.summary_seconds*1000:this.retry(this.summaryFailures));}
 resume(){this.localAt=0;this.quotaAt=0;this.summaryAt=0;}
 private retry(n:number){return Math.min(300000,60000*2**Math.min(n-1,3));}
}

export function acquireMonitorLock(home:string){
 const path=join(home,'monitor.pid');
 if(existsSync(path)){
  const pid=Number(readFileSync(path,'utf8'));
  if(!Number.isInteger(pid)||pid<=0)throw Error('invalid_monitor_lock');
  try{process.kill(pid,0);throw Error('monitor_already_running');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
  unlinkSync(path);
 }
 writeFileSync(path,String(process.pid),{flag:'wx',mode:0o600});
 return ()=>{if(existsSync(path)&&readFileSync(path,'utf8')===String(process.pid))unlinkSync(path);};
}
export function appendMonitorLog(home:string,value:unknown){
 const path=join(home,'logs','monitor.jsonl');
 if(existsSync(path)&&statSync(path).size>5*1024*1024)renameSync(path,path+'.1');
 appendFileSync(path,JSON.stringify(value)+'\n',{mode:0o600});
}
// Accept only real source files. A watcher event must not widen the discovery boundary.
export function sourceEventPath(home:string,folder:string,name:string){
 const root=join(home,folder),path=join(root,name),rel=relative(root,path);
 if(!rel||rel.startsWith('..')||isAbsolute(rel)||!name.endsWith('.jsonl')||(folder==='sessions'&&!path.split('/').at(-1)!.startsWith('rollout-')))return null;
 let current=root;
 try{if(lstatSync(root).isSymbolicLink())return null;for(const part of rel.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())return null;}if(!lstatSync(path).isFile())return null;}catch{return null;}
 return path;
}
export async function runMonitor(db:Ledger,client:AppServer,config:Config,home:string,options:{offline?:boolean;once?:boolean;show:(value:unknown)=>void;estimates:()=>unknown}){
 const release=acquireMonitorLock(home),schedule=new Schedule(config.monitor);
 let stopped=false,wake:(()=>void)|undefined,dirtyAt=Infinity,forceLocal=false,lastBeat=Date.now();
 const dirty=new Set<string>(),watchers=new Map<string,ReturnType<typeof watch>>();
 const resets=new Set<number>();let lastHealth=0;
 const emit=(kind:string,status:string,data:unknown)=>{const event={timestamp:new Date().toISOString(),kind,status,data};appendMonitorLog(home,event);db.observe('monitor',kind,status,data,event.timestamp);options.show(event);};
 const stop=()=>{stopped=true;wake?.();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const request=(path?:string)=>{if(path)dirty.add(path);else forceLocal=true;dirtyAt=Math.min(dirtyAt,Date.now()+schedule.config.debounce_ms);wake?.();};
 const attach=()=>{
  for(const folder of ['sessions','archived_sessions']){
   const root=join(config.codex_home,folder);if(watchers.has(root))continue;
   try{const w=watch(root,{recursive:true},(_event,name)=>{const path=name?sourceEventPath(config.codex_home,folder,String(name)):null;if(path){schedule.activity(Date.now());request(path);}else request();});
    w.on('error',()=>{w.close();watchers.delete(root);emit('watcher','error',{code:'watcher_unavailable',folder});});watchers.set(root,w);
   }catch(e){emit('watcher','error',{code:(e as NodeJS.ErrnoException).code??'watcher_unavailable',folder});}
  }
 };
 const heartbeat=()=>{const now=Date.now();db.set('monitor_state',{pid:process.pid,running:!stopped,heartbeat_at:new Date(now).toISOString(),active:schedule.active(now),last_activity_at:Number.isFinite(schedule.lastActivity)?new Date(schedule.lastActivity).toISOString():null,next_local_at:new Date(schedule.localAt).toISOString(),next_quota_at:options.offline?null:new Date(schedule.quotaAt).toISOString(),next_summary_at:options.offline?null:new Date(schedule.summaryAt).toISOString(),offline:!!options.offline,policy:schedule.config});lastHealth=now;};
 try{
  const hook=watch(home,(_event,name)=>{if(name==='refresh.request')request();});hook.on('error',()=>emit('watcher','error',{code:'hook_watcher_unavailable'}));watchers.set(home,hook);
  const prior=db.get<{heartbeat_at:string}>('monitor_state');
  if(prior&&Date.now()-Date.parse(prior.heartbeat_at)>75000)emit('observation_gap','unknown',{from:prior.heartbeat_at,to:new Date().toISOString(),reason:'monitor_offline'});
  emit('started','ok',{pid:process.pid,offline:!!options.offline,policy:schedule.config});
  while(!stopped){
   const now=Date.now();
   if(now-lastBeat>75000||now<lastBeat){emit('observation_gap','unknown',{from:new Date(lastBeat).toISOString(),to:new Date(now).toISOString(),reason:'sleep_stall_or_clock_change'});schedule.resume();client.close();}
   lastBeat=now;
   const localDue=schedule.due(now).local;
   if(localDue||now>=dirtyAt){
    const full=localDue||forceLocal;const paths=full?undefined:[...dirty];dirty.clear();dirtyAt=Infinity;forceLocal=false;
    try{
     const rollout=await syncRollouts(db,config.codex_home,db.rules(),undefined,paths);
     // Source event time determines reporting; recent mtime is only an activity signal.
     if(full){const m=db.db.prepare('SELECT MAX(mtime) AS latest FROM ingest_files').get()?.latest;if(typeof m==='number')schedule.activity(Math.min(Date.now(),m));schedule.localDone(Date.now());attach();}
     emit('local_sync','ok',{...rollout,mode:full?'reconcile':'changed_files'});
    }catch(e){schedule.localAt=Date.now()+60000;emit('local_sync','error',{code:errorCode(e)});}
   }
   // Retain known reset times across expiration so the post-reset sample is still taken.
   for(const q of db.latestQuota())if(q.resets_at)resets.add(q.resets_at*1000);
   for(const r of resets)if(r<Date.now()-300000)resets.delete(r);
   const due=schedule.due(Date.now(),[...resets]);
   if(!options.offline&&(due.quota||due.summary)&&!stopped){
    const methods:AccountMethod[]=[];if(due.quota)methods.push('account/rateLimits/read');if(due.summary)methods.push('account/read','account/usage/read');
    const result=await collectAccount(db,client,methods);
    if(due.quota)schedule.quotaDone(Date.now(),result.methods['account/rateLimits/read']==='ok',due.boundary);
    if(due.summary)schedule.summaryDone(Date.now(),result.methods['account/usage/read']==='ok'&&result.methods['account/read']==='ok');
    emit('remote_sync',result.status,result);
    try{options.estimates();}catch(e){emit('estimate','error',{code:errorCode(e)});}
   }
   if(Date.now()-lastHealth>=15000||options.once)heartbeat();
   if(options.once)break;
   // A single loop coalesces events; no overlapping collector runs or catch-up bursts.
   await new Promise<void>(done=>{let finished=false;const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);done();};const timer=setTimeout(finish,Math.max(25,Math.min(15000,dirtyAt-Date.now(),schedule.localAt-Date.now(),options.offline?Infinity:schedule.quotaAt-Date.now(),options.offline?Infinity:schedule.summaryAt-Date.now())));wake=finish;if(stopped)finish();});wake=undefined;
  }
 }finally{stopped=true;for(const w of watchers.values())w.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);heartbeat();emit('stopped','ok',{pid:process.pid});release();}
}
