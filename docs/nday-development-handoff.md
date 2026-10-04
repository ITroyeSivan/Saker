# Saker Nday 模式开发交接

> 交接日期：2026-09-30<br>
> 当前代码基线：Saker `0.4.66`、`dsh-hunter` `1.5.0`、`dsh-nday-hunter` `1.5.0`<br>
> 已完整验证宿主：DeepSeek Harness `0.2.0-rc.1`<br>
> 尚未适配宿主：DeepSeek Harness `0.2.0-rc.2`<br>
> 产品方向：后续以桌面端为主，不再把 Web 端当作主要交付目标。

本文是 Nday 模式的开发交接入口，按「改进方案 / 当前进展 / 待做」组织。后续模型接手时，先读本文，再读 `plugins/dsh-nday-hunter/README.md`、`plugins/dsh-hunter/README.md` 和 `preset/pentest/skills/pentest-nday/SKILL.md`。

## 0. 不可动摇的产品定义

Nday 模式不是“漏洞百科”，也不是“PoC 下载器”。目标是把公开情报变成可执行的、可复核的短路径：

1. 发现近期、高价值、与目标产品相关的 Nday 候选；
2. 把候选映射成精确的测绘查询；
3. 在用户声明的精确范围内找到候选资产；
4. 用机器可判定探针筛出短名单；
5. 用最小影响验证、OOB 或公开工具确认 RCE；
6. 一旦出现可复核的 RCE 证据立即停止；
7. 把来源、查询、候选、证据和结论沉淀到资产账本、证据索引和用户层语料。

成功标准不是“收集了多少条 CVE”，而是：

- 从情报到候选资产的耗时；
- 从查询到可复核 RCE 的耗时；
- 首轮命中率；
- 指纹误报率；
- FOFA/API 消耗；
- 每条结论是否能回到来源、查询和证据。

### 0.1 三条硬纪律

- **候选不是漏洞结论**：测绘命中、公众号文章、nuclei 模板更新、GitHub 搜索结果都只是线索。
- **不投放利用载荷**：Nday 插件只做指纹、最小验证和交接；利用交给条目点名的公开工具，由模型/用户按授权执行。
- **失败必须显式**：验证码、反爬、限流、未配置 key、无权限字段都写失败原因，不能伪装成零结果。

### 0.2 当前工作树状态

当前仓库有未提交改动。接手时不要回退现有改动，尤其不要回退：

- `plugins/dsh-nday-hunter/lib/source-pipeline.js`
- `plugins/dsh-nday-hunter/lib/free-sources.js`
- `plugins/dsh-nday-hunter/lib/metrics.js`
- `plugins/dsh-nday-hunter/lib/source-registry.js`
- `plugins/dsh-nday-hunter/lib/priority.js`
- `plugins/dsh-hunter/lib/client.js`
- `plugins/dsh-hunter/lib/index.js`
- `preset/pentest/agent.cordis.yml`
- `preset/pentest/agent.patch.yml`

---

# 一、改进方案

## 1.1 总体架构

```text
公开情报源
  CISA KEV / NVD / OSV / GitHub Advisories
  nuclei-templates 更新
  微信公众号（search-assisted）
        │
        ▼
采集器与归一化
  来源时间 / 可信等级 / freshness / dedupKey
  失败、验证码、反爬显式记录
        │
        ▼
Nday 优先级排序
  近期窗口 / 国产信创 / 目标相关性 / 利用成熟度
  可达性 / 影响 / 验证成本 / 社区热度
        │
        ▼
测绘查询计划
  目录显式 FOFA 指纹
  GET/HEAD 响应签名
  端口/产品别名兜底
  机构身份：ICP / 域名 / 证书 / 组织 / ASN
        │
        ▼
范围搜索
  FOFA 优先
  FOFA 不可用时 Hunter → Quake 降级
  精确范围过滤；机构身份只写被动候选
        │
        ▼
候选资产映射
  资产 → entryId → 查询组 → 依据
  写入 nday-scope-hunt 证据文件
        │
        ▼
轻量筛查
  nday_match：探针、证据强度、软 404 对照
  vhost / 非标准端口 / GBK / 重定向处理
        │
        ▼
最小影响验证
  OOB、只读确认、公开工具交接
  不建立 shell / webshell / memshell
        │
        ▼
沉淀与反馈
  nday_draft / nday_learn / nday_coverage
  nday_handoff / attack_plan / attack_gate
  metrics：命中率、误报率、查询到 RCE 时间
```

## 1.2 情报采集方案

### 已确定为免费/公开的源

| 源 | 用途 | 当前实现 |
|---|---|---|
| CISA KEV | 已知在野利用信号 | 公开 JSON，内置适配器 |
| NVD | CVE、CVSS、发布时间、引用 | 公开 REST API，内置适配器 |
| OSV | 开源依赖影响版本 | 公开 API，内置适配器 |
| GitHub Advisories | 漏洞公告、包生态、修复链接 | 公开 API，内置适配器 |
| nuclei-templates 更新 | PoC/模板变更线索 | 公开 commit Atom feed，内置适配器 |
| 微信公众号 | 国内提前量、复现文章 | 搜狗公开搜索页，search-assisted；验证码显式失败 |

### 明确不伪装成自动源的源

- **CNVD**：当前没有稳定、匿名、可自动化的免费 API；页面存在验证码。当前只作为宿主搜索/人工页面来源。
- **CNNVD**：部分数据需要账号或权限，不能匿名批量抓取。
- **奇安信 CERT / 国内情报站**：目前只有来源指引，没有接入稳定免费接口。
- **AVD**：存在外部浏览器脚本，但不是插件内的自动采集器。

后续如果要接 CNVD/CNNVD，必须先解决授权、频率、验证码、页面结构和可复核来源问题；在没有这些条件前，不要把它们写成“已接入”。

### 采集器设计原则

- 采集器默认不开启，避免安装后未经同意访问外部源。
- 后台定时器每 15 分钟检查一次，只有启用且到期才发请求。
- 每个源独立记录 `ok / skipped / failed`。
- 一个源失败不阻断其他源。
- 候选统一做 `dedupKey`、`trust`、`publishedAt`、`freshness`。
- 采集结果落 `$DSH_HOME/nday-hunter/`，不写随包目录。
- 采集锁要能处理崩溃遗留锁；当前已实现无效 PID/过期锁恢复。

## 1.3 Nday 优先级方案

优先级不是简单按发布时间排序，而是多因子打分：

| 维度 | 目标 |
|---|---|
| 近期窗口 | 优先新披露、新利用、新模板 |
| 国产/信创 | 护网与国内产品优先 |
| 目标相关性 | 与目标技术栈、产品、厂商匹配 |
| 利用成熟度 | 有公告、编号、PoC、补丁差分或成熟工具链的优先 |
| 可达性 | 无需认证、外网可达、前置条件少的优先 |
| 影响 | RCE、认证绕过、反序列化、任意文件读写优先 |
| 验证成本 | 可探针判定、可 OOB、可最小影响的优先 |
| 社区热度 | 公众号、会议、演练、工具收录作为时间窗口信号，不作为结论 |

策略字段当前包括：

```text
recentDays
domesticBoost
trendKeywords
excludeVendors
maxCandidates
queriesPerNday
concurrency
```

后续可扩展：行业权重、资产暴露面权重、FOFA 配额成本权重、目标已有技术栈权重、历史命中反馈权重。

## 1.4 测绘查询方案

查询计划分层：

1. **目录显式指纹**：条目里已经写明 FOFA 语法，优先级最高。
2. **探针响应签名**：从 GET/HEAD 响应判据派生被动产品签名。
3. **端口收窄**：目录给出明确端口时收窄查询。
4. **产品别名兜底**：没有精确语法时才用，必须标注为兜底。
5. **机构身份查询**：ICP、域名、证书组织、组织名、ASN 等，只用于机构候选发现。

硬规则：

- 不把 Shodan/Quake 原生语法误发给 FOFA。
- 不把宽泛产品名当受影响版本。
- 不把产品别名兜底写成精确指纹。
- 没有精确范围或机构身份时，在调用 API 前拒绝。
- 机构身份没有精确范围时，只保存被动候选，不进入活动资产账本，不探测候选主机。

## 1.5 资产平台与降级方案

- **FOFA**：主平台，是设置页唯一明确要求 key 的资产搜索平台。
- **Hunter / Quake**：可选降级平台；API key 也只在设置页/本机数据库配置。
- `nday_scope_hunt platform=auto` 的顺序为 `FOFA → Hunter → Quake`。
- 降级必须保留：
  - `platformAttempts`
  - `degradedFrom`
  - `fieldWarnings`
- Hunter/Quake 没有等价语法的字段要逐项标注，例如 `icon_hash`、`fid`、`cert.*`、高级 banner/JARM/TLS 字段。
- 不允许为了“有结果”把高级字段静默降级成宽查询。

## 1.6 轻量筛查与 RCE 验证方案

`nday_match` 的职责是短名单，不是漏洞确认：

- 探针结论只到 `fingerprint-weak / medium / strong`。
- 软 404、SPA、统一响应必须用随机对照请求识别。
- 纯状态码判据在软 404 上不能当路径存在证据。
- 内容判据在统一响应下可以保留，但只能当产品特征。
- 默认速率 15 req/s，速率调高要留痕。
- HTTPS 探针关闭证书校验，但不绕过授权范围。
- vhost、非标准端口、GBK 解码、同主机重定向都要处理。
- 命中后走 OOB 或最小只读确认；RCE 证据成立后立即停止。

## 1.7 知识沉淀方案

- `nday_draft`：从 POC 文档生成待审核草案，固定 `legacy-unreviewed`。
- `nday_learn`：把审核后的条目写入用户层 `DSH_HOME/refs/pentest/nday/`。
- `nday_triage`：把本地 POC 库排成待转工作单。
- `nday_coverage`：检查语料层、知识包层、本机 nuclei 模板层覆盖。
- `nday_handoff`：生成范围受限的 Nuclei 交接计划，不执行。
- `attack_plan` / `attack_gate`：按复用率生成资产桶，先验证代表资产再铺开。

用户层优先于包层；升级 Saker 不应丢现场学到的条目。

## 1.8 指标与反馈方案

指标文件：`$DSH_HOME/nday-hunter/metrics.json`

需要持续记录：

- 候选数；
- API 请求数；
- 查询组数；
- 成功查询组数；
- 首轮命中率；
- 指纹误报率；
- 确认 RCE 数；
- 从查询开始到确认 RCE 的时间。

反馈必须显式：

- `false-positive`
- `confirmed-rce`

指标不能只看总命中数，否则会把“查得多”误判成“效果好”。

## 1.9 UI 与配置方案

- 所有 key 从设置页或本机数据库读取，禁止硬编码。
- `dsh-hunter` 设置页提供：
  - 资产平台 API：FOFA / Hunter / Quake；
  - SRC 范围策略；
  - Nday 情报与策略；
  - 排序策略；
  - 免费源开关；
  - 采集间隔、时间窗口、每源上限；
  - 共享关键词、公众号检索词；
  - 立即采集；
  - 首轮命中率、误报率、查询到 RCE 时间。
- 设置页失败必须显示结构化错误，不能整块白板。

## 1.10 桌面端优先方案

后续产品方向：

- **桌面端是主目标**，Web 端只保留兼容验证。
- `profiles/desktop` 由 Electron 桌面端独占，CLI 安装器不得直接改它。
- 插件通过打包后的 tgz 经桌面端插件管理页安装/升级。
- `v0.2.0-rc.2` 已开始把 `dsh` 命令和插件管理内置到 macOS/Windows 桌面端，不再要求用户单独安装 Node 或 pnpm；Saker 的桌面安装文档和验证流程必须按这个新边界重做。
- 桌面端真实验证必须覆盖：插件管理页、安装/升级提示、设置面板、会话工具面、模型选择、异步问答、重启恢复。

## 1.11 v0.2.0-rc.2 适配方案

rc.2 尚未适配。已核对的官方变更中，以下与 Saker 直接相关：

1. **桌面端内置 dsh 命令和插件管理**：桌面端可在菜单栏管理并安装 dsh 命令，支持管理插件，无需另装 Node 或 pnpm。
2. **插件安装引导升级**：已安装、不兼容、内置插件的升级提示区分更细。
3. **模型目录升级到 pi-ai 0.87.1**：部分旧模型 ID 被移除，已保存的模型选择可能需要重新选择。
4. **异步问答模式**：实验性功能，等待超时后 Agent 可继续独立工作；可能影响 agent-loop、自动推进和子代理协作。
5. **Windows 沙箱权限脚本**：改为经授权后一次完成诊断与修复，保留备份和恢复命令。
6. **PowerShell / Bash 路径提示增强**：删除或移动前必须核对实际目标路径。

适配任务不是简单改 peer 版本，必须至少完成：

- 用 rc.2 源码重建 host/client/web/desktop bundle；
- 更新 Saker 对 rc.2 的 peer 兼容范围；
- 验证桌面端插件管理页可以安装/升级 Saker tgz；
- 验证桌面端不再依赖外部 Node/pnpm 的安装路径；
- 验证模型目录变更不会让 `dsh-model-reasoning` 或已保存模型失效；
- 验证异步问答模式下 `dsh-auto-advance`、子代理、Nday 工作流不会乱续轮；
- 验证 Windows 沙箱权限修复不会误改 Saker 工作区外文件；
- 更新 README、getting-started、release notes 和本交接文档。

---

# 二、当前进展

## 2.1 版本与基线

| 包 | 当前版本 | 状态 |
|---|---:|---|
| `dsh-saker` | `0.4.66` | 已打包并安装到真实 `web` profile |
| `dsh-hunter` | `1.5.0` | 已加入 Nday 设置面板、采集器 RPC、指标 |
| `dsh-nday-hunter` | `1.5.0` | 已加入采集器、降级、指标、去重/新鲜度 |
| DeepSeek Harness | `0.2.0-rc.1` | 已完成真实 Web 宿主验证 |
| DeepSeek Harness | `0.2.0-rc.2` | **尚未适配、尚未验证** |

## 2.2 Nday 工具面

当前 Nday/资产相关工具：

```text
nday_priority_plan
nday_policy_get
nday_policy_set
nday_source_fetch
nday_source_radar
nday_source_collect
nday_metrics
nday_catalog
nday_scope_hunt
nday_match
nday_coverage
nday_triage
nday_draft
nday_learn
nday_handoff
attack_plan
attack_gate
zday_pattern
oob_probe
access_confirm
```

其中 Pentest 主线 allowlist 当前包含：

```text
nday_priority_plan
nday_policy_get
nday_policy_set
nday_source_fetch
nday_source_radar
nday_source_collect
nday_metrics
nday_catalog
nday_scope_hunt
attack_plan
nday_coverage
nday_match
nday_draft
nday_learn
zday_pattern
oob_probe
nday_handoff
```

## 2.3 已实现的代码模块

| 文件 | 职责 |
|---|---|
| `plugins/dsh-nday-hunter/lib/index.js` | 工具注册、scope hunt、match、draft、handoff、采集器定时器 |
| `plugins/dsh-nday-hunter/lib/free-sources.js` | CISA/NVD/OSV/GitHub/nuclei/WeChat 适配器 |
| `plugins/dsh-nday-hunter/lib/source-pipeline.js` | 采集配置、状态、锁、去重、freshness、merge |
| `plugins/dsh-nday-hunter/lib/metrics.js` | 候选/API/命中率/误报率/时间到 RCE |
| `plugins/dsh-nday-hunter/lib/priority.js` | Nday 排序、查询计划、来源雷达 |
| `plugins/dsh-nday-hunter/lib/source-registry.js` | 来源能力注册表，区分 API/脚本/宿主搜索/仅指引 |
| `plugins/dsh-hunter/lib/index.js` | 资产平台搜索、范围管理、Nday RPC 端点 |
| `plugins/dsh-hunter/lib/client.js` | 资产平台 API、SRC 范围、Nday 策略与采集器 UI |
| `preset/pentest/opening.md` | Pentest 主 persona，接入 Nday/采集/子代理 |
| `preset/pentest/skills/pentest-nday/SKILL.md` | Nday 模式操作纪律 |

## 2.4 已实现的免费源状态

| 源 | 状态 | 说明 |
|---|---|---|
| CISA KEV | 已接入 | 公开 JSON |
| NVD | 已接入 | 公开 REST API |
| OSV | 已接入 | 公开 API |
| GitHub Advisories | 已接入 | 公开 API，可选 token |
| nuclei-templates | 已接入 | 公开 commit Atom feed |
| 微信公众号 | 已接入 | 搜狗公开结果页；验证码显式失败 |
| CNVD | 未接入 | 验证码/人工页面 |
| CNNVD | 未接入 | 账号/权限限制 |
| 奇安信 CERT | 未接入 | 仅来源指引 |
| AVD | 外部脚本 | `_ref/tools/avd-fetch.mjs` |

## 2.5 已完成的关键行为

- 自动采集器可以后台定时运行；默认停用，设置页可启用。
- 采集器支持立即采集、保存配置、查看逐源状态。
- 采集候选按编号/URL/标题去重，保留来源时间、可信等级、freshness、dedupKey。
- 采集器失败、验证码、反爬不会伪装成零结果。
- `nday_scope_hunt` 支持 `platform=auto|fofa|hunter|quake`。
- FOFA 不可用时自动降级到 Hunter/Quake。
- 降级结果保留 `platformAttempts`、`degradedFrom`、`fieldWarnings`。
- Nday 设置页已真实渲染：排序策略、免费源开关、采集状态、命中率/成本区都可见。
- FOFA/Hunter/Quake key 只从设置页或本机数据库读取。
- 全仓回归 `47 套 · 13258 ok / 0 fail / 16 skip`。
- 真实 `web` profile 字节同步：`2270` 个文件、`24` 个插件。
- `0.2.0-rc.1` 真实 Web 宿主 RPC、工具面、设置页和 Chrome for Testing UI 已验证。
- `0.2.0-rc.1` desktop bundle 构建通过；本轮没有重复启动 Electron 桌面应用。

## 2.6 已修复的典型问题

- 修复 `dsh-hunter/lib/client.js` 的括号语法错误。
- 修复 `preset/pentest/agent.cordis.yml` 新增工具列表的 YAML 缩进错误。
- 修复 `nday_scope_hunt` 无降级时读取 `null.length` 崩溃。
- 修复采集器崩溃遗留锁导致永久跳过。
- 修复工具描述预算超限。
- 修复测试 allowlist 漏掉新工具。

## 2.7 当前明确未完成

- **v0.2.0-rc.2 适配完全没有开始。**
- **桌面端还没有按 rc.2 的“内置 dsh 命令 + 插件管理”新边界重做安装和升级验证。**
- CNVD/CNNVD 仍没有稳定的自动免费源。
- 微信公众号仍受搜狗验证码/反爬影响。
- nuclei 当前只读 commit feed，还没有把模板 YAML 元数据、影响版本、作者、严重性完整抽取。
- 指标还没有接桌面端图表、导出和历史趋势。
- 误报/确认 RCE 反馈还没有从桌面 UI 直接回填。
- Nday 结果到 `stage-gate`、项目工作台、报告草稿的闭环还需要加强。
- 采集器的 per-source 退避、抖动、缓存策略、来源条款处理还可以继续完善。

---

# 三、待做

以下按优先级排列。每项都要给出可复现证据，不接受“代码看起来对”。

## P0-1：适配 `dsh v0.2.0-rc.2`

### 目标

让 Saker 在 rc.2 桌面端真实运行，并适配新的内置 dsh 命令/插件管理边界。

### 任务

- [ ] 拉取/构建 rc.2 源码和桌面端 bundle。
- [ ] 更新 Saker peerDependencies 对 `0.2.0-rc.2` 的兼容范围。
- [ ] 重新执行 `pack-all`、`install-all` 或桌面插件管理安装。
- [ ] 验证桌面端插件管理页能安装/升级 Saker tgz。
- [ ] 验证不依赖外部 Node/pnpm 的桌面安装路径。
- [ ] 验证 `profiles/desktop` 不被 CLI 安装器写入。
- [ ] 验证模型目录 pi-ai 0.87.1 下模型选择、reasoning 配置、旧模型 ID 迁移。
- [ ] 验证异步问答模式对自动推进、子代理和 Nday 工作流的影响。
- [ ] 验证 Windows 沙箱权限修复不会误改工作区外路径。
- [ ] 更新 README、getting-started、release notes、本交接文档。

### 验收

- rc.2 桌面端真实启动；
- 插件管理页显示 Saker 包且可安装/升级；
- 设置页无 slot error；
- 模型可见工具面包含 Nday 工具；
- 完成一次真实桌面会话；
- 回归、RPC、工具冒烟、安装同步全部通过。

## P0-2：桌面端作为唯一主验收面

### 目标

后续所有 UI、安装、插件升级和真实会话验证以桌面端为准，Web 只做兼容。

### 任务

- [ ] 把桌面端安装/升级流程写成唯一推荐路径。
- [ ] 所有 CDP/UI 验收一律使用 Chrome for Testing，不使用用户日常 Chrome。
- [ ] 桌面端设置页增加 Nday 指标图表、采集状态、错误详情。
- [ ] 桌面端验证 API key 不回显完整值。
- [ ] 桌面端验证采集器开关、立即采集、保存配置、失败源显示。
- [ ] 桌面端验证 SRC 范围选择和多目标子代理。

## P0-3：情报采集器可靠性

- [ ] CNVD/CNNVD：确认是否有合法稳定的公开接口；没有则保持人工/宿主搜索，不伪装自动源。
- [ ] 微信公众号：处理验证码、频控、重定向、文章正文抽取和来源时间。
- [ ] nuclei：从 commit feed 进入模板 YAML，抽取模板路径、严重性、标签、参考链接和作者。
- [ ] 采集器增加 per-source backoff、jitter、限速、缓存和失败重试上限。
- [ ] 采集器状态文件增加 schema migration。
- [ ] 对采集 URL 做白名单、超时、响应大小和 SSRF 防护。
- [ ] 明确来源条款与 robots/使用边界。

## P0-4：搜索与降级质量

- [ ] 完善 FOFA/Hunter/Quake 字段映射表。
- [ ] 对每个降级查询显示“哪些字段不支持、如何降级、是否仍具区分度”。
- [ ] 机构身份候选与精确范围候选继续严格分离。
- [ ] 防止高级指纹被静默降级成宽查询。
- [ ] 增加真实 FOFA 不可用、Hunter 可用、Quake 可用的端到端测试。
- [ ] 增加 API 配额消耗、失败原因、部分成功的结果质量统计。

## P0-5：RCE 验证闭环

- [ ] 把 `nday_scope_hunt → nday_match → OOB/access_confirm → 公开工具交接` 串成桌面端可观测工作流。
- [ ] 确认 RCE 后立即停止，不进入 shell/webshell/memshell。
- [ ] 把确认 RCE 反馈写回 metrics，形成查询到 RCE 时间。
- [ ] 把误报反馈写回 metrics，形成指纹误报率。
- [ ] 为软 404、SPA、WAF、vhost、非标准端口、GBK 增加真实靶场回归。

## P1-1：指标与反馈 UI

- [ ] 桌面端展示候选数、API 消耗、首轮命中率、误报率、查询到 RCE 时间。
- [ ] 支持按来源、平台、产品、时间窗口查看指标。
- [ ] 支持导出 JSON/CSV。
- [ ] 支持从命中行直接记录 false-positive / confirmed-rce。
- [ ] 保留历史趋势，避免只看最近一次。

## P1-2：结果进入项目工作台

- [ ] Nday 候选、命中、确认结果写入统一资产账本。
- [ ] `attack_plan` 桶进入 `stage-gate` / 项目工作台任务图。
- [ ] `nday_handoff` 交接单与公开工具执行状态关联。
- [ ] 证据索引、报告草稿、成果库之间建立双向引用。
- [ ] 桌面端显示每个桶的代表资产、验证状态和下一步。

## P1-3：语料与覆盖

- [ ] 继续补信创/国产产品语料，优先东方通、宝兰德、金蝶、致远、泛微、用友等。
- [ ] 扩展 `nday_triage` 的文档抽取和人工审核流程。
- [ ] 扩展 `nday_learn` 的 schema 校验和来源审计。
- [ ] 把 nuclei 模板与语料层做双向覆盖报告。
- [ ] 对“有模板但没有可筛条目”的产品生成明确的转条目任务。

## P2：长期增强

- [ ] 从公众号文章和厂商公告抽取产品、版本、前置条件、修复状态。
- [ ] 建立产品别名、版本区间、厂商和 CPE 的归一化表。
- [ ] 增加多语言来源。
- [ ] 增加来源质量评分和历史命中反馈。
- [ ] 增加采集器可观测性：耗时、失败率、缓存命中率、来源健康度。
- [ ] 评估是否需要独立的本地情报数据库，而不是继续使用 JSON 状态文件。

---

# 四、交付门禁

每次准备交付前至少完成：

```bash
node scripts/run-all-tests.mjs
node --import "file:///.../_ref/tools/smoke-register-real.mjs" _ref/tools/rpc-contract.mjs
node --import "file:///.../_ref/tools/smoke-register-real.mjs" _ref/tools/tool-smoke.mjs
node --import "file:///.../_ref/tools/smoke-register-real.mjs" _ref/tools/badpath-smoke.mjs
node _ref/tools/audit-scan.mjs
node _ref/tools/audit-bundle.mjs
node scripts/pack-all.mjs
node scripts/install-all.mjs
node _ref/tools/verify-installed-sync.mjs --home real
node _ref/tools/reconcile-profile-pkg.mjs --home real
```

然后必须做真实宿主验证：

- rc.2 桌面端启动；
- 插件管理页安装/升级；
- 设置页无 slot error；
- 会话工具面包含 Nday 工具；
- 真实模型回合；
- transcript 中能看到工具清单和工具调用；
- Chrome for Testing UI 验收；
- 清理临时文件并跑 `node _ref/tools/verify-temp-boundary.mjs`。

---

# 五、接手时的禁止事项

- 不要回退当前未提交改动。
- 不要把 key 写进源码。
- 不要把 CNVD/CNNVD 写成已接入自动源。
- 不要把公众号、GitHub、nuclei 更新或测绘命中写成漏洞结论。
- 不要用用户日常 Chrome 做 CDP；所有浏览器操作使用 Chrome for Testing。
- 不要把 Web profile 当主交付路径。
- 不要为了测试通过而放宽授权范围或隐藏失败。
- 不要在没有真实桌面端验证的情况下宣称 rc.2 已适配。
- 不要在未确认副作用的情况下执行破坏性操作。
