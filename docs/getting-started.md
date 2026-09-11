# 安装与首次配置

从零装到能跑通第一个任务。已经装过的可以直接跳到「更新与卸载」。

---

## 环境要求

- DeepSeek Harness已安装，`dsh web` 可以正常启动，并已配置可用模型。
- Node.js `>=22.5`。MCP Studio要求 `^22.19.0 || >=24.0.0`。
- 使用扫描器、Semgrep、Burp、Yakit、Claude Code或Codex时，需要自行安装并配置对应程序。

> 当前完整验证环境为 DeepSeek Harness **`0.1.5-rc.1-183f08e`** 内部 Web 版本。公开 npm 线 `@deepseek-ai/dsh@0.1.2-rc.1` 为 CLI-only，不在完整 Web 工作台的验证范围内。

**关于 `0.1.5-rc.1`**：已在真实宿主上完成适配并实跑验证。

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

**验收基线**：设置页 10/10 分区正常 · 插件 RPC 路由 12/12 已注册 · 插件加载失败 0 · 15 套测试 968 断言全绿。
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
dsh plugin --profile web add "file:C:/packages/dsh-saker-0.2.5.tgz"
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-sec-config-1.1.7.tgz"
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-knowledge-hub-0.1.10.tgz"
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-skill-browse-1.1.1.tgz"
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-stage-gate-1.5.0.tgz"
```

两个模式直接引用对应扫描插件。使用完整模式能力时一并安装：

```powershell
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-scanner-tools-1.0.0.tgz"
dsh plugin --profile web add "file:C:/packages/dsh-external-dsh-semgrep-audit-1.0.0.tgz"
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
