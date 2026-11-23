# Saker 0.9.22

日期：2026-11-15

### ✨ 新增功能

- `seatbelt_posture`：调用本机 Seatbelt 的固定只读 `system` 组，采集主机配置线索；拒绝 `extra`、远程、用户凭据和浏览器数据组。
- `ad_export_ingest`：导入 SharpHound/Adalanche JSON，归一化对象、ACL、边和候选路径，写证据文件；不声称已完成采集，也不把图边当可利用。
- 测试模块 `host-posture`、`ad-recon`、`ad-path-review` 现在有真实适配器；能力矩阵按 Host schema 与二进制解析显示。

### 🐛 问题修复

- Seatbelt 只做本机只读配置观察，结果不等于提权。
- AD 导出解析只处理已有 JSON；不自动运行 SharpHound/Adalanche 采集，不把导入的对象或边当漏洞。
- 版本复现仍需要隔离环境；JS 反混淆仍需后续隔离适配。
- A/B 未重跑；未发布、未 push、未 commit。

### 🎨 体验优化

- `dsh-scanner-tools` 定向测试、`module-capabilities`、`tool-scope`、Desktop 工具 schema 编译通过。
- 全量回归在安装前另行执行并记录。

### ⚠️ 其他变更

- `dsh-scanner-tools` 升到 `1.2.3`，`dsh-tool-scope` 升到 `0.3.6`，结果插件 `1.4.17`，根包 `0.9.22`。
- 不改变用户数据、MCP、会话、知识与个人方法。
