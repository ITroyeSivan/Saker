# dsh-mode-group (模式选择分组)

新建会话屏的模式选择器：**pentest / code-audit / ctf-solver 三个专业模式排在最前**，其余 roster 中可见的模式（如宿主 `standard`，供日常办公会话使用）紧随其后平铺列出。纯客户端表面，无宿主行为。

## 能力

- 模式 chip 单层平铺：专业安全模式（pentest / code-audit / ctf-solver）在前，其余可见模式随后；只认专业模式会把 `standard` 挡在 UI 之外，preset 层放行了也依然选不到。
- 数据与动作走 `connection.api.agentPresets`，语义与原生 seat 一致：选择 = 暂存 + 空白会话即应用；会话列表变化时补投。
- 视口自适应：悬停预览 + 点击固定，窄屏自动翻转/滚动，无其它界面改动。

## 组成

- `lib/client.js`：`conversation.compose` slot 上的选择 chip（含控制器与弹层定位）。
- `lib/index.js`：宿主半区占位（无宿主侧行为）。

## 相关

模式可见范围由 `dsh-saker` 的 `lib/preset-root.js` 决定（默认 `pentest / code-audit / ctf-solver / standard`，可用 `SAKER_VISIBLE_PRESETS` 追加）。本插件只负责把可见模式展示出来，不做二次筛选。

## 安装与卸载

作为 Saker 增量包随 `dsh plugin add` 安装；卸载即移除分组选择器，不影响平台内置模式选择。
