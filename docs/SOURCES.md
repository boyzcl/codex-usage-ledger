# 已核验来源

核验日期：2026-10-03。以下均读取过正文或代码；搜索结果摘要不作为实现依据。

| 来源 | 用途 |
| --- | --- |
| https://learn.chatgpt.com/docs/app-server#auth-endpoints | account/read、rateLimits/read、usage/read、初始化和数据口径 |
| https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs | TokenUsage、TokenUsageRecord、thread settings；服务内部 budget 字段不持久化，不能作为可用权重 |
| https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs | 整数百分比 round、动态窗口、账户 daily buckets |
| https://developers.openai.com/api/docs/pricing | Standard/Fast/Ultrafast，短/长上下文的 API 价格 |
| https://developers.openai.com/api/docs/models/gpt-6.1-sol | cache-write、272K 阈值和价格倍率 |
| https://learn.chatgpt.com/docs/pricing | credit 费率、共享额度、credit 费率不等于套餐内消耗、无单独 cache-write 收费 |
| https://learn.chatgpt.com/docs/agent-configuration/speed | 已购 credits 与套餐内 Fast/Ultrafast 使用不同倍率 |
| https://developers.openai.com/plugins/build/plugins | 插件结构、hook 路径、PLUGIN_ROOT、插件安装不自动信任 hook |
| https://learn.chatgpt.com/docs/hooks | Stop / SessionEnd；SessionEnd 始终同步，最多 3 秒 |

## 本机协议

- PATH CLI：0.147.0。
- ChatGPT/Codex 桌面应用：26.930.31428，build 12913。
- 应用内置 Codex CLI：0.160.0，在线采集优先使用此版本。
- 使用本机 `codex app-server generate-ts --experimental` 核验三个账户端点。
- 当前 rollout 是带 `ordinal` 的 JSONL，存在 `token_usage_record`、嵌入 compaction usage 和 `thread_settings_applied.thread_settings`。

## 参考项目

- [ccusage/ccusage](https://github.com/ccusage/ccusage)：核验提交 `7df1dddfbd486ca015e5de37d09b04512df48881`；当前 Codex parser 位于 `rust/adapters/codex/src/parser.rs`，已从旧 TypeScript 布局迁移。参考累计 delta、父历史重放、独立 compaction ID、速度变更状态。不采用该项目的默认模型猜测。
- [shanggqm/codexU](https://github.com/shanggqm/codexU)：核验提交 `db40798b4016aa559a79dc3d89ef83b1174d18fc`；读取 `Sources/CodexUsageWidget/Domain/CodexTokenCounterNormalizer.swift`，参考计数回退、high-water 与父历史指纹。两项目均核验了 MIT 许可证；本实现没有复制代码。

## 与初始方案的核验差异

1. 上游将 response usage 描述为 best-effort provider usage，不能把“每条都保证完整”当作前提。
2. 官方明确指出 credit 费率不直接决定套餐内额度消耗。容量估计需要已验证权重/映射，或显式实验假设。
3. 当前 API 文档只证明当前价格；不能给历史所有调用套当前费率并称为历史账单。
4. 多个 pairwise 候选并不等于多个独立样本。V0 使用不重叠 span，避免虚增置信度。
5. quantization/observed range 不是有统计覆盖保证的 95% 区间。
6. 插件钩子需单独授信；为保持原 `~/.codex` 只读，本轮只交付插件包，不注册或修改用户 hooks。

## 第一轮设置语义核验

2026-10-04 核验内置 CLI `0.160.0`，并读取对应 tag [`rust-v0.160.0` 的 protocol.rs](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/protocol.rs)（Git blob `abc4e90847636bfe51e6275ede528a13616c8573`）。`ThreadSettingsAppliedEvent.thread_settings` 是 `ThreadSettingsSnapshot`；`service_tier` 和 `reasoning_effort` 的 `Option` 字段以 `skip_serializing_if = "Option::is_none"` 序列化。省略表示此完整快照没有该设置，不能保留上次 Fast/high，也不能补成 Standard。`ThreadSettingsOverrides` / `TurnSettingsUpdate` 则明确为局部更新；模型 reroute 沿用局部字段语义。本轮不据最新主干字段推断旧版本的官方可用状态。

同一 tag 的 `SessionMeta.forked_from_ordinal_exclusive` 注释明确说明它是逻辑父线程的继承 exclusive ordinal，与物理 `history_base` 独立；revert 可替换物理历史而保留此边界。本轮仅投影该边界字段，不投影相邻的账号或用户标识，用于排除父线程分叉之后的偶然相等计数。

## 修复运行时边界

官方 Node [`v22.16.0` sqlite.md](https://github.com/nodejs/node/blob/v22.16.0/doc/api/sqlite.md) 将 `sqlite.backup` 标为 `added: v22.16.0`（blob `2c66898bf376c0f09dab60da5622b960f10462a3`）；[`v22.13.0` 的同文件](https://github.com/nodejs/node/blob/v22.13.0/doc/api/sqlite.md) 不含该 API（blob `270b8e8d8b750725942d655d6ba0dfbe9018623f`）。项目保持普通查询/导入的 22.13 下限，修复入口单独检查能力，避免导入模块时让普通命令一并失效。
