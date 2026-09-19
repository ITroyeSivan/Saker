# Saker Burp / Yakit 模型实操验证（2026-09-19）

## 结论

Burp 和 Yakit 两套 MCP 都能被真实模型主动发现、选择并完成实际操作；本轮同时抓到并修复了多个会影响实战的问题：

1. `dsh-skill-browse` 的 zip/tgz 解包仍可能同步阻塞宿主事件循环。
2. `opencode-proxy` 的 SSE 行缓冲修复在后续改动中丢失，真实模型请求会因 keepalive 插进半行 JSON 而报 `Unterminated string in JSON`。
3. `mcp-studio` 的 Yakit HTTP History 工具提示缺少 `includePath/excludePath` 数组类型，模型会误传字符串。
4. `install-all.mjs` 把 profile 相对 `file:` 依赖按 cwd 解析，误判为 dangling；后续安装失败时可能把仍有效的插件留在未安装状态。

## 连接与基础操作

| 通道 | 结果 | 证据 |
|---|---|---|
| Burp MCP | 27 个工具 | `initialize + tools/list` 成功，`base64_encode` 真调用返回 `c2FrZXI=` |
| Yakit MCP | 149 个工具 | `initialize + tools/list` 成功，`auto_decode` 真调用返回 `hello` |
| Burp 请求发送 | 成功 | `send_http1_request` 命中本地合成靶，返回 `SAKER_BURP_OPERATIONAL_MARKER` |
| Yakit 请求发送 | 成功 | `send_http_request_by_url` 命中本地合成靶，返回 `SAKER_YAKIT_OPERATIONAL_MARKER` |
| Yakit 流量查询 | 成功 | 查询刚产生的本地合成流量，记录可回读 |
| 独立操作探针复验 | 成功 | Burp SSE、Yakit streamable-HTTP、Yakit 入库回查三项均为真 |

## 模型行为验证

### 0. 本轮复验：不点名单套工具时的主动选择

测试前把隔离宿主的默认思考强度设为 `low`，从真实请求头确认：

```json
{"provider":"custom","model":"deepseek-flash","reasoningEffort":"low","maxTokens":128000}
```

第一轮提示只描述“当前已挂载的代理类流量测试工具”，没有点名 Burp 或 Yakit。模型先调用：

```text
mcp_search(query="http request proxy burp yakit", limit=30)
```

随后主动选择 Burp：

```text
mcp_call(server="burp", tool="send_http1_request", args={
  targetHostname:"127.0.0.1", targetPort:18080, usesHttps:false,
  content:"GET /saker-proactive-effect?case=burp-yakit-audit HTTP/1.1\r\nHost: 127.0.0.1:18080\r\nConnection: close\r\n\r\n"
})
```

真实响应为 `200`，响应头 `x-saker-marker: SAKER_BURP_YAKIT_EFFECT_MARKER`，body path 为 `/saker-proactive-effect?case=burp-yakit-audit`。

会话：`session-12bed896-f6e8-4a46-8646-5370437c6305`

第二轮提示明确禁止 Burp、shell、curl、扫描器和浏览器，要求使用“另一套代理类工具”，并同时用该工具自己的历史查询刚才的请求。模型自主搜索后选择 Yakit：

```text
mcp_call(server="yakit", tool="do_http_request", args={
  url:"http://127.0.0.1:18080/saker-proactive-effect?case=yakit-model-audit",
  method:"GET", save-packet:true, verbose:true, timeout:15
})
mcp_call(server="yakit", tool="query_http_flow", args={
  sourceType:"all", keyword:"saker-proactive-effect",
  keywordType:"url", full:true, haveBody:true,
  pagination:{page:1,limit:10}
})
```

请求回执包含 `request_sent:true`、`response_received:true`、`status_code:200`、`transport_error:null`。历史查询命中 Yakit Flow ID `17`，库内 request/response 与实时回显一致，证明 MCP 请求流量被真实持久化。

会话：`session-45a6463e-398d-443d-9a84-6f9dc9998ae9`

两轮均为低思考强度；第一轮输出 `1463` tokens、第二轮 `2531` tokens，没有出现工具选择漂移或用 shell 绕过代理工具。

### 1. 不点名工具时主动选择

会话：`session-dffac23e-93ef-4ad8-9358-8e386736d000`

提示只描述“已连接的流量测试工具”，没有点名 Yakit。模型先尝试错误的 fixture server，收到明确失败后主动调用 `mcp_search`，再调用：

```text
mcp_call(server="yakit", tool="send_http_request_by_url",
         args={url:"http://127.0.0.1:18080/saker-proactive-probe?case=yakit", method:"GET"})
```

最终正确返回 `SAKER_MODEL_PROACTIVE_MARKER`。说明 MCP 聚合搜索与失败恢复路径可用。

### 2. 只读历史查询与参数提取

使用修复后的代理运行，会话：`session-d3d070d7-5e09-46d5-971b-699e81772ea9`

模型自主调用：

```text
mcp_search(query="yakit http flow history search")
mcp_call(server="yakit", tool="query_http_flow",
         args={searchURL:"saker-proactive-probe", sourceType:"all", full:true,
               pagination:{page:1, limit:50}})
```

命中 Flow ID 5，正确回答 `case=yakit`，并明确说明全程只读、没有重放请求。这里也验证了 `sourceType:"all"` 提示有效；该记录是 `scan` 来源，只查默认 `mitm` 会漏。

### 3. 限定 Burp 时只走 Burp

会话：`session-8e136b79-7617-4b6e-a653-b8d43227294f`

模型先 `mcp_search`，随后只调用 Burp：

```text
mcp_call(server="burp", tool="send_http1_request")
```

请求带完整 HTTP/1.1 报文，命中 `http://127.0.0.1:18080/saker-burp-effect`，返回 `SAKER_MODEL_PROACTIVE_MARKER`，未绕到 shell、Yakit 或扫描器。

### 4. `includePath` 类型回归

中性任务的修复前会话 `session-a86f08fb-df0b-4c61-80e4-b83c38af57db` 中，模型把路径过滤写成字符串：

```text
query_http_flow({ includePath: "/saker-proactive-effect" })
```

Yakit 返回：

```text
code -32603
invalid argument: 'IncludePath' source data must be an array or slice, got string
```

模型随后自行改成 `["/saker-proactive-effect"]` 并成功，但这类可避免的失败会增加回合和 token。

修复后 `dsh-mcp-studio 1.1.21` 在工具描述最前面明确提示：

```text
sourceType:"all" is required for MCP request flows (mitm misses them);
includePath/excludePath are arrays, not strings.
```

重启隔离宿主后复验：

- `session-d2f1391e-3ff1-435d-b5cc-2d5b0eacac47`：中性任务只调用一次 `mcp_search`，随后 Yakit 请求和历史回查均成功。
- `session-7d6944b4-5537-402c-8404-b7f8b1d6ed0d`：模型按要求直接传 `includePath:["/saker-proactive-effect"]`，命中 Flow ID `21`；没有再次出现类型错误。
- `dsh-mcp-studio` 单测 `66/66` 通过；新增断言要求提示同时保留 `sourceType:"all"` 与 `includePath/excludePath are arrays`。

## `install-all.mjs` 相对路径修复

`pruneDanglingSakerDeps()` 原来直接对 `file:` 去掉前缀后的字符串调用 `existsSync()`，这会按**当前工作目录**解析。profile 中合法的相对依赖（例如 `file:saker(github)/...`）从仓库根运行时因此被误判为 dangling；若随后 `dsh` CLI 不可用，依赖和 bundle 会保持被删状态，插件静默消失。

修复：按 pnpm 的语义改为 `resolve(dirname(profilePkgPath), rawPath)`。

验证：

- `test-install-rollback.mjs` 新增 profile 相对 `file:` 用例，`24/24` 通过。
- 反向验证脚本把旧实现临时放回：新增断言稳定失败，并显示 `pruned 1 dangling dep(s): @dsh-external/dsh-probe`。
- 隔离和真实 profile 再次跑 `install-all.mjs` 均为 `24/24 ok`，没有再误删依赖。

## 根因与修复

### dsh-skill-browse 1.1.9

`zip/tgz` 解包从 `spawnSync` 改为异步子进程，并补上调用处的 `await`，避免 32MB 上限内的归档在解包时冻结宿主。

验证：

- 新实现测试 `63/63` 通过。
- 临时回退为同步 `spawnSync` 后，“解包不阻塞事件循环”断言失败。
- 真实宿主 RPC 安装、列表、卸载 `live-async-skill` 全部成功。
- 源码已同步到真实与隔离 profile，`228 files / 23 plugins` 字节一致。

### opencode-proxy SSE 行缓冲

复现脚本 `test_keepalive_frame_split.py` 在当前源码上稳定复现旧事故：

```text
data: {"id":"...","ob: keepalive
```

机制：上游 SSE 帧被 TCP 从 JSON 中间切开，代理把半行直接转发，随后 keepalive 注释插入半行，客户端 JSON 解析失败。

修复：流式转发只发送到最后一个换行，半行保留在 `pending`，后续 chunk 补齐后再发；心跳仍可在两个完整 SSE 记录之间发出。

验证：

- 旧行为反向验证稳定失败：`解析失败 = 1`，并出现 `ob: keepalive` 指纹。
- 修复后复现脚本：`data` 行解析失败 `0`，污染指纹 `0`，心跳仍生效。
- `test_live_stream_smoke.py`：真上游 `18` 个 `data` 行解析失败 `0`，流正常收尾。
- 用户 `8788` 代理已在无活动连接时按 PID 重启；真实模型再走 8788 查询 Yakit 成功，没有 `Unterminated string in JSON`。

## 当前运行状态

- `opencode-proxy`：`127.0.0.1:8788`，PID `17168`，代码指纹 `2ea760469d96`；
  修复后真实流式请求 `data_parse_fail=0`、无 keepalive 污染。
- Burp MCP：`127.0.0.1:9876`，保持用户实例不动。
- Yakit MCP：`127.0.0.1:11432`，保持用户实例不动。
- CFT、隔离宿主、合成靶机均已关闭。

## 剩余注意项

- 本轮模型测试使用了隔离 `DSH_HOME`，没有读取或修改用户当前会话内容。
- Burp 代理历史为空时，`get_proxy_http_history*` 会正常返回 `Reached end of items`；这不等同于工具失败。
- Yakit 的 `scan` 来源流量必须用 `sourceType:"all"` 才能命中，默认 `mitm` 会漏。
