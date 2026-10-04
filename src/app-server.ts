import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,symlinkSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import type {Config} from './types.js';
import {normalizeQuota} from './quota.js';
import type {Ledger} from './store.js';
export class AppServer {
 private child:ChildProcessWithoutNullStreams|null=null;private seq=0;
 private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
 constructor(private config:Config,private dataHome:string,private timeout=20000){}
 async start(){
  if(this.child)return;
  // Native writes are redirected; the OS denies writes to the real Codex home,
  // including writes through the auth link. This process never opens auth contents.
  if(process.platform!=='darwin'||!existsSync('/usr/bin/sandbox-exec'))throw Error('read_only_app_server_requires_macos_sandbox');
  const runtime=join(this.dataHome,'app-server');mkdirSync(runtime,{recursive:true,mode:0o700});
  const auth=join(this.config.codex_home,'auth.json'),link=join(runtime,'auth.json');
  if(existsSync(auth)){if(!existsSync(link))symlinkSync(auth,link);else if(realpathSync(link)!==realpathSync(auth))throw Error('unexpected_auth_link');}
  const source=realpathSync(this.config.codex_home);
  const profile=`(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(source)}))`;
  const args=['-p',profile,this.config.codex_binary,'app-server','--listen','stdio://','-c',`sqlite_home=${JSON.stringify(runtime)}`,'-c',`log_dir=${JSON.stringify(join(this.dataHome,'logs'))}`,'-c','analytics.enabled=false'];
  this.child=spawn('/usr/bin/sandbox-exec',args,{env:{...process.env,CODEX_HOME:runtime,RUST_LOG:'off'},stdio:['pipe','pipe','pipe']});
  const child=this.child;
  child.stderr.on('data',()=>{/* Deliberately never persist server logs or error payloads. */});
  child.on('error',()=>this.fail('app_server_spawn_failed'));child.on('exit',()=>{if(this.child===child){this.child=null;this.fail('app_server_exited');}});
  child.stdin.on('error',()=>this.fail('app_server_pipe_failed'));
  createInterface({input:child.stdout}).on('line',line=>{try{
   const m=JSON.parse(line);const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);
   if(m.error)p.reject(Error('rpc_error_'+String(m.error.code)));else p.resolve(m.result);
  }catch{/* Malformed or unrelated notifications never enter the ledger. */}});
  try{await this.request('initialize',{clientInfo:{name:'codex_usage_ledger',version:'0.4.1'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');}catch(e){this.close();throw e;}
 }
 request(method:string,params?:unknown):Promise<any>{
  if(!['initialize','account/read','account/rateLimits/read','account/usage/read'].includes(method))return Promise.reject(Error('rpc_not_allowlisted'));
  return new Promise((resolve,reject)=>{if(!this.child){reject(Error('app_server_not_running'));return;}const id=++this.seq;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('rpc_timeout'));},this.timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,...(params===undefined?{}:{params})})+'\n');});
 }
 private fail(code:string){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(code));}this.pending.clear();}
 close(){this.fail('app_server_closed');this.child?.stdin.end();this.child?.kill('SIGTERM');this.child=null;}
}
export type AccountMethod='account/read'|'account/rateLimits/read'|'account/usage/read';
export const accountMethods:AccountMethod[]=['account/read','account/rateLimits/read','account/usage/read'];
export async function collectAccount(db:Ledger,client:Pick<AppServer,'start'|'request'|'close'>,methods:AccountMethod[]=accountMethods){
 const state:Record<string,string>={};
 try{await client.start();}catch(e){
  const code=errorCode(e),timestamp=new Date().toISOString();
  for(const method of methods){state[method]=code;db.observe('app_server',method,'error',{code},timestamp);db.set('collection:'+method,{timestamp,status:'error',code});}
  const result={timestamp,status:'unavailable',code,methods:state};db.set('account_collection',result);return result;
 }
 for(const method of methods){
  const started_at=new Date().toISOString();
  try{const r=await client.request(method,method==='account/read'?{refreshToken:false}:undefined);const timestamp=new Date().toISOString();
   // Account identity is projected; quota and usage responses contain numeric account facts.
   const raw=method==='account/read'?{type:r?.account?.type??null,plan:r?.account?.planType??null}:r;
   db.transaction(()=>{
    db.observe('app_server',method,'ok',{started_at,response:raw},timestamp);
    if(method==='account/read')db.set('account',{...raw,timestamp});
    if(method==='account/rateLimits/read')for(const q of normalizeQuota(r,timestamp,'app_server'))db.insertQuota(q);
    if(method==='account/usage/read')db.insertAccount(timestamp,r);
    db.set('collection:'+method,{timestamp,status:'ok'});
   });state[method]='ok';
  }catch(e){const code=errorCode(e);state[method]=code;db.observe('app_server',method,'error',{started_at,code});db.set('collection:'+method,{timestamp:new Date().toISOString(),status:'error',code});}
 }
 const result={timestamp:new Date().toISOString(),status:Object.values(state).every(x=>x==='ok')?'ok':'partial',methods:state};db.set('account_collection',result);if(Object.values(state).some(x=>x==='rpc_timeout'))client.close();return result;
}
export function errorCode(e:unknown){const message=e instanceof Error?e.message:'';return /^[a-z_0-9-]+$/.test(message)?message:'operation_failed';}
