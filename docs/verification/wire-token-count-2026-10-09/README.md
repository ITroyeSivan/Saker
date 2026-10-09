# 最终传输请求计数：官方 Desktop 实验与未完成边界

2026-10-09。运行产品 Saker 0.4.99 / redteam-results 1.0.49，官方 Windows dsh Desktop 0.2.0-rc.2。本批为 G5 的计数路线调查及可复核审计工具，没有修改生产插件或交付严格 token 预算。已发布版本仍为 [v0.4.99](https://github.com/ITroyeSivan/Saker/releases/tag/v0.4.99)。

## 结果与实际问题

实际配置的 API-key 路线接受 `https://api.deepseek.com/anthropic/v1/messages/count_tokens` 请求。本地三个短样本的预先输入计数与实际生成 usage 一致；随后在官方 Desktop 捕获三次最终 `/messages` 请求，输入计数同样与原生实际 usage 相符，并与另一条原生共享预算账本逐次、合计核对。这里只证明本批样本的一致性，尚未建立提供方公开承诺的精确计数或可靠上界合同。

| Desktop 实际请求 | 原始字节 | 工具定义数 | 预计输入 | 实际输入，含缓存 | 实际输出 | 实际合计 |
|---|---:|---:|---:|---:|---:|---:|
| 第一轮回复 | 85,927 | 43 | 17,883 | 17,883 | 2 | 17,885 |
| 第二轮、工具调用之前 | 91,011 | 43 | 19,098 | 19,098 | 74 | 19,172 |
| 工具回执后的继续生成 | 92,613 | 43 | 19,477 | 19,477 | 74 | 19,551 |
| 合计 | — | — | — | — | — | **56,608** |

最终请求包含工具定义、系统提示、历史消息、工具结果、推理设置及适配器扩展；不能用只数用户文字的函数替代。原生工具事件确认第二轮实际调用了 `redteam_task action=status`，然后继续生成。用量按本路线的互不重叠 input/cache-read/cache-write 加 output 计算；不能把缓存算作免费或额外重复加到已经含缓存的总输入中。

另一个具体缺口是实际序列化输出上限为 **256,000**。第一轮若按输入加完整输出上限预留，需要 273,883 token，超过此前名义整轮 150,000。实际只输出两 token 不能用作调用前少预留的依据。应先显式约束输出、建立计数可靠边界和每次传输的原子准入，再校准并冻结效果评测预算。

## 实验方法与证据

专用诊断插件仅拦截官方 API 域名、`/messages` 路径及本次专用 sessionId。使用原始序列化 body 先调用计数端点，再发出原始生成请求；只保存 body、摘要、状态码和 usage，不保存认证或其他 HTTP 头。诊断会读取小响应的副本并等待结束，因此增加了计数往返、改变流式展示时序，**不是生产流实现或性能基线**。诊断包还进入宿主插件扩展元数据，不能把本批 body 字节当成未装探针的纯净产品基线。

1. 用三个直接 API 样本验证短文本、Unicode、system/tool 请求：[count-endpoint.json](count-endpoint.json)。这部分没有经过 Desktop 适配器，与下面的原生实验分开。
2. 官方 Desktop 建专用本地会话，从实际任务 API 在生成前设置共享模型调用次数；第一轮只回复收到，第二轮读取现有任务状态。不访问目标、不运行第三方 PoC。原生事件见 [native-events.json](native-events.json)，捕获结果见 [native-wire.json](native-wire.json)，原始请求见 [wire-1.json](wire-1.json)、[wire-2.json](wire-2.json)、[wire-3.json](wire-3.json)。
3. [audit.json](audit.json) 重新核对每个 body 的字节和 SHA-256、模型/推理/输出限制、输入计数与终止 usage，再与独立 [Desktop 任务账本](second-status.json) 的三条结算核对。工具、system、messages、其他 JSON 成员与语法字节分别计量，不将字节估算写成 token 数。
4. 原始诊断实现保留于 [diagnostic-probe.js](diagnostic-probe.js)，用于解释捕获边界。它是历史验收源码，含本批临时路径，已卸载，不是可直接投入生产的预算服务。实际激活 PID/时间见 [probe-activated.json](probe-activated.json)。
5. [credential-scan.json](credential-scan.json) 核对捕获正文未包含当时配置中存储的凭据值；头部未捕获。扫描覆盖的是已存储凭据，不冒称能识别所有未知秘密。仅保存专用合成会话材料，未保存其他用户会话正文。

[controlled-count.json](controlled-count.json) 是额外计数控制，不产生生成请求：相同短文字只改变 thinking 设置，省略/启用为 34，禁用为 8；说明推理设置也是计数输入的一部分。将第一份完整 Desktop body 仅改 `max_tokens` 为 4096，输入仍计为 17883；该变体没有实际生成，不能据此声称已验证输出限制执行或严格预算成功。

原生流程截图见 [desktop-count.png](desktop-count.png)。任务到期后已通过官方 API 取消并归档本次会话、注销专用工作区登记、恢复原选择，保留真实 home 的数据库和会话文件。见 [desktop-cleanup.json](desktop-cleanup.json)。诊断插件已通过官方 CLI 卸载；profile 配置对象与 cordis patch 校验和恢复一致，见 [configuration-restored.json](configuration-restored.json)。

稳定桌面快捷方式重新启动正常官方 Desktop，最终窗口的 MCP 工作台显示 2 启用、2 连接、176 目录工具；保存按钮禁用、未编辑设置，无本批面板错误。见 [截图](desktop-restored-mcp.png) 和 [原生文本](desktop-restored-mcp.txt)。没有调用 Burp/Yakit 的具体工具，不能算 G0 全部能力体检完成。实际 [快捷方式启动记录](normal-launch.json)、[所属进程树关闭记录](normal-stopped.json)、[临时清理记录](cleanup.json) 已保存；5 个自建目录已回收，日常 home 保留，[临时边界检查](temp-boundary.log)通过。另一个同时段出现的零字节临时文件无法确认归属，明确保留，不虚称已清理整个临时目录。

## 可复核命令与反向验证

在仓库目录运行：

```powershell
node scripts/audit-wire-token-count.mjs docs/verification/wire-token-count-2026-10-09 docs/verification/wire-token-count-2026-10-09/audit.json
node scripts/test-wire-token-count.mjs
```

审计不信任 `matches: true`：改计数、改正文摘要、换会话、缺结束事件、缺用量、输出超上限、重复/空捕获、改独立总量或逐次结算、保持总数不变而错分输入/输出、隐藏未知用量、重复账本 ID 均必须失败。真实三次捕获仍通过。结果见 [reverse.log](reverse.log)。这些是审计器的可证伪检查，不是生产硬预算实现的测试成绩。

## 下一步实现合同

目前生产钩子以宿主一次 `llm/stream` 调度预留模型次数，而官方 DeepSeek 适配器可能在一个调度内重传 HTTP 请求。没有将每个实际尝试单独原子准入，不能把调度次数称为实际传输尝试数。

下一批需在最终序列化及所有扩展合并之后绑定请求计数，明确输出限额及模型/路由，保留原子事务的短锁边界；每个可能发出的尝试单独关联父预算，不能在计数网络等待时持有 SQLite 写锁。准备后的请求变化须重新计数，发生未知结果不能释放为零。覆盖计数失败/超时/取消、并发争用、辅助调用、子代理、适配器重试、部分流和进程中断；生命周期卸载不能留下全局拦截或孤儿请求。优先复用宿主适配接口，不把本批全局 fetch 诊断直接变成生产插件。

[六处实际接入位置核对](seam-audit.json)保存了本地参考源码哈希及行号：主/子代理的 `agent/request` 在 `prepareCall` 之前，适合约束输出配置；在 `llm/stream` 才改已准备配置会触发 `INVALID_PREPARED_CALL`。标题与压缩直接调用 `llm.stream`，各有输出配置，单独改 `agent/request` 无法覆盖全树。现有 request extension 提供者只看到 base body；其他扩展的合并及序列化失败回退发生在其后，不能在贡献扩展时签发最终请求证明。该文件是本地参考源码审计，未冒称已经证明打包 Desktop 全部源/字节一致，更未实现新的运行钩子。

严格模式需要有依据的完整输入上界和可靠输出约束，不因少量一致样本而签发 `quality=exact`。不满足计数合同的路由保持明确拒绝或标成估计模式；拒绝本身不等于 G5 已完成。图片/文件上传、账户路由、真实重试、模型漂移和取消均尚未由本批验证。三组公平靶场评测、Nday 依赖链、多角色与其他 G0–G10 继续保留在总清单中。
