# Saker 0.9.25

### ✨ 新增功能

- 新增 `js_deobfuscate`：用 webcrack 静态解包/反混淆工作区 JS/JSX，输出文件、输入/输出 SHA256 与总结落盘。
- `js-deobfuscation` 模块接入真实 webcrack 适配器；不执行目标代码，不加载远程插件。

### 🐛 问题修复

- Windows Node CLI 的 `.cmd` 包装器现在可解析到实际 JS 入口，webcrack 不再因扩展名和无扩展名 shim 被误判。
- 工具根解析只接受 Windows 可执行扩展的 shim，避免把 Unix shell shim 当成本机程序。

### 🎨 体验优化

- JS 处理结果完整落盘，模型只拿摘要和可定位产物；失败保留总结、原件 hash 和 stderr 预览。

### ⚠️ 其他变更

- `dsh-scanner-tools` 升到 `1.2.5`，`dsh-tool-scope` 升到 `0.3.8`，结果插件 `1.4.20`，根包 `0.9.25`。
- 不改变用户数据、MCP、会话、知识与个人方法；未发布、未 push、未提交 Git。
