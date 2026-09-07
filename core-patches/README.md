# core-patches — 宿主层可选补丁

Saker 的**模式/插件**是纯增量（`dsh plugin add` 即可）。以下改动位于 **dsh 宿主层**（DeepSeek Harness 本体），无法用插件分发——需要克隆/拿到 dsh 源码后手工应用并重新构建。**不应用也能用 Saker**（只是登录页/标题保留 dsh 原生样式、默认密码为宿主默认值）。

在参考开发机上，这些改动位于 dsh 仓库（0.1.3-alpha.1）：

| 宿主文件 | 改动 | 效果 |
|---|---|---|
| `packages/client/connection/src/browser-auth.ts` | `DEFAULT_PASSWORD_SHA256 = sha256('123456')`；master key 首次随机 mint 并打印一次；`changePassword` 用 master key 校验 + 轮换签名密钥使旧会话全失效 | 默认密码 `admin/123456`；支持「设置→安全配置→修改密码」 |
| `apps/web/public/login.html` | 标题「Saker · 登录」+ 顶部 Saker 渐变字标；删除全部说明性文案（仅保留错误多次锁定提示） | 登录页极简 + Saker 品牌 |
| `apps/web/index.html` / `manifest.webmanifest` | title / manifest name → Saker | 浏览器标签与 PWA 名称 |
| `packages/bundle/web-app/src/index.ts` | 启动时先打印 `Saker — 基于 DeepSeek Harness 的攻防平台` 横幅再打印 URL | 启动即见品牌 |
| `packages/client/locale/src/locales/zh.ts` / `en.ts` | `brand.localBuild` → `Saker 攻防平台` / `Saker` | SPA 主界面空态抬头等处的应用名 |

应用后需重新构建：

```bash
pnpm run build:lib:host && pnpm run build:web
```

> ⚠️ 应用前请先审视上游许可与本仓库授权；二开分发时保留上游 MIT 版权声明。
