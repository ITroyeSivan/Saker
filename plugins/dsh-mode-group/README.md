# dsh-mode-group (模式选择分组)

新建会话屏的模式选择器：把**内置（宿主）模式**与 **pentest / code-audit 两个专业模式**分组展示，避免模式一多选择区拥挤。纯客户端表面，无宿主行为。

## 能力

- 模式 chip 两级分组：内置模式/通用入口一组，专业安全模式（pentest / code-audit）一组。
- 数据与动作走 `connection.api.agentPresets`，语义与原生 seat 一致：选择 = 暂存 + 空白会话即应用；会话列表变化时补投。
- 视口自适应：悬停预览 + 点击固定，窄屏自动翻转/滚动，无其它界面改动。

## 组成

- `lib/client.js`：`conversation.compose` slot 上的选择 chip（含控制器与弹层定位）。
- `lib/index.js`：宿主半区占位（无宿主侧行为）。

## 安装与卸载

作为 Saker 增量包随 `dsh plugin add` 安装；卸载即移除分组选择器，不影响平台内置模式选择。
