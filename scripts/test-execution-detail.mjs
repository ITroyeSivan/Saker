import assert from 'node:assert/strict'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { workbenchQuery } from '../plugins/dsh-redteam-results/lib/workbench.js'

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}

await test('执行详情返回请求/响应并与列表行关联，秘密已遮蔽', () => {
  const store = openStore(':memory:')
  try {
    const rootId = 'execution-detail-root'
    startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://example.com', budget: { workers: 0 } })
    const request = 'GET /api/export?tenant=B HTTP/1.1\r\nHost: example.com\r\nAuthorization: Bearer top-secret-token\r\nCookie: sid=abc123\r\n\r\n'
    const responseHead = 'HTTP/1.1 403 Forbidden\r\nSet-Cookie: sid=server-secret\r\nContent-Type: application/json\r\n\r\n'
    store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(
      rootId, 'execution-detail-1',
      JSON.stringify({
        request, responseHead, responseBodyBase64: Buffer.from('{"error":"forbidden"}').toString('base64'),
        status: 403, outcome: 'response', responseBytes: 21, completedAt: '2026-11-14T00:00:00.000Z',
        identity: { name: 'Account A' }, source: 'host-http-execution',
      }),
    )
    const listed = workbenchQuery({}, store, { kind: 'execution.records', context: { rootId } }).data
    assert.ok(listed.some(row => row.kind === 'http' && row.id === 'execution-detail-1'))
    const detail = workbenchQuery({}, store, {
      kind: 'execution.detail', context: { rootId, executionId: 'execution-detail-1', executionKind: 'http' },
    }).data
    assert.equal(detail.status, 403)
    assert.equal(detail.identity, 'Account A')
    assert.match(detail.request, /Authorization: \*\*\*/)
    assert.doesNotMatch(detail.request, /top-secret-token/)
    assert.match(detail.request, /Cookie: \*\*\*/)
    assert.match(detail.responseHead, /Set-Cookie: \*\*\*/)
    assert.doesNotMatch(detail.responseHead, /server-secret/)
    assert.equal(detail.responseBody, '{"error":"forbidden"}')
    assert.equal(detail.bytes, 21)
    assert.ok(detail.refs.some(ref => ref.kind === 'receipt' && ref.id === 'execution-detail-1'))
  } finally { store.db.close() }
})

await test('执行详情拒绝不存在的回执', () => {
  const store = openStore(':memory:')
  try {
    startTaskPolicy(store, 'execution-detail-empty', { mode: 'regular', target: 'https://example.com', budget: { workers: 0 } })
    assert.throws(() => workbenchQuery({}, store, {
      kind: 'execution.detail', context: { rootId: 'execution-detail-empty', executionId: 'missing', executionKind: 'http' },
    }), /not found/)
  } finally { store.db.close() }
})

console.log(failed ? `\n${failed} failed` : '\nall execution detail tests passed')
process.exit(failed ? 1 : 0)
