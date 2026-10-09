### ✨ 新增功能

- 任务开始支持方向、目标、当前问题与工具额度等独立字段，保留旧 policy JSON，禁止混用输入。

### 🐛 问题修复

- 修复进度说明与独立完成标记同时提交时丢失标记的问题；冲突输入拒绝更新。
- 修复成果模块首次导入时 schema 循环初始化错误。
- 成果登记格式错误一次返回完整方法契约与恢复路径，避免模型逐项猜测缺失字段。

### 🎨 体验优化

- 任务参数使用枚举和清楚的字段说明，减少 mode/workflow 猜测；工具说明保持原有长度预算。
- 已有任务继续禁止重启以重置预算，登记成果仍保持待独立复核。

### ⚠️ 其他变更

- Windows 官方 Desktop 0.2.0-rc.2 实际完成任务启动、8 个本地对照请求、独立评分和界面完成；恢复轮成功登记待复核成果。
- 89 套回归、13,626 通过、0 失败、16 跳过；官方编译器验证 20 个实际工具 schema。
- 快捷方式沿用日常数据，MCP 配置保留但两个服务未连接；尚未完成宿主独立验证与交付全流程，未完成 ARTEX 同条件效果比较。

下载桌面安装包后，按 [安装说明](https://github.com/ITroyeSivan/Saker/blob/v0.4.94/docs/getting-started.md) 更新。具体操作、测试结果与限制见 [发布检查](https://github.com/ITroyeSivan/Saker/blob/v0.4.94/docs/verification/task-inputs-2026-10-09/README.md)。另见 [完整目标及剩余工作](https://github.com/ITroyeSivan/Saker/blob/v0.4.94/docs/saker-implementation-progress-2026-10-08.md)。
