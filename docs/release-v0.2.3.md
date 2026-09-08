# Saker 0.2.3

Saker 攻防平台（猎隼）0.2.3 版本。本轮从 0.2.2 起累计 **29 个提交、172 个文件变更**（+3881 / -626），涵盖两个新插件、七个插件升级、一处远程 MCP 阻断性缺陷修复，以及一次面向公开发布的全面体检。

> 完整验证环境：DeepSeek Harness `0.1.3-alpha.2` 内部 Web 版本 · Node.js `>=22.5`

---

## 新增插件

| 插件 | 版本 | 能力 |
|---|---|---|
| `dsh-method-stack` | 0.1.4 | 测试方法可编排：26 个方法按五组勾选，会话开场自定义，输入框 dock 快捷点选，注入正文去重润色 |

插件总数 20 → **21**。

---

## 插件升级

| 插件 | 版本 | 主要变化 |
|---|---|---|
| `dsh-sec-config` | 1.0.12 → **1.1.7** | 工具库 v2「目录即库」：选根目录一键探测并自动分类导入、多根目录、分类自定义；`entries[]` 为真源、`tools` 派生兼容 `DSH_TOOL_*`；工具行可隐藏/恢复；stdio MCP 改用绝对解释器路径 |
| `dsh-webshell-mgr` | 1.0.0 → **1.1.12** | 设置页升级为资产库（上传自有马 + 明文口令管理）；库列表 = 扫描当前目录内全部 webshell 文件；上传缺省自动生成连接口令；新增 `webshell_library_list` / `webshell_library_read` 工具 |
| `dsh-knowledge-hub` | 0.1.5 → **0.1.10** | Exploit-DB 字段化索引（EDB-ID / CVE / 平台 / 描述）+ 中文与缩写别名召回；`edb-sync` 拉取官方索引；manifest 动态注入 EDB 行 |
| `dsh-mcp-studio` | 1.0.2 → **1.0.3** | 修复 streamable-http 诊断未回传 `Mcp-Session-Id`（见下） |
| `dsh-route-boost` | 1.3.3 → **1.3.4** | 识别配置工具面 + TTL 缓存 |
| `dsh-redteam-results` | 1.0.1 → **1.0.2** | 建库目录修复 |

---

## 缺陷修复

**远程 MCP 永久 unreachable（阻断性）** — `mcp-studio` 1.0.3

streamable-http 传输的诊断路径未保存并回传 `Mcp-Session-Id`，服务端返回 400 `Missing session ID`，导致 UI 永久显示 unreachable。运行时走官方 SDK 不受影响，但状态由诊断驱动，因此表现为「工具能用、界面说不能用」。已修复。

**目录探测回归** — `sec-config` 1.0.14

`scan-candidates` / `tool` 探测自 1.0.12 起缺失 `node:path` 导入，潜伏 `ReferenceError`。已修复。

**新用户视角体检**（`c40e89e`）

- `redteam-results` 建库目录
- `route-boost` 认配置工具面 + TTL 缓存
- `sec-config` stdio MCP 绝对解释器路径
- 16 个插件补 `files` 白名单（此前打包会混入 test / 旧 tgz / node_modules）

---

## 公开发布就绪

**README 定稿** — 15 张界面截图正式入档，路径与文件名固定，后续换图只需同名覆盖。

**全仓库链接修复：244 处死链 → 0**

知识库从上游 `skills/<x>/SKILL.md` 布局扁平化为 `refs/<分类>/<x>.md` 后，文内相对链接一直未同步。本次分三档处理：134 处按规则/语义映射回真实文件；108 处上游未随包的交叉引用去掉链接语法、保留可见文字；2 处上游截图改为文字说明。修复后 191 个链接 100% 有效。

**数据口径校正**

- Semgrep 开源规则集：1080（文件数口径）→ **1096 条规则**（1078 个文件）
- 代码审计手册篇数：226 → **232**
- WebShell 生成器：10 种 → **16 种**

**包完整性**

`dsh-method-stack`、`dsh-skill-browse` 补 `LICENSE`；三个插件的 `files` 补 `README` / `LICENSE`。全量打包校验 **22/22 通过**（1 根包 + 21 插件）。

---

## 安装

```powershell
git clone https://github.com/ITroyeSivan/Saker.git
cd Saker
node scripts/pack-all.mjs      # 需要 pnpm
node scripts/install-all.mjs   # 默认装到 web profile
```

`install-all.mjs` 会跳过已安装的同版本包、自动升级更高版本，并清理失效的旧 `file:` 依赖，可安全重复执行。用 `SAKER_PROFILE` 指定其他 profile，`DSH_CLI` 指向 CLI 入口，`DSH_HOME` 覆盖配置目录。

启动后：设置 → 安全配置填本机工具路径与服务地址 → MCP Studio 导入 MCP 服务 → 新建会话选 `pentest` 或 `code-audit`。

---

## 已知边界

- 公开 npm 线 `@deepseek-ai/dsh@0.1.2-rc.1` 为 CLI-only，不在完整 Web 工作台的验证范围内。
- 平台登录页在 localhost 场景走 HTTP；部署到局域网建议先接 HTTPS。
- 免杀变体不在 WebShell 生成器职责内，可通过「从文件导入」登记为产物。

---

**完整变更**：https://github.com/ITroyeSivan/Saker/compare/v0.2.2...v0.2.3
