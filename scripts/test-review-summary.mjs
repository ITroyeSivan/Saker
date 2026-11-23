// I2：隔天复核摘要必须纯读、限量、可定位，并且切换根不会串数据。
import './test-stub-register.mjs'
import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { openStore, registerFinding, updateFinding } from '../plugins/dsh-redteam-results/lib/store.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { workbenchQuery } from '../plugins/dsh-redteam-results/lib/workbench.js'
import { saveFindingEvidenceReview, readFindingEvidenceReviews } from '../plugins/dsh-redteam-results/lib/finding-evidence-reviews.js'
import { taskCostOverview } from '../plugins/dsh-redteam-results/lib/task-cost.js'

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}
const digest = value => createHash('sha256').update(value).digest('hex')
const endpoint = 'https://fixture.test/api/summary'
const packet = 'GET /api/summary HTTP/1.1\r\nHost: fixture.test\r\n\r\n'
const body = Buffer.from('summary fixture')
const head = 'HTTP/1.1 200 OK\r\ncontent-type: text/plain'
const store = openStore(':memory:')

function receipt(sessionId, id, requestId) {
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(sessionId, id, JSON.stringify({
    id, sessionId, source: 'host-http-execution', requestId, requestRevision: 'r1', endpoint, authContext: 'summary-user',
    request: packet, responseHead: head, responseBodyBase64: body.toString('base64'),
    responseBytes: body.length, capturedBytes: body.length, status: 200, outcome: 'response',
    completedAt: '2026-11-22T11:00:00.000Z', requestSha256: digest(packet),
    responseSha256: digest(Buffer.concat([Buffer.from(head), body])),
    requestBasis: digest(JSON.stringify([requestId, 'r1', endpoint, 'summary-user', packet])),
  }))
}

try {
  for (const rootId of ['summary-a', 'summary-b']) {
    startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://fixture.test', budget: { toolCalls: 10 } })
    saveTaskContext(store, rootId, {
      assets: [{ id: 'site', url: 'https://fixture.test', inScope: true }], checks: [], methods: [],
      requests: [{ id: 'req', revision: 'r1', endpoint, authContext: 'summary-user', kind: 'api', valid: true,
        request: packet, response: 'HTTP/1.1 200 OK\r\n\r\nsummary fixture' }],
    })
    receipt(rootId, 'receipt-' + rootId, 'req')
  }
  const finding = registerFinding(store, 'summary-a', 'pentest', {
    title: '待复核的发现', severity: 'high', target: endpoint, identity: 'summary-user',
    status: 'pending', evidenceRefs: [{ kind: 'request', id: 'req:r1' }],
  })
  const other = registerFinding(store, 'summary-a', 'pentest', {
    title: '依据不足的发现', severity: 'medium', target: endpoint, status: 'pending',
    evidenceRefs: [{ kind: 'request', id: 'req:r1' }],
  })
  const state = readFindingEvidenceReviews(store, 'summary-a', store.db.prepare('SELECT * FROM findings WHERE session_id=? AND id=?').get('summary-a', other.id))
  saveFindingEvidenceReview(store, 'summary-a', {
    findingId: other.id, decision: 'insufficient', note: '只看到摘要，没有完整原件。',
    refs: [], requestId: 'summary-review-0001',
    expectedFindingRevision: state.findingRevision, expectedBasisDigest: state.basisDigest, expectedHeadSeq: 0,
  })
  const contextHash = digest(JSON.stringify({ rootId: 'summary-a', generation: 0, sessionId: '' }))
  store.db.prepare(`INSERT INTO saker_command_records(command_id,context_hash,kind,payload_hash,status,phase,result,error,
    owner_pid,owner_runtime,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('cmd-summary-unknown', contextHash, 'work.retest', 'x', 'result-unknown', 'failed', '', '连接在结果前中断',
      0, '', 0, Date.now(), Date.now())
  store.db.prepare(`INSERT INTO saker_command_records(command_id,context_hash,kind,payload_hash,status,phase,result,error,
    owner_pid,owner_runtime,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('cmd-other-root', digest(JSON.stringify({ rootId: 'summary-b', generation: 0, sessionId: '' })),
      'work.retest', 'x', 'result-unknown', 'failed', '', '另一个根的中断', 0, '', 0, Date.now(), Date.now())

  await test('I2 摘要只返回最多三组、每组最多两个指针，并优先待复核', () => {
    const result = workbenchQuery({}, store, { kind: 'review.summary', context: { rootId: 'summary-a' } })
    const data = result.data
    assert.equal(data.rootId, 'summary-a')
    assert.equal(Number.isSafeInteger(data.generation), true)
    assert.equal(data.items.length <= 3, true)
    for (const group of data.items) assert.equal(group.length <= 2, true)
    const flat = data.items.flat()
    assert.equal(new Set(flat.map(item => item.kind + ':' + item.id)).size, flat.length, '同一记录只出现一次')
    assert.equal(flat.filter(item => item.kind === 'finding').length >= 1, true)
    assert.equal(flat.some(item => item.kind === 'http' && item.id === 'receipt-summary-a'), true)
    const unresolved = flat.find(item => item.kind === 'command')
    assert.equal(unresolved.commandId, 'cmd-summary-unknown')
    assert.equal(flat.some(item => item.commandId === 'cmd-other-root'), false, 'other root commands are not merged')
  })

  await test('I2 摘要状态区分本轮结束/暂停/未知操作，未知由 command.status 定位', () => {
    const result = workbenchQuery({}, store, { kind: 'review.summary', context: { rootId: 'summary-a' } }).data
    assert.equal(typeof result.state, 'string')
    assert.equal(result.reasonLabel.length > 0, true)
    assert.equal(result.items.flat().find(item => item.kind === 'command').reasonCode, 'COMMAND_RESULT_UNKNOWN')
    const status = workbenchQuery({}, store, {
      kind: 'command.status', context: { rootId: 'summary-a', generation: 0, sessionId: '', commandId: 'cmd-summary-unknown' },
    })
    assert.equal(status.data.status, 'result-unknown')
  })

  await test('I2 依据复核头失效的发现进入待复核组', () => {
    const result = workbenchQuery({}, store, { kind: 'review.summary', context: { rootId: 'summary-a' } }).data
    const review = result.items.find(group => group[0]?.group === 'review') || []
    assert.equal(review.some(item => item.id === other.id && item.reasonCode === 'REVIEW_INSUFFICIENT'), true)
    assert.equal(review.some(item => item.id === finding.id && item.reasonCode === 'FINDING_PENDING'), true)
  })

  await test('I2 读取摘要不写入任何事件或账本', () => {
    const counts = () => ({
      cost: store.db.prepare('SELECT COUNT(*) AS n FROM task_cost_events WHERE session_id=?').get('summary-a').n,
      policy: store.db.prepare('SELECT COUNT(*) AS n FROM task_policy_events WHERE session_id=?').get('summary-a').n,
      models: store.db.prepare('SELECT COUNT(*) AS n FROM task_model_calls WHERE root_session=?').get('summary-a').n,
      findings: store.db.prepare('SELECT COUNT(*) AS n FROM findings WHERE session_id=?').get('summary-a').n,
    })
    const before = counts()
    for (let i = 0; i < 3; i += 1) workbenchQuery({}, store, { kind: 'review.summary', context: { rootId: 'summary-a' } })
    assert.deepEqual(counts(), before)
  })

  await test('I2 roots.detail(summary) 的费用查询显式 backfill:false，旧默认仍可补写（哨兵反向）', () => {
    const session = {
      id: 'summary-a', seq: 1,
      events: [{ type: 'assistant/message', seq: 0, time: Date.now(),
        data: { usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 1, totalTokens: 11 },
          message: { content: 'fixture', id: 'm1' } } }],
      eventAt(index) { return this.events[index] },
      isOwnSeq() { return true },
    }
    const ctx = { sessions: { get: id => id === 'summary-a' ? session : null } }
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM task_cost_events WHERE session_id=?').get('summary-a').n
    workbenchQuery(ctx, store, { kind: 'roots.detail', context: { rootId: 'summary-a', detailMode: 'summary' } })
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_cost_events WHERE session_id=?').get('summary-a').n, before)
    taskCostOverview(ctx, store, 'summary-a')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_cost_events WHERE session_id=?').get('summary-a').n > before, true)
  })

  await test('I2 切换根后 B 的摘要不包含 A 的记录', () => {
    const b = workbenchQuery({}, store, { kind: 'review.summary', context: { rootId: 'summary-b' } }).data
    const flat = b.items.flat()
    assert.equal(flat.some(item => item.id === finding.id || item.id === other.id), false)
    assert.equal(flat.some(item => item.commandId === 'cmd-summary-unknown'), false)
  })
} finally {
  store.close()
}
console.log(failed ? '\n' + failed + ' review summary checks failed' : '\nreview summary read contract passed')
process.exitCode = failed ? 1 : 0
