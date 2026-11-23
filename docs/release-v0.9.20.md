# Saker 0.9.20

### ✨ 新增功能

- `protocol-boundary-test` 的 `raw-protocol` 能力映射到现有 `redteam_execution` 原始请求通道。
- `sourcemap-recovery` 支持 `sourcemapper` 或 HTTP+材料路径，不再因单一二进制缺失整体阻塞。

### 🐛 问题修复

- 协议边界模块不再因为不存在的独立 raw-protocol 工具被误判为 blocked。
- Source map 恢复不再把 sourcemapper 当作唯一入口。

### 🎨 体验优化

- 模块矩阵仍按真实 Host schema 动态计算；没有扩大任何目标授权。
- 结果插件升到 `1.4.15`；根包升到 `0.9.20`。

### ⚠️ 其他变更

- 不改变用户数据、MCP、会话、知识与个人方法；不发布、不 push、不提交 Git。
