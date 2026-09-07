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
} from './settings-rpc.ts'
import { diagnoseServer } from './diagnose.ts'

export const name = 'dsh-mcp-studio'
export const inject = ['tools']

/** Settings namespace owned by this plugin (client and Host spell the same value). */
export const STUDIO_SETTINGS_NAMESPACE = 'mcp-studio'

/** One mounted mcp-client fiber plus the config signature it was built from. */
interface Mount {
  readonly dispose: () => void
  readonly signature: string
}

/** Minimal face of the tools registry the status aggregator needs. */
interface ToolsServiceHandle {
  view(scope?: unknown): unknown
}

function signatureOf(server: ServerEntry): string {
  return JSON.stringify(toMcpClientConfig(server))
}

export function apply(ctx: Context, config: StudioSection): void {
  let current = (): StudioSection => config
  let alive = true
  const mounts = new Map<string, Mount>()
  /** Mount-lifecycle notes, enriched by the registry view on every status read. */
  const tracker: MountTracker = { states: new Map() }

  const reconcile = (): void => {
    if (!alive) return
    const section = current()
    const wanted = new Map<string, ServerEntry>()
    for (const server of section.servers) {
      if (server.enabled) wanted.set(server.id, server)
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
      mounts.set(id, { dispose: () => fiber.dispose(), signature: JSON.stringify(clientConfig) })
      Promise.resolve(fiber).then(
        () => {
          if (tracker.states.get(id)?.state === 'mounting') tracker.states.set(id, { state: 'mounted' })
        },
        (error: unknown) => {
          tracker.states.set(id, { state: 'error', error: error instanceof Error ? error.message : String(error) })
          ctx.logger.warn('mcp-studio: server "%s" failed to start: %s', server.name, String(error instanceof Error ? error.message : error))
        },
      )
    }
    for (const server of section.servers) {
      if (!mounts.has(server.id)) tracker.states.delete(server.id)
    }
  }

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

  ctx.inject(['connection', 'settings'], (web: unknown) => {
    const { connection, settings } = web as { connection: HostConnectionHandle; settings: HostSettingsService }
    const status = createStatusHandler(
      () => current(),
      () => (ctx.get('tools') as unknown as ToolsServiceHandle | undefined)?.view(undefined),
      tracker,
      executions,
    )
    const diagnose = async (id: string): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }> => {
      const server = current().servers.find(row => row.id === id)
      if (server === undefined) {
        return { ok: false, error: { code: 'bad-request', message: `unknown server row "${id}"`, details: {} } }
      }
      const report = await diagnoseServer(server)
      return { ok: true, value: report }
    }
    registerStudioRpc(connection, settings, STUDIO_SETTINGS_NAMESPACE, status, diagnose, () => executions.clear())
  })

  reconcile()
}
