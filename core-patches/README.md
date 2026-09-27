# core-patches — 宿主层可选补丁

Saker 的**模式/插件**是纯增量（`dsh plugin add` 即可）。以下改动位于 **dsh 宿主层**（DeepSeek Harness 本体），无法用插件分发——需要克隆/拿到 dsh 源码后手工应用并重新构建。**不应用也能用 Saker**（只是登录页/标题保留 dsh 原生样式、默认密码为宿主默认值）。

在参考开发机上，Saker 0.4.0 的宿主补丁位于 dsh 仓库（`0.1.7-rc.1`）：

| 宿主文件 | 改动 | 效果 |
|---|---|---|
| `packages/util/atomic-write/src/index.ts` | `withFileLock` 在竞争时识别锁文件里的死 PID，二次读取确认未换主后安全回收；活进程、空锁和未知格式不碰 | 宿主崩溃留下的 profile/settings 写锁不再永久堵住配置保存 |
| `packages/llm/llm-pi-ai/src/stream.ts` | `classifyPiAiError` 识别流式工具调用 JSON 截断（`Unterminated string in JSON...` / `Unexpected end of JSON input`）并归为可重试的 `TRANSPORT` | 上游断流导致的半截工具参数不再以不可重试的 `PI_AI_ERROR` 中止整个回合，长任务可自动重试继续 |
| `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` | 切换设置分区时把右侧内容区滚动位置复位 | 从长设置页切到另一个分区不会停在页面中部 |

应用后需重新构建：

```bash
pnpm run build:lib:host && pnpm run build:web
```

> ⚠️ 应用前请先审视上游许可与本仓库授权；二开分发时保留上游 MIT 版权声明。

早期版本还包含登录页、Saker 品牌标题和默认密码等宿主补丁。它们不在当前
`0.1.7-rc.1` 的官方源码树中；需要这些展示/认证改动时，应先把旧补丁 rebase
到对应文件后再构建，不能把 Saker 插件包当作登录页补丁的替代品。

### 2026-09-08 宿主 rebase 到 dsh-v0.1.3-alpha.2（Saker 0.2.3 起）

参考机宿主源码已从官方 0.1.3-alpha.1 整树换基到 alpha.2（316 commits）。除上表补丁外新增宿主侧两处本地适配（功能不变）：

| 位置 | 改动 | 原因 |
|---|---|---|
| `packages/session/session-persistence-jsonl/src/lease.ts` | fs-ext `flock` 改为惰性绑定：win32 直接走 Win32 信号量句柄（不 import fs-ext）；非 win32 才 `import('fs-ext')` | fs-ext 原生模块需 node-gyp/VS 编译，本机无 VS；Windows 分支本就使用 win32 信号量、从不调用 flock，官方 browser-worker 亦以"立即成功"stub 处理同场景 |
| `packages/client/web/package.json` | devDependencies 补 `zod@^4.4.3` | 本地 `seed.ts`/`platform.ts` 鉴权补丁依赖 zod |

其余 alpha.1 时代本地补丁（browser-auth 密码登录、frontend-static 退出浮标 tapIndex、login/index/manifest 品牌、locale brand.localBuild、client/web platform/seed）均已在 alpha.2 树原样保留；`connection/src/index.ts` 为官方断线恢复增量 + 本地 auth 路由增量合并（互不重叠）。alpha.2 新增的官方 `recovery-config` 注入与本地补丁并存（回归已验证：SPA 同时含 `dsh-auth-logout` 与 `__DSH_CONNECTION_RECOVERY__`）。

完整 diff 与升级记录见宿主工作区 `_upgrade/`（`Saker-dsh-alpha2-upgrade-report.md`、`upgrade-execute.js`、`prune-apply.js`、`merged-connection-index.ts`）。
