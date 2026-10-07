# Saker · 猎隼

Saker 是 [DeepSeek Harness Desktop](https://github.com/deepseek-ai/deepseek-harness) 的安全测试插件集，包含常规测试、Nday 发现、0Day 挖掘，以及工具管理、MCP、漏洞情报和知识库。

![Saker 桌面端功能截图](docs/images/00-hero-collage.png)

[查看单张截图](docs/images/desktop-screenshots-2026-10-04.md)

[下载](https://github.com/ITroyeSivan/Saker/releases/latest) · [安装说明](docs/getting-started.md) · [插件清单](docs/plugin-list.md) · [问题反馈](https://github.com/ITroyeSivan/Saker/issues)

## 测试模式

新建会话选择「Saker 渗透测试」，支持以下三种模式：

| 模式 | 用途 |
|---|---|
| 常规测试 | 检查接口、权限和业务流程中的常见漏洞 |
| Nday 发现 | 查询产品的已公开漏洞，检查版本和触发条件 |
| 0Day 挖掘 | 分析页面、JS、请求和业务逻辑，查找新的漏洞 |

支持导入请求、流量、JS 和已有扫描结果。测试过程中保存分析记录、复现步骤和证据；遇到封禁、账号失效等阻碍会停止并说明原因。子代理按需创建，同站复用，最多两个，结束后释放。

三个模式各有三个可复制示例。常规测试可选择「只做当前模式」「收集后自动接 Nday」「常规与 Nday 同时进行」，子代理上限可选 0、1、2。交互频率可选「仅必要时询问」「阶段汇报，自动继续」「阶段完成后等我确认」，任务开始后也可调整。两方向共用资料、操作预算与截止时间。[查看实际桌面界面与验收](docs/verification/release-0.4.88.md)。

代码审计和 CTF 不再作为独立模式，历史会话仍可查看。

## 功能

- **工具管理**：配置本机工具路径，按需调用扫描和分析工具。
- **MCP 工作台**：管理 MCP 服务，查看连接状态、工具列表和调用日志。
- **漏洞情报**：选择数据源并更新，查看各源进度，单独重试失败的源。
- **知识库**：随包提供安全资料，支持检索和导入资料。
- **技能与方法**：编辑技能、提示词和测试方法，调整调用顺序。
- **任务与成果**：查看任务进度、操作记录和子任务，保存漏洞证据，导出报告及附件。
- **WebShell 管理**：管理脚本、连接和文件操作。

共 24 个功能插件和一个根包，可按需安装。外部工具及 MCP 服务需要单独安装、配置和启动，见[插件清单](docs/plugin-list.md)。

## 安装

当前版本 **0.4.88**，已在 Windows 的官方 Desktop **0.2.0-rc.2** 上测试。其他宿主版本尚未验证。

1. 安装官方 Desktop，完成首次初始化并配置模型，然后完全退出应用。
2. 下载 [Saker-0.4.88-desktop.zip](https://github.com/ITroyeSivan/Saker/releases/download/v0.4.88/Saker-0.4.88-desktop.zip)，解压到长期保留的目录。
3. 在解压目录执行，将路径替换为 Desktop 的实际安装目录：

```powershell
node scripts/install-desktop.mjs --desktop-dir "C:/实际安装目录/DeepSeek Harness"
```

安装脚本会检查全部 25 个包，并创建或刷新桌面的 **Saker (dsh Desktop)** 快捷方式。安装后双击快捷方式启动；更新时沿用原来的用户数据目录。

请保留解压目录中的 `dist/desktop`，已安装插件会引用其中的文件。脚本需要 Node.js ≥22.5；也可在应用的「插件」页手动安装 tgz，先安装功能插件，最后安装根包。源码构建步骤见[安装说明](docs/getting-started.md)。

## 测试记录

桌面测试覆盖任务流程、设置页、插件加载、成果导出和 MCP 调用。记录：[框架测试](docs/verification/framework-desktop-2026-10-03.md)、[功能复测](docs/verification/desktop-healthcheck-2026-10-04.md)、[0.4.88 发布检查](docs/verification/release-0.4.88.md)。

目前的测试不能证明真实目标的漏洞检出率提高。Token 用量随任务变化，Nday 对照测试中用量有所增加。

Saker 自有代码采用 [MIT](LICENSE)，随附资料的许可见[第三方说明](THIRD_PARTY_NOTICES.md)。
