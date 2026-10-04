import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync,unlinkSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from './quota.js';
import {setTimeout as delay} from 'node:timers/promises';
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function servicePaths(home:string){const label='local.codex-usage-ledger.'+hash(home).slice(0,12);return {label,plist:join(homedir(),'Library','LaunchAgents',label+'.plist'),target:`gui/${process.getuid!()}/${label}`,domain:`gui/${process.getuid!()}`};}
export function servicePlist(home:string,label:string,node=process.execPath,cli=fileURLToPath(new URL('./cli.js',import.meta.url))){
 return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${[node,cli,'watch','--json','--data-home',home].map(s=>'<string>'+xml(s)+'</string>').join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer><key>ProcessType</key><string>Standard</string>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>${xml(join(home,'logs','service-error.log'))}</string>
<key>Umask</key><integer>63</integer>
</dict></plist>\n`;
}
function launch(args:string[],required=true){const r=spawnSync('/bin/launchctl',args,{encoding:'utf8',timeout:10000});if(required&&r.status!==0)throw Error('launchctl_'+args[0]+'_failed');return r;}
export async function service(home:string,action:string){
 if(process.platform!=='darwin')throw Error('service_requires_macos');
 const p=servicePaths(home);
 const waitUnloaded=async()=>{const deadline=Date.now()+35000;while(launch(['print',p.target],false).status===0){if(Date.now()>=deadline)throw Error('service_stop_timeout');await delay(250);}};
 const bootout=async()=>{launch(['bootout',p.target],false);await waitUnloaded();};
 if(!['install','start','stop','restart','uninstall','status'].includes(action))throw Error('unknown_service_action');
 if(action==='install'){
  const content=servicePlist(home,p.label);mkdirSync(dirname(p.plist),{recursive:true});writeFileSync(p.plist,content,{mode:0o600});
  await bootout();launch(['enable',p.target]);launch(['bootstrap',p.domain,p.plist]);
 }
 if(action==='start'||action==='restart'){
  if(!existsSync(p.plist))throw Error('service_not_installed');
  launch(['enable',p.target]);
  if(action==='restart')await bootout();
  const existing=launch(['print',p.target],false);if(existing.stdout?.includes('state = SIGTERMed'))await waitUnloaded();
  if(launch(['print',p.target],false).status!==0)launch(['bootstrap',p.domain,p.plist]);
 }
 if(action==='stop'||action==='uninstall'){
  launch(['disable',p.target]);await bootout();
  if(action==='uninstall'&&existsSync(p.plist))unlinkSync(p.plist);
 }
 if(['install','start','restart'].includes(action)){const deadline=Date.now()+10000;while(!/state = running/.test(launch(['print',p.target],false).stdout??'')){if(Date.now()>=deadline)throw Error('service_start_timeout');await delay(250);}}
 const r=launch(['print',p.target],false);const raw=r.stdout??'';
 const disabled=launch(['print-disabled',p.domain],false).stdout??'';
 const state=raw.match(/^\s*state = (.+)$/m)?.[1]??'unloaded';const pid=raw.match(/^\s*pid = (\d+)$/m)?.[1];
 const monitorPid=existsSync(join(home,'monitor.pid'))?Number(readFileSync(join(home,'monitor.pid'),'utf8')):null;
 return {action,installed:existsSync(p.plist),loaded:r.status===0,running:state==='running',state,pid:pid?Number(pid):null,monitor_pid:monitorPid,login_enabled:existsSync(p.plist)&&!['true','disabled'].some(value=>disabled.includes('"'+p.label+'" => '+value)),label:p.label,plist:p.plist,data_home:home,log:join(home,'logs','monitor.jsonl'),error_log:join(home,'logs','service-error.log')};
}
