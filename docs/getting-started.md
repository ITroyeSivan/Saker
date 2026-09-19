# 安装与首次配置

从零装到能跑通第一个任务。已经装过的可以直接跳到「更新与卸载」。

---

## 环境要求

- DeepSeek Harness已安装，`dsh web` 可以正常启动，并已配置可用模型。
- Node.js `>=22.5`。MCP Studio要求 `^22.19.0 || >=24.0.0`。
- 使用扫描器、Semgrep、Burp、Yakit、Claude Code或Codex时，需要自行安装并配置对应程序。

> 当前完整验证环境为 DeepSeek Harness **`0.1.6-alpha.1-0a15e36`** 内部 Web 版本；
> `0.1.5-rc.1` 保留兼容。公开 npm 线以 `npm view @deepseek-ai/dsh dist-tags` 为准。

**关于 `0.1.6-alpha.1`**：已在真实宿主上完成适配并实跑验证；本次迁移了 PTC workflow provider，
并修复了 MCP proxy/hybrid 子进程退出后的死通道重开。下一节保留 0.1.5 破坏性变更的历史说明。

需要特别说明的是——**这一版存在静态 API 差分看不出来的破坏性变更**，本项目最初的差分结论（「影响仅一处」）是**错的**，已被实跑推翻：

| 变更 | 说明 |
|---|---|
| `connection` 服务的 inject 收窄 | `["webServer", "credentials"]` → `["credentials"]` |
| 路由注册归属改为**调用方** | 需用 `owner.webServer`，不再是消费方 |

后果：沿用 `connection.rpc.handle(channel, handler)` 的插件会**静默注册失败且不抛错** ——
设置页永久「加载中…」、RPC 通道 404，日志里毫无线索。改用
`connection.register(ctx, channel, handler)` 并确保 inject 带 `webServer` 后恢复正常。

其余依赖面（`agentPresets` 契约、persona `prefix`、`skill-filesystem` 的 `customSkillDirs`、
`defineTool` 声明式契约、`conversation.hero.agentPreset` 槽位）经实跑确认未变；
宿主新增的 `dsh-tool-present` 已由 Saker 两个预设同步挂载。

**验收基线**（2026-09-12 在 dsh 0.1.5-rc.1 宿主上实测）：设置页 10/10 分区正常 ·
6 条插件 RPC 通道全部可访问（`/dsh-knowledge-hub`、`/dsh-mcp-studio`、`/dsh-method-stack`、
`/dsh-sec-config`、`/dsh-skill-browse`、`/dsh-webshell-mgr-rpc` 的 `.../status` 均返回 HTTP 200）·
插件加载失败 0 · 17 套插件测试 **1147** 断言全绿 + MCP Studio 51 条 TS 测试全绿。
详见 [docs/release-v0.2.5.md](release-v0.2.5.md)。

## 从源码安装全部组件

```bash
git clone https://github.com/ITroyeSivan/Saker.git
cd Saker

# 生成根模式包和21个插件包
node scripts/pack-all.mjs

# 按顺序安装到web profile（自动跳过同版本、升级更高版本）
node scripts/install-all.mjs

# 重启宿主
dsh web
```

`pack-all.mjs` 需要 `pnpm` 可用。`install-all.mjs` 默认安装到 `web` profile，可用 `SAKER_PROFILE` 指定其他profile；`dsh` 不在PATH时用 `DSH_CLI` 指向CLI入口（例如源码树里的 `apps/cli/lib/bin.js`），`DSH_HOME` 可覆盖配置目录。脚本会跳过已安装的同版本包、自动升级更高版本，并清理因重新打包而失效的旧 `file:` 依赖，可安全重复执行。

启动后：

1. 在「设置 → 安全配置」填写需要使用的本机工具路径与服务地址。
2. 在MCP Studio导入或新增MCP服务。
3. 新建会话，选择 `pentest` 或 `code-audit`。

<details>
<summary><b>只安装部分组件</b></summary>

每个目录都是独立的dsh bundle。先安装根模式包，再按需要添加插件：

```powershell
dsh plugin --profile web add "file:C:/packages/dsh-saker-0.3.9.tgz"
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-sec-config-1.3.23.tgz"
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-knowledge-hub-0.3.18.tgz"
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-skill-browse-1.1.10.tgz"
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-stage-gate-1.7.2.tgz"
```

三个模式共用同一套扫描插件（靶场/CTF 场景也走同一批工具）。使用完整模式能力时一并安装：

```powershell
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-scanner-tools-1.0.16.tgz"
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-semgrep-audit-1.0.7.tgz"
```

</details>

<details>
<summary><b>更新与卸载</b></summary>

更新时重新打包并对需要升级的包执行 `dsh plugin add`，然后重启dsh。`install-all.mjs` 会跳过同版本项、升级更高版本，并先清理指向已删除tgz的旧依赖。

```powershell
dsh plugin --profile web add "file:C:/packages/dsh-saker-新版本.tgz"
dsh plugin --profile web remove dsh-saker
```

独立插件需要使用各自的包名管理。卸载包不会自动删除已经生成的会话、数据库和任务产物。

</details>

---

## 交给 AI 代为部署

把下面整段贴给任意能读写文件、能执行命令的 AI（Claude Code / Codex / 其他 agent 均可）。
它会自己把环境检查、打包、安装、自检跑完并逐步报告。

装之前先确认它**没有**改 `preset/` 与 `plugins/*/cordis.patch.yml` 里的绑定方式，也**没有**把路径写死成某台机器上的路径——这两件事是最常见的"装完不能用"来源。

```text
你要在这台机器上部署 Saker（DeepSeek Harness 的渗透测试 / 代码审计 / CTF 解题插件集）。
按顺序执行，每步不通过就停下报告，不要跳过断言、不要"绕过"报错。

【0. 先读，别猜】
- 读 README.md 与 docs/getting-started.md，确认安装顺序。
- 禁止修改 preset/ 与 plugins/*/cordis.patch.yml 的绑定方式（改了会装不上）。
- 禁止把绝对路径写进仓库文件；路径只能来自环境变量或命令行参数。

【1. 环境前置检查】
- dsh --version 能跑通（不在 PATH 时用 DSH_CLI 指向 CLI 入口）。
- node -v 满足 >= 22.5；MCP Studio 要求 ^22.19.0 || >=24.0.0。
- pnpm 可用；不可用就先装。
- 记下 profile 目录：默认 ~/.dsh/profiles/web（可用 SAKER_PROFILE / DSH_HOME 覆盖）。

【2. 打包与安装】
- node scripts/pack-all.mjs
  断言：1 个根模式包 + 23 个插件包全部生成，无失败项。
- node scripts/install-all.mjs
  断言：输出里没有 cannot find / ERR_MODULE_NOT_FOUND / 安装异常。
  必须真的跑 install，不能只跑 pack —— 打包通过不等于装得上（出过 pack 全绿但安装崩 ReferenceError）。
- 若本轮改过插件代码：先升该插件 package.json 的 version，否则 install-all 按版本号跳过，改动不会生效。

【3. 重启并自检】
- 重启 dsh web。
- 插件加载：日志里搜不到插件加载失败。
- RPC 路由已注册。判据：HTTP 401 = 已注册（被鉴权栅栏挡下），404 = 没注册。逐条探测：
  /dsh-attack-atlas  /dsh-campaign-memory  /dsh-hunter  /dsh-redteam-results
  /dsh-session-pulse  /dsh-webshell-mgr  /dsh-webshell-mgr-rpc  /dsh-mcp-studio
- 设置页分区逐个打开：「安全配置」「webshell 管理」「MCP Studio」「refusal-guard」都不得停在永久「加载中…」。
- 新建会话能选到 pentest / code-audit / ctf-solver 三个 preset。

【4. 出错时的排查入口（按顺序，不要瞎试）】
- dsh 起不来：先看端口是否被占（换 --port）；NODE_OPTIONS 置空；删 ~/.dsh/.credentials.yaml.lock 再起。
- 某设置页永久「加载中…」：几乎一定是该插件 RPC 路由没注册 —— 用第 3 步的 401/404 探测定位到具体通道，
  再查该插件是否用了 connection.register(ctx, channel, handler)，以及 inject 里有没有带 webServer。
- 插件没装上：核对 profile 的 package.json 依赖是不是 file: tgz，以及 bundles 层数是否符合预期。
- 改了代码不生效：比对已装 lib/*.js 与仓库源码的 md5 —— 版本号没升就会这样。

【5. 报告方式】
- 逐步报告：命令、实际输出、断言是否通过。
- 任何一步失败：给原始错误输出 + 你的判断 + 打算怎么修，不要自行跳过。
任何情况下不要改 preset 绑定、不要写死路径、不要 force push。
```
