import {stripVTControlCharacters} from 'node:util';
import {cellWidth,type DisplayOptions} from './display.js';
const valid=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const exact=(n:number)=>n.toLocaleString('en-US',{maximumFractionDigits:2});
const number=(n:unknown)=>!valid(n)?'—':Math.abs(n)>=1e8?exact(Number((n/1e8).toFixed(2)))+' 亿':Math.abs(n)>=1e4?exact(Number((n/1e4).toFixed(2)))+' 万':exact(n);
const money=(n:unknown)=>valid(n)?'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
const percent=(n:unknown)=>valid(n)?exact(Number((n*100).toFixed(2)))+'%':'—';
const safe=(s:unknown)=>stripVTControlCharacters(String(s??'—')).replace(/[\p{Cc}\p{Cf}]/gu,' ');
const identity=(p:any)=>p?.scope?.account_ref&&p.scope.status!=='mixed'?JSON.stringify([p.scope.account_ref,p.scope.workspace_ref,p.scope.billing_source,p.limit_id,p.slot,p.window_duration_mins]):null;

// Read-only presentation: amounts and percentages are selected from existing results.
export function readerDisplay(value:any,options:DisplayOptions):string {
 const command=options.command??(value?.today?'status':'report'),status=command==='status';
 const width=Math.max(20,Math.min(220,options.width??80)),tz=options.timezone??'Asia/Shanghai',now=options.now??Date.now();
 const lines:{text:string;bold?:boolean}[]=[];
 const add=(text='',bold=false)=>{
  // Numeric tokens remain intact; wrapping prose may separate a label from its value.
  const atoms=safe(text).match(/\$?[+-]?\d[\d,.]*(?:%| 万| 亿)?|[^\d]/gu)??[''];let line='';
  for(const atom of atoms){if(cellWidth(line)+cellWidth(atom)>width&&line){lines.push({text:line.trimEnd(),bold});line='';}line+=atom;}
  lines.push({text:line.trimEnd(),bold});
 };
 const pair=(label:string,v:string)=>{if(cellWidth(label+'  '+v)<=width)add(label+'  '+v);else{add(label);add('  '+v);}};
 const section=(label:string)=>{add();add(label,true);};
 const clock=(iso:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso));
 const stamp=(iso:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso));
 const observation=(plans:any[]=[])=>{
  if(!plans.length||plans.some(p=>!identity(p))||new Set(plans.map(identity)).size!==1)return null;
  if(plans.length===1)return plans[0];
  const ordered=[...plans].sort((a,b)=>a.observed_from.localeCompare(b.observed_from));
  return {...ordered.at(-1),parts:ordered,percent_points:plans.every(p=>valid(p.percent_points))?plans.reduce((n,p)=>n+p.percent_points,0):null};
 };
 const remaining=(p:any):string=>{
  if(!p)return '—';const path=p.remaining?.trajectory??[{remaining_percent:100-p.from_percent},{remaining_percent:100-p.to_percent}];
  if(p.parts)return p.parts.map(remaining).join(' / ');
  const recoveries=path.filter((q:any)=>q.event==='recovery');
  if(recoveries.length>2)return `${exact(p.remaining.from_percent)}% → …（${recoveries.length}次回升）→ ${exact(p.remaining.to_percent)}%`;
  return path.map((q:any)=>exact(q.remaining_percent)+'%'+(q.event==='recovery'?`（${clock(q.timestamp)}回升）`:'')).join(' → ')+(p.observation_count===1?'（单点）':'');
 };
 const consumed=(p:any)=>p&&valid(p.percent_points)?'≈'+exact(p.percent_points):'—';
 const priced=(t:any,p:any)=>t?.records>0&&valid(p?.api_token_coverage)&&p.api_token_coverage>0&&valid(p.known_api_subtotal_usd)?money(p.known_api_subtotal_usd)+(p.api_token_coverage<1?'*':''):'—';
 const usage=(label:string,t:any,p:any)=>[label,t?.records>0?number(t.total_tokens):'—',t?.records>0?number(t.input_tokens):'—',t?.records>0?number(t.output_tokens):'—',t?.records>0&&t.input_tokens>0?percent(t.cached_input_tokens/t.input_tokens):'—',priced(t,p)];
 const table=(headers:string[],rows:string[][],groups:number[][])=>{
  if(width<64){for(const cells of rows){add(cells[0],true);for(let i=1;i<headers.length;i++)pair(headers[i],cells[i]);add();}return;}
  const print=(indexes:number[])=>{
   const sizes=indexes.map(i=>Math.max(cellWidth(headers[i]),...rows.map(r=>cellWidth(safe(r[i])))));
   const needed=sizes.reduce((n,s)=>n+s,0)+indexes.length-1;
   if(needed>width){for(const cells of rows){add(cells[0],true);for(const i of indexes.filter(i=>i!==0))pair(headers[i],cells[i]);}return;}
   const line=(cells:string[],bold=false)=>add(indexes.map((i,n)=>safe(cells[i])+' '.repeat(sizes[n]-cellWidth(safe(cells[i])))).join('│'),bold);
   line(headers,true);add(sizes.map(n=>'─'.repeat(n)).join('┼'));for(const cells of rows)line(cells,cells[0]==='合计'||cells[0]==='累计消耗');
  };
  const full=headers.map((_,i)=>i),fullSize=full.reduce((n,i)=>n+Math.max(cellWidth(headers[i]),...rows.map(r=>cellWidth(safe(r[i])))),headers.length-1);
  if(width>=110&&fullSize<=width)print(full);else for(const [n,g] of groups.entries()){if(n)add();print(g);}
 };
 const conditional=value.conditional_capacity;
 const roots=new Map<string,any>((conditional?.windows??[]).map((w:any)=>[w.id,w]));
 const capacities=(windows:any[]=[],plans:any[]=[])=>{
  const resolved=windows.map(w=>({...roots.get(w.epoch_id??w.id),...w}));
  const visible=resolved.filter(w=>identity(w)&&plans.some(p=>identity(p)===identity(w)&&(p.segments??[]).some((s:any)=>valid(s.resets_at)&&Math.abs(s.resets_at-w.reset_anchor)<=1)));
  const keys=new Set(visible.map(identity));
  if(!visible.length||keys.size!==1||plans.some(p=>!identity(p)||identity(p)!==[...keys][0]))return {api:'—',tokens:'—',label:'范围不明或不可估',range:false,coverage:[] as number[]};
  const available=visible.filter(w=>valid(w.api?.equivalent_100_percent));
  if(!available.length)return {api:'—',tokens:'—',label:'无有效估算',range:false,coverage:[] as number[]};
  const partial=available.some(w=>w.api.coverage==='known_partial');
  const missing=available.length<visible.length||plans.some(p=>(p.segments??[]).some((s:any)=>!visible.some(w=>valid(s.resets_at)&&Math.abs(s.resets_at-w.reset_anchor)<=1)));
  const render=(values:number[],format:(n:number)=>string)=>{const lo=Math.min(...values),hi=Math.max(...values);return (lo===hi?format(lo):format(lo)+'～'+format(hi))+(partial?'*':'');};
  const tokens=available.map(w=>w.reference_tokens);
  return {api:render(available.map(w=>w.api.equivalent_100_percent),money),tokens:tokens.every(valid)?render(tokens,number):'—',label:missing?'可估分段（其余 —）':visible.length>1?'分段估算':'观测段估算',range:visible.length>1,coverage:available.map(w=>w.api.token_coverage).filter(valid)};
 };
 const report=status?value.today??{}:value,days=status?[]:value.daily??[],single=days.length===1;
 const p=observation(single?days[0].observation:value.observation),summaryCapacity=capacities(single?conditional?.days?.find((d:any)=>d.date===days[0].date)?.windows:conditional?.windows,single?days[0].observation:value.observation);
 const t=report.totals,price=report.current_price_valuation;
 add(status?'Codex 用量账本':({today:'今日用量',week:'本周用量',month:'本月用量',report:'区间用量'} as Record<string,string>)[command]??'用量',true);
 const range=value.display_period??value.period??report.period;
 if(range){const end=new Date(Date.parse(range.to_exclusive)-1).toISOString();const calendar=clock(range.from)==='00:00'&&new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(range.to_exclusive))==='00:00:00';
  add(calendar?`统计范围：${stamp(range.from).split(' ')[0]} 至 ${stamp(end).split(' ')[0]}（含末日）`:`统计范围：${stamp(range.from)} 至 ${stamp(range.to_exclusive)}（不含结束时刻）`);
 }
 if(status){
  const qs=value.quota??[];
  if(qs.length===1&&valid(qs[0].used_percent))pair('剩余 '+exact(100-qs[0].used_percent)+'%','（最近采样）');else pair('剩余额度','—（多范围或无观测）');
  for(const [i,q] of qs.entries()){
   if(qs.length>1)pair(`额度 ${i+1}（${valid(q.window_duration_mins)?exact(q.window_duration_mins/60)+'小时':'时长未知'}）`,valid(q.used_percent)?exact(100-q.used_percent)+'%':'—');
   const reset=q.reset_iso??(q.resets_at?new Date(q.resets_at*1000).toISOString():null);if(reset)pair('报告重置时间',stamp(reset));
   if(now-Date.parse(q.timestamp)>Math.max(300,value.monitor?.policy?.quota_idle_seconds??900)*2000)add('额度快照较旧，请以采样时刻为准。');
  }
  pair('当日消耗估计（百分点）','—');
 }else if(single){pair(days[0].ongoing?'剩余额度（今日采样）':'剩余额度（当日首末采样）',remaining(p));pair('当日消耗估计（百分点）',consumed(p));}
 else{pair('剩余额度（区间末次）',p?exact(p.remaining?.to_percent??100-p.to_percent)+'%':'—');pair('区间消耗（百分点）',consumed(p));}
 pair((status?'今日 ':single?'当日 ':'区间 ')+'Token',t?.records>0?number(t.total_tokens):'—');pair('API 等效（当前价格）',priced(t,price));
 pair('100% API 等效估算',summaryCapacity.api);pair('100% 标准等效 Token',summaryCapacity.tokens);
 if(!t?.records)add('此范围内暂无已入账记录；金额不适用。');
 const usageHeaders=['日期','总 Token','输入','输出','缓存命中','API 等效'];
 if(days.length>1){section('每日用量');table(usageHeaders,[...days.map((d:any)=>usage(d.date+(d.ongoing?' 至今':''),d.totals,d.current_price_valuation)),usage('合计',t,price)],[[0,1,2,3],[0,4,5]]);
  section('每日额度');const dailyRows=days.map((d:any)=>{const obs=observation(d.observation),c=capacities(conditional?.days?.find((cd:any)=>cd.date===d.date)?.windows,d.observation),label=c.label.startsWith('可估')?'（部分）':c.range?'（分段）':'';return [d.date,remaining(obs),consumed(obs),c.api+label,c.tokens+label];});
  table(['日期','剩余变化','消耗额度（百分点）','100% API 等效估算','100% 标准等效 Token'],[...dailyRows,['累计消耗','—',consumed(p),'—','—']],[[0,1,2],[0,3,4]]);
 }
 section(status||single?'模型用量':'区间模型汇总');
 const modelRows=(Object.entries(report.models??{}) as [string,any][]).sort((a,b)=>b[1].total_tokens-a[1].total_tokens).map(([m,mt])=>usage(m==='unknown'?'未识别模型':m,mt,mt.current_price_valuation));
 table(['模型',...usageHeaders.slice(1)],[...modelRows,usage('合计',t,price)],[[0,1,2,3],[0,4,5]]);
 const coverage=price?.api_token_coverage;
 const modelPriceMissing=modelRows.length&&Object.values(report.models).some((mt:any)=>!mt.current_price_valuation);
 add((t?.records&&valid(coverage)?`用量计价覆盖 ${percent(coverage)}${coverage<1?'；其余 '+percent(1-coverage)+' 暂无价格':''}。`:'')+(coverage===0?'暂无可计价用量。':'')+'* 为已知计价部分；API 等效不是订阅账单。'+(modelPriceMissing?'模型当前金额未提供，显示 —。':''));
 const capCoverage=summaryCapacity.coverage;
 const capNote=status?'状态未提供当日消耗及 100% 估算；用 cux today 查看。':`100% 范围：${single?'当日':'区间'}${summaryCapacity.label}；仅按本地记录估算，账户覆盖未核实。`;
 add(capNote+(capCoverage.length?'计价覆盖 '+(Math.min(...capCoverage)===Math.max(...capCoverage)?percent(capCoverage[0]):percent(Math.min(...capCoverage))+'～'+percent(Math.max(...capCoverage)))+'。':'')+(conditional?.reference?'标准 Token 参考 '+safe(conditional.reference.model)+' 普通输入，并非官方容量。':'')+(summaryCapacity.range||days.some((d:any)=>capacities(conditional?.days?.find((cd:any)=>cd.date===d.date)?.windows,d.observation).range)?'分段范围不是置信区间。':''));
 add('消耗为采样段累计估计，边界及未覆盖时段未补算；— 为未观测或不可估。完整依据与日模型见 --details。');
 if(status){
  const m=value.monitor,age=now-Date.parse(m?.heartbeat_at);add(m?.running&&age>=-1000&&age<90000?'● 后台运行中':m?.running?'监控心跳已过期，请检查服务。':'监控状态未知或已停止。');
  if(m?.offline)add('当前为离线采集；官方额度不会刷新。');
  if((options.collection??value.collection)?.status&&((options.collection??value.collection).status!=='ok'))add('最近额度查询失败，以上为已有快照。');
  if(value.last_sync&&now-Date.parse(value.last_sync.synced_at)>Math.max(300,m?.policy?.local_reconcile_seconds??300)*2000)add('本地同步时间较旧，请检查采集是否正常。');
  const availability=value.official_availability?.availability??(value.quota?.length===1?value.quota[0].availability:null);
  const permission=(a:any)=>`${a?.ordinary_usage_allowed===true?'允许':a?.ordinary_usage_allowed===false?'不允许':'未知'} / ${a?.spend_control_reached===true?'已达限制':a?.spend_control_reached===false?'未达限制':'未知'}`;
  pair('普通用量 / 支出控制',permission(availability));
  if(value.quota?.length>1)for(const [i,q] of value.quota.entries())pair(`额度 ${i+1} 许可 / 支出`,permission(q.availability));
 }
 const h=value.legacy_reconciliation??{};
 if(h.conflict_records||h.pending_tokens||h.source_unavailable_candidate_tokens||t?.source_unavailable_tokens||value.issues?.some((i:any)=>i.code!=='inherited_legacy_skipped'))add('历史待核对：未确认用量未计入，缺源事实已保留；数量与证据见 --details。');
 return lines.map(l=>options.color&&l.bold?`\x1b[1m${l.text}\x1b[0m`:l.text).join('\n');
}
