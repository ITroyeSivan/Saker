# dsh-stage-gate

DSH 宿主平面插件：把各安全预设（Saker 的 pentest / code-audit / ctf-solver）的阶段门禁纪律中的**结构检查**变成模型工具
`stage_gate` / `gates_list`——模型不能自评门禁，必须调用工具校验，判定追加进 `<workspace>/gate-log.md` 审计 trail。

## 目标契约与中断恢复（operation-state.json）

- `operation_goal`：任务开工把目标登记为可判定契约（goal + 每行一条成功完成标准，id g1..gN）。
- `stage_gate`：每次判定自动把 gates 进度同步进同一文件（无契约时落骨架）。
- `operation_progress`：完成标准逐条 met/failed/reopened + 待办清单维护；`verdict=all-met` 即契约达成。
- 下游消费：route-boost 信封读它投递「operation 恢复」行（中断续作）；sec-enforce 报告门在
  完成标准未全 met 时拦截 reports/ 落盘（gate-pass 之外的第二道确定性终态门槛）。

## 设计立场

- playbook 的门禁是文本契约（六层门禁的第①-④层）；本插件是第⑥层「运行时强制」的 v1：
  **结构检查可机器判定**（文件存在/非空、必需标记、表格行完整、产物哈希登记），
  **语义门禁仍归复核员**（输出里的 `manual` 字段逐条列出）——结构通过 ≠ 完整通过。
- 挂宿主平面（cordis.patch.yml 无 realm 行，注册进 host `tools` 注册表）→ 七个模式全部可见。

## 工具

- `stage_gate(mode, stage, workspace, file?)` → `{pass, checks, manual, missing}`，写 gate-log.md。
- `gates_list(mode?)` → 各模式门禁 schema：规范文件名清单 / **每个文件必须出现的标记字面量、表格行列下限、哈希与 provenance 要求（`requirements`）** / 是否需要 file 参数 / manual 项。
  `requirements` 由门禁定义派生（每条非 `file` 检查一条），照它写文件就能一次过门——不必先撞 FAIL 再反推「markers」是什么。

## 各模式门禁与规范文件名（v1 结构集）

| 模式 | 门 | 规范文件 |
|---|---|---|
| pentest | P1 资产基线 / P2 finding（需 file）/ P3 覆盖度 | **asset-inventory.json（机器可读资产清单）**、assets.md（含 WAF、速率标记）、evidence-index.md、coverage-matrix.md |
| code-audit | A1 面映射 / A2 双链（需 file，语义归复核员）/ A3 覆盖+对账 | surface-map.md（含 入口/sink/深度 标记）、audit-coverage-matrix.md、scan-reconcile.md |
| binary-analysis | B0 登记 / B1 三验（需 file）/ B2 覆盖+台账 | artifacts/<hash>/provenance.md（64 位哈希）、analysis-coverage.md、hypothesis-ledger.md |
| attack-defense | recon / breach / lateral（需 file）/ persistence / report（需 file） | assets.md、evidence-index.md、paths-ledger.md（candidate/chosen）、persistence-registry.md（手动排除） |
| av-evasion | V1 边界 / V3 配对（需 file）/ V2 证据（需 file）/ V4 外推（需 file） | experiment-plan.md（自研/实验室/第三方）、实验报告（技术侧+检测侧）、判定日志（构建/判定+哈希） |

## 结构门禁的边界

- 只做结构校验；表格「未填满行」会列出但不理解语义（N-A 理由是否成立仍是复核员的事）。
- 阶段材料中的哈希检查只检查格式；任务依赖产物另外读取原文件核对 sha256。
- 结构门禁与依赖就绪都不能代替漏洞语义验证。

## 依赖任务与防重复执行（1.10.0）

`operation_intent` 可带 `task_key`、`depends_on` 和 `required_artifacts`。
同会话同键同定义重放返回原 id，变更定义拒绝复用。引用必须指向已登记执行任务；
拒绝依赖环、跨会话、不同资产组与不相交的显式资产范围。

`operation_task action=ready` 查询就绪和等待原因，`claim/start` 在状态锁内再次检查。
前置任务未成功不能启动；指定产物还需前置任务登记该路径、文件存在且非空、
位于当前工作区并通过 sha256。产物目前限 16 MiB，相对路径禁止越界。
这只证明依赖与内容完整性，不证明产物中的结论正确。

带依赖或稳定键的任务更新需回传 `start/claim` 返回的 `task.leaseId` 为 `lease_id`；
重试产生新租约，旧执行者不能提交结果。无依赖的旧任务维持旧更新协议。
`runTrackedTask` 的依赖失败会阻止执行体；宿主原生 guard 在子代理、MCP 等匹配工具执行前
检查依赖，但不自动把所有工具调用记为成功，也不声称对子代理派发实现跨进程事务。
工作台显示真实等待原因，重启后根据落盘任务与当前产物重新计算。

负责人匹配沿用保守工具别名；同时有多个受约束任务匹配时拒绝猜测，
应使用不同负责人或逐项编排。未登记的工具动作不由这一层自动推断依赖。

## 桌面端安装

使用官方桌面端的插件管理入口选择本插件打包产物。整套 Saker 安装在仓库根目录运行 `node scripts/install-desktop.mjs --desktop-dir "C:/path/to/DeepSeek Harness"`：首次打开官方桌面端初始化后，完全退出应用再安装。安装器调用桌面端随附 CLI 管理 desktop profile，不直接修改 profile 文件。重新打开桌面端后检查当前预设中的 `stage_gate` / `gates_list` 工具。

## 项目工作台（1.7.0）

会话标签页「项目工作台」按**工作区**只读展示：目标契约、完成标准收尾进度、方向/任务状态
（含结果冲突 `⚠` 与 `interrupted`）、产物索引（证据行 / 扫描待处置 / 最近门禁 / `reports/`）
与需要处理的 attention 清单。

- 服务端：`lib/project-snapshot.mjs` 只读本工作区文件；
  `lib/project-channel.mjs` 通过宿主 connection 注册 `/dsh-stage-gate-project`，
  使用宿主鉴权与同源保护，端点 `status`（只接受绝对路径且存在的工作区）。
  Desktop 与 Web 客户端共用 connection RPC，避免直接 fetch 在 Desktop 返回空响应。
- 客户端：`lib/client.js` 注册 `conversation.view`。注意必须
  `ctx.slots.inject("conversation.view", () => ctx.slots.register(...))`——
  直接 `register` 不会出现在标签栏（实测）。
- 与其它标签页的分工：finding 台账在「redteam 成果」，跨会话记忆在「战役记忆」，
  覆盖矩阵在「AttackAtlas」；本页只管项目契约与执行状态。

## 作业进度（1.8.0）

项目工作台新增 7 步进度条：确认目标 → 快速摸底 → 整理合并 → 按指纹归类 → 排优先级 →
先验证再铺开 → 出结果/转下一目标。页面和资产组表只读同一份工作区文件：

- `asset-inventory.json` 提供资产数；
- `fingerprint-buckets.json` 提供资产组、资产 ID 与优先分；
- `operation-state.json` 的方向/任务提供阶段、`bucketId`、负责人与进行中/排队/受阻状态；
- `reports/` 决定最后一步是否进入当前阶段。

`attack_plan` 生成的资产组会自动登记为带 `bucketId` 的排队任务（已有 `operation-state.json`
时），子代理领取或完成后状态回流到同一张图，不在界面里另造一套进度。任务区同时显示
`parentTaskId` 父子树，至少支持两级：资产组任务为父、验证/复核子代理为子。

`operation_intent` 模型工具现可显式携带 `stage` / `bucket_id` / `target_ids` /
`reuse_score` / `parent_task_id`，与作业进度和攻击清单共用一套字段。

## 标签页进度状态（1.9.6）

`shell.overlay` 在不增加页面控件的情况下读取当前会话状态和只读工作台快照，并更新浏览器标签标题：
运行中显示当前阶段，失败显示「失败」，有完整报告且完成标准已收齐时显示「有结果」，其余已停止任务显示「等待用户」。
不写入会话标题事件；切换到其他主面板时保留宿主产品标题。

## 测试

`node test/run.mjs`：纯函数 runGate/listGates 的 fixture 测试（含通过/失败/缺 file/未知门/审计日志写入）。
## 执行任务状态

子代理结果回收（1.6.2）：`scanner`/`semgrep` 这类长工具由 `runTrackedTask` 自动收尾；
`subagent` 家族改为按宿主生命周期回收——`subagent/start` 把唯一匹配的排队任务转
`running`，`subagent/end` 按 `stopReason` 收进 `succeeded`（写入子代理自己的最终输出）/
`failed` / `interrupted`。绑定规则与长工具一致：同负责人别名 + 同 session 且候选唯一
才动，多候选一律交给模型自己收尾。

结果冲突只记不覆盖（1.6.3）：终态任务再收到**不同**结果时写 `task.conflicts[]`
（最多留最近 5 条），**不改已落库的终态**；同结果重复上报按幂等处理（`updatedAt` 也不动）。
`subagent/start` 时记 `runId→taskId`，`subagent/end` 按 runId 精确回收，
并发同 provider 的子代理也能对上号。冲突会出现在项目工作台的 `任务结果冲突` attention 里。

> 实现注意：`subagent/start|end` 是**作用域事件**，监听器只拿得到 `info`、拿不到 parent，
> 所以必须挂 `agent/created` → `agent.ctx.on(...)` 把 agent 闭包进作用域监听；
> 另外原生 `subagent` 是异步派发，`tools/result` 只代表"已启动"，不能拿它收尾。

`operation_intent` 可带 `owner` / `max_attempts`，将方向登记为可执行任务。
`operation_task` 负责 `start / heartbeat / progress / succeed / fail / cancel / retry / interrupt`
状态流转；长时间无心跳的 running 任务会在下一次状态写入时转 `interrupted`。
`operation_task(action=claim)` 可在共享 workspace 里原子领取最老的 queued 任务，
供多个内部子代理避免重复执行。
长任务工具（`nuclei_scan` / `httpx_probe` / `ffuf_fuzz` / 注册表扫描器 / `semgrep_scan`）
会按 `owner` 自动认领唯一 queued 任务，在工具执行体内完成
`running → succeeded/failed`，不要求模型在调用前后手动补两条状态操作。
