import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
const home = mkdtempSync(join(tmpdir(), 'saker-research-'))
process.env.DSH_HOME = home
const { apply } = await import('../plugins/dsh-nday-hunter/lib/index.js')
const store = openStore(join(home, 'redteam-results', 'results.db'))
const tools = new Map()
apply({ tools: { register: tool => tools.set(tool.name, tool) }, effect: () => {} }, { exposedTools: ['zday_pattern'] })
const server = createServer((req, res) => {
  if (req.url.startsWith('/api/refund')) { res.setHeader('content-type', 'application/json'); res.end('{"refund":true,"amount":1}') }
  else res.end('<html>static portal</html>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}/api/refund?amount=1`
const response = await fetch(endpoint)
const request = { id: 'baseline', endpoint, authContext: 'fixture-user', revision: 'v1', valid: true, kind: 'api',
  request: 'GET /api/refund?amount=1 HTTP/1.1', response: `HTTP/1.1 ${response.status} OK\r\n\r\n${await response.text()}`,
  inputs: [{ name: 'amount', location: 'query', evidenceIds: ['baseline'] }] }
const context = { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [request] }
const execute = id => tools.get('zday_pattern').execute({ surface: '退款 幂等 并发', requestId: 'baseline' }, { agent: { session: { id } } })
let failures = 0
async function test(name, fn) { try { await fn(); console.log('ok   ' + name) } catch (error) { failures++; console.log('FAIL ' + name + ': ' + error.message) } }
try {
  await test('actual observed API baseline enters hypothesis planning and carries identity revision and endpoint', async () => {
    saveTaskContext(store, 'ready', context)
    const result = await execute('ready')
    assert.equal(result.ok, true, result.error)
    assert(result.patterns.length > 0)
    assert.equal(result.inputs[0].endpoint, endpoint)
    assert.match(result.text, /fixture-user/)
    assert.match(result.text, /不是漏洞发现/)
  })
  await test('static portal invalid identity failed response missing scope or unobserved input cannot start deep research', async () => {
    for (const [i, patch] of [{ kind: 'portal' }, { valid: false }, { response: 'HTTP/1.1 403 Forbidden' }, { inputs: [] },
      { inputs: [{ name: 'amount', location: 'query', evidenceIds: ['unrelated'] }] }].entries()) {
      saveTaskContext(store, `blocked-${i}`, { ...context, requests: [{ ...request, ...patch }] })
      const result = await execute(`blocked-${i}`)
      assert.equal(result.reason, 'backend_api_missing')
      assert.deepEqual(result.patterns, [])
    }
    saveTaskContext(store, 'no-scope', { ...context, assets: [{ ...context.assets[0], inScope: false }] })
    assert.equal((await execute('no-scope')).blocked, true)
  })
  await test('another session or free surface text never borrows a prior API baseline', async () => {
    assert.equal((await execute('unknown')).blocked, true)
    const result = await tools.get('zday_pattern').execute({ surface: '后台API 退款' }, {})
    assert.equal(result.blocked, true)
    assert.deepEqual(result.patterns, [])
  })
  await test('multiple API entries and revisions require explicit selection instead of mixing research inputs', async () => {
    saveTaskContext(store, 'multiple', { ...context, requests: [request, { ...request, revision: 'v2' }] })
    assert.equal((await execute('multiple')).reason, 'research_input_ambiguous')
    const selected = await tools.get('zday_pattern').execute({ surface: '退款 并发', requestId: 'baseline', requestRevision: 'v2' }, { agent: { session: { id: 'multiple' } } })
    assert.equal(selected.inputs.length, 1)
    assert.equal(selected.inputs[0].revision, 'v2')
    assert(selected.patterns.length)
    assert.equal((await tools.get('zday_pattern').execute({ surface: '退款', requestId: 'baseline', requestRevision: 'missing' }, { agent: { session: { id: 'multiple' } } })).reason, 'backend_api_missing')
  })
} finally {
  store.close()
  await new Promise(resolve => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
