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

`corrected_attribution` 表示同 ID、同 Token 事实的归因纠正。`excluded_inherited_history` 和 `excluded_superseded_by_exact` 排除有证据的重复量，原事实留在候选或修复证据中。重写或缺源后无法继续核对的候选保存在 `legacy_candidate_history`；重新构建和重复修复不会静默丢弃它们。`pending_parent_history` 表示无法核实的分叉候选，不计入确认用量。有 ordinal 分叉边界时，只以边界之前的父事件作为继承证据；旧日志无边界时只能核对连续指纹，不能承诺恢复所有历史归属。`retained_source_unavailable` 保留缺源或无法从现存源匹配的历史记录，并以 `repair_status: source_unavailable` 标记。`pending_token_fact_conflict` 保留原 Token 事实，等待人工核对，不覆盖为新计数。

历史金额与当前价格重估保持分开。归因未变的记录保留原金额；归因纠正仅重新核验该记录原来引用的不可变价格规则。原引用不再适用或缺失时金额为 `null`，不会静默换成当前价格或零。新恢复记录使用源时间与账本现有历史规则。价格替代关系留待下一轮。

每个变化文件在读取前后做摘要和文件状态校验。`deferred_files > 0` 表示有源文件正在变化，本次未提交该文件，相关历史保留并待核对；此时不能宣称完成全量恢复。修复版本、可见记录、源证据和估计缓存的失效处理在同一事务中提交。中断留下基线和未提交纠正的副本；保留证据，使用新的输出目录重试。

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
