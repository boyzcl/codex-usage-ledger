import {parseArgs} from 'node:util';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {chmodSync,existsSync} from 'node:fs';
import {loadConfig} from './config.js';
import {Ledger} from './store.js';
import {syncRollouts} from './ingest.js';
import {AppServer,collectAccount} from './app-server.js';
import {quotaEstimates} from './estimator.js';
import {aggregate,period,report,localDay,shiftDay,midnight} from './report.js';
import {hash} from './quota.js';
import {dailyReport,empiricalPlans,cycleKey} from './daily.js';
import {priceUsage} from './pricing.js';
import {format,formatError} from './display.js';
import {runMonitor} from './monitor.js';
import {service} from './service.js';
import {repairPreview,consistentBackup} from './repair.js';
import {exportData} from './export.js';
function argumentsForCli(){return parseArgs({allowPositionals:true,options:{json:{type:'boolean'},'experimental-empirical':{type:'boolean'},details:{type:'boolean'},out:{type:'string'},input:{type:'string'},'out-dir':{type:'string'},timezone:{type:'string'},from:{type:'string'},to:{type:'string'},'data-home':{type:'string'},'codex-home':{type:'string'},offline:{type:'boolean'},once:{type:'boolean'},online:{type:'boolean'},help:{type:'boolean'}}});}
let opts:ReturnType<typeof argumentsForCli>;
try{opts=argumentsForCli();}catch{console.error(process.argv.includes('--json')?JSON.stringify({error:'invalid_arguments'}):formatError('invalid_arguments'));process.exit(1);}
const command=opts.positionals[0]??'status';
const help=`Codex 用量账本

日常查询
  cux status                         当前额度、今日用量和采集状态
  cux quota                          各窗口的剩余额度与重置时间
  cux today | week | month           今日 / 本周 / 本月用量
  cux report --from 日期 --to 日期    指定区间（YYYY-MM-DD，包含末日）
  cux models                         全部已入账历史的模型排行
  cux estimate                       容量估计及缺少的条件

监控与检查
  cux service status                 查看后台服务
  cux service start | stop | restart  恢复 / 暂停 / 重启
  cux service install | uninstall     安装 / 移除启动项，保留历史数据
  cux doctor [--online]               本地检查；--online 另查官方接口
  cux sync [--offline]                同步一次；--offline 仅导入本地
  cux repair-preview --input 库 --codex-home 日志目录 --out-dir 新目录
                                     只读备份并在副本修复，输出私人差异
  cux repair-rollback --input baseline.db --out 新库
                                     从备份恢复到新库，不覆盖任何已有库
  cux watch [--once]                  前台监控；--once 仅运行一轮

数据导出
  cux export usage --from 日期 --to 日期 --out 文件.jsonl
  支持 usage / quota / account / observations / prices / estimates / issues
  不写 --out 则输出 JSONL；已有文件不会被覆盖。

显示与路径
  --experimental-empirical           显式显示实验经验外推，仍保留严格缺失原因
  --details                          展开精确数字和完整详情
  --json                             输出机器可读 JSON，优先于 --details
  --data-home 路径                    指定账本数据目录
  --codex-home 路径                   指定 Codex 日志目录

时间使用 config.json 的时区；week 从周一开始。
普通查询读取账本，无需每次同步。NO_COLOR=1 可关闭终端颜色。`;
if(opts.values.help||command==='help'){console.log(help);}else{await main().catch(e=>{const code=e instanceof RangeError?'invalid_date':e instanceof Error&&/^[a-z_0-9]+$/.test(e.message)?e.message:'operation_failed';console.error(opts.values.json?JSON.stringify({error:code}):formatError(code));process.exitCode=1;});}
async function main(){
 if(command==='repair-preview'||command==='repair-rollback'){
  if(!opts.values.input)throw Error('repair_requires_input');
  if(command==='repair-rollback'){if(!opts.values.out)throw Error('repair_requires_output');await consistentBackup(opts.values.input,opts.values.out);console.log(JSON.stringify({restored_to:resolve(opts.values.out),input_read_only:true}));return;}
  if(!opts.values['codex-home']||!opts.values['out-dir'])throw Error('repair_requires_explicit_paths');
  const value=await repairPreview(opts.values.input,opts.values['codex-home'],opts.values['out-dir'],opts.values.timezone??'UTC',(n,total)=>{if(process.stderr.isTTY)console.error(`修复预览：${n}/${total}`);});console.log(JSON.stringify(value,null,2));return;
 }
 if(!['status','today','week','month','report','models','quota','estimate','sync','watch','doctor','service','export'].includes(command))throw Error('unknown_command');
 const home=resolve(opts.values['data-home']??process.env.CUX_HOME??join(homedir(),'.codex-usage-ledger'));
 const {config,rules}=loadConfig(home,opts.values['codex-home']);
 const view={command,details:opts.values.details,timezone:config.timezone,width:process.stdout.columns??80,color:!!process.stdout.isTTY&&process.env.NO_COLOR===undefined&&process.env.TERM!=='dumb'};
 if(command==='service'){
  if(opts.values['codex-home'])throw Error('service_uses_saved_codex_home');
  const result=await service(home,opts.positionals[1]??'status');
  if(opts.values.json){console.log(JSON.stringify(result,null,2));return;}
  let monitor=null;const path=join(home,'usage.db');if(existsSync(path)){const ledger=new Ledger(path);try{monitor=ledger.get('monitor_state');}finally{ledger.close();}}
  console.log(format(result,{...view,monitor}));return;
 }
 const db=new Ledger(join(home,'usage.db'));chmodSync(join(home,'usage.db'),0o600);
 const client=new AppServer(config,home);db.savePrices(rules);
 const show=(value:unknown)=>console.log(opts.values.json?JSON.stringify(value,null,2):format(value,{...view,collection:db.get('collection:account/rateLimits/read')}));
 function empiricalCurrent(){
  const latest=db.latestQuota();const starts=latest.filter(q=>q.resets_at&&q.window_duration_mins).map(q=>new Date((q.resets_at!-q.window_duration_mins!*60)*1000).toISOString()).sort();
  if(!starts.length)return [];const now=new Date().toISOString(),from=starts[0],to=new Date(Date.parse(now)+1).toISOString();
  const prices=db.rules();const rows=db.records(from,to).map(r=>({...priceUsage({...r,timestamp:now},prices),timestamp:r.timestamp}));
  return empiricalPlans(rows,db.officialQuotas(from,to),{from,to_exclusive:to,timezone:config.timezone}).filter(p=>latest.some(q=>cycleKey(q)===p.cycle));
 }
 function withEmpirical(caps:any[]){const empirical=opts.values['experimental-empirical']?empiricalCurrent():[];return caps.map(c=>({...c,estimated_capacity:null,lower_bound:null,upper_bound:null,equivalents:{},strict_reason:c.reason??'unverified_account_window_attribution',reason:c.reason??'unverified_account_window_attribution',empirical:empirical.find(p=>p.limit_id===c.limit_id&&p.slot===c.slot&&p.resets_at===c.resets_at&&p.window_duration_mins===c.window_duration_mins)??null}));}
 function estimates(){
  const latest=db.latestQuota();
  const qs=db.cycleQuotas(latest);
  const earliest=latest.filter(q=>q.resets_at!==null&&q.window_duration_mins!==null).map(q=>new Date((q.resets_at!-q.window_duration_mins!*60)*1000).toISOString()).sort()[0];
  const result=quotaEstimates(qs,earliest?db.records(earliest):[],config,db.rules());
  db.transaction(()=>{for(const r of result)db.db.prepare('INSERT OR REPLACE INTO capacity_estimates VALUES (?,?,?)').run(hash(r.cycle),new Date().toISOString(),JSON.stringify(r));db.set('latest_estimates',result);});return result;
 }
 async function sync(){
  const rollout=await syncRollouts(db,config.codex_home,db.rules(),(n,total)=>{if(process.stderr.isTTY&&!opts.values.json)console.error(`正在导入：${n}/${total} 个文件`);});
  const account=opts.values.offline?{status:'skipped'}:await collectAccount(db,client);
  estimates();return {rollout,account};
 }
 try{
  if(command==='sync'){show(await sync());return;}
  if(command==='watch'){
   await runMonitor(db,client,config,home,{offline:opts.values.offline,once:opts.values.once,show,estimates});return;
  }
  if(command==='export'){const result=await exportData(db,opts.positionals[1]??'usage',period('report',config.timezone,opts.values.from,opts.values.to),opts.values.out);if(opts.values.out)show(result);return;}
  if(command==='estimate'){show(withEmpirical(estimates()));return;}
  if(command==='quota'){show({account:db.get('account'),windows:quotaView(db),collection:db.get('collection:account/rateLimits/read'),monitor:db.get('monitor_state')});return;}
  if(command==='doctor'){
   const integrity=db.db.prepare('PRAGMA quick_check').get();const checks={sqlite:integrity?.quick_check==='ok',source_exists:existsSync(config.codex_home),pricing_rules_valid:rules.length>0,readonly_collector_supported:process.platform==='darwin',sync_completed:!!db.get('last_sync')};
   const online=opts.values.online?await collectAccount(db,client):null;const ok=Object.values(checks).every(Boolean)&&(!online||online.status==='ok');
   show({ok,checks,online,monitor:db.get('monitor_state'),issues:db.issues(),last_sync:db.get('last_sync'),pricing_note:'Historical prices before the first verified effective date are unknown. Current-price revaluation is separate.',estimator:config.estimator});if(!ok)process.exitCode=1;return;
  }
  if(command==='models'){show(report(db.records(),db.rules()));return;}
  const range=period(command==='status'?'today':command,config.timezone,opts.values.from,opts.values.to);
  const rows=db.records(range.from,range.to_exclusive);
  if(command!=='status'){show({period:range,legacy_reconciliation:db.get('legacy_reconciliation'),...dailyReport(rows,db.officialQuotas(range.from,range.to_exclusive),db.rules(),range,undefined,{experimentalEmpirical:opts.values['experimental-empirical']})});return;}
  const lifetime=db.db.prepare('SELECT COALESCE(SUM(total_tokens),0) AS total FROM usage_records').get()!.total as number;
  const official=db.latestAccount();const day=localDay(new Date().toISOString(),config.timezone);const weekStart=midnight(shiftDay(day,-6),config.timezone);
  show({as_of:new Date().toISOString(),legacy_reconciliation:db.get('legacy_reconciliation'),monitor:db.get('monitor_state'),account:db.get('account'),quota:quotaView(db),today:{period:range,...report(rows,db.rules())},last_7_calendar_days:aggregate(db.records(weekStart)),capacity:withEmpirical(db.get<any[]>('latest_estimates')??[]),last_sync:db.get('last_sync'),account_cross_check:{local_tokens:lifetime,official_lifetime_tokens:official?.summary?.lifetimeTokens??null,difference:official?.summary?.lifetimeTokens==null?null:lifetime-official.summary.lifetimeTokens,official_observed_at:official?.timestamp??null,note:'Account scope, retention, recording gaps and reporting delay differ; difference is not automatically external usage.'},issues:db.issues()});
 }finally{client.close();db.close();}
}
function quotaView(db:Ledger){return db.latestQuota().map(({raw_json,...q})=>({...q,remaining_percent:100-q.used_percent,reset_iso:q.resets_at?new Date(q.resets_at*1000).toISOString():null,age_seconds:Math.max(0,(Date.now()-Date.parse(q.timestamp))/1000),plan_type:JSON.parse(raw_json)?.planType??JSON.parse(raw_json)?.plan_type??null}));}
