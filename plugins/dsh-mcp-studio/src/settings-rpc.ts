/**
 * Loopback RPC surface for the Web page, all scoped to this plugin:
 * settings/get|mutate (namespace-scoped settings seam proxy), status
 * (live per-server state + tool catalog), diagnose, executions/clear.
 */
import type { ServerEntry, StudioSection } from './types.ts'

export const STUDIO_CHANNEL = '/dsh-mcp-studio'

export type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** Fields a client may write; anything else is rejected before the seam. */
const WRITABLE_FIELDS = new Set(['servers'])

export interface StudioSettingsDescriptor {
  readonly status: 'ready'
  readonly value: unknown
  readonly base?: unknown
  readonly user?: unknown
  readonly revision: number
  readonly writable: boolean
  readonly mode: 'host'
  readonly applies?: unknown
}

export interface HostSettingsService {
  readonly writable: boolean
  describe(options?: { redactSecrets?: boolean }): Array<{
    ns: string
    value: unknown
    base?: unknown
    user?: unknown
    revision: number
    applies?: unknown
  }>
  mutate(
    ns: string,
    ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }>,
    expectedRevision?: number,
  ): Promise<void>
}

/**
 * dsh 0.1.5-rc.1: `connection.register(ctx, ...)` is the supported entry — it binds the
 * route to the *calling* plugin's ctx so that `owner.webServer.register(...)` runs against
 * the consuming plugin, not against the connection service's own ctx. `rpc.handle` (the
 * 0.1.4 shape) silently fails to register under 0.1.5: the route 404s and the settings page
 * hangs on "loading". Keep the legacy member on the type only so older hosts still typecheck.
 */
export interface HostConnectionHandle {
  register(
    ctx: unknown,
    channel: string,
    handler: (endpoint: string, payload: unknown) => Promise<RpcResult>,
    options: { authority: 'trusted-host' | 'loopback' },
  ): unknown
  rpc?: {
    handle(channel: string, handler: (endpoint: string, payload: unknown) => Promise<RpcResult>, options: { authority: 'trusted-host' | 'loopback' }): unknown
  }
}

function ok(value: unknown): RpcResult {
  return { ok: true, value }
}

function failure(error: unknown, ns: string): RpcResult {
  return {
    ok: false,
    error: {
      code: 'settings-rejected',
      message: error instanceof Error ? error.message : String(error),
      details: { ns },
    },
  }
}

function badRequest(message: string): RpcResult {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('payload must be an object')
  return value as Record<string, unknown>
}

function descriptor(settings: HostSettingsService, ns: string): StudioSettingsDescriptor {
  const view = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === ns)
  if (view === undefined) throw new Error(`settings namespace "${ns}" is unavailable`)
  return {
    status: 'ready',
    value: view.value,
    ...(view.base === undefined ? {} : { base: view.base }),
    ...(view.user === undefined ? {} : { user: view.user }),
    revision: view.revision,
    writable: settings.writable,
    mode: 'host',
    ...(view.applies === undefined ? {} : { applies: view.applies }),
  }
}

/* Tool-call execution records (fed by the session event stream). */

export interface ExecutionRecord {
  readonly at: number
  readonly server: string
  readonly tool: string
  readonly durationMs: number
  readonly ok: boolean
  readonly error?: string
}

export interface ExecutionRing {
  readonly max: number
  push(record: ExecutionRecord): void
  recent(limit: number): readonly ExecutionRecord[]
  clear(): void
}

export function createExecutionRing(max = 200): ExecutionRing {
  const records: ExecutionRecord[] = []
  return {
    max,
    push: record => {
      records.push(record)
      if (records.length > max) records.splice(0, records.length - max)
    },
    recent: limit => records.slice(-limit).reverse(),
    clear: () => {
      records.splice(0, records.length)
    },
  }
}

/* Live status aggregation over the tool registry. */

export interface ToolView {
  readonly name: string
  readonly description: string
}

export type ServerState = 'disabled' | 'mounting' | 'connected' | 'unreachable' | 'error'

export interface ServerStatus {
  readonly id: string
  readonly name: string
  readonly transport: string
  readonly state: ServerState
  readonly error?: string
  readonly toolCount: number
  readonly tools: readonly ToolView[]
  /** Effective tool exposure for this row: `direct` or `proxy`. */
  readonly exposure?: 'direct' | 'proxy'
}

/**
 * Proxied servers contribute no `mcp__<name>__*` tools, so tool visibility can no longer
 * be the health signal. The catalog is: if we can list it, the server is reachable.
 */
export interface ProxyView {
  readonly catalog: (serverName: string) => ReadonlyArray<ToolView>
  readonly state: (serverName: string) => { state: 'connecting' | 'ready' | 'error'; error?: string } | undefined
}

export interface StudioStatus {
  readonly servers: readonly ServerStatus[]
  readonly summary: { readonly total: number; readonly enabled: number; readonly connected: number; readonly tools: number }
  readonly executions?: readonly ExecutionRecord[]
  readonly execCapacity?: number
}

/** Mount lifecycle notes the mount engine records as fibers settle. */
export interface MountTracker {
  readonly states: Map<string, { state: 'mounting' | 'mounted' | 'error'; error?: string }>
}

function asToolsViewHandle(view: unknown): { visible: ReadonlyMap<string, { name: string; description?: unknown }> } | undefined {
  if (typeof view !== 'object' || view === null) return undefined
  const visible = (view as { visible?: unknown }).visible
  if (!(visible instanceof Map)) return undefined
  return view as { visible: ReadonlyMap<string, { name: string; description?: unknown }> }
}

/** Build the status getter: per enabled server, aggregate its tools out of the registry view (direct) or its catalog (proxy). */
export function createStatusHandler(
  section: () => StudioSection,
  viewOf: () => unknown,
  tracker: MountTracker,
  executions?: ExecutionRing,
  proxy?: { view: ProxyView; exposureOf: (server: ServerEntry) => 'direct' | 'proxy' },
): () => Promise<RpcResult> {
  return async (): Promise<RpcResult> => {
    const current = section()
    const view = asToolsViewHandle(viewOf())
    const servers: ServerStatus[] = []
    let connected = 0
    let totalTools = 0
    for (const server of current.servers) {
      const prefix = `mcp__${server.name}__`
      const tools: ToolView[] = []
      const effective = server.enabled && proxy !== undefined ? proxy.exposureOf(server) : 'direct'
      let proxiedState: { state: 'connecting' | 'ready' | 'error'; error?: string } | undefined
      let proxiedError: string | undefined
      if (server.enabled && effective === 'proxy' && proxy !== undefined) {
        for (const tool of proxy.view.catalog(server.name)) tools.push({ name: tool.name, description: tool.description })
        tools.sort((left, right) => left.name.localeCompare(right.name))
        proxiedState = proxy.view.state(server.name)
        proxiedError = proxiedState?.error
      } else if (view !== undefined && server.enabled) {
        for (const [name, definition] of view.visible) {
          if (!name.startsWith(prefix)) continue
          tools.push({ name: name.slice(prefix.length), description: typeof definition.description === 'string' ? definition.description : '' })
        }
        tools.sort((left, right) => left.name.localeCompare(right.name))
      }
      const note = tracker.states.get(server.id)
      let state: ServerState
      let error: string | undefined
      if (!server.enabled) state = 'disabled'
      else if (effective === 'proxy') {
        if (proxiedState === undefined) state = 'unreachable'
        else if (proxiedState.state === 'ready') state = 'connected'
        else if (proxiedState.state === 'connecting') state = 'mounting'
        else state = 'error'
        error = proxiedError
      } else if (tools.length > 0) state = 'connected'
      else if (note?.state === 'error') {
        state = 'error'
        error = note.error
      } else if (note?.state === 'mounting') state = 'mounting'
      else state = 'unreachable'
      if (state === 'connected') connected += 1
      totalTools += tools.length
      servers.push({
        id: server.id,
        name: server.name,
        transport: server.transport,
        state,
        ...(error === undefined ? {} : { error }),
        toolCount: tools.length,
        tools,
        exposure: effective,
      })
    }
    const enabled = servers.filter(server => server.state !== 'disabled').length
    return ok({
      servers,
      summary: { total: servers.length, enabled, connected, tools: totalTools },
      ...(executions === undefined ? {} : { executions: executions.recent(executions.max), execCapacity: executions.max }),
    })
  }
}

export function registerStudioRpc(
  ctx: unknown,
  connection: HostConnectionHandle,
  settings: HostSettingsService,
  ns: string,
  status: () => Promise<RpcResult>,
  diagnose?: (id: string) => Promise<RpcResult>,
  clearExecutions?: () => void,
  debug?: () => unknown,
): void {
  connection.register(ctx, STUDIO_CHANNEL, async (endpoint, rawPayload): Promise<RpcResult> => {
    if (endpoint === 'status') return status()
    // Read-only diagnostics: expose *why* the badge reads the way it does — whether the tool
    // view resolved, which `mcp__` tools the global view actually holds, and each server's
    // mount note. The badge only reflects tool visibility, so without the intermediate values
    // a "diagnose says reachable / badge says unreachable" split is undebuggable.
    if (endpoint === 'debug') {
      if (debug === undefined) return badRequest('debug unavailable')
      return ok(debug())
    }
    if (endpoint === 'executions/clear') {
      if (clearExecutions === undefined) return badRequest('execution log unavailable')
      clearExecutions()
      return ok({ cleared: true })
    }
    if (endpoint === 'diagnose') {
      if (diagnose === undefined) return badRequest('diagnose unavailable')
      const id = typeof (rawPayload as { id?: unknown } | null)?.id === 'string' ? (rawPayload as { id: string }).id : ''
      return diagnose(id)
    }
    try {
      if (endpoint === 'settings/get') return ok(descriptor(settings, ns))
      if (endpoint === 'settings/mutate') {
        if (!settings.writable) throw new Error('DSH settings are read-only')
        const payload = asObject(rawPayload)
        const rawOps = payload.ops
        if (!Array.isArray(rawOps) || rawOps.length === 0 || rawOps.length > 4) throw new Error('ops must contain 1..4 settings edits')
        const ops = rawOps.map((raw): { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] } => {
          const op = asObject(raw)
          const path = op.path
          if (!Array.isArray(path) || path.length !== 1 || !WRITABLE_FIELDS.has(String(path[0]))) {
            throw new Error(`unsupported mcp-studio settings path: ${JSON.stringify(path)}`)
          }
          if (op.op === 'unset') return { op: 'unset', path: [String(path[0])] }
          if (op.op !== 'set') throw new Error(`unsupported settings operation: ${String(op.op)}`)
          return { op: 'set', path: [String(path[0])], value: op.value }
        })
        const revision = payload.expectedRevision === undefined ? undefined : Number(payload.expectedRevision)
        await settings.mutate(ns, ops, revision)
        return ok(descriptor(settings, ns))
      }
      return badRequest(`unknown endpoint: ${endpoint}`)
    } catch (error) {
      return failure(error, ns)
    }
  }, { authority: 'loopback' })
}

export type { ServerEntry }
