# codex-usage-ledger 使用指南

完成安装并启用后台服务后，本工具自动记录本机的 Codex Token 消耗，并定时保存官方额度快照。日常使用 Codex 时，无需手动同步，也无需保持终端窗口打开。首次安装请先按 [README](../README.md) 构建并安装 `cux`，再运行 `cux service install` 启用登录自动启动。

它提供中文终端看板和 JSON / JSONL 导出，当前没有独立图形窗口。查看数据时，打开 macOS「终端」，输入本指南中的 `cux` 命令即可。也可以在 Codex 中说「查看我的 Codex 额度和今天用量」或「导出本月 Token 明细」，由助手调用这些命令。

## 1. 最常用的查询

| 想看什么 | 命令 |
| --- | --- |
| 当前额度、今日消耗、监控状态 | `cux status` |
| 官方已用百分比、剩余百分比、重置时间 | `cux quota` |
| 今天的 Token 与金额统计 | `cux today` |
| 本周一至今 | `cux week` |
| 本月一日至今 | `cux month` |
| 指定日期区间 | `cux report --from 2026-10-01 --to 2026-10-03` |
| 所有已入账历史的模型汇总 | `cux models` |
| 容量推算结果与无法推算的原因 | `cux estimate` |
| 后台服务是否运行 | `cux service status` |

`--to 2026-10-03` 包含 10 月 3 日全天。日、周、月统计按`config.json` 中的时区划分（示例为 `Asia/Shanghai`）；导出的事件时间为 UTC，末尾的 `Z` 表示 UTC。精确时间戳作为 `--to` 时不包含该时刻。

例如 `cux report --from 2026-10-03T00:00:00Z --to 2026-10-04T00:00:00Z` 查询这两个 UTC 时刻之间的记录。`week` 是当地周一至今，`month` 是月初至今；`status` 没有逐日表，`status --json` 的 `last_7_calendar_days` 仅汇总今天及前6个日历日。查看逐日表请用 `week` 或指定日期范围的 `report`。`status.workload` 与 `estimate --details` 的最近7天/30天则从报告时刻向前滚动7×24/30×24小时，另有当前额度周期的本地历史。这些范围可能重叠，不能相加；周期内活动不自动成为该窗口的已归属消耗。

查询已有数据不会调用模型。普通报告与 `quota` 读取本地账本；如需立即刷新一次，可运行 `cux sync`。可先用 `cux service status` 检查服务；自动监控已运行时，通常无需手动同步。

所有查询默认显示中文看板。`cux status` 依次显示剩余额度、今日用量、API 等效价值和采集状态；数字默认使用「万、亿」，时间使用配置时区，首次运行默认采用系统时区。

顶部时间是报告生成时间，不是所有数据的采集时间。请同时查看「额度更新于」「Token 更新于」和采集状态。后台运行与采集成功是两个不同状态：最近额度查询失败、心跳过期或数据较旧时，会另行提示。

需要精确数字或完整信息时，加 `--details`：

```sh
cux status --details
cux today --details
cux models --details
cux doctor --details
cux service status --details
```

详情包含精确 Token 数、历史价格小计及覆盖率、credits 等效值、完整模型排行、诊断代码等。`cux models` 默认显示消耗最多的 5 个模型，`--details` 显示全部；逐日综合表始终列出范围内的全部模型。

普通看板中的金额优先展示「按当前价格重估」的 API 等效值，覆盖率紧随金额显示。`cux models` 的模型排行每行标注的则是「历史 API 已知小计」及对应覆盖率；不同价格口径不能相加。`--details` 展开整体历史价格口径。

终端支持颜色时会显示加粗标题、额度条与状态颜色。重定向到文件时自动去掉颜色，窄窗口自动折行或上下排列。需要主动关闭颜色时使用：

```sh
NO_COLOR=1 cux status
```

`--json` 优先于 `--details`，保留机器可读字段和原始时间格式。`cux quota --json` 的 `collection` 可读取最近额度查询的成功或失败状态。

### 逐日综合表

`cux today`、`cux week`、`cux month`、`cux report` 现在使用同一张综合表。每一天先显示合计，再显示各模型明细；表尾显示区间合计和各模型的区间合计。模型行是合计的拆分，不要把它们再次相加。

| 列 | 含义 |
| --- | --- |
| 日期 | 配置时区的日期；今天标注「至今」 |
| 模型 / 层级 | 当日合计、模型明细、区间合计；多个额度周期另列分段 |
| 总 Token / 输入 / 输出 | 当日或区间的已入账用量；输入包含缓存，输出包含推理 |
| 缓存命中率 | 缓存读取 Token ÷ 输入 Token；合计由总数相除，不平均每日百分比 |
| 官方已用 起→止 | 官方首末快照的原始已用比例；单点保留该比例，不补造午夜值 |
| Plan观测消耗（估算，百分点） | 按时间顺序分段后，相邻快照非负变化之和；35 表示 35 个百分点，仅覆盖已观测时段 |
| 100% 等效 Token | 默认 `—`；显式实验模式才显示匹配 Token × 100 ÷ 额度变化百分点 |
| API 等效已知小计 | 按报告生成时的价格重估的已知美元小计，不是订阅账单 |
| 计价覆盖率 | 可计价 Token ÷ 总 Token；不是金额覆盖率 |

模型行的官方比例、Plan 观测消耗和 100% 等效 Token 固定显示 `—`。已知每个模型用了多少 Token，并不能证明它占用了多少套餐额度，因此不按 Token 比例分摊。其余缺数据或无法估计的单元格也显示 `—`，不代表零。

`*` 表示只覆盖已观测时段，观测消耗不是精确日账单。官方已用比例与容量估算独立：已知且稳定的 `account_ref` 即可显示官方比例和观测变化，即使工作区及计费归属仍为 `partial`。缺少账号身份或归属状态为 `mixed` 时只显示观测摘要，消耗保持未知。同刻冲突的原始点保留，冲突点不参与消耗累计。

计算先遍历全局时间链，再分别维护额度桶和窗口位置。账号 A→B→A、工作区或计费归属变化不会跨段连接；额度桶或窗口位置从观测帧中消失后再出现，也不会接回旧端点。百分比回退、重置截止时间变化（包括 1 秒差异）、窗口时长变化及冲突也会分段。重置后的 0 有效，负变化不计入消耗；正跳变保留，不截断。超过 30 分钟的采样空档单独提示。单点可显示原始比例，消耗为 `—`；没有快照时均未知。逐日及区间消耗都只累计日内有效成对观测，跨午夜的空档不分摊到任何一天。

表格下方列出观测起止时间和分段数量，`--details` 展示各段端点与精确截止时间。Token 列包含全天或截至当前的全部已入账记录，反推容量只使用匹配时段的 Token。不会把全天 Token 除以半天的额度变化。

账号和额度窗口归属尚未核实，默认容量保持 `—`。经验值不会覆盖严格估算的缺失原因。需要查看实验结果时，显式使用 `cux report --from 2026-10-01 --to 2026-10-03 --experimental-empirical` 或 `cux estimate --experimental-empirical`；输出同时说明严格估算不可用的原因。默认 JSON 和 JSONL 同样标记 `unverified`、来源、严格原因及限制，容量值保持 `null`。实验输出标记 `experimental_unverified`，此前展示的经验值不属于已验证套餐容量。

实验示例：匹配时段内用了 4 亿 Token，额度增加 20 个百分点，经验外推为 `4 亿 × 100 ÷ 20 = 20 亿 Token`。它假设模型、速度、输入输出及缓存组合保持相似，且没有其他设备等未记录消耗，**不是官方套餐的固定 Token 上限**。两个模型的 Token 数相同，也不意味着额度消耗相同。

目前经验估算只使用定时查询保存的 `app_server` 快照，不混用日志内的额度快照。单日至少需要成对观测且变化达到 5 个百分点才输出容量；快照冲突、百分比回退（包含跨日单点）、已达 100%、Token 拆分异常或疑似外部消耗时不输出。超过 30 分钟的采样空档会单独提示；即使有本地 Token，也无法排除混入外部消耗或上报延迟。

区间估算按同一周期的「匹配 Token 总和 ÷ 已观测百分点总和」计算，不平均每日容量。跨午夜没有成对观测的空档不纳入逐日合计；`cux estimate --experimental-empirical` 使用当前周期的连续观测区间，可能因此与逐日表的区间估算略有不同。多个窗口或重置时间分别列示，不合并百分比；重置时间相差 1 秒也先保留为独立分段，不自动假定相同。

推荐把终端拉宽到约 140 列以上阅读十一列表格。较窄时单元格折行，极窄时按行展开字段；所有字段均保留。`--details` 可查看精确数字、匹配 Token、窗口标识和异常代码。

## 2. 保存汇总结果

需要给其他程序或助手分析时，在查询命令后加 `--json`。下面的命令把本月汇总保存到「下载」文件夹：

```sh
cux month --json > "$HOME/Downloads/codex-month.json"
```

指定区间并保存：

```sh
cux report --from 2026-10-01 --to 2026-10-03 --json > "$HOME/Downloads/codex-report.json"
```

Shell 的 `>` 会覆盖同名文件。需要保留多个版本时，请在文件名中加入日期。

`export plan-observations` 输出与报告 `observation[]` 相同的派生观测对象，使用 JSONL 元数据和独立类型；原有 `quota` 和 `observations` 原始证据导出保持原意。

报告保留原有汇总字段，并增加逐日明细：

| 字段 | 含义 |
| --- | --- |
| `daily[]` | 每日合计、模型明细、当前价格重估和额度观测 |
| `daily[].observation[]` | 独立的官方比例观测：首末比例、百分点估算、有效相邻变化数、分段及标记 |
| `observation[]` | 区间官方观测；与逐日同口径，不合并账号或跨日消耗 |
| `observation_basis` | 观测单位、来源、覆盖范围和累计口径；不包含容量或模型分配 |
| `daily[].plans[]` | 分窗口、分重置周期的百分点增量、匹配 Token、容量估算和原因 |
| `plan_cycles[]` | 区间内各周期的综合经验估算，不合并不同周期 |
| `models.*.current_price_valuation` | 各模型按当前价格重估的金额与覆盖率 |
| `daily_basis` | 时区、重估时刻、额度来源和最低观测变化要求 |
| `totals.total_tokens` | 已入账的总 Token |
| `totals.input_tokens` | 输入 Token，包含缓存读取与缓存写入 |
| `totals.cached_input_tokens` | 缓存读取 Token |
| `totals.cache_write_input_tokens` | 缓存写入 Token |
| `totals.uncached_input_tokens` | 扣除两类缓存后的普通输入 |
| `totals.output_tokens` | 输出 Token，包含 reasoning |
| `totals.reasoning_output_tokens` | 推理输出，是 output 的子集，不再加一次 |
| `totals.unclassified_tokens` | 总量已知，但输入、输出拆分不完整的部分 |
| `models` | 按模型分组的同口径统计 |
| `totals.api_equivalent_usd` | 按已验证历史价格计算的完整 API 等效金额；缺价时为 `null` |
| `totals.known_api_subtotal_usd` | 可以计价部分的金额小计 |
| `totals.api_token_coverage` | 可计价 Token 占比，0～1 |
| `current_price_valuation` | 用当前价格重估的假设金额，单独列示 |

API 等效金额不是订阅实际付款。`null` 或 `unknown` 表示证据不足，不表示零消耗。普通输入、缓存、输出之间有包含关系，不能把表中每一行都相加。

## 3. 获取原始事实明细

`export` 导出 JSONL：每行一个 JSON 对象。第一行是文件说明，当前 `schema_version: 3`，之后每行一条记录。它适合后续用 Python、数据库或助手重新计算；直接导入 Excel 前通常需要先转换。

先创建一个导出文件夹：

```sh
mkdir -p "$HOME/Downloads/codex-ledger"
```

导出指定区间的逐条 Token 记录：

```sh
cux export usage --from 2026-10-01 --to 2026-10-03 --out "$HOME/Downloads/codex-ledger/usage-2026-10-01_03.jsonl"
```

导出额度快照与完整采集记录：

```sh
cux export quota --from 2026-10-01 --to 2026-10-03 --out "$HOME/Downloads/codex-ledger/quota-2026-10-01_03.jsonl"
cux export observations --from 2026-10-01 --to 2026-10-03 --out "$HOME/Downloads/codex-ledger/observations-2026-10-01_03.jsonl"
cux export plan-observations --from 2026-10-01 --to 2026-10-03 --out "$HOME/Downloads/codex-ledger/plan-observations-2026-10-01_03.jsonl"
```

其他导出：

```sh
cux export account --out "$HOME/Downloads/codex-ledger/account.jsonl"
cux export prices --out "$HOME/Downloads/codex-ledger/prices.jsonl"
cux export estimates --out "$HOME/Downloads/codex-ledger/estimates.jsonl"
cux export conflicts --out "$HOME/Downloads/codex-ledger/conflicts.jsonl"
cux export estimate-history --out "$HOME/Downloads/codex-ledger/estimate-history.jsonl"
cux export issues --out "$HOME/Downloads/codex-ledger/issues.jsonl"
```

不写 `--from` 和 `--to` 就导出所有已保存记录。`--out` 不覆盖已有文件；遇到 `export_file_already_exists` 时换一个文件名。不写 `--out` 会把 JSONL 输出到终端。

| 导出类型 | 内容与适用用途 |
| --- | --- |
| `usage` | 规范化的源 Token 计数、事件时间、模型、速度、来源、响应 ID、数据质量，以及入账时的金额与价格规则 ID；用于重新汇总或计价 |
| `quota` | 逐窗口额度快照，含百分比、窗口长度、重置时间、来源及原额度对象；用于绘制曲线、划分周期 |
| `account` | 官方账户累计量与按日 buckets 的历次快照；用于核对账本，不是逐请求明细 |
| `observations` | 监控启用后的查询原始响应、请求开始及观测时间、错误代码、本地同步摘要、监控中断记录；用于检查采集完整性 |
| `prices` | 所有已保存的价格规则、来源和有效期；不受日期参数过滤 |
| `estimates` | 每个周期最近一次派生结果的未核实视图，容量/区间为 `null`，含 `status: unverified`、来源、严格原因及限制；实验入口仍须显式开启 |
| `estimate-history` | 替换或失效前仍存在的派生原值，标记 `historical_unverified`；用于审计，不作为已核实容量 |
| `conflicts` | 同 ID 的争议变体、六项 Token、归因与历史价格引用，含 `dispute_status`；历史证据行 `confirmed: false`、`quantity: null`，不相加为用量。`open` 尚未计入确认；`resolved_by_owner` 的选定 owner 已恢复确认 |
| `issues` | 导入质量问题代码、文件哈希及偏移；不受日期参数过滤 |
| `valuations` | 后续回算的逐条事实投影、输入指纹、原入账报价/引用和新报价/引用；日期按源事件时间过滤，可用 `--run` 指定版本 |
| `valuation-runs` | 重算版本、算法、完整价格目录及来源、输入哈希、口径、范围与覆盖率；日期按版本创建时间过滤，可用 `--run` 指定版本 |

`usage` 中的原始事实指从日志提取的计数字段，不是完整会话日志；不会导出提问、回复或工具输出，也省略项目路径。会话与响应 ID 会保留，便于去重。旧格式记录可能是累计计数差分，需结合 `source` 和 `data_quality` 判断，不能全部视为逐响应官方原始记录。

`observations` 保留百分比未变化的成功查询，也保留失败查询。启用此版本之前没有的采集时间、失败历史和缺失快照，不会事后伪造。

从 JSONL 读取 Token 明细的 Python 示例（先按前述步骤导出）：

```python
import json
from pathlib import Path

path = Path.home() / "Downloads/codex-ledger/usage-2026-10-01_03.jsonl"
total = 0
with path.open() as file:
    for line in file:
        entry = json.loads(line)
        if entry["type"] == "usage":
            total += entry["data"]["total_tokens"]
print(total)
```

若目标是重算金额，可用第8节的 `revalue` 并同时导出 `valuations` 和 `valuation-runs`，或自行结合 `usage` 和 `prices`；若目标是研究额度容量，请同时使用 `usage`、`quota` 和 `observations`。保留 `account` 可以做账户总量交叉核对。不要仅凭百分比与混合模型 Token 总和直接相除，并声称得到了官方套餐总容量。

## 4. 自动监控的实际行为

| 项目 | 默认行为 |
| --- | --- |
| 本地日志变化 | 合并约 1.5 秒内的通知，校验已消费前缀摘要，再解析变化文件的新增完整行 |
| 补漏 | 每 5 分钟重新发现文件并核对检查点，不反复解析或入账未变日志；摘要校验仍可能读取大量字节 |
| 官方额度 | 最近 10 分钟检测到本地日志活动时，每 5 分钟查询；空闲时每 15 分钟查询 |
| 官方账户汇总 | 每 30 分钟查询 |
| 重置边界 | 已知重置前约 1 分钟、重置后安排额外采样；合并相近查询 |
| 网络或 RPC 失败 | 重试间隔为 1、2、4、5 分钟，之后最多每 5 分钟重试 |
| 休眠恢复 | 检测到循环中断后补读日志、重取当前额度，并标记观测空档 |
| 登录与意外退出 | 登录后自动启动；意外退出后由 launchd 尝试重启 |

文件通知、系统调度和网络响应会影响实际延迟，表中间隔不是硬实时保证。活动判断用本地日志变化，无法立即知道另一台设备开始工作；本机空闲期间仍保留 15 分钟额度查询。

网络恢复后在下一次重试时重新采集，失败期间不把旧数值标成新值。电脑关机、退出 macOS 账户或休眠时不会持续采集。恢复后可补读仍保留的本地 Token 日志，但无法恢复未观测到的历史额度百分比。

监控进程不调用模型，不额外消耗生成 Token；它会使用少量 CPU、磁盘和网络。当前实现利用日志中的额度快照及定时查询，没有把跨进程推送作为可靠来源。无需导入插件或手动信任 Hooks，就能完成自动采集。

## 5. 启停、检查和故障排查

查看系统服务：

```sh
cux service status
```

正常时应看到「后台服务：运行中」「登录自动启动：已启用」。需要机器可读状态时，运行 `cux service status --json`，对应字段为 `installed`、`running`、`login_enabled`。服务运行不等于每次查询成功；查询结果还需查看 `cux quota` 的提示，或 `cux quota --json` 的 `collection`。

暂停自动监控（也暂停下次登录自启动）：

```sh
cux service stop
```

恢复自动监控及登录启动：

```sh
cux service start
```

配置修改后重启：

```sh
cux service restart
```

移除后台服务，保留历史数据：

```sh
cux service uninstall
```

重新安装并启用：

```sh
cux service install
```

后台服务已运行时，不要另开 `cux watch`；单实例锁会返回 `monitor_already_running`。手动前台诊断时，先停止服务，再运行 `cux watch`，按 Ctrl+C 结束，最后运行 `cux service start` 恢复后台模式。

遇到额度停留在旧时间或服务异常，依次检查：

1. 运行 `cux service status`，确认服务状态。
2. 运行 `cux doctor --json`，检查数据库、源目录和同步状态。
3. 运行 `cux doctor --online --json`，检查三个官方账户查询；这一步会进行网络请求并保存本次观测。
4. 查看最近的运行日志：

```sh
tail -n 20 "$HOME/.codex-usage-ledger/logs/monitor.jsonl"
tail -n 20 "$HOME/.codex-usage-ledger/logs/service-error.log"
```

`monitor.jsonl` 超过约 5 MB 会保留上一份 `.1` 文件。完整采集观测仍保留在 SQLite，可通过 `export observations` 获取。`service-error.log` 用于进程启动错误，没有自动轮转。

认证失效时，请在官方 Codex 应用中恢复登录，再重启服务。本工具不修改原 Codex 配置或认证内容。`doctor` 通过不表示历史账本覆盖了账户全部用量，也不表示模型权重已经确认。历史缺口与当前采集故障分开显示；「已排除继承记录」表示去重处理，不代表新增数据丢失。

常见参数和操作错误会给出中文原因及错误代码。SQLite 的已知实验性提示在模块加载时被单独过滤；其他警告和真实错误仍正常保留。

## 6. 数据位置与备份

- 主数据库：`~/.codex-usage-ledger/usage.db`
- 配置：`~/.codex-usage-ledger/config.json`
- 价格种子：`~/.codex-usage-ledger/prices.json`；完整目录在数据库 `pricing_rules` 表
- 保存的回算：数据库 `valuation_runs` 和 `valuation_results` 表
- 运行日志：`~/.codex-usage-ledger/logs/`
- 启动项：`~/Library/LaunchAgents/local.codex-usage-ledger.<数据目录标识>.plist`
- 程序目录：克隆并构建本仓库的目录

`npm link` 安装的全局 `cux` 和已安装的后台服务都依赖程序目录，请保留该目录。使用 `cux service status --details` 查看本机启动项和日志的实际位置。移动程序后，需要重新安装命令链接并重新运行 `service install`。

配置中的 `monitor` 对象控制分层频率。旧的 `poll_seconds` 字段保留兼容，但不再控制后台调度。修改配置后需运行 `cux service restart`；一般无需调整。

分享或分析数据时优先使用 `export`。不要分享整个数据目录，其中的 `app-server` 包含认证链接和官方运行状态。

需要备份运行中的 SQLite 时，使用 SQLite 的备份命令，避免只复制 `usage.db` 而遗漏 WAL 中的数据：

```sh
sqlite3 "$HOME/.codex-usage-ledger/usage.db" ".backup '$HOME/Downloads/codex-ledger-backup.db'"
```

备份文件名应使用新名称。数据库备份含本地归因信息，适合自己保存；导出的 Token 明细则省略了项目路径。

另存 `config.json`、原 `prices.json`、程序提交及 Node 版本；只备份种子不能恢复后来导入的目录或回算历史。恢复时先 `cux service stop`，确认所有写入者退出；保留当前数据库及 WAL/SHM 的失败现场和最新增量。把一致备份复制到一个新的数据目录，放入对应配置与价格种子，先以 `cux --data-home /absolute/path/restored prices --json` 和 `report --json` 核对。程序与数据库匹配并验收后，按 [部署与恢复](DEPLOYMENT.md) 切换默认目录，再 `cux service start`。不要覆盖打开的数据库或把旧 WAL 留给恢复文件；较早备份不能覆盖后来新增的记录、价格或回算。

## 7. 长期能得到什么

自动运行后，可以持续得到日、周、月与任意区间的 Token 统计、模型分布、缓存占比、API 等效金额、额度百分比时间序列、额度重置周期和采集质量记录。这些原始事实允许以后使用新价格规则或新的推算方法重新分析。

显式加 `--experimental-empirical` 后，只有满足相应方法所需的归属、映射、权重及有效样本条件，才可能展示实验关系。经验外推要求已验证的账号、工作区、计费来源及本地用量到窗口的归属和有效成对观测；严格权重估计还要求已验证的模型映射及额度权重。持续累积快照本身不会补齐这些证据，条件不满足时容量一直显示 `—`。实验结果可以帮助比较观测组合，不能证明官方固定容量或独立模型权重。实验性 credit 代理估计保持关闭。

## 旧账本修复

更新程序再 `sync` 不等于修复历史归因。使用 [隔离修复说明](REPAIR.md) 生成备份和修复预览。父记录未到的 legacy 候选保留并标为待核对，不计入确认用量。缺源历史继续保留，以 `repair_status: source_unavailable` 标记；汇总同时给出缺源记录数和 Token，不能据此声称归因已重新验证。

## 账号边界、官方可用状态与最近历史（v0.4.4）

`status` 和 `quota` 分开显示「普通用量」及「支出控制」：普通用量取官方 `ordinaryUsageAllowed`，支出控制取 `spendControlReached`。字段缺失为未知；剩余百分比、credits余额或重置时间不替代官方许可。每项附来源与采样时间，旧快照不代表当前实时许可。

额度响应的 `accountId` 以命名空间哈希引用保存为后台账号范围。工作区及实际计费来源没有独立证据时标为 `partial`；全缺失为 `unknown`，冲突为 `mixed`。plan、cwd、相同周期、`normalModelSlug` 或当前登录账号不能补齐这些身份。线程的 `creator_account_id` 只描述创建时账号，恢复线程后不会更新，不能给后来调用追溯归属。旧原始事实不改写。

本地记录与账号及具体窗口没有直接计费证据时，窗口的匹配 Token 为0，未分配用量另列；0表示「没有已证明匹配的记录」，不表示实际消耗为零。默认容量及显式实验都保留未知容量和严格原因。不同账号、缺失/冲突身份、不同来源或不同窗口不能拼成实验样本。既有历史派生值继续保留在 `estimate-history`。

`status` 的 `workload` 和 `estimate --details` 独立列出滚动最近7天、30天及当前周期时间范围内的**本地历史**。查询从这些范围起点的并集读取，短周期不截断历史；每段单独计算模型、速度、缓存和Token构成。范围包含起点及 `as_of`，结束界为 `as_of+1ms`；时区随配置。`coverage.status=partial_observed_history` 表示仅覆盖已记录事实，不能从首末记录推断连续完整采集。周期时间内的本地活动没有自动分配到该额度窗口，重叠范围不能相加。

容量拟合要求当前周期的精确归属。历史等效组合另按同一已验证账号、工作区、计费来源、额度桶、窗口位置和长度筛选，可使用有来源事件证明的历史周期，不要求历史重置时间等于当前重置时间。近7天、30天及模型30日组合分别换算；历史缺归属、权重或价格时，相应等效值为空，`equivalent_reasons` 给出原因。当前容量可用不意味着历史组合完整；这些组合仍只描述已观察记录。

日报保留每天、模型和已验证容量周期十一列表，模型额度分配与容量未知时用「—」；整体说明保留严格原因。稳定已知账号的官方比例默认独立展示，使用 `observation` 字段和 `plan-observations` 派生导出；未知身份快照按日期和已观察的桶标签展示为观测摘要，不把每份快照称为套餐周期，不拼接百分比或推算容量；JSON 中仍保留各份独立证据。JSONL新增scope/availability/证据引用和范围口径，schema_version为3。私人原响应及旧金额/价格引用留在SQLite，导出隐去原账号、工作区、用户ID和email，仅输出归一化哈希引用。

## 容量证据与每日运行诊断

`cux estimate --details` 和 `cux status --details` 展开「容量证据 · 资格与覆盖」。对应 JSON 的每项容量结果新增 `diagnostics`；原容量状态与空值保持原有含义。诊断不会把实验输出升级为已验证套餐容量。

每个观测序列按账号证据、来源、额度桶、窗口位置、长度和精确截止时间分开。后台账号已知但工作区/计费来源缺失时，只能显示「仅观测到后台账号」；用户声明不能补写为请求的 `source_event` 归属。截止相差 1 秒也不合并，另列抖动候选；百分比下降与截止变化只能证明重置或窗口变更候选，原因和自然重置仍需核实。

「研究输入合格 / 拒绝区间」使用不重叠的至少 5 百分点区间，并保留下降、冲突和尾部不足区间的拒绝原因。它与既有容量估计的有效区间不是同一资格：研究输入合格仍不证明权重、目标组合可识别性、账户完整性、留出误差或完整周期验收。0/100 截断、未知模型/速度、未归属记录、不同账号/窗口、不可恢复来源和采样空档都会显示原因。已证明匹配 Token 为 0 只表示没有匹配记录；未归属本地 Token 仍单列。

区间资格逐一检查内部相邻观测，不能只看首尾百分点或许可。内部回退、blocked/unknown 许可或同刻矛盾上下文会结束当前连续区间，并保存被拒边界与上下文引用；后续恢复允许且无冲突的点可重新形成独立区间，拒绝原因不会永久污染未来观测。

同一精确窗口中已被账本标为 mixed/归属不明的观测也不能在分组时跳过。它只作为可能受影响序列的拒绝边界，不归属到已知账号、不并入有效样本；原上下文引用继续保留。

官方日桶另列观察到的修订日期。官方日界、账号/计数口径与延迟未核实前，`local_official_difference` 和即时外部消耗判断保持 `null`；某轮汇总大幅增加不能解释为该轮新增用量。缺失桶也不当作零。

每日采集汇总按配置时区显示已查询范围内的成功、失败和已报告空档。额度/本地成功间隔超过配置最大额度间隔的 2 倍时另列空档；汇总查询的门槛至少为 1 小时。日志已有的部署/休眠空档也单独保留，事件可能描述同一时段，不能把事件数当作独立缺失量。

诊断最多回看 8 天，额度每桶/窗口位置最多 5,000 点，观测最多 10,000 条；官方日桶读取最近 2 天内最多 128 份响应。截取状态在 `query` 或 `account_daily.truncated` 中说明。首末采样不能证明连续覆盖，完整周期验收不会由这些计数自动通过。

运行空间只读取 DB、WAL 和日志的当前文件大小，不扫描会话或目录树。未取得文件大小为未知；单次 stat 不能推断每日增长。每日独立保存 `diagnostics.storage_snapshot` 才能比较真实增量；现有日志滚动继续使用，不删除事实、不做 VACUUM 或新建整库备份。诊断计算自身没有写入或新增数据库表；CLI 原有的估算缓存/价格行为继续沿用。

## 8. 更新价格与保存重算版本（v0.4.5）

金额有三层：`usage` 保存源 Token/归属及入账时报价；`revalue --basis event` 用后来保存的目录按原事件时刻回算；`--basis current --at` 把同批 Token 假设放到指定时刻计价。普通日报的当前价格重估是查询时生成的临时结果，需保存可复现版本时使用 `revalue`。任何回算都不改源事实、归属、入账报价或原规则 ID，也不提高账号/窗口归属的可信度。

### 唯一推荐调价流程

先查看完整目录和哈希，导出价格事实：

```sh
mkdir -p "$HOME/Downloads/codex-ledger"
cux prices --json
cux export prices --out "$HOME/Downloads/codex-ledger/prices-before-update.jsonl"
```

核实官方来源、生效时刻及四项费率后，在终端执行下面的交互脚本，从导出选择旧规则并生成新规则数组。脚本不推断官方调价、不改种子；此前有后继时拒绝选旧节点。输入 UTC 或带时区偏移的 ISO 时间；无证据的历史日期不能补造。缓存写入价格不明可输入 `null`，其他费率须有证据，单位均为每百万 Token。

```sh
python3 - <<'PY'
import json
from pathlib import Path
console = open("/dev/tty")
def ask(prompt):
    print(prompt, end="", flush=True)
    return console.readline().strip()
folder = Path.home() / "Downloads/codex-ledger"
rules = [json.loads(line)["data"] for line in
         (folder / "prices-before-update.jsonl").read_text().splitlines()
         if json.loads(line)["type"] == "prices"]
old_id = ask("要替代的当前末端规则 ID: ")
old = next(r for r in rules if r["id"] == old_id)
assert not any(r.get("supersedes") == old_id for r in rules), "请选择当前末端规则"
new = dict(old)
new["id"] = ask("新规则 ID（不可复用）: ")
assert new["id"] not in {r["id"] for r in rules}, "新 ID 已存在"
new["supersedes"] = old_id
new["effective_from"] = ask("已核实生效时刻（ISO）: ")
new["effective_to"] = ask("明确截止时刻（ISO，未公布留空）: ") or None
new["retrieved_at"] = ask("来源核验时刻（ISO）: ")
new["source_url"] = ask("官方来源 HTTPS URL: ")
new["basis"] = ask("已核实事实及限制说明: ")
new["rates"] = {}
for field in ("input", "cached_input", "cache_write", "output"):
    value = ask(f"{field} 每百万 Token 费率: ")
    new["rates"][field] = None if field == "cache_write" and value == "null" else float(value)
out = folder / "price-update.json"
with out.open("x") as file:
    json.dump([new], file, ensure_ascii=False, indent=2)
print(out)
PY
```

核对生成文件后导入并查看目录：

```sh
cux prices import --input "$HOME/Downloads/codex-ledger/price-update.json"
cux prices --json
```

输入必须是 JSON 规则数组，不能把 JSONL 直接导入。多规则调价可放入同一数组，整批校验及追加原子完成。完全相同的重导入新增0条；旧 ID 的任何事实变化都会拒绝。价格种子不变，后台后续同步和重启读取数据库完整目录，无需修改 `prices.json`。

新旧规则的 kind、model、processing_mode、context_min/context_max 必须相同，新起点严格晚于旧起点。有效区间为 `[effective_from, effective_to)`；旧规则实际终点取原明确截止与后继起点的较早者，原字段不改。原明确截止早于后继起点时保留缺价空档。每个旧节点只允许一个直接后继，继续调价须替代最新末端。模型、档位、上下文分段改变时应分别提供有证据的规则，不能借替代关系跨维度套价。

API、已购 credits、已验证 allowance 独立演进。普通输入、缓存读取、缓存写入、输出分别计价，reasoning 已含在 output。已购 credits 的缓存写入按其普通 input 费率，不能把 API 的写入加价或 credits 倍率当作套餐内 allowance 权重。没有已验证 allowance 仍未知，不靠价格更新产生容量。

未声明替代关系的重叠不会按「最新」选择，报价为 `null`。未知模型/速度、拆分不一致、无法核实的历史价格或正量缓存写入缺价，也保持未知。第一个公开种子只证明2026-10-03核验时的价格，回算不会自动补齐更早时期。

### 保存与导出重算版本

按事件时间回算指定区间：

```sh
cux revalue --basis event --from 2026-10-03 --to 2026-10-04
```

把同批事件假设放到指定时刻，使用该时刻适用的目录价格：

```sh
cux revalue --basis current --at 2026-10-04T10:00:00Z \
  --from 2026-10-03 --to 2026-10-04
```

省略 `--basis` 默认为 event；event 不接受 `--at`，current 必须提供 `--at`。省略日期处理全部已确认历史。命令输出版本 ID、目录哈希、口径、记录数、已知小计和 Token 覆盖率；`--json` 还输出三种金额、范围、输入哈希及完整目录。相同输入、目录、范围及口径复用同一版本；后来新增事实、合法归因修复或新价格目录会产生新版本，旧版本保留。

复制输出的版本 ID，替换下面的占位值。结果与来源需成对导出：

```sh
valuation_run='替换为命令输出的版本ID'
cux export valuations --run "$valuation_run" \
  --out "$HOME/Downloads/codex-ledger/valuation-results.jsonl"
cux export valuation-runs --run "$valuation_run" \
  --out "$HOME/Downloads/codex-ledger/valuation-run.jsonl"
```

`valuation-runs` 保存完整目录、来源、算法版本 `valuation_v1`、内容哈希和输入范围；`valuations` 保存必要 Token/模型/速度事实、逐条输入指纹以及原/新报价引用。事件源的规范化事实和原归属仍留在 `usage` 中；如需独立重算或核对来源，另导出相同范围的 `usage`。指纹覆盖执行当时的完整规范化 Usage，包括入账报价；之后修复产生的输入不能冒充旧快照。项目路径和会话正文不复制到重算导出，原账号/工作区标识继续隐去；响应 ID 及哈希仍可能关联个人活动，分享前应审阅。

新导出类型沿用 JSONL schema_version 3。`valuations` 的日期过滤按事件时间，`valuation-runs` 按版本创建时间；成对导出时建议只用 `--run`，避免同一历史日期筛掉后来创建的 run。`prices` 导出所有规则，不按日期过滤。已有输出文件不覆盖，换新名称可保存多个版本。

回算在单个写事务内固定目录和源输入，两遍流式读取后原子提交 run/results；中断或失败没有半批结果。大范围回算期间其他入账可能因写锁超时而暂缓，优先按有限日期区间执行。需要全历史时，先一致备份，再 `service stop`、回算、`service start`；记录停服区间，本地日志可补读，停止期间的官方额度采样不能事后恢复。数据库忙时先确认其他操作结束，再重试相同命令。

已知小计仅涵盖可计价 Token；覆盖率不代表账本覆盖全部账户活动。回算和当前价格重估都不是订阅账单，credits 不证明套餐内容量。账号、窗口或权重未验证时容量继续显示 `—`。待核对事实不是零，也不能统称为已经去重的重复记录。
