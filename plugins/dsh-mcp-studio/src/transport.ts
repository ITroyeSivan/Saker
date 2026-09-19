/**
 * Persistent MCP channel: one long-lived connection per server with `request` /
 * `notify` / `close`, over either a spawned stdio child or Streamable HTTP.
 *
 * Why this exists apart from `diagnose.ts`: the connection diagnosis and the proxy
 * exposure mode need the *same* wire behaviour (session-id bookkeeping, SSE frame
 * parsing, notification semantics). Keeping two copies means fixing every protocol
 * quirk twice, and the second copy is always the one that rots.
 *
 * @module dsh-mcp-studio/transport
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { splitArgs } from './types.ts'
import type { ServerEntry } from './types.ts'

/** Default per-request timeout when the caller does not supply one. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export interface McpChannel {
  /** Send one request and resolve with its `result`; rejects on error, timeout, or disconnect. */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
  /** Send one notification (no id, no response expected). */
  notify(method: string, params?: unknown): void
  /** Whether the underlying transport is still usable. */
  readonly alive: boolean
  /** Tear the connection down. Safe to call repeatedly. */
  close(): void
  /** Why the channel ended, when it ended unexpectedly. */
  readonly closedReason?: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * 统一出站策略（跨插件契约）：包运行器首次启动会从公网 registry 拉包，属于 infra 出站。
 * 契约文件与判定语义见根包 `dsh-saker/lib/egress.js`；这里**同步**读同一份策略文件，
 * 因为 `stdioChannel` 是同步的，而动态 import 是异步的——把整条 openChannel 链改成
 * async 不值得。两边判定必须一致，由 `scripts/test-egress-policy-consistency.mjs` 锁住。
 */
const PACKAGE_RUNNER_HOSTS: Record<string, string> = {
  npx: 'registry.npmjs.org',
  npm: 'registry.npmjs.org',
  pnpm: 'registry.npmjs.org',
  bunx: 'registry.npmjs.org',
  yarn: 'registry.yarnpkg.com',
  uvx: 'pypi.org',
  pipx: 'pypi.org',
}
const EGRESS_MODES = ['allow', 'allowlist', 'frozen']

/** 命令是包运行器时返回它要访问的 registry 主机；普通可执行文件返回空串。 */
export function runnerRegistryHost(command: string): string {
  const base = String(command ?? '').trim().split(/[\\/]/).pop()?.toLowerCase().replace(/\.(cmd|exe|ps1|bat)$/, '') ?? ''
  return PACKAGE_RUNNER_HOSTS[base] ?? ''
}

function egressHome(): string {
  // 平台数据根统一跟随 $DSH_HOME，缺省回落 ~/.dsh（与其它插件的规范形态一致）
  const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
  return DSH_HOME
}

function readEgressPolicy(): { mode: string; allowHosts: string[] } {
  try {
    const raw = JSON.parse(readFileSync(join(egressHome(), 'saker-egress', 'policy.json'), 'utf8')) as Record<string, unknown>
    const mode = EGRESS_MODES.includes(String(raw.mode)) ? String(raw.mode) : 'allow'
    const allowHosts = Array.isArray(raw.allowHosts)
      ? raw.allowHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean)
      : []
    return { mode, allowHosts }
  } catch {
    return { mode: 'allow', allowHosts: [] }
  }
}

function hostAllowed(host: string, allowHosts: string[]): boolean {
  for (const rule of allowHosts) {
    if (rule === host) return true
    if (/^[0-9a-f:.]+$/.test(rule)) continue
    if (host.endsWith(`.${rule}`)) return true
  }
  return false
}

function appendEgressAudit(entry: Record<string, unknown>): void {
  try {
    const file = join(egressHome(), 'saker-egress', 'audit.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), plugin: 'dsh-mcp-studio', kind: 'infra', ...entry })}\n`, 'utf8')
  } catch { /* 审计不能反过来打断启动路径 */ }
}

/**
 * 包运行器出站判定（同步）。非包运行器返回 `{ decision: 'allow', reason: 'no-registry-fetch' }`，
 * 因为本地已装可执行文件不产生下载流量。
 */
export function evaluateRunnerEgress(server: ServerEntry): { decision: 'allow' | 'deny'; reason: string; mode: string; host: string } {
  const host = runnerRegistryHost(server.command)
  if (host === '') return { decision: 'allow', reason: 'no-registry-fetch', mode: 'allow', host: '' }
  const policy = readEgressPolicy()
  let decision: 'allow' | 'deny' = 'allow'
  let reason = 'allow-all'
  if (policy.mode === 'frozen') { decision = 'deny'; reason = 'infra_frozen' }
  else if (policy.mode === 'allowlist') {
    decision = hostAllowed(host, policy.allowHosts) ? 'allow' : 'deny'
    reason = decision === 'allow' ? 'allowlisted' : 'not_allowed'
  }
  appendEgressAudit({ host, decision, reason, mode: policy.mode, note: `${server.name} ${server.command}` })
  return { decision, reason, mode: policy.mode, host }
}

/** 被策略拦下的通道：不 spawn、任何请求都带原因失败（错误会落到该 server 的 note 上）。 */
function blockedChannel(reason: string): McpChannel {
  return {
    get alive() { return false },
    get closedReason() { return reason },
    request() { return Promise.reject(new Error(reason)) },
    notify() { throw new Error(reason) },
    close() { /* nothing to close */ },
  }
}

/** JSON-RPC over a spawned child process (newline-delimited). */
function stdioChannel(server: ServerEntry): McpChannel {
  const gate = evaluateRunnerEgress(server)
  if (gate.decision === 'deny') {
    return blockedChannel(
      `统一出站策略拦截（${gate.reason} / mode=${gate.mode}）：${server.command} 需要访问 ${gate.host} 拉包。` +
      '改档位：设置 → 安全配置 → 出站策略。',
    )
  }
  const child: ChildProcess = spawn(server.command, splitArgs(server.argsLine), {
    cwd: server.cwd === '' ? undefined : server.cwd,
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map<number, Pending>()
  let buffer = ''
  let nextId = 1
  let alive = true
  let closedReason: string | undefined

  const failAll = (reason: string): void => {
    if (!alive) return
    alive = false
    closedReason = reason
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
      pending.delete(id)
    }
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const frame = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (frame === '') continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(frame) as Record<string, unknown>
      } catch {
        continue // Non-JSON noise on stdout belongs to the server's own logging.
      }
      const id = typeof message.id === 'number' ? message.id : undefined
      if (id === undefined) continue
      const entry = pending.get(id)
      if (entry === undefined) continue
      pending.delete(id)
      clearTimeout(entry.timer)
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', () => { /* server logs: expected, not surfaced here */ })
  child.on('error', (error: Error) => failAll(`child process error: ${error.message}`))
  child.on('exit', (code, signal) => failAll(`server exited (code ${String(code)}, signal ${String(signal)})`))
  // A child can close stdin before process `exit` fires. The write callback may then emit
  // EPIPE asynchronously; without this listener Node treats it as an unhandled stream error
  // and takes down the whole dsh host.
  child.stdin?.on('error', (error: Error) => failAll(`stdio write failed: ${error.message}`))
  child.stdin?.on('close', () => failAll('stdio input closed'))

  const write = (payload: unknown): void => {
    if (!alive) throw new Error(closedReason ?? 'channel closed')
    const stdin = child.stdin
    if (stdin === null || stdin.destroyed || !stdin.writable) throw new Error('stdio input is not writable')
    stdin.write(`${JSON.stringify(payload)}\n`)
  }

  return {
    get alive() { return alive },
    get closedReason() { return closedReason },
    request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      return new Promise<unknown>((resolve, reject) => {
        if (!alive) {
          reject(new Error(closedReason ?? 'channel closed'))
          return
        }
        const id = nextId++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`request "${method}" timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    notify(method, params) {
      try {
        write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
      } catch { /* a dead channel cannot carry notifications; the caller sees it on the next request */ }
    },
    close() {
      failAll('channel closed by caller')
      try { child.kill() } catch { /* already gone */ }
    },
  }
}

/** JSON-RPC over Streamable HTTP: one POST per request, a fresh id per call. */
function httpChannel(server: ServerEntry): McpChannel {
  const url = new URL(server.url)
  // Streamable-HTTP servers (Yakit, Kali 武器库, …) hand out an Mcp-Session-Id in the
  // initialize response; every later request must echo it or the server answers
  // 400 "Missing session ID". A preset header wins so operators can pin a session.
  let sessionId = String(
    Object.entries(server.headers ?? {}).find(([key]) => key.toLowerCase() === 'mcp-session-id')?.[1] ?? '',
  ).trim()
  let nextId = 1
  let alive = true
  let closedReason: string | undefined

  const post = async (message: Record<string, unknown>, timeoutMs: number): Promise<Array<Record<string, unknown>>> => {
    const isNotification = typeof message.method === 'string' && message.id === undefined
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...server.headers,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!sessionId) {
      const issued = response.headers.get('mcp-session-id')?.trim()
      if (issued) sessionId = issued
    }
    // Notifications legitimately answer 202/empty — never look at their bodies.
    if (isNotification) return []
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const contentType = response.headers.get('content-type') ?? ''
    const text = await response.text()
    if (text.trim() === '') throw new Error(`empty response body from ${server.url}`)
    const out: Array<Record<string, unknown>> = []
    if (contentType.includes('text/event-stream')) {
      for (const frame of text.split('\n')) {
        if (!frame.startsWith('data:')) continue
        const payload = frame.slice(5).trim()
        if (payload === '') continue
        try {
          out.push(JSON.parse(payload) as Record<string, unknown>)
        } catch { /* keep scanning frames */ }
      }
    } else {
      out.push(JSON.parse(text) as Record<string, unknown>)
    }
    return out
  }

  return {
    get alive() { return alive },
    get closedReason() { return closedReason },
    async request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      if (!alive) throw new Error(closedReason ?? 'channel closed')
      const id = nextId++
      let responses: Array<Record<string, unknown>>
      try {
        responses = await post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, timeoutMs)
      } catch (error) {
        // A transport-level failure (timeout, ECONNREFUSED, non-2xx) means the
        // connection is gone; mark it so callers stop retrying against a dead socket.
        if (error instanceof Error && !/^HTTP 4\d\d/.test(error.message)) {
          alive = false
          closedReason = error.message
        }
        throw error instanceof Error ? error : new Error(String(error))
      }
      const match = responses.find(candidate => candidate.id === id)
      if (match === undefined) throw new Error(`no response for "${method}" (id ${id})`)
      if (match.error !== undefined) throw new Error(JSON.stringify(match.error))
      return match.result
    },
    notify(method, params) {
      if (!alive) return
      void post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }, DEFAULT_REQUEST_TIMEOUT_MS)
        .catch(() => { /* notifications are fire-and-forget by design */ })
    },
    close() {
      alive = false
      closedReason = 'channel closed by caller'
    },
  }
}

/** Open one channel to the configured server. Throws only on configuration problems, not on wire failures. */
export function openChannel(server: ServerEntry): McpChannel {
  return server.transport === 'streamable-http' ? httpChannel(server) : stdioChannel(server)
}

export interface HandshakeResult {
  readonly protocolVersion?: string
  readonly serverName?: string
  readonly serverVersion?: string
}

/** Run the MCP opening handshake on an already-open channel. */
export async function handshake(channel: McpChannel, clientName = 'dsh-mcp-studio', timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<HandshakeResult> {
  const result = await channel.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: clientName, version: '0.1.0' },
  }, timeoutMs)
  channel.notify('notifications/initialized')
  const info = (result ?? {}) as Record<string, unknown>
  const serverInfo = (info.serverInfo ?? {}) as Record<string, unknown>
  return {
    ...(typeof info.protocolVersion === 'string' ? { protocolVersion: info.protocolVersion } : {}),
    ...(typeof serverInfo.name === 'string' ? { serverName: serverInfo.name } : {}),
    ...(typeof serverInfo.version === 'string' ? { serverVersion: serverInfo.version } : {}),
  }
}

/** One raw tool descriptor as the server advertises it. */
export interface RawToolDescriptor {
  readonly name: string
  readonly description: string
  /** JSON Schema for the arguments, kept verbatim so a proxy call can pass it back on demand. */
  readonly inputSchema: unknown
}

/** Read the server's tool catalog over an already-handshaken channel. */
export async function listTools(channel: McpChannel, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<RawToolDescriptor[]> {
  const result = await channel.request('tools/list', {}, timeoutMs)
  const tools = (result as { tools?: unknown } | undefined)?.tools
  if (!Array.isArray(tools)) return []
  return tools
    .filter((tool): tool is Record<string, unknown> => typeof tool === 'object' && tool !== null)
    .map(tool => ({
      name: typeof tool.name === 'string' ? tool.name : '',
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: tool.inputSchema ?? {},
    }))
    .filter(tool => tool.name !== '')
}
