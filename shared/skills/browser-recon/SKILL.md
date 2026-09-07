---
name: browser-recon
description: 浏览器/网页交互作战技能：JS 抓取、SPA 渲染、登录口人机交互、指纹确认、动态 API 触发、客户端富应用下的入口面盘点。默认通道 Chrome MCP（无 webdriver、真实浏览器指纹），无则降级 webdriver 消指纹链；登录后改包走 burp/yakit MCP（保会话态）；抓到的 JS/接口补全 pentest 的 JS 盘点与 API 入口表。
---

# 浏览器侦察（browser-recon）

> 位置：Saker 模式包 `shared/skills/`，各预设（pentest / code-audit）共同加载。
> 适用：SPA / 客户端富应用 / 复杂登录口 / 需人机交互的页面（验证码、短信、扫码、OAuth 跳转）。

## 通道阶梯

| 场景 | 默认通道 | 降级链（缺失时） |
|---|---|---|
| 自动化巡页 / 抓 JS / 提取 API | **Chrome MCP**（真实浏览器指纹，免 webdriver 标记） | webdriver 消指纹链（`--disable-blink-features=AutomationControlled` + 真实 UA/分辨率）→ curl 拉首屏 HTML（异步 chunk 缺失需标注） |
| 登录后改包 / 拦截重放 | **burp / yakit MCP**（保 Cookie，可改可重放） | mitmproxy → curl 带凭据直发（能发不能拦，登记损失） |
| 客户端加密 / 签名抓取 | **frida** hook 关键函数离线重放 | 反编译静态分析（wxapkg / apk / asar）→ 加密流量侧录 |

## 落地产物（必登记 evidence-index）

- **JS 资产表**：`scripts/<target>/js-files.md`——路径 / 大小 / sha256 / 关键导出 / 路由命中。
- **API 入口表**：`scripts/<target>/api-endpoints.md`——方法 / 路径 / 入参 / 鉴权要求 / 触发 URL。
- **登录态会话**：`scripts/<target>/session.json`（**只存 cookie + csrf**，**禁存明文账密**），
  供后续 burp/yakit 复用。

## 纪律

- 真实浏览器指纹优先：自动化扫描流量在 WAF/蜜罐前会"自报家门"，先消指纹。
- JS 异步 chunk 缺失必须显式标注——拿到首屏 HTML 不等于拿到全部前端代码。
- 抓到的接口与 JS 路由 = 后续 pentest 漏洞类全集的输入面，**别抓完即丢**。
- 客户端侧反编译产物（wxapkg / apk / asar）按 preset/pentest/skills/pentest-playbook
  「客户端侧作战线」章登记。

## 与其他技能的关系

- 入口面盘点的"客户端入口"维度（小程序 / app / 桌面）由 `pentest-playbook`
  客户端侧作战线承接，本技能提供"浏览器抓取 + 抓包"通道子集。
- 抓到的接口进入 `pentest-playbook` 的形态作战线 A（纯 API 型）继续打。
- 凭证/会话复用 = `red-team-command-doctrine` 的最小化纪律（不持久化账密）。
