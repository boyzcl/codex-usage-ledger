# 旧账本隔离修复

本轮只生成修复副本，不自动覆盖原数据库或切换后台服务。源码版本与旧数据纠正是两项操作；普通 `sync` 的质量优先级不能替代历史修复验收。

## 前置条件

普通查询与导入继续支持 Node.js 22.13+。修复/回滚依赖 `node:sqlite.backup`，在 Node.js 22 系列中最低为 22.16.0。入口按 API 是否存在做前置检查：不支持时返回 `sqlite_backup_unavailable`，不会创建输出目录或空备份文件。其他主版本也必须提供该 API，不能只按版本号大小推断能力。不支持备份的运行时仍可验证普通查询和前置拒绝；备份成功路径的测试会明确跳过，完整修复验证需要提供该 API 的运行时。

- 在独立克隆完成 `npm ci` 和 `npm run check`。命令使用该克隆的 `node dist/src/cli.js`，避免全局 `cux` 指向旧服务目录。
- 输入为现有 SQLite 账本，源目录为 rollout 所在的 Codex 目录。输出目录必须尚不存在，且不能与源日志目录互相包含。检查可用磁盘空间：至少需要两份输入账本加一份重解析事实库。
- 数据库、源路径和逐记录证据属于私人数据。输出目录不放入 Git。解析只投影元数据、Token 和额度字段，不持久化对话正文；摘要校验扫描全部字节，但仅保留摘要。

## 生成预览

```sh
node dist/src/cli.js repair-preview \
  --input /absolute/path/usage.db \
  --codex-home /absolute/path/codex \
  --out-dir /absolute/path/new-preview \
  --timezone Asia/Shanghai
```

输入以 SQLite 只读连接打开，通过 online backup 获取含已提交 WAL 的一致性副本。源日志在备份后逐文件读取，报告记录备份与扫描时间；新增记录可能包含备份后的活动，不等同于恢复了旧缺口。不会对输入执行 schema 迁移、同步或纠正。

输出：

| 文件 | 用途 |
| --- | --- |
| `baseline.db` | 一致性基线备份，保留原记录和金额 |
| `reparsed.db` | 从现存源文件重解析的投影事实、候选及检查点摘要 |
| `repaired.db` | 在副本上原子应用纠正，含 `repair_evidence` 和修复版本 |
| `preview.json` | 按日期、模型、问题类型分组的前后差异、缺源/待核对统计及扫描开销 |

`corrected_attribution` 表示同 ID、同 Token 事实的归因纠正。`excluded_inherited_history` 和 `excluded_superseded_by_exact` 排除有证据的重复量，原事实留在候选或修复证据中。重写或缺源后无法继续核对的候选保存在 `legacy_candidate_history`；重新构建和重复修复不会静默丢弃它们。`pending_parent_history` 表示无法核实的分叉候选，不计入确认用量。有 ordinal 分叉边界时，只以边界之前的父事件作为继承证据；旧日志无边界时只能核对连续指纹，不能承诺恢复所有历史归属。`retained_source_unavailable` 保留缺源或无法从现存源匹配的历史记录，并以 `repair_status: source_unavailable` 标记。`pending_token_fact_conflict` 将同 ID 的争议双方移入 `usage_conflicts`，保留六项 Token、归因及实际已有历史金额/价格引用。未裁决争议从确认用量和活跃候选移出，合法追加继续入账。同六字段的低可信复制归因争议可由更可信的原始 owner 裁决恢复确认，历史变体保留，当前状态为 `resolved_by_owner`；六字段事实冲突保持 `open`，不会借 owner 到达清空。`pending_attribution_conflict` 同样保存同可信来源的归因矛盾；不会按最后写入者决定。预览分列争议身份数、变体数与前后确认量，冲突量为 `null`，不视为零，也不相加两个变体。

修复会合并重解析中新增的日志额度快照，并用 `added_quota_snapshots` 报告新增数量；旧官方/日志快照与原始 payload 保留。相同 ID 的规范化额度字段必须一致，payload 的表示或附加元数据差异不覆盖原快照。规范化字段冲突时返回 `repair_quota_fact_conflict`，整次纠正事务回滚，保留原输入与基线备份供核对。重复修复不新增相同快照。

普通追加与重解析沿用保全规则：`legacy_candidate_history` 中首次归档的 raw 不因相同事实再次到达或归因增强而覆盖、删除；同一 thread/event_index 换成另一身份前，先归档被替换的候选。归档只保存证据，不叠加到确认用量。若既有确认记录已标为 `repair_status: source_unavailable`，新的 `pending` 候选不足以删除它；有证据的继承重复、exact 替代及真正 Token 冲突仍按原规则移出确认用量。代码修复不会自动补回此前已移出的记录或恢复已丢失的历史 raw 表示，数据恢复仍需独立核验。

已知 turn 的 exact 只替代同 thread+turn 的 legacy；缺源但保留的 exact 继续支持该范围。未知 turn 必须有同源、同任务段内相邻用量事件的具体一对一链接，并同时核对时间及六字段；仅同线程或 Token 相等不足以替代。任务/turn 边界重置配对，当前有效候选中的多个 legacy 指向同 response 时保守保留。历史链接继续作为证据，时间改写产生的新候选不受旧链接阻塞。

历史金额与当前价格重估保持分开。归因未变的记录保留原金额；同来源归因纠正仅重新核验该记录原来引用的不可变价格规则。原始 owner 替代低可信副本时采用 owner 在事件时间已计算的金额/引用，副本原金额仍作为证据保留。原引用不再适用或缺失时金额为 `null`，不会静默换成当前价格或零。新恢复记录使用源时间与账本现有历史规则。v0.4.5 的显式 supersedes 只影响完整目录的有效价格选择；归因纠正仍用原引用的规则子集核验，不会让后继把原引用挤掉。revalue 另存回算结果，不覆盖修复的权威来源或原金额。已保存回算的输入哈希指向执行时的事实版本；合法修复后重新回算产生新版本，原 run/results 留存。

每个变化文件在读取前后做摘要和文件状态校验。`deferred_files > 0` 表示有源文件正在变化，本次未提交该文件，相关历史保留并待核对；此时不能宣称完成全量恢复。修复版本、可见记录、源证据和估计缓存的失效处理在同一事务中提交。清理或替换容量缓存前，仍存在的派生原值保存至 `capacity_estimate_history`，不会补造以前已经删除的历史。中断留下基线和未提交纠正的副本；保留证据，使用新的输出目录重试。

## 验收、重复运行和回滚

1. 检查 `preview.json` 的差异与待核对项；用只读 SQLite 查询核对必要的 `repair_evidence`。不要输出账号标识或逐记录私人信息到公共报告。
2. 以 `repaired.db` 为下一次输入、使用新的输出目录再次运行预览。源未变化时，归因纠正/重复排除/新增记录应为零；缺源标记继续保留。
3. 需要回滚演练时，从基线恢复到一个尚不存在的新数据库：

```sh
node dist/src/cli.js repair-rollback \
  --input /absolute/path/new-preview/baseline.db \
  --out /absolute/path/rollback.db
```

恢复使用 SQLite backup，不覆盖已有文件。将恢复副本与原基线的记录、价格引用及 Token 比较。实际生产替换需要另行验收和部署安排，本轮不执行。

合成验收命令：

```sh
npm run check
node --test dist/test/round1.test.js dist/test/repair.test.js
```

可保留合成演练的文件证据：`node scripts/exercise-repair.mjs /absolute/path/new-synthetic-exercise`。脚本会生成合成旧库、修复、重复修复、回滚副本和 `exercise.json`，不使用个人路径。

测试包含子先/父先与分批重核、真正分叉后偶然相等、同 inode 中间改写、替换、截断增长、半行、归档、读取中变化、同 ID 纠正、缺源保留、Token 冲突、幂等重复、事务中断和备份回滚。

## v0.4.4 身份及许可投影迁移

打开旧库时新增 `quota_context`，不改原 quota_snapshots、usage_records、金额、价格引用或原observations。一次事务从成功的原 `account/rateLimits/read` observations恢复同时间且额度事实及桶raw完全一致的旧官方行，记录源observation ID及上下文指纹。源缺失保持unknown；候选身份或许可不唯一标mixed/unknown，不选择首个或最后一个，也不把rollout快照改成官方来源。`quota_context_version`使重复打开幂等，原派生快照先保存到历史。

新采集的身份/许可来自同一次官方响应。恢复后的旧ID保持不变；同一已恢复响应再次插入复用旧事实ID。不同身份的新事实ID分开。repair-preview保留/追加context，已有同ID上下文不一致则 `repair_quota_context_conflict`，整个修复事务回滚。

上线前仍需最新一致性备份、原行完整对账与独立预览；不得把旧预览覆盖持续增长的生产库。本迁移新增投影表，紧急代码回退到v0.4.3可以保留新表和原库，避免丢弃上线后新观测；未经核实的投影不参与旧版容量解释。先停服务并备份失败现场，再恢复旧构建；公开撤回用普通revert，不能强推。

旧版可读取原表不等于保留B隔离语义；回退后不应使用旧版显式实验入口解释多身份容量。
