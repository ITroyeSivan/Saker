# 成果登记字段语义词典（finding-fields）

> redteam_finding_register / redteam_finding_update 三工具的完整字段语义。工具 schema 内
> 只留极简描述，本手册是唯一全量语义源（随预设分发；从任一技能基目录按 `shared/refs/finding-fields.md`
> 相对定位，或 fs-search 文件名定位）。字段名/类型/枚举与工具 schema 完全一致。

## 登记纪律（三工具共用）

- **会话 × 模式自动隔离**：归属由当前会话推导，不可也不需指定他模式；子代理的登记落入子代理
  自身会话库——需进主会话成果页的，由主会话（总控/报告员）登记。
- **每条进入报告的 finding 必登**；status 保持诚实，语义矩阵：
  `pending`=尚未验证（含验证未完成或环境性失败——WAF 拦截/目标不可达/超时——保持
  pending，不得因此判误报）；`suspect`=疑似未定论（静态线索/侧信道现象成立，但影响链
  未闭环或复核只能部分复现，报告按未验证项处理）；`verified`=验证完成且真实可再复现（**代码审计仅限动态
  验证成功**：EXP 本地复现，或在线授权环境实测 L1 通过）；`code-reviewed`=代码审计
  静态复核通过（代码侧已复核，代码级推理不得升 verified）；`false-positive`=验证后
  确认不存在/误判；`fixed`=仅限此前已 `verified` 真实存在过、用户修复后复测不成功。
- 模式原生富字段按「当前模式 persona 的成果登记条款」填（各模式板式语义见下），不发明字段。
- update 仅用于：状态流转（verified/false-positive/fixed）、severity/字段修订、verifyNote
  记复核结论、retestNote 记复测结论；delete 两步确认后删行（页面删除按钮同源）。

## 通用字段（全模式）

| 字段 | 语义 | 填写要点 |
|---|---|---|
| title | 漏洞/战果/交付物/路径名 | 简短；列表展示用 |
| severity | critical/high/medium/low | 严重/高危/中危/低危；战果与交付物=权限/价值级别 |
| target | 漏洞地址/目标/位置 | URL、主机、对象路径、产物路径 |
| summary | 核心简介一句话 | 列表页展示；控制在一句 |
| type | 漏洞/战果/交付物类型 | 按各模式类型词表（如 SQLi/XSS/未授权；可含 CWE） |
| description | 描述 | 影响与成因；战果=内容摘要（凭据数/数据范围/权限级） |
| poc | 测试过程 + **完整 EXP（必填）** | 复杂漏洞=复现脚本（`exp/<finding-id>.py`，含用法）；简单漏洞=可直接复现的完整请求/命令/输入——只写「复现条件/利用前提」不算合格 |
| evidence | 证据引用 | evidence-index 编号/产物路径；审计=双链比对文件 `artifacts/<id>-chains.md` |
| fix | 修复建议（**每条 finding 必填**） | 针对该问题点的具体修法；免杀类=检测侧建议 |
| status | pending/code-reviewed/suspect/verified/false-positive/fixed | 默认 pending；suspect=疑似未定论（可按模式省略）；verified=动态验证成功可复现（代审静态复核填 code-reviewed）；fixed 需先 verified 且修复后复测不成功 |
| evidenceLevel | confirmed/partial/unknown | 证据等级，默认 unknown |

## 可接收级别与弱配置排除（模型登记硬门禁）

- `redteam_finding_register` 只接收 `medium` / `high` / `critical`。`low` / `info` 不进入成果库；漏填等级也不能靠默认值蒙混。
- TLS/SSL 配置、CORS 配置、缺失安全头（HSTS/CSP/X-Frame-Options 等）、banner/version disclosure、普通 information disclosure、self-XSS、无影响 open redirect、rate-limit 缺失、cookie flags 等**弱配置项默认不接收**。
- 只有在补齐 `chain`（入口 → 影响）以及 `impact` 或可复现 `poc` 时，弱配置项才可能作为中危以上 finding 登记；单列“配置错误/扫描器命中/建议加固”无效。
- 如果证据只支持低危或信息项，不登记成果、不写进报告；继续找可利用链，或明确标为未验证/不接收。

## 代码审计富字段（findings 板式；**登记时必填组**：auditMode / chain / chainTracer / chainVerdict / snippetEntry / snippetSink / poc（完整 EXP） / fix）

| 字段 | 语义 |
|---|---|
| auditMode | **审计形态（代审必填）**：`static`=静态审计（未提供本地复现环境，或环境未复现生效——代码层审计结果一律归此）；`dynamic`=动态·验证成功（用户提供的本地可用环境**真实复现生效**才归此）。提供了本地环境时审计自动动态优先，但未复现生效的 finding 仍标 static |

| 字段 | 语义 |
|---|---|
| chain | 调用链 entry→sink；审计双链第一侧（审计工人链），每行一链，如 `Controller.x() → Service.y() → Dao.z(sql)` |
| chainTracer | 追踪员链（双链第二侧，独立重追的 entry→sink；与 chain 对照） |
| chainVerdict | 双链一致性结论（一致 / 不一致+差异说明；不一致=疑似，不进 confirmed） |
| snippetEntry | 入口代码片段（entry 处关键代码） |
| snippetSink | sink 代码片段（危险点实际代码） |
| cwe | CWE 编号（如 CWE-89） |
| patch | 修复 diff 建议（diff 格式） |
| sourceOrigin | manual=人工深审 / scan-confirmed=扫描命中复核确认 / scan-false-positive=扫描误报复核（对账台账用） |

## 二进制分析富字段（assets 产物板式）

| 字段 | 语义 |
|---|---|
| sampleHash | 样本 SHA256（唯一标识；页面按样本分组） |
| family | 家族/变种归属（如 AgentTesla、CobaltStrike） |
| packer | 壳/保护（如 UPX、VMProtect、无壳） |
| iocs | IOC 清单（C2/URL/IP/互斥量/注册表/持久化位置，每行一条） |
| detectionRule | 检测规则（YARA/Sigma 原文） |

## 渗透测试富字段（findings 板式；attack-defense 战果同用）

| 字段 | 语义 |
|---|---|
| baseline | 对照三件套①基线（正常请求的行数/内容） |
| diffEvidence | 对照三件套②差分（注入后真实翻转证据） |
| markerEcho | 对照三件套③marker 逐字回显 |
| impact | 影响证明（拿到什么数据/执行到什么程度，如 whoami 输出、脱库行数） |
| cvss | CVSS 向量与评分（如 `CVSS:3.1/AV:N/... (8.6)`） |
| requestPkt | 完整请求包（决定性请求原文） |
| responsePkt | 关键响应（证明影响的响应原文/片段） |
| retestNote | 复测注记（修复后复测结论：已修复/部分/未修复+依据；update 专用） |
| chain | attack-defense 战果=获取路径；利用链以 `L<级>:` 前缀标链级（L1-L5，见 ad-playbook「验证与评分」） |

## 云安全富字段（cloudpath 攻击路径板式）

| 字段 | 语义 |
|---|---|
| entry | 入口凭证或身份（AK/SK、实例身份、公开入口） |
| identity | 利用身份（IAM 用户/角色/服务身份） |
| permission | 权限（策略名/权限清单） |
| resource | 目标资源（ARN/桶名/实例 ID） |

## 应急溯源富字段（timeline 时间线板式）

| 字段 | 语义 |
|---|---|
| timelineAt | 攻击时间节点（时间线排序：ISO 或 `YYYY-MM-DD HH:MM`；未知填 unknown） |

## 渗透模式的利用交付

`proofKind` 区分 `fingerprint`、`interaction`、`execution`、`access`、`write` 与 `other-impact`。外带交互不得写成执行证明。

`reproduction` 是完整方法的 JSON 字符串，登记与更新均支持，落入成果库并随导出保存：

```json
{
  "kind": "method",
  "mechanism": "漏洞编号或确切机制名称",
  "methodVersion": "v1",
  "endpoint": "https://example.com/api/import",
  "prerequisites": ["所需身份、模块和受影响条件"],
  "dependencies": [],
  "parameters": ["认证输入方式及所需参数，不硬编码当前凭据"],
  "steps": ["可操作的完整步骤，包含实际请求及必要状态处理"],
  "successCriterion": "怎样根据输出判定已证实的影响",
  "reviewSteps": "复核步骤与对照",
  "recovery": "恢复步骤；无持久修改时明确说明",
  "verification": {"status":"not-run","evidenceIds":[]}
}
```

脚本形式使用 `kind:script`，给 `code`、`language` 与 `runCommand`；其他字段相同。没有依赖或额外前提时使用空数组。方法需要实际步骤，公告或仓库链接不能替代。超过 20000 字的材料显式拒绝，避免截断脚本后仍声称完整。

`verification.status` 使用 `verified` 或 `not-run`；已实测必须引用相应复现证据。目标的影响已证实、但生成脚本未运行时用 `not-run`，不得把两者混为一谈。成果页可显示材料完整性并导出完整利用方法；证据不够、复核未完成或仅有交互时，完整成果导出会拒绝。

渗透模式的status和二次评级是记录声明，不能单独晋级为可交付成果。门禁要求宿主执行回执匹配同会话、入口、identity、当前methodId/methodVersion及关键报文；run提供methodId/methodVersion，reproduction.verification提供controlReceiptId/probeReceiptId。派生executionEvidence不接受模型填写。HTTP执行仍不证明影响，必须另有独立效果验证。当前只支持已审阅的private-json-read/v1契约：两轮所有者参考、正常身份/归属、跨身份私有对象探测及匿名拒绝，均用实际回执；通过的effectReceiptId只能证明access，不能称为RCE。其他机制仍待验证。此阶段不代表完整实战检出完成。

Nday 成果指标从成果库当前状态读取：独立复核、明确影响、关键证据及完整方法齐备才计数；同会话的同机制与实际入口去重。重复反馈不增加成果数，删除、降级和证据撤回立即生效。成果库不存在、未迁移或不可读时报告未知，不写成零；没有唯一筛选/复核记录时不计算指纹误报率。

## verifyNote（update 专用）

复核注记：结论+依据，简短——「确认/挑战」二选一结论、对照三件套/确定性信号的判定要点、
跨 harness 双签结论（如触发）。


## 实测（hunter）配套约定

- code-audit finding 的 `poc` 字段顶部可附「指纹:」与「L1验证:」两行约定节（格式见
  audit-playbook 确证闭环流程）——成果页「实测」按钮据此自动搜索与验证。
- 主特征搜索零命中时自动逐级放宽（单一特征→框架名兜底）从互联网侧续寻可用资产，
  仍零命中才收 no-assets 并附下一步建议；实测历史登记实际命中的查询串。
- 实测结论回写 `retestNote`（[实测] 前缀）与 `evidence`（实测:verdict 附行）；
  L1 通过时 status 由实测流程置为 verified（与人工复核路径同权）。
- 授权边界：互联网资产仅 L0（存活+指纹）；L1 仅对「hunter 狩猎」页标记授权的资产；
  L2 完整 EXP 默认禁用。未授权资产需要完整 POC 验证时不设死路：建议标记授权后重试
  L1，或交接渗透测试模式按渗透纪律执行（先确认该资产测试授权，成果登记后回标）。
# 极简检查记录

`redteam_delivery` 将当前渗透会话的已复核有效成果打包为 ZIP，保存到该会话工作目录，返回实际路径。成果页面也可下载完整交付包。内含 `delivery/findings.md`、`repro/`、`evidence/` 和 `checked.tsv`。只计入证据及独立复核齐全的有效漏洞；待补齐记录保留本地，重复机制/入口合并。

脚本使用参数或环境变量接收认证信息，不能硬编码凭据。`reproduction` 可给 `scriptFilename`（安全的单个文件名），并使 `runCommand` 引用该名称；省略时由运行命令中唯一脚本名推导，无法确定则拒绝交付，须补齐名称。脚本保存在每条成果独立目录，说明中给出运行目录；代码按原字节交付，不自动修改。关键证据中的常见认证头、URL/JSON/表单凭据字段脱敏，原始记录仍保留在本地。已证实目标效果和生成脚本尚未实测必须分别标明。

使用 `redteam_checks` 批量保存或读取当前渗透会话检查记录。JSON 数组中每项含 `assetId/entryId/endpoint/methodVersion/authContext/requestRevision`（身份与请求基线变化应单独记录）、可选展示名 `asset/check`、`status`、`executed/requestValid/observationValid`、`evidenceIds`、本地 `reason` 及可选 `supplementAttempts`。

`not-hit`（已测未命中）要求真实执行、有效请求、有效观察和证据；登录失效、网关阻断及外带观测不可用不能标成未命中。`not-applicable` 需要排除条件的证据；`blocked` 保存本地阻断原因；`not-tested` 表示没有执行。不能将阴性记录登记为有效漏洞。简表 `checked.tsv` 仅有资产、检查项、状态三列，详细身份、原因与证据引用留在任务库。方法、身份、入口或请求变化后可以重测，阴性不能推导整个站点安全。
