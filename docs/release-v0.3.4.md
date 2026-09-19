# Saker v0.3.4

## 焦点

这一版不追求增加更多入口，重点是把长任务、上下文和长期记忆做成可恢复、可测量、可治理的底座。

## 主要更新

### 任务恢复

- `stage-gate 1.6.1` intent 增加 `owner` / `maxAttempts` 与任务状态机：
  `queued / running / succeeded / failed / cancelled / interrupted`。
- `operation_task` 支持 start/heartbeat/progress/succeed/fail/cancel/retry/interrupt。
- scanner、semgrep 等长任务工具按 session + owner 自动绑定 intent，
  执行体结束自动收口，不要求模型手工补两条状态调用。
- `operation_task(action=claim)` 支持多个内部子代理在同一项目 state 中原子领取
  queued 任务，避免重复执行；不解析不可靠的 prompt task id。
- 同 owner 多候选或 session 不匹配时拒绝自动绑定，避免接力错任务。
- owner 使用边界匹配而不是子串匹配，短名称不会误领 `rescan` / `webscan`
  一类相邻任务。
- `trace-vault` 工具调用开始即写 `running`，结果返回更新同一行；
  进程中断或心跳过期自动标 `interrupted`。
- **子代理结果回收**（`stage-gate 1.6.2`）：按宿主生命周期事件
  `subagent/start` → 唯一的 queued 任务转 `running`（顺手挡住重复认领），
  `subagent/end` → `completed` 收 `succeeded` 并写入子代理**自己的**最终输出、
  `error` 收 `failed`、`aborted` 收 `interrupted`（可 retry）。
  绑定沿用保守规则（同 owner 别名 + 同 session，唯一才动）；多候选一律不动，
  交给模型自己收口，宁可漏记也不猜归属。
- **任务结果冲突只记不覆盖**（`stage-gate 1.6.3`）：终态任务再收到**不同**结果时
  写入 `task.conflicts[]`（最多留最近 5 条，含 from/to/明细），**不覆盖已落库的终态**；
  同结果重复上报按幂等处理（连 `updatedAt` 都不动）。`subagent/start` 时记下
  `runId → taskId`，`subagent/end` 按 runId 精确回收——并发同 provider 的子代理
  也能对上号；宿主重启后退回保守匹配。冲突会进项目工作台 attention（`任务结果冲突`）。

### 上下文与工具面

- 三 preset 的 tool-result pruner 从 `1000000` 字符降到 `32768` 字符，
  超出裁到头 `24576` + 尾 `6144`。真实宿主压力验证：3 个 120K 输出
  被压到最长 30759 字符，连续 3 次一致；正常 1M 窗口下仍保留完整结果，
  到压力门才裁剪。
- `scanner-tools` 补入 `katana_crawl`，覆盖已配置但此前不可调用的
  JS/API 端点发现能力；默认深度 3、限速 20、目标须登记。
- 同步补入 `afrog_scan` 与 `fscan_portscan`：
  afrog 默认仅 high/critical、限速 20/并发 5；
  fscan 默认关闭 POC/爆破/Redis 利用，只做授权范围内资产面发现。
- `scanner-tools` 增加 8 个“按安装状态注册”的可选方向：
  Prowler、Trivy、Checkov、kube-hunter、Arjun、Dalfox、
  Volatility 3、Binwalk。未安装时不进入模型工具面，避免不可用 schema
  常驻；装好后重启宿主即可使用。
- `tool-scope` 新增 `tool_pack`：
  WebShell 全局工具包默认收起，模型进入后渗透阶段时按需加载。
- 长会话 10 轮真实抓包：工具面恒定 90 个 / 80417B；
  运行时不重复膨胀。
- 30 轮真实宿主 mock 压测：工具面恒定 94 个 / 83920B；
  第 30 轮消息体和整体请求分别 60389B / 144486B，增长有界。
- 30 轮审计连续重复 3 次，工具面与体积保持一致。
- 30 轮审计新增首轮工具定义体积分解：宿主内置 `pwsh` / `workflow` 最大，
  插件侧 `redteam_*` 11738B、`campaign_*` 5795B、`operation_*` 5520B；
  当前真实 trace 样本不足以证明某个包低频，暂不按猜测隐藏工具，防止省 token
  反过来降低任务成功率。

### 长期记忆与知识

- **知识检索（`knowledge-hub 0.3.0`）**：修掉"中文提问 + 英文术语"的召回坑
  （实测「Sigma 检测规则 powershell 编码命令」旧版只命中一篇无关中文文档，
  `sigma-rules/...powershell_base64_encoded_*.yml` 排在第 9）。三件确定性改动——
  中文术语按固定对照表替换成英文说法后整句再检索、混合查询额外跑"只含拉丁术语"的
  FTS 计划、按"命中查询概念数"对同一候选集重排（不引入向量库、不调模型）。
  评测集同时扩容到 **52 条人工核对用例**（新增用例带 `expectPaths` 精确文档判定）：
  Top-1 94.2% / Top-5 100% / MRR 0.965 / 负样例标记 4/5；覆盖新增
  原型污染、GraphQL、OAuth redirect_uri、格式化字符串、RSA 共模、APK 逆向、
  Azure Managed Identity、DCSync、Sigma LSASS、UART/JTAG、iOS Keychain 和
  Linux auditd 持久化。
- 知识评测脚本新增**样本量下限门禁**：正样例少于 50、负样例少于 5 直接失败；
  用 1 正 1 负的小样本做过反向验证（旧实现会显示 100% 假绿，现在亮红），
  反向锁已作为 `knowledge-eval-guard` 进入全量回归。
- **知识检索提速（`knowledge-hub 0.3.1`）**：上面那三件改动一度把平均耗时从 ~230ms 推到 ~375ms，
  CPU profile 一查大头不在检索——`ensureKnowledgeIndex()` **每次检索都会调一次 `status()`**，
  而它每次都 `SELECT COUNT(*)` 整表（8.4 万 chunk，实测 ~140ms）。计数只在重建/失效时变，
  改成进程内缓存后平均耗时 **375ms → 34.9ms**（比改动前的 230ms 还快 6.6 倍），
  检索质量指标一字未变。
- **提示词装配路径上的全量遍历也修了（`knowledge-hub 0.3.2`）**：知识库那行 manifest
  每个回合都会被装配一次，而它在旧实现里每次都重算——`stats()` 要把整个知识目录遍历一遍
  （实测冷 348ms / 热 ~33ms，2 轮会话里回调被调用 3 次）。改成缓存（5 分钟 TTL +
  导入/同步/索引重建时显式失效，空库也走缓存）后，装配期这次遍历变成 0ms。
  - **方法目录也走同一条热路径**（`method-stack 0.1.16`）：`fullCatalog()` 每回合遍历内置/用户
    方法目录并逐个读取 `prompt.md`（实测中位 8.5ms）。改成 60s TTL 缓存，并在
    `clone / restore / save-prompt` 三条写路径显式失效；临时 `DSH_HOME` 的真实 RPC handler
    验证保存后立即读到新正文，装配期中位降到 0.1ms。
  另：30 轮工具面审计补了"关键工具必须在场"的断言——它以前只断言"工具面稳定"，
  实测一个插件语法错误导致整个插件消失时审计照样全绿。
- `campaign-memory` 新增 `campaign_memory_feedback`：
  `helpful / misleading / obsolete` 反馈参与热度排序或退役，旧库自动迁移。
- `campaign-memory 1.1.12` 补上「候选→落库」闭环：装配期若本工作区存在
  `memory-candidates.md`，召回块多一行「有 N 条未入库记忆候选」提示
  （只在该文件存在时出现，实测整块 284 字符；没有记忆也没有候选时整块为空、零 token）。
  没有这行提示时，收尾蒸馏落盘的候选没人确认，真实库里会一直没有记忆。
- 新增只读报告 `scripts/report-memory-effect.mjs`：
  写入 / 当前召回窗口 / 读取 / 反馈 / 项目推进度（准则、意图、任务状态）一条链，
  并按「有被读取过的记忆 vs 没有」分组给项目推进度关联；样本不足时明确标注，
  不做因果声明。配套 `scripts/test-memory-effect.mjs` 14 条断言（含「门槛调高必须变成样本不足」
  与「报告跑完 usage/feedback 不变」两条反向验证）。
- 知识库保持 FTS5 + 中文 bigram + BM25 + metadata boost；
  30 条中英混合真实评测：Top-1 93.3%、Top-5 100%、MRR 0.947、平均约 230ms。
- 当前证据不支持先引入 embedding/RAG。
- 修复普通年份被误判为 Exploit-DB 精确 ID 的误召回；无答案查询暴露的
  词面高分类问题已列入后续 reranker/置信度校准，不直接跳到向量库。
- `knowledge_search` 增加低置信标注（查询词覆盖不足时提示），
  知识评测加入 5 条负样例；release gate 约束 Top-1 低置信率 ≤15%、
  负样例标记率 ≥60%。

### OPSEC

- `sec-config 1.3.17` 模型代理默认做字段名 + 内容双层密钥脱敏：
  Authorization/Cookie、密码、私钥、云密钥、常见 token 和 URL 查询秘密值；
  结构化 `{"password":"..."}`、嵌套 `access_token`、`tenantSecret` / `xApiToken`
  这类驼峰变体与 `name/value` 形式的 Authorization 也不会因为“值不像 token”而漏掉。
  另按 gitleaks 高置信规则补 GCP `AIza…`、GitLab `glpat-…`、Slack `xox…`、
  Stripe `sk/rk_live…`、Azure AD client secret，不做泛化熵扫描以减少误伤。
`Authorization: Basic ...` 会整段替换，不再只吃掉 `Basic` 一词；目标 IP、域名、URL
和普通验证载荷保持不变。
- **统一出站策略（跨插件总闸）**：策略是单文件契约
  `$DSH_HOME/saker-egress/policy.json`（`mode` + `allowHosts`），实现住在根包
  `dsh-saker/egress`，判定与审计落在 `$DSH_HOME/saker-egress/audit.jsonl`（超 256KB 轮转）。
  三档：`allow`（默认）/ `allowlist`（只放白名单，子域按标签后缀命中）/
  `frozen`（基础设施出站全冻）。**只管基础设施出站**（模型上游、知识包 git 同步、
  MCP 包下载）；目标流量与回环地址不受影响，避免"开了 OPSEC 就干不了活"。
  接入点：`sec-config` 模型代理转发前判定（冻结档返回 `403 EgressBlocked`，不发起请求）、
  `knowledge-hub` git 同步前判定（`frozen` 下一次 git 都不跑）、
  `mcp-studio` 包运行器（npx/npm/pnpm/bunx/yarn/uvx/pipx）spawn 前判定（不拉包、不启动）。
  设置面板新增「统一出站策略」区块：切档位、维护白名单、看最近判定；
  端点 `egress/get` / `egress/set`。
- 保留目标 IP、域名、URL 路径和普通验证载荷。
- 设置面板可切换脱敏开关，健康检查显示脱敏次数。
- 模型代理增加固定上游 origin 校验：拒绝绝对 URL / 协议相对 URL 改换目标；
  健康检查保留最近 20 次出站摘要，面板显示最近一条。
- 密钥脱敏按 Authorization、Cookie、私钥、云密钥、token、JWT 等类型分桶，
  健康检查和设置面板显示主要类型。

### 安装、报告与工作台

- 安装器的模型思考强度配置可自动发现 `_ref/dsh-src-*`，不再依赖人工环境变量。
- `redteam-results 1.0.13` 导出菜单新增稳定 JSON 报告：
  schema `saker.redteam.report.v1` / `schemaVersion: 1`。
  配套 `scripts/validate-redteam-report.mjs` 校验入口：无 `schema` 的旧导出
  按 v1 迁移并标 `migrated=true`，未知 schema 与畸形 findings 直接拒绝。
- 新增只读脚本：
  - `report-observability.mjs`：trace / memory / findings 汇总；
    memory 输出包含 `helpful / misleading / obsolete` 反馈分桶；
  - `project-status.mjs`：目标、准则、意图、任务、证据、对账和报告项目状态，
    可生成单文件 HTML 项目工作台；统一输出需人工处理的 attention 清单。
    统一 job 视图同时聚合 stage-gate 任务和 trace-vault 的 running/interrupted 调用。
    项目长期记忆按 workspace_key 聚合数量、反馈分桶和最近高频条目，误导记忆进入 attention。
- **宿主内的项目工作台**（`stage-gate 1.7.0`）：会话标签页「项目工作台」按**工作区**展示
  目标契约、准则收口进度、意图/任务状态（含结果冲突与中断）、产物索引（证据行、
  扫描待处置、最近门禁、reports/）与需要处理的 attention 清单。
  数据只读、只读**本工作区文件**（不读别的插件 SQLite）；路由
  `/dsh-stage-gate-project` 走同源信任栅栏 + CSRF，端点 `status` 只接受绝对路径工作区。
  页面顶部写明与其它标签页的分工（finding 台账在「redteam 成果」、跨会话记忆在
  「战役记忆」、覆盖矩阵在「AttackAtlas」），避免重复视图。
- **报告草稿生成**（`scripts/generate-report-drafts.mjs` + 根包 `dsh-saker/report-drafts`）：
  把结构化成果直接落成工作区里的 `reports/NN-<标题>.md` 六字段报告草稿——
  台账里已有的（描述/等级/地址/过程/三件套/报文/复核/二次评级）原样搬进来，
  编不出来的如实标 `（待补：…）`。会话从工作区台账里的 `sessionId` 取（或 `--session` 指定），
  **已有同名报告一律不覆盖**（`--dry` 只看计划）。误报默认不出报告（`--all` 可强制）。
  红线：待补提示里**不出现**门禁要检查的关键词，**证据不足的草稿必须仍然过不了 P2 结构门禁**
  ——这条由测试锁死，防止生成器用占位文案把门禁骗过去。
- 结构化报告校验新增**非阻断 warnings**：`verified` 缺 `verifyNote` / `secondRating`、
  `fixed` 缺 `retestNote`、`confirmed` 缺 `evidence`、`baseline === diffEvidence`
  都会列出，但不会把“需人工裁决”的语义问题伪装成硬失败；反向测试锁住告警存在且
  不影响 `ok=true`。

## 验证

发布前运行：

```powershell
node scripts/release-gate.mjs --knowledge --observability --task-baseline --context
```

本轮结果：

- 全量回归 `36` 套：`1983 ok / 0 fail / 17 skip`
- 真实 profile：`228` 个文件字节一致（含根包 `lib/**`）
- 隔离 profile：`228` 个文件字节一致
- 知识评测（52 条人工核对用例）：Top-1 94.2% / Top-5 100% / MRR 0.965 /
  低置信 Top-1 5.8% / 负样例标记 4/5 / **平均约 33ms**（修复每次检索全表计数之前是 ~375ms）
- 任务基线：成功率 90%，过期中断恢复率 100%
- 连续 10 次任务恢复/并发首开压力套件：10/10 通过
- 真实宿主重启恢复审计：连续 5/5 通过
- 独立 Chrome for Testing（真实点击，不是读代码）：
  - redteam 成果页与项目工作台均无 `data-slot-error`，非空白真实渲染通过；
  - 导出菜单点“结构化报告（JSON）”产出的文件带 `schemaVersion: 1`，
    并通过 `validate-redteam-report.mjs`（`migrated=false`）；
  - MCP 工作台“粘贴 JSON”抽屉里 12 个预设 chip 实际渲染，
    点 Playwright 后填入固定版本 `@playwright/mcp@0.0.80` 且 `disabled: true`。
- 真宿主装配期注入（`_ref/tools/probe-memory-candidates-inject.mjs`，两侧都验）：
  有候选的工作区主回合请求里出现候选提示行，干净工作区完全不出现召回块；
  请求按工作区路径认领并断言带 `tools`，避免把「标题生成」辅助调用当成主回合。
- 子代理结果回收：真宿主 mock 子代理跑通一次完整链路（父派发 → 子代理跑完 →
  台账自动收口）；同台账里 owner=bash 的对照任务保持 `queued` 不动，
  证明回收是定向的而不是"见 queued 就关"。
- 子代理回收探针的 mock 改为按请求 tools 分发：辅助请求不再抢走工具调用序列；
  修复前 release gate 偶发 `19/20`，修复后连续 `10/10` 真宿主运行通过。
- 任务结果冲突：同结果重复上报幂等（`updatedAt` 不变）、不同结果记冲突且终态不被覆盖、
  冲突记录封顶 5 条、已收口任务收到 `error`/`aborted` 记冲突而不抛错；
  项目工作台 attention 出现 `任务结果冲突`。
- 项目工作台（真浏览器 + 真数据）：独立 Chrome for Testing 里标签页正常渲染
  （`data-slot-error=0`），显示 9 条待处理、准则 1/3、任务三条（含
  `succeeded ⚠冲突` 与 `interrupted`）、证据行/待处置/门禁 FAIL 与两份报告产物；
  只读路由另用 HTTP 直连验证：无 CSRF 头返回 403、带 token 返回快照。
  截图：`_ref/shots/project-workbench-tab-20260918.png`。
- 当前构建再次用 CFT 真机复验项目工作台：页面实际渲染目标契约、9 条 attention、
  准则 `1/3`、冲突/中断任务、扫描待处置、门禁 FAIL 和报告产物，`data-slot-error=0`；
  新截图 `_ref/shots/project-workbench-current-20260918.png`。探针宿主和 CFT 已关闭。
- 报告草稿：证据齐全的草稿**能过** P2 结构门禁；证据不足的草稿**过不了**
  （生成器不伪造 marker）；重复运行不覆盖已有报告；`--dry` 不写盘；误报默认跳过。
- 统一出站策略：判定表 23 条 + 跨实现一致性 9 条（根包 vs mcp-studio 同步实现）；
  已装形态验证 5 条（用**已安装**的 sec-config / knowledge-hub / 根包跑冻结档）；
  反向验证：把已装根包的 `lib/egress.js` 挪走后，四条断言立刻变成
  `egress-module-missing` 且 git 真的跑起来（fail-open 会被门禁抓住）。
- 已装形态字段级脱敏：直接从真实 profile 的已装 `sec-config` 加载模块，
  验证结构化 password、Basic Authorization、目标 URL 保留、工具 schema 不变、
  分桶计数、off 模式与字符串 JSON 参数可解析（7/7）。
- 全量回归新增“必需套件在场”锁：固定 36 个套件，缺套件或零断言直接失败；
  注入一个不存在的套件名时实测会以非零码退出，删测试文件不再能静默变绿。
- release gate：`20/20 passed`

### 可观测性：指标历史与趋势

- `scripts/record-metrics.mjs`：把每轮门禁测到的数字追加进
  `$DSH_HOME/saker-metrics/history.jsonl`（上限 200 行，同盘原子写）——
  工具面（个数/字节/是否稳定）、请求体（首/第 10/末/峰值）、大结果裁剪、
  记忆与反馈分桶、成果数、轨迹数与错误数。
- `trace-vault 0.3.7` 新增跨会话标准评测：首次有效动作时间（会话起点到第一次
  `outcome=ok` 工具结果）、工具失败率（blocked/error/interrupted）与错误率。
  `report-observability.mjs` 直接输出 `firstAction` / `toolFailure`；
  没有样本时写 `null`，不写 0。真实库当前为 `firstAction=7000ms`、`toolFailure=0%`。
- `scripts/report-metrics-trend.mjs`：读最近 N 条，打印表格 + 相对上一条的增减。
  它是**报告不是门禁**：不设通过线，负责让"是不是在慢慢变胖"看得见；硬门禁仍在 release gate。
- **数据诚实性**：没测到的量写 `null`（趋势里显示 `—`），**不写 0**——否则会出现
  "突然降到零"的假回退，这是最容易骗到自己的一类数据事故（测试锁死）。

## 已知边界

- 统一出站策略只覆盖 Saker 自己的基础设施出站（模型上游、知识同步、MCP 包下载）。
  插件里由用户显式发起的**目标**流量（扫描器、webshell、hunter 查询）按设计不受它管，
  它们由授权范围与 scope 约束；`sec-config` 的模型代理仍是唯一做内容脱敏的一层。
- `tools.restrict()` 只能过滤全局工具，preset 平面注册的 scanner 不能走
  `tool_pack`；当前未强行改造其注册平面。
- subagent 启动请求没有稳定的 task id/metadata 字段，因此没有把 prompt 文本
  猜测成任务 id。
- 外部 Docker 靶场和模型任务成功率基准尚未接入；当前是工程基线和本地真实宿主验证。
- dsh 自带 Playwright MCP 已完成 stdio 握手验证（24 个工具），
  `mcp-studio 1.1.14` 已加入固定版本的一等预设；预设默认关闭，
  导入后仍由用户/Agent 显式保存，不静默改 settings。
  预设 chip 与填值行为已在真实浏览器里点过一遍（见“验证”）。

## 未做

- Docker/Kali 隔离执行面。
- 本地模型。
- 多真人用户/RBAC/团队分派。
