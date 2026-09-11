<div align="center">

# Saker

**给 DeepSeek Harness 用的安全测试工作台：渗透测试与代码审计的流程、工具、留痕都可替换。**

模块化提示词 · 21 个独立插件 · 自定义工具链 · MCP 接入 · 安全知识库 · WebShell 管理

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness-111827?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![Saker](https://img.shields.io/badge/Saker-v0.2.5-4f46e5?style=flat-square)](https://github.com/ITroyeSivan/Saker)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?style=flat-square&logo=node.js&logoColor=white)](./package.json)
[![License](https://img.shields.io/badge/code-MIT-2563eb?style=flat-square)](./LICENSE)

</div>

![Saker 功能一览](./docs/images/00-hero-collage.png)

## 这是什么

Saker 是 DeepSeek Harness 上的一套安全测试模式包，外加 21 个独立插件。
它不提供扫描器、模型或额度，负责的是「怎么测」这件事：测试流程、攻击面口径、工具接入、过程留痕、成果复核。

跟常见的「AI 渗透测试插件」不同，那些本质是一段写死的提示词——流程、话术、输出格式、工具选择全固化在文本里，装上去是什么样，用起来就永远是什么样。
Saker 把每一层拆成可替换的插件：26 个测试方法的组合和正文能改，覆盖矩阵的列序由你的方法论决定，工具链接哪些由你决定，模式包（persona / playbook）可以整套换掉。

**不做什么：** 不附带商业扫描器、本机 CLI、模型服务或第三方平台额度；不替你获取测试授权；也不做「一键出报告」的托管服务。

## 特性

- **两种作业模式** — 渗透测试（外部打点）/ 代码审计（源码链路），各自有完整流程与产出格式
- **攻击面矩阵** — 覆盖状态落库，拆到「阶段 × 资产 × 漏洞类」，看得见哪里还没测
- **测试方法可编排** — 26 个内置方法可勾选、改正文、存组合，输入框「方法 ▾」一键切
- **工具链自己接** — 本机扫描器 / 任意 MCP 服务 / Claude Code / Codex 子代理，接哪个用哪个
- **WebShell 管理** — 16 种载荷形态生成、连接与文件/数据库操作，库按语言与绕过形式分类
- **知识库随包** — PayloadsAllTheThings 全量文本、方法论手册、Exploit-DB 字段化索引，离线可用
- **成果与证据链** — 每个发现挂证据与复核状态，报告由台账生成，不是让模型现场编
- **跨会话战役记忆** — 战术、指纹、工具可用性、教训可检索，下一场不用从零开始

## 快速开始

### 环境要求

- DeepSeek Harness 已安装，`dsh web` 能正常启动，并已配置可用模型
- Node.js `>= 22.5`（MCP Studio 要求 `^22.19.0 || >= 24.0.0`）
- 用扫描器、Semgrep、Burp、Yakit、Claude Code / Codex 时，需自行安装并配置

### 安装

```bash
git clone https://github.com/ITroyeSivan/Saker.git
cd Saker

node scripts/pack-all.mjs        # 生成根模式包和 21 个插件包
node scripts/install-all.mjs     # 装进 dsh 的 web profile
dsh web                          # 重启宿主
```

`install-all.mjs` 会跳过已是最新的包、升级更高版本，可安全重复执行。

### 确认装好了

进入「设置」，依次点开安全配置 / MCP 工作台 / 知识库 / 技能 / 方法编排 / WebShell，六个面板都应正常加载。
新建会话选择 `pentest` 模式，输入框上方会出现「方法 ▾」入口。

工具探测、MCP 地址、DNSLog 等首次配置见 [安装与首次配置](./docs/getting-started.md)。

## 后续计划

- [x] 适配 DeepSeek Harness `0.1.5-rc.1`（`connection` 注入收窄、路由归属变更）
- [x] 15 套插件测试接入统一测试桩，968 条断言全绿
- [ ] 可配置的 HTML / PDF 报告模板
- [ ] 攻击面覆盖报告一键导出
- [ ] 多目标协作会话的拓扑视图
- [ ] 公开版 DeepSeek Harness 的兼容性验证
- [ ] 插件间版本依赖的兼容性检查

## 文档

| 你想做什么 | 看哪篇 |
|---|---|
| 装起来、跑通第一个任务 | [安装与首次配置](./docs/getting-started.md) |
| 搞清楚每个功能在哪、怎么改成自己的 | [功能说明](./docs/features.md) |
| 了解整体设计与插件分工 | [架构：它是怎么搭起来的](./docs/architecture.md) |
| 查某个插件是干什么的 | [插件清单](./docs/plugin-list.md) |
| 改代码、打包、发版 | [开发与发布](./docs/development.md) |
| 确认能用在哪、哪些结论要人复核 | [边界与执行约束](./docs/boundaries.md) |
| 看这一版改了什么 | [发布说明](./docs/release-v0.2.5.md) |

## 边界与授权

Saker 面向**已获授权**的安全测试、代码审计和本地实验，不负责获取授权。
扫描结果和模型结论都可能误判，涉及真实系统的处置应由安全人员复核。

本地配置与任务产物可能含 API Key、Token、请求报文和源码，公开日志或截图前务必脱敏，不要提交个人的 `.dsh` 目录。
仓库内的 WebShell 管理与资产检索组件仅适用于明确授权范围，默认不应把管理端暴露到公网。

## 反馈与许可

- Bug、功能建议、用法疑问：[GitHub Issues](https://github.com/ITroyeSivan/Saker/issues)（请附 dsh 版本、Saker 版本和复现步骤）
- 作者：[@ITroyeSivan](https://github.com/ITroyeSivan)
- 项目仍在快速迭代，会不定时适配 DSH 最新版本、修问题、优化性能

Saker 自有代码采用 [MIT License](./LICENSE)。随附第三方资料不自动转为 MIT，再分发前请读 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

致谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[dsh-pentest](https://github.com/howmp/dsh-pentest)、[ARTEX](https://github.com/Autumn-27/ARTEX)，以及所有被引用的知识资料、检测规则与安全工具的维护者。
