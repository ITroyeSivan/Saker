# dsh 0.1.6 host capability map

Saker should not rebuild capabilities that the host already owns. This map records which side is authoritative.

| Capability | Authoritative implementation | Saker role |
|---|---|---|
| Session turn navigation, trajectory, todo panel, subagent directory | dsh `0.1.6-alpha.1` host client | `dsh-session-pulse` is disabled by default; only domain-specific security views remain |
| Session persistence, paging, fork, archive, stats, projections | dsh host | Saker consumes the same session state; no second session store |
| Browser use | dsh experimental Browser Use provider; otherwise an upstream browser MCP server | `browser-recon` is methodology only and prefers host Browser Use or MCP Studio proxy tools |
| Computer use | dsh experimental Cua Driver providers | Saker does not ship a desktop-control runtime |
| MCP resources and URI templates | dsh `dsh-mcp-client` / `dsh-mcp-resources` | `dsh-mcp-studio` adds configuration, diagnostics, proxy exposure, and token compression |
| Goal and plan mode | dsh `dsh-goal` / `dsh-plan-mode` | Saker adds domain gate criteria and operation ledgers, not a second goal service |
| Subagents | dsh `dsh-subagent`, spawn/fork providers, and host UI | `dsh-product-subagents` only adds external Codex/Claude Code execution providers |
| PTC and workflow | dsh `dsh-ptc-runtime` / `dsh-workflow-ptc` | Saker presets mount the provider in their agent scope and consume it |
| Web search and fetch | dsh base tools | `dsh-hunter` remains specialized asset discovery, not a generic search duplicate |
| Web terminal | dsh web sidebar terminal | `dsh-webshell-mgr` remains remote authorized-shell management |
| Auto review | dsh experimental Auto Review | Saker does not duplicate it |

## Browser integration

Use host Browser Use when a session must own a browser resource for its full lifetime. Use the MCP Studio Chrome DevTools preset when token pressure matters more: it pins `chrome-devtools-mcp@1.9.0`, stays disabled until explicitly enabled, and `auto`/proxy exposure keeps the full 29-tool catalog out of the standing prompt.

The measured upstream catalogs at `0.1.6-alpha.1` are:

| Provider | Tools | Serialized tool schemas |
|---|---:|---:|
| Chrome DevTools MCP full | 29 | ~26 KB |
| Chrome DevTools MCP slim | 3 | ~1 KB |
| Playwright MCP | 24 | ~18.5 KB |

## Session UI

Host Trajectory and Turn Outline are the canonical session views. `dsh-session-pulse` remains in the repository for old-host compatibility only and has `disabled: true` in its default Cordis row.
