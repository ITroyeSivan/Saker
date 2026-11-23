# Saker 0.9.26

### ✨ 新增功能

- 延续 0.9.25 的 `js_deobfuscate` / webcrack 适配器。

### 🐛 问题修复

- 桌面启动器显式注入 `SAKER_NODE`，Node CLI 子进程不再误用 Electron 可执行文件。
- Windows `.cmd` 包装器解析到真实 JS 入口后，使用真正的 `node.exe` 启动。

### 🎨 体验优化

- webcrack 在真实 Desktop 中可稳定处理工作区 JS，输入/输出 hash 与产物可追溯。

### ⚠️ 其他变更

- 根包升到 `0.9.26`；results `1.4.20`、scanner-tools `1.2.5`、tool-scope `0.3.8` 不变。
- 不改变用户数据、MCP、会话、知识与个人方法；未发布、未 push、未提交 Git。
