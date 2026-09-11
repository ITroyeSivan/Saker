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
 * @param {number} [opts.timeoutMs] 上游超时，默认 15 分钟（长任务）
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ server, port, close: () => Promise<void>, stats: () => object }>}
 */
export function startModelProxy(opts) {
  const host = opts.host || '127.0.0.1'
  const port = Number(opts.port) || 8788
  const upstreamBase = String(opts.upstreamBase || '').replace(/\/+$/, '')
  const session = opts.session || 'ses_' + randomBytes(8).toString('hex')
  const userAgent = opts.userAgent || 'saker-sec-config/1.0'
  const clientId = opts.clientId || 'saker'
  const projectId = opts.projectId || 'saker'
  const sanitize = opts.sanitize !== false
  const timeoutMs = Number(opts.timeoutMs) || 900000
  const log = opts.log || (() => {})
  const counters = { requests: 0, stripped: 0, errors: 0, lastPath: '', lastStatus: 0, lastMs: 0 }

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
          session_mode: opts.session ? 'fixed' : 'per-process',
          sanitize,
          stats: counters,
        })
      }

      const body = await readBody(req)
      const { body: outBody, stripped } = sanitizeBody(body, sanitize)
      if (stripped > 0) counters.stripped += stripped

      const upstreamUrl = upstreamBase + (req.url || '/')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      let upstreamRes
      try {
        upstreamRes = await fetch(upstreamUrl, {
          method: req.method,
          headers: outboundHeaders(req.headers, { session, userAgent, clientId, projectId }),
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : outBody,
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
      log(`--> ${req.method} ${req.url} strip=${stripped} -> ${upstreamRes.status} ${counters.lastMs}ms`)

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
      log(`!! ${req.method} ${req.url} 失败：${message}`)
      if (!res.headersSent) sendJson(502, { error: { type: 'ProxyUpstreamError', message } })
      else res.end()
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      log(`内置模型代理已启动 http://${host}:${port} -> ${upstreamBase}（strip=${sanitize}）`)
      resolve({
        server,
        port,
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
