# 插件清单

Saker 当前包含 23 个独立插件。多数用户不需要逐个理解——`pack-all` + `install-all` 会完成整套安装。
每个插件目录都有独立 README 说明配置、边界与验证方式。

---

Saker当前包含23 个独立插件。多数用户不需要逐个理解；`pack-all` + `install-all` 会完成整套安装。

| 位置 | 插件 | 版本 | 做什么 |
|---|---|---|---|
| 界面与配置 | `dsh-mode-group` | 1.0.3 | 在新会话页集中展示安全模式 |
| 界面与配置 | `dsh-sec-config` | 1.3.9 | 管理工具路径、Burp/Yakit、DNSLog与改密入口（API Key由「平台设置」统一维护）；工具按分类呈现、支持指定根目录自动探测候选一键导入，可自定义与删除；**内置模型接入代理 + 端点档案一键切换**（用法见该插件 README） |
| 界面与配置 | `dsh-mcp-studio` | 1.1.13 | 管理、诊断和预览MCP服务及工具；stdio 断管错误不再打挂宿主；Chrome DevTools 预设固定 1.9.0 |
| 界面与配置 | `dsh-knowledge-hub` | 0.2.0 | 知识库管理：20 个自动同步知识包、SQLite FTS5 离线混合检索、随包 PATT 与手册、用户积累、Git/本机导入、Exploit-DB 字段化索引 |
| 界面与配置 | `dsh-skill-browse` | 1.1.8 | 设置页「技能」：列出共享 / 模式专属 / 已安装技能；上传zip/tgz安装并热载、可卸载用户层技能；一键复制宿主引用串 |
| 界面与配置 | `dsh-method-stack` | 0.1.15 | 提示词模块化：26 个内置提示词可勾选、克隆、改正文、存组合；输入框「方法 ▾」直接切换 |
| 工具 | `dsh-scanner-tools` | 1.0.5 | 将nuclei、httpx、ffuf封装为模型工具；降级阶梯只在缺装结果中返回 |
| 工具 | `dsh-semgrep-audit` | 1.0.4 | 使用本地Semgrep和随包规则集进行代码扫描 |
| 工具 | `dsh-hunter` | 1.0.4 | 聚合FOFA、Hunter、Quake资产检索与分级实测 |
| 工具 | `dsh-webshell-mgr` | 1.1.24 | 管理已授权环境中的连接、文件和数据库操作；内置16种载荷生成形态 |
| 工具 | `dsh-tool-scope` | 0.1.2 | 按会话模式收窄工具面：隐藏当前模式本来就调不动的全局工具（规则只镜像各插件既有门禁，如 webshell 仅渗透测试）；代码审计下工具声明体积 −34% |
| 过程 | `dsh-stage-gate` | 1.5.6 | 记录目标与意图，检查阶段产物是否齐全；`operation_conclude` 申请结束（**结束条件由系统判定**，准则/意图未收口会被驳回） |
| 过程 | `dsh-sec-enforce` | 1.4.4 | 在工具执行前约束写入范围、报告门和高风险操作 |
| 过程 | `dsh-route-boost` | 1.3.10 | 按当前阶段补充门禁、证据和知识资料指针；信封列出可引用技能名与工具就绪度 |
| 过程 | `dsh-auto-advance` | 0.3.8 | 子代理返回后，在有限轮次内推进尚未收口的任务；单句回复/禁工具指令不追加开工轮 |
| 过程 | `dsh-refusal-guard` | 1.0.2 | 识别异常拒答并触发有记录的纠偏流程 |
| 记录 | `dsh-redteam-results` | 1.0.10 | 保存发现、复核状态并导出Markdown |
| 记录 | `dsh-attack-atlas` | 1.2.9 | 按目标记录攻击面覆盖和攻击链 |
| 记录 | `dsh-trace-vault` | 0.3.5 | 将工具调用和结果写入可检索的过程库 |
| 记录 | `dsh-campaign-memory` | 1.1.9 | 保存可跨会话检索的战役信息 |
| 协作 | `dsh-product-subagents` | 1.1.2 | 接入本机Claude Code、Codex CLI子代理 |
| 协作 | `dsh-session-pulse` | 0.1.6 | **默认停用**：dsh 0.1.6 宿主已提供 Turn Outline、Trajectory、Todo 和 Subagent 目录；仅保留旧宿主兼容实现 |
| 协作 | `dsh-ctf-observer` | 0.1.6 | CTF 模式的旁路监督与协作看板：重复试错/错误堆积/无进展检测→注入纠偏；并提供 ctf_state/ctf_challenge/ctf_dispatch/ctf_steer 四个调度工具 |

每个插件目录都有独立README，说明配置、边界和验证方式。完整目录见 [`plugins/`](../plugins/)。

<details>
<summary><b>结果可信与执行约束</b></summary>

- 扫描命中只表示待核对线索；确认漏洞需要补充复现过程和证据。
- `dsh-stage-gate` 检查文件、标记和表格等可机器判断的阶段产物；语义正确性仍由复核者判断。
- `dsh-sec-enforce` 限制任务工作区外写入、无速率控制的全端口扫描，以及命中任务约束的命令和请求。部分可逆高风险操作进入宿主审批。
- `dsh-product-subagents` 提供不同执行后端的复核路径，但是否独立、是否具备所需上下文，仍取决于你的模型与CLI配置。
- `dsh-auto-advance` 只在存在未关闭意图时工作，有连续轮次上限，用户可以随时接管。

</details>

<details>
<summary><b>离线资料与第三方规则</b></summary>

- 渗透测试资料索引当前记录108篇。
- 代码审计资料索引当前记录236篇Markdown，并包含自建及第三方Semgrep规则（自建Java 402条 / 开源快照1096条）。
- 内置 [PayloadsAllTheThings](https://github.com/swisskyrepo/PayloadsAllTheThings) 全量文本（66个漏洞章节的README与payload清单，commit `3ac2790`，MIT），另有 20 个自动同步知识包，覆盖 CTF、渗透、AD、云/API、移动、硬件、DFIR 与应急响应。
- 检索使用 SQLite FTS5 + BM25 离线混合索引；中文按 bigram 召回，英文/CVE/EDB-ID 精确定位，结果只返回少量片段，按 `chunkId` 精读。
- Exploit-DB不随包：放到 `DSH_HOME/refs/imports/exploitdb/` 即建字段化索引，或在设置页一键下载官方索引（约30MB，需可访问gitlab.com）。索引命中形如 `[EDB-12345]`。
- Semgrep OSS快照、自建规则和其他资料具有不同许可，数量与来源以各目录README为准。

Saker自有代码采用MIT License；随附第三方资料不自动转为MIT。再分发前请阅读 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

</details>
