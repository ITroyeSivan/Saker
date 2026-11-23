# Saker 0.9.12

### ✨ 新增功能

- 无新增模型工具；本版继续 T08 清理。

### 🐛 问题修复

- 代码审计技能不再调用已退役的 `gates_list`、`stage_gate`、`operation_*`；覆盖/门禁改由 `audit-coverage-matrix.md`、`surface-map.md`、`audit-chains.md` 文件台账核对。

### 🎨 体验优化

- 退役 `@dsh-external/dsh-stage-gate` 产品包；旧 gate-log/operation-state 只作历史读取，不再作为运行时第二台账。
- 移除 `task-workflow` 工具包和 `stage-gate`/`operation_*` 作用域规则；`tool-scope` 升到 `0.3.4`。
- 产品插件降为 11 个。

### ⚠️ 其他变更

- 根包升级到 `0.9.12`，结果插件保持 `1.4.9`。
- `sec-enforce` 仍保留，统一硬守卫迁移未完成。
- 不改变数据、MCP、会话、知识与个人方法；不发布、不 push、不提交 Git。
