# dsh Desktop host capability map

Supported Windows host: official Desktop 0.2.0-rc.2. The plugin client runs in the application's shared renderer; `client.platform = web` remains the official renderer API identifier.

Saker should not rebuild capabilities that the host already owns. This map records which side is authoritative.

| Capability | Authoritative implementation | Saker role |
|---|---|---|
| Session turn navigation, trajectory, todo panel, subagent directory | dsh Desktop shared host client | `dsh-session-pulse` is disabled by default; only domain-specific security views remain |
| Session persistence, paging, fork, archive, stats, projections | dsh host | Saker consumes the same session state; no second session store |
| Browser use | dsh experimental Browser Use provider; otherwise an upstream browser MCP server | `browser-recon` is methodology only and prefers host Browser Use or MCP Studio proxy tools |
| Computer use | dsh experimental Cua Driver providers | Saker does not ship a desktop-control runtime |
| MCP resources and URI templates | dsh `dsh-mcp-client` / `dsh-mcp-resources` | `dsh-mcp-studio` adds configuration, diagnostics, proxy exposure, and token compression |
| Goal and plan mode | dsh `dsh-goal` / `dsh-plan-mode` | Saker adds domain gate criteria and operation ledgers, not a second goal service |
| Subagents | dsh `dsh-subagent`, spawn/fork providers, and host UI | `dsh-product-subagents` only adds external Codex/Claude Code execution providers |
| PTC and workflow | dsh `dsh-ptc-runtime` / `dsh-workflow-ptc` | Saker presets mount the provider in their agent scope and consume it |
| Web search and fetch | dsh base tools | `dsh-hunter` remains specialized asset discovery, not a generic search duplicate |
| Host terminal | dsh host terminal provider, subject to the current Desktop workspace and provider availability | Saker uses host terminal capabilities; remote shell management is excluded from the current product |
| Auto review | dsh experimental Auto Review | Saker does not duplicate it |

## Browser integration

Use host Browser Use when a session must own a browser resource for its full lifetime. Use the MCP Studio Chrome DevTools preset when token pressure matters more: it pins `chrome-devtools-mcp@1.9.0`, stays disabled until explicitly enabled, and `auto`/proxy exposure keeps the full 29-tool catalog out of the standing prompt.

## Session UI

Host Trajectory and Turn Outline are the canonical session views. `dsh-session-pulse` remains in the repository for old-host compatibility only and has `disabled: true` in its default Cordis row.
