# dsh-sec-config（安全配置中心）

安全平台的统一配置入口。一个「安全配置」设置区管理本机工具路径、服务端点（Burp / Yakit）、DNSLog、API key，并把配置实时交付给 agent：工具路径以 `DSH_TOOL_*` 注入 shell 环境，服务端点自动桥接成 MCP server，运行态工具/MCP 概况随每轮提示词注入模型上下文。

## 配置项

设置页 →「安全配置」（设置区 `sec-config` 命名空间，落盘 `~/.dsh/settings.yaml`）：

| 分组 | 字段 | 说明 |
|---|---|---|
| 工具路径 | `sqlmap / nuclei / dirsearch / fscan / subfinder / httpx / katana / afrog / ffuf / jwt_tool / nmap` | 本机工具绝对路径或命令名 |
| 服务端点 | `burpUrl / yakitUrl` | Burp / Yakit 地址；保存即桥接 MCP（见下） |
| Burp 桥脚本 | `burpBridgeScript` | 可选：覆盖 stdio↔SSE 桥脚本路径（默认用包内副本） |
| DNSLog | `url / token` | OOB 回调平台（如 ceye.io） |
| API Keys | `deepseekKey` 等 | 平台密钥 |
| 模型接入 | `model.mode / listenPort / upstream / sanitize` | 内置本机代理，把 dsh 接上 OpenCode Go 这类网关（见下） |
| 改密表单 | `masterKey / newPassword / confirm` | 变更平台登录密码（master key 签发制，随宿主补丁启用） |

## 交付机制

- **shellEnv 注入**：注册 `DSH_TOOL_<NAME>` 环境变量（值 resolve 自 settings.yaml），每次 shell 调用实时注入；playbook 优先读环境变量、空则回退 PATH。
- **MCP 自动桥接**：`services.burpUrl / yakitUrl` 保存后自动同步为 mcp-studio 的一条 server——Yakit 走 `streamable-http`（自动补 `/mcp`），Burp 走 `stdio` 桥。模型下一轮即可见 `mcp__burp__*` / `mcp__yakit__*` 工具，无需去 MCP 工作台手工添加。前端在地址行显示挂载状态徽章（已挂载 N 工具 / 连接中 / 待启用 / 失败）与「立即挂载」按钮。
- **提示词 manifest**：注册 `systemPrompt.context`（`sec-config-manifest`），每次提示词组装时渲染一份当前已配工具 / 服务端点 / DNSLog / 已挂载 MCP 工具面的清单。配置改动（UI 保存或直接改 yaml，均经 settings 热载）下一轮自动进模型上下文，无需重启；文本确定性，未变化零开销。
- **Burp stdio 桥**：Burp 官方 MCP 扩展跑 legacy SSE（9876），mcp-studio 只支持 stdio / streamable-http，故随包附 `tools/burp-sse-bridge.mjs`（Node 标准库 stdio↔SSE 转发）。解析顺序：`services.burpBridgeScript` 覆盖 → 包内副本 → 空。免 Java、免提取 fat-jar 代理。
- **secret 字段**（`dnslog.token` / `apiKeys.*`）：读取时 redact 为 `***`；空写/`***` 写被忽略（不清空已存值）。

## 模型接入（第三方网关）

OpenCode Go 这类网关要求请求带 `x-opencode-session` 头，而 dsh 没有注入自定义头的入口 ——
直连会直接收到 `400 MissingSessionID`。

**本插件自带一个本机代理**（`lib/model-proxy.js`，纯 Node 标准库）：在宿主进程内起一个
loopback 服务，把 `/v1/*` 原样转发到上游，途中补齐会话头并按需剥掉客户端注入的私有字段。
随插件走，**不依赖任何外部程序** —— 装上即用，不需要另装或手动启动别的东西。

### 两种用法，同一份实现

同一个 `lib/model-proxy.js` 既能被插件在宿主内调用，也能**单独跑起来给任何客户端用**：

```bash
node lib/model-proxy.js --port 8788 --upstream https://opencode.ai/zen/go
# 客户端 base URL 填 http://127.0.0.1:8788/v1，API Key 照原样填（代理原样透传 Authorization）
```

随包附带 Windows 启动器 `tools/model-proxy.cmd`（`bg` 后台 / `stop` 停止 / `help` 参数；
端口与上游可用环境变量 `MODEL_PROXY_PORT` / `MODEL_PROXY_UPSTREAM` 覆盖）。
这一路径是给 **WorkBuddy / Cline / Roo Code / Continue / 各种 OpenAI 兼容 SDK** 这类
「只能填 base url、注入不了自定义头」的客户端准备的 —— 它们和 dsh 卡在同一个问题上。

> 启动器脚本是**纯 ASCII** 的。cmd.exe 按 OEM 代码页（简中即 GBK）读 `.cmd`，
> 写中文注释会变乱码并被当成命令执行 —— 这是个真踩过的坑。

代理做的事：

1. 补 `x-opencode-session` / `User-Agent` / `x-opencode-client` / `x-opencode-project` / `x-opencode-request`
2. 剥私有字段（`agent` / `messageId` / `traceId` / `usage` / `reasoning` / `annotations` 等）——
   不剥上游会回 `400 ... Extra inputs are not permitted`，且对话越长累计越多
3. 原样回传，**包含 SSE 流**（不能整体缓冲，否则边生成边看就没了）
4. 只监听 `127.0.0.1`，不对外暴露

「安全配置 → 模型接入」三档，选定后点「写入配置」：

| 档位 | 写进 provider 的 baseURL |
|---|---|
| 走本机代理（内置，推荐） | `http://127.0.0.1:<listenPort>/v1` |
| 直连上游 | `<upstream>/v1`（dsh 仍会 400，仅供排查） |
| 自定义地址 | 手填 |

**地址只写到 `/v1`。** dsh 会在 baseURL 后自行拼 `/chat/completions`，
多写一层会变成 `/v1/chat/completions/chat/completions`，上游回 404 —— 这是实测踩过的坑。

写入方式是 `settings.mutate` 的 path-ops，只改 `llm-pi-ai.providers.<id>.baseURL`
**一个字段**，不重述也不误删同一命名空间下的其他 provider 与模型列表。
provider 名不存在时会明确拒绝，不会凭空建一个。

面板显示：目标地址 / 当前实际生效值 / 是否一致 / 代理状态（含已转发次数与剥字段数），
并提供「启动 / 停止内置代理」。**测试连通**会对目标地址发一次
`GET <baseURL>/models`（不消耗 token）并回显状态码与耗时。

端口默认 `8788`。若该端口已被别的程序占用（例如你另有一个代理在跑），面板会说明
并显示「已有服务在监听该端口」——此时内置代理让位，直接复用那个服务；
要完全自包含就停掉占用方，或换一个端口。

写完需**重启 dsh** 生效。密钥由 dsh 自己的凭据库提供（`apiKeyEnv` → `~/.dsh/.credentials.yaml`
的 `refs`），本面板不碰密钥；代理对 `Authorization` 头**原样透传**。

## 依赖

- peer：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-shell-env`。
- 「修改密码 / master key」依赖宿主 `browser-auth` 补丁（见仓库根 `core-patches/`）；未打补丁时该表单不可用，其余配置功能正常。
- MCP 桥接写 `mcp-studio` 命名空间，需 mcp-studio 插件在 profile 中安装（缺失时该功能降级、其余正常）。

## 存储

命名空间数据经 `settings` 服务写入 `~/.dsh/settings.yaml`（明文与 mcp-studio 等插件同策略；读取时对 secret 字段做 `***` 脱敏）。
