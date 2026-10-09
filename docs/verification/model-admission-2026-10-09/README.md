# 共享模型调用预算：官方 Desktop 验收与边界

2026-10-09。Saker 0.4.99 / redteam-results 1.0.49；宿主为 Windows 官方 dsh Desktop 0.2.0-rc.2。当前工作区和安装的实际字节为依据。本批为 G5 的部分交付，完整 G0–G10 继续保留。

## 问题与实现

此前只有目标操作/时间限制和事后会话统计；单次生成就可超过名义 token 额度。现在在真实 `llm/stream` 调度前以 SQLite 事务预留共享模型调用次数，发出前写入标记，完成后按原生用量结算。所属子代理沿主任务当前轮次计账；标题和压缩等辅助目的也经过相同钩子。账本不存提示词、凭据或模型输出。

缺用量或流中断保留未知，只有未发出预留可以释放。正常卸载等待活跃生成收尾；重启仅在旧 PID 确实不存在时恢复该运行实例，未知成本不清零。PID 存活/复用、检查权限失败或旧记录缺 owner 时保持未结算，不能靠超时判定已停止。

严格 token 的预留接口要求请求摘要、路线/模型、计数版本及覆盖完整调度的可靠计数证明。当前生产路线没有接入此计数服务；拒绝请求是正确边界，尚不能完成严格 token 的可执行成功路径。未在普通 UI 或公开工具参数中提供该 token 功能。

## 实际 Desktop 流程

建立专用本地目录/会话，保留日常 home、模型与 MCP 配置。初始化和补充请求使用 Desktop 自带 RPC；真实表单操作使用 Windows Computer Use 和 Desktop 调试接口，不使用 web/headless 宿主替代。

1. 空白聊天打开“设置 → 开始任务与预算”，填写仅回复收到、不调用工具和目标的问题；设模型次数 1、worker 0。实际表单点击开始，在首次生成之前保存政策。
2. 真实生成返回“收到”，账本 1 次、17,876 token（含缓存）。追加请求后出现 `TASK_MODEL_BUDGET`，账本仍只有同一已结算调用，任务停止并显示共享额度耗尽。
3. 另一真实会话设置 2 次额度，自动标题未被禁用：主生成 17,889 token、标题生成 176 token；共享账本为 2 次、18,065 token。原会话事件统计只含主生成，两者按不同统计范围展示。
4. 单独会话从 Desktop 任务 API 设置 100 token 严格额度；真实路线因缺可靠计数拒绝，账本 0 次。原生会话有被拒绝的生成记录及未知 usage，不把这种生成记录计作提供方调用。

[native-proof.json](native-proof.json) 包含三会话政策、真实调用账本、筛选后的原生事件与配置保护结果。[round-after-exhaust.json](round-after-exhaust.json) 与 [aux-and-strict-result.json](aux-and-strict-result.json) 为实际 RPC 返回。[桌面拦截截图](desktop-budget-denial.png) 展示可见原因。

MCP 状态为 2 启用、2 连接、176 个目录工具；实际设置页保存禁用、未编辑。见 [状态](mcp-status.json) 与 [设置截图](desktop-mcp.png)。本批未调用 Burp/Yakit 的具体工具，不能因此宣称 G0 的全部工具体检完成。

## 测试与反向证据

[model-budget.log](model-budget.log)：12 项行为通过，含主/子共享、预留和实际结算、取消、未知用量、计数证书、冲突结算、8 个连接同时争抢 3 次额度、真实退出进程恢复、卸载等待及实际 Desktop RPC 能力检查。

[reverse.log](reverse.log)：取消调用次数拦截、未知按零、删除 token 占用、信任普通估计四个缺陷变体，均导致对应行为断言失败。临时变体不修改生产文件，执行完自动清理。

[task-ui.log](task-ui.log) 为 25 项界面业务回归；它不能替代上述 Desktop 流程。

[regression-final.log](regression-final.log) 为 102 套完整回归，13,690 通过、1 失败、16 跳过。唯一失败是正在更新的 `client.js` 与此前 tgz 不一致；最终重打包并安装后，原检查 [hygiene-final.log](hygiene-final.log) 的 7 项全部通过。未把这次失败改写成完整回归全绿。

最终官方安装校验 22 个生产包，并刷新真实 Windows Desktop 快捷方式。[restart-proof.json](restart-proof.json) 确认最终源码摘要、重启后调用数 1/2/0 和用量一致，日常 dsh 配置、MCP 配置文件哈希及依赖名称保留，仅 root/redteam 两项依赖更新。

从实际 `.lnk` 正常启动当前 Desktop，没有调试参数，沿用原日常 home 和用户数据。原生窗口点击“任务与成果”显示“共享模型调用 1/1；剩余 0 次”及停止原因，没有 slot 渲染错误；见 [重启截图](desktop-restart.png) 和 [实际控件](desktop-restart-ui.txt)。

## 收尾与发布保护

验收结束后通过官方 Desktop RPC 归档本次四个会话、移除临时工作区登记、恢复原会话选择；只改登记，不删除日常 home 的会话和数据库。见 [Desktop 清理回执](desktop-cleanup.json)。本次确认归属的 Desktop 进程树已关闭，[MCP 再检查](mcp-after-cleanup.json)仍为 2 启用、2 连接、176 个目录工具，用户的独立服务保留。[快捷方式](shortcut-proof.json)记录稳定启动器、日常配置与正常启动证据。

本次完整回归和 Desktop 留下的 59 个临时目录共 94 个文件已按明确范围送入回收站，包括临时配置快照；其他较早或无法归属的临时状态保留。见 [清理记录](temp-cleanup.json)和 [边界检查](temp-boundary.log)。关键验收资料保留在本文目录，临时脚本未进入发布包。

发布工具 `scripts/publish-desktop-release.mjs` 要求已推送且干净的对应提交，核对 tag、版本与 ZIP 名称，先准备 draft、上传并校验 ZIP/校验和，再公开发布。已有附件不得静默替换；上传中断保留 draft 供核实后续接。此保护不能替代生产功能验收。

v0.4.99 已发布，tag 指向 `de60b41eb6b4bab0bf1090a49745b88dd261a6b4`。ZIP 为 25,048,259 字节，远端 SHA-256 与本地一致；[发布后回执](release-receipt.json)记录公开下载链接。该回执在打包和发布后产生，仅补入源码证据目录，不反向更换已发布 ZIP。

## 未完成范围

- 生产路线精确/可信上界计数、完整硬 token 成功路径及实际金额预算尚未完成。
- 当前限制的是宿主 LLM 调度；适配器内部 HTTP 重试不能据此称为逐 HTTP 尝试限额。
- 用户在首轮前用任务表单启动时可覆盖首轮；从普通聊天让模型首次调用工具创建任务时，该次设置生成已经开始，覆盖缺口仍在。
- 子代理/压缩/竞争/崩溃的行为测试不能冒充完整真实 Desktop 同站多角色或模型断流恢复验收。
- 未完成公平三组评测、多漏洞类别扩展、Nday/依赖/独立复测闭环、知识质量、性能及并发阶梯与 10 次完整试用。没有成本或检出率改善的对照结论。
