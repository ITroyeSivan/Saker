# dsh-redteam-results

会话隔离的 **redteam 成果**登记与展示：渗透测试 / 代码审计两预设共用。模型在会话内登记发现，Web 端每个会话的「redteam 成果」标签页查看成果——存储严格按「会话 × 模式」双键隔离；模式页提供跨会话聚合视图（行带会话标注）+ 全局任务台账大屏。

## 组成

- **模型工具**（宿主平面，两预设可见）：`redteam_finding_register` / `redteam_finding_update` / `redteam_finding_delete`——执行时自动取当前会话 id 与模式（`exec.agent.session`），模型不指定归属。
- **会话标签页**（`conversation.view` slot）：与 会话/轨迹/EASM暴露面 并列的「redteam 成果」页。左侧模式入口（渗透测试 / 代码审计，带计数徽标）+「任务台账视图」跨会话大屏：
  - 上部统计：总数 + 严重/高危/中危/低危计数卡（点击即筛选）、占比堆叠条、状态分布 chips（待验证/已验证/误报/已修复，点击筛选）、类型分布 top；
  - 下部列表：一条漏洞一行（序号/名称/级别标签/状态/简介/时间），点击行手动展开详情（描述、测试过程与复现 EXP、证据引用、修复建议、复核注记）；分页 10 条/页；
  - 操作：单条**验证**（把复核请求注入当前会话，模型按对照三件套复核后回写状态）、单条**删除**（两步确认，统计动态更新）；
  - 导出：**导出全部**=当前筛选范围的 MD 表格；**勾选导出**=逐漏洞 MD 报告（名称/描述/等级/地址/测试过程/修复建议）。
- **存储**：node:sqlite 单库 `~/.dsh/redteam-results/results.db`（行级持久——删除某条成果即删除对应行，除非删库，数据永远在；会话隔离由 session_id 主键保证）。
- **Web 通道**：不走 connection.rpc（该 API 在部分 fiber 上注册 webServer 路由会静默 405），采用 better-sidebar 同款配方——静态注入 webServer/webRuntime 自注册 `/dsh-redteam-results` 前缀路由 + 同源信任栅栏（回环/受信 Host + Origin 同源校验）。
- **渗透 vs 代码审计的差异化**（导出与视图）：
  - 审计单漏洞 MD 报告=审计详情：问题名称/描述/等级/**RCE 主线归类**/**问题所在代码位置（sink 点）**/证据等级/状态 + **审计链路（entry→sink）** + 复现条件/利用前提 + 修复建议 + 证据与复核（双链比对记录+复核注记）；组合/复杂漏洞在 chain 里给完整链路（每行一链）。
  - 渗透单漏洞 MD 报告=测试记录：名称/描述/等级/地址 + **测试过程** + 修复建议。
  - 导出全部表格：审计列含「主线类型 + sink 位置」，渗透为「类型 + 地址」；审计统计的类型分布标注为「RCE 主线分布」。
- **板式**：两预设均为**发现型（findings）**漏洞报告版式——严重度统计卡、报告详情、MD 漏洞报告导出（其余历史板式为兼容旧库保留，不再出现在 UI 侧栏）。

## 字段

`title / severity(critical|high|medium|low) / status / evidenceLevel(confirmed|partial|unknown) / type / target / summary / description / poc / evidence / fix / verifyNote / createdAt / verifiedAt`。status 词表为漏洞型五态：`pending / code-reviewed / verified / false-positive / fixed`（fixed=已修复须先 verified）。扩展字段（代审双链/CWE/patch 等）按模式落库，SQLite 冗余列保留兼容旧数据。

## 验证

`node test/run.mjs`：SQLite 数据层（:memory:）+ 通道纯逻辑——登记自增/白名单回落/状态翻转/双维隔离/筛选分页/统计/计数/验证文案/信任栅栏/端点分发。

## 安装

web profile `package.json`：dependencies 加 `@dsh-external/dsh-redteam-results` link + `dsh.profile.bundles` 追加同名 bundle，`pnpm install`，**重启 dsh web 生效**。随 Saker 发布时用 `dsh plugin add` 增量安装即可。
