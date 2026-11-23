// 0.9.37 独立放行复核 A/B 的定向夹具。
// 先把它跑在旧实现上记录失败，再用同一夹具验证修复。
import './test-stub-register.mjs'
import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { openStore, registerFinding } from '../plugins/dsh-redteam-results/lib/store.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { resolveEvidenceRef } from '../plugins/dsh-redteam-results/lib/evidence-resolve.js'
import { saveFindingEvidenceReview, readFindingEvidenceReviews } from '../plugins/dsh-redteam-results/lib/finding-evidence-reviews.js'
import { workbenchQuery } from '../plugins/dsh-redteam-results/lib/workbench.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = path.join(root, '..', '_ref', 'tmp', 'release-audit-ab-' + process.pid)
fs.mkdirSync(tmp, { recursive: true })
const digest = value => createHash('sha256').update(value).digest('hex')
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}

const endpoint = 'https://fixture.test/api/ab'
const packet = suffix => 'GET /api/ab' + (suffix || '') + ' HTTP/1.1\r\nHost: fixture.test\r\n\r\n'
const store = openStore(':memory:')

function insertReceipt(sessionId, id, requestId, revision, requestText, body) {
  const bodyBuffer = Buffer.from(body)
  const head = 'HTTP/1.1 200 OK\r\ncontent-type: text/plain'
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(sessionId, id, JSON.stringify({
    id, sessionId, source: 'host-http-execution', requestId, requestRevision: revision,
    endpoint, authContext: 'ab-user', request: requestText,
    responseHead: head, responseBodyBase64: bodyBuffer.toString('base64'),
    responseBytes: bodyBuffer.length, capturedBytes: bodyBuffer.length, status: 200, outcome: 'response',
    completedAt: '2026-11-23T01:00:00.000Z', requestSha256: digest(requestText),
    responseSha256: digest(Buffer.concat([Buffer.from(head), bodyBuffer])),
    requestBasis: digest(JSON.stringify([requestId, revision, endpoint, 'ab-user', requestText])),
  }))
}

try {
  const rootId = 'ab-root'
  const childId = 'ab-child'
  startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://fixture.test', budget: { toolCalls: 20 } })
  const rootRequest = packet('?owner=root')
  const childRequest = packet('?owner=child')
  saveTaskContext(store, rootId, {
    assets: [{ id: 'site', url: 'https://fixture.test', inScope: true }], checks: [], methods: [],
    requests: [{ id: 'req', revision: 'r1', endpoint, authContext: 'ab-user', valid: true,
      request: rootRequest, response: 'HTTP/1.1 200 OK\r\n\r\nroot body' }],
  })
  saveTaskContext(store, rootId, {
    assets: [{ id: 'site', url: 'https://fixture.test', inScope: true }], checks: [], methods: [],
    requests: [
      { id: 'req', revision: 'r1', endpoint, authContext: 'ab-user', valid: true,
        request: rootRequest, response: 'HTTP/1.1 200 OK\r\n\r\nroot body' },
      { id: 'req', revision: 'r2', endpoint, authContext: 'ab-user-2', valid: true,
        request: packet('?rev=2'), response: 'HTTP/1.1 200 OK\r\n\r\nrev2 body' },
    ],
  })
  store.db.prepare("INSERT INTO role_instances(session_id,child_id,role_id,role_version,work_id,state,record,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(rootId, childId, 'role', 1, 'work', 'active', '{}', new Date().toISOString())
  insertReceipt(rootId, 'receipt-root-r1', 'req', 'r1', rootRequest, 'root r1 body')
  insertReceipt(rootId, 'receipt-root-r2', 'req', 'r2', packet('?rev=2'), 'root r2 body')
  insertReceipt(childId, 'receipt-child-r1', 'req', 'r1', childRequest, 'child r1 body')

  await test('A1 请求回执关联键包含 owner：根与子会话同名同版不串回执', () => {
    const resolved = resolveEvidenceRef(store, rootId, { kind: 'request', id: 'req:r1' })
    assert.equal(resolved.openRef.ownerSessionId, rootId)
    assert.deepEqual(resolved.receipts.map(item => item.id), ['receipt-root-r1'])
    assert.equal(resolved.receipts.some(item => item.ownerSessionId === childId), false)
  })

  await test('A1 findingDetail 的 HTTP 回执也按 owner+requestId+revision 精确匹配', () => {
    const finding = registerFinding(store, rootId, 'pentest', {
      title: 'AB 回执归属', severity: 'high', target: endpoint, identity: 'ab-user', status: 'pending',
      evidenceRefs: [{ kind: 'request', id: 'req:r1' }],
    })
    const detail = workbenchQuery({}, store, { kind: 'findings.detail', context: { rootId, findingId: finding.id } }).data
    assert.deepEqual(detail.receipts.map(item => item.id), ['receipt-root-r1'])
    assert.equal(detail.receipts.some(item => item.id === 'receipt-root-r2'), false)
    assert.equal(detail.receipts.some(item => item.id === 'receipt-child-r1'), false)
  })

  await test('A1 测试路径为无唯一回执的请求建版本节点，且不连子会话回执', () => {
    const finding = registerFinding(store, rootId, 'pentest', {
      title: 'AB 图请求节点', severity: 'high', target: endpoint, status: 'pending',
      evidenceRefs: [{ kind: 'request', id: 'req:r2' }],
    })
    const graph = workbenchQuery({}, store, { kind: 'exploration.graph', context: { rootId } }).data[0]
    const requestNodes = graph.nodes.filter(node => node.kind === 'request')
    assert.equal(requestNodes.length >= 1, true)
    const requestEdge = graph.edges.find(edge => edge.from === finding.id && edge.kind === 'references')
    assert.ok(requestEdge, 'finding should reference the versioned request node')
    assert.equal(requestEdge.to, 'request:' + rootId + ':req:r2')
    assert.equal(graph.edges.some(edge => edge.to === 'receipt-child-r1'), false)
  })

  const requestOnlyFinding = registerFinding(store, rootId, 'pentest', {
    title: 'AB 请求原件入口', severity: 'high', target: endpoint, status: 'pending',
    evidenceRefs: [{ kind: 'request', id: 'req:r2' }],
  })

  // 组件级夹具：用生产 SakerFindingInspector 渲染合成 DTO。
  const source = fs.readFileSync(path.join(root, 'src', 'client', 'index.js'), 'utf8')
  function fnSource(name) {
    const start = source.indexOf('function ' + name + '(')
    if (start < 0) throw new Error('missing ' + name)
    const end = source.indexOf('\nfunction ', start + 1)
    return source.slice(start, end < 0 ? source.length : end)
  }
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false) })
  const walk = (node, predicate, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (predicate(node)) out.push(node)
    for (const child of node.children || []) walk(child, predicate, out)
    return out
  }
  const text = node => typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children || []).map(text).join('') : ''
  class Hooks {
    cells = []; cursor = 0; effects = []
    useState = initial => {
      const i = this.cursor++
      if (!(i in this.cells)) this.cells[i] = { value: typeof initial === 'function' ? initial() : initial }
      return [this.cells[i].value, value => { this.cells[i].value = typeof value === 'function' ? value(this.cells[i].value) : value }]
    }
    useRef = initial => {
      const i = this.cursor++
      if (!(i in this.cells)) this.cells[i] = { ref: { current: initial } }
      return this.cells[i].ref
    }
    useEffect = (effect, deps) => {
      const i = this.cursor++
      const old = this.cells[i]
      if (!old || deps.some((x, n) => !Object.is(x, old.deps[n]))) {
        this.cells[i] = { deps, cleanup: old?.cleanup }
        this.effects.push(() => { old?.cleanup?.(); this.cells[i].cleanup = effect() })
      }
    }
    render(callback) {
      this.cursor = 0; this.effects = []
      const result = callback()
      for (const effect of this.effects) effect()
      return result
    }
  }
  function renderInspector(props, hooks = new Hooks()) {
    const calls = { opened: null, api: [] }
    const context = vm.createContext({
      h, JSON, Date, Math, Number, String, Array, Object, Set, Map, Promise, Error, console,
      crypto: { randomUUID: () => 'uuid-fixture' },
      useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect,
      api: (name, payload) => { calls.api.push({ name, payload }); return new Promise(() => {}) },
      wbResponseError: response => response && response.ok === false ? Error(response.error) : null,
      wbErrorText: error => String(error?.message || error || ''),
      wbTime: value => String(value || ''),
      wbVerificationLabel: value => String(value || ''),
      wbEvidenceRefKindLabel: value => String(value || ''),
      wbGraphKindLabel: value => String(value || ''),
      wbNodeStateLabel: value => String(value || ''),
      SEVERITY_LABEL: { critical: '严重', high: '高危', medium: '中危', low: '低危' },
      SakerInspectorLoading: () => null, SakerInspectorError: () => null,
      SakerDetailFrame: (p, children) => h('div', null, children), SakerDetailTabs: () => null,
    })
    const code = fnSource('SakerFindingInspector') + '\n;globalThis.__render = SakerFindingInspector;'
    new vm.Script(code).runInContext(context)
    return { tree: hooks.render(() => context.__render(props)), calls }
  }

  const requestDto = {
    id: requestOnlyFinding.id, sessionId: rootId, findingId: requestOnlyFinding.id,
    title: 'AB 请求原件入口', severity: 'high', verificationState: 'candidate',
    findingRevision: 'rev-1', basisDigest: 'b'.repeat(64),
    evidenceReferences: [{
      kind: 'request', id: 'req', revision: 'r2', location: 'exact', quality: 'historical',
      openRef: { type: 'request', ownerSessionId: rootId, id: 'req', revision: 'r2' },
      receipts: [], receiptCount: 0,
    }],
    reviewHead: null, reviewHistory: [], reviewTotal: 0, reviewHistoryCursor: null,
  }

  await test('A2 发现详情为精确请求原件渲染“打开请求”并传 owner/id/revision', () => {
    const { tree, calls } = renderInspector({ selected: { kind: 'finding', rootId, id: requestOnlyFinding.id },
      state: { data: requestDto, loading: false, error: '' }, tab: 'evidence', onTab: () => {}, onRetry: () => {},
      onOpenRequest: ref => { calls.opened = ref } })
    const button = walk(tree, node => node.type === 'button' && text(node) === '打开请求')[0]
    assert.ok(button, 'missing 打开请求 action')
    button.props.onClick()
    assert.equal(calls.opened.kind, 'request')
    assert.equal(calls.opened.ownerSessionId, rootId)
    assert.equal(calls.opened.id, 'req')
    assert.equal(calls.opened.revision, 'r2')
  })

  await test('A3 复核历史超过最近 10 条时渲染“加载更早”入口', () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      reviewSeq: 20 - index, decision: 'insufficient', decisionLabel: '依据不足', note: 'n' + index,
      createdAt: '2026-11-23T00:00:00.000Z', current: index === 0, superseded: index > 0,
    }))
    const { tree } = renderInspector({ selected: { kind: 'finding', rootId, id: requestOnlyFinding.id },
      state: { data: { ...requestDto, reviewHistory: history, reviewTotal: 15, reviewHistoryCursor: 'cursor-1' },
        loading: false, error: '' }, tab: 'history', onTab: () => {}, onRetry: () => {} })
    assert.ok(walk(tree, node => node.type === 'button' && /加载更早/.test(text(node)))[0], 'missing 加载更早 action')
  })

  // B1 材料完整性
  const goodFile = path.join(tmp, 'good.txt')
  const badFile = path.join(tmp, 'bad.txt')
  const noDigestFile = path.join(tmp, 'nodigest.txt')
  const dirFile = path.join(tmp, 'material-dir')
  fs.writeFileSync(goodFile, 'good material', 'utf8')
  fs.writeFileSync(badFile, 'bad material', 'utf8')
  fs.writeFileSync(noDigestFile, 'no digest material', 'utf8')
  fs.mkdirSync(dirFile, { recursive: true })
  const insertMaterial = (id, file, registeredDigest) => store.db.prepare(
    'INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
    .run(rootId, id, '', registeredDigest || '', JSON.stringify({ id, file, name: id,
      ...(registeredDigest ? { digest: registeredDigest } : {}) }))
  insertMaterial('material-good', goodFile, digest('good material'))
  insertMaterial('material-bad', badFile, digest('different bytes'))
  insertMaterial('material-nodigest', noDigestFile, '')
  insertMaterial('material-dir', dirFile, '')

  await test('B1 目录、摘要不符标不可用；无摘要标未核', () => {
    const good = resolveEvidenceRef(store, rootId, { kind: 'file', id: 'material-good' })
    assert.equal(good.quality, 'current')
    const bad = resolveEvidenceRef(store, rootId, { kind: 'file', id: 'material-bad' })
    assert.equal(bad.quality, 'invalid')
    assert.equal(bad.reasonCode, 'INTEGRITY_UNVERIFIED')
    const dir = resolveEvidenceRef(store, rootId, { kind: 'file', id: 'material-dir' })
    assert.equal(dir.quality, 'invalid')
    const noDigest = resolveEvidenceRef(store, rootId, { kind: 'file', id: 'material-nodigest' })
    assert.equal(noDigest.quality, 'unknown')
  })

  await test('B1 不可核材料不能保存“依据足以支持”', () => {
    const finding = registerFinding(store, rootId, 'pentest', {
      title: 'AB 材料复核', severity: 'high', target: endpoint, status: 'pending',
      evidenceRefs: [{ kind: 'file', id: 'material-bad' }],
    })
    const state = readFindingEvidenceReviews(store, rootId,
      store.db.prepare('SELECT * FROM findings WHERE session_id=? AND id=?').get(rootId, finding.id))
    assert.throws(() => saveFindingEvidenceReview(store, rootId, {
      findingId: finding.id, decision: 'supported', note: '摘要不符也应被拒绝。',
      refs: [{ kind: 'file', id: 'material-bad', revision: '' }], requestId: 'ab-review-0001',
      expectedFindingRevision: state.findingRevision, expectedBasisDigest: state.basisDigest, expectedHeadSeq: 0,
    }), /可核|可打开的原件/)
  })

  await test('B1 文件内容变化后已保存复核头标失效', () => {
    const finding = registerFinding(store, rootId, 'pentest', {
      title: 'AB 文件变化', severity: 'high', target: endpoint, status: 'pending',
      evidenceRefs: [{ kind: 'file', id: 'material-good' }],
    })
    const state = readFindingEvidenceReviews(store, rootId,
      store.db.prepare('SELECT * FROM findings WHERE session_id=? AND id=?').get(rootId, finding.id))
    saveFindingEvidenceReview(store, rootId, {
      findingId: finding.id, decision: 'supported', note: '当前文件摘要与登记一致。',
      refs: [{ kind: 'file', id: 'material-good', revision: '' }], requestId: 'ab-review-0002',
      expectedFindingRevision: state.findingRevision, expectedBasisDigest: state.basisDigest, expectedHeadSeq: 0,
    })
    fs.writeFileSync(goodFile, 'good material changed after review', 'utf8')
    const after = readFindingEvidenceReviews(store, rootId,
      store.db.prepare('SELECT * FROM findings WHERE session_id=? AND id=?').get(rootId, finding.id))
    assert.equal(after.reviewHead.current, false)
    assert.equal(after.headState, 'stale')
  })

  // B2 550 条引用；第 501 条变化必须让旧快照失效。独立根避免其它发现挤进前 500。
  const reportRoot = 'ab-report-root'
  startTaskPolicy(store, reportRoot, { mode: 'regular', target: 'https://fixture.test', budget: { toolCalls: 5 } })
  const at = '2026-11-23T02:00:00.000Z'
  for (let findingIndex = 1; findingIndex <= 11; findingIndex += 1) {
    const refs = Array.from({ length: 50 }, (_, index) => ({
      kind: 'file', id: 'mat-' + String((findingIndex - 1) * 50 + index + 1).padStart(4, '0'),
    }))
    store.db.prepare(`INSERT INTO findings(session_id,id,mode,evidence_level,title,summary,severity,status,target,
      evidence_refs,description,poc,impact,evidence,created_at,updated_at,seq)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      reportRoot, 'ab-' + String(findingIndex).padStart(2, '0'), 'pentest', 'partial',
      'AB 报告引用 ' + findingIndex, '', 'medium', 'pending', endpoint,
      JSON.stringify(refs), '', '', '', '', at, at, findingIndex)
  }
  const lateFile = path.join(tmp, 'late-material.txt')
  fs.writeFileSync(lateFile, 'late material', 'utf8')

  await test('B2 第 501 条引用变化会改变报告快照并拒绝旧预览', async () => {
    const { dispatch } = await import('../plugins/dsh-redteam-results/lib/index.js')
    const preview = await dispatch({}, store, 'delivery.bundle', { sessionId: reportRoot, preview: true })
    assert.equal(preview.evidenceQuality.length <= 500, true)
    assert.equal(preview.evidenceQualityTotal >= 550, true)
    const late = preview.evidenceQuality.find(row => row.id === 'mat-0501')
    assert.equal(late, undefined, 'display may stay limited, but the changed ref is outside it')
    store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
      .run(reportRoot, 'mat-0501', '', digest('late material'), JSON.stringify({ id: 'mat-0501', file: lateFile,
        name: 'late', digest: digest('late material') }))
    await assert.rejects(dispatch({}, store, 'delivery.bundle', { sessionId: reportRoot, expectedSnapshot: preview.snapshot }),
      /内容已变化/)
    const next = await dispatch({}, store, 'delivery.bundle', { sessionId: reportRoot, preview: true })
    assert.notEqual(next.snapshot, preview.snapshot)
    const downloaded = await dispatch({}, store, 'delivery.bundle', { sessionId: reportRoot, expectedSnapshot: next.snapshot })
    assert.equal(typeof downloaded.archive, 'string')
  })
} finally {
  store.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(failed ? '\n' + failed + ' release audit A/B checks failed' : '\nrelease audit A/B checks passed')
process.exitCode = failed ? 1 : 0
