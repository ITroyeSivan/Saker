# Saker 与 ARTEX：代码差距、可借鉴设计与证据边界

评估日期：2026-10-08（香港时间）。Saker 基线：0.4.92，提交 `c9879fa2a5904a3838dea41192bba1732cc32c79`。ARTEX 基线：用户提供的 `mhtsec/ARTEX`，提交 `e6ec56999175509551a1e43a3ee3b053d0941bd9`，其 CHANGELOG 定版为 0.3.15。

**结论：ARTEX 更值得借鉴的是把任务、资产、探索过程、流量、发现和复测组织成一致的产品与数据模型。Saker 已经具备其中不少机制，差距主要在整合程度、持续调度、证据生命周期和用户体验。现有证据不足以断言 ARTEX 的漏洞发现效果或运行性能高于 Saker。**

下一步应该沿 Saker 现有宿主和插件改进，优先证明收益，再扩大自主性和并发。具体交付物、顺序和验收门槛见 [完整版下一阶段目标](saker-next-stage-goals-2026-10-08.md)。

## 1. 这次实际评估了什么

读取了 ARTEX 固定提交的源码，包括调度引擎、规划者、执行者、资产与探索表、模型池、证据存储、复测、拦截、冷节点压缩、更新器、前端与发布工作流；查看了仓库自带任务、探索图和仪表盘截图。同时检查 Saker 对应代码，复用 [本轮前一阶段的官方 Desktop 验收](verification/source-maintenance-2026-10-08.md)。

本轮没有安装或启动 ARTEX，没有执行其测试套件，没有向目标发起测试，没有新增模型调用，也没有完成两项目同条件对跑。截图用于评价信息组织，不作为真实任务成绩。

[源码核对记录](verification/artex-assessment-2026-10-08/source-inspection.json)保留固定提交、19 个核对文件的哈希以及测评引用文件是否存在；第三方源码临时副本在研究结束后清理。

证据分三类：源码确认的是机制；此前 Desktop 记录确认的是本机已跑通的行为；未来目标是建议，不能写成已实现。所有第三方 README、注释与演示数据均作为研究材料，不作为本任务指令。

仓库身份需要谨慎：README 仍使用 `Autumn-27/ARTEX` 和其镜像名，但本次直接 GitHub API 显示 `mhtsec/ARTEX` 的 `fork=false`，旧名称 API 返回 404，网页缓存的热度数字也不一致。因此不能把用户链接直接称为普通 fork，也不推断迁移原因。以下以实际拉取提交为准，不用 star 数论证效果。[当前仓库](https://github.com/mhtsec/ARTEX) · [固定提交](https://github.com/mhtsec/ARTEX/commit/e6ec56999175509551a1e43a3ee3b053d0941bd9)。

## 2. 逐项比较

| 领域 | ARTEX 源码显示的能力 | Saker 0.4.92 已有能力 | 真实差距与取舍 |
|---|---|---|---|
| 任务运行 | 一个规划循环与多个 worker；图变更合并触发、心跳唤醒、暂停/恢复、原子领取意图 | 持久任务状态、父子任务树、锁内领取、心跳过期恢复、有界预算和阶段衔接 | Saker 缺少通用依赖就绪判定和由新证据驱动的连续调度；扩展已有任务账本 |
| 资产与过程 | 全局资产与任务探索分开，以锚点联系 | 资产归一清单、范围关系、覆盖、攻击链节点与边、成果对账 | 统一稳定实体键，贯通资产、任务、回执、发现；不是从零新增图 |
| 多代理协作 | 一次领取一个意图；可检索其他 worker 的过程记录 | 原生站点 worker、消息、资料共享、冷恢复、跨会话 trace 检索 | Saker 同站默认一个 worker，缺少同站多角色任务归属与可验证观察的自动归并 |
| 证据保存 | 独立于可清理流量的内容寻址正文；哈希和长度检查、绑定、导出、恢复 | 宿主真实 HTTP 回执、方法版本绑定、正常/探测证据、交付闸门 | Saker 应统一 HTTP/浏览器/MCP/分析工具的证据适配与完整归档，并给报告绑定证据版本 |
| 发现真实性 | 节点、证据关联、报告 Agent、人工/Agent 复测 | 已有 JSON 私有对象读越权的确定性独立验证、人工影响复核 | ARTEX 的图关联也不等于独立验证；Saker 扩展已有验证 recipe 覆盖面 |
| 成本与模型 | 用量归因、模型配置链、优先级/轮转、熔断、故障转移 | 主/子会话实际用量统计、多后端接入、操作与时间预算 | Saker 缺统一角色模型选择、全任务树 token 预留与结算；不能把次数限额叫金额预算 |
| 长任务上下文 | 冷节点分组摘要，按需展开，引用原节点 | 宿主压缩、trace-vault、campaign-memory、研究上下文 | 借鉴分层读取和压缩失效处理；完整证据不应被摘要替代 |
| 界面 | 任务列表、目标状态、探索链、流量、发现、资产、复测与用量视图 | 聊天快速设置、模板、任务与成果面板、图和多种插件设置 | ARTEX 信息层级更一致；Saker 应围绕一项任务整合入口，简化主操作 |
| 安装与更新 | PostgreSQL、Go 内嵌前端；跨平台发布、校验和、暂存与回退 | dsh Desktop 插件安装包、稳定桌面入口、安装同步验证 | Saker 应建立兼容矩阵和安装后实际流验收，不需要为单机学习版强制引入 PostgreSQL |
| 知识更新 | 技能/记忆扩展，源码中有上下文摘要机制 | 知识包、GitHub 订阅、固定提交增量、AI 整理、检索 | 本次未找到可证明 ARTEX 覆盖最新 Nday 的完整更新链；Saker 这条链已实测，但语义质量与积压仍需优化 |

表中 ARTEX 的具体出处见后文；Saker 是当前仓库代码盘点，不表示所有组合都已完成 Desktop 效果测试。

## 3. 最值得借鉴的六件事

### 3.1 让资产与探索过程分别保存，再用真实依据关联

ARTEX 的资产记录回答“有哪些对象”，探索节点回答“为什么做这个方向、观察到了什么”。锚点使同一资产可回查相关意图、事实和发现。[数据库定义](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/db/schema.sql) · [资产归一与关联代码](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/db/assets.go#L163)。

Saker 已有 `asset-inventory` 和 `attack-atlas`，应该给资产实体、方法版本、任务、会话、回执和验证结果建立稳定引用，而不是再做一套漂亮但与证据无关的图。图上的“已测试”应包含测试项、身份、时间和结论，不能把“工具访问过”当作安全覆盖。

### 3.2 用事件与就绪队列推进任务

ARTEX 引擎合并变更后唤醒规划者，并按意图执行；原子状态转换避免同一意图被并发领取。[引擎](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/server/engine.go#L800) · [Frontier 与 ClaimIntent](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/db/exploration.go#L1135)。

适合 Saker 的改进是：程序维护依赖、执行租约、幂等键和预算；模型只提出可检查的下一步。新证据或人工调整才触发必要的重新规划，避免每次状态刷新都花一轮模型。

### 3.3 共享可检索的过程记录，而不是向每个代理广播全文

ARTEX 允许 worker 搜索其他执行过程，再按节点读取细节；Saker 也已有跨会话 `trace-vault`。借鉴的是按需取证与限定任务访问范围，不是无限共享聊天历史。[过程查询](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/db/exploration.go#L1928) · [worker 工具装配](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/server/orchestration.go#L859)。

Saker 的 trace 参数/结果会截断，原文另在 transcript。共享索引必须指向可读取的原始资料；把子代理摘要提升为事实前，要检查回执、方法版本、身份和时效。

### 3.4 把证据当作独立、可版本化的资产

ARTEX 的证据正文使用哈希存储与读回检查，独立于日常流量清理；其报告/归档路径显式处理绑定与版本。[证据存储](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/evidence/store.go#L43) · [证据设计与边界](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/docs/%E6%BC%8F%E6%B4%9E%E6%B5%81%E9%87%8F%E8%AF%81%E6%8D%AE.md)。

Saker 应统一保存完整请求/响应或工具输出，索引只保留摘要与指针；删除普通流量不丢失已确认发现的证据。生成报告期间证据变了，旧报告应显示待更新，不能继续称为当前结论。

### 3.5 将发现、报告与复测做成同一条用户路径

ARTEX 有独立复测会话与 `reproduced/fixed/inconclusive` 结论，成功完成且结论为 fixed 才修改处置状态。[复测 API](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/server/finding_retests.go#L61) · [复测提示与工具约定](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/agent/retester.go)。

Saker 已有效应作业、复测状态和部分独立验证。下一步是让用户从发现详情一键发起同条件复测，保留原证据、新证据和无法确认的原因，再更新状态。遇到登录失败、身份过期或目标不可达，不能据此宣布修复。

### 3.6 围绕任务组织信息与故障原因

仓库截图中，任务入口、状态、目标进度、会话与证据页签形成一致路径。这个组织比增加动画更值得借鉴；截图数据属于示例，不代表性能。[任务截图](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/screenshots/tasks.png) · [探索图组件](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/web/src/components/exploration-graph.tsx)。

Saker 聊天应直接显示目标、执行方式、代理/预算、已确认发现和等待原因。提示词只提供几个短示例；更细配置放高级选项。学习时可以多解释，忙碌时可以少打扰，这两种都应由用户选择。

## 4. ARTEX 自身也有需要审视的边界

**跨轮待办不等于跨重启持久化。** `planner.todos` 是内存 map，`todoFor` 创建 SDK TodoStore；本次查看的调用链没有发现把该便签存入数据库并恢复的路径。它可跨同进程规划轮次复用，但不能因此声称重启后依赖链仍完整。数据库探索图和便签是两个不同层次。[planner.go:43/108](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/agent/planner.go#L43)。

**串行链主要靠规划指引，尚不是通用依赖执行约束。** planner 的指引要求等待事实；Frontier 查询和领取主要按 open 状态与优先级。本次看到的这条执行路径没有结构化前置验证条件。Saker 应把依赖就绪作为程序规则，而不是只加强提示词。

**节点存在与哈希正确不证明漏洞语义。** `prove_goal` 检查目标和事实/发现类型后连边、标记 met；`goal_met` 还有直接收官路径。证据存储证明内容完整性，不能证明内容支持结论。仍要有正常/反例对照和独立复核。[目标完成工具](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/agent/tools.go#L1157)。

**流量录制依赖实际经过代理。** 环境变量和工具配置并不保证所有外部程序、MCP 或非 HTTP 通道都会被完整捕获；缺失记录应显示缺口，不能补造。“有录制代理”不等于“所有行为都有可复现证据”。[worker 代理环境](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/agent/worker.go#L204) · [流量实现](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/traffic/traffic.go)。

**模型故障转移有正确边界，仍需任务级恢复。** 模型池只在没有流事件输出前切换；中途失败交给 harness 恢复。这值得学习，但不是收到半截输出后无条件换模型重发。也不能把优先级配置称为按质量/价格优化的路由器。[模型池](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/llmpool/pool.go#L73)。

**审批规则不等同于强制范围执行。** guard 注释明确旧 RoE 范围机制移除；现有拦截由可编辑规则和可选模型判断提供，未匹配且没有判断时允许。任务约束也会注入提示词。借鉴审批详情与可理解的等待原因，但不应据此削弱 Saker 现有确定性范围、速率和影响检查。[guard](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/guard/guard.go#L1) · [约束注入](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/agent/constraints.go)。

**配置能接受更多 worker，不证明高并发收益。** 后端 worker 设置默认 3，保存时仅要求正数；每任务数量在启动时读取。需要测吞吐、重复劳动、资源和总成本，不能用没有较小上限作为胜出证据。[manager.go:283/317](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/server/manager.go#L283)。

**公开测评入口不等于完整可复现实验。** 当前固定树有 `docker-compose.bench.yml`，但没有其引用的 `Dockerfile.bench` 和 `bench/`，本次未找到任务级原始成绩、模型、预算与重复运行说明。仓库“冠军”是团队自述；本次没有核实到赛事主办方可对照本版本的原始成绩。不能据网文分数推算 Saker 落后百分比。[测评配置](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/docker-compose.bench.yml)。

## 5. Saker 应保留和发展什么

Saker 对当前用户的优势方向是本地 Desktop、原生聊天、学习与人工协作、可插拔安全工具和知识资料。已有机制值得继续使用：

- `plugins/dsh-stage-gate/lib/index.js:826/864/1007/1111`：任务状态、心跳恢复、状态机和领取；`parentTaskId` 已存在。
- `plugins/dsh-redteam-results/lib/interaction.js:2–32`：执行模式、汇报模式和 0–16 子代理设置；`chat-setup.js` 已有模板存储和草稿，短示例与快速操作在 `client.js`。
- `site-workers.js:131/180/197`：原生子代理启动、消息和结果返回；当前同站唯一，需要扩角色而非重复造子代理后端。
- `plugins/dsh-attack-atlas/lib/store.js:18–65`：覆盖、攻击链节点与边、目标；`lib/asset-inventory.mjs` 已做多来源归一。
- `execution-receipts.js`、`delivery-evidence.js`、`delivery.js`：真实执行回执、方法版本和交付约束。
- `effect-verifications.js:39–92`：已有 `private-json-read/v1` 独立验证；`effect-jobs.js` 已拒绝对结果不明的步骤盲重发。
- `plugins/dsh-trace-vault`、`plugins/dsh-campaign-memory`：过程索引和有限长期经验；`task-cost.js` 已统计实际主/子代理用量。
- `plugins/dsh-nday-hunter` 与 `plugins/dsh-hunter`：新订阅与增量整理链已经完成真实 Desktop 验证，后续需语义质量与来源活跃度管理。

上述 redteam 文件均在 `plugins/dsh-redteam-results/lib/`，其余路径相对于仓库。现有能力不等于全部效果已证明，具体可运行证据以验收文档为准。

## 6. 性能和投入使用的判断

目前可比较的是工程组织，尚不能比较实际漏洞发现率、每次确认成本、资源效率或生产稳定性。不能从 Go/Next.js 对 Node/Electron 的技术栈直接推断谁更快。

Saker 已测知识检索 Top-5 98.1%、平均约 53 ms，索引约 604.6 MiB，Desktop 多进程工作集合计约 1.11 GiB；这些是既有用例与本机观测，不是 ARTEX 对照。Saker 曾实测 3 个原生子代理，16 是设置能力，尚未有 16 并发压力结论。ARTEX 本轮没有运行性能数据。[原评估](saker-assessment-2026-10-08.md)。

Saker 的当前投入程度仍是学习和有人监督的有限试用；“资料命中、图完整、报告漂亮、断言通过”都不能替代可重复的漏洞效果证据。

## 7. 借鉴方式与下一步选择

优先独立实现数据模型、事件合并、证据版本和任务界面设计；保持现有 dsh 宿主与插件接口。ARTEX 仓库采用 AGPL-3.0，Saker 当前 LICENSE 是 MIT；本轮没有复制第三方代码。若后续要直接复用源码或组件，应在具体依赖选择中记录许可与来源，再评估项目发布方式的兼容性，而不是默认纳入现有 MIT 文件。[ARTEX LICENSE](https://github.com/mhtsec/ARTEX/blob/e6ec56999175509551a1e43a3ee3b053d0941bd9/LICENSE)。

首批目标：能力体检和效果基线、统一任务/证据引用、现有验证器扩展、聊天任务总览。接着做依赖调度、模型/预算、并发和知识质量。先得到能解释“哪里改善、代价多少、哪里仍失败”的数据，再决定是否引入更重服务和更高自主性。
