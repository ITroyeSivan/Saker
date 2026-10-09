# dsh-redteam-results

聊天输入框上方提供持续可见的任务设置：方向、协作方式、子代理上限，以及可编辑、插入、复制的提示词。草稿按会话和方向隔离，个人模板保存在本机，可跨会话选用；草稿不会自动发送或注入模型。阶段确认也可直接在聊天中完成。运行中调整频率和人数不会重置操作额度或截止时间；降低人数前先释放已占名额的子代理。

当前用于桌面渗透测试的小问题、按需站点子代理、共享材料、请求对照、成本统计和成果复核。新任务只有常规测试、Nday发现、0Day挖掘；旧代码审计记录保留读取。

每个模式有四个可编辑示例。常规流程可选单方向、收集后接 Nday、常规与 Nday 共同推进，统一使用原范围、操作额度、截止时间和 0–16子代理上限。同站续接使用原会话与工具清单；需要 Nday 的任务首次分派前须加载 nday 工具包，子会话只可加载原清单允许的工具。

协作方式提供 `guided`（共同研判）、`confirm`（关键节点确认）、`continuous`（自主推进）；`reporting`独立选择 `summary` 或 `milestone`。旧 `milestone`协作值保留为自主推进且每阶段简报。当前用户设置进入实际任务提示词，模型不能替换；共同研判与确认节点使用 checkpoint/progress 保存等待状态，未确认时目标操作和自动衔接被阻止。聊天中可补充业务思路，再显式继续；确认不增加额度或延长截止时间。

完成状态可直接用 `redteam_task {action:'progress',planComplete:true}`。结束且全部子代理已释放后，桌面“保留资料，选择下一轮问题”保存上一轮预算和证据，让人选择新的问题；模型不能自行重置。

`redteam_finding_register comparisonId=<run-pair返回的pair-ID>` 自动填入当前两张读取回执和已审阅的方法。对照必须已解释为support；登记仍是pending，不自动证明影响。正常/异常观察ID的`.observation`后缀仅解析为本会话确切保存的对应对照，不能跨会话引用。

`redteam_research assess` 优先直接提供 `id/observationId/outcome/interpretation/nextInformation`。outcome只有support、counterevidence、no-information；difference只是原始差异。未解释或支持疑点的对照不能写成not-hit，历史冲突记录读取时标成blocked。

成本从官方会话事件取得，只保存计数字段。合计主代理与所有归属子代理，包括已释放的历史子任务；缓存、缺少用量的调用和不可用会话单独显示。模型运行用时合并父子并发区间，不包括后台标题请求，不估算金额。目标操作预算不等于全部模型工具调用。

会话隔离的成果登记与展示：桌面「任务与成果」按任务、发现、资料、历史组织，当前发现、分组、分页导出都限定本会话；只有明确打开历史才跨会话聚合。成本与统计默认折叠，资料和历史统计按需加载。旧代码审计记录仍可读取。页面浏览不自动调用模型，模型工具声明仍占用上下文，不能把收起界面当作 token 节省。

## 组成

- **模型工具**（宿主平面，两预设可见）：`redteam_finding_register` / `redteam_finding_update` / `redteam_finding_delete`——执行时自动取当前会话 id 与模式（`exec.agent.session`），模型不指定归属。
- **会话标签页**（`conversation.view` slot）：与 会话/轨迹/EASM暴露面 并列的「redteam 成果」页。左侧模式入口（渗透测试 / 代码审计，带计数徽标）+「任务台账视图」跨会话大屏：
  - 上部统计：总数 + 严重/高危/中危/低危计数卡（点击即筛选）、占比堆叠条、状态分布 chips（待验证/疑似/已验证/误报/已修复，点击筛选）、类型分布 top；
  - 下部列表：一条漏洞一行（序号/名称/级别标签/状态/简介/时间），点击行手动展开详情（描述、测试过程与复现 EXP、证据引用、修复建议、复核注记）；分页 10 条/页；
  - 操作：单条**验证**（把复核请求注入当前会话，模型按对照三件套复核后回写状态）、单条**删除**（两步确认，统计动态更新）；
  - 导出菜单四项：**总览（MD）**=当前筛选范围的总览报告；**全部（表格）**=翻页取全后的 MD 表格（不受单页 100 条截断）；**报告包（HTML）**=可浏览器打印成 PDF 的自包含 HTML；**结构化报告（JSON）**=`schema=saker.redteam.report.v1` / `schemaVersion: 1`，可用 `scripts/validate-redteam-report.mjs` 校验（无 `schema` 的旧导出按 v1 迁移并标 `migrated=true`，未知 schema 拒绝）。另有**导出选中报告**=逐漏洞 MD 报告（名称/描述/等级/地址/测试过程/修复建议）。
- **存储**：node:sqlite 单库 `~/.dsh/redteam-results/results.db`（行级持久——删除某条成果即删除对应行，除非删库，数据永远在；会话隔离由 session_id 主键保证）。
- **Web 通道**：不走 connection.rpc（该 API 在部分 fiber 上注册 webServer 路由会静默 405），采用 better-sidebar 同款配方——静态注入 webServer/webRuntime 自注册 `/dsh-redteam-results` 前缀路由 + 同源信任栅栏（回环/受信 Host + Origin 同源校验）。
- **渗透 vs 代码审计的差异化**（导出与视图）：
  - 审计单漏洞 MD 报告=审计详情：问题名称/描述/等级/**RCE 主线归类**/**问题所在代码位置（sink 点）**/证据等级/状态 + **审计链路（entry→sink）** + 复现条件/利用前提 + 修复建议 + 证据与复核（双链比对记录+复核注记）；组合/复杂漏洞在 chain 里给完整链路（每行一链）。
  - 渗透单漏洞 MD 报告=测试记录：名称/描述/等级/地址 + **测试过程** + 修复建议。
  - 导出全部表格：审计列含「主线类型 + sink 位置」，渗透为「类型 + 地址」；审计统计的类型分布标注为「RCE 主线分布」。
- **板式**：两预设均为**发现型（findings）**漏洞报告版式——严重度统计卡、报告详情、MD 漏洞报告导出（其余历史板式为兼容旧库保留，不再出现在 UI 侧栏）。

## 字段

`title / severity(critical|high|medium|low) / status / evidenceLevel(confirmed|partial|unknown) / type / target / summary / description / poc / evidence / fix / verifyNote / createdAt / verifiedAt`。status 词表为漏洞型六态：`pending / code-reviewed / suspect / verified / false-positive / fixed`（suspect=疑似未定论；fixed=已修复须先 verified）。扩展字段（代审双链/CWE/patch 等）按模式落库，SQLite 冗余列保留兼容旧数据。

## 验证

`node test/run.mjs`：SQLite 数据层（:memory:）+ 通道纯逻辑——登记自增/白名单回落/状态翻转/双维隔离/筛选分页/统计/计数/验证文案/信任栅栏/端点分发。

## 安装

通过官方 DeepSeek Harness Desktop 的「插件」页安装，或完全退出应用后使用桌面自带命令。全套安装可使用仓库 `scripts/install-desktop.mjs`，见[桌面安装指南](../../docs/getting-started.md)。不直接改 desktop profile 的依赖、激活清单或锁文件；独立网页部署入口已弃用。
# 完整交付与极简已测清单

目标操作前调用 `redteam_task action=start`，policy为JSON，如 `{"mode":"0day","budget":{"toolCalls":60,"discoveryCalls":8,"minutes":30}}`。按用户已有约束确定预算；这些数值仅为格式示例。模式为nday/regular/0day，campaign兼容为nday；stop可选first-high/first-rce/queue/budget。Nday默认首个完整、已实测复现且独立复核为高危的成果停止，常规/0Day默认计划或预算结束。工具守卫计数并阻止继续目标操作，数据库重开保留已用量，不能重置同一会话预算。

`action=status` 从实际成果与当前共享请求计算状态；`action=progress`记录planComplete/queueComplete，`action=cancel`结束目标操作。停止后仍可记录成果、共享上下文、检查、读写本地证据及导出交付。工具调用数不是命令内部HTTP请求数，单个批量工具仍需其请求数量限制。0Day独立定位预算耗尽且没有可达、范围内、有效正常后台/API请求与可控输入时返回backend_api_missing。`zday_pattern`再按requestId/requestRevision选唯一业务基线；原始请求含kind及inputs(name/location/evidenceIds)。桌面宿主不支持tools.guard时启动策略明确失败，不能声称已强制预算。

`redteam_context` 保存/读取当前渗透会话共享上下文，Nday、常规和后台/API研究复用同一份数据。JSON对象包含 `assets`（id/url/inScope/reachable）、`checks`（assetId/entryId/endpoint/methodVersion/authContext/requestRevision、productConfirmed/productEvidenceIds、conditions、requestValid/baselineEvidenceIds、methodReviewed）、`requests`（id/endpoint/authContext/revision及原始请求响应）、`methods`（id/version及审阅资料）和 `maxSupplementAttempts`。这是完整快照替换，更新时携带要保留的资产/请求/方法；不会修改独立检查历史。入口须属于记录资产的同源，已知条件须附证据。该工具保存事实和引用，不执行请求。

省略 `context` 读取20条分页索引，`offset` 指定下一页；`kind=asset/request/method` 配合 `id` 和可选 `version` 按需读取详情。请求使用revision，方法使用version；存在多个版本时必须指定。当前快照替换后仍可显式读取该会话的旧请求/方法版本，输出会标记历史；其他会话不能取得这些记录。

检查项标记 `requestValid=true` 时，baselineEvidenceIds须指向唯一有效请求：实际endpoint、authContext、revision均相同，且请求记录含 `valid=true`、原始 `request/response` 文本。`methodReviewed=true` 必须对应相同entryId（或显式methodId）/methodVersion且 `reviewed=true` 的方法。相同请求revision的入口、身份、请求/响应和相同方法version的内容不能改写；内容变化采用新版本，审阅与有效性可降级。每段请求/响应限64KB，更大的内容另存原始证据并建立引用。旧快照的未关联声明只读降级为未知，不改写原数据；重新确认后可保存新的有效快照。

`nday_priority_plan` 在实际会话中自动只读加载这些资产/入口及 `redteam_checks` 的历史。省略 `verificationContext` 使用共享快照；提供当前上下文可更新当前入口，历史仍按原资产/入口/身份/方法/请求键合并。变化条件允许重测，历史阴性不得覆盖不同身份或方法。数据源缺失、旧结构、损坏或插件不可用时明确显示未知，不创建/重建成果库，也不声称已经去重。

渗透会话可用 `redteam_checks` 保存/读取检查记录，区分已测未命中、不适用、受阻、未测。成果页面展示当前会话清单并导出 `checked.tsv`，只有资产、检查项、状态三列；详细原因和检查上下文留本地。未命中必须有真实执行、有效请求、有效观察和证据。

`redteam_delivery` 在当前会话工作目录保存唯一命名 ZIP；页面的“导出本会话完整交付包”下载同样的内容：`delivery/findings.md`、`repro/`、`evidence/`、`checked.tsv`。每条有效成果必须经过独立复核，具备实际入口、影响证明、完整复现方法及关键请求/响应；仅有回连、材料不全或未复核不计入成果。脚本按运行命令的实际文件名保存到独立目录，提供前提、依赖、参数、成功判据和恢复说明，生成脚本尚未运行时明确标明。

交付中的常见凭据字段脱敏；脚本需从环境/参数读取身份，发现常见硬编码凭据时拒绝打包并提示修订。原始证据仍保留本地。空成果包说明本轮未确认有效漏洞，阴性清单不能推导整个目标安全。

## 固定版本的精选方法包

成果页折叠区域“精选方法包”提供文件导入、目录、资料读取、静态审阅、正反例证据导入、激活与历史回退。资料不加入聊天首页或每轮完整提示；模型按需调用 `redteam_method`。导入不执行脚本、不装依赖、不自动认可上游EXP。原始资料的请求顺序、变量、编码、外带配置和匹配逻辑全部保留，不将复杂判定缩成路径非404。

模型操作：`action=list` 按offset每页20条；`detail`按digest读取固定版本；`active`按id读取当前可复用版本；`stage`接收方法包JSON；`review`和`verify`接收审阅建议或测试证据JSON。模型的审阅建议不能代替桌面静态审阅；激活、回退须成果页明确操作。静态通过及带版本依赖的正例/阴性对照测试通过后状态为trusted；这表示已保存审阅及环境测试记录，不能推导当前目标必然适用或存在漏洞。

方法包文档使用 `schema=saker.method-package/1`；上限2MB、40个代码文件，每个代码文件上限256KB。id/version为小写字母数字、点、下划线、横线（最长96字符）。相同id/version不得修改，内容变化用新版本。规范化JSON排序计算整包SHA256，代码逐文件校验UTF8内容SHA256；来源固定revision及内容sha256。不会抓取引用URL，支持脱网读取本地完整包。不能随包分发的代码只保留来源、版本、摘要及获取说明，不能放入files。

| 字段 | 必填内容 |
|---|---|
| title/products/mechanism | 标题、产品数组、具体机制 |
| applicability | 条件数组，每项name/requiredEvidence |
| discovery | fingerprints数组，保留表达式及语义 |
| detection | baseline/control/criterion及按顺序requests数组；每请求id/method/target/matchers，原始variables/encoding/oob等字段原样保留 |
| exploitation | identity/steps数组/parameters数组/successCriterion/recovery；可选file对应files中的实际路径 |
| dependencies | 数组（可空），每项name/version/source URL/instructions |
| evidence | mechanism/impact/limitations，区分交互、机制和实际影响 |
| sources | 每项url/revision/sha256/license/retrieval |
| maintenance | changes与recheckConditions文本数组 |
| files | 数组（可空），每项path/content/sha256/license/redistribute=true；仅安全相对路径 |

静态审阅记录：`methodDigest/reviewer/decision(approved或rejected)/notes`。测试证据：`methodDigest/result(passed或failed)/notes/environment/runnerVersion/executedAt`；`positive`与`negative`各含expected/observed/matched，以及request/response对象（content/sha256）。passed要求正例和对照判定均满足，响应内容不同；`dependencies`列出与方法包相同name/version及validated=true。保存的是调用方提供的环境与观察证据，摘要证明材料未变，不代替人工核对它是否真实对应所称环境及机制；界面审阅应检查这些记录。

新版本暂存不影响激活版本。激活/回退在SQLite事务中同时写当前指针及变更历史，比较当前摘要防止过期页面覆盖新选择；回退只接受曾经激活且当前仍审阅/测试通过的版本。后续否决或失败测试会撤下当前版本，但保留全部旧资料及记录。共享上下文方法可加 `packageDigest`（及可选packageId），其reviewed=true必须对应当前激活的精确digest/version；方法撤下时，读取旧上下文只读降级审阅状态，不改写原证据。目标验证仍按会话的实际请求、身份和适用条件独立处理。
## Nday、常规与0Day验证方向契约

渗透结果页默认显示“可交付发现”，按会话、入口和机制去重；“待验证或补证”与“全部记录”仍保留线索、原始记录及重复历史。清单、分组和导出共用同一交付筛选，先筛选去重再分页，不会因前一页都是线索而隐藏后面的可交付记录。复现方法未运行、缺关键请求或响应、报文格式错误或入口/Host不匹配时，不能计为可交付发现或已确认RCE。虚拟Host可在复现方法中显式保存hostHeader。

这些检查只核对保存材料的一致性和明确失败条件。`verification.status=verified`及二次评级仍由调用方提交，尚不能凭这些字段证明实际执行与独立影响；真实影响验证和模型能力对照必须另取运行证据，不能用本模块契约测试替代。

保存检查时，宿主从本会话共享上下文计算证据摘要，忽略模型填写的摘要。跨轮复用须同时匹配检查身份键、产品及条件证据、正常报文、方法内容和Host；缺少摘要的旧记录仍保留，但不自动跳过检查。历史受阻不作为当前检查的结束结论；有效请求和前提补齐后仍能验证。证据摘要只证明已记录内容相同，不证明语义判断正确。

`redteam_research` 只管理当前渗透会话的资料，不执行请求，也不自动登记漏洞。`groups` 按已确认功能、实际输入结构和权限边界选择代表请求；缺少边界证据保持独立，成员之间不共享验证结论。`list` 每页20条简短索引，`detail` 按本会话假设ID读取完整记录。成果页的“研究假设”默认折叠，报文仅在详情内展开。

实际因安全或工具策略中断时，调用 `action=close id=<假设ID> document=<实际中断原因> restriction=safety-policy`（工具策略用 `tool-policy`）。方向标为“受限／未覆盖”，不要求虚构HTTP报文，不增加尝试次数，也不当成反证或通过。已有观察保留，覆盖标为 `partial`；没有观察标为 `not-executed`。中断原因来自提交者报告，不是宿主已经独立确认的执行回执。停止该分支，不改ID绕过限制。`redteam_task action=next` 单列 `restrictedDirections`；基准报告必须单列受限项，不能算作完整阴性覆盖。

`redteam_execution action=run hypothesisId=<当前方向> requestId=<已存请求> requestRevision=<版本>` 由宿主执行一次HTTP请求，生成不可通过工具提交的回执ID；`action=detail id=<回执>` 按会话读取完整回执。执行前核对当前方向、同入口/身份标签、有效范围及预算；不跟随重定向，HTTPS保留证书验证。支持HTTP/1.1普通请求，不执行生成脚本，不支持重复头、分块请求、Upgrade或独立vhost。传输用实际UTF-8正文长度及Connection: close规范化，其他已存请求内容保持；不满足契约时显式失败。

回执区分完整响应、重定向、超限、超时及传输错误。`requestAttempts`计启动尝试，`requestsWritten`表示Node请求流完成写入（不能证明服务器收到）；保留状态、耗时、捕获字节与摘要。默认回传摘要，认证头和正文只在本会话detail读取。回执不能证明身份标签真实、对象归属、权限越界或RCE，`impactVerified`固定false。

`redteam_research observe` 可引用 `controlReceiptId/probeReceiptId`，宿主从回执派生报文、执行时间和runner，忽略同时提交的报文。必须是本方向两次不同、当前完整响应，已用于观察的执行不能重复用；正文和状态相同，仅Date等头变化不能成为支持。原control/probe方式保留为 `submitted-packets`，不是宿主执行证明。

复现绑定时，run同时提供当前已审阅的 `methodId/methodVersion`，完整方法在 `reproduction` 中填写 `methodId`，并将两张回执ID放入 `verification.controlReceiptId/probeReceiptId`。成果 `identity` 必须匹配回执身份标签，关键报文须与probe回执对应；原始字节留回执，成果文本按已有规则裁去首尾空白。方法内容/版本、请求/身份/范围变化不能借旧回执晋级；复核时间或说明变化不触发重测。HTTP回执不能证明生成脚本已经执行。

当前0.4.79开发源码的自动效果验证覆盖：已审阅的 `private-json-read/v1` 业务契约。其他机制可由桌面操作人独立核对实际回执并人工复核；无法明确对象归属/ACL语义的响应仍保留待验证，不推断目标安全，也不能改称RCE。单轮对照只能支持继续验证，不能确认影响。已接入正常／异常对照批次和私有读取自动任务；其他自动影响验证器、桌面实测与真实token/检出对照尚待验收。

方法的 `effectSpec` 必须明确JSON指针：`resourceIdPath/ownerIdPath/viewerIdPath/visibilityPath/readersPath/markerPath`。此契约要求服务器JSON给出私有对象、真实查看者和所有者、显式读者列表及不在请求中的不透明私有标记；`visibility` 为 `private`，所有者在读者列表中，被测身份不在列表中。缺少字段或不清楚这些字段的业务含义，不能套用该验证器。

`redteam_execution action=verify-effect document=<JSON>` 引用已有宿主回执，不发新HTTP、不派模型。JSON含 `methodId/methodVersion` 和恰好两轮 `rounds:[{owner,normal,probe,denied},...]`：每轮分别是所有者私有对象参考、被测身份自己的正常对象、同身份读取所有者对象、同资源的匿名拒绝。八次执行必须独立，方法、入口、请求和凭据边界一致。验证实际查看者/归属、私有读者列表、标记一致性、非回显、匿名401/403/404拒绝及重复结果；不能只看状态码。失败记 `inconclusive`，不表示整个入口没有漏洞。

通过后，`verification.effectReceiptId` 绑定宿主生成的 `effect-*` ID，control/probe引用第二轮；仅 `proofKind=access` 可由该结果晋级。`effect-detail`按本会话读取对照摘要，结果页默认折叠“独立影响对照”，交付包含effect.json：私有标记只以摘要保留，实际值不写进对照摘要。原始HTTP回执仍可按ID读取。

创建新效果证明时，八张回执需在15分钟窗口内；既有历史证明按记录时间复核，不因时间经过就重复发请求。方法/请求/范围变化仍使它不能沿用。历史证明不保证现在登录态有效或当前部署未修复。

开发源码现有 `redteam_execution action=run-effect`，一次工具调用执行已审阅的 `private-json-read/v1` 对照任务。`input` 为 JSON，包含 `methodId`、`methodVersion` 和 `roles`；四个角色 `owner`、`normal`、`probe`、`denied` 各带 `requestId`、`requestRevision`。前两者需要有效的已观察业务基线；`denied` 是同一受保护对象的无认证请求，不要求另有匿名 200 接口。只能执行保存且在授权范围内的 GET 请求。

成功任务执行八次实际请求，每次计入共享预算；无效基线或失败对照提前停止，结果保留未确认。同一工作重复调用读取缓存；请求或方法变化使旧证明不可沿用。进程在发出请求后中断且未保存响应时，禁止自动重发该未知步骤。该任务不能执行任意脚本，也不证明 RCE。当前尚未完成最新版桌面验收和同模型 token/检出对比，不能宣称省 token 或高效检出。

先启动有限预算的任务，并在 `redteam_context` 保存有效范围内正常请求与实际输入。三个子模式均接受正常web/API业务请求；JS与页面材料分析不以后台请求为前置条件。`create` 的 `document` 为JSON，包含：

- `id`：不可变假设ID；`requestId/requestRevision`：当前唯一有效请求版本。
- `controlledInputs`：`[{name,location}]`，必须存在于该请求的已观察输入中。
- `title/serverPath/boundary/normalBehavior/supportCriterion/falsifier/nextInformation`：具体假设、处理路径、边界、正常行为、支持判据、反证及下一步新信息。
- `knownCheck`：`{outcome,rationale,sources:[{reference,observation}]}`。outcome为 `known/variant/none-found/not-assessed`；已评估结果必须保留确切来源和观察。none-found只说明记录的检索未找到解释。
- `maxAttempts`：1到10，默认4；`noInformationLimit`：1到3，默认2。

有效入口出现后，宿主操作守卫要求存在当前有效且未结束的假设；`zday_pattern`仍可辅助规划。预算守卫按工具调用计数，不能识别一个shell命令里的全部HTTP请求；本台账也不宣称能约束命令内部流量。当前请求正文、身份、版本、输入或范围失效会阻止沿用该假设；不能删除基线来重新进入定位预算。

禁止直接用`subagent_*`绕过管理：确有需要通过`redteam_task delegate/send`派发和续接。Nday和常规创建验证方向后也复用守卫：当前方向至多执行两次目标工具操作，随后须保存实际对照与观察或关闭方向。观察成功写入后才恢复操作额度；全局预算继续累计，数据库重开保留计数。识别、候选与规划工具不占当前方向的两次额度，仍占全局操作预算。守卫不能识别任意shell命令内的目标或请求数，这不是单请求级隔离保证。

`redteam_task action=next`读取当前方向、剩余尝试与下一条尚未登记方向的有效请求；当前方向被反证不结束整个目标。有重复支持的线索给出独立影响验证动作，最多再允许两次工具操作，此后需整理证据并关闭方向，不能无休止追加验证。原始报文存台账，create/observe/close默认只回传摘要，`detail`按需读取完整过程。更改基线ID或版本标签而报文、身份与判据不变，不能重置方向；同一检查键的supplementAttempts不能回退。

`observe` 用 `id` 选择假设，`document` 为JSON：`id`（观察ID）、`outcome`、`endpoint/authContext`、`executedAt/runner`、`expected/observed/interpretation/nextInformation`，以及 `control/probe` 的实际 `{request,response}` HTTP报文。endpoint、身份和请求路径绑定所选基线；成功状态的正常对照须有效。outcome为 `support/counterevidence/no-information/blocked`。正常对照失败只能归blocked，完全相同响应不能作为支持差异；重复须独立执行时间，重复ID拒绝。

反证关闭方向；连续两轮有正常对照的支持记录结束本假设并按公开解释归为已知漏洞、新变体、疑似未公开或未证实异常。无新信息达到限制或单假设预算用完停止，`close`也可用document中的理由结束。关闭方向不能继续或重置；仅修改ID、标题或预算不能重开同一绑定和判据。确切新基线或不同边界须重新评估，整体任务预算仍不能重置。

记录中的执行信息和语义观察由调用方提交；摘要仅证明保存内容，不能证明观察真实或全球新颖性。重复支持不替代影响和复现的独立复核，也不自动生成成果。完整原始过程留在本地台账，交付正文仍只包含有效漏洞和极简已测清单。

## 桌面问题与站点子任务

`redteam_task start` 直接传 `mode`（regular/nday/0day）、`question`、`target` 和 `toolCalls`，可选 `minutes`、`workers`（0..16，不能超过桌面选择）。小任务用0个子代理；省略workflow沿用桌面选择。旧policy JSON仍兼容，但不能与独立字段混用。默认按预算完成小任务，不在首个高危时结束。已有任务不能通过再次start重置预算。

单模式完成用 `action=progress, planComplete=true`；衔接流程按阶段用regularComplete/ndayComplete。可附 `progress` JSON保存note；JSON与独立字段中的同名标记必须一致，冲突时拒绝更新。完成标记不会因为同时提交note而丢失。

`delegate` document含site、question、need(large-site-materials或independent-site-research)、reason；必须是已保存范围内站点。同站返回原childId；`send`含childId/message续接同会话。`report`仅子代理可用，含state(completed/blocked/needs-user)、summary；报告不是漏洞证明，保存后宿主释放。`workers`核对实际数量，`cleanup`关闭本任务子代理，不能处理其他父任务。默认不创建，空闲、关闭中和关闭失败均占名额；创建失败不另起替代代理。

`pause`含code、reason、evidence。IP被封、正常访问失效等阻碍停止目标请求，保留未知覆盖。只有桌面用户处理阻碍后可恢复；模型随后用`redteam_execution run purpose=baseline`复查已存正常GET/HEAD请求，预算不重置，类型变成登录HTML不能当恢复。

## 选定材料、短判断与批次对照

`redteam_context materials`为JSON：site、files[{path,url}]。每次1..30个工作目录内文件，单文件≤512KB、批次≤5MB、每会话≤200源；同内容缓存，URL映射由提供者给出而非网络事实。返回增量前12线索及位置；kind=material、id读取详情。接口、路由、密钥样式与源码映射均只是线索，动态调用和不完整覆盖明确列出。

`redteam_research create`可用短格式：id、requestId/requestRevision、question、expectedEffect、negativeResult、nextStep。请求事实和输入由程序保存，不强迫业务研究先检索所有已知漏洞。

`redteam_execution run-pair` document含hypothesisId、normal/probe各{requestId,requestRevision}，可选methodId/methodVersion、timeoutMs/maxBytes。同入口、同实际凭证的已存GET/HEAD请求批次执行；自动保存回执及事实差异，不判断漏洞。正常访问失败停止后续请求。预算与inflight标记一同提交，实际结果未知不自动重发；重复相同工作返回缓存。`pair-detail`按job id查摘要。

差异需要解释时，`redteam_research assess id=<方向>` document含observationId、outcome(support/counterevidence/no-information)、interpretation、nextInformation；只解释最新尚未解释的回执，不再重发报文、不增加尝试次数。模型解释不是独立影响证明。

## 其他业务效果的桌面人工复核

成果详情“人工复核实际效果”用于access/write/other-impact。先有与复现绑定的实际正常与异常宿主回执；操作人填写实际权限、对象、效果和局限，明确勾选已独立核对。写入还需至少四个不同回执，其中两个成功GET读取用于效果与恢复，明确确认还原。此操作不作为模型工具，标为desktop-impact-review；不宣称程序已自动理解业务语义，不支持把普通HTTP包升级为RCE。报文、方法或范围变化使复核失效；支持的自动验证仍标为host-effect-verifier。
