/**
 * Proxy exposure tests.
 *
 * Two layers, deliberately:
 *  - pure logic (search ranking, schema conversion, exposure decision) — no I/O;
 *  - a real round trip against `tests/fixtures/mcp-test-server.mjs` over **both** transports,
 *    through the actual `ProxyRegistry` and the real tool definitions it registers.
 *
 * The second layer is the point: a fake channel would prove the wiring compiles, not that a
 * call reaches a server and its answer comes back. Every call assertion checks a value that
 * only the server can produce (`echo:<text>`, `add`'s arithmetic, `SECRET`).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import {
  applyToolHint,
  decideExposure,
  paramHint,
  ProxyRegistry,
  rankTools,
  renderSearchText,
  scoreTool,
  summarizeCatalog,
  tokenize,
  toolLine,
  toParameterDeclaration,
  toToolParameters,
  META_TOOL_CALL,
  META_TOOL_SEARCH,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  type ToolMeta,
} from '../src/proxy.ts'
import { catalogOfSize, SECRET, startHttpServer, TOOLS } from './fixtures/mcp-test-server.mjs'
import { handshake, listTools, openChannel } from '../src/transport.ts'
import type { ServerEntry, StudioSection } from '../src/types.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Forward slashes: `splitArgs` treats `\` as an escape outside quotes. */
const FIXTURE = path.join(HERE, 'fixtures', 'mcp-test-server.mjs').replace(/\\/g, '/')

const cleanups: Array<() => void | Promise<void>> = []
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

/** A complete row; only the interesting bits need stating in a test. */
function makeServer(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return {
    id: 'row-1',
    enabled: true,
    name: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    argsLine: FIXTURE,
    env: {},
    cwd: '',
    url: '',
    headers: {},
    toolCallTimeoutMs: 10_000,
    failOnStartupError: false,
    exposure: 'proxy',
    proxyThreshold: 10,
    directTools: [],
    ...overrides,
  }
}

function sectionOf(...servers: ServerEntry[]): StudioSection {
  return { servers }
}

/** A tools registry stand-in that keeps every definition, so tests can execute the real ones. */
function captureRegistry() {
  interface CapturedTool {
    description?: string
    parameters?: Record<string, any>
    execute: (args: any, exec?: unknown) => unknown
    render?: (args: any, value: any) => any
  }
  const registered = new Map<string, CapturedTool>()
  const ctx = {
    tools: {
      // `defineTool` is identity-shaped, so the definition arrives exactly as authored:
      // `render` lives under `output`, and flattening it here mirrors what the real
      // registry does before it hands a value to the model.
      register: (definition: unknown) => {
        const def = definition as {
          name: string
          description?: string
          parameters?: Record<string, any>
          output?: { render?: (args: any, value: any) => any }
          execute?: (args: any, exec?: unknown) => unknown
        }
        registered.set(def.name, {
          description: def.description,
          parameters: def.parameters,
          execute: def.execute as CapturedTool['execute'],
          render: def.output?.render,
        })
        return () => { registered.delete(def.name) }
      },
    },
  }
  return { registered, ctx }
}

/** Start the fixture over HTTP in-process and hand back a matching row. */
async function httpFixture(options: { sse?: boolean; tools?: number } = {}) {
  const { server, port } = await startHttpServer({
    sse: options.sse === true,
    sessionId: 'test-session-1',
    tools: options.tools === undefined ? TOOLS : catalogOfSize(options.tools),
  })
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return {
    url: `http://127.0.0.1:${String(port)}/mcp${options.sse === true ? '?sse=1' : ''}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

describe('proxy: pure logic', () => {
  it('adds the Yakit flow-scope and array-parameter hints without changing unrelated descriptions', () => {
    const hinted = applyToolHint('yakit', 'query_http_flow', 'Query HTTP flow data.')
    assert.match(hinted, /sourceType:"all"/)
    assert.match(hinted, /includePath\/excludePath are arrays/)
    assert.ok(hinted.slice(0, 140).includes('sourceType:"all"'))
    assert.ok(hinted.slice(0, 140).includes('includePath/excludePath'))
    assert.equal(applyToolHint('yakit', 'auto_decode', 'decode'), 'decode')
    assert.equal(applyToolHint('burp', 'send_http1_request', 'send'), 'send')
  })

  it('decideExposure honours explicit settings and treats an unknown count as pending', () => {
    assert.equal(decideExposure({ exposure: 'direct', proxyThreshold: 10 }, 999), 'direct')
    assert.equal(decideExposure({ exposure: 'proxy', proxyThreshold: 10 }, 1), 'proxy')
    assert.equal(decideExposure({ exposure: 'hybrid', proxyThreshold: 10 }, 1), 'proxy')
    // `auto` cannot answer before the server has been listed: answering `direct` here is how
    // a big server would silently stay uncompressed forever.
    assert.equal(decideExposure({ exposure: 'auto', proxyThreshold: 10 }, undefined), 'pending')
    assert.equal(decideExposure({ exposure: 'auto', proxyThreshold: 10 }, 9), 'direct')
    assert.equal(decideExposure({ exposure: 'auto', proxyThreshold: 10 }, 10), 'proxy')
    assert.equal(decideExposure({ exposure: 'auto', proxyThreshold: 30 }, 29), 'direct')
  })

  it('tokenize splits on whitespace and separators, lowercases, and expands Chinese aliases', () => {
    assert.deepEqual(tokenize('Scan URL'), ['scan', 'url'])
    assert.deepEqual(tokenize('a,b;c|d/e'), ['a', 'b', 'c', 'd', 'e'])
    assert.deepEqual(tokenize('   '), [])
    assert.deepEqual(tokenize(undefined), [])
    assert.deepEqual(tokenize('HTTP 流量 查询'), ['http', '流量', 'flow', 'traffic', '查询', 'query', 'search'])
  })

  const metas: ToolMeta[] = [
    { server: 'burp', name: 'scan', description: 'start a scan', inputSchema: {} },
    { server: 'burp', name: 'scan_url', description: 'scan one url', inputSchema: {} },
    { server: 'yakit', name: 'url_fetch', description: 'fetch a url and scan it', inputSchema: {} },
    { server: 'yakit', name: 'noise', description: 'unrelated', inputSchema: {} },
  ]

  it('scoreTool prefers exact names, then prefixes, then descriptions', () => {
    assert.equal(scoreTool(metas[0]!, ['scan']), 1_000)
    assert.ok(scoreTool(metas[1]!, ['scan']) > 0)
    assert.equal(scoreTool(metas[3]!, ['scan']), 0)
    assert.equal(scoreTool(metas[3]!, []), 1)
  })

  it('rankTools drops non-matches, filters by server, and caps the limit', () => {
    // Name hits outrank description-only hits, so `url_fetch` (whose description says
    // "scan it") comes last rather than being excluded.
    assert.deepEqual(rankTools(metas, { query: 'scan' }).map(m => m.name), ['scan', 'scan_url', 'url_fetch'])
    assert.deepEqual(rankTools(metas, { query: 'zzz-nothing-matches' }), [])
    assert.deepEqual(rankTools(metas, { server: 'yakit' }).map(m => m.name), ['noise', 'url_fetch'])
    assert.equal(rankTools(metas, { query: '', limit: 2 }).length, 2)
    assert.equal(rankTools(metas).length, Math.min(SEARCH_DEFAULT_LIMIT, metas.length))
    const big: ToolMeta[] = Array.from({ length: 50 }, (_, i) => ({ server: 's', name: `t${i}`, description: '', inputSchema: {} }))
    assert.equal(rankTools(big, {}).length, SEARCH_DEFAULT_LIMIT)
    assert.equal(rankTools(big, { limit: 999 }).length, SEARCH_MAX_LIMIT)
  })

  it('Chinese flow-query aliases surface query_http_flow ahead of generic HTTP tools', () => {
    const flow: ToolMeta = {
      server: 'yakit',
      name: 'query_http_flow',
      description: 'Query HTTP flow data from the current project.',
      inputSchema: {},
    }
    assert.equal(rankTools([...metas, flow], { query: 'HTTP 流量 查询' })[0]?.name, 'query_http_flow')
  })

  it('paramHint marks optionals and open schemas', () => {
    assert.equal(paramHint({ properties: { a: {}, b: {} }, required: ['a'] }), 'a, b?')
    assert.equal(paramHint({ properties: {}, additionalProperties: true }), '…')
    assert.equal(paramHint({}), '')
    assert.equal(paramHint(undefined), '')
  })

  it('toolLine carries the server, the argument hint, and a one-line description', () => {
    const line = toolLine({ server: 'burp', name: 'scan', description: 'start\n  a  scan', inputSchema: { properties: { url: {} }, required: ['url'] } })
    assert.equal(line, '- burp.scan(url) — start a scan')
  })

  it('renderSearchText explains emptiness differently from no-match', () => {
    assert.match(renderSearchText([], { query: '', total: 0 }), /没有启用任何被代理/)
    assert.match(renderSearchText([], { query: 'zzz', total: 30 }), /没有匹配「zzz」.*30 条/s)
    const text = renderSearchText([metas[0]!], { query: 'scan', total: 30 })
    assert.match(text, /命中 1 条（编目共 30 条）/)
    assert.match(text, /- burp\.scan\(\)/)
    assert.match(text, new RegExp(META_TOOL_CALL))
  })

  it('summarizeCatalog counts per server, sorted', () => {
    assert.deepEqual(summarizeCatalog(metas), [{ server: 'burp', tools: 2 }, { server: 'yakit', tools: 2 }])
    assert.deepEqual(summarizeCatalog([]), [])
  })

  it('toParameterDeclaration widens anything it cannot express, never guesses', () => {
    assert.deepEqual(toParameterDeclaration({ type: 'string', description: 'x' }), { type: 'string', description: 'x' })
    assert.deepEqual(toParameterDeclaration({ type: 'string', enum: ['a', 'b'] }), { type: 'string', enum: ['a', 'b'] })
    assert.deepEqual(toParameterDeclaration({ type: 'array' }), { type: 'array' })
    assert.deepEqual(toParameterDeclaration({ type: 'object' }), { type: 'object', additionalProperties: true })
    // A union must not be declared `string`: the registry validates arguments, so a wrong
    // declaration rejects the call the model was told to make.
    const union = toParameterDeclaration({ oneOf: [{ type: 'string' }, { type: 'object' }] })
    assert.equal(union.type, 'json')
    assert.match(String(union.description), /复杂\/联合类型/)
    assert.equal(toParameterDeclaration({ type: 'unknown-type' }).type, 'json')
  })

  it('toToolParameters marks required properties and survives an empty schema', () => {
    const parameters = toToolParameters({
      type: 'object',
      properties: { url: { type: 'string', description: 'target' }, mode: { type: 'string', enum: ['a'] } },
      required: ['url'],
      additionalProperties: false,
    })
    assert.deepEqual(parameters.url, { type: 'string', description: 'target', required: true })
    assert.deepEqual(parameters.mode, { type: 'string', enum: ['a'] })
    assert.deepEqual(toToolParameters(undefined), {})
    assert.deepEqual(toToolParameters({ type: 'object' }), {})
  })
})

describe('proxy: transport round trip (real server, both transports)', () => {
  it('stdio: handshake, catalog, and a real call', async () => {
    const channel = openChannel(makeServer())
    cleanups.push(() => channel.close())
    const info = await handshake(channel, 'test-client')
    assert.equal(info.serverName, 'mcp-test-server')
    const tools = await listTools(channel)
    assert.equal(tools.length, TOOLS.length)
    assert.ok(tools.some(tool => tool.name === 'secret'))
    const result = await channel.request('tools/call', { name: 'echo', arguments: { text: 'hi' } })
    assert.deepEqual(result, { content: [{ type: 'text', text: 'echo:hi' }] })
  })

  it('streamable-http: the issued session id is echoed on every later request', async () => {
    const fixture = await httpFixture()
    const channel = openChannel(makeServer({ transport: 'streamable-http', url: fixture.url, name: 'http-fixture' }))
    cleanups.push(() => channel.close())
    await handshake(channel, 'test-client')
    // The fixture rejects any post-initialize request without the id it issued (400),
    // so a successful list is the proof that the bookkeeping works.
    const tools = await listTools(channel)
    assert.equal(tools.length, TOOLS.length)
    const result = await channel.request('tools/call', { name: 'add', arguments: { a: 2, b: 40 } })
    assert.deepEqual(result, { content: [{ type: 'text', text: '42' }] })
  })

  it('streamable-http: SSE-framed responses are parsed', async () => {
    const fixture = await httpFixture({ sse: true })
    const channel = openChannel(makeServer({ transport: 'streamable-http', url: fixture.url, name: 'sse-fixture' }))
    cleanups.push(() => channel.close())
    await handshake(channel, 'test-client')
    const tools = await listTools(channel)
    assert.equal(tools.length, TOOLS.length)
    const result = await channel.request('tools/call', { name: 'secret', arguments: {} })
    assert.deepEqual(result, { content: [{ type: 'text', text: SECRET }], structuredContent: { marker: SECRET } })
  })

  it('a request timeout rejects the call without killing the channel', async () => {
    const channel = openChannel(makeServer({ toolCallTimeoutMs: 200 }))
    cleanups.push(() => channel.close())
    await handshake(channel, 'test-client')
    await assert.rejects(
      channel.request('tools/call', { name: 'slow', arguments: { ms: 1_500 } }, 200),
      /timed out after 200ms/,
    )
    // The dropped response must not desynchronise the next call.
    const after = await channel.request('tools/call', { name: 'echo', arguments: { text: 'still here' } })
    assert.deepEqual(after, { content: [{ type: 'text', text: 'echo:still here' }] })
  })

  it('a closed channel reports why instead of hanging', async () => {
    const channel = openChannel(makeServer())
    channel.close()
    assert.equal(channel.alive, false)
    await assert.rejects(channel.request('tools/list', {}), /closed/)
  })

  it('stdio EPIPE rejects the request without crashing the host process', async () => {
    const source = readFileSync(path.join(HERE, '..', 'src', 'transport.ts'), 'utf8')
    assert.match(source, /child\.stdin\?\.on\('error'/, 'stdio error listener must stay installed')
    const channel = openChannel(makeServer({
      argsLine: '-e "process.exit(0)"',
    }))
    cleanups.push(() => channel.close())
    await assert.rejects(
      channel.request('initialize', { padding: 'x'.repeat(2_000_000) }, 500),
      /stdio|writable|closed|exited|EPIPE/i,
    )
  })
})

describe('proxy: registry over a real server', () => {
  it('registers exactly two meta-tools and really calls through them', async () => {
    const server = makeServer()
    const section = () => sectionOf(server)
    const registry = new ProxyRegistry(section)
    cleanups.push(() => registry.closeAll())
    registry.syncServers([server])
    await registry.ensureAll()
    assert.equal(registry.catalog().length, TOOLS.length)
    assert.equal(registry.hasCatalog('fixture'), true)
    assert.equal(registry.listedCount('fixture'), TOOLS.length)

    const { registered, ctx } = captureRegistry()
    registry.registerMetaTools(ctx)
    // The whole point of the mode: two names, not thirty.
    assert.deepEqual([...registered.keys()].sort(), [META_TOOL_CALL, META_TOOL_SEARCH])

    const search = registered.get(META_TOOL_SEARCH)!
    const found = await search.execute({ query: 'scan target 07' }) as { ok: boolean; text: string; count: number }
    assert.equal(found.ok, true)
    assert.match(found.text, /fixture\.scan_target_07/)
    assert.match(found.text, new RegExp(META_TOOL_CALL))
    // The render path is what the model actually reads.
    assert.deepEqual(search.render?.(undefined, found), [{ type: 'text', text: found.text }])

    const call = registered.get(META_TOOL_CALL)!
    const hit = await call.execute({ server: 'fixture', tool: 'secret', args: {} }) as { ok: boolean; text: string }
    assert.equal(hit.ok, true)
    assert.equal(hit.text, SECRET)
    assert.deepEqual(call.render?.(undefined, hit), [{ type: 'text', text: SECRET }])

    const added = await call.execute({ server: 'fixture', tool: 'add', args: { a: 20, b: 22 } }) as { ok: boolean; text: string }
    assert.equal(added.text, '42')

    const echoed = await call.execute({ server: 'fixture', tool: 'echo', args: { text: '通过代理' } }) as { ok: boolean; text: string }
    assert.equal(echoed.text, 'echo:通过代理')
  })

  it('reopens a dead stdio channel even while its catalog is still fresh', async () => {
    const server = makeServer({
      argsLine: `${FIXTURE} --exit-after-tool secret`,
      name: 'flapping',
    })
    const registry = new ProxyRegistry(() => sectionOf(server))
    cleanups.push(() => registry.closeAll())
    registry.syncServers([server])
    await registry.ensureAll()
    assert.equal(registry.hasCatalog('flapping'), true)

    const first = await registry.call('flapping', 'secret', {})
    assert.equal(first.ok, true)
    assert.equal(first.text, SECRET)

    // The fixture exits after replying. Wait until the child-close signal lands, then issue a
    // second call while `listedAt` is still well inside CATALOG_TTL_MS. Before the liveness
    // check this returned `server exited`; after the fix it reconnects and serves the call.
    await new Promise(resolve => setTimeout(resolve, 150))
    const second = await registry.call('flapping', 'secret', {})
    assert.equal(second.ok, true, String(second.error))
    assert.equal(second.text, SECRET)
  })

  it('rejects an unknown tool locally and suggests near names', async () => {
    const server = makeServer()
    const registry = new ProxyRegistry(() => sectionOf(server))
    cleanups.push(() => registry.closeAll())
    registry.syncServers([server])
    await registry.ensureAll()
    const result = await registry.call('fixture', 'scan_target_0', {})
    assert.equal(result.ok, false)
    assert.match(String(result.error), /没有工具「scan_target_0」/)
    assert.match(String(result.error), /scan_target_01/)
    const wrongServer = await registry.call('nope', 'echo', {})
    assert.match(String(wrongServer.error), /未知 server「nope」/)
  })

  it('propagates a server-side isError instead of reporting success', async () => {
    const server = makeServer()
    const registry = new ProxyRegistry(() => sectionOf(server))
    cleanups.push(() => registry.closeAll())
    registry.syncServers([server])
    await registry.ensureAll()
    const result = await registry.call('fixture', 'boom', {})
    assert.equal(result.ok, false)
    assert.equal(result.error, 'deliberate failure')
  })

  it('reports an unreachable server as an error note, and never throws', async () => {
    const dead = makeServer({ transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', name: 'dead' })
    const registry = new ProxyRegistry(() => sectionOf(dead))
    cleanups.push(() => registry.closeAll())
    registry.syncServers([dead])
    await registry.ensureAll()
    assert.equal(registry.hasCatalog('dead'), false)
    assert.equal(registry.listedCount('dead'), undefined)
    assert.equal(registry.stateOf('dead')?.state, 'error')
    const search = await registry.search({ query: 'echo' })
    assert.equal(search.matches.length, 0)
    assert.equal(search.errors.length, 1)
    assert.equal(search.errors[0]!.name, 'dead')
    const call = await registry.call('dead', 'echo', {})
    assert.equal(call.ok, false)
    assert.match(String(call.error), /不可用/)
  })

  it('drops a mount when its row goes away or is renamed', async () => {
    const server = makeServer()
    const registry = new ProxyRegistry(() => sectionOf(server))
    cleanups.push(() => registry.closeAll())
    registry.syncServers([server])
    await registry.ensureAll()
    assert.equal(registry.snapshot().length, 1)
    registry.syncServers([])
    assert.deepEqual(registry.snapshot(), [])
    assert.equal(registry.hasCatalog('fixture'), false)
    // A renamed row must be rebuilt, not silently kept under the old name.
    registry.syncServers([server])
    await registry.ensureAll()
    registry.syncServers([{ ...server, name: 'renamed' }])
    assert.equal(registry.snapshot()[0]!.name, 'renamed')
    assert.equal(registry.hasCatalog('fixture'), false)
    await registry.ensureAll()
    assert.equal(registry.hasCatalog('renamed'), true)
  })

  it('rebuilds a proxied mount when the same row changes connection config', async () => {
    const server = makeServer({ argsLine: `${FIXTURE} --tools 3` })
    let current = server
    const registry = new ProxyRegistry(() => sectionOf(current))
    cleanups.push(() => registry.closeAll())
    registry.syncServers([current])
    await registry.ensureAll()
    assert.equal(registry.listedCount('fixture'), 3)

    current = { ...server, argsLine: FIXTURE }
    registry.syncServers([current])
    await registry.ensureAll()
    assert.equal(registry.listedCount('fixture'), TOOLS.length)
    assert.equal(registry.catalogFor('fixture').some(tool => tool.name === 'scan_target_07'), true)
  })

  it('auto resolves to proxy for a big catalog and to direct for a small one', async () => {
    const big = makeServer({ id: 'big', name: 'big', exposure: 'auto', proxyThreshold: 10 })
    const small = makeServer({ id: 'small', name: 'small', exposure: 'auto', proxyThreshold: 10, argsLine: `${FIXTURE} --tools 3` })
    const registry = new ProxyRegistry(() => sectionOf(big, small))
    cleanups.push(() => registry.closeAll())
    registry.syncServers([big, small])
    // Before listing, `auto` must not commit to a direct mount.
    assert.equal(decideExposure(big, registry.listedCount('big')), 'pending')
    await registry.ensureAll()
    assert.equal(decideExposure(big, registry.listedCount('big')), 'proxy')
    assert.equal(registry.listedCount('big'), TOOLS.length)
    assert.equal(decideExposure(small, registry.listedCount('small')), 'direct')
    assert.equal(registry.listedCount('small'), 3)
  })

  /**
   * The live-host regression: `auto` decided "direct" for a 3-tool server, which removes it
   * from the proxy set — and with the count read off the live mount, that same removal erased
   * the evidence the decision was based on. The row then read as `pending`, went back into the
   * proxy set, was re-mounted, re-listed, re-decided, and its direct mount was torn down on
   * every lap. Nothing threw; the tools just never stayed visible. Only a real host run showed
   * it, because the unit tests called listedCount() without ever removing the row first.
   */
  it('auto keeps the count it learned after the row leaves the proxy set', async () => {
    const big = makeServer({ id: 'big', name: 'big', exposure: 'auto', proxyThreshold: 10 })
    const small = makeServer({ id: 'small', name: 'small', exposure: 'auto', proxyThreshold: 10, argsLine: `${FIXTURE} --tools 3` })
    let rows: ServerEntry[] = [big, small]
    const registry = new ProxyRegistry(() => sectionOf(...rows))
    cleanups.push(() => registry.closeAll())
    const proxied = (): ServerEntry[] =>
      rows.filter(row => decideExposure(row, registry.listedCount(row.name)) !== 'direct')

    registry.syncServers(proxied())
    await registry.ensureAll()
    assert.equal(decideExposure(small, registry.listedCount('small')), 'direct')

    // Reconcile exactly the way the host does it: a `direct` row is no longer handed over.
    registry.syncServers(proxied())
    assert.equal(registry.snapshot().some(mount => mount.name === 'small'), false, 'the direct row must leave the proxy')
    assert.equal(registry.listedCount('small'), 3, 'the learned count must outlive the mount')
    assert.equal(decideExposure(small, registry.listedCount('small')), 'direct', 'and must not flip back to pending')
    // A second lap of the same reconcile is what used to oscillate; it must now be a no-op.
    registry.syncServers(proxied())
    assert.equal(registry.snapshot().some(mount => mount.name === 'small'), false)

    // Editing the row makes the old measurement non-evidence: it describes another server.
    rows = [{ ...small, argsLine: `${FIXTURE} --tools 20` }, big]
    registry.syncServers(proxied())
    assert.equal(registry.listedCount('small'), undefined, 'an edited row must be re-measured')

    // And an explicit forget is honoured too.
    rows = [big, small]
    registry.syncServers(proxied())
    registry.dropServer('small')
    assert.equal(registry.listedCount('small'), undefined)
  })
})

describe('proxy: hybrid promotions', () => {
  it('promotes the named tools to real mcp__ entries with usable parameters', async () => {
    const server = makeServer({ exposure: 'hybrid', directTools: ['echo', 'union_input', 'not_advertised'] })
    const registry = new ProxyRegistry(() => sectionOf(server))
    cleanups.push(() => registry.closeAll())
    registry.syncServers([server])
    await registry.ensureAll()
    const { registered, ctx } = captureRegistry()
    const result = registry.registerPromotedTools(ctx, server)
    assert.deepEqual(result.registered, ['mcp__fixture__echo', 'mcp__fixture__union_input'])
    assert.deepEqual(result.missing, ['not_advertised'])
    assert.equal(result.disposers.length, 2)

    const echo = registered.get('mcp__fixture__echo')!
    assert.deepEqual(echo.parameters, { text: { type: 'string', description: '要回显的文本', required: true } })
    const echoed = await echo.execute({ text: 'promoted' }) as { ok: boolean; text: string }
    assert.equal(echoed.text, 'echo:promoted')
    assert.deepEqual(echo.render?.(undefined, echoed), [{ type: 'text', text: 'echo:promoted' }])

    // The union parameter must arrive as `json`, not as a guess that would reject the call.
    const union = registered.get('mcp__fixture__union_input')!
    assert.equal((union.parameters!.selector as { type: string }).type, 'json')
    assert.deepEqual(union.parameters!.mode, { type: 'string', enum: ['fast', 'slow'] })
    const unionResult = await union.execute({ selector: { id: 7 }, mode: 'fast' }) as { ok: boolean; text: string }
    assert.equal(unionResult.ok, true)
    assert.match(unionResult.text, /selector=\{"id":7\} mode=fast/)

    // Disposal must actually withdraw the tool.
    for (const dispose of result.disposers) dispose()
    assert.deepEqual([...registered.keys()], [])
  })

  it('an error from a promoted tool surfaces as ok:false', async () => {
    const server = makeServer({ exposure: 'hybrid', directTools: ['boom'] })
    const registry = new ProxyRegistry(() => sectionOf(server))
    cleanups.push(() => registry.closeAll())
    registry.syncServers([server])
    await registry.ensureAll()
    const { registered, ctx } = captureRegistry()
    registry.registerPromotedTools(ctx, server)
    const boom = registered.get('mcp__fixture__boom')!
    const result = await boom.execute({}) as { ok: boolean; error: string; text: string }
    assert.equal(result.ok, false)
    assert.equal(result.error, 'deliberate failure')
    assert.equal(result.text, 'deliberate failure')
  })
})
