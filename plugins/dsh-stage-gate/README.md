# dsh-stage-gate

DSH 宿主平面插件：把各安全预设（Saker 的 pentest / code-audit / ctf-solver）的阶段门禁纪律中的**结构检查**变成模型工具
`stage_gate` / `gates_list`——模型不能自评门禁，必须调用工具校验，判定追加进 `<workspace>/gate-log.md` 审计 trail。

## 目标契约与中断恢复（operation-state.json）

- `operation_goal`：任务开工把目标登记为可判定契约（goal + 每行一条成功准则，id g1..gN）。
- `stage_gate`：每次判定自动把 gates 进度同步进同一文件（无契约时落骨架）。
- `operation_progress`：准则逐条 met/failed/reopened + 待办清单维护；`verdict=all-met` 即契约达成。
- 下游消费：route-boost 信封读它投递「operation 恢复」行（中断续作）；sec-enforce 报告门在
  准则未全 met 时拦截 reports/ 落盘（gate-pass 之外的第二道确定性终态门槛）。

## 设计立场

- playbook 的门禁是文本契约（六层门禁的第①-④层）；本插件是第⑥层「运行时强制」的 v1：
  **结构检查可机器判定**（文件存在/非空、必需标记、表格行完整、产物哈希登记），
  **语义门禁仍归复核员**（输出里的 `manual` 字段逐条列出）——结构通过 ≠ 完整通过。
- 挂宿主平面（cordis.patch.yml 无 realm 行，注册进 host `tools` 注册表）→ 七个模式全部可见。

## 工具

- `stage_gate(mode, stage, workspace, file?)` → `{pass, checks, manual, missing}`，写 gate-log.md。
- `gates_list(mode?)` → 各模式门禁 schema：规范文件名清单 / 是否需要 file 参数 / manual 项。

## 各模式门禁与规范文件名（v1 结构集）

| 模式 | 门 | 规范文件 |
|---|---|---|
| pentest | P1 资产基线 / P2 finding（需 file）/ P3 覆盖度 | assets.md（含 WAF、速率标记）、evidence-index.md、coverage-matrix.md |
| code-audit | A1 面映射 / A2 双链（需 file，语义归复核员）/ A3 覆盖+对账 | surface-map.md（含 入口/sink/深度 标记）、audit-coverage-matrix.md、scan-reconcile.md |
| binary-analysis | B0 登记 / B1 三验（需 file）/ B2 覆盖+台账 | artifacts/<hash>/provenance.md（64 位哈希）、analysis-coverage.md、hypothesis-ledger.md |
| attack-defense | recon / breach / lateral（需 file）/ persistence / report（需 file） | assets.md、evidence-index.md、paths-ledger.md（candidate/chosen）、persistence-registry.md（手动排除） |
| av-evasion | V1 边界 / V3 配对（需 file）/ V2 证据（需 file）/ V4 外推（需 file） | experiment-plan.md（自研/实验室/第三方）、实验报告（技术侧+检测侧）、判定日志（构建/判定+哈希） |

## v1 边界（诚实声明）

- 只做结构校验；表格「未填满行」会列出但不理解语义（N-A 理由是否成立仍是复核员的事）。
- 不拦截工具调用、不监听会话事件（那是未来版本；先证明 schema 校验有用）。
- 哈希检查是「存在 64 位十六进制串」，不重算哈希（重算需要原始样本，属复核员/人工范围）。

## 安装（与 dsh-webbridge/mcp-studio 同法）

profiles/web/package.json：dependencies 加 `"@dsh-external/dsh-stage-gate": "link:本目录"`，
`dsh.profile.bundles` 加 `"@dsh-external/dsh-stage-gate"`，然后 profiles/web 下 `pnpm install`，
重启 dsh web 后 `stage_gate` / `gates_list` 对全部预设可见。

## 项目工作台（1.7.0）

会话标签页「项目工作台」按**工作区**只读展示：目标契约、准则收口进度、意图/任务状态
（含结果冲突 `⚠` 与 `interrupted`）、产物索引（证据行 / 扫描待处置 / 最近门禁 / `reports/`）
与需要处理的 attention 清单。

- 服务端：`lib/project-snapshot.mjs` 只读本工作区文件（**不读别的插件 SQLite**）；
  `lib/project-channel.mjs` 自注册路由 `/dsh-stage-gate-project`，
  同源信任栅栏 + CSRF，端点 `status`（只接受绝对路径且存在的工作区）。
- 客户端：`lib/client.js` 注册 `conversation.view`。注意必须
  `ctx.slots.inject("conversation.view", () => ctx.slots.register(...))`——
  直接 `register` 不会出现在标签栏（实测）。
- 与其它标签页的分工：finding 台账在「redteam 成果」，跨会话记忆在「战役记忆」，
  覆盖矩阵在「AttackAtlas」；本页只管项目契约与执行状态。

## 测试

`node test/run.mjs`：纯函数 runGate/listGates 的 fixture 测试（含通过/失败/缺 file/未知门/审计日志写入）。
## 执行任务状态

子代理结果回收（1.6.2）：`scanner`/`semgrep` 这类长工具由 `runTrackedTask` 自动收口；
`subagent` 家族改为按宿主生命周期回收——`subagent/start` 把唯一匹配的 queued 任务转
`running`，`subagent/end` 按 `stopReason` 收进 `succeeded`（写入子代理自己的最终输出）/
`failed` / `interrupted`。绑定规则与长工具一致：同 owner 别名 + 同 session 且候选唯一
才动，多候选一律交给模型自己收口。

结果冲突只记不覆盖（1.6.3）：终态任务再收到**不同**结果时写 `task.conflicts[]`
（最多留最近 5 条），**不改已落库的终态**；同结果重复上报按幂等处理（`updatedAt` 也不动）。
`subagent/start` 时记 `runId→taskId`，`subagent/end` 按 runId 精确回收，
并发同 provider 的子代理也能对上号。冲突会出现在项目工作台的 `任务结果冲突` attention 里。

> 实现注意：`subagent/start|end` 是**作用域事件**，监听器只拿得到 `info`、拿不到 parent，
> 所以必须挂 `agent/created` → `agent.ctx.on(...)` 把 agent 闭包进作用域监听；
> 另外原生 `subagent` 是异步派发，`tools/result` 只代表"已启动"，不能拿它收口。

`operation_intent` 可带 `owner` / `max_attempts`，将方向登记为可执行任务。
`operation_task` 负责 `start / heartbeat / progress / succeed / fail / cancel / retry / interrupt`
状态流转；长时间无心跳的 running 任务会在下一次状态写入时转 `interrupted`。
`operation_task(action=claim)` 可在共享 workspace 里原子领取最老的 queued 任务，
供多个内部子代理避免重复执行。
长任务工具（`nuclei_scan` / `httpx_probe` / `ffuf_fuzz` / 注册表扫描器 / `semgrep_scan`）
会按 `owner` 自动认领唯一 queued 任务，在工具执行体内完成
`running → succeeded/failed`，不要求模型在调用前后手动补两条状态操作。
