# Saker v0.3.1

## 兼容

- 适配 dsh `0.1.6-alpha.1` 的 PTC workflow provider 更名。
- 渗透测试、代码审计、CTF 三个 agent preset 的 workflow provider 从已删除的
  `@deepseek-ai/dsh-workflow-worker-thread` 迁移为 `@deepseek-ai/dsh-workflow-ptc`；
  挂载仍留在 preset 自己的 `workflowEngine` isolate 内，供 `workflow` / `ralph`
  在 agent 作用域内解析。
- 保留对 dsh `0.1.5-rc.1` 的兼容性；本次只移除对已淘汰 provider 的重复挂载。
- `dsh-mcp-studio` 升到 `1.1.12`，修复 proxy/hybrid 通道退出后在 catalog TTL 内不重开的问题，
  并把开发依赖明确锁到 dsh `0.1.6-alpha.1`。

## 验证

- 全仓插件测试、仓库级不变量、安装回滚、工具描述预算与宿主 preset 引用门禁通过
  （24 套 · 1643 ok / 0 fail / 17 skip）。
- 在真实 dsh `0.1.6-alpha.1` 宿主上验证三个 preset 可挂载，模型可正常调用
  `workflow` 工具。
