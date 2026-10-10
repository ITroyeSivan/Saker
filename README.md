# Saker · 猎隼

Saker（猎隼）是基于 [DeepSeek Harness Desktop](https://github.com/deepseek-ai/deepseek-harness) 的 AI 安全测试工作台，面向个人学习与本地实验。通过一个聊天入口使用常规测试、Nday 发现和 0Day 挖掘，按当前问题调用工具、查阅资料、整理证据。

[下载](https://github.com/ITroyeSivan/Saker/releases/latest) · [安装说明](docs/getting-started.md) · [功能说明](docs/features.md) · [插件清单](docs/plugin-list.md) · [问题反馈](https://github.com/ITroyeSivan/Saker/issues)

![Saker 聊天界面：直接设置测试方向、协作方式、进度汇报和子代理人数](docs/media/chat-settings.jpg)

*在聊天框上方设置这次怎么测试、什么时候需要你参与。*

## 使用方式

新建会话选择「Saker 渗透测试」，说明练习目标、具体问题和允许的操作范围，再设置任务方向与额度。

| 模式 | 用途 |
|---|---|
| 常规测试 | 检查接口、权限和业务流程中的常见漏洞 |
| Nday 发现 | 查询产品的公开漏洞，核对版本和触发条件 |
| 0Day 挖掘 | 分析页面、JS、请求和业务逻辑，寻找新的漏洞 |

聊天框上方可直接调整协作方式：共同研判、关键节点确认或自主推进；进度汇报单独设置。提示词提供简短示例，支持编辑、插入、复制和保存个人模板。子代理上限可设置为 0–16，按需创建、同站复用、结束释放。

<details>
<summary>查看提示词示例</summary>

选择手头已有的资料，填写必要信息，再编辑或复制提示词。

![Saker 提示词编辑器：选择示例、填写资料、编辑并插入或复制](docs/media/prompt-editor.jpg)

</details>

常规测试可选择仅当前方向、收集后接 Nday 或与 Nday 一起推进，共用资料、操作额度和截止时间。支持导入请求、流量、JS 和已有扫描结果，保存复现步骤、证据和报告材料。

## 功能

- 工具与 MCP：配置本机扫描、分析工具和 MCP 服务，查看连接状态、可用工具与调用记录。
- 漏洞情报与知识库：管理更新来源，检索产品漏洞，导入 Git 仓库或本机资料。
- 提示词与方法：自定义提示词、技能和测试方法，保存常用模板。
- 进度与发现：集中查看当前任务、最近发现与待补证原因，核对原始记录，整理报告和复现文件。

外部工具及 MCP 服务需要单独安装和配置。

## 安装

当前版本 **0.4.103**，适用于官方 Windows Desktop **0.2.0-rc.2**。

1. 安装官方 Desktop，完成初始化和模型配置，然后完全退出应用。
2. 从 [Releases](https://github.com/ITroyeSivan/Saker/releases/latest) 下载桌面安装包，解压到长期保留的目录。
3. 在解压目录执行，将路径替换为 Desktop 的安装目录：

```powershell
node scripts/install-desktop.mjs --desktop-dir "C:/path/to/DeepSeek Harness"
```

安装器检查全部 22 个包，并创建或刷新桌面的 **Saker (dsh Desktop)** 快捷方式。双击快捷方式启动；更新沿用原来的用户数据与 MCP 配置。请保留解压目录中的 `dist/desktop`。脚本需要 Node.js ≥22.5。

## 项目状态

项目目前处于快速迭代阶段，暂不建议正式使用，仅限个人学习与本地实验。请在自行搭建或明确获授权的环境中使用。

Saker 自有代码采用 [MIT](LICENSE)，随附资料许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。源码构建及贡献方式见 [开发说明](docs/development.md)。
