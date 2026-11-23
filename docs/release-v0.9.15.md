# Saker 0.9.15

### ✨ 新增功能

- 无新增模型工具；本版把仍有用的执行硬守卫并入根包统一 guard，并覆盖 Windows PowerShell。

### 🐛 问题修复

- `dsh-sec-enforce` 依赖旧 `gate-log.md` / `operation-state.json` 的报告门和流程门已删除，不再形成第二套状态台账。
- 工作区写入边界、破坏性命令拦截、速率纪律、账号/权限/防火墙/flood 人工审批和全局熔断迁到 `lib/security-guard.js`。
- 守卫同时识别 `bash`、`pwsh`、`powershell`、`cmd` 等 shell；Windows 上的根目录/用户目录递归删除、磁盘破坏操作和本地账号变更不再漏拦。
- 写入 `reports/` 不再要求先过已退役的阶段门；工作区外写入仍会被拒绝并可人工批准。

### 🎨 体验优化

- 退役独立 `dsh-sec-enforce` 插件，减少同一权限被两个 hook 重复判断。
- 旧 `enforce-log.md` 保留只读；新的拒绝记录仍写同一文件，便于连续查看。
- 根包版本升到 `0.9.15`；结果插件保持 `1.4.10`。

### ⚠️ 其他变更

- 产品独立插件降为 10 个。
- 不改变用户数据、MCP、会话、知识与个人方法；不发布、不 push、不提交 Git。
