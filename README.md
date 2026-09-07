<div align="center">

# Saker

从一条线索，到一份有证据的漏洞报告。

装进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的攻防插件包。两个 agent 模式（渗透测试 / 代码审计）+ 18 个功能插件，`dsh plugin add` 增量安装，卸载零残留，不 fork 宿主。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![version](https://img.shields.io/badge/dsh-saker-0.1.0-4c6ef5)
![modes](https://img.shields.io/badge/modes-2-37b24d)
![plugins](https://img.shields.io/badge/plugins-18-7048e8)
![refs](https://img.shields.io/badge/knowledge-344%20docs-f08c00)
![rules](https://img.shields.io/badge/semgrep-1093%20files%2F1499%20rules-e03131)

</div>

<!-- 建议放一张主界面截图：登录后新建会话选择 pentest/code-audit 的视图（screenshots/） -->

## 安装

安装分两层，别混：

- **装代码（一次性）**：把 saker 的根包 + 功能插件装进 dsh。插件本质是 npm 包，必须由 `dsh plugin add` 在平台外装（运行中的 web 服务不能给自己改依赖树）。这步做一次即可。
- **做配置（装完以后，全在前端）**：工具路径、Burp/Yakit 地址、DNSLog、模型密钥——都在 设置 → 安全配置 / MCP 工作台 里填，保存即热生效，模型下一轮就能调。与本文其余命令无关。

前置：DeepSeek Harness 已装好（`dsh web` 能启动），Node.js ≥ 22.5，已配置可用模型。然后**从源码仓库部署**（推荐，一条命令装完）：

```bash
node scripts/pack-all.mjs       # clone 后先打包：产出根包 + 18 插件 tgz（tgz 不入库）
node scripts/install-all.mjs    # 按序安装根包 + 18 插件，已装的自动跳过，可重复跑
```

等价的 Release 路径（发布后）——直接用预构建资产，无需 clone、无需打包：

```powershell
dsh plugin --profile web add "https://github.com/<owner>/saker/releases/download/v0.1.0/dsh-saker-0.1.0.tgz"
# ……其余 18 个插件 tgz 同样 add（或下载到本地后 file: 引用）
```

手动装单个插件（想只挑几个时）：版本号以 tgz 文件名为准（`dsh-external-<name>-<ver>.tgz`）。

```powershell
dsh plugin --profile web add "file:./plugins/dsh-sec-config/dsh-external-dsh-sec-config-1.0.6.tgz"   # 工具路径 / 服务 / 密钥配置
dsh plugin --profile web add "file:./plugins/dsh-stage-gate/dsh-external-dsh-stage-gate-1.5.0.tgz"   # 阶段门
dsh plugin --profile web add "file:./plugins/dsh-sec-enforce/dsh-external-dsh-sec-enforce-1.4.1.tgz"  # 执行护栏
```

重启 `dsh web`：新建会话时模式下拉里出现 `pentest` / `code-audit`，功能插件进 设置 页。

更新 = `install-all` 重跑（或装新版 tgz 覆盖）；卸载 = `dsh plugin --profile web remove <包名>`，零残留。

## 两个模式

| | pentest | code-audit |
|---|---|---|
| 输入 | 授权目标、资产清单、抓包材料 | 本地源码、仓库、反编译产物 |
| 做什么 | Web / API / 移动端 / 小程序 / 云资产，SRC 式全等级穷尽 | 模块 × sink 矩阵，全量扫描链 + 深度审计链双链对账 |
| 验证 | 请求 / 响应对照，针对性复现 | 代码链路核对（entry → sink），具备环境时动态验证 |
| 交付 | 漏洞位置、测试过程、证据、修复建议 | 代码位置、审计链路、复现条件、修复建议 |

两个模式各带自己的预设（`agent.cordis.yml`）与领域知识库，随包只读注册，不写宿主配置。

## 内置内容

- `知识库 344 篇`：Web / API / 组件 / 移动 / 小程序 / 云 / 供应链 / 内网 / SRC 方法论，按主题组织在 `preset/*/refs/`。
- `semgrep 规则 1093 个文件（1499 条规则）`：Java / PHP / JS / Python / Go / Ruby 等，来源与各自许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

以上全部随包携带，断网可用。知识库按需检索注入，不整包塞进上下文。

## 纪律怎么做成的

方法论不是写在 prompt 里让模型"自觉"，而是拆成了可校验的机制：

- `dsh-stage-gate`：每阶段落盘产物做结构校验（文件存在、标记齐全、表完整），判定写入 `gate-log.md`。没过门，报告写不出去。
- `dsh-sec-enforce`：工具调用前拦截——报告缺 Gate PASS 拒绝落盘、写操作限制在工作区内、裸全端口扫描直接拒并说明原因、高危 bash 走人工审批。
- `dsh-refusal-guard`：模型异常拒答时自动重锚 → 重试 → 升级，过程落审计。
- `dsh-route-boost`：每轮注入治理信封（当前阶段、该过的门、证据等级、refs 指针），阶段切换时才投递。
- `dsh-auto-advance`：子代理返回后自动推进下一步，有轮数上限，人可随时接管。

## 可视化与协作

- `dsh-attack-atlas`：攻击面矩阵。战场分区 × 战术列逐格标记（已测 / 有发现 / 未命中 / 不适用 / 预算耗尽），按目标分账。
- `dsh-redteam-results`：成果页。会话隔离的 findings 库，严重度统计、状态流转、MD 报告导出。
- `dsh-mcp-studio`：MCP 工作台。stdio / streamable-http 两种传输，支持 Burp、Yakit 等自建 MCP，连接状态与工具预览一体；server 列表可被 sec-config 自动写入。
- `dsh-session-pulse` / `dsh-campaign-memory` / `dsh-trace-vault`：会话状态、跨会话战役记忆、每次工具调用留痕，压缩后仍可检索。
- `dsh-product-subagents`：把 Claude Code / Codex CLI 作为独立子代理跑复核（用户触发），和 dsh 自己的结论做双签对照。

## 接入你的工具箱

Saker 不让你换工具，也不要求把工具装进仓库。`dsh-sec-config` 是唯一入口：设置 → 安全配置，填本机工具真实路径，保存即热生效。

```text
工具路径        sqlmap / nuclei / dirsearch / fscan / subfinder / httpx /
                katana / afrog / ffuf / jwt_tool / nmap （11 个）
服务端点        burpUrl / yakitUrl
其他            DNSLog(url/token) / DeepSeek API key / 改密表单
```

填完的路径以 `DSH_TOOL_<NAME>` 环境变量注入每次 bash 调用，playbook 按变量取用、取不到回退 PATH——模型在终端里 `sqlmap` 就是真调你本机那份。空配置 = 什么都不注入，不影响默认行为。

### MCP：Burp / Yakit 一次接线

mcp-studio 只讲 stdio 与 streamable-http 两种传输。两类服务接法不同：

- `Yakit`：开 MCP 后填 `http://127.0.0.1:11432`，保存即桥接（自动补 `/mcp`，streamable-http），模型下一轮拿到 `mcp__yakit__*`。
- `Burp`：官方 MCP 扩展监听 legacy SSE（默认 `http://127.0.0.1:9876`），mcp-studio 不直接支持。sec-config 内置 `tools/burp-sse-bridge.mjs`（Node 标准库 stdio↔SSE 转发，零依赖）自动接上——不需要单独的 `mcp-proxy-all.jar`（Burp 扩展把代理代码编死在 fat jar 里，提取按钮在很多版本报 `Could not find mcp-proxy-all.jar`，这条路不通）。填 `http://127.0.0.1:9876`，保存即桥接，模型拿到 `mcp__burp__*`（send_http1_request / create_repeater_tab / get_proxy_http_history 等 20+ 工具）。

两种服务都要求软件本体在跑（端口可探活）。桥接状态在安全配置页实时显示（已挂载 N 工具 / 连接中 / 待启用 / 失败），另有「立即挂载」按钮可手动触发。

### 模型怎么知道配了什么

两条通道，都是"改完下一轮生效"，不用重启：

1. **工具面**：MCP server 挂载后，其工具以 `mcp__<server>__<tool>` schema 进每轮模型请求，模型按需调用。
2. **概况文本**：sec-config 注册 `systemPrompt.context`，每轮 prompt 组装时渲染一行当前已配工具 / 服务 / MCP 工具数的 manifest，随上下文喂给模型。配置一变，下一轮自动更新（确定性文本，无变化零开销，secret 不渲染）。

改 yaml 文件本身也一样生效：settings 层热载，不重启。

其他本机工具集成：`dsh-scanner-tools`（扫描器封装）、`dsh-semgrep-audit`（本地 semgrep + 离线规则）、`dsh-hunter`（FOFA / Hunter / Quake 资产狩猎）、`dsh-webshell-mgr`（生成 → 连接 → 命令 / 文件 / 数据库）。

## 插件目录

| 插件 | 职责 |
|---|---|
| dsh-mode-group | 模式选择器 |
| dsh-sec-config | 安全配置：工具路径 / Burp·Yakit / DNSLog / API Key / 改密（保存即桥接 MCP） |
| dsh-stage-gate | 阶段门：产物结构校验、意图台账 |
| dsh-sec-enforce | 执行护栏：报告门 / 写边界 / 高危审批 |
| dsh-route-boost | 逐轮治理信封 |
| dsh-refusal-guard | 拒答自动修复 |
| dsh-auto-advance | 子代理返回后自动推进 |
| dsh-scanner-tools | 本机扫描器封装 |
| dsh-semgrep-audit | semgrep 全量扫描链 |
| dsh-redteam-results | 成果登记与报告导出 |
| dsh-attack-atlas | 攻击面矩阵 |
| dsh-session-pulse | 会话状态面板 |
| dsh-campaign-memory | 战役记忆 |
| dsh-trace-vault | 过程留痕库 |
| dsh-product-subagents | Claude Code / Codex 子代理 |
| dsh-mcp-studio | MCP 工作台 |
| dsh-hunter | FOFA / Hunter / Quake 资产狩猎 |
| dsh-webshell-mgr | Webshell 管理 |

每个插件目录内各有 README，写机制、配置与验证方式。

## 仓库结构

```text
saker/
├── preset/
│   ├── pentest/            # 渗透测试预设：agent.cordis.yml + refs 知识库 + playbook
│   └── code-audit/         # 代码审计预设
├── shared/                 # 两模式共享技能
├── plugins/                # 18 个功能插件，各自 lib/ + README + LICENSE（sec-config 另带 tools/ 内置桥脚本）
├── scripts/pack-all.mjs    # 打包：根包 + 全部插件 tgz（构建产物，clone 后先跑）
├── scripts/install-all.mjs # 安装：按序 add 根包 + 18 插件，幂等可重跑
├── lib/preset-root.js      # 模式注册入口（resolvedRoots，trust=system）
├── cordis.patch.yml        # bundle 加载配置
├── core-patches/           # 宿主层改动说明（登录页 / 品牌 / 改密接口，需改 dsh 源码）
├── LICENSE                 # MIT
└── THIRD_PARTY_NOTICES.md  # 第三方规则集许可声明
```

## 从源码构建

```bash
# 一键打出全部发布物：根包 + 18 个插件 tgz（等效于下面两条手工命令）
node scripts/pack-all.mjs

# 手工等价：
pnpm pack                          # 根包：产出 dsh-saker-<ver>.tgz
(cd plugins/dsh-sec-config && pnpm pack)   # 单插件：产出 dsh-external-dsh-sec-config-<ver>.tgz
```

根包 `files` 只含 `preset/ shared/ lib/ cordis.patch.yml` 与文档，不含 `plugins/` 与 `core-patches/`。`.tgz` 均被 gitignore，clone 后需先 pack 再安装。

维护约定：改动 preset 或任一插件后，重打对应 tgz，并在运行中的宿主上 `dsh plugin add` 重装验证；若同时改到宿主层（登录页、banner、鉴权等），把改动同步写进 `core-patches/` 文档，宿主侧改动需要重建后重启。

## 安全边界

- 仅限授权测试：面向获得授权的渗透测试、代码审计与本地实验。测试前明确目标范围，任何扫描命中、模型判断与复核输出都结合证据二次确认。
- 本地配置与产物可能含 API Key / Token，发布截图或日志前先脱敏；不要把个人 `~/.dsh` 配置提交上来。
- 自有代码 MIT；随附的 semgrep 社区规则（LGPL-2.1 + Commons Clause）、Trail of Bits 规则（AGPL-3.0）等第三方内容遵循各自许可，见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## Roadmap

- 成果库 → 可配置报告模板（HTML / PDF）
- 多目标协同会话拓扑的可视化编排
- 攻击面矩阵 → 覆盖度报告自动导出

## 反馈

功能建议与可复现问题到 [Issues](../../issues) 提交，附 dsh / 插件版本、操作步骤与脱敏日志。涉及凭据、未公开漏洞或真实目标的信息走私下渠道，不要贴公开 Issue。

## License

MIT © 2026 Saker contributors
