/** Host plugin: owns the `mcp-studio` settings namespace, mounts one mcp-client per enabled row (hot-swap on edit, dispose on remove), and serves live status aggregated from the tool registry over the plugin's loopback channel. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only import: pulls in dsh-session's Context event augmentation
// (`session/event` etc.) so ctx.on() accepts session lifecycle events.
import type {} from '@deepseek-ai/dsh-session'
// Type-only import: pulls in dsh-settings' Context augmentation (ctx.settings).
import type {} from '@deepseek-ai/dsh-settings'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import {
  Config,
  toMcpClientConfig,
  validateSection,
  type ServerEntry,
  type StudioSection,
} from './types.ts'
import {
  createExecutionRing,
  createStatusHandler,
  registerStudioRpc,
  type ExecutionRing,
  type HostConnectionHandle,
  type HostSettingsService,
  type MountTracker,
  type ProxyView,
} from './settings-rpc.ts'
import { diagnoseServer } from './diagnose.ts'
import {
  decideExposure,
  ProxyRegistry,
  summarizeCatalog,
  META_TOOL_CALL,
  META_TOOL_SEARCH,
  type ExposureDecision,
} from './proxy.ts'

export const name = 'dsh-mcp-studio'
// `settings` is declared here because apply() itself owns the `mcp-studio` namespace
// (ctx.settings.register below). Cordis refuses *reading* a service the calling fiber did
// not declare, so leaving it out made the registration throw into its own catch and the
// namespace silently never existed. `webServer` is deliberately NOT declared at module
// level: it only exists in browser-serving profiles, and the MCP mounts plus the two
// meta-tools are useful headless too — the page's RPC channel is opened on a scoped
// ctx.inject(...) below instead.
export const inject = ['tools', 'settings']

/** Settings namespace owned by this plugin (client and Host spell the same value). */
export const STUDIO_SETTINGS_NAMESPACE = 'mcp-studio'

/** One mounted mcp-client fiber plus the config signature it was built from. */
interface Mount {
  readonly dispose: () => void
  readonly signature: string
  readonly ready: Promise<unknown>
}

/** Minimal face of the tools registry the status aggregator needs. */
interface ToolsServiceHandle {
  view(scope?: unknown): unknown
}

function signatureOf(server: ServerEntry): string {
  return JSON.stringify(toMcpClientConfig(server))
}

export async function apply(ctx: Context, config: StudioSection): Promise<void> {
  let current = (): StudioSection => config
  let alive = true
  const mounts = new Map<string, Mount>()
  /** Mount-lifecycle notes, enriched by the registry view on every status read. */
  const tracker: MountTracker = { states: new Map() }

  // ── Proxied exposure: one aggregated connection per server, two meta-tools in total ──
  // Rows whose exposure is (or may become) `proxy` are connected here instead of through
  // `ctx.plugin(mcpClient, …)`, so their per-tool schemas never enter the prompt unasked.
  const proxy = new ProxyRegistry(
    () => current(),
    (format, ...args) => ctx.logger.info(format, ...args),
  )

  /**
   * Effective exposure for a row. `auto` needs the catalog size, so it reports `pending`
   * until the server has answered once — the mount is kept alive precisely to learn that.
   */
  const decide = (server: ServerEntry): ExposureDecision => decideExposure(server, proxy.listedCount(server.name))

  /** Promoted `hybrid` tools, keyed by row id, with the signature that produced them. */
  const promotions = new Map<string, { signature: string; disposers: Array<() => void>; names: string[] }>()

  /** Disposers for `mcp_search` / `mcp_call`, present only while a row is proxied. */
  let metaTools: Array<() => void> | undefined

  /** Warm every proxied catalog, then settle: `auto` rows may now switch to a direct mount. */
  let settlePromise: Promise<void> | undefined
  const settleProxy = (): Promise<void> => {
    if (!alive) return Promise.resolve()
    if (settlePromise !== undefined) return settlePromise
    settlePromise = (async () => {
      try {
        await proxy.ensureAll()
        if (alive) reconcile()
      } finally {
        settlePromise = undefined
      }
    })()
    return settlePromise
  }

  /**
   * 读当前 servers 列表，**永不抛**。
   *
   * 为什么单独抽出来：本插件的 `current()` 在 settings 命名空间未注册时回落到 patch config，
   * 而 config 未必带 servers（手改 settings.yaml 写成 null / 命名空间迟到 / 外部工具部分写入都可能）。
   * 原先直接 `current().servers.some(...)` 一旦拿到非数组就抛，而这是在 `setInterval` 回调里 ——
   * **未捕获异常会直接打挂整个宿主进程**（不是只坏一个面板，是 dsh serve 整个没了）。
   * 同一处防御也用在 reconcile：它会从看门狗、settings 变更、卸载等多条路径被调用，
   * 抛出去同样可能打到宿主。
   */
  const serversOf = (): ServerEntry[] => {
    try {
      const list = (current() as StudioSection | undefined)?.servers
      return Array.isArray(list) ? list : []
    } catch { return [] }
  }

  const reconcile = (): void => {
    if (!alive) return
    const enabled = serversOf().filter(server => server.enabled)

    // 1) Proxy mounts for every row that is proxied, or whose decision is still pending.
    proxy.syncServers(enabled.filter(server => decide(server) !== 'direct'))

    // 2) Direct mounts (the original mcp-client path).
    const wanted = new Map<string, ServerEntry>()
    for (const server of enabled) {
      if (decide(server) === 'direct') wanted.set(server.id, server)
    }
    for (const [id, mount] of [...mounts]) {
      const server = wanted.get(id)
      if (server === undefined || signatureOf(server) !== mount.signature) {
        mount.dispose()
        mounts.delete(id)
        tracker.states.delete(id)
      }
    }
    for (const [id, server] of wanted) {
      if (mounts.has(id)) continue
      const clientConfig = toMcpClientConfig(server)
      tracker.states.set(id, { state: 'mounting' })
      let fiber: ReturnType<Context['plugin']>
      try {
        fiber = ctx.plugin(mcpClient, clientConfig)
      } catch (error) {
        ctx.logger.warn('mcp-studio: could not mount server "%s": %s', server.name, String(error))
        tracker.states.set(id, { state: 'error', error: String(error) })
        continue
      }
      const ready = Promise.resolve(fiber)
      mounts.set(id, { dispose: () => fiber.dispose(), signature: JSON.stringify(clientConfig), ready })
      ready.then(
        () => {
          if (tracker.states.get(id)?.state === 'mounting') tracker.states.set(id, { state: 'mounted' })
        },
        (error: unknown) => {
          tracker.states.set(id, { state: 'error', error: error instanceof Error ? error.message : String(error) })
          ctx.logger.warn('mcp-studio: server "%s" failed to start: %s', server.name, String(error instanceof Error ? error.message : error))
        },
      )
    }
    for (const server of serversOf()) {
      if (!mounts.has(server.id)) tracker.states.delete(server.id)
    }

    // 3) Hybrid promotions: a proxied row may keep a few tools as first-class entries.
    const wantedPromotions = new Set<string>()
    for (const server of enabled) {
      if (server.exposure !== 'hybrid' || decide(server) !== 'proxy') continue
      const signature = JSON.stringify([server.name, server.directTools])
      const existing = promotions.get(server.id)
      if (existing !== undefined && existing.signature === signature) {
        wantedPromotions.add(server.id)
        continue
      }
      if (existing !== undefined) {
        for (const dispose of existing.disposers) { try { dispose() } catch { /* already gone */ } }
        promotions.delete(server.id)
      }
      // Promotion needs metadata, which may not be loaded yet; the next reconcile after
      // `settleProxy` picks it up. Registering a tool with no schema would be worse than waiting.
      if (proxy.listedCount(server.name) === undefined) continue
      let result: ReturnType<ProxyRegistry['registerPromotedTools']>
      try {
        result = proxy.registerPromotedTools(ctx as unknown as { tools: { register(definition: unknown): unknown } }, server)
      } catch (error) {
        ctx.logger.warn('mcp-studio: promoting tools for "%s" failed: %s', server.name, String(error))
        continue
      }
      if (result.missing.length > 0) {
        ctx.logger.warn('mcp-studio: "%s" does not advertise directTools: %s', server.name, result.missing.join(', '))
      }
      promotions.set(server.id, { signature, disposers: result.disposers, names: result.registered })
      wantedPromotions.add(server.id)
    }
    for (const [id, promotion] of [...promotions]) {
      if (wantedPromotions.has(id)) continue
      for (const dispose of promotion.disposers) { try { dispose() } catch { /* already gone */ } }
      promotions.delete(id)
    }

    // 5) The two meta-tools exist only while something is actually proxied — otherwise
    //    they are two more names in the prompt with nothing behind them.
    const anyProxied = enabled.some(server => decide(server) === 'proxy')
    if (anyProxied && metaTools === undefined) {
      try {
        metaTools = proxy.registerMetaTools(ctx as unknown as { tools: { register(definition: unknown): unknown } })
      } catch (error) {
        ctx.logger.warn('mcp-studio: registering proxy meta-tools failed: %s', String(error))
      }
    } else if (!anyProxied && metaTools !== undefined) {
      for (const dispose of metaTools) { try { dispose() } catch { /* already gone */ } }
      metaTools = undefined
    }

    // 6) `auto` rows still waiting on a catalog: go learn, then run me again.
    if (enabled.some(server => decide(server) === 'pending')) void settleProxy()
  }

  // ── Self-healing watchdog: mounted but contributed zero tools → force a remount ──
  // (exponential backoff, capped at 5 minutes)
  //
  // Why this has to exist: mounting only fires on apply and on a config-signature change.
  // The common operator ordering is **start dsh first, then start Burp/Yakit** — so the
  // first connection is doomed, and reconcile never retries just because the service came
  // up later. `note.state` stays "mounted" while the status page shows "unreachable" for
  // want of visible tools, and the UI's "mount now" button is a no-op when the signature is
  // unchanged (same signature → no rebuild). The server is then stuck until a host restart.
  // Observed in practice: service long since available, badge permanently red.
  // The verdict here is driven by *tool visibility* — that is the fact that actually matters
  // to the model.
  const retryBackoff = new Map<string, { attempts: number; nextAt: number }>()
  const WATCHDOG_MS = 15_000
  /**
   * 定时器回调的**异常隔离层**。
   *
   * 这是全插件唯一一处「出错会打挂整个宿主」的地方：`setInterval` 里抛出的异常
   * 无人接管，Node 会直接终止进程（不是坏一个面板，是 **dsh serve 整个没了**，
   * 而用户只会看到界面突然断开）。所以看门狗这一轮无论出什么错都只记日志。
   */
  const watchdogTick = (): void => {
    if (!alive) return
    try {
      tickOnce()
    } catch (error) {
      ctx.logger?.warn?.(`mcp-studio: watchdog tick failed: ${(error as Error)?.message ?? error}`)
    }
  }
  const tickOnce = (): void => {
    // Drop retry entries for servers that were removed or disabled.
    for (const id of [...retryBackoff.keys()]) {
      if (!serversOf().some(server => server.id === id && server.enabled)) retryBackoff.delete(id)
    }
    let view: unknown
    try { view = (ctx.get('tools') as unknown as ToolsServiceHandle | undefined)?.view(void 0) } catch { view = void 0 }
    const visible = typeof view === 'object' && view !== null && (view as { visible?: unknown }).visible instanceof Map
      ? (view as { visible: Map<string, unknown> }).visible
      : undefined
    const now = Date.now()
    let forced = false
    for (const server of serversOf()) {
      if (!server.enabled) continue
      const prefix = `mcp__${server.name}__`
      let count = 0
      if (visible !== undefined) for (const toolName of visible.keys()) if (toolName.startsWith(prefix)) count += 1
      if (decide(server) !== 'direct') {
        // Proxied rows publish no `mcp__` tools at all, so tool visibility can never be
        // their health signal — a readable catalog is. Remounting would not help either:
        // re-listing is the repair, and `ensure` owns that retry.
        if (proxy.hasCatalog(server.name)) { retryBackoff.delete(server.id); continue }
        const state = retryBackoff.get(server.id) ?? { attempts: 0, nextAt: 0 }
        if (now < state.nextAt) continue
        state.attempts += 1
        state.nextAt = now + Math.min(WATCHDOG_MS * 2 ** (state.attempts - 1), 300_000)
        retryBackoff.set(server.id, state)
        ctx.logger.info('mcp-studio: proxy catalog for "%s" unavailable — re-list attempt %d (retry in %dms)', server.name, state.attempts, state.nextAt - now)
        void proxy.ensure(server.name, { force: true }).then(() => { if (alive) reconcile() })
        continue
      }
      if (!mounts.has(server.id)) continue
      if (count > 0) { retryBackoff.delete(server.id); continue }
      const state = retryBackoff.get(server.id) ?? { attempts: 0, nextAt: 0 }
      if (now < state.nextAt) continue
      state.attempts += 1
      state.nextAt = now + Math.min(WATCHDOG_MS * 2 ** (state.attempts - 1), 300_000)
      retryBackoff.set(server.id, state)
      ctx.logger.info('mcp-studio: "%s" mounted but no visible tools — remount attempt %d (retry in %dms)', server.name, state.attempts, state.nextAt - now)
      try { mounts.get(server.id)?.dispose() } catch { /* already disposed */ }
      mounts.delete(server.id)
      tracker.states.delete(server.id)
      forced = true
    }
    if (forced) reconcile()
  }
  const watchdog = setInterval(watchdogTick, WATCHDOG_MS)
  ctx.effect(() => () => clearInterval(watchdog), 'mcp-studio: watchdog')

  ctx.effect(() => () => {
    alive = false
    for (const mount of mounts.values()) {
      try {
        mount.dispose()
      } catch (error) {
        ctx.logger.warn('mcp-studio: mount disposal failed: %s', String(error))
      }
    }
    mounts.clear()
    tracker.states.clear()
    for (const promotion of promotions.values()) {
      for (const dispose of promotion.disposers) { try { dispose() } catch { /* already gone */ } }
    }
    promotions.clear()
    if (metaTools !== undefined) {
      for (const dispose of metaTools) { try { dispose() } catch { /* already gone */ } }
      metaTools = undefined
    }
    // Close proxy channels last: a channel left open holds a child process (stdio) or a
    // socket, and on Windows a surviving child is what turns a later cleanup into EBUSY.
    proxy.closeAll()
  }, 'mcp-studio: lifecycle')

  // dsh 0.1.2: installSettingsSection was removed; register the namespace on
  // the ctx.settings provider instead. The scope supplies resolved values on
  // top of the composition base, mirroring the old setSource/onChange contract.
  try {
    const scope = ctx.settings.register(STUDIO_SETTINGS_NAMESPACE, Config as z<StudioSection>, {
      base: config,
      validate: validateSection,
    })
    current = () => scope.get()
    scope.watch(() => {
      reconcile()
    })
  } catch (error) {
    ctx.logger.warn('mcp-studio: settings provider unavailable, keeping patch baseline: %s', String(error))
  }

  /** Tool-call monitoring over session events, folded into an execution ring served by the status RPC. */
  const executions: ExecutionRing = createExecutionRing(200)
  const inflight = new Map<string, { server: string; tool: string; at: number }>()
  /** Drop call→result pairings that never settled. */
  ctx.effect(() => {
    const sweeper = setInterval(() => {
      const cutoff = Date.now() - 10 * 60_000
      for (const [key, entry] of [...inflight]) {
        if (entry.at < cutoff) inflight.delete(key)
      }
    }, 60_000)
    return () => {
      clearInterval(sweeper)
    }
  }, 'mcp-studio: inflight sweep')
  ctx.on('session/event', ((session: unknown, event: { type: string; time: number; data: Record<string, unknown> }) => {
    if (event.type === 'tool/call') {
      const name = typeof event.data.name === 'string' ? event.data.name : ''
      if (!name.startsWith('mcp__')) return
      const callId = typeof event.data.callId === 'string' ? event.data.callId : ''
      const sessionId = String((session as { id?: unknown }).id ?? '')
      inflight.set(`${sessionId}:${event.time}:${callId}`, {
        server: name.split('__')[1] ?? '',
        tool: name,
        at: event.time,
      })
      return
    }
    if (event.type === 'tool/result') {
      const message = (event.data.message ?? {}) as {
        source?: { kind?: unknown; callId?: unknown }
        content?: ReadonlyArray<{ type?: unknown; toolCallId?: unknown; isError?: unknown }>
      }
      const callId = typeof message.source?.callId === 'string' && message.source?.kind === 'tool'
        ? message.source.callId
        : (message.content ?? []).find(block => typeof block?.toolCallId === 'string')?.toolCallId
      if (typeof callId !== 'string') return
      const sessionId = String((session as { id?: unknown }).id ?? '')
      for (const [key, entry] of [...inflight]) {
        if (!key.startsWith(`${sessionId}:`) || !key.endsWith(`:${callId}`)) continue
        inflight.delete(key)
        const isError = (message.content ?? []).some(block => block?.isError === true) || event.data.error !== undefined
        const errorInfo = event.data.error
        executions.push({
          at: entry.at,
          server: entry.server,
          tool: entry.tool,
          durationMs: Math.max(0, event.time - entry.at),
          ok: !isError,
          ...(isError && errorInfo !== undefined ? { error: JSON.stringify(errorInfo).slice(0, 300) } : {}),
        })
      }
    }
  }) as never)

  ctx.inject(['connection', 'settings', 'webServer'], (web: unknown) => {
    // The callback of ctx.inject() is itself a plugin apply, so its first argument is a
    // Context scoped to these three services — not a bare service bag. Registering the RPC
    // channel through THIS ctx is what makes `connection.register()`'s internal
    // `owner.webServer.register(route)` legal; passing the outer ctx (which only declares
    // ['tools','settings']) threw `cannot get property "webServer" without inject`, and the
    // failure was swallowed by the catch-all around the call, so the page's channel simply
    // never existed while everything else looked healthy.
    const scope = web as Context
    const { connection, settings } = web as { connection: HostConnectionHandle; settings: HostSettingsService }
    const proxyView: ProxyView = {
      catalog: serverName => proxy.catalogFor(serverName).map(meta => ({ name: meta.name, description: meta.description })),
      state: serverName => proxy.stateOf(serverName),
    }
    const status = createStatusHandler(
      () => current(),
      () => (ctx.get('tools') as unknown as ToolsServiceHandle | undefined)?.view(undefined),
      tracker,
      executions,
      { view: proxyView, exposureOf: server => (decide(server) === 'proxy' ? 'proxy' : 'direct') },
    )
    const diagnose = async (id: string): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }> => {
      const server = current().servers.find(row => row.id === id)
      if (server === undefined) {
        return { ok: false, error: { code: 'bad-request', message: `unknown server row "${id}"`, details: {} } }
      }
      const report = await diagnoseServer(server)
      return { ok: true, value: report }
    }
    const debug = (): unknown => {
      const toolsSvc = ctx.get('tools') as unknown as ToolsServiceHandle | undefined
      let view: unknown
      try { view = toolsSvc?.view?.(void 0) } catch { view = 'threw' }
      const names = view !== 'threw' && typeof view === 'object' && view !== null && (view as { visible?: unknown }).visible instanceof Map
        ? [...(view as { visible: Map<string, unknown> }).visible.keys()]
        : null
      return {
        hasToolsService: Boolean(toolsSvc),
        hasViewMethod: typeof toolsSvc?.view === 'function',
        viewKind: view === undefined ? 'undefined' : view === 'threw' ? 'threw' : typeof view,
        globalViewSize: names === null ? null : names.length,
        mcpPrefixed: names === null ? null : names.filter(name => name.startsWith('mcp__')).slice(0, 12),
        sampleNames: names === null ? null : names.slice(0, 12),
        // Tool-surface accounting: this is the number the proxy mode is meant to bring down.
        metaTools: names === null ? null : names.filter(name => name === META_TOOL_SEARCH || name === META_TOOL_CALL),
        promoted: [...promotions.entries()].map(([id, promotion]) => ({ id, tools: promotion.names })),
        proxy: { mounts: proxy.snapshot(), catalog: summarizeCatalog(proxy.catalog()) },
        notes: [...tracker.states.entries()].map(([id, note]) => ({ id, ...note })),
        // Self-healing retry ledger: attempts=0 (absent) means the server's tools are visible,
        // so the watchdog leaves it alone.
        retry: [...retryBackoff.entries()].map(([id, state]) => ({ id, attempts: state.attempts, nextInMs: Math.max(0, state.nextAt - Date.now()) })),
        mountedIds: [...mounts.keys()],
        servers: current().servers.map(server => ({
          id: server.id,
          name: server.name,
          enabled: server.enabled,
          transport: server.transport,
          exposure: server.exposure,
          effective: decide(server),
          proxyThreshold: server.proxyThreshold,
          directTools: server.directTools,
        })),
      }
    }
    registerStudioRpc(scope, connection, settings, STUDIO_SETTINGS_NAMESPACE, status, diagnose, () => executions.clear(), debug)
  })

  reconcile()

  /**
   * Startup readiness barrier. `auto` small catalogs first mount through the proxy,
   * learn their tool count, then switch to a direct mount. Without waiting, the first
   * model request can see 91 tools and the second 94 — a real unstable prompt surface.
   * The wait is bounded so an unreachable MCP server cannot hold host startup forever.
   */
  const STARTUP_MOUNT_SETTLE_MS = 5_000
  const startupDeadline = Date.now() + STARTUP_MOUNT_SETTLE_MS
  const remaining = (): number => Math.max(0, startupDeadline - Date.now())
  const timeout = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  await Promise.race([settleProxy(), timeout(remaining())])
  const directReadiness = [...mounts.values()].map(mount => mount.ready)
  if (directReadiness.length > 0) await Promise.race([Promise.allSettled(directReadiness), timeout(remaining())])
  if (Date.now() >= startupDeadline && mounts.size > 0) {
    ctx.logger.info('mcp-studio: MCP startup still settling after %dms; first request may see a partial tool surface', STARTUP_MOUNT_SETTLE_MS)
  }
}
