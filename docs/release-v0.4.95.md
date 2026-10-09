### ✨ 新增功能

- 任务动态状态进入独立上下文，稳定系统说明要求以最新宿主持久快照为准；旧宿主保留兼容路径。

### 🐛 问题修复

- 修复打开聊天和轮询时自动保存默认任务选择的问题；只有用户明确操作才持久化设置。
- 修复少量任务状态变化触发整份系统说明历史快照的传输浪费，原预算守卫继续强制执行。

### 🎨 体验优化

- 官方 Desktop 实际确认人数 4、启动预算 0/3 和停止 cancelled 同步到模型与界面，预算未重置。
- 第二轮请求 84,620 字节，上版为 95,415 字节；主请求系统说明和工具定义稳定，完整 system 历史快照为 0。

### ⚠️ 其他变更

- Windows 官方 Desktop 0.2.0-rc.2 实际抓获 7 个主请求及 1 个辅助标题请求；91 套回归、13,634 通过、0 失败、16 跳过，三种机制回退触发对应失败。
- 快捷方式更新并实际启动，沿用日常数据；MCP 配置保留但两个服务未连接。
- 状态变化仍追加约 4.8 KB 聚合运行上下文；字节差异不证明稳定 token、费用或漏洞效果改善，G0–G10 整体继续推进。

下载桌面安装包后，按 [安装说明](https://github.com/ITroyeSivan/Saker/blob/v0.4.95/docs/getting-started.md) 更新。具体操作、测试结果与限制见 [发布检查](https://github.com/ITroyeSivan/Saker/blob/v0.4.95/docs/verification/task-prompt-cost-2026-10-09/README.md)。另见 [完整目标及实施进度](https://github.com/ITroyeSivan/Saker/blob/v0.4.95/docs/saker-implementation-progress-2026-10-08.md)。
