# 插件清单

Saker 当前包含 24 个独立插件及一个根模式包。运行 `node scripts/pack-all.mjs` 打包，再在官方桌面端插件页面安装并启用；需要脚本安装时使用 `scripts/install-desktop.mjs`。旧 `install-all` 网页安装流程已弃用。
每个插件目录都有独立 README 说明配置、边界与验证方式。本轮完整说明见[改进与插件介绍](saker-improvements-and-plugin-guide-2026-10-02.md)。

| 位置 | 插件 | 版本 | 做什么 |
|---|---|---|---|
| 界面与配置 | `dsh-mode-group` | 1.0.6 | 新会话统一展示渗透测试入口及三个子模式 |
| 界面与配置 | `dsh-sec-config` | 1.3.28 | 管理本机工具路径与服务配置，提供工具探测、模型接入代理和端点切换 |
| 界面与配置 | `dsh-mcp-studio` | 1.2.2 | 管理 MCP 服务、连接状态与工具；支持直接或代理接入、列表刷新与调用记录 |
| 界面与配置 | `dsh-knowledge-hub` | 0.3.19 | 管理 23 个可同步知识包，支持离线检索、分块精读、Git/本机导入和个人资料 |
| 界面与配置 | `dsh-skill-browse` | 1.1.10 | 浏览、导入和卸载用户技能，复制宿主引用；卸载内容可恢复 |
| 界面与配置 | `dsh-method-stack` | 0.1.22 | 选择、组合和编辑测试方法，修改会话开场；方法正文按需读取 |
| 工具 | `dsh-scanner-tools` | 1.1.10 | 封装本机扫描与爬取工具，按需加载；导入已有资产导出结果 |
| 工具 | `dsh-nday-hunter` | 1.5.8 | 更新漏洞来源，按产品与版本核对适用条件，整理优先级与待验证目标 |
| 工具 | `dsh-semgrep-audit` | 1.0.11 | 提供本地 Semgrep 扫描能力；代码审计独立模式已退出新任务菜单 |
| 工具 | `dsh-hunter` | 1.5.3 | 聚合 FOFA、Hunter、Quake 查询，提供资产平台 API 和漏洞情报更新设置；SRC 范围策略已移除 |
| 工具 | `dsh-webshell-mgr` | 1.1.32 | 管理已授权环境的连接、文件和数据库操作，编辑与删除前保存备份 |
| 工具 | `dsh-tool-scope` | 0.1.16 | 按任务阶段加载或隐藏工具，缩小模型每轮需要读取的工具列表 |
| 过程 | `dsh-stage-gate` | 1.10.0 | 记录目标、方向与任务状态，检查阶段材料和任务结束条件 |
| 过程 | `dsh-sec-enforce` | 1.4.11 | 检查工作目录、请求预算与操作约束，阻止不符合当前任务要求的执行 |
| 过程 | `dsh-route-boost` | 1.3.15 | 提供测试路径提示；渗透测试以当前小任务、具体问题和已确认影响收尾 |
| 过程 | `dsh-auto-advance` | 0.3.14 | 在有限轮次内推进尚未完成的任务，支持用户接管，避免结束后反复自动开工 |
| 过程 | `dsh-refusal-guard` | 1.0.3 | 识别异常拒答并记录；模型与服务自身的安全限制仍然有效 |
| 记录 | `dsh-redteam-results` | 1.0.43 | 管理小任务、模式示例、常规与 Nday 衔接、站点子任务、共享证据与报告材料包 |
| 记录 | `dsh-attack-atlas` | 1.3.5 | 按目标记录攻击面和已确认的发现 |
| 记录 | `dsh-trace-vault` | 0.3.8 | 记录工具调用、错误和中断，区分执行失败与目标访问受阻 |
| 记录 | `dsh-campaign-memory` | 1.1.14 | 保存并跨会话检索目标、线索和已有结论 |
| 协作 | `dsh-product-subagents` | 1.1.2 | 按需接入本机 Claude Code、Codex CLI，提供明确范围的复核任务 |
| 协作 | `dsh-session-pulse` | 0.1.7 | 默认停用；保留旧宿主兼容实现，当前任务与子代理界面由官方宿主提供 |
| 协作 | `dsh-ctf-observer` | 0.1.8 | 保留历史 CTF 会话兼容；当前没有 CTF 新任务入口 |

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
<summary><b>离线资料与第三方规则</b></summary>

- 渗透测试资料索引当前记录108篇。
- 代码审计资料索引当前记录236篇Markdown，并包含自建及第三方Semgrep规则（自建Java 402条 / 开源快照1096条）。
- 内置 [PayloadsAllTheThings](https://github.com/swisskyrepo/PayloadsAllTheThings) 全量文本（66个漏洞章节的README与payload清单，commit `3ac2790`，MIT），另有 **23 个**自动同步知识包，覆盖 CTF、渗透、AD、云/API、移动、硬件、DFIR 与应急响应，以及护网常用的 Nday/POC 语料（Awesome-POC、Nday-Exploit-Plan、PeiQi WIKI）。
- 检索使用 SQLite FTS5 + BM25 离线混合索引；中文按 bigram 召回，英文/CVE/EDB-ID 精确定位，结果只返回少量片段，按 `chunkId` 精读。
- Exploit-DB不随包：放到 `DSH_HOME/refs/imports/exploitdb/` 即建字段化索引，或在设置页一键下载官方索引（约30MB，需可访问gitlab.com）。索引命中形如 `[EDB-12345]`。
- Semgrep OSS快照、自建规则和其他资料具有不同许可，数量与来源以各目录README为准。

Saker自有代码采用MIT License；随附第三方资料不自动转为MIT。再分发前请阅读 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

</details>
