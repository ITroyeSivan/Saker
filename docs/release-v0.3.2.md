# Saker v0.3.2

## 自 v0.2.6 以来的累计更新

- 新增 CTF 解题模式、CTF 协作观察器和按模式工具收窄；目前覆盖渗透测试、代码审计和 CTF 三个方向。
- 知识库扩展到 20 个自动同步知识包，新增 SQLite FTS5 + BM25 + 中文 bigram 离线混合检索、
  chunk 精读和后台索引构建。
- 提示词与工具面持续精简：方法栈模块化、工具描述预算门禁、`tools.restrict` 按模式隐藏无效工具；
  代码审计模式下工具声明体积降低约 34%。
- 结束条件外置：`operation_conclude` 由系统检查准则和意图台账后再结束回合，`failed` 被作为有效终态。
- MCP Studio 增加 `auto` / `proxy` / `hybrid` 暴露模式、真实状态诊断、热切换与自愈重连；
  修复 stdio EPIPE 打挂宿主、proxy 死通道在 catalog TTL 内不重开等真实缺陷。
- 会话与 UI：修复提示词栏、自动开工提醒、会话排序、分叉、子代理通知等一批运行时问题。
- 适配 dsh `0.1.6-alpha.1`：迁移 PTC workflow provider，更新 MCP SDK、agent 生命周期和 session UI 契约。
- 与宿主能力去重：停止重复维护 session 状态面板；浏览器与桌面操作优先复用宿主或上游 MCP 运行时。

## 宿主能力去重

- 对照 dsh `0.1.6-alpha.1` 的 Browser Use、Computer Use、Trajectory、Turn Outline、
  Todo、Subagent 目录和 session projections，明确宿主与 Saker 的职责边界。
- `dsh-session-pulse` 默认停用。宿主已提供任务、轮次、轨迹和子代理 UI；旧实现仅保留给旧宿主
  或专门兼容测试，新会话不再重复渲染。
- `browser-recon` 改为优先使用宿主 Browser Use；没有时使用 MCP Studio 管理上游浏览器 MCP，
  Saker 不再维护第二套浏览器运行时。
- Chrome DevTools MCP 预设固定到 `1.9.0`，保持与 dsh `0.1.6-alpha.1` 的 pin 一致。
  29 个上游工具由 MCP Studio 的 `auto`/proxy 暴露，常驻提示词只增加 `mcp_search` / `mcp_call`。

## 验证

- dsh session/UI 宽范围回归：530 个测试文件、8944 项通过、12 项跳过。
- Browser/Computer provider 定向测试：19 个测试文件、136 项通过。
- Browser Use 真实 Chrome for Testing：Chrome DevTools MCP、Playwright MCP 的 launch/attach
  共 4 项 e2e 通过。
- MCP Studio proxy 真实浏览器 e2e：29 个 Chrome DevTools 工具可搜索，`new_page` 导航成功，
  `take_snapshot` 返回目标页面内容。
