# 开发与发布

根包注册预设，功能插件位于 plugins/；preset/ 和 shared/ 提供方法及参考资料，scripts/ 提供打包、安装和检查工具，benchmarks/ 提供合成靶场与评分器。

每个插件包含 package.json、README.md 和 lib/，可选 test/。集中发布时更新根包及受影响插件的版本号，普通提交不逐次递增发布版本。发布文件由 package.json 的 files 白名单控制；桌面交付文档使用显式白名单。

## 构建与安装

```powershell
node scripts/pack-all.mjs
node scripts/install-desktop.mjs --desktop-dir "C:/path/to/DeepSeek Harness"
```

当前适配官方 Windows Desktop 0.2.0-rc.2。安装前完成 desktop profile 初始化并退出应用。安装器调用官方 CLI，核对包内容并刷新桌面快捷方式。DSH_DESKTOP_DIR 可代替安装目录参数；DSH_HOME 可指定独立配置目录。

## 检查

单插件使用统一宿主桩运行：

```powershell
node --import ./scripts/test-stub-register.mjs plugins/<插件目录>/test/run.mjs
node scripts/run-all-tests.mjs
node scripts/check-public-content.mjs
```

外部程序缺失应明确报告跳过。单元检查不能代替官方 Desktop 的实际安装、插件激活、界面流程与 MCP 可用性检查。

## 发布

日常修改先合并到主分支，累积为一批完整改进后再发布。文档、展示图、文案和小幅样式调整通常随下一版本一起交付，不单独创建 Release。常规发布以每周至多一次为参考，没有值得更新的内容或关键流程尚未完成检查时顺延，不为凑频率发版。

只有安全问题、数据损坏、无法启动或主要功能不可用等紧急修复需要提前发布；用户明确要求交付版本时也可单独发布。发布前应能清楚说明用户获得了什么、是否需要升级及如何迁移。历史标签及安装包保留，不因调整节奏删除或覆盖。

更新版本与用户文档，按 [发布格式](release-format.md) 编写说明。打包、安装并在官方 Desktop 检查受影响流程后，构建交付包：

```powershell
node scripts/pack-desktop-release.mjs
```

提交并推送后，使用 scripts/publish-desktop-release.mjs 发布对应版本的 ZIP 和校验文件。内部聊天、工作提示词、个人路径、进度与验收记录应保存在仓库外，不进入源代码、文档或安装包。功能测试仅使用合成或公开许可的样例。

产品展示图保存在 docs/media/，使用当前版本界面，并隐藏会话历史、个人配置和开发信息。清理内部记录时保留这些公开展示图；界面变化后更新对应图片。安装包通过显式文件白名单携带 README 引用的图片。
