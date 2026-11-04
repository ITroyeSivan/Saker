# 插件清单

Saker 当前包含 15 个独立插件及一个根模式包。运行 `node scripts/pack-all.mjs` 打包，再在官方桌面端插件页面安装并启用；需要脚本安装时使用 `scripts/install-desktop.mjs`。旧 `install-all` 网页安装流程已弃用。
本版不发布 `dsh-attack-atlas`、`dsh-campaign-memory`、`dsh-webshell-mgr`、`dsh-method-stack`、`dsh-route-boost`、`dsh-knowledge-hub`、`dsh-nday-hunter`、`dsh-ctf-observer`、`dsh-refusal-guard`。统一清单禁止这些插件打包、安装和激活；旧 profile 升级时由官方插件管理移除。`dsh-refusal-guard` 因会把缺少文档/账号的正常说明误判为拒答并自动重试而退出默认路径，旧审计文件不删除。比赛模式由当前 Saker 插件承载，不再启用旧 CTF 观察器；hunter 只保留 FOFA、Hunter、Quake 资产查询、平台配置和授权资产写入。

每个插件目录都有独立 README 说明配置、边界与验证方式。配置方式见各插件 README。

| 位置 | 插件 | 版本 | 做什么 |
|---|---|---|---|
| 界面与配置 | `dsh-mode-group` | 1.1.7 | 新会话统一展示自由测试、比赛模式与案例测试入口，并在切换正在运行的任务时要求明确处理 |
| 界面与配置 | `dsh-sec-config` | 1.3.38 | 管理本机工具路径与服务配置，提供工具探测、模型接入代理和端点切换 |
| 界面与配置 | `dsh-mcp-studio` | 1.2.13 | 管理 MCP 服务、连接状态与工具；支持直接或代理接入、列表刷新与调用记录 |
| 界面与配置 | `dsh-skill-browse` | 1.1.17 | 浏览、导入和卸载用户技能，复制宿主引用；卸载内容可恢复 |
| 工具 | `dsh-scanner-tools` | 1.2.0 | 封装本机扫描与爬取工具，按需加载；导入已有资产导出结果 |
| 工具 | `dsh-semgrep-audit` | 1.0.12 | 提供本地 Semgrep 扫描能力；代码审计独立模式已退出新任务菜单 |
| 工具 | `dsh-hunter` | 1.6.1 | 聚合 FOFA、Hunter、Quake 查询，提供资产平台 API 和授权资产写入 |
| 工具 | `dsh-tool-scope` | 0.3.0 | 按任务场景加载或隐藏工具，缩小模型每轮需要读取的工具列表 |
| 过程 | `dsh-stage-gate` | 1.10.2 | 记录目标、方向与任务状态，检查阶段材料和任务结束条件；仅代码审计/CTF 模式可见 |
| 过程 | `dsh-sec-enforce` | 1.4.12 | 检查工作目录、请求预算与操作约束，阻止不符合当前任务要求的执行 |
| 过程 | `dsh-auto-advance` | 0.3.15 | 可选自动续接组件，默认关闭；按案例继续由当前运行状态处理 |
| 记录 | `dsh-redteam-results` | 1.1.6 | 管理自由测试、比赛模式、案例测试、执行证据、发现、恢复与报告材料包 |
| 记录 | `dsh-trace-vault` | 0.3.10 | 记录工具调用、错误和中断，区分执行失败与目标访问受阻 |
| 协作 | `dsh-product-subagents` | 1.1.3 | 按需接入本机 Claude Code、Codex CLI，提供明确范围的复核任务 |
| 协作 | `dsh-session-pulse` | 0.1.16 | 默认停用；保留旧宿主兼容实现，当前任务与子代理界面由官方宿主提供 |

每个插件目录都有独立README，说明配置、边界和验证方式。完整目录见 [`plugins/`](../plugins/)。

<details>
<summary><b>结果可信与执行约束</b></summary>

- 扫描命中只表示待核对线索；确认漏洞需要补充复现过程和证据。
- `dsh-stage-gate` 检查文件、标记和表格等可机器判断的阶段产物；语义正确性仍由复核者判断。
- `dsh-sec-enforce` 限制任务工作区外写入、无速率控制的全端口扫描，以及命中任务约束的命令和请求。部分可逆高风险操作进入宿主审批。
- `dsh-product-subagents` 提供不同执行后端的复核路径，但是否独立、是否具备所需上下文，仍取决于你的模型与CLI配置。
- `dsh-auto-advance` 只在存在未结束的工作方向时工作，有连续轮次上限，用户可以随时接管。

</details>

<details>
<summary><b>直连资料与第三方规则</b></summary>

- 公共漏洞知识库和 Nday 资料库已退出产品。需要 CVE、公告、PoC 或 EXP 时，由当前任务直接读取用户文件或联网获取。
- 代码审计保留工具实际需要的 Semgrep 规则；随包规则与其许可证见各目录说明。
- 用户自行保存的 refs、imports 或历史知识数据不会被删除、扫描或自动导入。需要时可按普通文件读取。

Saker 自有代码采用 MIT License；随附 Semgrep 规则不自动转为 MIT。再分发前请阅读 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

</details>
