# Saker 0.9.19

### ✨ 新增功能

- `curation.*`、`knowledge.*`、`account.*` 域端点接入同一 Host scope 校验。
- Workbench 查询/命令会先解析当前会话 scope，并自动附带 `entrySessionId/projectKey/workspaceKey/scopeRevision`，缓存 30 秒。

### 🐛 问题修复

- 不存在的入口会话不再返回空知识/账号列表，统一返回 `SCOPE_MISMATCH`。
- 可选 projectKey/workspaceKey/scopeRevision 与当前会话不一致时明确拒绝。

### 🎨 体验优化

- 域端点继续使用既有 handler，不复制第二套知识/账号服务。
- 结果插件升到 `1.4.14`；根包升到 `0.9.19`。

### ⚠️ 其他变更

- 不改变用户数据、MCP、会话、知识与个人方法；不发布、不 push、不提交 Git。
