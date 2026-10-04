import {stripVTControlCharacters} from 'node:util';
export interface DisplayOptions {command?:string;details?:boolean;timezone?:string;width?:number;color?:boolean;now?:number;collection?:any;monitor?:any;}
const valid=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const exact=(n:unknown)=>valid(n)?n.toLocaleString('en-US',{maximumFractionDigits:2}):'未知';
const compact=(n:unknown)=>!valid(n)?'未知':Math.abs(n)>=1e8?`${exact(Number((n/1e8).toFixed(2)))} 亿`:Math.abs(n)>=1e4?`${exact(Number((n/1e4).toFixed(2)))} 万`:exact(n);
const money=(n:unknown)=>valid(n)?'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'暂不可计算';
const percent=(ratio:unknown)=>valid(ratio)?`${exact(Number((ratio*100).toFixed(2)))}%`:'未知';
// Terminal control sequences from model names or paths must not affect the UI.
const safe=(s:unknown)=>stripVTControlCharacters(String(s??'未知')).replace(/[\p{Cc}\p{Cf}]/gu,' ');
export function cellWidth(s:string){return [...stripVTControlCharacters(s)].reduce((n,c)=>n+(/\p{Mark}/u.test(c)?0:/[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(c)?2:1),0);}
function wrap(line:string,width:number){const out:string[]=[];let part='',n=0;for(const c of line){const size=cellWidth(c);if(n+size>width){out.push(part);part='';n=0;}part+=c;n+=size;}out.push(part);return out;}
const reasons:Record<string,string>={unverified_workspace_billing_identity:'后台账号范围已知，工作区/计费归属仍未完全核实',partial_local_account_window_attribution:'部分本地用量仍未归属，不能外推整体容量',unknown_account_identity:'额度快照缺少可验证账号身份',mixed_account_identity:'额度身份存在冲突，未拼接观测',unverified_local_account_window_attribution:'本地用量与账号及额度窗口的对应关系未知',unverified_account_window_attribution:'账号与额度窗口归属尚未核实',unknown_bucket_model_mapping:'缺少模型与额度窗口的映射',missing_verified_allowance_weights:'缺少已验证的模型额度权重',no_observations:'尚未采到额度数据',insufficient_clean_spans:'可用于推算的消耗区间不足',insufficient_clean_spans_or_coverage:'有效消耗区间或覆盖率不足'};
Object.assign(reasons,{invalid_historical_window_attribution:'历史记录不在其声明的额度周期内',inconsistent_historical_usage:'组合中含不可用于换算的历史记录',missing_verified_mix_weights_or_prices:'组合中缺少已验证的额度权重或价格',no_matched_tokens:'没有匹配的本地 Token'});
const issues:Record<string,[string,string]>={
 inconsistent_token_components:['Token 拆分不一致','保留总量；不对不一致的拆分计价。'],inherited_legacy_skipped:['已排除继承记录','去重处理，不代表新增数据丢失。'],legacy_initial_baseline_gap:['旧记录起始基线缺口','首次记录之前的消耗可能无法恢复。'],unrecoverable_usage_gap:['无法恢复的历史用量','现有日志不足，不能凭空补齐。'],unresolved_fork_history:['分叉历史无法确认','无法确认的继承部分未重复计入。'],malformed_line:['日志行格式损坏','该行未入账；其他完整记录继续处理。'],oversized_line_skipped:['日志行超过读取上限','该行已跳过，保留偏移用于排查。'],missing_timestamp:['记录缺少时间','无法按日期归属的记录需要核对。'],invalid_usage_record:['用量字段无效','该记录未作为有效用量入账。']};
export const errorMessages:Record<string,string>={
 repair_quota_context_conflict:'同一额度事实的身份/可用状态投影冲突，修复已回滚；原始证据保留。',
 repair_quota_fact_conflict:'同一 ID 的额度事实冲突，修复事务已回滚。原始输入和基线备份保留，请核对副本；本次未切换生产账本。',
 sqlite_backup_unavailable:'账本修复需要 node:sqlite.backup（Node.js 22 系列至少为 22.16.0）。请升级运行时；本次未创建输出。',
 report_range_too_large:'逐日报表最多支持 10 年，请缩小日期范围。',unknown_command:'命令不存在，请运行 cux --help 查看用法。',unknown_service_action:'服务操作不存在，请使用 status、start、stop、restart、install 或 uninstall。',unknown_export_kind:'导出类型不存在，请运行 cux --help 查看支持的类型。',invalid_date:'日期格式有误，请使用 YYYY-MM-DD 或有效时间戳。',invalid_date_range:'日期范围有误，开始时间必须早于结束时间。',invalid_arguments:'参数有误，请运行 cux --help 查看用法。',monitor_already_running:'自动监控已在运行，无需再启动 watch。请运行 cux service status 查看。',service_not_installed:'尚未安装后台服务，请运行 cux service install。',export_file_already_exists:'导出文件已存在，请换一个文件名；已有文件未被覆盖。',rpc_timeout:'官方查询超时；已保存的数据仍可读取。',app_server_exited:'官方采集进程已退出，请运行 cux doctor --online 检查。',app_server_spawn_failed:'无法启动官方采集进程，请检查 Codex 程序路径。',service_start_timeout:'后台服务启动未在等待时间内完成，请运行 cux service status 检查。',service_stop_timeout:'后台服务仍在退出，请稍后运行 cux service status 检查。',data_home_must_be_separate_from_codex_home:'账本目录与 Codex 源目录不能互相包含，请调整 --data-home。',invalid_monitor_interval:'采集间隔配置无效，请检查 config.json 中的 monitor。',invalid_poll_seconds:'旧轮询间隔配置无效，请检查 config.json。',service_requires_macos:'系统服务管理目前仅支持 macOS。',read_only_app_server_requires_macos_sandbox:'当前环境不支持受只读保护的在线采集，可使用 sync --offline。',rollout_directory_unreadable:'无法读取 Codex 日志目录，请检查目录和读取权限。',operation_failed:'操作未完成，请运行 cux doctor --details 检查，或加 --json 获取错误代码。'};
export function formatError(code:string){return `操作失败：${errorMessages[code]??'操作未完成，请检查配置或运行 cux doctor --details。'}\n错误代码：${safe(code)}`;}
export function format(value:any,options:DisplayOptions={}):string {
 const command=options.command??(value?.today?'status':value?.totals?'report':Array.isArray(value)?'estimate':value?.windows?'quota':'unknown');
 const details=!!options.details,tz=options.timezone??'Asia/Shanghai',now=options.now??Date.now();
 const width=Math.max(20,Math.min(value?.daily?220:88,options.width??80)),narrow=width<64;const rows:{text:string;style?:number}[]=[];
 const add=(text='',style?:number)=>{for(const line of String(text).split('\n'))for(const part of wrap(safe(line),width))rows.push({text:part,style});};
 const section=(title:string)=>{add();add(title,1);add('─'.repeat(Math.min(width,48)),2);};
 const pair=(label:string,v:unknown,style?:number)=>{const text=safe(v);if(width<40||cellWidth(label)+cellWidth(text)+2>Math.min(width,48)){add(label,2);add('  '+text,style);}else add(label+' '.repeat(Math.max(2,Math.min(width,48)-cellWidth(label)-cellWidth(text)))+text,style);};
 const num=(n:unknown)=>details?exact(n):compact(n);
 const stamp=(iso:unknown)=>{const d=new Date(String(iso));if(!Number.isFinite(d.getTime()))return '未知';return new Intl.DateTimeFormat('zh-CN',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',...(details?{second:'2-digit'}:{})}).format(d);};
 const duration=(ms:number)=>{const s=Math.max(0,Math.floor(ms/1000));return s>=86400?`${Math.floor(s/86400)}天${Math.floor(s%86400/3600)}小时`:s>=3600?`${Math.floor(s/3600)}小时${Math.floor(s%3600/60)}分`:s>=60?`${Math.floor(s/60)}分${s%60}秒`:`${s}秒`;};
 const age=(iso:unknown)=>{const at=Date.parse(String(iso));return !Number.isFinite(at)?'尚无记录':at>now+1000?'时间晚于当前时钟，请核对':duration(now-at)+'前';};
 const timeZone=tz==='Asia/Shanghai'?'北京时间':tz;
 const title=(s:string)=>{add(s,1);add(`${stamp(value?.as_of??new Date(now).toISOString())} · ${timeZone}`,2);};
 const windowName=(mins:unknown)=>!valid(mins)?'长度未知的额度窗口':mins%1440===0?`${exact(mins/1440)} 天额度窗口`:mins%60===0?`${exact(mins/60)} 小时额度窗口`:`${exact(mins)} 分钟额度窗口`;
 const methodName=(m:string)=>({'account/read':'账户信息','account/rateLimits/read':'官方额度','account/usage/read':'账户用量'}[m]??safe(m));
 function collection(r:any){if(!r)return;const status=r.status==='ok'?'成功':r.status==='skipped'?'离线，未查询':'失败或部分失败';pair('官方采集',status);if(r.timestamp)pair('查询时间',stamp(r.timestamp));for(const [method,status] of Object.entries(r.methods??{})){if(details||status!=='ok')add(`${methodName(method)}：${status==='ok'?'成功':errorMessages[String(status)]??'查询失败'}${details&&status!=='ok'?'（'+safe(status)+'）':''}`,status==='ok'?undefined:33);}if(r.code)add(errorMessages[r.code]??'查询失败，请运行 cux doctor --online 检查。',33);}
 function officialAvailability(snapshot:any){
  if(!snapshot)return;const a=snapshot.availability;section('官方可用状态 · 最近观测');
  pair('普通用量',a?.ordinary_usage_allowed===true?'官方允许':a?.ordinary_usage_allowed===false?'官方不允许':'未知');
  pair('支出控制',a?.spend_control_reached===true?'已达到限制':a?.spend_control_reached===false?'未达到限制':'未知');
  if(a?.sampled_at)add('状态采样于 '+stamp(a.sampled_at),2);
  add('状态独立于剩余百分比；重置时间不保证恢复。',2);add('此为所示时刻的采样，不保证之后的实时许可。',2);
  if(snapshot.scope?.status!=='verified')add('账号/工作区与本地用量归属尚未完全核实。',33);
 }
 function workload(v:any){
  if(!v)return;section('最近用量 · 本地记录');
  for(const w of v.windows??[])if(['last_7_days','last_30_days'].includes(w.name)){
   pair(w.name==='last_7_days'?'最近 7 天':'最近 30 天',num(w.totals.total_tokens)+' Token');
   if(details){pair('查询起点',stamp(w.from));pair('查询终点（不含）',stamp(w.to_exclusive));pair('首末观测',stamp(w.coverage.observed_from)+' → '+stamp(w.coverage.observed_to));}
  }
  add('按滚动范围独立查询；仅为已记录本地历史，未分配到账号或额度窗口。',2);
 }
 function quotas(qs:any[]){
  section('额度');
  if(!qs.length)add('暂无有效额度快照，请运行 cux sync 或检查采集状态。',33);
  for(const [i,q] of qs.entries()){
   if(i)add();add(`${safe(q.limit_id)} · ${windowName(q.window_duration_mins)}`,2);
   if(q.availability){pair('普通用量',q.availability.ordinary_usage_allowed===true?'官方允许':q.availability.ordinary_usage_allowed===false?'官方不允许':'未知');pair('支出控制',q.availability.spend_control_reached===true?'已达到限制':q.availability.spend_control_reached===false?'未达到限制':'未知');}
   const p=q.used_percent;
   if(valid(p)&&p>=0&&p<=100){pair('剩余 '+percent((100-p)/100),'已用 '+percent(p/100),1);const size=Math.min(24,width);const filled=Math.round(size*p/100);add('█'.repeat(filled)+'░'.repeat(size-filled),p>=90?33:36);}
   else add('额度百分比暂不可用',33);
   const reset=q.reset_iso??(q.resets_at?new Date(q.resets_at*1000).toISOString():null);pair('下次重置',reset?stamp(reset):'未知');if(reset)add(Date.parse(reset)>now?'约 '+duration(Date.parse(reset)-now)+'后':'重置时间已过，等待新快照',2);
   add('额度更新于 '+age(q.timestamp),2);
   const policy=(value.monitor??options.monitor)?.policy;const staleSeconds=Math.max(300,policy?.quota_idle_seconds??900)*2;
   if(now-Date.parse(q.timestamp)>staleSeconds*1000)add('注意：额度快照较旧，不代表当前实时剩余量。',33);
   if(details){pair('身份状态',q.scope?.status??'unknown');pair('数据来源',q.source==='app_server'?'官方查询':q.source==='rollout'?'本地日志中的额度':q.source);pair('窗口位置',q.slot??'未知');}
  }
  const c=value.collection??options.collection;if(c&&c.status!=='ok'){add('最近额度查询失败，以上为已有快照。',33);if(details)collection(c);}
 }
 function tokens(t:any){
  if(!t||t.records===0){add('此范围内暂无已入账记录。');return;}
  pair('总 Token',num(t.total_tokens),1);add();
  if(details)pair('输入合计',num(t.input_tokens));
  pair('缓存输入',num(t.cached_input_tokens));pair('普通输入',num(t.uncached_input_tokens));
  if(details||t.cache_write_input_tokens)pair('缓存写入',num(t.cache_write_input_tokens));pair('输出',num(t.output_tokens));
  if(details)pair('其中推理输出',num(t.reasoning_output_tokens));
  if(t.unclassified_tokens)pair('尚未分类',num(t.unclassified_tokens));
  add();pair('输入缓存命中率',t.input_tokens>0?percent(t.cached_input_tokens/t.input_tokens):'不适用（无输入）');
  if(details){pair('用量记录',exact(t.records));pair('唯一响应',exact(t.unique_responses));pair('会话数',exact(t.sessions));add('缓存读取与写入包含在输入中；推理输出包含在输出中。',2);}
 }
 function valuation(v:any,historical:any){
  section('API 等效价值 · 按当前价格');
  if(!historical?.records){add('暂无用量，金额不适用。');return;}
  if(!v){add('暂不可计算，缺少价格重估结果。',33);return;}
  const coverage=v.api_token_coverage,full=v.api_equivalent_usd!==null&&valid(v.api_equivalent_usd);
  pair(full?'已计价金额':'可计价部分',valid(coverage)&&coverage>0?money(v.known_api_subtotal_usd):'暂无可计价用量',1);pair('Token 计价覆盖率',percent(coverage));
  add(full?'这是 API 等效金额，不是订阅账单。':'这是部分用量的 API 等效金额，不是订阅账单。',2);
  if(valid(coverage)&&coverage<1)add(`其余 ${percent(1-coverage)} 暂时无法计价。`,33);
  if(details){pair('重估时间',stamp(v.at));section('历史价格与 credits · 详情');pair('历史 API 完整金额',money(historical.api_equivalent_usd));pair('历史 API 已知小计',money(historical.known_api_subtotal_usd));pair('历史 API 覆盖率',percent(historical.api_token_coverage));pair('历史 credits 完整等效值',historical.credit_equivalent===null?'暂不可计算':exact(historical.credit_equivalent));pair('历史 credits 已知小计',exact(historical.known_credit_subtotal));pair('历史 credits 覆盖率',percent(historical.credit_token_coverage));add('历史价格只覆盖已验证有效期；缺价不等于零消耗。',2);}
 }
 function monitor(m:any,lastSync?:any){
  if(!m){add('○ 尚无监控状态；运行 cux service status 检查。',33);}else{
   const ageMs=now-Date.parse(m.heartbeat_at),fresh=m.running&&ageMs>=-1000&&ageMs<90000;
   add(fresh?'● 后台运行中':m.running?'! 监控心跳已过期，请检查服务。':'○ 监控已停止',fresh?32:33);
   if(m.offline)add('当前为离线采集；官方额度不会刷新。',33);
   if(details){pair('最近心跳',stamp(m.heartbeat_at));pair('当前频率',m.active?'活跃':'空闲');pair('下次本地检查',stamp(m.next_local_at));pair('下次额度查询',m.offline?'离线模式':stamp(m.next_quota_at));pair('下次汇总查询',m.offline?'离线模式':stamp(m.next_summary_at));}
  }
  if(lastSync){add('Token 更新于 '+age(lastSync.synced_at),2);if(now-Date.parse(lastSync.synced_at)>Math.max(300,m?.policy?.local_reconcile_seconds??300)*2000)add('注意：本地同步时间较旧，请检查采集是否正常。',33);}
 }
 function capacity(cs:any[],brief=false){
  if(!cs.length){add('套餐总容量：暂不可推算，尚无有效周期数据。',33);return;}
  for(const c of cs){
   const e=c.empirical;
   if(e?.estimated_tokens!=null){
    add('实验经验外推；严格估算不可用：'+(reasons[c.strict_reason??c.reason]??'账号与额度窗口归属尚未核实'),33);
    if(brief){add(`Plan 100% · ${safe(c.limit_id)}：约 ${num(e.estimated_tokens)} Token（观测组合外推）`,1);add(`样本消耗 ${exact(e.percent_points)} 个百分点；假设模型组合不变且无未记录消耗。`,2);continue;}
    section(`${safe(c.limit_id)} · 观测组合外推`);pair('Plan 100% 等效 Token','约 '+num(e.estimated_tokens),1);pair('样本额度消耗',exact(e.percent_points)+' 个百分点');pair('匹配时段 Token',num(e.matched_tokens));pair('观测开始',stamp(e.observed_from));pair('观测结束',stamp(e.observed_to));pair('API 等效已知部分',money(e.estimated_api_known_usd));pair('Token 计价覆盖率',percent(e.api_token_coverage));add('按观测模型、速度与缓存组合外推，并非官方 Token 上限；假设无未记录的账户消耗。',2);
    if(e.flags.includes('sampling_gap'))add('观测中存在超过 30 分钟的采样空档。',33);
    if(details){pair('仅取整误差下界',num(e.rounding_only_lower));pair('仅取整误差上界',num(e.rounding_only_upper));add('上述上下界不包含模型变化、记录缺失等误差，不是置信区间。',2);for(const [model,t] of Object.entries(e.model_tokens))pair(safe(model),num(t));}
    if(!details)continue;
   }
   const experimental=c.basis==='experimental_credit_proxy';
   if(brief){add(`套餐总容量 · ${safe(c.limit_id)}：${c.estimated_capacity==null?'—':`约 ${num(c.estimated_capacity)} 加权额度单位`}`,c.estimated_capacity==null?33:undefined);if(c.estimated_capacity==null)add(reasons[c.reason]??'证据不足',33);if(experimental)add('实验性 credits 代理估计，不是官方容量。',33);continue;}
   section(`${safe(c.limit_id)} · ${windowName(c.window_duration_mins)}`);officialAvailability({scope:c.scope,availability:c.availability});if(details)workload(c.workload);
   if(c.estimated_capacity==null){add('暂不可推算',33);add(reasons[c.reason]??'证据不足');}
   else{pair('容量估计',num(c.estimated_capacity)+' 加权额度单位');pair('估计范围',num(c.lower_bound)+' ～ '+num(c.upper_bound));pair('可信程度',({HIGH:'较高',MEDIUM:'中等',LOW:'较低'} as any)[c.confidence]??'未知');add('范围反映取整误差及观测差异，不是 95% 置信区间。',2);}
   add(experimental?'依据：实验性 credits 代理；映射由用户提供，不是官方容量。':'方法：仅使用已验证的额度权重，缺少权重时不输出容量。',experimental?33:2);
   pair('有效消耗区间',exact(c.clean_span_count));pair('有效区间累计变化',exact(c.observed_percent_span)+' 个百分点');pair('观测跨度覆盖率',percent(c.coverage_ratio));
   if(c.external_usage_detected)add('发现外部消耗或异常区间，已影响估计。',33);
   if(details){pair('额度观测数',exact(c.observation_count));pair('还缺有效区间',exact(c.missing_clean_spans));pair('还缺变化百分点',exact(c.missing_percent_span));if(c.reason)pair('原因代码',c.reason);
    const mixNames:Record<string,string>={last_7_days:'最近 7 天用量组合',last_30_days:'最近 30 天用量组合',cycle:'本周期用量组合'};
    for(const [key,mix] of Object.entries(c.equivalents??{}) as [string,any][]){add(mixNames[key]??safe(key));add(mix?`  等效 Token ${num(mix.equivalent_tokens)} · API ${money(mix.equivalent_api_usd)}`:'  暂不可换算'+(c.equivalent_reasons?.[key]?'：'+(reasons[c.equivalent_reasons[key]]??'证据不足'):''));}
    for(const span of c.spans??[])add(`${stamp(span.from)} → ${stamp(span.to)}：${exact(span.delta)} 个百分点；${span.candidate==null?'未用于估计':'候选容量 '+num(span.candidate)}`);
   }
  }
 }
 function quality(list:any[],full=false){
  const warnings=list.filter(x=>x.code!=='inherited_legacy_skipped'),dedup=list.filter(x=>x.code==='inherited_legacy_skipped');
  if(!full){if(warnings.length)add('历史数据有完整性提示，可运行 cux doctor 查看。',33);return;}
  section('历史数据质量');if(!warnings.length)add('未发现已记录的数据完整性问题。');
  for(const q of [...warnings,...dedup]){const description=issues[q.code];pair(description?.[0]??'其他数据问题',exact(q.count)+' 次');add(description?.[1]??'请结合问题代码核对日志。',2);if(details)pair('问题代码',q.code);}
  if(list.length)add('以上为累计事件数，不等于缺失 Token 数，也不表示当前采集失败。',2);
 }
 function modelTable(report:any){
  section('模型消耗排行');const all=(Object.entries(report.models??{}) as [string,any][]).sort((a,b)=>b[1].total_tokens-a[1].total_tokens);const top=details?all:all.slice(0,5);
  if(!top.length){add('此范围内暂无模型用量。');return;}
  if(!narrow)add('模型 / Token                         占比     缓存命中');
  for(const [i,[model,t]] of top.entries()){
   const share=report.totals.total_tokens>0?percent(t.total_tokens/report.totals.total_tokens):'不适用',hit=t.input_tokens>0?percent(t.cached_input_tokens/t.input_tokens):'不适用';
   add(`${i+1}. ${model==='unknown'?'未识别模型':safe(model)}`,1);
   if(narrow){pair('Token',num(t.total_tokens));pair('消耗占比',share);pair('输入缓存命中率',hit);}else pair('   '+num(t.total_tokens),share+'     '+hit);
   add(`   历史 API 已知小计 ${money(t.known_api_subtotal_usd)} · 覆盖 ${percent(t.api_token_coverage)}`,2);
  }
  if(top.length<all.length)add(`另有 ${all.length-top.length} 个模型；加 --details 查看全部。`,2);
 }
 function dailyTable(v:any){
  section('逐日用量 · 模型明细');
  const headers=['日期','模型 / 层级','总 Token','输入','输出','缓存命中率','Plan 消耗','100% 等效 Token','API 等效已知小计','计价覆盖率'];
  const table:{cells:string[];bold:boolean}[]=[];
  const dayLabel=(d:string)=>d.slice(5).replace('-','/');
  const verified=(p:any)=>p.scope?.status==='verified'&&p.scope.account_ref&&p.scope.workspace_ref&&p.scope.billing_source;
  const cycles=v.plan_cycles.filter(verified);
  // Display groups are labels for observations only. They never join evidence or percentages into a capacity cycle.
  const summaries=(plans:any[])=>{
   const groups=new Map<string,{limit_id:string;slot:string;minutes:number;count:number;from:string;to:string}>();
   for(const p of plans.filter((p:any)=>!verified(p))){const key=JSON.stringify([p.limit_id,p.slot,p.window_duration_mins]),old=groups.get(key);
    if(old){old.count+=p.observation_count;old.from=[old.from,p.observed_from].filter(Boolean).sort()[0];old.to=[old.to,p.observed_to].filter(Boolean).sort().at(-1)!;}
    else groups.set(key,{limit_id:p.limit_id,slot:p.slot,minutes:p.window_duration_mins,count:p.observation_count,from:p.observed_from,to:p.observed_to});
   }
   return [...groups.values()];
  };
  if(v.legacy_reconciliation?.conflict_records)add('争议用量记录：'+num(v.legacy_reconciliation.conflict_records)+' 条；双方证据保留，未计入确认用量，数量待核对。',33);
  if(v.legacy_reconciliation?.pending_tokens)add('待核对的分叉 Token：'+num(v.legacy_reconciliation.pending_tokens)+'；未计入确认用量。',33);
  if(v.legacy_reconciliation?.source_unavailable_candidate_tokens)add('缺源的待核对候选 Token：'+num(v.legacy_reconciliation.source_unavailable_candidate_tokens)+'；保留事实，未计入确认用量。',33);
  if(v.totals?.source_unavailable_tokens)add('保留的缺源历史 Token：'+num(v.totals.source_unavailable_tokens)+'；当前无法重新核实归因。',33);
  const planCells=(plans:any[])=>plans.length===1?[plans[0].percent_points==null?'—':exact(plans[0].percent_points)+'%'+(plans[0].partial?'*':''),plans[0].estimated_tokens==null?'—':'约 '+num(plans[0].estimated_tokens)]:['—','—'];
  const record=(date:string,label:string,t:any,priced:any,plans:any[]=[],bold=false)=>{
   const has=t?.records>0,pc=planCells(plans);
   table.push({cells:[date,label,has?num(t.total_tokens):'—',has?num(t.input_tokens):'—',has?num(t.output_tokens):'—',has&&t.input_tokens>0?percent(t.cached_input_tokens/t.input_tokens):'—',...pc,has&&priced?.api_token_coverage>0?money(priced.known_api_subtotal_usd):'—',has?percent(priced?.api_token_coverage):'—'],bold});
  };
  const modelRows=(date:string,models:any)=>{for(const [model,t] of (Object.entries(models??{}) as [string,any][]).sort((a,b)=>b[1].total_tokens-a[1].total_tokens))record(date,'↳ '+(model==='unknown'?'未识别模型':safe(model)),t,t.current_price_valuation);};
  const planRows=(plans:any[],date:string)=>{for(const [i,p] of plans.entries()){
   table.push({cells:[date,`↳ 窗口 ${i+1}`,'—','—','—','—',...planCells([p]),'—','—'],bold:false});
  }};
  for(const day of v.daily){
   const label=dayLabel(day.date)+(day.ongoing?' 至今':'');
   const plans=day.plans.filter(verified);
   record(label,day.totals.records?'当日合计':'无记录',day.totals,day.current_price_valuation,plans,true);
   modelRows('↳',day.models);if(plans.length>1)planRows(plans,'↳');
   for(const s of summaries(day.plans))table.push({cells:['↳',`观测 · ${safe(s.limit_id)} / ${safe(s.slot)} · ${windowName(s.minutes)} · ${exact(s.count)} 条`,'—','—','—','—','—','—','—','—'],bold:false});
  }
  record('区间合计','全部模型',v.totals,v.current_price_valuation,cycles,true);modelRows('↳',v.models);
  if(cycles.length>1)planRows(cycles,'区间分段');
  // All ten columns remain in a single table. Cells wrap inside their own column;
  // extremely narrow terminals use a labeled row rather than dropping columns.
  if(width<64){
   for(const r of table){add();for(let i=0;i<headers.length;i++)pair(headers[i],r.cells[i],r.bold&&i<2?1:undefined);}
  }else{
   const widths=width>=140?[10,23,12,12,11,10,10,17,13,10]:width>=110?[8,18,10,10,9,8,8,13,11,8]:[6,10,7,7,7,6,6,9,9,6];
   while(widths.reduce((a,b)=>a+b,0)+9>width){const index=widths.indexOf(Math.max(...widths));widths[index]--;}
   const print=(cells:string[],bold=false)=>{const lines=cells.map((c,i)=>wrap(safe(c),widths[i]));const height=Math.max(...lines.map(x=>x.length));for(let n=0;n<height;n++){const line=lines.map((parts,i)=>{const part=parts[n]??'';return part+' '.repeat(Math.max(0,widths[i]-cellWidth(part)));}).join('│');rows.push({text:line.trimEnd(),style:bold?1:undefined});}};
   print(headers,true);add(widths.map(w=>'─'.repeat(w)).join('┼'),2);
   for(const [i,r] of table.entries()){if(i&&r.bold)add(widths.map(w=>'─'.repeat(w)).join('┼'),2);print(r.cells,r.bold);}
  }
  if(v.daily_basis?.strict_reason)add('严格容量估算不可用：账号与额度窗口归属尚未核实。'+(v.daily_basis.experimental_empirical?'已启用显式实验经验外推；缺少证据时仍为空。':''),33);
  add();add('— 表示无记录、不可估计或未做模型额度归因，不代表 0。',2);
  add('* Plan 仅统计已观测时段；Token 列是全日/至今用量，反推只使用匹配时段的 Token。',2);
  add('API 金额为按当前价格重估的已知小计，并非订阅账单；模型行不可与合计再次相加。',2);
  add('100% 等效 Token 是经验外推，并非官方上限；假设模型/速度/缓存组合不变且无未记录消耗。',2);
  if(cycles.length>1)add('存在多个额度窗口或重置周期，分别列示；不同周期的百分比不合并。',33);
  if(v.plan_cycles.some((p:any)=>!verified(p)))add('未知归属的快照按日期和额度桶标签摘要展示；不拼接百分比、不推算容量。独立证据保留在 JSON 输出。',2);
  const reasons:Record<string,string>={unverified_workspace_billing_identity:'后台账号范围已知，工作区/计费归属仍未完全核实',partial_local_account_window_attribution:'部分本地用量仍未归属，不能外推整体容量',unknown_account_identity:'额度快照缺少可验证账号身份',mixed_account_identity:'额度身份存在冲突，未拼接观测',unverified_local_account_window_attribution:'本地用量与账号及额度窗口的对应关系未知',unverified_account_window_attribution:'账号与额度窗口归属尚未核实',conflicting_snapshots:'同一时刻额度快照冲突',no_observations:'缺少成对观测',small_percent_change:'变化不足 5 个百分点',percent_decrease:'区间内百分比回退',external_usage_suspected:'存在疑似外部消耗',inconsistent_tokens:'Token 数据不一致',saturated:'额度已达 100%，观测受上限影响',no_matched_tokens:'没有匹配的本地 Token'};
  const emptyDays=v.daily.filter((d:any)=>!d.plans.length).map((d:any)=>dayLabel(d.date));
  if(emptyDays.length)add('无官方成对快照的日期不估算 Plan 消耗或容量。',2);
  for(const day of v.daily){
   for(const s of summaries(day.plans))add(`${dayLabel(day.date)} 观测摘要：${safe(s.limit_id)} / ${safe(s.slot)} / ${windowName(s.minutes)}；${exact(s.count)} 条；${stamp(s.from)} → ${stamp(s.to)}；归属未知。`,2);
   const plans=day.plans.filter(verified);
   for(const [i,p] of plans.entries()){
   const prefix=dayLabel(day.date)+(plans.length>1?` 窗口 ${i+1}`:'');
   add(`${prefix}：${stamp(p.observed_from)} → ${stamp(p.observed_to)}${p.reason?'；'+(reasons[p.reason]??'证据不足'):''}${p.flags.includes('sampling_gap')?'；存在超过 30 分钟的采样空档':''}`,2);
   if(details){pair('匹配时段 Token',num(p.matched_tokens));pair('原始变化',exact(p.percent_points)+' 个百分点');pair('额度标识',`${p.limit_id} / ${p.slot} / ${p.window_duration_mins} 分钟`);pair('周期重置',stamp(new Date(p.resets_at*1000).toISOString()));if(p.flags.length)pair('观测标记',p.flags.join(', '));}
  }}
  for(const [i,p] of cycles.entries())if(cycles.length>1||details)add(`区间${cycles.length>1?'窗口 '+(i+1):'合计'}：${safe(p.limit_id)} / ${windowName(p.window_duration_mins)} / ${p.slot} / 重置 ${stamp(new Date(p.resets_at*1000).toISOString())}${details?'':':'+String(new Date(p.resets_at*1000).getUTCSeconds()).padStart(2,'0')}；匹配 Token ${num(p.matched_tokens)}`,2);
 }
 function syncResult(v:any){title('同步结果');section('本地记录');pair('新增记录',exact(v.rollout?.added_records));pair('变化文件',exact(v.rollout?.changed_files));pair('检查文件',exact(v.rollout?.files));if(v.rollout?.malformed_or_oversized_lines)add('发现损坏或超限日志行，请运行 cux doctor 查看。',33);pair('完成时间',stamp(v.rollout?.synced_at));section('官方数据');collection(v.account);}
 if(command==='status'){
  title('Codex 用量账本 · '+safe(({pro:'Pro',plus:'Plus',free:'Free',business:'Business',enterprise:'Enterprise'} as any)[value.account?.plan]??value.account?.plan??'套餐未知'));
  officialAvailability(value.official_availability);quotas(value.quota??[]);section('今日用量');tokens(value.today?.totals);valuation(value.today?.current_price_valuation,value.today?.totals);
  if(value.legacy_reconciliation?.conflict_records)add('争议用量记录：'+num(value.legacy_reconciliation.conflict_records)+' 条；双方证据保留，未计入确认用量，数量待核对。',33);
  if(value.legacy_reconciliation?.pending_tokens)add('待核对的分叉 Token：'+num(value.legacy_reconciliation.pending_tokens)+'；未计入确认用量。',33);
  if(value.legacy_reconciliation?.source_unavailable_candidate_tokens)add('缺源的待核对候选 Token：'+num(value.legacy_reconciliation.source_unavailable_candidate_tokens)+'；保留事实，未计入确认用量。',33);
  if(value.today?.totals?.source_unavailable_tokens)add('今日含缺源历史 Token：'+num(value.today.totals.source_unavailable_tokens)+'；当前无法重新核实归因。',33);
  workload(value.workload);section('采集状态');monitor(value.monitor,value.last_sync);add();capacity(value.capacity??[],true);quality(value.issues??[]);
  if(details){section('账户总量核对');pair('本地累计 Token',num(value.account_cross_check?.local_tokens));pair('官方累计 Token',num(value.account_cross_check?.official_lifetime_tokens));pair('本地减官方',num(value.account_cross_check?.difference));pair('官方汇总采集时间',stamp(value.account_cross_check?.official_observed_at));add('范围、保留期限和上报延迟不同，差额不能直接当作外部消耗。',2);modelTable(value.today);quality(value.issues??[],true);}
  else{add();add('更多明细：cux status --details',2);}
 }else if(['today','week','month','report','models'].includes(command)){
  title(({today:'今日用量',week:'本周用量',month:'本月用量',report:'区间用量',models:'模型用量 · 全部已入账历史'} as any)[command]);
  if(value.period){const start=(value.display_period??value.period).from,end=(value.display_period??value.period).to_exclusive;const midnight=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(end))==='00:00:00';
   const startsAtMidnight=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(start))==='00:00:00';
   if(midnight&&startsAtMidnight&&!details)add(`统计范围：${stamp(start).split(' ')[0]} 至 ${stamp(new Date(Date.parse(end)-1).toISOString()).split(' ')[0]}（含末日）`,2);
   else add(`统计范围：${stamp(start)} 至 ${stamp(end)}（不含结束时刻）`,2);
  }
  officialAvailability(value.official_availability);if(value.daily){dailyTable(value);if(details){section('用量合计 · 精确口径');tokens(value.totals);valuation(value.current_price_valuation,value.totals);}}else{section('用量合计');tokens(value.totals);valuation(value.current_price_valuation,value.totals);modelTable(value);}
  if(!details){add();add(`精确数字与完整明细：cux ${command} --details${command==='report'?'（沿用日期参数）':''}`,2);}
 }else if(command==='quota'){title('Codex 额度');officialAvailability(value.official_availability);quotas(value.windows??[]);if(details){section('采集状态');monitor(value.monitor);collection(value.collection);}}
 else if(command==='estimate'){title('套餐容量推算');capacity(Array.isArray(value)?value:[]);if(!details){add();add('详细依据：cux estimate --details',2);}}
 else if(command==='doctor'){
  title('账本诊断');section('当前检查');add(value.ok?'✓ 本次基础检查通过':'! 本次检查发现异常',value.ok?32:33);
  const names:Record<string,string>={sqlite:'数据库完整性',source_exists:'源目录存在',pricing_rules_valid:'价格规则格式',readonly_collector_supported:'只读在线采集支持',sync_completed:'已有同步记录'};
  for(const [k,ok] of Object.entries(value.checks??{}))pair(names[k]??k,ok?'通过':'未通过');
  if(value.online)collection(value.online);else add('本次未检查网络；运行 cux doctor --online 检查官方查询。',2);
  section('监控状态');monitor(value.monitor,value.last_sync);quality(value.issues??[],true);
  section('下一步');if(!value.ok)add('先处理未通过的检查项；在线采集异常可运行 cux doctor --online --details。',33);
  add('历史缺口需有可恢复的源日志才能补齐；不要删除账本。');add('基础检查通过不表示历史全覆盖或额度权重已验证。',2);
 }else if(command==='service'){
  title('自动监控服务');section('运行状态');pair('后台服务',value.running?'运行中':value.loaded?'正在切换状态':'未运行');pair('登录自动启动',value.login_enabled?'已启用':'已停用');pair('安装状态',value.installed?'已安装':'未安装');
  if(options.monitor){section('最近采集心跳');monitor({...options.monitor,running:!!value.running&&options.monitor.running});if(!details)pair('最近心跳',stamp(options.monitor.heartbeat_at));}
  if(details){section('服务详情');pair('进程 ID',value.pid??'无');pair('系统状态',value.state);pair('数据目录',value.data_home);pair('启动项',value.plist);pair('运行日志',value.log);pair('错误日志',value.error_log);}
  add();add(value.running?'暂停：cux service stop':value.installed?'恢复：cux service start':'启用：cux service install',2);
 }else if(command==='sync')syncResult(value);
 else if(command==='export'){title('导出完成');pair('记录数',exact(value.records));pair('格式','JSONL（每行一条 JSON）');add('已保存至：');add(value.path??'标准输出');if(value.range)add(`事件范围：${stamp(value.range.from)} 至 ${stamp(value.range.to_exclusive)}（不含结束时刻）`,2);add('这是静态快照，后台新增记录不会自动写入此文件。',2);}
 else if(command==='watch'){
  const names:Record<string,string>={started:'监控已启动',stopped:'监控已停止',local_sync:'本地入账',remote_sync:'官方采集',observation_gap:'观测中断',watcher:'文件监听',estimate:'容量计算'};
  const state=value.status==='ok'?'成功':value.status==='unknown'?'需留意':'异常';
  const info=value.kind==='local_sync'&&value.status==='ok'?`新增 ${exact(value.data?.added_records)} 条 · ${exact(value.data?.changed_files)} 个变化文件`:value.kind==='remote_sync'?Object.entries(value.data?.methods??{}).map(([m,s])=>methodName(m)+(s==='ok'?'成功':'失败')).join(' · '):value.kind==='observation_gap'?'已记录空档；缺失的历史额度无法补造':value.data?.code?errorMessages[value.data.code]??'请运行 cux doctor --details 检查':'';
  add(`${stamp(value.timestamp)} · ${names[value.kind]??'监控'} · ${state}${info?' · '+info:''}`,value.status==='ok'?undefined:33);
  if(details&&value.data?.code)pair('错误代码',value.data.code);
 }else add('暂无可展示结果，请加 --json 查看原始输出。');
 return rows.map(r=>options.color&&r.style?`\x1b[${r.style}m${r.text}\x1b[0m`:r.text).join('\n');
}
