import assert from 'node:assert/strict'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { workbenchQuery } from '../plugins/dsh-redteam-results/lib/workbench.js'

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}

await test('资产覆盖图连接资产→请求→检查，并给出真实分母/未测/受阻', () => {
  const store = openStore(':memory:')
  try {
    const rootId = 'coverage-root'
    startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://example.com', budget: { workers: 0 } })
    saveTaskContext(store, rootId, {
      assets: [{ id: 'asset-1', url: 'https://example.com', inScope: true, reachable: true }],
      requests: [{ id: 'request-1', endpoint: 'https://example.com/login', method: 'GET',
        authContext: 'account-a', valid: false, revision: 'r1' }],
      checks: [], methods: [],
    })
    store.db.prepare('INSERT INTO checked_items(session_id,context_key,record,updated_at) VALUES(?,?,?,?)').run(
      rootId, 'coverage-1',
      JSON.stringify({ id: 'check-1', entryId: 'login-check', asset: 'https://example.com',
        check: '登录页检查', endpoint: 'https://example.com/login', authContext: 'account-a', status: 'not-hit' }),
      new Date().toISOString(),
    )
    const cover = workbenchQuery({}, store, { kind: 'assets.coverage', context: { rootId } }).data[0]
    assert.ok(cover.nodes.some(node => node.kind === 'asset' && node.id === 'asset-1'))
    assert.ok(cover.nodes.some(node => node.kind === 'endpoint' && node.id === 'request-1'))
    assert.ok(cover.nodes.some(node => node.kind === 'check'))
    const endpoint = cover.nodes.find(node => node.id === 'request-1')
    const check = cover.nodes.find(node => node.kind === 'check')
    assert.equal(endpoint.title, 'GET /login')
    assert.match(endpoint.subtitle, /example\.com.*身份 account-a/)
    assert.equal(check.title, '登录页检查')
    assert.match(check.subtitle, /身份 account-a.*已测未命中.*check-1/)
    assert.ok(cover.edges.some(edge => edge.from === 'asset-1' && edge.to === 'request-1' && edge.kind === 'exposes'))
    assert.ok(cover.edges.some(edge => edge.from === 'request-1' && edge.kind === 'tested-by'))
    assert.equal(cover.knownDenominator, 1)
    assert.equal(cover.checkDimensions.notHit, 1)
    assert.equal(cover.checkDimensions.notTested, 0)
  } finally { store.db.close() }
})

await test('无资产表时覆盖图用真实回执推导 host→endpoint', () => {
  const store = openStore(':memory:')
  try {
    const rootId = 'coverage-receipt-root'
    startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://example.com', budget: { workers: 0 } })
    store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(
      rootId, 'receipt-1',
      JSON.stringify({ request: 'GET https://example.com/ HTTP/1.1', status: 200, completedAt: '2026-11-14T00:00:00.000Z', outcome: 'response' }),
    )
    const cover = workbenchQuery({}, store, { kind: 'assets.coverage', context: { rootId } }).data[0]
    assert.ok(cover.nodes.some(node => node.kind === 'asset' && node.title === 'example.com'))
    assert.ok(cover.nodes.some(node => node.kind === 'endpoint'))
    assert.ok(cover.edges.some(edge => edge.kind === 'exposes'))
  } finally { store.db.close() }
})

console.log(failed ? `\n${failed} failed` : '\nall coverage graph tests passed')
process.exit(failed ? 1 : 0)
