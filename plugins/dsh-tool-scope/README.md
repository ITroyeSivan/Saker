# dsh-tool-scope

按模式收窄全局工具可见性 —— 把各插件**已经声明的模式门禁**前移到「可见性层」。

## 为什么需要它

一轮模型请求里 **工具定义占 67.8%**（实测：101 个工具 / 111.5K 字节，请求体共 164K）。
其中宿主内置只有 29 个，**插件贡献 72 个**。而这里面有一批工具，在**当前模式下本来就调不动**：

| 插件 | 它自己声明的门禁 | 非适用模式下的后果 |
|---|---|---|
| `dsh-webshell-mgr` | `ALLOWED_MODES = ["pentest"]`（lib/index.js:598） | 调用**硬拒绝**：`webshell 工具面仅限渗透测试模式调用` |
| `dsh-ctf-observer` | `MODE_ID = "ctf-solver"`（lib/index.js:42） | 工具准入失败（"只在 ctf-solver 模式生效"） |
| `dsh-redteam-results` / `dsh-campaign-memory` / `dsh-trace-vault` / `dsh-knowledge-hub` | `MODE_IDS = ["pentest","code-audit","ctf-solver"]` | 注入与入库均不生效 |

也就是说：**这些工具的声明在非适用模式下纯占上下文，一丝用处都没有**。
模型看得到、调不动，还替它们付 token。

## 它做什么

会话创建时读当前模式，用**宿主原生的 per-agent 工具过滤**
（`agent.ctx.tools.restrict({ deny })`，见 `packages/core/tools/src/index.ts:1061`）
把当前模式永远用不到的工具从可见性里收掉 —— 模型看不到 = 不进请求体。

思路来自 **BreachWeave 的 `pi-mcp-adapter`**（"别把全部工具声明塞进上下文"），
但落地形态更轻：不造代理层、不加新工具、不改变任何调用语义，
直接复用宿主已有的可见性过滤能力。

此外提供 `tool_pack` 按需入口：只把 **WebShell 管理**这个低频大类默认收起，
进入相应阶段时由模型用 `tool_pack(action=load, pack=webshell)` 加载。工具包只改可见性，
不改变任何工具的行为或权限；基础侦察、记录、报告工具始终常驻。

## 实测收益（每个会话每轮）

| 会话模式 | 隐藏工具 | 省下 |
|---|---|---|
| 渗透测试 | `ctf_*`（4 个） | ~3K |
| **代码审计** | `webshell_*` + `ctf_*`（17 个） | **~13K** |
| CTF 解题 | `webshell_*`（13 个） | ~10K |
| 标准（宿主默认预设） | webshell + ctf + security 组全部命中项 | 视实际加载插件数 |

> 数字取自真实请求体（`docs/reports/02-体检与评估/evidence/真实请求体样本-164K.json`）。

## 纪律

- **只减不增**：只用 `deny`，从不用 `allow`（`allow` 会把未列出的工具全部隐藏，语义危险）。
- **不发明规则**：规则表只收录「插件自己已经声明的门禁」，每条都标注源码依据；
  门禁改了这里必须跟着改 —— `test/run.mjs` 里有**源码契约锁**，漏改会亮红。
- **失败可见**：`restrict` 抛错只 `logger.warn` 并**放行**（宁可多带工具，也不要把工具面改成半截）。
- **可关**：`enable: false` 整体关闭；`rules: { webshell: false }` 逐条关闭。
- **工具包可关**：`packs: { webshell: false, ad: false }` 可让指定包始终常驻。
- **幂等**：同一 agent 只挂一次；`agent/disposed` 时释放过滤器。

## 配置

```yaml
- insert:
    - id: dsh-tool-scope
      name: '@dsh-external/dsh-tool-scope'
      config:
        enable: true      # 总开关
        log: true         # 启动与每次收窄打一行 info
        rules:            # 逐条开关（缺省 = 启用）
          webshell: true
          ctf: true
          security: true
        packs:            # 低频工具包；false = 不收，始终可见
          webshell: true
```

## 不做什么

- 默认只收起上表列出的低频包；未进入 `packs.js` 的无门禁工具原样保留，
  避免替产品擅自砍掉核心扫描器与阶段门禁。
- 不改任何工具的**行为**，只改「模型能不能看见它」。
- 不做 MCP 工具的收窄（那是 `dsh-mcp-studio` 的 `exposure` / `proxyThreshold` 职责）。
