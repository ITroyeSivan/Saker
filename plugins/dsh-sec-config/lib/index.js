// dsh-sec-config — host plugin.
// Owns the `sec-config` settings namespace (local tool paths, service endpoints,
// DNSLog, API keys), serves a loopback RPC for the settings page, and injects
// the configured tool paths into the agent shell as DSH_TOOL_* variables so the
// pentest/audit playbooks can discover tools without hardcoded paths.
//
// Bridges `services.burpUrl` / `services.yakitUrl` into mcp-studio.servers so
// editing these endpoints in the "安全配置" page also feeds the model's MCP tool
// registry (mcp__burp__* / mcp__yakit__*) — saves the operator a second trip
// to the "MCP 工作台" for the same source-of-truth data.
import z from '@deepseek-ai/schemastery'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-sec-config'
export const inject = ['connection', 'settings', 'shellEnv', 'systemPrompt']

const NAMESPACE = 'sec-config'
const CHANNEL = '/dsh-sec-config'
const MCP_STUDIO_NAMESPACE = 'mcp-studio'

/**
 * Preset tool definitions shown in the 安全配置 page, grouped by category.
 * The page lets the operator pick from this list, add their own custom tools
 * (arbitrary key), or remove any entry — the manifest below always reflects the
 * live tools object (preset keys + custom keys), and every preset key is
 * injected into the shell as DSH_TOOL_<NAME>.
 */
export const TOOL_PRESETS = [
  { key: 'subfinder', label: 'Subfinder', category: '信息收集' },
  { key: 'httpx', label: 'Httpx', category: '信息收集' },
  { key: 'nmap', label: 'Nmap', category: '信息收集' },
  { key: 'nuclei', label: 'Nuclei', category: '漏洞扫描' },
  { key: 'afrog', label: 'Afrog', category: '漏洞扫描' },
  { key: 'fscan', label: 'Fscan', category: '漏洞扫描' },
  { key: 'dirsearch', label: 'Dirsearch', category: '目录与接口' },
  { key: 'katana', label: 'Katana', category: '目录与接口' },
  { key: 'ffuf', label: 'Ffuf', category: '目录与接口' },
  { key: 'sqlmap', label: 'SQLMap', category: '注入与利用' },
  { key: 'jwt_tool', label: 'JWT Tool', category: '令牌与认证' },
]

export const TOOL_CATEGORIES = ['信息收集', '漏洞扫描', '目录与接口', '注入与利用', '令牌与认证']

/** Preset tool keys whose paths the shell receives as DSH_TOOL_<NAME>. */
const TOOL_KEYS = TOOL_PRESETS.map((t) => t.key)

/** Custom (operator-defined) tool keys may also be configured; they are listed
 * in the prompt manifest and callable via PATH, but are not declared as
 * DSH_TOOL_* shell variables (the shell-env registry requires a static
 * declaration set at registration time). */
const TOOL_KEY_RE = /^[A-Za-z0-9_]+$/

function isToolKey(key) {
  return typeof key === 'string' && TOOL_KEY_RE.test(key) && key.length <= 40
}

/** Fields the client may write through settings/mutate. */
const WRITABLE_FIELDS = new Set(['tools', 'services', 'dnslog', 'apiKeys', 'scanRoots'])

/** Secret-bearing fields: redacted on read; an empty/`***` write is ignored. */
const SECRET_FIELDS = new Set(['dnslog.token', 'apiKeys.deepseekKey'])

/**
 * Default search paths for the Burp MCP stdio proxy JAR. The Burp
 * `burp-mcp-all.jar` ships the proxy logic compiled into one fat jar with no
 * extract command exposed; this list lets the operator drop the JAR (e.g.
 * extracted from the Burp MCP tab "Extract server proxy..." button) at a
 * predictable location and have sec-config wire it up without further config.
 */
const BURP_PROXY_DEFAULT_PATHS = [
  'E:\\工作\\Web Security\\Tools\\02-流量抓包与代理\\BurpSuite_Pro_V2026.4\\mcp-proxy-all.jar',
  'E:\\工作\\Web Security\\Tools\\02-流量抓包与代理\\mcp-proxy-all.jar',
]

/**
 * Candidate locations for the stdio-to-SSE bridge script, in order:
 *   1. `services.burpBridgeScript` — explicit operator override (settings).
 *   2. In-package copy shipped with this plugin (tools/burp-sse-bridge.mjs),
 *      resolved from import.meta.url so it works wherever the plugin lands.
 * The bridge is preferred over the fat-jar proxy because the Burp extension
 * failed the "Extract server proxy..." step with `Could not find
 * mcp-proxy-all.jar in extension resources` (proxy compiled in, not
 * extractable) and the bridge needs no Java runtime.
 */

/** Locate the preferred stdio bridge script; empty string when absent. */
function resolveBurpBridgeScript(section) {
  // 1. explicit override in settings
  const override = section && section.services && section.services.burpBridgeScript
  if (typeof override === 'string' && override.trim()) {
    try { if (existsSync(override)) return override } catch { /* fall through */ }
  }
  // 2. in-package copy (import.meta.url -> ../tools/burp-sse-bridge.mjs)
  try {
    const pkg = new URL('../tools/burp-sse-bridge.mjs', import.meta.url)
    if (existsSync(fileURLToPath(pkg))) return fileURLToPath(pkg)
  } catch { /* fall through */ }
  return ''
}

/**
 * Stable ids the sec-config bridge writes for the servers it manages. Picking a
 * fixed id (instead of a timestamp) keeps writes idempotent across page reloads
 * and lets mcp-studio reconcile without churning the mount cycle.
 */
const SEC_MANAGED_IDS = {
  burp: 'srv-sec-burp',
  yakit: 'srv-sec-yakit',
}

const toolShape = {}
for (const key of TOOL_KEYS) toolShape[key] = z.string().default('')

const Config = z.object({
  tools: z.object(toolShape),
  services: z.object({
    burpUrl: z.string().default(''),
    yakitUrl: z.string().default(''),
    burpBridgeScript: z.string().default(''),
  }),
  dnslog: z.object({
    url: z.string().default(''),
    token: z.string().default(''),
  }),
  apiKeys: z.object({
    deepseekKey: z.string().default(''),
  }),
  /** 供「工具自动探测」扫描的候选根（用户可选填；留空则用已配工具父目录）。 */
  scanRoots: z.array(z.string()).default([]),
})

function ok(value) { return { ok: true, value } }
function failure(message) { return { ok: false, error: { code: 'sec-config', message: String(message), details: {} } } }

function redact(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redact)
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = redact(v)
  if (value && typeof value.token === 'string' && value.token) out.token = '***'
  if (value && typeof value.deepseekKey === 'string' && value.deepseekKey) out.deepseekKey = '***'
  return out
}

/** Merge a `set` op into the current object, resolving dotted secret paths. */
function applyOps(current, ops) {
  const next = JSON.parse(JSON.stringify(current))
  for (const raw of ops) {
    if (!raw || typeof raw !== 'object' || raw.op !== 'set') continue
    const path = Array.isArray(raw.path) ? raw.path : []
    if (path.length === 0 || !WRITABLE_FIELDS.has(String(path[0]))) continue
    if (path.length === 1) {
      next[path[0]] = raw.value
      continue
    }
    const leaf = String(path[path.length - 1])
    let cursor = next
    for (const seg of path.slice(0, -1)) {
      if (cursor[seg] === undefined || cursor[seg] === null) cursor[seg] = {}
      cursor = cursor[seg]
    }
    cursor[leaf] = raw.value
  }
  return next
}

/** Neutralize `{{` so interpolated prompt rendering treats it as literal prose. */
function escapePromptBraces(text) {
  return text.includes('{{') ? text.replace(/\{(?=\{)/gu, '{\u2060') : text
}

function ensureSuffix(url, suffix) {
  if (!url) return url
  const trimmed = url.replace(/\/+$/u, '')
  return trimmed.endsWith(suffix) ? trimmed : trimmed + suffix
}

/** Resolve the Burp MCP stdio proxy JAR location; empty string when not found. */
function resolveBurpProxyPath() {
  for (const p of BURP_PROXY_DEFAULT_PATHS) {
    try { if (existsSync(p)) return p } catch { /* ignore */ }
  }
  return ''
}

/**
 * 工具路径"自动探测"（替代原生目录对话框——浏览器给不了绝对路径，而宿主弹窗
 * 在无交互桌面/远程会话下会不可见甚至卡死，且无法自动化验证）。
 *
 * 方案：宿主在**候选根**（用户显式填的扫描根 + 所有已配工具路径的父目录 +
 * 已知工具目录常量）里做深度受限的静默扫描，按工具名匹配出候选绝对路径，
 * 前端渲染成"一键点选"列表——体验与技能上传一致，永不弹窗、永不冻结。
 */
const TOOL_NAME_EXT_RE = /\.(exe|py|bat|cmd|ps1|go|sh|jar|rb|pl)$/i

function isToolCandidateFile(name, toolKey) {
  const lower = name.toLowerCase()
  const base = lower.replace(/\.[^.]+$/, '')
  const extOk = TOOL_NAME_EXT_RE.test(lower) || !lower.includes('.')
  if (!extOk) return false
  // 排除安装包/构建残留（nmap-7.99-setup.exe 等）
  if (/setup|install|uninstall|\.msi$|\.zip$/.test(lower)) return false
  // 文件名主部 === 工具 key（jwt_tool.py / nuclei.exe / sqlmap 等）
  if (base === toolKey.toLowerCase()) return true
  // 工具目录常见命名：fscan_2.2.1_windows_x64.exe / sqlmap-dev 等前缀匹配
  if (base.startsWith(toolKey.toLowerCase() + '_')) return true
  if (base.startsWith(toolKey.toLowerCase() + '-')) return true
  return false
}

/** 单层目录扫描（不递归，候选根一般已按工具分好层）。 */
function scanDirForTool(root, toolKey, out, depth = 0, maxDepth = 2) {
  if (depth > maxDepth) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.name === 'node_modules' || e.name === '__pycache__') continue
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      scanDirForTool(full, toolKey, out, depth + 1, maxDepth)
    } else if (e.isFile() && isToolCandidateFile(e.name, toolKey)) {
      out.push(full)
    }
  }
}

/**
 * 汇总候选根并扫描。同步执行（几十~几百目录，深度 ≤2，单次毫秒级）；
 * 结果按"越靠前越可能"排序（父目录命中 > 深层）。超长扫描加保护上限。
 */
const SCAN_MAX_ROOTS = 32
const SCAN_MAX_HITS = 64
function findToolCandidates(section) {
  const tools = (section && section.tools) || {}
  const roots = []
  const seen = new Set()
  const addRoot = (r) => {
    if (!r || seen.has(r)) return
    seen.add(r)
    roots.push(r)
  }
  // 1) 用户显式填的扫描根（顶层配置 scanRoots，UI 可编辑）
  if (Array.isArray(section && section.scanRoots)) section.scanRoots.forEach(addRoot)
  // 2) 所有已配工具路径的父目录及其上一级（Tools\04-...\sqlmap → 扫 04-... 与 Tools，
  //    让同大类/同目录的 nuclei/ffuf 等互见；bin 型扁平目录自动覆盖）
  for (const v of Object.values(tools)) {
    if (typeof v !== 'string' || !v || v === '***') continue
    addRoot(path.dirname(v))
    addRoot(path.dirname(path.dirname(v)))
  }
  // 3) 随包常量里的工具根线索（mcp-proxy 父目录等）
  for (const p of BURP_PROXY_DEFAULT_PATHS) {
    try { if (existsSync(p)) addRoot(path.dirname(path.dirname(p))) } catch { /* ignore */ }
  }
  if (roots.length === 0) return { roots: [], candidates: {} }
  const candidates = {}
  for (const t of TOOL_PRESETS) {
    const hits = []
    for (const root of roots.slice(0, SCAN_MAX_ROOTS)) scanDirForTool(root, t.key, hits)
    if (hits.length > SCAN_MAX_HITS) hits.length = SCAN_MAX_HITS
    // 排序：短路径优先（更接近工具根）；同长度按字母序稳定
    hits.sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
    candidates[t.key] = hits.slice(0, 8)
  }
  return { roots, candidates }
}

/**
 * Build one mcp-studio server entry from a sec-config service endpoint. Returns
 * `null` when the entry cannot be built (e.g. Burp with no proxy jar available).
 */
function buildServerEntry(name, rawUrl, section) {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!url) return null
  if (name === 'burp') {
    // Prefer the in-repo stdio bridge script: Burp's fat-jar proxy extraction
    // can fail on some Burp builds ("Could not find mcp-proxy-all.jar in
    // extension resources"), and the bridge is a plain Node script with no
    // Java prerequisite. Fall back to the JAR if the script is missing.
    const scriptPath = resolveBurpBridgeScript(section)
    if (scriptPath) {
      // Use forward slashes — mcp-studio's splitArgs treats backslashes as
      // shell escapes and would mangle Windows paths containing spaces and
      // CJK characters ("E:\工作\..." → "E:工作...").
      const scriptPosix = scriptPath.replace(/\\/g, '/')
      return {
        id: SEC_MANAGED_IDS.burp,
        enabled: true,
        name: 'burp',
        transport: 'stdio',
        command: 'node',
        argsLine: `"${scriptPosix}" --sse-url ${url}`,
        env: {},
        cwd: '',
        url: '',
        headers: {},
        toolCallTimeoutMs: 60000,
        failOnStartupError: false,
      }
    }
    const proxyPath = resolveBurpProxyPath()
    if (!proxyPath) {
      return {
        id: SEC_MANAGED_IDS.burp,
        enabled: false,
        name: 'burp',
        transport: 'stdio',
        command: 'java',
        argsLine: `-jar "${proxyPath || 'PATH_MISSING'}" --sse-url ${url}`,
        env: {},
        cwd: '',
        url: '',
        headers: {},
        toolCallTimeoutMs: 60000,
        failOnStartupError: false,
        _missingProxy: true,
      }
    }
    const proxyPosix = proxyPath.replace(/\\/g, '/')
    return {
      id: SEC_MANAGED_IDS.burp,
      enabled: true,
      name: 'burp',
      transport: 'stdio',
      command: 'java',
      argsLine: `-jar "${proxyPosix}" --sse-url ${url}`,
      env: {},
      cwd: '',
      url: '',
      headers: {},
      toolCallTimeoutMs: 60000,
      failOnStartupError: false,
    }
  }
  if (name === 'yakit') {
    return {
      id: SEC_MANAGED_IDS.yakit,
      enabled: true,
      name: 'yakit',
      transport: 'streamable-http',
      command: '',
      argsLine: '',
      env: {},
      cwd: '',
      url: ensureSuffix(url, '/mcp'),
      headers: {},
      toolCallTimeoutMs: 60000,
      failOnStartupError: false,
    }
  }
  return null
}

/**
 * Mirror the current sec-config.services into mcp-studio.servers (merge by
 * name). Operators keep the convenience of a single source-of-truth page; the
 * MCP 工作台 gets auto-synced and the model's mcp__* tool registry lights up
 * on the next prompt assembly.
 */
async function syncMcpServers(settings, services) {
  const wanted = new Map()
  const missingProxy = []
  const section = { services: services || {} }
  for (const [name, rawUrl] of [['burp', services && services.burpUrl], ['yakit', services && services.yakitUrl]]) {
    if (typeof rawUrl === 'string' && rawUrl.trim().length > 0) {
      const entry = buildServerEntry(name, rawUrl, section)
      if (entry) {
        wanted.set(name, entry)
        if (entry._missingProxy) missingProxy.push(name)
      }
    }
  }
  let current
  try {
    current = settings.get(MCP_STUDIO_NAMESPACE)
  } catch (err) {
    throw new Error(`mcp-studio namespace not registered yet: ${err && err.message ? err.message : String(err)}`)
  }
  const list = current && Array.isArray(current.servers) ? current.servers : []
  const consumed = new Set()
  const merged = []
  for (const srv of list) {
    if (!srv || typeof srv !== 'object') continue
    if (srv.name === 'burp' || srv.name === 'yakit') {
      consumed.add(srv.name)
      const entry = wanted.get(srv.name)
      if (entry) {
        // Preserve any operator-edited fields we don't manage (e.g. custom headers)
        const { _missingProxy: _drop, ...cleanEntry } = entry
        merged.push(cleanEntry)
      }
      // else: services cleared the URL → drop the managed server row
    } else {
      merged.push(srv)
    }
  }
  for (const [name, entry] of wanted) {
    if (!consumed.has(name)) {
      const { _missingProxy: _drop, ...cleanEntry } = entry
      merged.push(cleanEntry)
    }
  }
  merged.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  await settings.update(MCP_STUDIO_NAMESPACE, { servers: merged })
  return {
    synced: Array.from(wanted.keys()),
    missingProxy,
    servers: merged,
  }
}

/** Schedule a sync that survives mcp-studio not-yet-registered at first watch tick. */
function scheduleSync(settings, services, logger) {
  let attempts = 0
  const attempt = async () => {
    try {
      const result = await syncMcpServers(settings, services)
      logger?.debug?.('dsh-sec-config: MCP bridge synced servers=%s missingProxy=%s', JSON.stringify((result && result.synced) || []), JSON.stringify((result && result.missingProxy) || []))
      return result
    } catch (err) {
      attempts += 1
      const msg = err && err.message ? err.message : String(err)
      if (attempts >= 8) console.error('[dsh-sec-config] MCP bridge sync failed after 8 attempts: %s', msg)
      else setTimeout(attempt, 800)
    }
    return null
  }
  setTimeout(attempt, 400)
}

/**
 * Render the runtime tool/MCP manifest as one dynamic prompt context.
 * Deterministic in (tools, services, dnslog, mounted mcp tool names) — identical
 * inputs must produce identical text, otherwise the runtime-context projection
 * re-snapshots on every turn.
 * The model never needs absolute paths (DSH_TOOL_<NAME> carries them into every
 * shell call); what it needs is *which* tools/services/MCP servers are live, so
 * a configured-but-empty tool is not silently assumed available.
 */
export function renderManifest(section, listMountedMcpTools) {
  const lines = []
  const tools = section && section.tools ? section.tools : {}
  const byKey = new Map(TOOL_PRESETS.map((t) => [t.key, t]))
  const configured = []
  for (const t of TOOL_PRESETS) {
    if (typeof tools[t.key] === 'string' && tools[t.key].length > 0) configured.push(t.key)
  }
  for (const key of Object.keys(tools)) {
    if (!byKey.has(key) && isToolKey(key) && typeof tools[key] === 'string' && tools[key].length > 0) {
      configured.push(key + '(自定义)')
    }
  }
  if (configured.length > 0) lines.push(`tools: ${configured.join(' ')}`)
  const services = section && section.services ? section.services : {}
  const serviceParts = []
  if (services.burpUrl) serviceParts.push(`burp=${services.burpUrl}`)
  if (services.yakitUrl) serviceParts.push(`yakit=${services.yakitUrl}`)
  if (serviceParts.length > 0) lines.push(`services: ${serviceParts.join(' ')}`)
  if (section && section.dnslog && section.dnslog.url) lines.push('dnslog: url 已配（token 不回显）')
  let mcpNames = []
  try {
    const view = listMountedMcpTools ? listMountedMcpTools() : []
    mcpNames = Array.isArray(view)
      ? view.map((t) => (t && typeof t.name === 'string' ? t.name : '')).filter((name) => name.startsWith('mcp__'))
      : []
  } catch { /* registry read failure contributes no mcp line */ }
  if (mcpNames.length > 0) {
    const perServer = new Map()
    for (const name of mcpNames) {
      const server = name.split('__')[1] ?? '?'
      perServer.set(server, (perServer.get(server) ?? 0) + 1)
    }
    const summary = [...perServer.entries()]
      .map(([server, count]) => `${server}(${count})`)
      .sort()
      .join(' ')
    lines.push(`mcp: ${summary}`)
  }
  if (lines.length === 0) return ''
  return escapePromptBraces(`<sec-config manifest>\n${lines.join('\n')}\n</sec-config manifest>`)
}

export function apply(ctx, config = {}) {
  let current = () => config
  let scope = null
  const base = { tools: {}, services: {}, dnslog: {}, apiKeys: {}, scanRoots: [], ...(config ?? {}) }

  try {
    scope = ctx.settings.register(NAMESPACE, Config, { base })
    current = () => scope.get()
  } catch (error) {
    ctx.logger?.warn?.('dsh-sec-config: settings provider unavailable, using patch baseline: %s', String(error))
  }

  ctx.inject(['connection', 'settings', 'shellEnv', 'systemPrompt'], (web) => {
    const { connection, settings, shellEnv } = web

    connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
      try {
        if (endpoint === 'tool-presets') {
          return ok({ presets: TOOL_PRESETS, categories: TOOL_CATEGORIES })
        }
        if (endpoint === 'settings/get') {
          return ok({
            status: 'ready',
            value: redact(current()),
            writable: settings.writable !== false,
            mode: 'host',
          })
        }
        if (endpoint === 'settings/mutate') {
          if (settings.writable === false) return failure('DSH settings are read-only')
          const raw = payload && typeof payload === 'object' ? payload : {}
          const rawOps = raw.ops
          if (!Array.isArray(rawOps) || rawOps.length === 0 || rawOps.length > 16) {
            return failure('ops must contain 1..16 settings edits')
          }
          const ops = rawOps
            .filter((op) => op && typeof op === 'object' && op.op === 'set' && Array.isArray(op.path) && op.path.length >= 1 && WRITABLE_FIELDS.has(String(op.path[0])))
            .map((op) => ({ op: 'set', path: op.path.map(String), value: op.value }))
          // Preserve existing secrets when the client echoes a mask back.
          const before = current()
          const merged = applyOps(before, ops)
          const revision = typeof raw.expectedRevision === 'number' ? raw.expectedRevision : undefined
          await settings.mutate(NAMESPACE, ops, revision)
          const after = current()
          // Mirror services into mcp-studio on the same write so the operator
          // sees the MCP card turn green in the 工作台 without a second save.
          scheduleSync(settings, (after && after.services) || {}, ctx.logger)
          return ok({ status: 'ready', value: redact(after), writable: true, mode: 'host' })
        }
        if (endpoint === 'mount-services') {
          const services = (current() && current().services) || {}
          try {
            const result = await syncMcpServers(settings, services)
            return ok(result)
          } catch (err) {
            return failure(err && err.message ? err.message : String(err))
          }
        }
        if (endpoint === 'scan-candidates') {
          // 工具自动探测：静默扫描候选根（scanRoots + 已配工具父目录两级），
          // 按预设工具名匹配返回候选绝对路径。无弹窗、毫秒级、可 headless 验证。
          try {
            const { roots, candidates } = findToolCandidates(current())
            return ok({ roots: roots.slice(0, 12), candidates })
          } catch (err) {
            return failure(err && err.message ? err.message : String(err))
          }
        }
        if (endpoint === 'services/probe') {
          // Cheap reachability probe for the UI badge — connects (no full MCP handshake)
          // and reports whether the endpoint accepts traffic. Does not require
          // mcp-studio to be registered.
          const services = (current() && current().services) || {}
          const targets = []
          if (services.burpUrl) targets.push({ name: 'burp', url: services.burpUrl })
          if (services.yakitUrl) targets.push({ name: 'yakit', url: ensureSuffix(services.yakitUrl, '/mcp') })
          const results = await Promise.all(targets.map(async (t) => {
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 4000)
            try {
              const res = await fetch(t.url, { method: 'GET', signal: ctrl.signal })
              return { name: t.name, url: t.url, reachable: true, status: res.status }
            } catch (err) {
              return { name: t.name, url: t.url, reachable: false, error: err && err.message ? err.message : String(err) }
            } finally {
              clearTimeout(timer)
            }
          }))
          return ok({ probes: results })
        }
        return failure('unknown endpoint: ' + endpoint)
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
    }, { authority: 'loopback' })

    const variables = {}
    for (const key of TOOL_KEYS) {
      variables['DSH_TOOL_' + key.toUpperCase()] = { description: 'Configured path to the ' + key + ' security tool (empty when unset).' }
    }
    shellEnv.register({
      name: 'sec-config-tools',
      variables,
      resolve: () => {
        const section = current()
        const out = {}
        const tools = section && section.tools ? section.tools : {}
        for (const key of TOOL_KEYS) {
          out['DSH_TOOL_' + key.toUpperCase()] = typeof tools[key] === 'string' ? tools[key] : ''
        }
        return out
      },
    })

    // Dynamic prompt context: re-rendered at every prompt assembly from the
    // LIVE settings scope (UI saves and external settings.yaml edits both flow
    // through the hot-reloading settings provider), so config changes reach the
    // model's next context snapshot without a restart. Same mechanism the
    // governance envelope uses; deterministic text means zero cost when nothing
    // changed. Mounted MCP tools are introspected from the live tool registry.
    try {
      ctx.systemPrompt.context({
        name: 'sec-config-manifest',
        order: 550,
        text: () => renderManifest(current(), () => ctx.get('tools')?.view(void 0)),
      })
    } catch (error) {
      ctx.logger?.warn?.('dsh-sec-config: systemPrompt unavailable, runtime manifest disabled: %s', String(error))
    }

    // Initial mount pass + ongoing reconciliation. scope.watch delivers every
    // commit, so UI saves and direct yaml edits both flow into
    // mcp-studio.servers without a second round-trip.
    try {
      if (scope && typeof scope.watch === 'function') {
        scope.watch((next) => {
          const services = (next && next.services) || {}
          scheduleSync(settings, services, ctx.logger)
        })
        scheduleSync(settings, (current() && current().services) || {}, ctx.logger)
      } else {
        console.error('[dsh-sec-config] NO settings scope — MCP bridge disabled (scope=%s)', scope === null ? 'null' : typeof scope)
      }
    } catch (error) {
      console.error('[dsh-sec-config] bridge setup error:', error && error.message ? error.message : String(error))
    }
  })
}
