# Saker 0.9.18

### ✨ 新增功能

- `workbench.query` / `workbench.command` 在上下文带真实 Host 会话时，统一核对 root 的项目归属和可选 scopeRevision。
- `root.start` 会把当前 workspace 的 projectKey 写入业务 root，后续查询可直接核对。

### 🐛 问题修复

- 旧 root 的 projectKey 为空时，从该 root 的真实 Host 会话回退计算，避免历史数据绕过跨项目检查。
- 跨项目 root 查询不再返回数据，统一返回 `SCOPE_MISMATCH`。
- 传入过期 scopeRevision 时明确要求刷新，不静默读取旧项目。

### 🎨 体验优化

- 业务 root UUID 不会被误当成 Host 会话；现有 root 路由保持兼容。
- 结果插件升到 `1.4.13`；根包升到 `0.9.18`。

### ⚠️ 其他变更

- 不改变用户数据、MCP、会话、知识与个人方法；不发布、不 push、不提交 Git。
