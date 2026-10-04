# Saker v0.4.65

发布日期：2026-09-29

## 变更

- 适配 DeepSeek Harness `0.2.0-rc.1`：放宽 MCP Studio 与安全配置对 `dsh-mcp-client` / `dsh-settings` 的 peer 版本范围，继续兼容 `0.1.7-rc.2`。
- 适配 0.2 桌面端安装边界：`profiles/desktop` 由 Electron 独占，CLI 安装会拒绝；文档改为使用打包后的 tgz 经桌面端插件页安装。
- 修复 `dsh-mode-group` 在 0.2 新会话 Provider binding 下预设选择不落地的问题；现在会从主视图保留的空白会话应用 staged preset。
- `dsh-mode-group` 升级到 `1.0.4`，根包升级到 `0.4.65`。

## 验证

- Saker 源码全量回归：47 套，13,247 通过、0 失败、16 跳过。
- 25 个包的 peer 矩阵同时满足 `0.1.7-rc.2` 与 `0.2.0-rc.1`。
- v0.2 桌面端真实 Electron 运行：25 个包安装，设置页 12/12 分区加载，无 slot error。
- `Saker 渗透测试` 新会话请求工具面 61 个，包含 `nday_*`、`knowledge_*`、`redteam_finding_*`、`stage_gate`、扫描器入口与 `tool_pack`。
- `Saker 代码审计` 新会话请求工具面 45 个，包含 `semgrep_scan`、`stage_gate` 与代码审计相关工具。
- 桌面端插件页 25 个包中 21 个独立 bundle 运行中；`dsh-session-pulse` 按设计默认停用，三个 preset-plane 包不提供独立 bundle 组件。
