// dsh-sec-config —— 内置模型代理（host 侧，仅 Node 标准库）。
//
// 为什么需要它：OpenCode Go 这类网关要求请求头带 `x-opencode-session`
// （纯「存在且非空」校验，值不参与认证），而 dsh 没有注入自定义头的入口，
// 直连必然收到 `400 MissingSessionID`。
//
// 做法：在宿主进程内起一个 loopback HTTP 服务，把 /v1/* 原样转发到上游，
// 途中补齐会话头，并剥掉客户端注入的私有字段（不剥上游会回
// `400 ... Extra inputs are not permitted`，且对话越长累计越多）。
//
// **不依赖任何外部程序** —— 随插件走，任何用户装上即用。
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// 统一出站策略（根包 `dsh-saker/egress`）：模型上游属于 infra 出站，
// 冻结档必须在**发出请求之前**拦下。实现只解析，不在这里复制判定逻辑。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const requireFromHere = createRequire(import.meta.url)
let egressModule
async function egressLib() {
  if (egressModule !== undefined) return egressModule
  try {
    egressModule = await import(pathToFileURL(requireFromHere.resolve('dsh-saker/egress')).href)
  } catch {
    try {
      egressModule = await import(pathToFileURL(path.resolve(HERE, '..', '..', '..', 'lib', 'egress.js')).href)
    } catch {
      egressModule = null
    }
  }
  return egressModule
}

/** 默认闸门：读统一策略 + 判定 + 留痕；模块缺失时不拦（保持旧行为）并如实回报。 */
export async function checkUpstreamEgress(home, host, note) {
  const lib = await egressLib()
  if (!lib) return { decision: 'allow', reason: 'egress-module-missing', mode: 'allow', policySource: 'module-missing' }
  return lib.checkEgress(home, { plugin: 'dsh-sec-config', kind: 'infra', host, note })
}

/** 消息对象上的私有字段。用「有没有 role」判断是不是消息对象 ——
 *  `model` 只在消息里非法，顶层的 `model` 是必需的，剥错了会得到
 *  「Model  is not supported」。 */
const MSG_EXTRA_KEYS = [
  'agent', 'messageId', 'model', 'requestModelId', 'requestModelName',
  'traceId', 'conversationRequestId', 'rawUsage', 'usage', 'reasoning',
]
/** content block 上的私有字段（任何层级都剥）。 */
const BLOCK_EXTRA_KEYS = ['annotations']
/** 顶层私有字段（**绝不能**把 model / messages / input 放进来）。 */
const TOP_EXTRA_KEYS = [
  'agent', 'traceId', 'conversationRequestId',
  'requestModelId', 'requestModelName', 'rawUsage',
]
/** 逐跳头，不转发。 */
const HOP_BY_HOP = new Set([
  'host', 'connection', 'content-length', 'accept-encoding', 'proxy-connection',
  'keep-alive', 'upgrade', 'te', 'trailer', 'transfer-encoding',
])
/**
 * 回传时要丢掉的头。
 *
 * Node 的 fetch（undici）**会自动解压**上游响应，但**不会**把 `content-encoding`
 * 从响应头里去掉 —— 原样转发出去，客户端会对已解压的内容再解一次，
 * 报 `Decompression failed`。长度同理，解压后必变。
 */
const DROP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length'])
const AUDIT_LIMIT = 20

/** Outbound redaction modes. `secrets` is deliberately protocol-aware and
 * preserves targets; it is not a generic "replace every scary word" pass. */
export const REDACTION_MODES = ['off', 'secrets', 'secrets+pii']

// 字段级分类（对标 Presidio 的 recognizer → operator 分离，但保持零依赖）：
// 先按字段名判断结构化数据类别，再执行对应 operator。这样 `{"password":"hunter2"}`
// 这种“值本身不像 token”的结构化凭据不会漏；目标 IP、域名、URL 和普通载荷仍放行。
const FIELD_KIND_RULES = [
	[/^(?:proxy_)?authorization$/, 'authorization'],
	[/^(?:set_)?cookie$/, 'cookie'],
	[/^private_key$/, 'private-key'],
	[/^(?:aws_)?(?:access_key_id|secret_access_key)$/, 'cloud-key'],
	[/^github_(?:token|pat)$/, 'github-token'],
	[/^jwt$/, 'jwt'],
	[/^(?:api_key|apikey)$/, 'api-key'],
	[/^(?:password|passwd|pass|secret|client_secret|access_token|refresh_token|id_token|token|credential|credentials|session_id|sessionid|csrf|xsrf)$/, 'secret'],
	[/(?:^|_)(?:password|passwd|pass|secret|token|credential|credentials)(?:_|$)/, 'secret'],
]
const CARRIER_VALUE_KEYS = new Set(['value', 'data', 'text', 'content'])

function normalizeFieldName(name) {
	return String(name ?? '')
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
}

function sensitiveFieldKind(name) {
	const normalized = normalizeFieldName(name)
	if (!normalized) return ''
	for (const [pattern, kind] of FIELD_KIND_RULES) if (pattern.test(normalized)) return kind
	return ''
}

/** 识别 `{ name: "Authorization", value: "Basic ..." }` 这类键值对结构。 */
function sensitiveCarrierKind(node) {
	for (const key of ['name', 'key', 'header', 'field']) {
		if (typeof node[key] !== 'string') continue
		const kind = sensitiveFieldKind(node[key])
		if (kind) return kind
	}
	return ''
}

function redactFieldValue(value, kind) {
	if (value === undefined || value === null || value === '') return { value, redacted: 0, byKind: {} }
	if (typeof value === 'string' && /^\[REDACTED:[^\]]+\]$/.test(value.trim())) {
		return { value, redacted: 0, byKind: {} }
	}
	return { value: `[REDACTED:${kind}]`, redacted: 1, byKind: { [kind]: 1 } }
}

/**
 * Redact credentials embedded in a text block. The default mode keeps target
 * IPs, domains, paths and ordinary security payloads intact, because those are
 * required for an authorized test to remain reproducible.
 */
export function redactText(value, mode = 'secrets') {
	let out = String(value ?? '')
	const byKind = {}
	const secretsEnabled = mode === 'secrets' || mode === 'secrets+pii'
	const piiEnabled = mode === 'secrets+pii'
	if (!secretsEnabled || !out) return { text: out, redacted: 0, byKind }
	let redacted = 0
	const replace = (re, repl, kind) => {
		out = out.replace(re, (...args) => {
			redacted += 1
			byKind[kind] = (byKind[kind] || 0) + 1
			if (typeof repl === 'function') return repl(...args)
			return String(repl).replace(/\$(\d+)/g, (_match, index) => args[Number(index)] ?? '')
		})
	}

	replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED:private-key]', 'private-key')
	// 保留字段名，替换整个 header 值（Bearer / Basic / Digest 都适用）。
	// 结构化 JSON 里的值优先按“带引号的 value”截断，避免吃掉同一行后续字段。
	replace(/(["']?(?:proxy-)?authorization["']?\s*:\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED:authorization]$2', 'authorization')
	replace(/(["']?(?:proxy-)?authorization["']?\s*:\s*)(?=[^\s"'\r\n,;])([^\r\n,;]+)/gi, '$1[REDACTED:authorization]', 'authorization')
	replace(/(["']?cookie["']?\s*:\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED:cookie]$2', 'cookie')
	replace(/(["']?cookie["']?\s*:\s*)(?=[^\s"'\r\n])([^\r\n]+)/gi, '$1[REDACTED:cookie]', 'cookie')
	replace(/(["']?set-cookie["']?\s*:\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED:set-cookie]$2', 'cookie')
	replace(/(["']?set-cookie["']?\s*:\s*)(?=[^\s"'\r\n])([^\r\n]+)/gi, '$1[REDACTED:set-cookie]', 'cookie')
	replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED:bearer]', 'bearer')
	replace(/\b(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/g, '[REDACTED:cloud-key]', 'cloud-key')
	replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}\b/gi, '[REDACTED:github-token]', 'github-token')
	// 高置信 SaaS/云凭据前缀（对标 gitleaks config/gitleaks.toml）：
	// 不做泛化熵扫描，只替换有明确格式的 token，减少误伤安全测试载荷。
	replace(/\bAIza[A-Za-z0-9_-]{35}\b/g, '[REDACTED:google-api-key]', 'google-api-key')
	replace(/\bglpat-[A-Za-z0-9_.-]{20,320}\b/g, '[REDACTED:gitlab-token]', 'gitlab-token')
	replace(/\bxox[baprs]-[A-Za-z0-9-]{10,100}\b/g, '[REDACTED:slack-token]', 'slack-token')
	replace(/\b(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]{10,99}\b/g, '[REDACTED:stripe-key]', 'stripe-key')
	replace(/\b[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.-]{31,34}\b/g, '[REDACTED:azure-client-secret]', 'azure-client-secret')
	replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]', 'api-key')
	replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt]', 'jwt')
	replace(/(["']?(?:password|passwd|pass|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key)["']?\s*[:=]\s*)(["']?)([^"'\r\n,}\s]+)\2/gi, '$1$2[REDACTED:secret]$2', 'secret')
	replace(/([?&](?:token|access_token|refresh_token|api_key|apikey|password|passwd)=)[^&#\s]+/gi, '$1[REDACTED:query-secret]', 'query-secret')
	if (piiEnabled) {
		replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED:email]', 'email')
		replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[REDACTED:phone-cn]', 'phone-cn')
		replace(/(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g, '[REDACTED:id-cn]', 'id-cn')
		out = out.replace(/(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g, (match) => {
			const digits = match.replace(/\D/g, '')
			if (digits.length < 16 || digits.length > 19 || !luhnValid(digits)) return match
			redacted += 1
			byKind['bank-card'] = (byKind['bank-card'] || 0) + 1
			return '[REDACTED:bank-card]'
		})
	}
	return { text: out, redacted, byKind }
}

function luhnValid(digits) {
	let sum = 0
	let double = false
	for (let i = digits.length - 1; i >= 0; i -= 1) {
		let n = digits.charCodeAt(i) - 48
		if (double) {
			n *= 2
			if (n > 9) n -= 9
		}
		sum += n
		double = !double
	}
	return sum % 10 === 0
}

function redactNode(node, mode, inheritedKind = '') {
	if (typeof node === 'string') {
		if (inheritedKind) return redactFieldValue(node, inheritedKind)
		const result = redactText(node, mode)
		return { value: result.text, redacted: result.redacted, byKind: result.byKind }
	}
	if (Array.isArray(node)) {
		let redacted = 0
		const byKind = {}
		const next = node.map((item) => {
			const result = redactNode(item, mode, inheritedKind)
			redacted += result.redacted
			for (const [kind, count] of Object.entries(result.byKind || {})) byKind[kind] = (byKind[kind] || 0) + count
			return result.value
		})
		return { value: next, redacted, byKind }
	}
	if (!node || typeof node !== 'object') {
		return inheritedKind
			? redactFieldValue(node, inheritedKind)
			: { value: node, redacted: 0, byKind: {} }
	}
	let redacted = 0
	const byKind = {}
	const next = {}
	const carrierKind = sensitiveCarrierKind(node)
	for (const [key, value] of Object.entries(node)) {
		const fieldKind = sensitiveFieldKind(key)
			|| (carrierKind && CARRIER_VALUE_KEYS.has(normalizeFieldName(key)) ? carrierKind : '')
		const result = redactNode(value, mode, fieldKind || inheritedKind)
		next[key] = result.value
		redacted += result.redacted
		for (const [kind, count] of Object.entries(result.byKind || {})) byKind[kind] = (byKind[kind] || 0) + count
	}
	return { value: next, redacted, byKind }
}

/**
 * Redact only model-bound message content. Top-level tool definitions stay
 * byte-identical because their JSON schemas are executable contracts, not
 * user data.
 */
export function redactBody(raw, mode = 'secrets') {
	if ((mode !== 'secrets' && mode !== 'secrets+pii') || !raw || raw.length === 0) return { body: raw, redacted: 0, byKind: {} }
	let obj
	try { obj = JSON.parse(raw.toString('utf8')) } catch { return { body: raw, redacted: 0, byKind: {} } }
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { body: raw, redacted: 0, byKind: {} }

	let redacted = 0
	const byKind = {}
	for (const key of ['messages', 'input']) {
		if (!Array.isArray(obj[key])) continue
		const result = redactNode(obj[key], mode)
		obj[key] = result.value
		redacted += result.redacted
		for (const [kind, count] of Object.entries(result.byKind || {})) byKind[kind] = (byKind[kind] || 0) + count
	}
	if (typeof obj.prompt === 'string') {
		const result = redactText(obj.prompt, mode)
		obj.prompt = result.text
		redacted += result.redacted
		for (const [kind, count] of Object.entries(result.byKind || {})) byKind[kind] = (byKind[kind] || 0) + count
	}
	return redacted > 0
		? { body: Buffer.from(JSON.stringify(obj), 'utf8'), redacted, byKind }
		: { body: raw, redacted: 0, byKind: {} }
}

/**
 * 剥掉客户端注入的私有字段。
 *
 * 只走「已知容器」（顶层 / messages / input / content block），**不做全量递归** ——
 * 否则会误伤工具定义：`tools[].function.parameters.properties` 里完全可以有个
 * 属性就叫 model / usage / reasoning，全量递归会把用户的工具 schema 改坏。
 *
 * @returns {{ body: Buffer, stripped: number }} stripped=0 时 body 原样返回
 */
export function sanitizeBody(raw, sanitize) {
  if (!sanitize || !raw || raw.length === 0) return { body: raw, stripped: 0 }
  let obj
  try {
    obj = JSON.parse(raw.toString('utf8'))
  } catch {
    return { body: raw, stripped: 0 }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { body: raw, stripped: 0 }

  let stripped = 0
  const drop = (node, keys) => {
    for (const k of keys) {
      if (node && Object.prototype.hasOwnProperty.call(node, k)) {
        delete node[k]
        stripped += 1
      }
    }
  }

  drop(obj, TOP_EXTRA_KEYS)
  for (const key of ['messages', 'input']) {
    const seq = obj[key]
    if (!Array.isArray(seq)) continue
    for (const item of seq) {
      if (!item || typeof item !== 'object') continue
      drop(item, MSG_EXTRA_KEYS)
      drop(item, BLOCK_EXTRA_KEYS)
      const content = item.content
      if (Array.isArray(content)) {
        for (const block of content) if (block && typeof block === 'object') drop(block, BLOCK_EXTRA_KEYS)
      }
    }
  }

  if (stripped === 0) return { body: raw, stripped: 0 }
  return { body: Buffer.from(JSON.stringify(obj), 'utf8'), stripped }
}

/** 构造代理要注入的头。会话值是「存在且非空」校验，不参与认证。 */
export function outboundHeaders(headers, opts) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = value
  }
  out['user-agent'] = opts.userAgent
  out['x-opencode-session'] = opts.session
  out['x-opencode-client'] = opts.clientId
  out['x-opencode-project'] = opts.projectId
  out['x-opencode-request'] = 'req-' + randomBytes(4).toString('hex')
  // 明确要未压缩：SSE 流经解压/再转发没有收益，反而多一层出错面
  out['accept-encoding'] = 'identity'
  return out
}

/**
 * Join a client request path to the configured upstream without allowing the
 * request to retarget the proxy. Absolute-form and protocol-relative request
 * targets are rejected before URL construction.
 */
export function resolveUpstreamUrl(upstreamBase, requestUrl) {
	const base = new URL(String(upstreamBase || ''))
	const raw = String(requestUrl || '/')
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
		throw new Error(`upstream URL must be relative: ${raw}`)
	}
	const joined = base.toString().replace(/\/+$/, '') + '/' + raw.replace(/^\/+/, '')
	const target = new URL(joined)
	if (target.origin !== base.origin) throw new Error(`upstream origin mismatch: ${target.origin} != ${base.origin}`)
	return target
}

/**
 * 独立运行模式：`node model-proxy.js --port 8788 --upstream https://opencode.ai/zen/go`
 *
 * 同一份实现既能在宿主进程内被插件调用（Saker），也能单独跑起来给**任何**客户端用 ——
 * 比如 WorkBuddy 这类只允许填 base url、注入不了自定义头的应用。
 * 用 `--print-config` 可以拿到该填进客户端的地址。
 */
export function parseCliArgs(argv) {
  const out = {
    host: '127.0.0.1',
    port: 8788,
    upstream: 'https://opencode.ai/zen/go',
    sanitize: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--host') out.host = next()
    else if (a === '--port' || a === '-p') out.port = Number(next())
    else if (a === '--upstream' || a === '-u') out.upstream = next()
    else if (a === '--no-sanitize') out.sanitize = false
    else if (a === '--session') out.session = next()
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

/** 读满请求体（有上限，避免异常大包把宿主吃满）。 */
export function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 起一个内置代理。
 *
 * @param {object} opts
 * @param {string} opts.host 监听地址，默认 127.0.0.1（只服务本机）
 * @param {number} opts.port 监听端口
 * @param {string} opts.upstreamBase 上游基址，如 https://opencode.ai/zen/go
 * @param {string} [opts.userAgent]
 * @param {string} [opts.clientId] 写入 x-opencode-client
 * @param {string} [opts.projectId] 写入 x-opencode-project
 * @param {boolean} [opts.sanitize] 是否剥私有字段，默认 true
 * @param {string} [opts.redaction] off / secrets，默认 secrets
 * @param {number} [opts.timeoutMs] 上游超时，默认 15 分钟（长任务）
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ server, port, close: () => Promise<void>, stats: () => object }>}
 */
export function startModelProxy(opts) {
  const host = opts.host || '127.0.0.1'
  const requestedPort = Number(opts.port)
  const port = Number.isFinite(requestedPort) ? requestedPort : 8788
  const upstreamBase = String(opts.upstreamBase || '').replace(/\/+$/, '')
  const session = opts.session || 'ses_' + randomBytes(8).toString('hex')
  const userAgent = opts.userAgent || 'saker-sec-config/1.0'
  const clientId = opts.clientId || 'saker'
  const projectId = opts.projectId || 'saker'
  const sanitize = opts.sanitize !== false
  const redaction = REDACTION_MODES.includes(String(opts.redaction)) ? String(opts.redaction) : 'secrets'
  const timeoutMs = Number(opts.timeoutMs) || 900000
  const log = opts.log || (() => {})
  const egressHome = opts.dshHome || opts.home || undefined
  const gate = opts.egressCheck || ((host, note) => checkUpstreamEgress(egressHome, host, note))
  const counters = { requests: 0, stripped: 0, redacted: 0, redactedKinds: {}, errors: 0, lastPath: '', lastStatus: 0, lastMs: 0, events: [] }
  const noteEvent = (event) => {
    counters.events.push({ at: new Date().toISOString(), ...event })
    if (counters.events.length > AUDIT_LIMIT) counters.events.splice(0, counters.events.length - AUDIT_LIMIT)
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now()
    const sendJson = (code, obj) => {
      const buf = Buffer.from(JSON.stringify(obj), 'utf8')
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length })
      res.end(buf)
    }

    try {
      if (req.method === 'GET' && (req.url === '/__health' || req.url === '/__health/')) {
        return sendJson(200, {
          ok: true,
          kind: 'builtin',
          upstream: upstreamBase,
          upstream_origin: new URL(upstreamBase).origin,
          session_mode: opts.session ? 'fixed' : 'per-process',
          sanitize,
          redaction,
          egress: counters.lastEgress || null,
          stats: counters,
        })
      }

      const body = await readBody(req)
      const { body: outBody, stripped } = sanitizeBody(body, sanitize)
      if (stripped > 0) counters.stripped += stripped
      const { body: safeBody, redacted, byKind } = redactBody(outBody, redaction)
      if (redacted > 0) {
        counters.redacted += redacted
        for (const [kind, count] of Object.entries(byKind || {})) counters.redactedKinds[kind] = (counters.redactedKinds[kind] || 0) + count
      }

      let upstreamUrl
      try {
        upstreamUrl = resolveUpstreamUrl(upstreamBase, req.url || '/')
      } catch (error) {
        counters.errors += 1
        noteEvent({ path: req.url || '/', status: 400, error: error.message })
        return sendJson(400, { error: { type: 'UpstreamTargetRejected', message: error.message } })
      }
      // 统一出站策略：上游是 infra 目的地，冻结档在这里断掉（不发起 fetch）
      let verdict = null
      try {
        verdict = await gate(new URL(upstreamUrl).hostname, `${req.method} ${req.url || '/'}`)
      } catch { verdict = null }
      if (verdict) counters.lastEgress = verdict
      if (verdict && verdict.decision === 'deny') {
        counters.errors += 1
        noteEvent({ path: req.url || '/', status: 403, error: `egress:${verdict.reason}` })
        return sendJson(403, {
          error: {
            type: 'EgressBlocked',
            message: `统一出站策略拦截（${verdict.reason} / mode=${verdict.mode}）：上游 ${new URL(upstreamUrl).origin} 被冻结。改档位：设置 → 安全配置 → 出站策略。`,
          },
        })
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      let upstreamRes
      try {
        upstreamRes = await fetch(upstreamUrl, {
          method: req.method,
          headers: outboundHeaders(req.headers, { session, userAgent, clientId, projectId }),
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : safeBody,
          signal: controller.signal,
          redirect: 'manual',
        })
      } finally {
        clearTimeout(timer)
      }

      counters.requests += 1
      counters.lastPath = req.url
      counters.lastStatus = upstreamRes.status
      counters.lastMs = Date.now() - started
      noteEvent({ method: req.method, path: req.url, status: upstreamRes.status, stripped, redacted, redactedKinds: byKind || {}, ms: counters.lastMs })
      log(`--> ${req.method} ${req.url} strip=${stripped} redact=${redacted} -> ${upstreamRes.status} ${counters.lastMs}ms`)

      const headers = {}
      upstreamRes.headers.forEach((v, k) => {
        const name = k.toLowerCase()
        if (HOP_BY_HOP.has(name) || DROP_RESPONSE_HEADERS.has(name)) return
        headers[k] = v
      })
      res.writeHead(upstreamRes.status, headers)
      if (!upstreamRes.body) {
        res.end()
        return
      }
      // 原样回传（含 SSE 流）—— 不能整体缓冲，否则模型边生成边看就没了
      const { Readable } = await import('node:stream')
      Readable.fromWeb(upstreamRes.body).pipe(res)
    } catch (err) {
      counters.errors += 1
      const message = err && err.message ? err.message : String(err)
      noteEvent({ method: req.method, path: req.url || '/', status: 502, error: message, ms: Date.now() - started })
      log(`!! ${req.method} ${req.url} 失败：${message}`)
      if (!res.headersSent) sendJson(502, { error: { type: 'ProxyUpstreamError', message } })
      else res.end()
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const actualPort = server.address().port
      log(`内置模型代理已启动 http://${host}:${actualPort} -> ${upstreamBase}（strip=${sanitize} redact=${redaction}）`)
      resolve({
        server,
        port: actualPort,
        session,
        close: () => new Promise((done) => server.close(() => done())),
        stats: () => ({ ...counters }),
      })
    })
  })
}

const USAGE = `用法（独立运行，不依赖 dsh）：
  node model-proxy.js [--port 8788] [--host 127.0.0.1] [--upstream https://opencode.ai/zen/go]
                      [--no-sanitize] [--session ses_xxx]

启动后把它当作上游的替代地址填进客户端，例如：
  客户端 base URL  http://127.0.0.1:8788/v1
  客户端 API Key   照原样填（本代理原样透传 Authorization）
健康检查            curl http://127.0.0.1:8788/__health
`

/** 被直接执行（而不是被 import）时才起服务 —— 这样插件内引用不会意外起一个监听。 */
const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  const proxy = await startModelProxy({
    host: args.host,
    port: args.port,
    upstreamBase: args.upstream, // 注意：函数参数叫 upstreamBase，CLI 选项叫 --upstream
    sanitize: args.sanitize,
    session: args.session,
    log: (line) => console.log(`[model-proxy] ${line}`),
  })
  console.log(`[model-proxy] 就绪：客户端填 http://${args.host}:${proxy.port}/v1`)
  const shutdown = () => proxy.close().then(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
