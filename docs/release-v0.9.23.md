# Saker 0.9.23

### ✨ 新增功能

- 新增 `seatbelt_posture`：固定调用本机 Seatbelt 只读 `system` 组，拒绝额外参数、远程、用户凭据和浏览器数据组。
- 新增 `ad_export_ingest`：导入 SharpHound/Adalanche JSON，归一化对象、ACL、边和候选路径，写证据原件。
- `host-posture`、`ad-recon`、`ad-path-review` 接入真实适配器；模块矩阵读取进程内已注册工具，不再因工作台受限视图误报缺失。

### 🐛 问题修复

- Pentest preset 的 `exposedTools` 白名单补齐两个新工具。
- `seatbelt_posture` 改为常驻 schema，执行时再解析二进制，避免宿主启动时设置未就绪导致静默跳过。
- 工具登记表只记录真正成功注册的工具；延迟加载的 active-scan 工具不会提前标记。

### 🎨 体验优化

- AD 导入只产出候选观察和证据引用，不把对象属性、ACL 或图边当可利用证明。
- Seatbelt 输出完整落盘，模型只拿封顶预览；本机只读，不修改系统设置。

### ⚠️ 其他变更

- `dsh-scanner-tools` 升到 `1.2.4`，`dsh-tool-scope` 升到 `0.3.7`，结果插件 `1.4.18`，根包 `0.9.23`。
- 不改变用户数据、MCP、会话、知识与个人方法；未发布、未 push、未提交 Git。
