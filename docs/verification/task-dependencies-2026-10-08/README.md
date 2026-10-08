# 依赖任务的实际验收

版本：Saker 0.4.93；宿主：Windows 官方 DeepSeek Harness Desktop 0.2.0-rc.2。沿用日常 home、用户数据与 MCP 配置。使用官方应用的原生界面和调试接口；不是独立浏览器或 mock 宿主。

## 流程与结果

在 `_ref/tmp` 内建立只含合成本地资料的两步任务：i2 依赖 i1，并要求 i1 登记的 `identity.json` 匹配固定 SHA256。

1. 首次真实模型轮次没有看到 `operation_task`。检查工具过滤与插件状态后，发现新增嵌套 schema 缺少 `additionalProperties`，使 stage-gate 激活失败。原单测使用恒等 schema 桩，漏过此错误。
2. 插件激活修复后，任务包加载将真实请求中的工具从 41 个扩展为 48 个，但两个账本调用被预算守卫误判为目标操作。修正本地工具分类，未放开目标请求守卫。
3. 重跑：`ready` 返回 i1 就绪、i2 等待；`start i2` 返回“等待前置任务 i1（queued）”。磁盘状态中 i2 尝试次数仍为 0。
4. 后续轮次：`start i1` → 宿主 `read identity.json` → 携带租约 `succeed i1` 并登记产物 → `ready` 返回 i2 就绪 → `claim owner=httpx_probe` → 携带 i2 租约结束 → `ready` 返回两个任务 succeeded。
5. 官方“项目工作台”真实展示了等待原因；放行后等待项消失，两个任务显示已完成。目标完成标准与工作方向刻意保持未收口，不能把执行 succeeded 当成漏洞确认或整个项目完成。

[筛选后的原始 Desktop 事件与用量](desktop-events.json)保留失败轮次、实际工具清单、参数、调用、结果及最终状态，不复制整个日常配置或完整会话快照。模型为 Desktop 所选 DeepSeek-V41-Flash，Low。没有真实目标扫描或子代理，领取 httpx 所有者只是队列检查，没有执行 httpx。

工作台改为宿主鉴权 connection RPC，修复直接 fetch 在 Desktop 的空 JSON 响应；避免旧原始路由与同路径 RPC 重复注册。实际宿主 inventory 中 stage-gate 与 tool-scope 均为 active。

## 其他检查

- 标准回归：86 套，13,607 项通过，0 失败，16 跳过。跳过不计为通过。
- 新增依赖行为：11 组，包括真实本地 HTTP 链。未满足依赖时实际请求数为 0；放行后的三步链只发出 1 个请求。这里模型调用为 0，不能算模型效果评测。
- 反向验证：移除启动守卫、包装器拒绝传播、领取条件、稳定键、租约和哈希核验六种变异，均被对应行为断言抓住，生产代码保持不变。
- 官方 Desktop 实际 schema 编译器接受 9 个任务/门禁定义；故意删除嵌套对象开放性字段，明确返回原激活错误。
- 实际 MCP 设置页与宿主 status 一致：2 项启用，0 项连接，0 个工具；Burp、Yakit 均 unreachable。配置保留，尚不能声称这两项服务可调用。

## 边界与剩余验收

本批证明的是任务依赖内核和 Desktop 接入。没有完成 G1 的漏洞效果对照、16 代理压力测试、全树 token 预留、取消传播或完整事件规划。产物哈希证明正文完整性，不证明身份授权、版本适用或漏洞语义。

2026-10-09 补充：最终安装后重新刷新实际 Windows 桌面的 `Saker (dsh Desktop)` 快捷方式，并通过该快捷方式启动官方应用。进程使用原日常 `desktop-data` 和 `.dsh`，未附加调试端口。原生捕获接口连续返回 `foreground window did not report a process id`，因此这次正常启动只确认进程及配置，未声称原生截图验收通过。

随后以同一稳定启动器的调试参数重启官方 Desktop，通过其实际渲染界面检查任务已完成、等待项消失、无空 JSON 错误，并重新打开实际 MCP 设置页：仍为 2 项启用、0 项连接、0 个工具。stage-gate、tool-scope、redteam-results 均 active。[重启检查记录](desktop-restart.json)保留结果。此前已在原生 Desktop 实际操作改动流程；此处调试接口也属于官方应用，不是另外启动的 Web 宿主。

测试进程按已记录的完整路径及父进程关闭；68 项本次生成的临时目录/脚本已送回收站并逐项核对不存在，原有临时目录保留。`node _ref/tools/verify-temp-boundary.mjs` 返回 `TEMP BOUNDARY OK`。日常 home 中由 Desktop 管理的本地验收会话保留，属于沿用日常配置时产生的应用记录，不复制到公开证据中，也未清理其他用户会话。
