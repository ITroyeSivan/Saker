# Saker v0.2.9

本版修复真实浏览器验收中确认的两处行为回归。

## 修复

| 插件 | 版本 | 修复 |
|---|---|---|
| `dsh-session-pulse` | 0.1.4 → **0.1.5** | 当前宿主已把会话聊天快照拆为槽位的 `useChat`，插件仍从 `useSession(s => s.chat)` 读取，导致提示词栏恒为空、完全不渲染。现改为使用 `useChat`，并补回归锁。 |
| `dsh-auto-advance` | 0.3.7 → **0.3.8** | 用户明确要求“只回复一句话”或“不要调用工具”时，不再追加自动开工提醒。此前提醒会迫使模型再跑一轮，甚至违背禁工具指令继续调用工具。 |

## 验证

- `dsh-session-pulse`：32/32
- `dsh-auto-advance`：72/72
- 全仓：22 套 · 1620 ok / 0 fail / 17 skip；`test-dsh-home` 11/11；安装回滚 23/23。
- MCP Studio TypeScript：55/55。
- 浏览器复验：提示词栏正常显示并可定位消息；“只回复 FIX_OK，不要调用工具”实测 1 轮 / 1 步 /
  0ms 工具调用，transcript 无 `auto-advance`。
