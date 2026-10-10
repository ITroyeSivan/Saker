# Saker · 猎隼

Saker 是 [DeepSeek Harness Desktop](https://github.com/deepseek-ai/deepseek-harness) 的安全测试插件集，提供常规测试、Nday 发现、0Day 挖掘，以及工具、MCP、漏洞情报和知识库管理。

[下载](https://github.com/ITroyeSivan/Saker/releases/latest) · [安装说明](docs/getting-started.md) · [功能说明](docs/features.md) · [插件清单](docs/plugin-list.md) · [问题反馈](https://github.com/ITroyeSivan/Saker/issues)

## 使用方式

新建会话选择「Saker 渗透测试」，选择测试方向并说明目标范围、具体问题和操作额度。

| 模式 | 用途 |
|---|---|
| 常规测试 | 检查接口、权限和业务流程中的常见漏洞 |
| Nday 发现 | 查询产品的公开漏洞，核对版本和触发条件 |
| 0Day 挖掘 | 分析页面、JS、请求和业务逻辑，寻找新的漏洞 |

聊天框上方可快速选择共同研判、关键节点确认或自主推进，进度汇报单独设置。提示词支持示例、填空、编辑、插入和复制，个人模板可跨会话复用。子代理上限可设置为 0–16，按需创建、同站复用、结束释放。

常规测试可选择仅当前方向、收集后接 Nday 或与 Nday 一起推进，共用资料、操作额度和截止时间。支持导入请求、流量、JS 和已有扫描结果，保存复现步骤、证据和报告材料。

## 功能

- 工具管理：配置本机工具路径，按需调用扫描和分析工具。
- MCP 工作台：管理服务，查看连接状态、工具列表和调用日志。
- 漏洞情报与知识库：更新来源、检索产品漏洞、导入 Git 或本机资料。
- 技能与方法：编辑提示词、技能和测试方法。
- 任务与成果：查看进度、子任务及操作记录，整理证据并导出材料。

包含 21 个功能插件和一个根包。外部工具及 MCP 服务需要单独安装和配置。AttackAtlas、战役记忆和 WebShell 管理已退出运行包；旧会话数据保留。

## 安装

当前版本 **0.4.102**，适用于官方 Windows Desktop **0.2.0-rc.2**。

1. 安装官方 Desktop，完成初始化和模型配置，然后完全退出应用。
2. 从 [Releases](https://github.com/ITroyeSivan/Saker/releases/latest) 下载桌面安装包，解压到长期保留的目录。
3. 在解压目录执行，将路径替换为 Desktop 的安装目录：

```powershell
node scripts/install-desktop.mjs --desktop-dir "C:/path/to/DeepSeek Harness"
```

安装器检查全部 22 个包，并创建或刷新桌面的 **Saker (dsh Desktop)** 快捷方式。双击快捷方式启动；更新沿用原来的用户数据与 MCP 配置。请保留解压目录中的 `dist/desktop`。脚本需要 Node.js ≥22.5。

## 使用边界

适合学习和有人监督的有限试用。扫描或情报命中是候选线索，确认漏洞仍需复现与证据复核。模型调度次数额度不等同于 HTTP 请求次数或严格 token 总预算，完整严格 token 预算目前不可用。效果基准的工具和协议见 [benchmarks](benchmarks/task-effects/README.md)，不据此声明检出率提升。

Saker 自有代码采用 [MIT](LICENSE)，随附资料许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。源码构建及贡献方式见 [开发说明](docs/development.md)。
