# Saker 0.2.6

Saker 攻防平台（猎隼）0.2.6 版本。本轮从 0.2.5 起累计 **3 个提交**，核心是给 `dsh-sec-config`
加了一个**内置的模型接入代理**——让 dsh 能接上 OpenCode Go 这类要求自定义请求头的网关，
不需要用户额外装或手动启动任何东西。附带把 README 重写为简介、详述下沉到 `docs/`。

> 验证环境：DeepSeek Harness `0.1.5-rc.1-183f08e` · Node.js `>=22.5`

---

## 一、新增：内置模型接入代理

### 问题

OpenCode Go 档位的端点要求请求头带 `x-opencode-session`（纯「存在且非空」校验，
值不参与认证），缺失就直接回：

```
HTTP 400  {"error":{"type":"MissingSessionID", ...}}
```

而 dsh 的模型配置**没有注入自定义请求头的入口**。同类客户端（WorkBuddy / Cline /
Roo Code / Continue / 各种 OpenAI 兼容 SDK）卡在同一个问题上。

### 做法

`dsh-sec-config` 自带一个本机代理（`lib/model-proxy.js`，**纯 Node 标准库，零依赖**）：
在宿主进程内起一个 loopback 服务，把 `/v1/*` 原样转发到上游，途中补齐会话头，
并按需剥掉客户端注入的私有字段。**随插件走，不依赖任何外部程序。**

代理做的事：

1. 补 `x-opencode-session` / `User-Agent` / `x-opencode-client` / `x-opencode-project` / `x-opencode-request`
2. 剥私有字段（`agent` / `messageId` / `traceId` / `usage` / `reasoning` / `annotations` 等）——
   不剥上游会回 `400 ... Extra inputs are not permitted`，且**对话越长累计越多**
3. **原样回传，包含 SSE 流**（不能整体缓冲，否则边生成边看就没了）
4. 只监听 `127.0.0.1`

### 界面

设置 → 安全配置 →「模型接入（OpenCode Go）」，三档，选定后点「写入配置」：

| 档位 | 写进 provider 的 baseURL |
|---|---|
| 走本机代理（内置，推荐） | `http://127.0.0.1:<listenPort>/v1` |
| 直连上游 | `<upstream>/v1`（dsh 仍会 400，仅供排查） |
| 自定义地址 | 手填 |

面板显示：目标地址 / 当前实际生效值 / 是否一致 / 代理状态（含已转发次数与剥字段数），
并提供「启动 / 停止内置代理」与「测试连通」（对 `/models` 发一次请求，不消耗 token）。

### 两种用法，同一份实现

同一个 `lib/model-proxy.js` 也能**单独跑起来给任何客户端用**：

```bash
node lib/model-proxy.js --port 8788 --upstream https://opencode.ai/zen/go
```

随包附带 Windows 启动器 `tools/model-proxy.cmd`（`bg` 后台 / `stop` 停止 / `help` 参数）。
这一路径是给「只能填 base url、注入不了自定义头」的客户端准备的。

> 启动器脚本是**纯 ASCII** 的。cmd.exe 按 OEM 代码页读 `.cmd`，写中文注释会变乱码
> 并被当成命令逐行执行 —— 这是实测踩过的坑。

---

## 二、修掉的坑（都值得记一笔）

| 坑 | 现象 | 修法 |
|---|---|---|
| baseURL 被拼两层 | `dsh` 会在 baseURL 后自动拼 `/chat/completions`；写成 `.../v1/chat/completions` 会变成 `/v1/chat/completions/chat/completions` → 上游 **404** | 地址只写到 `/v1`。排查靠代理日志里记的实际路径，猜不出来 |
| 响应解压错位 | `fetch`(undici) 会自动解压上游响应，但**保留** `content-encoding` 头 —— 原样转发后客户端再解一次，报 `Decompression failed` | 出站加 `accept-encoding: identity`；回传丢掉 `content-encoding` / `content-length` |
| 剥字段误伤工具 | 全量递归会把 `tools[].function.parameters.properties` 里叫 `model`/`usage`/`reasoning` 的属性一起删掉 | 只走「已知容器」（顶层 / `messages` / `input` / content block），不做全量递归 |
| 顶层 `model` 不能剥 | 它是必需字段，剥错会得到 `Model is not supported` | 只剥**消息对象**上的 `model`（用有没有 `role` 判断） |
| 端口冲突 | 用户可能已有别的代理在监听同一端口 | 内置代理绑定失败时提示「端口已被占用」，同时健康检查显示该端口在线 —— 复用已有服务 |

---

## 三、测试

`dsh-sec-config` 新增测试目录，**25 条离线单测**（纯函数、不联网），已并入统一测试套件：

- 目标地址推导（三种档位、去尾斜杠、空值拦截）
- 剥字段（顶层 / 消息 / content block 各一处；工具 schema 不被误伤；关开关与非 JSON 原样放过）
- 注入头（会话头存在、逐跳头不外传、`Authorization` 原样透传、强制未压缩）

另附**活体测试** `test/live-upstream.mjs`（真起代理真打上游，4 条），与离线套件分开，
不拖累不联网的环境。

全量回归：**15 套 → 16 套，993 条断言全绿**。

---

## 四、文档

- **README 重写为简介**（456 行 → 105 行）：只回答「这是什么 / 怎么跑起来 / 去哪看细节」
- 详述下沉 `docs/`：`getting-started` / `architecture` / `features` / `plugin-list` /
  `development` / `boundaries`
- 首页封面改为**功能拼图**（9 张核心功能截图 + 标签），由 `docs/images/make-collage.py` 生成
- 术语统一为读者一眼懂的说法（那 26 个 prompt 模块就叫「提示词」；模式是 **3 个**：
  渗透测试 / 代码审计 / 标准）

---

## 五、版本清单

| 包 | 版本 | 主要变化 |
|---|---|---|
| `dsh-saker`（根） | 0.2.5 → **0.2.6** | 版本号与文档同步 |
| `dsh-sec-config` | 1.1.10 → **1.2.0** | **内置模型接入代理**；三档接入界面；独立运行模式与 Windows 启动器；25 条离线单测 |

插件总数保持 **21**。

---

## 六、升级

```bash
git clone https://github.com/ITroyeSivan/Saker.git   # 或 git pull
cd Saker
node scripts/pack-all.mjs
node scripts/install-all.mjs
dsh web
```

升级后打开「设置 → 安全配置」，底部会多出「模型接入（OpenCode Go）」。
默认走内置代理，点「写入配置」后**重启 dsh** 生效。

> `install-all.mjs` 按 `package.json` 版本号跳过同版本包。自己改过插件代码的话，
> 务必同时升版本号，否则不会重装、改动静默不生效。
