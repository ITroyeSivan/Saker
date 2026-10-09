### ✨ 新增功能

- 多步任务可登记前置任务与固定哈希的产物条件，宿主只领取就绪任务。
- 稳定任务键避免重复登记，执行租约拒绝旧执行者提交；无依赖历史任务保留原语义。
- 渗透模式可通过 tool_pack load task-workflow 按需加载任务工具。

### 🐛 问题修复

- 修复 Desktop 项目工作台空 JSON 响应与工具 schema 导致插件激活失败的问题。
- 修复本地账本操作被任务预算守卫误拦的问题。

### 🎨 体验优化

- 前置未完成时拒绝启动并显示等待原因，完成前置产物后可领取并继续。

### ⚠️ 其他变更

- Windows 官方 Desktop 0.2.0-rc.2 实际跑通「等待 → 前置产物登记 → 领取 → 完成」。
- 86 套标准回归、13,607 通过、0 失败、16 跳过；六种机制回退的反向验证通过。
- 快捷方式沿用日常配置和数据，MCP 配置保留但两个服务未连接；本轮不是漏洞检出率或高并发性能验证。

下载桌面安装包后，按 [安装说明](https://github.com/ITroyeSivan/Saker/blob/v0.4.93/docs/getting-started.md) 更新。具体操作、测试结果与限制见 [发布检查](https://github.com/ITroyeSivan/Saker/blob/v0.4.93/docs/verification/task-dependencies-2026-10-08/README.md)。另见 [完整目标及实施进度](https://github.com/ITroyeSivan/Saker/blob/v0.4.93/docs/saker-implementation-progress-2026-10-08.md)。
