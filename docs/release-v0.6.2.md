# Saker 0.6.2

本版适配官方 DeepSeek Harness Desktop **0.2.2-rc.1**。新版宿主将 Node.js 最低版本提高到 **24.9**，并调整了 Session Projection、工具限制和宿主插件服务；本版已完成对应迁移，同时保留旧 Desktop 兼容。

### ✨ 新增功能

- 支持官方 DeepSeek Harness Desktop **0.2.2-rc.1**，安装器与插件清单同步更新。
- 自由测试、案例测试和比赛模式继续共用统一入口；MCP、模型、账号、会话和历史记录沿用原配置。

### 🐛 问题修复

- 迁移 Session Projection 读取：优先使用 `agents.turnBoundaryOf()`，不再依赖已弃用的 `sessionProjections.stateOf(session, key)`。
- 适配 `tools.restrict()` 的 0.2.2 规则：只限制全局可限制工具，排除保留的 `run_code` 传输名，并读取宿主的 `restrictableNames`，避免工具包收窄失效或插件初始化失败。
- 移除 `dsh-hunter`、`dsh-stage-gate`、`dsh-session-pulse` 对已不存在 `webRuntime` 服务的硬依赖，恢复插件激活和项目状态通道。
- 修正 Saker 接口前缀探测、空会话场景读取及比赛模式用量请求，避免无意义的 4xx 和界面错误提示。
- 保留退役插件迁移，不删除用户的历史数据库、项目材料、账号和 MCP 配置。

### 🎨 体验优化

- 检查表继续使用限宽、限高的弹窗；长说明、详情和请求原文保持可读。
- 比赛模式不再展示不适用于该场景的渗透测试用量行。
- 工具包按 0.2.2 的真实可限制工具集收起；自由测试静态工具面从 39 项降到 26 项。

### ⚠️ 其他变更

- 需要 Node.js **24.9 及以上版本**；Desktop 0.2.2 自身也要求同一运行时。
- 更新沿用日常 home 和 `desktop-data`，安装前自动备份 profile 配置；保留 `dist/desktop`。
- Burp/Yakit MCP 配置仍保留，但其本地端口是否在线取决于用户自己的服务；本版不把“配置存在”当作“服务已连接”。
- 本轮使用合成本地夹具和隔离宿主验证，没有新增真实目标漏洞检出率、GPU 吞吐或付费模型效果结论。
- 全量回归通过。官方 0.2.2-rc.1 隔离运行完成了自然续接、三轮缺文档、助手本地执行、工具作用域和项目状态通道检查；正式 Desktop 检查了结果页、检查表弹窗及设置/提示词面板。
