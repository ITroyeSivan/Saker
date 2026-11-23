// I1：人工依据复核的写入合同、幂等/冲突、旧判断保留与报告口径。
import './test-stub-register.mjs'
import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { openStore, registerFinding, getFinding, updateFinding } from '../plugins/dsh-redteam-results/lib/store.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { workbenchQuery } from '../plugins/dsh-redteam-results/lib/workbench.js'
import { saveFindingEvidenceReview } from '../plugins/dsh-redteam-results/lib/finding-evidence-reviews.js'

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}
const digest = value => createHash('sha256').update(value).digest('hex')
const endpoint = 'https://fixture.test/api/review'
const packet = 'GET /api/review HTTP/1.1\r\nHost: fixture.test\r\n\r\n'
const body = Buffer.from('review fixture body')
const responseHead = 'HTTP/1.1 200 OK\r\ncontent-type: text/plain'
const store = openStore(':memory:')

function insertReceipt(sessionId, id, requestId, requestRevision) {
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(sessionId, id, JSON.stringify({
    id, sessionId, source: 'host-http-execution', requestId, requestRevision, endpoint, authContext: 'review-user',
    request: packet, responseHead, responseBodyBase64: body.toString('base64'),
    responseBytes: body.length, capturedBytes: body.length, status: 200, outcome: 'response',
    completedAt: new Date('2026-11-22T10:00:00.000Z').toISOString(),
    requestSha256: digest(packet), responseSha256: digest(Buffer.concat([Buffer.from(responseHead), body])),
    requestBasis: digest(JSON.stringify([requestId, requestRevision, endpoint, 'review-user', packet])),
  }))
}

try {
  startTaskPolicy(store, 'review-root', { mode: 'regular', target: 'https://fixture.test', budget: { toolCalls: 20 } })
  saveTaskContext(store, 'review-root', {
    assets: [{ id: 'site', url: 'https://fixture.test', inScope: true }], checks: [], methods: [],
    requests: [{ id: 'req', revision: 'r1', endpoint, authContext: 'review-user', kind: 'api', valid: true,
      request: packet, response: 'HTTP/1.1 200 OK\r\n\r\nreview fixture body' }],
  })
  insertReceipt('review-root', 'receipt-review', 'req', 'r1')
  const created = registerFinding(store, 'review-root', 'pentest', {
    title: '人工复核夹具', severity: 'high', target: endpoint, identity: 'review-user',
    status: 'pending', evidenceRefs: [{ kind: 'request', id: 'req:r1' }],
  })
  const root = 'review-root'
  const detail = () => workbenchQuery({}, store, { kind: 'findings.detail', context: { rootId: root, findingId: created.id } }).data
  const base = () => {
    const data = detail()
    return { expectedFindingRevision: data.findingRevision, expectedBasisDigest: data.basisDigest,
      expectedHeadSeq: data.reviewHead ? data.reviewHead.reviewSeq : 0 }
  }
  const save = (patch) => saveFindingEvidenceReview(store, root, {
    findingId: created.id, decision: 'insufficient', note: '只看到保存的响应摘要，尚未核对完整原件。',
    refs: [], requestId: 'review-request-0001', ...base(), ...patch,
  }, 'desktop-action')

  await test('I1-01 用当前精确引用保存“依据足以支持”，作者与时间由服务端记录', () => {
    const before = detail()
    assert.equal(before.reviewHead, null)
    assert.equal(before.reviewTotal, 0)
    assert.equal(before.evidenceReferences[0].location, 'exact')
    assert.equal(before.evidenceReferences[0].quality, 'current')
    const result = save({ decision: 'supported', note: '已打开当前请求原件和回执，状态与正文一致。',
      refs: [{ kind: 'request', id: 'req', revision: 'r1' }] })
    assert.equal(result.ok, true)
    assert.equal(result.review.decision, 'supported')
    assert.equal(result.review.decisionLabel, '依据足以支持')
    assert.equal(result.review.current, true)
    assert.equal(result.review.author, 'desktop-action')
    assert.equal(result.reviewTotal, 1)
    const row = store.db.prepare('SELECT author,review_seq,request_id FROM finding_evidence_reviews WHERE session_id=? AND finding_id=?').get(root, created.id)
    assert.deepEqual({ ...row }, { author: 'desktop-action', review_seq: 1, request_id: 'review-request-0001' })
    assert.equal(getFinding(store, root, created.id).delivery.ready, false, '依据复核不改现有确认等级')
  })

  await test('I1-02 同请求同载荷幂等返回原结果；不同载荷拒绝', () => {
    const again = save({ decision: 'supported', note: '已打开当前请求原件和回执，状态与正文一致。',
      refs: [{ kind: 'request', id: 'req', revision: 'r1' }], expectedHeadSeq: 1 })
    assert.equal(again.idempotent, true)
    assert.equal(detail().reviewTotal, 1)
    assert.throws(() => save({ decision: 'insufficient', note: '换了内容但复用同一请求 ID。',
      expectedHeadSeq: 1 }), error => error.code === 'REVIEW_CONFLICT')
  })

  await test('I1-02 预期版本、依据摘要或历史头的任一不符都产生可见冲突', () => {
    for (const patch of [{ expectedFindingRevision: 'stale-revision' }, { expectedBasisDigest: 'f'.repeat(64) },
      { expectedHeadSeq: 0 }, { expectedHeadSeq: 9 }]) {
      assert.throws(() => save({ requestId: 'review-request-0002', ...patch }),
        error => error.code === 'REVIEW_CONFLICT', JSON.stringify(patch))
    }
    assert.equal(detail().reviewTotal, 1)
  })

  await test('I1-01 先“依据不足”再更正：旧判断保留并标“已更正”', () => {
    const state = base()
    const insufficient = saveFindingEvidenceReview(store, root, {
      findingId: created.id, decision: 'insufficient', note: '只看到摘要，没有打开完整原件。',
      refs: [], requestId: 'review-request-0003', ...state,
    })
    assert.equal(insufficient.review.decision, 'insufficient')
    assert.equal(insufficient.reviewHead.current, true)
    const next = base()
    const corrected = saveFindingEvidenceReview(store, root, {
      findingId: created.id, decision: 'superseded', note: '补充打开回执后更正先前“依据不足”的判断。',
      refs: [{ kind: 'request', id: 'req', revision: 'r1' }], requestId: 'review-request-0004', ...next,
    })
    assert.equal(corrected.reviewTotal, 3)
    const history = workbenchQuery({}, store, { kind: 'findings.review-history', context: { rootId: root, findingId: created.id } })
    assert.equal(history.data.length, 3)
    assert.equal(history.data[0].reviewSeq, 3)
    assert.equal(history.data[1].superseded, true)
    assert.equal(history.data[1].supersededLabel, '已更正')
  })

  await test('I1-02 没有先前判断时不能“更正”；正文写“已验证”不能代替 decision', () => {
    assert.throws(() => saveFindingEvidenceReview(store, 'other-root', {
      findingId: created.id, decision: 'superseded', note: '更正原因',
      refs: [], requestId: 'review-request-0005', expectedFindingRevision: '', expectedBasisDigest: '', expectedHeadSeq: 0,
    }), /finding not found|缺少/)
    assert.throws(() => save({ decision: 'verified', requestId: 'review-request-0006' }), /decision/)
    assert.equal(detail().reviewTotal, 3)
  })

  await test('I1-01 证据版本变化后当前头标为不可复核，但旧判断仍可回看', () => {
    updateFinding(store, root, 'pentest', created.id, { summary: '证据变化后的业务版本' })
    const data = detail()
    assert.equal(data.reviewHead.current, false)
    assert.equal(data.headState, 'stale')
    assert.equal(data.headNote, '原判断保留，当前依据不可复核')
    assert.equal(data.reviewHistory.length, 3)
    assert.equal(data.reviewHistory.filter(item => item.superseded).length >= 1, true)
  })

  await test('I1-02 只接受当前详情中可定位的精确引用', () => {
    const stale = (() => { const data = detail(); return { expectedFindingRevision: data.findingRevision,
      expectedBasisDigest: data.basisDigest, expectedHeadSeq: data.reviewHead.reviewSeq } })()
    assert.throws(() => saveFindingEvidenceReview(store, root, {
      findingId: created.id, decision: 'insufficient', note: '引用不在详情里。',
      refs: [{ kind: 'request', id: 'other-request', revision: 'r1' }], requestId: 'review-request-0007', ...stale,
    }), /不在当前发现详情/)
    saveTaskContext(store, root, {
      assets: [{ id: 'site', url: 'https://fixture.test', inScope: true }], checks: [], methods: [],
      requests: [
        { id: 'req', revision: 'r1', endpoint, authContext: 'review-user', valid: true, request: packet,
          response: 'HTTP/1.1 200 OK\r\n\r\nreview fixture body' },
        { id: 'req', revision: 'r2', endpoint, authContext: 'review-user-2', valid: true,
          request: packet.replace('/api/review', '/api/review?v=2'), response: 'HTTP/1.1 200 OK\r\n\r\nv2' },
      ],
    })
    updateFinding(store, root, 'pentest', created.id, {
      evidenceRefs: [{ kind: 'request', id: 'req' }],
    })
    const data = detail()
    assert.equal(data.evidenceReferences[0].location, 'ambiguous')
    assert.throws(() => saveFindingEvidenceReview(store, root, {
      findingId: created.id, decision: 'insufficient', note: '裸 ID 有多个版本。',
      refs: [{ kind: 'request', id: 'req' }], requestId: 'review-request-0008',
      expectedFindingRevision: data.findingRevision, expectedBasisDigest: data.basisDigest,
      expectedHeadSeq: data.reviewHead ? data.reviewHead.reviewSeq : 0,
    }), /版本或归属未确定/)
  })

  await test('I1 报告保留用户决定计数，并让旧导出预览因复核变化失效', async () => {
    const { dispatch } = await import('../plugins/dsh-redteam-results/lib/index.js')
    const preview = await dispatch({}, store, 'delivery.bundle', { sessionId: root, preview: true })
    assert.equal(preview.userEvidenceReviews.total, 1, 'one finding has a current review head')
    assert.equal(preview.userEvidenceReviews.records, 3, 'all three saved rows stay countable')
    assert.equal(preview.userEvidenceReviews.superseded >= 1, true)
    assert.equal(preview.userEvidenceReviews.stale >= 1, true)
    const data = detail()
    saveFindingEvidenceReview(store, root, {
      findingId: created.id, decision: 'insufficient', note: '复核后又看到新的限制，记录当前判断。',
      refs: [], requestId: 'review-request-0009',
      expectedFindingRevision: data.findingRevision, expectedBasisDigest: data.basisDigest,
      expectedHeadSeq: data.reviewHead.reviewSeq,
    })
    await assert.rejects(dispatch({}, store, 'delivery.bundle', { sessionId: root, expectedSnapshot: preview.snapshot }),
      /内容已变化/)
  })
} finally {
  store.close()
}
console.log(failed ? '\n' + failed + ' evidence review checks failed' : '\nevidence review contract passed')
process.exitCode = failed ? 1 : 0
