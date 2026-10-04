import {mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync,chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,join,dirname,relative} from 'node:path';
import type {Config} from './types.js';
import {validatePrices} from './pricing.js';
export const monitorDefaults={local_reconcile_seconds:300,quota_active_seconds:300,quota_idle_seconds:900,activity_seconds:600,summary_seconds:1800,debounce_ms:1500};
export function assertSeparate(dataHome:string,codexHome:string){
 const canonical=(p:string):string=>existsSync(p)?realpathSync(p):join(canonical(dirname(p)),p.split('/').at(-1)!);
 const data=canonical(resolve(dataHome)),source=canonical(resolve(codexHome));
 const inside=(a:string,b:string)=>{const r=relative(a,b);return !r||(!r.startsWith('..')&&!r.startsWith('/'));};
 if(inside(source,data)||inside(data,source))throw Error('data_home_must_be_separate_from_codex_home');
}
export function loadConfig(dataHome:string,codexOverride?:string){
 const defaultCodex=resolve(process.env.CODEX_HOME??join(homedir(),'.codex'));
 let saved:Partial<Config>={};if(existsSync(join(dataHome,'config.json')))saved=JSON.parse(readFileSync(join(dataHome,'config.json'),'utf8'));
 const desktop='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
 const config:Config={codex_home:defaultCodex,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,poll_seconds:60,codex_binary:existsSync(desktop)?desktop:'codex',...saved,estimator:saved.estimator??{weight_basis:'verified',bucket_models:{}}};
 if(codexOverride)config.codex_home=resolve(codexOverride);
 config.monitor={...monitorDefaults,...saved.monitor};
 for(const [key,value] of Object.entries(config.monitor))if(!Number.isFinite(value)||value<(key==='debounce_ms'?100:5))throw Error('invalid_monitor_interval');
 assertSeparate(dataHome,config.codex_home);
 if(!Number.isFinite(config.poll_seconds)||config.poll_seconds<5)throw Error('invalid_poll_seconds');
 new Intl.DateTimeFormat('en',{timeZone:config.timezone});
 mkdirSync(dataHome,{recursive:true,mode:0o700});chmodSync(dataHome,0o700);mkdirSync(join(dataHome,'logs'),{recursive:true,mode:0o700});
 if(!existsSync(join(dataHome,'config.json')))writeFileSync(join(dataHome,'config.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
 const pricesFile=join(dataHome,'prices.json');
 if(!existsSync(pricesFile))writeFileSync(pricesFile,readFileSync(new URL('../../data/prices.json',import.meta.url)),{mode:0o600});
 return {config,rules:validatePrices(JSON.parse(readFileSync(pricesFile,'utf8')))};
}
