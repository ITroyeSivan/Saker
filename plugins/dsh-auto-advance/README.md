# dsh-auto-advance 自动推进器

安全模式（pentest / code-audit）的可选自动推进器：执行体返回 → 有未结束的工作方向 → followup 推进提醒。默认关闭；启用后会把提醒作为 user 消息插入会话，并消耗一轮模型请求。

## 做什么

subagent 类工具（原生 `subagent`/`subagent_fork` + `subagent_claude_code`/`subagent_codex` 等
`subagent` 前缀工具）的结果到达时，若 operation-state 里存在未结束的工作方向，
注入一条推进提醒：

- 先用 `operation_progress` 结束本次执行对应的工作方向（`intent_done` 附产出位置 /
  `intent_blocked` 写明原因）；
- 再依锚 `operation_intent` 派下一步，或无下一步时静默收尾（不硬造方向）；
- 派单 prompt 里写了 `i1/i2` 时点名对应的工作方向（以 prompt 提及为准）。

## 三护栏（自主不失控）

| 护栏 | 语义 |
| --- | --- |
| 轮数上限 | 连续自动推进 `maxAutoTurns`（默认 5）轮封顶；真人消息重置计数 |
| opt-in | 只有存在未结束的工作方向时激活（登记即激活，与 scope 同规则） |
| 自描述注入 | 提醒自带当前状态（结束什么/还剩什么/第几轮/人工随时接管），可审计 |

另有冷却窗 `cooldownMs`（默认 30s）：并行执行体齐返回并作一次推进，不刷屏。

用户明确只要“发现并验证漏洞 / 至少给一个可复现证据”时，视为有界发现任务：
不追加开工轮，命中后也不继续自动催全量覆盖和额外枚举。

## 边界

- 只注入，不拦截不改写；非安全模式/无台账会话零干扰。
- followup 源标记 `kind:"user"`（与 attack-atlas 覆盖提醒同款），自注入 id 被排除在
  「真人重置」判定外。
- 注入失败不重试（下一执行体返回自然再试）。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enable` | `true` | 总开关 |
| `maxAutoTurns` | `5` | 连续自动推进轮数上限 |
| `cooldownMs` | `30000` | 冷却窗（毫秒） |

## 测试

`node test/run.mjs`——决策纯函数全分支/装配接线/三护栏/真人重置/工作方向点名。
