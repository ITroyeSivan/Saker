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
| 改密表单 | `masterKey / newPassword / confirm` | 变更平台登录密码（master key 签发制，随宿主补丁启用） |

## 交付机制

- **shellEnv 注入**：注册 `DSH_TOOL_<NAME>` 环境变量（值 resolve 自 settings.yaml），每次 shell 调用实时注入；playbook 优先读环境变量、空则回退 PATH。
- **MCP 自动桥接**：`services.burpUrl / yakitUrl` 保存后自动同步为 mcp-studio 的一条 server——Yakit 走 `streamable-http`（自动补 `/mcp`），Burp 走 `stdio` 桥。模型下一轮即可见 `mcp__burp__*` / `mcp__yakit__*` 工具，无需去 MCP 工作台手工添加。前端在地址行显示挂载状态徽章（已挂载 N 工具 / 连接中 / 待启用 / 失败）与「立即挂载」按钮。
- **提示词 manifest**：注册 `systemPrompt.context`（`sec-config-manifest`），每次提示词组装时渲染一份当前已配工具 / 服务端点 / DNSLog / 已挂载 MCP 工具面的清单。配置改动（UI 保存或直接改 yaml，均经 settings 热载）下一轮自动进模型上下文，无需重启；文本确定性，未变化零开销。
- **Burp stdio 桥**：Burp 官方 MCP 扩展跑 legacy SSE（9876），mcp-studio 只支持 stdio / streamable-http，故随包附 `tools/burp-sse-bridge.mjs`（Node 标准库 stdio↔SSE 转发）。解析顺序：`services.burpBridgeScript` 覆盖 → 包内副本 → 空。免 Java、免提取 fat-jar 代理。
- **secret 字段**（`dnslog.token` / `apiKeys.*`）：读取时 redact 为 `***`；空写/`***` 写被忽略（不清空已存值）。

## 依赖

- peer：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-shell-env`。
- 「修改密码 / master key」依赖宿主 `browser-auth` 补丁（见仓库根 `core-patches/`）；未打补丁时该表单不可用，其余配置功能正常。
- MCP 桥接写 `mcp-studio` 命名空间，需 mcp-studio 插件在 profile 中安装（缺失时该功能降级、其余正常）。

## 存储

命名空间数据经 `settings` 服务写入 `~/.dsh/settings.yaml`（明文与 mcp-studio 等插件同策略；读取时对 secret 字段做 `***` 脱敏）。
