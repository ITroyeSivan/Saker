# Saker 0.9.16

### ✨ 新增功能

- 新增内部查询 `scope.resolve`：根据入口会话和可选 workspaceId 返回规范化的 workspaceKey、projectKey、cwd、scopeRevision 与 `resolved`/`legacy-unassigned` 分类。

### 🐛 问题修复

- 不存在的入口会话、缺少可信工作区身份、请求另一个不可访问工作区时明确返回 `SCOPE_MISMATCH`，不再静默回退到随机路径或当前项目。
- 历史 root 的项目归属与当前 Host 工作区不一致时标记 `legacy-unassigned`，只进入显式历史视图。

### 🎨 体验优化

- 结果插件升到 `1.4.11`；根包升到 `0.9.16`。
- `scope.resolve` 不写数据库、不启动模型、不新增轮询。

### ⚠️ 其他变更

- 不改变用户数据、MCP、会话、知识与个人方法；不发布、不 push、不提交 Git。
