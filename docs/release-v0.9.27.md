# Saker 0.9.27

### ✨ 新增功能

- 新增 `version_reproduce`：在隔离 VMware + Docker 的 `--network none` 容器中运行 A/B 两个版本命令，记录 exit、stdout/stderr、输出文件和差异。
- `version-reproduction` 模块接入真实隔离后端；工具只在存在 `SAKER_LAB_CONFIG` 时注册。

### 🐛 问题修复

- 复现文件通过 SCP 进入 VM，双版本输出通过 SCP 回传；路径、镜像名和文件路径均做边界校验。
- SSH/Docker 失败、超时和回传失败都明确返回，不把差异当漏洞。

### 🎨 体验优化

- 每个复现运行写 `summary.json`、`stdout.txt`、`stderr.txt`、A/B 输出目录和 evidence-index。
- 结果只显示行为差异，结论仍需模型独立判断。

### ⚠️ 其他变更

- `dsh-scanner-tools` 升到 `1.2.6`，`dsh-tool-scope` 升到 `0.3.9`，结果插件 `1.4.21`，根包 `0.9.27`。
- 不改变用户数据、MCP、会话、知识与个人方法；未发布、未 push、未提交 Git。
