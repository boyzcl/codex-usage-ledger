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
| Plan 消耗 | 同一窗口、同一重置周期内，已观测到的额度增量；10% 表示完整 Plan 的 10 个百分点 |
| 100% 等效 Token | 匹配观测时段的 Token × 100 ÷ 额度变化百分点 |
| API 等效金额 | 按报告生成时的价格重估的已知美元小计，不是订阅账单 |
| 计价覆盖率 | 可计价 Token ÷ 总 Token；不是金额覆盖率 |

模型行的 Plan 消耗和 100% 等效 Token 固定显示 `—`。已知每个模型用了多少 Token，并不能证明它占用了多少套餐额度，因此不按 Token 比例分摊。其余缺数据或无法估计的单元格也显示 `—`，不代表零。

`*` 表示只覆盖已观测时段。表格下方列出观测起止时间：Token 列包含全天或截至当前的全部已入账记录，反推容量只使用首末快照之间匹配的 Token。不会把全天 Token 除以半天的额度变化，也不会补造午夜快照。

例如：匹配时段内用了 4 亿 Token，额度增加 20 个百分点，经验外推为 `4 亿 × 100 ÷ 20 = 20 亿 Token`。它假设模型、速度、输入输出及缓存组合保持相似，且没有其他设备等未记录消耗，**不是官方套餐的固定 Token 上限**。两个模型的 Token 数相同，也不意味着额度消耗相同。

目前经验估算只使用定时查询保存的 `app_server` 快照，不混用日志内的额度快照。单日至少需要成对观测且变化达到 5 个百分点才输出容量；快照冲突、百分比回退、已达 100%、Token 拆分异常或疑似外部消耗时不输出。超过 30 分钟的采样空档会单独提示；即使有本地 Token，也无法排除混入外部消耗或上报延迟。

区间估算按同一周期的「匹配 Token 总和 ÷ 已观测百分点总和」计算，不平均每日容量。跨午夜没有成对观测的空档不纳入逐日合计；`cux estimate` 使用当前周期的连续观测区间，可能因此与逐日表的区间估算略有不同。多个窗口或重置时间分别列示，不合并百分比；重置时间相差 1 秒也先保留为独立分段，不自动假定相同。

推荐把终端拉宽到约 140 列以上阅读十列表格。较窄时单元格折行，极窄时按行展开字段；所有字段均保留。`--details` 可查看精确数字、匹配 Token、窗口标识和异常代码。

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

报告保留原有汇总字段，并增加逐日明细：

| 字段 | 含义 |
| --- | --- |
| `daily[]` | 每日合计、模型明细、当前价格重估和额度观测 |
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

`export` 导出 JSONL：每行一个 JSON 对象。第一行是文件说明，之后每行一条记录。它适合后续用 Python、数据库或助手重新计算；直接导入 Excel 前通常需要先转换。

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
```

其他导出：

```sh
cux export account --out "$HOME/Downloads/codex-ledger/account.jsonl"
cux export prices --out "$HOME/Downloads/codex-ledger/prices.jsonl"
cux export estimates --out "$HOME/Downloads/codex-ledger/estimates.jsonl"
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
| `estimates` | 每个周期最近一次保存的严格权重容量估计及其依据，不含查询时计算的经验外推；经验结果请用 `cux estimate --json` 或报表 JSON 保存 |
| `issues` | 导入质量问题代码、文件哈希及偏移；不受日期参数过滤 |

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

若目标是重算金额，请使用 `usage` 和 `prices`；若目标是研究额度容量，请同时使用 `usage`、`quota` 和 `observations`。保留 `account` 可以做账户总量交叉核对。不要仅凭百分比与混合模型 Token 总和直接相除，并声称得到了官方套餐总容量。

## 4. 自动监控的实际行为

| 项目 | 默认行为 |
| --- | --- |
| 本地日志变化 | 合并约 1.5 秒内的通知，只读取变化文件的新增部分 |
| 补漏 | 每 5 分钟重新发现文件并核对检查点，不全量重读未变文件 |
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
- 价格：`~/.codex-usage-ledger/prices.json`
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

## 7. 长期能得到什么

自动运行后，可以持续得到日、周、月与任意区间的 Token 统计、模型分布、缓存占比、API 等效金额、额度百分比时间序列、额度重置周期和采集质量记录。这些原始事实允许以后使用新价格规则或新的推算方法重新分析。

经验外推会随采样累积展示观测组合下的 100% 等效 Token。它可以帮助比较不同时段，不能证明官方固定容量或独立模型权重。严格权重估计仍要求模型到额度窗口的映射、额度权重和有效样本；缺少证据时保持未知。实验性 credit 代理估计保持关闭。
