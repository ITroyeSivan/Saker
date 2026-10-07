# 聊天协作设置实际验收（0.4.90）

日期：2026-10-07。宿主为官方 dsh Desktop 0.2.0-rc.2，使用日常 Desktop 配置与用户数据。Saker 0.4.90、成果插件1.0.41、模式插件1.0.6。以下桌面结果来自官方 Electron 窗口、原生 UI 操作及其调试接口；构建与单测只作为补充证据。

## 实际桌面结果

| 流程 | 实际结果与证据 |
|---|---|
| 聊天入口与外观 | 原生窗口可见方向、协作方式、子代理、写提示词、设置；编辑区有高度限制，检查浅色和深色后恢复「跟随系统」。[浅色入口](chat-cooperation-2026-10-07/compact-chat-toolbar.png)、[设置](chat-cooperation-2026-10-07/cooperation-settings.png)、[提示词](chat-cooperation-2026-10-07/prompt-editor.png)、[深色设置](chat-cooperation-2026-10-07/dark-cooperation-settings.png) |
| 协作与汇报独立 | 三种协作方式×两种汇报方式共六种组合，经真实桌面控件提交并读回；自定义3和16可保存，17被拒绝并显示错误。[记录](chat-cooperation-2026-10-07/preferences-proof.json) |
| 共同研判等待与继续 | 合成任务选择「共同研判＋结束时汇总」，实际模型仍在常规→Nday节点等待。等待时改汇报量和人数，原等待、起始时间、额度及截止时间保留。原生输入框补充标记 POLISH-0701，点击「按当前思路继续」后实际用户消息及模型结果包含该思路，流程完成。[等待](chat-cooperation-2026-10-07/guided-wait.json)、[等待时设置](chat-cooperation-2026-10-07/guided-settings-while-waiting.json)、[消息证据](chat-cooperation-2026-10-07/guided-transcript-proof.json)、[完成](chat-cooperation-2026-10-07/guided-complete.json)、[界面](chat-cooperation-2026-10-07/guided-human-decision.png) |
| 原生子代理超过旧上限 | 真实宿主接纳3个不同合成站点子任务；第三次接纳时三者均为running，峰值active=3。子任务继承父任务协作/汇报方式，人数上限为0，不嵌套分派；随后全部释放，收尾时无活动子任务。[原始接纳与继承记录](chat-cooperation-2026-10-07/three-native-workers.json) |
| 插件激活 | Saker 2/2、成果1/1、模式1/1均运行，slot错误0。[记录](chat-cooperation-2026-10-07/plugin-activation.json) |
| 实际 MCP 配置 | Burp、Yakit两份配置存在并启用，桥接方式和地址保留。当前连接0、工具0；没有验证实际业务调用。[记录](chat-cooperation-2026-10-07/mcp-proof.json) |
| 实际桌面快捷方式 | 刷新用户桌面「Saker (dsh Desktop)」，其稳定启动器指向当前官方 Desktop、原日常home及user-data目录；关闭自建调试实例后实际启动该快捷方式，原生窗口出现新版聊天控件，无需登录。[记录](chat-cooperation-2026-10-07/shortcut-proof.json) |

## 补充检查

- 25个包构建成功；安装同步检查为24个插件、2,310个文件、0差异。
- 与上一版相同的81套常规回归：13,559项通过、0失败、16跳过。15项因缺上游文件，1项因无PHP环境。[逐套记录](chat-cooperation-2026-10-07/regression.json)、[汇总](chat-cooperation-2026-10-07/regression.txt)。
- 本次三项反向检查分别恢复「只有confirm会等待」、旧上限2、「只显示末8个代理」，对应行为断言均失败；恢复新版后针对界面的24项通过。[可证伪记录](chat-cooperation-2026-10-07/reverse-proof.json)。
- 额外执行的历史跨模块 `test-nday-planning-reverse.mjs` **未通过**：首个旧锚点失效；排查还发现冗余分支变异不改变行为。47项检查之后进程退出1，不能计为整套成功。该脚本源码保持原状；不影响上面本次三项独立反向结果。[初始失败日志](chat-cooperation-2026-10-07/historical-reverse-unresolved.log)。

## 验证边界与收尾

本轮使用离线合成材料和 `.invalid` 站点标签，没有进行外部目标安全测试。子代理验收期间主代理实际读取了工作区源码并执行本地命令；首轮选错目标被范围检查拒绝，后续另开合成任务获得上述三代理接纳证据。结论只覆盖人数接纳、继承和生命周期，不证明漏洞发现能力或子任务材料语义正确。

16是可保存、可校验的设置上限，尚未做16代理同时运行的压力测试；没有验证窄窗口布局。实际MCP业务服务未连接，不能将配置保留等同于工具可用。

验收工作区注册已移除，仅清除了本轮三个验收会话中的提示词草稿；会话历史、任务记录及用户数据保留，全局默认仍为空。[草稿收尾](chat-cooperation-2026-10-07/cleanup-owned-drafts.json)。测试结束后关闭仅本轮启动的 Desktop 进程；日常入口仍为桌面快捷方式。

[设计与参考方法对应关系](../chat-cooperation-design-2026-10-07.md)
