# codex-usage-ledger

本地优先的 Codex Token 与额度账本。运行环境为 Node.js 22.13+；SQLite 使用 Node.js 内置模块。当前 macOS 版本支持受只读保护的官方额度采集；其他平台可以离线导入 rollout，尚未验证在线采集。

## 快速开始

默认命令现为中文终端看板：剩余额度与重置时间优先，Token 使用「万、亿」，金额始终标注覆盖率。加 `--details` 展开精确数字与完整信息；`--json` 保留既有汇总字段并增加逐日字段，JSONL 导出保持原格式。颜色只在支持的终端中启用，设置 `NO_COLOR=1` 可关闭。

需要 Node.js 22.13+、Git，以及已登录的官方 Codex 环境。首次从 GitHub 获取项目：

```sh
git clone https://github.com/boyzcl/codex-usage-ledger.git
cd codex-usage-ledger
npm ci
npm run build
node bin/cux.mjs sync
node bin/cux.mjs status
npm link
cux watch
```

`watch` 在前台持续运行，监听日志变化并增量入库，每 5 分钟补漏。官方额度活跃时每 5 分钟、空闲时每 15 分钟查询，账户汇总每 30 分钟查询。按 Ctrl+C 停止。

使用 `cux service install` 安装并启用 macOS 登录后台服务；`cux service status` 查看状态，`stop` / `start` 暂停和恢复。首次安装需要显式执行该命令，普通查询不会自动安装服务。完整操作与导出指南见 [docs/USAGE.md](docs/USAGE.md)。

```sh
cux export usage --from 2026-10-01 --to 2026-10-03 --out usage.jsonl
cux export quota --out quota.jsonl
cux export observations --out observations.jsonl
```

导出为 JSONL，首行是元数据，随后每行一条记录；`--out` 拒绝覆盖已有文件。

```sh
cux today
cux week
cux month
cux report --from 2026-10-01 --to 2026-10-03
cux models --json
cux quota --json
cux estimate --json
cux doctor --online
```

`today`、`week`、`month`、`report` 统一显示十列综合表：每日合计、全部模型明细、区间合计、模型区间合计。包括 Token、输入、输出、缓存命中率、Plan 消耗、100% 等效 Token、当前价格 API 已知小计及计价覆盖率。模型的额度与容量列显示 `—`，不按 Token 占比虚构额度归因。

`week` 是当地周一至今，`month` 是当地月初至今；`status` 另显示最近 7 个日历日。日期范围中的 `--to 2026-10-03` 包含当天，精确时间戳的上界不包含该时刻。时区取 `config.json`，首次运行默认采用系统时区，可在 `config.json` 中修改。

`status` 不扫描 rollout，也不访问网络。先运行 `sync` 或保持 `watch`。所有主要命令支持 `--json`，离线导入使用 `sync --offline`，单次监控检查使用 `watch --once`。

## 数据与隐私

默认数据目录：`~/.codex-usage-ledger/`。可以用 `CUX_HOME` 或 `--data-home` 修改。包含：

- `usage.db`：记录、额度快照、账户摘要、增量检查点、价格版本、估计和质量问题。
- `config.json`：源目录、时区、`monitor` 分层采集频率、Codex 程序路径、估计配置。旧 `poll_seconds` 不再控制 watch。
- `prices.json`：人工审阅的、有来源和生效时间的价格规则。
- `app-server/`：隔离的 Codex app-server 运行状态。
- `logs/`：监控摘要日志与启动错误；监控摘要约 5 MB 轮转一次。官方 quota / usage 响应保存在 SQLite observations，认证与会话正文不入库。

工具仅发现 `sessions/**/rollout-*.jsonl` 和 `archived_sessions/**/rollout-*.jsonl`，不查询 Codex SQLite。解析器通过字段投影跳过正文，不保存 prompt、回复、工具输出。账本保留本机项目路径用于归因；CLI 汇总不导出路径、线程 ID 或会话 ID；显式 `export usage` 保留去重用的响应与会话 ID，省略项目路径。没有遥测、分析上报或 usage 上传。

macOS 在线采集使用独立 `CODEX_HOME` 和 `sandbox-exec`。认证交给官方 app-server：隔离目录中的认证链接指向原文件，账本程序不打开认证内容；操作系统拒绝写原 Codex 目录。不会主动刷新认证。认证过期或只读限制导致采集失败时，历史账本仍可读取。不要把整个数据目录分享给别人；其中的认证链接和运行状态不属于交付物。

数据目录与源目录不能互相包含，符号链接解析后也检查。安装及验证没有修改原 Codex 数据或 hooks 配置。

## 统计口径

- 新格式使用 `token_usage_record`，按全局 `response_id` 去重。源记录被复制到子代理或移入归档时，不重复计入。
- 对应 turn 已出现新格式记录时，移除同 turn 的旧格式暂存记录。旧 turn 仍保留，支持历史会话升级。
- 旧格式优先使用变化计数对应的 `last_token_usage`；缺失时使用累计增量。累计回退与缓存分类回退分别处理。
- 父子会话的旧格式重放按连续父事件指纹匹配。父记录未到或无法建立起始对应关系时，候选事实保存在 `legacy_candidates`，不计入确认用量；父数据变化后重新核对。明确分叉之后的偶然相等不再作为继承证据。日志提供 `forked_from_ordinal_exclusive` 时，只匹配父线程在该边界之前的 ordinal，父线程后续相等计数不能被当作继承。老日志没有边界时仍依赖连续指纹证据，不能证明全部历史归属。此算法不能恢复所有历史缺失记录。
- compaction 的嵌入 `latest_token_usage_record` 只有在 ID 与 `compaction_response_id` 一致时才补记，否则不能当作新请求。
- `input` 包含 cached 和 cache write。`uncached = max(input - cached - write, 0)`。
- `reasoning` 属于 output，不再次加入 total 或计费。
- 旧记录可能只增加 total、没有 input/output 拆分。这部分保留在 `unclassified_tokens`，不伪造拆分或金额，因此总数与已知拆分之和可能不同。
- 模型和速度按 turn/context/settings 事件归因。没有速度记录时保持 `unknown`，不默认 Standard。
- 数字不一致、损坏行、过大行、不可恢复 compaction 均留下问题代码，不保存坏行正文。

增量检查点保存完整已消费字节前缀的 SHA-256 摘要和解析器版本。变化文件先校验整个前缀，再决定是否追加；不依赖头尾抽查。设备、inode、大小、修改时间和 ctime 用于发现变化，恢复 mtime 不能隐藏同大小改写。检查点和该文件的账本变更原子提交；不完整的末行等待下次补全。读取前后完整摘要及文件状态不一致时整文件事务回滚，留待下一次同步；`validation_bytes_read` 和 `validation_ms` 记录校验开销。检测到文件重写会重新读入，保留已入账的事实记录。最终去重依赖记录身份，不依赖路径。

完整 `thread_settings_applied` 快照省略或清空速度/推理字段时清除旧状态，速度保持 `unknown`；局部模型 reroute 只更新提供的字段。

旧账本不能只依靠更新后再次同步纠正：使用 [隔离修复说明](docs/REPAIR.md) 生成一致性备份、修复副本和差异，再验收。修复不覆盖输入数据库。

## 金额

`api_equivalent_usd` 是假设同样调用使用 API 的 Token 等效金额，不是订阅实际支出；不含工具调用、语音、容器等独立收费项目。

`credit_equivalent` 使用 Codex 已购 credits 的官方费率。cache write 按普通非缓存 input 计入，不额外收 API 的 cache-write 加价。Fast 的 purchased-credit 倍率与 included-allowance 倍率分别处理。

价格规则包含模型、速度、上下文区间、起止时间、四项费率、来源及核验时间。规则 ID 入库后不可改写。增加新价格必须使用新 ID 和不重叠的有效区间。未知模型、未知速度、无法确认的价格时期以及规则重叠均返回 `null`。

首版价格表只证明 2026-10-03 核验时的价格，不追溯编造历史生效日。报告同时输出：

1. 按已验证历史有效期计算的金额，缺价时总额为 `unknown`，同时提供已知小计和覆盖率。
2. 按当前价格重估的假设金额，单独标注时间和覆盖率。

## 额度容量

额度事实来自官方百分比；窗口按 `limit_id + duration + reset + slot` 分开，不硬编码 5 小时或周额度。

当前尚未验证账号和额度窗口归属，默认 `status`、`estimate` 和逐日报表的容量保持未知（表格显示 `—`），严格估算缺失原因仍保留。此前展示的经验值不属于已验证套餐容量。只有显式加 `--experimental-empirical` 才展示实验结果，例如 `cux report --from 2026-10-01 --to 2026-10-03 --experimental-empirical`。

实验经验估算独立于严格权重估计：仅使用 `app_server` 同窗口、同重置时间的成对快照，以 `(首快照,末快照]` 内的本地 Token 除以百分点变化并乘以 100。变化至少 5 个百分点才输出，标记局部观测及超过 30 分钟的采样空档；百分比回退（包括跨日单点）、冲突、饱和、疑似外部消耗或 Token 不一致时不输出。该结果假设观测模型、速度及缓存组合不变且没有未记录消耗，不是官方固定 Token 上限。

逐日表按配置时区分组，不插值午夜快照。同周期区间估算使用逐日匹配 Token 与百分点的总和；跨午夜的观测空档不纳入。显式实验模式下，`estimate` 和 `status` 的经验值使用当前周期连续观测，因此与逐日表可能略有差异。不同窗口、不同 reset 值分别保留；即使只差一秒也不擅自合并。原始快照不修改。

报表 JSON 新增 `daily`、`plan_cycles`、`daily_basis`、`display_period` 及模型的当前价格重估；原 `totals` 与历史金额字段保留。`estimate --experimental-empirical --json` 在原估计项中增加 `empirical`；默认该字段为 `null`，`strict_reason` 始终保留。经验值按查询时的事实重算，不写入原严格估计表；需保存时导出报表 JSON。

官方说明 credit 费率不能直接决定套餐内额度消耗，且模型与额度 bucket 的公开映射不完整。因此默认配置不填入额度权重或猜测映射。目前结果可能是 `missing_verified_allowance_weights` 或 `unknown_bucket_model_mapping`。

估计器已实现并通过合成数据验证：至少 3 个互不重叠的 clean spans、累计至少 10 个百分点、覆盖率至少 80% 才输出点估计；每个 span 至少变化 5 个百分点。跨 reset 或百分比下降不形成 span。使用加权中位数、异常候选剔除、百分比量化边界；显示的是量化和观测离散范围，**不是统计意义的 95% 置信区间**。

有本机零 Token 而额度增加超过 1 个百分点的区间时，标记外部消耗并排除。存在本地用量时，无法保证识别所有混入的外部消耗。覆盖率只是可用于拟合的观测跨度占比，不是账户所有活动的真实采集率。

明确接受实验假设后，可在 `config.json` 中设置：

```json
{
  "estimator": {
    "weight_basis": "credit_proxy",
    "bucket_models": { "codex": ["gpt-6.1-sol"] }
  }
}
```

该映射仅是配置示例，不能当作你的账户的已验证映射。实验模式将 credit 权重作为代理，并使用已公布的 Fast 2.5x / Ultrafast 8x 套餐倍率；所有结果始终标注 `experimental_credit_proxy`。估计用记录必须具有可验证的时间价格、模型、速度及逐响应来源。不要用当前价格重估回填历史权重。

容量可用时，输出最近 7 天、30 天、当前周期的等效 Token/API 金额；单模型 Standard 使用该模型观测到的 input/cache/output 比例，不声称模型本身有唯一的“总 Token”。

## 可选插件

`plugin/` 是可导入的本地插件，包含 Stop / SessionEnd 钩子。只在账本数据目录触碰刷新标记，不读取 hook stdin，不计数 Token，不访问认证。

导入插件后，需在 Codex 的 Hooks 界面审阅并信任当前定义；安装不会自动授信。必须同时保持 `cux watch` 运行。未启用插件时，文件监听与 5 分钟补漏仍会同步，后台服务无需插件即可工作。

项目不直接修改 `~/.codex/hooks.json` 或插件注册表，遵守原目录只读的约束；因此不存在覆盖其他用户 hook 的安装步骤。插件的导入、授信和 UI 验证尚需用户在应用内完成。

## 项目结构

```text
src/
  app-server.ts   只读 RPC 采集
  discovery.ts    文件发现、完整行增量读取
  privacy.ts      白名单 JSON 投影
  parser.ts       模型状态、usage 和旧格式回退
  ingest.ts       增量导入
  store.ts        SQLite 账本
  pricing.ts     版本化金额计算
  quota.ts       额度窗口规范化
  estimator.ts   容量估计与等效 mix
  report.ts      时间区间和汇总
  daily.ts       逐日与模型明细、按观测组合经验外推
  display.ts     终端输出
  monitor.ts     分层调度、单实例锁、运行观测
  service.ts     macOS launchd 服务管理
  export.ts      JSONL 原始事实导出
  cli.ts         命令入口
bin/cux.mjs
plugin/
data/prices.json
test/core.test.ts
docs/SOURCES.md
```

## 验证

```sh
npm run check
cux sync
cux doctor --online --json
```

`doctor` 的通过表示存储、价格配置、源目录、同步和指定的在线查询正常，不表示历史记录完全覆盖账户用量。质量问题与额度不足仍单独报告。

实现对 ccusage / codexU 的边界处理进行了研究，没有复制其源代码。上游版本、协议和价格来源见 `docs/SOURCES.md`。本机验收报告与个人统计导出不上传到 GitHub。仓库包含源码、测试、价格规则、可选插件和使用指南；依赖与构建产物通过 `npm ci` 和 `npm run build` 生成。
