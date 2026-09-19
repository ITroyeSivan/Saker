/**
 * Tool-surface compression for MCP servers.
 *
 * The problem this solves: `mcp-client` registers one model-facing tool per server
 * tool, so a Burp (27) + Yakit (53) pair puts 80 names, descriptions and JSON
 * Schemas into every single turn — while a typical session calls one or two of them.
 *
 * Exposure per server:
 *
 * - `direct`  — the plain `mcp-client` mount (one tool per server tool, current default).
 * - `proxy`   — this module connects on its own and publishes exactly two meta-tools:
 *   `mcp_search` (find a tool by keyword) and `mcp_call` (forward one invocation).
 *   Metadata therefore reaches the model only when it actually looks for something.
 * - `hybrid`  — `proxy`, plus the tools named in `directTools` promoted back to real
 *   `mcp__<server>__<tool>` entries for the two or three the operator calls all day.
 * - `auto`    — `direct` below `proxyThreshold` tools, `proxy` at or above it.
 *
 * `mcp_call` forwards over the same protocol path a direct mount would use, so the
 * server sees an ordinary MCP `tools/call`: nothing server-side depends on the exposure.
 *
 * @module dsh-mcp-studio/proxy
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { handshake, listTools, openChannel, DEFAULT_REQUEST_TIMEOUT_MS, type McpChannel, type RawToolDescriptor } from './transport.ts'
import type { ServerEntry, StudioSection } from './types.ts'

/** Model-facing names of the two meta-tools. */
export const META_TOOL_SEARCH = 'mcp_search'
export const META_TOOL_CALL = 'mcp_call'

/** Re-list a catalog once it is older than this, so `tools/list_changed` needs no handler. */
export const CATALOG_TTL_MS = 5 * 60_000
/** Default `mcp_search` result count. */
export const SEARCH_DEFAULT_LIMIT = 8
/** Hard cap on `mcp_search` results — dumping the catalog is the cost this mode exists to avoid. */
export const SEARCH_MAX_LIMIT = 30
/** Description characters kept per search hit. */
const HIT_DESCRIPTION_CHARS = 140
/** Wait before retrying a server whose connect/handshake/list failed. */
const RETRY_BACKOFF_MS = 10_000

/** One tool as this module remembers it. */
export interface ToolMeta {
  /** Configured server name (the `mcp__<server>__` namespace, unwrapped). */
  readonly server: string
  /** Raw tool name as the server advertises it. */
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

export type ExposureDecision = 'direct' | 'proxy' | 'pending'

/* ── Pure logic (no I/O — the whole search/convert surface is testable offline) ── */

/**
 * Integration-specific contract hints that the upstream MCP server does not carry.
 * Keep these at the front of the description so the bounded `mcp_search` line still
 * retains the action the model must take to avoid a false-negative query.
 */
const TOOL_DESCRIPTION_HINTS: ReadonlyMap<string, string> = new Map([
  [
    'yakit.query_http_flow',
    'sourceType:"all" is required for MCP request flows (mitm misses them); includePath/excludePath are arrays, not strings.',
  ],
])

/** Add a known integration hint without mutating the upstream descriptor. */
export function applyToolHint(server: string, name: string, description: string): string {
  const hint = TOOL_DESCRIPTION_HINTS.get(`${server.toLowerCase()}.${name.toLowerCase()}`)
  if (hint === undefined) return description
  return description.trim() === '' ? hint : `${hint} ${description}`
}

/**
 * Effective exposure for one server.
 * @param server - configured row; `exposure` and `proxyThreshold` are read.
 * @param toolCount - tools the server advertises, or `undefined` before the first list.
 * @returns `direct`, `proxy`, or `pending` — `auto` with an unknown count must keep the
 *   connection alive long enough to learn the count, so it cannot answer yet.
 */
export function decideExposure(server: Pick<ServerEntry, 'exposure' | 'proxyThreshold'>, toolCount: number | undefined): ExposureDecision {
  if (server.exposure === 'direct') return 'direct'
  if (server.exposure === 'proxy' || server.exposure === 'hybrid') return 'proxy'
  if (toolCount === undefined) return 'pending'
  return toolCount >= server.proxyThreshold ? 'proxy' : 'direct'
}

/**
 * Small, high-confidence Chinese-to-English expansion for MCP tool discovery.
 * The tool catalogs are overwhelmingly English while operators commonly search in
 * Chinese; without this, a query such as “HTTP 流量 查询” misses `query_http_flow`
 * because the description says "flow" and "query".
 */
const SEARCH_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['查询', ['query', 'search']],
  ['流量', ['flow', 'traffic']],
  ['抓包', ['mitm', 'capture', 'proxy']],
  ['历史', ['history']],
  ['请求', ['request']],
  ['响应', ['response']],
  ['扫描', ['scan']],
  ['端口', ['port']],
  ['漏洞', ['vuln', 'risk']],
  ['编码', ['encode']],
  ['解码', ['decode']],
  ['浏览器', ['browser']],
  ['代理', ['proxy']],
  ['文件', ['file']],
  ['命令', ['command', 'exec']],
  ['进程', ['process']],
  ['内存', ['memory']],
])

/** Split a query into lowercase tokens on whitespace and common separators. */
export function tokenize(query: unknown): string[] {
  const raw = String(query ?? '')
    .toLowerCase()
    .split(/[\s,;|/]+/)
    .map(token => token.trim())
    .filter(token => token !== '')
  const expanded: string[] = []
  const seen = new Set<string>()
  for (const token of raw) {
    for (const candidate of [token, ...(SEARCH_ALIASES.get(token) ?? [])]) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      expanded.push(candidate)
    }
  }
  return expanded
}

/** Score one tool against query tokens: name hits dominate, an exact name short-circuits. */
export function scoreTool(meta: ToolMeta, tokens: readonly string[]): number {
  if (tokens.length === 0) return 1
  const name = meta.name.toLowerCase()
  const description = meta.description.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (name === token) return 1_000
    if (name.startsWith(token)) score += 60
    else if (name.includes(token)) score += 40
    if (description.includes(token)) score += 8
  }
  return score
}

/** Rank a catalog against a query. Zero-score tools are dropped, so an unmatched query returns nothing. */
export function rankTools(
  metas: readonly ToolMeta[],
  options: { query?: unknown; server?: unknown; limit?: unknown } = {},
): ToolMeta[] {
  const tokens = tokenize(options.query)
  const serverFilter = String(options.server ?? '').trim().toLowerCase()
  const rawLimit = Number(options.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), SEARCH_MAX_LIMIT)
    : SEARCH_DEFAULT_LIMIT
  const pool = serverFilter === ''
    ? metas
    : metas.filter(meta => meta.server.toLowerCase() === serverFilter)
  return pool
    .map(meta => ({ meta, score: scoreTool(meta, tokens) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score
      || left.meta.server.localeCompare(right.meta.server)
      || left.meta.name.localeCompare(right.meta.name))
    .slice(0, limit)
    .map(entry => entry.meta)
}

/** Compact argument hint: declared property names, `?` on optional ones, `…` when the schema is open. */
export function paramHint(inputSchema: unknown): string {
  const schema = (inputSchema ?? {}) as { properties?: unknown; required?: unknown; additionalProperties?: unknown }
  const properties = typeof schema.properties === 'object' && schema.properties !== null
    ? Object.keys(schema.properties as Record<string, unknown>)
    : []
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  const parts = properties.map(key => (required.has(key) ? key : `${key}?`))
  if (schema.additionalProperties === true) parts.push('…')
  return parts.join(', ')
}

/** One catalog line: what the model uses to decide whether a hit is worth calling. */
export function toolLine(meta: ToolMeta): string {
  const hint = paramHint(meta.inputSchema)
  const description = meta.description.replace(/\s+/g, ' ').trim().slice(0, HIT_DESCRIPTION_CHARS)
  return `- ${meta.server}.${meta.name}(${hint})${description === '' ? '' : ` — ${description}`}`
}

/** Render a search result as the model-facing text block. */
export function renderSearchText(
  matches: readonly ToolMeta[],
  context: { query?: unknown; total: number },
): string {
  const query = String(context.query ?? '').trim()
  if (matches.length === 0) {
    return query === ''
      ? '当前没有启用任何被代理的 MCP 工具（编目 0 条）。'
      : `没有匹配「${query}」的 MCP 工具（本轮编目 ${context.total} 条）。换个关键词，或不带关键词列出全部。`
  }
  return [
    `命中 ${matches.length} 条（编目共 ${context.total} 条）：`,
    ...matches.map(toolLine),
    '',
    `调用：${META_TOOL_CALL}(server=..., tool=..., args={...})；args 是按上面括号里的参数名组成的对象。`,
  ].join('\n')
}

/** Per-server catalog sizes, for status/debug output. */
export function summarizeCatalog(metas: readonly ToolMeta[]): Array<{ server: string; tools: number }> {
  const counts = new Map<string, number>()
  for (const meta of metas) counts.set(meta.server, (counts.get(meta.server) ?? 0) + 1)
  return [...counts.entries()]
    .map(([server, tools]) => ({ server, tools }))
    .sort((left, right) => left.server.localeCompare(right.server))
}

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

/**
 * Convert one JSON Schema property into a `defineTool` parameter declaration.
 *
 * Unsupported shapes (unions, const/enum-only, nested) become `json`, which accepts any
 * JSON value. Widening is safe; guessing is not — the registry validates arguments against
 * what we declare, so declaring `string` for a union would reject the very call the model
 * was told to make.
 */
export function toParameterDeclaration(property: unknown): Record<string, unknown> {
  const node = (property ?? {}) as Record<string, unknown>
  const description = typeof node.description === 'string' ? node.description.replace(/\s+/g, ' ').trim() : ''
  const withDescription = (declaration: Record<string, unknown>): Record<string, unknown> =>
    description === '' ? declaration : { ...declaration, description }
  if (node.type === 'array') return withDescription({ type: 'array' })
  if (node.type === 'object') return withDescription({ type: 'object', additionalProperties: true })
  if (typeof node.type !== 'string' || !SCALAR_TYPES.has(node.type)) {
    const note = '（原 schema 为复杂/联合类型，按 JSON 值传入）'
    return { type: 'json', description: description === '' ? note : `${description}${note}` }
  }
  const declaration: Record<string, unknown> = { type: node.type }
  if (Array.isArray(node.enum)) declaration.enum = node.enum
  return withDescription(declaration)
}

/** Build `defineTool` parameters for one raw tool descriptor. */
export function toToolParameters(inputSchema: unknown): Record<string, unknown> {
  const schema = (inputSchema ?? {}) as { properties?: unknown; required?: unknown }
  const properties = typeof schema.properties === 'object' && schema.properties !== null
    ? schema.properties as Record<string, unknown>
    : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  const parameters: Record<string, unknown> = {}
  for (const [key, property] of Object.entries(properties)) {
    parameters[key] = { ...toParameterDeclaration(property), ...(required.has(key) ? { required: true } : {}) }
  }
  return parameters
}

/* ── Runtime: channels, cached catalogs, meta-tools ── */

interface MountNote {
  state: 'connecting' | 'ready' | 'error'
  error?: string
  tools: ToolMeta[]
  listedAt: number
  nextRetryAt: number
}

interface ProxyMount {
  readonly id: string
  readonly name: string
  /** Full connection fingerprint: same id/name is not enough when command/url/env changes. */
  readonly fingerprint: string
  channel: McpChannel
  /** Whether the current channel has completed `initialize`; a replaced channel must handshake again. */
  handshaken: boolean
  note: MountNote
}

export interface CallResult {
  ok: boolean
  text: string
  structured?: unknown
  error?: string
}

/** Connects to proxied servers, caches their catalogs, and answers `mcp_search` / `mcp_call`. */
export class ProxyRegistry {
  private readonly mounts = new Map<string, ProxyMount>()
  /**
   * Last successfully listed tool count per server name, keyed by the row's connection
   * fingerprint. Sticky on purpose. `auto` decides from this number, and the moment it
   * decides "small, mount directly" the server leaves the proxy set — so a count read off
   * the live mount alone forgets itself the instant it is used. That produced a live-only
   * oscillation: pending → proxy (list 3) → direct → pending (count gone) → proxy → … with
   * the direct mount torn down on every lap and the server's tools never staying visible.
   * A learning that survives the mount is what makes the decision a one-way door; editing
   * the row (its fingerprint changes) or calling dropServer() is what opens it again.
   */
  private readonly learned = new Map<string, { count: number; fingerprint: string }>()
  private readonly section: () => StudioSection
  private readonly log: (format: string, ...args: unknown[]) => void

  constructor(
    section: () => StudioSection,
    log: (format: string, ...args: unknown[]) => void = () => {},
  ) {
    this.section = section
    this.log = log
  }

  /**
   * What makes two versions of a row "the same server" for the purposes of a learned count.
   * Deliberately excludes exposure/proxyThreshold/directTools: toggling a row between `auto`
   * and `proxy` must not throw away what we already learned about its catalog size.
   */
  private fingerprintOf(server: ServerEntry): string {
    return JSON.stringify([
      server.name,
      server.transport,
      server.command,
      server.argsLine,
      server.url,
      server.cwd,
      server.env,
    ])
  }

  /** All catalogs, concatenated. */
  catalog(): ToolMeta[] {
    const out: ToolMeta[] = []
    for (const mount of this.mounts.values()) out.push(...mount.note.tools)
    return out
  }

  /** One server's catalog (`[]` when unlisted). */
  catalogFor(serverName: string): ToolMeta[] {
    const mount = this.mountByName(serverName)
    return mount === undefined ? [] : mount.note.tools
  }

  /**
   * A server's catalog size, or `undefined` while it has never answered.
   * The distinction matters: `auto` must not treat "connect not attempted" as "zero tools"
   * and permanently fall back to a direct mount without ever looking.
   *
   * A live reading wins, but a learned one is used when the server is no longer mounted by
   * the proxy — which is the normal state of every `auto` row that resolved to `direct`.
   */
  listedCount(serverName: string): number | undefined {
    const mount = this.mountByName(serverName)
    if (mount !== undefined && mount.note.state === 'ready') return mount.note.tools.length
    const row = this.section().servers.find(server => server.name === serverName)
    if (row === undefined) return undefined
    const learned = this.learned.get(serverName)
    if (learned === undefined || learned.fingerprint !== this.fingerprintOf(row)) return undefined
    return learned.count
  }

  /** Per-server catalog state, for the status page. */
  stateOf(serverName: string): { state: 'connecting' | 'ready' | 'error'; error?: string } | undefined {
    const mount = this.mountByName(serverName)
    if (mount === undefined) return undefined
    return { state: mount.note.state, ...(mount.note.error === undefined ? {} : { error: mount.note.error }) }
  }

  /** Whether a server has a usable catalog — the proxied equivalent of "its tools are visible". */
  hasCatalog(serverName: string): boolean {
    const mount = this.mountByName(serverName)
    return mount !== undefined && mount.note.state === 'ready' && mount.note.tools.length > 0
  }

  /** Per-server state for the status page and `debug`. */
  snapshot(): Array<{ id: string; name: string; state: MountNote['state']; tools: number; error?: string }> {
    return [...this.mounts.values()].map(mount => ({
      id: mount.id,
      name: mount.name,
      state: mount.note.state,
      tools: mount.note.tools.length,
      ...(mount.note.error === undefined ? {} : { error: mount.note.error }),
    }))
  }

  private mountByName(serverName: string): ProxyMount | undefined {
    for (const mount of this.mounts.values()) if (mount.name === serverName) return mount
    return undefined
  }

  private serverOf(id: string): ServerEntry | undefined {
    return this.section().servers.find(server => server.id === id)
  }

  private closeMount(id: string): void {
    const mount = this.mounts.get(id)
    if (mount === undefined) return
    try { mount.channel.close() } catch { /* already closed */ }
    this.mounts.delete(id)
  }

  /** Close everything (plugin unload). */
  closeAll(): void {
    for (const id of [...this.mounts.keys()]) this.closeMount(id)
  }

  /**
   * Reconcile mounts against `list` (the rows whose exposure may be proxied).
   * A row that leaves `list` or changes its name is torn down; a new row gets a channel.
   *
   * Only rows present in `list` are examined for staleness — a row that left because `auto`
   * resolved it to `direct` must keep its learned count, or the decision it just made would
   * be erased on the next reconcile.
   */
  syncServers(list: readonly ServerEntry[]): void {
    const wanted = new Map<string, ServerEntry>()
    for (const server of list) if (server.enabled) wanted.set(server.id, server)
    for (const [id, mount] of [...this.mounts]) {
      const server = wanted.get(id)
      if (server !== undefined && server.name === mount.name && this.fingerprintOf(server) === mount.fingerprint) continue
      this.closeMount(id)
    }
    for (const [id, server] of wanted) {
      // An edited row describes a different server than the one we measured, so the old
      // count is not evidence about this one. Dropping it re-opens the `auto` decision.
      const learned = this.learned.get(server.name)
      if (learned !== undefined && learned.fingerprint !== this.fingerprintOf(server)) {
        this.learned.delete(server.name)
      }
      if (this.mounts.has(id)) continue
      const fingerprint = this.fingerprintOf(server)
      this.mounts.set(id, {
        id,
        name: server.name,
        fingerprint,
        channel: openChannel(server),
        handshaken: false,
        note: { state: 'connecting', tools: [], listedAt: 0, nextRetryAt: 0 },
      })
    }
  }

  /** Forget one mount by server name (used when `auto` resolves to a direct mount instead). */
  dropServer(serverName: string): void {
    const mount = this.mountByName(serverName)
    if (mount !== undefined) this.closeMount(mount.id)
    this.learned.delete(serverName)
  }

  /**
   * Make sure a server's catalog is loaded and fresh. Never throws: failures land in the
   * server's note so `mcp_search` can report them instead of the caller seeing a crash.
   */
  async ensure(serverName: string, options: { force?: boolean } = {}): Promise<MountNote | undefined> {
    const mount = this.mountByName(serverName)
    if (mount === undefined) return undefined
    const server = this.serverOf(mount.id)
    if (server === undefined) return undefined
    // A fresh catalog is only reusable while the channel that produced it is alive.
    // Without this, a crashed stdio child keeps a "fresh" cache for the full TTL and every
    // call goes to the dead pipe instead of reopening the server.
    const fresh = mount.channel.alive
      && mount.note.state === 'ready'
      && Date.now() - mount.note.listedAt < CATALOG_TTL_MS
    if (fresh && options.force !== true) return mount.note
    if (mount.note.state === 'error' && Date.now() < mount.note.nextRetryAt) return mount.note
    const timeoutMs = Math.max(server.toolCallTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
    try {
      // A dead channel cannot be revived: replace it, which also invalidates the handshake.
      if (!mount.channel.alive) {
        try { mount.channel.close() } catch { /* already closed */ }
        mount.channel = openChannel(server)
        mount.handshaken = false
      }
      if (!mount.handshaken) {
        await handshake(mount.channel, 'dsh-mcp-studio-proxy', timeoutMs)
        mount.handshaken = true
      }
      const raw: RawToolDescriptor[] = await listTools(mount.channel, timeoutMs)
      mount.note = {
        state: 'ready',
        tools: raw.map(tool => ({
          server: server.name,
          name: tool.name,
          description: applyToolHint(server.name, tool.name, tool.description),
          inputSchema: tool.inputSchema,
        })),
        listedAt: Date.now(),
        nextRetryAt: 0,
      }
      // Remember the size so `auto` keeps the verdict after the mount goes away.
      this.learned.set(server.name, { count: mount.note.tools.length, fingerprint: this.fingerprintOf(server) })
      return mount.note
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      mount.note = { state: 'error', error: message, tools: [], listedAt: Date.now(), nextRetryAt: Date.now() + RETRY_BACKOFF_MS }
      this.log('mcp-studio: proxy list for "%s" failed: %s', server.name, message)
      return mount.note
    }
  }

  /** Load every proxied server's catalog (mount-time warm-up). */
  async ensureAll(): Promise<void> {
    for (const mount of [...this.mounts.values()]) await this.ensure(mount.name)
  }

  /** Search across all catalogs, refreshing missing or stale ones first. */
  async search(options: { query?: unknown; server?: unknown; limit?: unknown } = {}): Promise<{
    matches: ToolMeta[]
    total: number
    errors: Array<{ name: string; error: string }>
  }> {
    const serverName = String(options.server ?? '').trim()
    if (serverName !== '' && this.mountByName(serverName) !== undefined) await this.ensure(serverName)
    else await this.ensureAll()
    const catalog = this.catalog()
    return {
      matches: rankTools(catalog, options),
      total: catalog.length,
      errors: this.snapshot()
        .filter(entry => entry.state === 'error')
        .map(entry => ({ name: entry.name, error: entry.error ?? 'unknown error' })),
    }
  }

  /** Forward one `tools/call`. */
  async call(serverName: string, tool: string, args: unknown): Promise<CallResult> {
    const name = String(serverName ?? '').trim()
    if (name === '') return { ok: false, text: '', error: `${META_TOOL_CALL} 需要 server 参数（用 ${META_TOOL_SEARCH} 查名字）` }
    const toolName = String(tool ?? '').trim()
    if (toolName === '') return { ok: false, text: '', error: `${META_TOOL_CALL} 需要 tool 参数` }
    const mount = this.mountByName(name)
    if (mount === undefined) {
      const known = [...this.mounts.values()].map(candidate => candidate.name)
      return {
        ok: false,
        text: '',
        error: known.length === 0
          ? '没有可调用的被代理 MCP server。'
          : `未知 server「${name}」；当前被代理的 server：${known.join(', ')}`,
      }
    }
    const server = this.serverOf(mount.id)
    if (server === undefined) return { ok: false, text: '', error: `server「${name}」的配置行已不存在` }
    // Warm the catalog first: it also proves the tool name is real, so a typo is reported
    // as "no such tool" rather than as a confusing server-side error.
    const note = await this.ensure(name)
    if (note === undefined || note.state !== 'ready') {
      return { ok: false, text: '', error: `server「${name}」不可用：${note?.error ?? '目录未就绪'}` }
    }
    if (!note.tools.some(candidate => candidate.name === toolName)) {
      const near = note.tools.map(candidate => candidate.name).filter(candidate => candidate.includes(toolName)).slice(0, 5)
      return {
        ok: false,
        text: '',
        error: `server「${name}」没有工具「${toolName}」${near.length === 0 ? '' : `；名字接近的有：${near.join(', ')}`}（先用 ${META_TOOL_SEARCH} 确认名字）`,
      }
    }
    try {
      const result = await mount.channel.request('tools/call', { name: toolName, arguments: args ?? {} }, server.toolCallTimeoutMs)
      const payload = (result ?? {}) as {
        content?: ReadonlyArray<{ type?: unknown; text?: unknown }>
        structuredContent?: unknown
        isError?: unknown
      }
      const text = (payload.content ?? [])
        .filter(block => typeof block?.text === 'string')
        .map(block => String(block.text))
        .join('\n')
      if (payload.isError === true) return { ok: false, text, error: text === '' ? `工具「${toolName}」返回错误` : text }
      return { ok: true, text: text === '' ? '(该工具没有返回文本内容)' : text, structured: payload.structuredContent ?? null }
    } catch (error) {
      return { ok: false, text: '', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Register `mcp_search` + `mcp_call` against the host tool registry.
   * @returns one disposer per registration, so a reconcile that leaves no proxied server
   *   can withdraw the pair rather than leaving two dead tools in the prompt.
   */
  registerMetaTools(ctx: { tools: { register(definition: unknown): unknown } }): Array<() => void> {
    const disposers: Array<() => void> = []
    const keep = (disposable: unknown): void => {
      if (typeof disposable === 'function') disposers.push(disposable as () => void)
    }
    keep(ctx.tools.register(defineTool({
      name: META_TOOL_SEARCH,
      description: '检索已接入的 MCP server 工具目录（关键词匹配工具名与描述，返回工具名、参数名与一句话说明）。'
        + '被代理（proxy/hybrid/auto）的 server 不会把每个工具单独暴露给模型，所以调用前先用本工具找名字。'
        + '不带 query 列出全部（受 limit 限制）；只给 server 则列出该 server 的全部工具。'
        + `查到后用 ${META_TOOL_CALL} 调用。`,
      parameters: {
        query: { type: 'string', description: '关键词（空格分隔多个，如：scan url）；留空列出全部' },
        server: { type: 'string', description: '限定某个 server（配置里的 name）' },
        limit: { type: 'number', description: `返回条数（默认 ${SEARCH_DEFAULT_LIMIT}，上限 ${SEARCH_MAX_LIMIT}）` },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: typeof (value as { text?: unknown }).text === 'string' ? String((value as { text: string }).text) : '' }],
      },
      execute: async (args) => {
        const result = await this.search({ query: args.query, server: args.server, limit: args.limit })
        const base = renderSearchText(result.matches, { query: args.query, total: result.total })
        const suffix = result.errors.length === 0
          ? ''
          : `\n\n以下 server 暂时取不到目录（不影响其它 server）：\n${result.errors.map(entry => `- ${entry.name}：${entry.error}`).join('\n')}`
        return { ok: true, count: result.matches.length, total: result.total, text: base + suffix }
      },
    })))

    keep(ctx.tools.register(defineTool({
      name: META_TOOL_CALL,
      description: '调用被代理的 MCP server 上的某个工具（server/tool 用 '
        + `${META_TOOL_SEARCH} 查到的名字；args 是按该工具参数名组成的对象）。`
        + '工具名写错会在本地就被拦下并给出相近名字，不会打到 server。返回值原样带回。',
      parameters: {
        server: { type: 'string', required: true, description: 'server 名（配置里的 name）' },
        tool: { type: 'string', required: true, description: '工具名（server 侧原始名，不含 mcp__ 前缀）' },
        args: { type: 'json', description: '该工具的调用参数对象，如 {"url":"http://x"}' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
        render: (_args, value) => [{
          type: 'text',
          text: typeof (value as { text?: unknown }).text === 'string' && String((value as { text: string }).text) !== ''
            ? String((value as { text: string }).text)
            : String((value as { error?: unknown }).error ?? ''),
        }],
      },
      execute: async (args) => {
        const result = await this.call(args.server, args.tool, args.args)
        if (result.ok) {
          return {
            ok: true,
            text: result.text,
            ...(result.structured === undefined || result.structured === null ? {} : { structured: result.structured }),
          }
        }
        return { ok: false, error: result.error ?? 'call failed', text: result.error ?? 'call failed' }
      },
    })))

    return disposers
  }

  /**
   * Register the `directTools` of a hybrid server as real `mcp__<server>__<tool>` entries.
   * @returns the registered names, the names with no metadata (server does not advertise
   *   them), and a disposer per registration so a reconfigure can undo it.
   */
  registerPromotedTools(
    ctx: { tools: { register(definition: unknown): unknown } },
    server: Pick<ServerEntry, 'name' | 'directTools'>,
  ): { registered: string[]; missing: string[]; disposers: Array<() => void> } {
    const catalog = this.catalogFor(server.name)
    const registered: string[] = []
    const missing: string[] = []
    const disposers: Array<() => void> = []
    for (const rawName of server.directTools) {
      const meta = catalog.find(candidate => candidate.name === rawName)
      if (meta === undefined) {
        missing.push(rawName)
        continue
      }
      const publicName = `mcp__${server.name}__${rawName}`
      const description = meta.description.trim() === ''
        ? `MCP 工具 ${server.name}.${rawName}（server 未提供描述）。`
        : meta.description
      const dispose = ctx.tools.register(defineTool({
        name: publicName,
        description,
        parameters: toToolParameters(meta.inputSchema),
        output: {
          schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
          render: (_args, value) => [{
            type: 'text',
            text: typeof (value as { text?: unknown }).text === 'string' && String((value as { text: string }).text) !== ''
              ? String((value as { text: string }).text)
              : String((value as { error?: unknown }).error ?? ''),
          }],
        },
        execute: async (args) => {
          const result = await this.call(server.name, rawName, args)
          if (result.ok) {
            return {
              ok: true,
              text: result.text,
              ...(result.structured === undefined || result.structured === null ? {} : { structured: result.structured }),
            }
          }
          return { ok: false, error: result.error ?? 'call failed', text: result.error ?? 'call failed' }
        },
      }))
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      registered.push(publicName)
    }
    return { registered, missing, disposers }
  }
}
