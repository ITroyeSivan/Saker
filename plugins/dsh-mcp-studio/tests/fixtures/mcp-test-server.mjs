/**
 * Minimal MCP test server — the fixture the proxy integration tests drive.
 *
 * Two reasons this exists instead of driving Yakit/Burp:
 *  1. those are desktop apps that are not always running, and a test that skips when the
 *     service is down proves nothing;
 *  2. the interesting behaviour is protocol-level (session id bookkeeping, SSE framing,
 *     isError propagation, catalog size), and a real server lets us pin it exactly.
 *
 * Zero dependencies, two transports:
 *   stdio              `node mcp-test-server.mjs`
 *   streamable-http    `node mcp-test-server.mjs --http 18931 [--sse]`
 *
 * `--sse` makes every response an `text/event-stream` frame, which exercises the client's
 * SSE branch. HTTP mode requires the issued `mcp-session-id` on every non-initialize
 * request and answers `400 Missing session ID` otherwise — the same shape Yakit enforces,
 * so a client that forgets the header fails here too.
 *
 * Nothing is ever written to stdout in stdio mode: that stream is the wire.
 */
import http from 'node:http'
import process from 'node:process'

export const PROTOCOL_VERSION = '2025-06-18'
export const SERVER_NAME = 'mcp-test-server'
export const SERVER_VERSION = '1.0.0'
/** Distinctive marker: a successful `secret` call proves the round trip really happened. */
export const SECRET = 'MCP-TEST-ROUNDTRIP-OK'

/** Filler tools, so the catalog has a size worth compressing (`auto` threshold tests). */
const FILLER_COUNT = 24

/** Tool catalog. `call` receives the parsed arguments and returns the tool result body. */
export const TOOLS = [
  {
    name: 'echo',
    description: '回显给定文本（冒烟用）。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
      additionalProperties: false,
    },
    call: args => ({ content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }] }),
  },
  {
    name: 'add',
    description: '两个整数相加。',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    call: args => ({ content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] }),
  },
  {
    name: 'secret',
    description: '返回固定的往返标记，用于确认调用真的落到了 server 上。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => ({ content: [{ type: 'text', text: SECRET }], structuredContent: { marker: SECRET } }),
  },
  {
    name: 'boom',
    description: '总是返回 isError 的工具（错误传播路径）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => ({ content: [{ type: 'text', text: 'deliberate failure' }], isError: true }),
  },
  {
    name: 'slow',
    description: '等待 ms 毫秒后返回（超时路径）。',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'integer' } },
      required: ['ms'],
      additionalProperties: false,
    },
    call: async args => {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(args.ms) || 0)))
      return { content: [{ type: 'text', text: `slept ${String(args.ms)}` }] }
    },
  },
  {
    name: 'union_input',
    description: '参数是联合类型（验证参数声明退化为 json 而不是猜成 string）。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { oneOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false }] },
        mode: { type: 'string', enum: ['fast', 'slow'] },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    call: args => ({ content: [{ type: 'text', text: `selector=${JSON.stringify(args.selector)} mode=${String(args.mode ?? '')}` }] }),
  },
  ...Array.from({ length: FILLER_COUNT }, (_, index) => ({
    name: `scan_target_${String(index + 1).padStart(2, '0')}`,
    description: `第 ${index + 1} 号扫描适配器：执行目标探测并返回结果概要。`,
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '目标 URL' } },
      required: ['url'],
      additionalProperties: false,
    },
    call: args => ({ content: [{ type: 'text', text: `scan_target_${String(index + 1).padStart(2, '0')} -> ${String(args.url ?? '')}` }] }),
  })),
]

/** A name no tool uses — the client must reject it locally, without asking the server. */
export const NOT_A_TOOL = 'this_tool_does_not_exist'

function ok(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * Handle one decoded JSON-RPC message.
 * @param message - the decoded request or notification.
 * @param tools - catalog to serve; a smaller slice models a small server for `auto` tests.
 * @returns the response object, or `undefined` for notifications.
 */
export async function handleMessage(message, tools = TOOLS) {
  const id = message?.id
  const method = message?.method
  if (method === 'notifications/initialized') return undefined
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    })
  }
  if (method === 'tools/list') {
    return ok(id, {
      tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    })
  }
  if (method === 'tools/call') {
    const name = message?.params?.name
    const tool = tools.find(candidate => candidate.name === name)
    if (tool === undefined) return error(id, -32602, `unknown tool: ${String(name)}`)
    const result = await tool.call(message?.params?.arguments ?? {})
    return ok(id, result)
  }
  return error(id, -32601, `method not found: ${String(method)}`)
}

/** First `size` tools of the fixture catalog — how a "small server" is modelled. */
export function catalogOfSize(size) {
  return TOOLS.slice(0, Math.max(0, Math.min(size, TOOLS.length)))
}

/** Attach the newline-delimited stdio protocol to the given streams. */
export function serveStdio(options = {}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const tools = options.tools ?? TOOLS
  const exitAfterTool = options.exitAfterTool
  let buffer = ''
  input.setEncoding('utf8')
  input.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const frame = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (frame === '') continue
      let message
      try {
        message = JSON.parse(frame)
      } catch {
        continue
      }
      void Promise.resolve(handleMessage(message, tools)).then((response) => {
        if (response === undefined) return
        const frame = `${JSON.stringify(response)}\n`
        if (exitAfterTool !== undefined && message?.method === 'tools/call' && message?.params?.name === exitAfterTool) {
          output.write(frame, () => { process.exit(0) })
        } else {
          output.write(frame)
        }
      })
    }
  })
}

/** Start the streamable-HTTP transport. Resolves with the listening port. */
export function startHttpServer(options = {}) {
  const sse = options.sse === true
  const tools = options.tools ?? TOOLS
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const forceSse = sse || url.searchParams.get('sse') === '1'
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      let message
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400).end()
        return
      }
      const isInitialize = message?.method === 'initialize'
      // Session enforcement, mirroring Yakit: after initialize every request must echo the
      // id the server issued, or it is rejected outright.
      const presented = String(req.headers['mcp-session-id'] ?? '').trim()
      if (!isInitialize && options.sessionId !== undefined && presented !== options.sessionId) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing session ID' }))
        return
      }
      const headers = { 'content-type': forceSse ? 'text/event-stream' : 'application/json' }
      if (isInitialize && options.sessionId !== undefined) headers['mcp-session-id'] = options.sessionId
      void Promise.resolve(handleMessage(message, tools)).then((response) => {
        if (response === undefined) {
          res.writeHead(202, headers).end()
          return
        }
        const body = forceSse ? `data: ${JSON.stringify(response)}\n\n` : JSON.stringify(response)
        res.writeHead(200, headers).end(body)
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 })
    })
  })
}

const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('/mcp-test-server.mjs')
if (invokedDirectly) {
  const toolsIndex = process.argv.indexOf('--tools')
  const tools = toolsIndex >= 0 ? catalogOfSize(Number(process.argv[toolsIndex + 1]) || TOOLS.length) : TOOLS
  const httpIndex = process.argv.indexOf('--http')
  if (httpIndex >= 0) {
    const port = Number(process.argv[httpIndex + 1]) || 0
    startHttpServer({ port, sse: process.argv.includes('--sse'), sessionId: 'test-session-1', tools })
      .then(({ port: bound }) => { process.stdout.write(`${String(bound)}\n`) })
      .catch(() => process.exit(1))
  } else {
    const exitToolIndex = process.argv.indexOf('--exit-after-tool')
    const exitAfterTool = exitToolIndex >= 0 ? process.argv[exitToolIndex + 1] : undefined
    serveStdio({ tools, exitAfterTool })
  }
}
