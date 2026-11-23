// F2 定向回归：同一解析器必须让发现详情、探索图和报告索引落到同一版本/归属。
import './test-stub-register.mjs'
import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore, registerFinding } from '../plugins/dsh-redteam-results/lib/store.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { resolveEvidenceRef } from '../plugins/dsh-redteam-results/lib/evidence-resolve.js'
import { workbenchQuery } from '../plugins/dsh-redteam-results/lib/workbench.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = path.join(root, '..', '_ref', 'tmp', 'evidence-resolve-' + process.pid)
fs.mkdirSync(tmpRoot, { recursive: true })
const digest = value => createHash('sha256').update(value).digest('hex')

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}

const endpoint = 'https://fixture.test/api/doc'
const packet = (suffix = '') => 'GET /api/doc' + suffix + ' HTTP/1.1\r\nHost: fixture.test\r\n\r\n'
const request = (id, revision, authContext, suffix = '') => ({
  id, revision, endpoint, authContext, kind: 'api', valid: true,
  request: packet(suffix), response: 'HTTP/1.1 200 OK\r\n\r\n' + revision,
})

function insertReceipt(store, { sessionId, id, requestId, requestRevision, requestText, authContext = 'fixture', status = 200, body = 'fixture' }) {
  const bodyBuffer = Buffer.from(body)
  const responseHead = 'HTTP/1.1 ' + status + ' OK\r\ncontent-type: text/plain'
  const record = {
    id, sessionId, source: 'host-http-execution', requestId, requestRevision,
    endpoint, authContext: 'fixture',
    request: requestText,
    responseHead, responseBodyBase64: bodyBuffer.toString('base64'),
    responseBytes: bodyBuffer.length, capturedBytes: bodyBuffer.length,
    status, outcome: 'response', completedAt: new Date('2026-11-22T09:00:00.000Z').toISOString(),
    requestSha256: digest(requestText),
    responseSha256: digest(Buffer.concat([Buffer.from(responseHead), bodyBuffer])),
    requestBasis: digest(JSON.stringify([requestId, requestRevision, endpoint, authContext, requestText])),
    current: true, integrityValid: true,
  }
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)')
    .run(sessionId, id, JSON.stringify(record))
}

const store = openStore(':memory:')
try {
  const r1 = request('doc', 'r1', 'user-r1', '?v=1')
  const r2 = request('doc', 'r2', 'user-r2', '?v=2')
  const r3 = request('doc', 'r3', 'user-r3', '?v=3')
  const solo = request('solo', 'v1', 'user-solo')
  const bare = request('bare-only', 'v1', 'user-bare')
  const base = { assets: [{ id: 'site', url: 'https://fixture.test', inScope: true }], checks: [], methods: [] }
  for (const sessionId of ['root-a', 'root-b', 'root-unique'])
    startTaskPolicy(store, sessionId, { mode: 'regular', target: 'https://fixture.test', budget: { toolCalls: 20 } })
  saveTaskContext(store, 'root-a', { ...base, requests: [r1] })
  saveTaskContext(store, 'root-a', { ...base, requests: [r2] })
  saveTaskContext(store, 'root-a', { ...base, requests: [r3] })
  saveTaskContext(store, 'root-a', { ...base, requests: [r2, solo, bare] })
  saveTaskContext(store, 'root-b', { ...base, requests: [request('doc', 'r1', 'other-identity', '?b=1')] })
  saveTaskContext(store, 'root-unique', { ...base, requests: [solo] })

  insertReceipt(store, { sessionId: 'root-a', id: 'receipt-r1', requestId: 'doc', requestRevision: 'r1', requestText: r1.request, authContext: 'user-r1', body: 'r1' })
  insertReceipt(store, { sessionId: 'root-a', id: 'receipt-r2a', requestId: 'doc', requestRevision: 'r2', requestText: r2.request, authContext: 'user-r2', body: 'r2a' })
  insertReceipt(store, { sessionId: 'root-a', id: 'receipt-r2b', requestId: 'doc', requestRevision: 'r2', requestText: r2.request, authContext: 'user-r2', body: 'r2b' })
  insertReceipt(store, { sessionId: 'root-a', id: 'receipt-r3', requestId: 'doc', requestRevision: 'r3', requestText: r3.request, authContext: 'user-r3', body: 'r3' })
  insertReceipt(store, { sessionId: 'root-unique', id: 'receipt-solo', requestId: 'solo', requestRevision: 'v1', requestText: solo.request, authContext: 'user-solo', body: 'solo' })
  insertReceipt(store, { sessionId: 'root-b', id: 'receipt-r1-b', requestId: 'doc', requestRevision: 'r1', requestText: request('doc', 'r1', 'other-identity', '?b=1').request, authContext: 'other-identity', body: 'root-b' })
  insertReceipt(store, { sessionId: 'root-a', id: 'receipt-shared', requestId: 'shared', requestRevision: 'v1', requestText: r2.request, authContext: 'user-r2', body: 'shared-root' })
  store.db.prepare("INSERT INTO role_instances(session_id,child_id,role_id,role_version,work_id,state,record,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run('root-a', 'child-a', 'role', 1, 'work', 'active', '{}', new Date().toISOString())
  insertReceipt(store, { sessionId: 'child-a', id: 'receipt-shared', requestId: 'shared', requestRevision: 'v1', requestText: r2.request, authContext: 'user-r2', body: 'shared-child' })
  // 未登记为子会话的 child-x：即使库里有同名回执，也不能被当前根借用。
  insertReceipt(store, { sessionId: 'child-x', id: 'receipt-hidden', requestId: 'shared', requestRevision: 'v1', requestText: r2.request, authContext: 'user-r2', body: 'hidden' })
  // 坏回执：缺完整性字段。
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)')
    .run('root-a', 'receipt-broken', JSON.stringify({ id: 'receipt-broken', requestId: 'broken', requestRevision: 'v1' }))

  const goodFile = path.join(tmpRoot, 'material-good.txt')
  fs.writeFileSync(goodFile, 'fixture material body', 'utf8')
  store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
    .run('root-a', 'material-good', '', digest('fixture material body'),
      JSON.stringify({ id: 'material-good', file: goodFile, name: 'good.txt', digest: digest('fixture material body') }))
  store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
    .run('root-a', 'material-missing', '', digest('missing'),
      JSON.stringify({ id: 'material-missing', file: path.join(tmpRoot, 'does-not-exist.txt'), name: 'missing.txt' }))

  await test('F2 第 1 行：精确 request:doc:r1 落到 r1 原件，关联回执只列 r1', () => {
    const resolved = resolveEvidenceRef(store, 'root-a', { kind: 'request', id: 'doc:r1' })
    assert.equal(resolved.location, 'exact')
    assert.equal(resolved.revision, 'r1')
    assert.equal(resolved.openRef.type, 'request')
    assert.equal(resolved.openRef.id, 'doc')
    assert.equal(resolved.openRef.revision, 'r1')
    assert.equal(resolved.receiptCount, 1)
    assert.equal(resolved.receipts[0].id, 'receipt-r1')
    assert.equal(resolved.quality, 'historical', 'r1 is no longer the current revision, so its receipt is history')
    assert.notEqual(resolved.location, 'missing')
  })

  await test('F2 第 2 行：旧裸 request:doc 多版本不代选最新，明确 REVISION_REQUIRED', () => {
    const resolved = resolveEvidenceRef(store, 'root-a', { kind: 'request', id: 'doc' })
    assert.equal(resolved.location, 'ambiguous')
    assert.equal(resolved.reasonCode, 'REVISION_REQUIRED')
    assert.equal(resolved.openRef, null)
    assert.equal(resolved.receiptCount, 0)
    assert.equal(resolved.receipts.some(ref => ref.id === 'receipt-r2a' || ref.id === 'receipt-r2b'), false)
  })

  await test('F2 第 3 行：execution:receipt-r1 按已保存执行 ID 打开同一回执', () => {
    const resolved = resolveEvidenceRef(store, 'root-a', { kind: 'execution', id: 'receipt-r1' })
    assert.equal(resolved.location, 'exact')
    assert.equal(resolved.quality, 'historical')
    assert.equal(resolved.reasonCode, 'RECEIPT_HISTORICAL')
    assert.deepEqual(resolved.openRef, { type: 'execution', ownerSessionId: 'root-a', id: 'receipt-r1' })
  })

  await test('F2-01 旧裸 ID 在当前范围唯一版本时返回 unique-legacy', () => {
    const resolved = resolveEvidenceRef(store, 'root-unique', { kind: 'request', id: 'solo' })
    assert.equal(resolved.location, 'unique-legacy')
    assert.equal(resolved.revision, 'v1')
    assert.equal(resolved.quality, 'current')
    assert.deepEqual(resolved.receipts.map(ref => ref.id), ['receipt-solo'])
  })

  await test('F2-01 两个根有同名记录时各读各的归属和回执', () => {
    const a = resolveEvidenceRef(store, 'root-a', { kind: 'request', id: 'doc:r1' })
    const b = resolveEvidenceRef(store, 'root-b', { kind: 'request', id: 'doc:r1' })
    assert.equal(a.openRef.ownerSessionId, 'root-a')
    assert.equal(b.openRef.ownerSessionId, 'root-b')
    assert.deepEqual(b.receipts.map(ref => ref.id), ['receipt-r1-b'])
    assert.equal(b.receipts[0].ownerSessionId, 'root-b')
    assert.equal(a.receipts[0].ownerSessionId, 'root-a')
  })

  await test('F2-01 同 ID 跨归属的回执不能默认选中任一方', () => {
    const resolved = resolveEvidenceRef(store, 'root-a', { kind: 'execution', id: 'receipt-shared' })
    assert.equal(resolved.location, 'ambiguous')
    assert.equal(resolved.reasonCode, 'OWNER_UNRESOLVED')
    assert.equal(resolved.openRef, null)
  })

  await test('F2-01 历史精确版本可读，但标为历史且不提高当前证据等级', () => {
    const resolved = resolveEvidenceRef(store, 'root-a', { kind: 'request', id: 'doc:r3' })
    assert.equal(resolved.location, 'exact')
    assert.equal(resolved.revision, 'r3')
    assert.equal(resolved.quality, 'historical')
    assert.equal(resolved.receipts[0].current, false)
    assert.equal(resolved.receipts[0].integrityValid, true)
  })

  await test('F2-01 同版多回执列出记录而不是代选', () => {
    const resolved = resolveEvidenceRef(store, 'root-a', { kind: 'request', id: 'doc:r2' })
    assert.equal(resolved.location, 'exact')
    assert.equal(resolved.receiptCount, 2)
    assert.equal(resolved.reasonCode, 'MULTIPLE_RECEIPTS')
    assert.deepEqual(resolved.receipts.map(ref => ref.id).sort(), ['receipt-r2a', 'receipt-r2b'])
    assert.equal(resolved.quality, 'current')
    assert.equal(resolved.openRef.type, 'request', 'multiple receipts stay at the request original')
  })

  await test('F2-01 坏回执/缺完整性字段标 invalid，不当作当前佐证', () => {
    const resolved = resolveEvidenceRef(store, 'root-a', { kind: 'execution', id: 'receipt-broken' })
    assert.equal(resolved.location, 'exact')
    assert.equal(resolved.quality, 'invalid')
    assert.equal(resolved.reasonCode, 'INTEGRITY_UNVERIFIED')
    assert.equal(resolved.receipt.current, false)
    assert.equal(resolved.receipt.integrityValid, false)
  })

  await test('F2-01 无回执但有原件：可打开请求，但质量未知', () => {
    const resolved = resolveEvidenceRef(store, 'root-a', { kind: 'request', id: 'bare-only:v1' })
    assert.equal(resolved.location, 'exact')
    assert.equal(resolved.quality, 'unknown')
    assert.equal(resolved.reasonCode, 'INTEGRITY_UNVERIFIED')
    assert.equal(resolved.openRef.type, 'request')
  })

  await test('F2-01 未登记的子会话回执不能证明当前根', () => {
    const resolved = resolveEvidenceRef(store, 'root-a', { kind: 'execution', id: 'receipt-hidden' })
    assert.equal(resolved.location, 'missing')
    assert.equal(resolved.reasonCode, 'RECORD_NOT_FOUND')
  })

  await test('F2-01 材料索引存在但原件缺失时不伪造正文', () => {
    const missing = resolveEvidenceRef(store, 'root-a', { kind: 'file', id: 'material-missing' })
    assert.equal(missing.location, 'missing')
    assert.equal(missing.quality, 'invalid')
    assert.equal(missing.openRef, null)
    const good = resolveEvidenceRef(store, 'root-a', { kind: 'file', id: 'material-good' })
    assert.equal(good.location, 'exact')
    assert.equal(good.quality, 'current')
    assert.equal(good.openRef.type, 'material')
  })

  await test('F2-02 两版本交叉选中的错误回执次数为 0', () => {
    const r1Ref = resolveEvidenceRef(store, 'root-a', { kind: 'request', id: 'doc:r1' })
    const r2Ref = resolveEvidenceRef(store, 'root-a', { kind: 'request', id: 'doc:r2' })
    assert.equal(r1Ref.receipts.some(item => item.id.startsWith('receipt-r2')), false)
    assert.equal(r2Ref.receipts.some(item => item.id === 'receipt-r1'), false)
    assert.equal(r1Ref.receipts.filter(item => item.id !== 'receipt-r1').length, 0)
  })

  registerFinding(store, 'root-a', 'pentest', {
    title: 'F2 定向回归', severity: 'high', target: endpoint, identity: 'user-r2',
    summary: '同一请求两版本、多个回执与歧义引用。',
    evidenceRefs: [
      { kind: 'request', id: 'doc:r1' },
      { kind: 'request', id: 'doc' },
      { kind: 'execution', id: 'receipt-r1' },
      { kind: 'file', id: 'material-missing' },
      { kind: 'request', id: 'bare-only:v1' },
    ],
  })

  await test('F2-02 发现详情与探索图使用同一 openRef', () => {
    const finding = store.db.prepare("SELECT id FROM findings WHERE session_id='root-a' ORDER BY seq DESC LIMIT 1").get()
    const detail = workbenchQuery({}, store, { kind: 'findings.detail', context: { rootId: 'root-a', findingId: finding.id } })
    const refs = detail.data.evidenceReferences
    assert.equal(refs.length, 5)
    assert.equal(refs[0].location, 'exact')
    assert.equal(refs[0].openRef.type, 'request')
    assert.equal(refs[1].location, 'ambiguous')
    assert.equal(refs[1].reasonCode, 'REVISION_REQUIRED')
    assert.equal(refs[1].openRef, null)
    assert.equal(refs[2].openRef.type, 'execution')
    assert.equal(refs[2].openRef.id, 'receipt-r1')
    assert.equal(refs[3].location, 'missing')
    assert.equal(refs[4].location, 'exact')
    assert.equal(refs[4].quality, 'unknown')

    const graph = workbenchQuery({}, store, { kind: 'exploration.graph', context: { rootId: 'root-a' } }).data[0]
    const supported = graph.edges.filter(edge => edge.kind === 'supported-by')
    const targets = supported.map(edge => edge.to)
    assert.equal(targets.includes('receipt-r1'), true, 'exact request and execution refs may point at r1 receipt')
    assert.equal(targets.includes('receipt-r2a') || targets.includes('receipt-r2b'), false, 'ambiguous bare ref never picks r2')
    assert.equal(graph.meta.unresolvedEvidence.some(item => item.reasonCode === 'REVISION_REQUIRED'), true)
  })

  await test('F2-02 报告索引追加引用质量，质量变化使旧快照拒绝下载', async () => {
    const { dispatch } = await import('../plugins/dsh-redteam-results/lib/index.js')
    const preview = await dispatch({}, store, 'delivery.bundle', { sessionId: 'root-a', preview: true })
    assert.equal(preview.archive, null)
    assert.equal(preview.snapshot.length, 64)
    assert.equal(Array.isArray(preview.evidenceQuality), true)
    const bareRow = preview.evidenceQuality.find(row => row.kind === 'request' && row.id === 'bare-only')
    assert.equal(bareRow.quality, 'unknown')
    insertReceipt(store, { sessionId: 'root-a', id: 'receipt-bare', requestId: 'bare-only', requestRevision: 'v1',
      requestText: bare.request, authContext: 'user-bare', body: 'bare' })
    await assert.rejects(dispatch({}, store, 'delivery.bundle', { sessionId: 'root-a', expectedSnapshot: preview.snapshot }),
      /内容已变化/)
    const next = await dispatch({}, store, 'delivery.bundle', { sessionId: 'root-a', preview: true })
    assert.notEqual(next.snapshot, preview.snapshot)
    assert.equal(next.evidenceQuality.find(row => row.kind === 'request' && row.id === 'bare-only').quality, 'current')
    assert.equal(next.archive, null)
  })
} finally {
  try { store.close() } catch { /* already closed */ }
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
console.log(failed ? '\n' + failed + ' evidence resolution checks failed' : '\nevidence resolution matrix passed')
process.exitCode = failed ? 1 : 0
