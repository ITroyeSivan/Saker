/** Integration test: mount engine lifecycle, settings seam wiring, loopback RPC registration. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  apply as studioApply,
  inject as studioInject,
  name as studioName,
} from '../src/index.ts'
import type { StudioSection } from '../src/types.ts'
import type { RpcResult } from '../src/settings-rpc.ts'

interface ScopeLike {
  get(): StudioSection
  watch(cb: () => void): () => void
  update(patch: object): Promise<void>
  replace(section: object): Promise<void>
}

class StubTools extends Service {
  readonly registered: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  register(definition: { name: string }): () => void {
    this.registered.push(definition.name)
    return () => {
      this.registered = this.registered.filter(name => name !== definition.name)
    }
  }
  view(): unknown {
    const visible = new Map(this.registered.map(name => [name, { name, description: `desc of ${name}` }]))
    return { visible }
  }
}

class StubSettings extends Service {
  private readonly registrations = new Map<string, { scope: ScopeLike }>()
  constructor(ctx: Context) {
    super(ctx, 'settings')
  }
  register(ns: string, _schema: unknown, options: { base?: unknown }): ScopeLike {
    let user: Record<string, unknown> = {}
    let watcher: (() => void) | undefined
    const resolve = (): StudioSection => ({ ...(options.base as StudioSection), ...user }) as StudioSection
    const scope: ScopeLike = {
      get: () => resolve(),
      watch: cb => {
        watcher = cb
        return () => {
          watcher = undefined
        }
      },
      update: async patch => {
        user = { ...user, ...patch }
        watcher?.()
      },
      replace: async section => {
        user = section as Record<string, unknown>
        watcher?.()
      },
    }
    this.registrations.set(ns, { scope })
    return scope
  }
  commit(ns: string, patch: object): void {
    this.registrations.get(ns)?.scope.update(patch)
  }
  get writable(): boolean {
    return true
  }
  describe(): Array<{ ns: string; value: unknown; revision: number; applies: string }> {
    return [...this.registrations.entries()].map(([ns, { scope }]) => ({ ns, value: scope.get(), revision: 1, applies: 'live' }))
  }
  async mutate(): Promise<void> {}
}

/** Minimal webServer face: `connection.register` routes through the *calling* plugin's
 *  owner.webServer, so the service must be injectable for the RPC surface to come up. */
class StubWebServer extends Service {
  readonly routes: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }
  register(route: { path?: string }): () => void {
    if (typeof route?.path === 'string') this.routes.push(route.path)
    return () => {}
  }
}

class StubConnection extends Service {
  handler: ((endpoint: string, payload: unknown) => Promise<RpcResult>) | undefined
  constructor(ctx: Context) {
    super(ctx, 'connection')
  }
  /**
   * dsh 0.1.5-rc.1 shape: binds the route to the consuming plugin's ctx.
   *
   * The inject assertion below is not decoration. The host's real
   * `connection.register()` does `owner.effect(() => owner.webServer.register(route))`, and
   * cordis only lets a fiber read a service it declared — otherwise
   * `cannot get property "webServer" without inject` (vendor/cordis/src/reflect.ts).
   * Whether that read actually throws depends on the isolate topology between the calling
   * fiber and the provider, so a flat test root can silently allow it: an earlier version of
   * this stub ignored its ctx argument and read nothing, the suite stayed green, and the
   * channel simply never existed in a real host. Asserting the declared dependency directly
   * is topology-independent, which is what a regression guard has to be.
   */
  register(
    ctx: unknown,
    _channel: string,
    handler: (endpoint: string, payload: unknown) => Promise<RpcResult>,
    _options?: unknown,
  ): () => void {
    const owner = ctx as { webServer?: unknown; fiber?: { inject?: Record<string, unknown> } }
    const declared = owner.fiber?.inject
    if (declared === undefined) {
      throw new Error('test stub: connection.register() got something that is not a cordis Context')
    }
    if (!('webServer' in declared)) {
      throw new Error('test stub: connection.register() was given a ctx that never injected webServer — the real host throws "cannot get property \\"webServer\\" without inject" here')
    }
    if (owner.webServer === undefined) {
      throw new Error('test stub: webServer declared but not reachable from the registering ctx')
    }
    this.handler = handler
    return () => {
      this.handler = undefined
    }
  }
  /** Kept so the stub also satisfies any legacy call path. */
  readonly rpc = {
    handle: (_channel: string, handler: (endpoint: string, payload: unknown) => Promise<RpcResult>) => {
      this.handler = handler
      return () => {
        this.handler = undefined
      }
    },
  }
}

test('studio host: mounts per enabled row, hot-swaps on change, serves status RPC', async (t) => {
  const root = new Context()
  const tools = new StubTools(root)
  void tools
  const settings = new StubSettings(root)
  void settings
  const webServer = new StubWebServer(root)
  void webServer
  const connection = new StubConnection(root)
  void connection

  const section: StudioSection = { servers: [] }
  const fiber = root.plugin({ name: studioName, inject: studioInject, apply: studioApply }, section)
  // The watchdog holds a live interval; dispose it even when an assertion throws,
  // otherwise a failing test leaves the process alive and the runner never exits.
  t.after(() => fiber.dispose())
  await fiber
  assert.ok(settings.describe().some(entry => entry.ns === 'mcp-studio'), 'namespace should register')
  assert.ok(connection.handler !== undefined, 'loopback RPC should register')

  const status = async (): Promise<{ servers: Array<{ name: string; state: string }>; summary: Record<string, number> }> => {
    const result = await connection.handler!('status', {})
    assert.ok(result.ok)
    return result.value as { servers: Array<{ name: string; state: string }>; summary: Record<string, number> }
  }

  let initial = await status()
  assert.deepEqual(initial.summary, { total: 0, enabled: 0, connected: 0, tools: 0 })

  // The self-healing ledger must be reachable: it is the evidence trail for a badge that
  // reads "unreachable" while the service is actually up.
  interface DebugShape {
    hasToolsService: boolean
    retry: Array<{ id: string; attempts: number; nextInMs: number }>
    mountedIds: string[]
    servers: Array<{ id: string; enabled: boolean }>
  }
  const debug = async (): Promise<DebugShape> => {
    const result = await connection.handler!('debug', {})
    assert.ok(result.ok)
    return result.value as DebugShape
  }
  const before = await debug()
  assert.equal(before.hasToolsService, true, 'tools service should be visible to diagnostics')
  assert.deepEqual(before.retry, [], 'no retry entries before anything is mounted')
  assert.deepEqual(before.mountedIds, [])

  // A mounted row contributing no tools reads as unreachable, not error.
  settings.commit('mcp-studio', { servers: [{
    id: 's1', enabled: true, name: 'demo', transport: 'stdio', command: 'false',
    argsLine: '', env: {}, cwd: '', url: '', headers: {}, toolCallTimeoutMs: 60_000, failOnStartupError: false,
  }] })
  await new Promise(resolve => setTimeout(resolve, 30))
  let after = await status()
  assert.equal(after.servers[0]!.name, 'demo')
  assert.equal(after.summary.enabled, 1)

  // Disabling every server unmounts and clears state.
  settings.commit('mcp-studio', { servers: [] })
  await new Promise(resolve => setTimeout(resolve, 30))
  after = await status()
  assert.deepEqual(after.summary, { total: 0, enabled: 0, connected: 0, tools: 0 })

  const cleared = await debug()
  assert.deepEqual(cleared.mountedIds, [], 'unmounting must not leave a stale mount behind')
  assert.deepEqual(cleared.retry, [], 'unmounting must clear the retry ledger')
})
