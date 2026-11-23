import assert from 'node:assert/strict'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { createRoleSpec } from '../plugins/dsh-redteam-results/lib/role-orchestration.js'
import { workbenchQuery } from '../plugins/dsh-redteam-results/lib/workbench.js'
import { taskElapsed } from '../plugins/dsh-redteam-results/lib/task-duration.js'
import { updateTaskProgress, pauseTaskPolicy, resumeTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'

const store = openStore(':memory:')
let failed = 0
async function test(name, callback) {
  try { await callback(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}

for (let index = 0; index < 120; index += 1) {
  const rootId = 'list-root-' + String(index).padStart(3, '0')
  startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://target-' + index + '.example', budget: { workers: 0 } })
  saveTaskContext(store, rootId, {
    assets: [{ id: 'asset-' + index, url: 'https://target-' + index + '.example', inScope: true, reachable: true }],
    requests: [{ id: 'request-' + index, endpoint: 'https://target-' + index + '.example/api/' + index, authContext: 'acct-' + index, valid: false, revision: 'r' + index }],
    checks: [], methods: [],
  })
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(rootId, 'receipt-' + index,
    JSON.stringify({ request: 'GET https://target-' + index + '.example/api/' + index + ' HTTP/1.1', status: 200,
      completedAt: new Date(2026, 0, 1, 0, index).toISOString(), outcome: 'response', integrityValid: true,
      identity: { name: 'acct-' + index } }))
}
const firstRoot = 'list-root-000'
store.db.prepare('INSERT INTO findings(session_id,id,mode,evidence_level,title,summary,severity,status,target,evidence_refs,description,poc,impact,evidence,created_at,updated_at,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(firstRoot, 'F001', 'pentest', 'partial', 'Listed finding', 'find me', 'high', 'pending', 'https://target-0.example', '[]', 'd', 'p', 'i', 'e',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)
createRoleSpec(store, firstRoot, { title: 'List role', objective: 'obj', responsibilities: 'resp', deliverable: 'deliver', scope: 'root', source: 'user' })
createRoleSpec(store, firstRoot, { roleId: readOnlyRoleId(), title: 'List role v2', objective: 'obj2', responsibilities: 'resp', deliverable: 'deliver', scope: 'root', source: 'user' })

function readOnlyRoleId() {
  return store.db.prepare('SELECT role_id FROM role_specs WHERE owner_session=? ORDER BY rowid DESC LIMIT 1').get(firstRoot)?.role_id
    || 'role-missing'
}

await test('roots.list: 20/50/100 paging reaches more than 50 records', () => {
  const first = workbenchQuery({}, store, { kind: 'roots.list', page: { limit: 20 } })
  assert.equal(first.page.total, 120)
  assert.equal(first.data.length, 20)
  assert.ok(first.page.nextCursor)
  const second = workbenchQuery({}, store, { kind: 'roots.list', page: { limit: 20, cursor: first.page.nextCursor } })
  assert.equal(second.data.length, 20)
  assert.notEqual(second.data[0].rootId, first.data[0].rootId)
  const hundred = workbenchQuery({}, store, { kind: 'roots.list', page: { limit: 100 } })
  assert.equal(hundred.data.length, 100)
})

await test('roots.list: text and state filters return the matching subset', () => {
  const text = workbenchQuery({}, store, { kind: 'roots.list', filter: { text: 'target-42.example' } })
  assert.equal(text.data.length, 1)
  assert.equal(text.data[0].rootId, 'list-root-042')
  const state = firstPageState()
  const filtered = workbenchQuery({}, store, { kind: 'roots.list', filter: { state } })
  assert.ok(filtered.data.length > 0)
  assert.ok(filtered.data.every(row => row.controlState === state))
})

function firstPageState() {
  return workbenchQuery({}, store, { kind: 'roots.list', page: { limit: 1 } }).data[0].controlState
}

await test('findings/traffic/assets/logs/attention: text filters are real', () => {
  const findings = workbenchQuery({}, store, { kind: 'findings.list', context: { rootId: firstRoot }, filter: { text: 'Listed' } })
  assert.equal(findings.data.length, 1)
  const traffic = workbenchQuery({}, store, { kind: 'traffic.list', context: { rootId: firstRoot }, filter: { text: 'receipt-0' } })
  assert.equal(traffic.data.length, 1)
  const assets = workbenchQuery({}, store, { kind: 'assets.list', context: { rootId: firstRoot }, filter: { text: 'request-0' } })
  assert.ok(assets.data.some(row => row.id === 'request-0'))
  const attention = workbenchQuery({}, store, { kind: 'attention.list', filter: { text: 'no-such-attention' } })
  assert.equal(attention.data.length, 0)
  const logs = workbenchQuery({}, store, { kind: 'logs.list', context: { rootId: firstRoot }, filter: { text: 'no-such-log' } })
  assert.equal(logs.data.length, 0)
})

await test('roles.list: exposes versions and instances and supports text search', () => {
  const roles = workbenchQuery({}, store, { kind: 'roles.list', context: { rootId: firstRoot }, filter: { text: 'List role' } })
  assert.equal(roles.data.length, 1)
  assert.ok(roles.data[0].versions.length >= 2)
  assert.ok(Array.isArray(roles.data[0].instances))
})

await test('findings/traffic: more than 500 records remain searchable and countable', () => {
  const large = openStore(':memory:')
  try {
    const rootId = 'large-list-root'
    startTaskPolicy(large, rootId, { mode: 'regular', target: 'https://large.example', budget: { workers: 0 } })
    const insertFinding = large.db.prepare('INSERT INTO findings(session_id,id,mode,evidence_level,title,summary,severity,status,target,evidence_refs,description,poc,impact,evidence,created_at,updated_at,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    const insertReceipt = large.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)')
    for (let i = 0; i < 600; i += 1) {
      const at = new Date(1700000000000 + i * 1000).toISOString()
      insertFinding.run(rootId, 'Record-' + i, 'pentest', 'partial', 'Record ' + i, '', 'medium', 'pending',
        'https://large.example', '[]', '', '', '', '', at, at, i)
      insertReceipt.run(rootId, 'Receipt-' + i, JSON.stringify({
        request: 'GET https://large.example/' + i + ' HTTP/1.1', status: 200, completedAt: at, outcome: 'response', integrityValid: true,
      }))
    }
    insertFinding.run(rootId, 'audit-other-mode', 'code-audit', 'partial', 'Audit-only record', '', 'low', 'pending',
      'https://large.example', '[]', '', '', '', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 999)
    const all = workbenchQuery({}, large, { kind: 'findings.list', page: { limit: 100 } })
    assert.equal(all.page.total, 601)
    const oldest = workbenchQuery({}, large, { kind: 'findings.list', filter: { text: 'Record 0' }, page: { limit: 100 } })
    assert.equal(oldest.data.length, 1)
    const traffic = workbenchQuery({}, large, { kind: 'traffic.list', context: { rootId }, page: { limit: 100 } })
    assert.equal(traffic.page.total, 600)
    const oldTraffic = workbenchQuery({}, large, { kind: 'traffic.list', context: { rootId }, filter: { text: 'Receipt-0' }, page: { limit: 100 } })
    assert.equal(oldTraffic.data.length, 1)
    const taskPage = workbenchQuery({}, large, { kind: 'findings.list', context: { rootId }, page: { limit: 50 } })
    assert.equal(taskPage.page.total, 600, 'task findings use the pentest finding set only')
    assert.equal(taskPage.data.length, 50)
    assert.ok(taskPage.page.nextCursor)
    const taskPage2 = workbenchQuery({}, large, { kind: 'findings.list', context: { rootId }, page: { limit: 50, cursor: taskPage.page.nextCursor } })
    assert.equal(taskPage2.data.length, 50)
    assert.notEqual(taskPage2.data[0].findingId, taskPage.data[0].findingId)
    const summaryDetail = workbenchQuery({}, large, { kind: 'roots.detail', context: { rootId, detailMode: 'summary' } })
    assert.equal(summaryDetail.data.findingsOmitted, true)
    assert.equal(summaryDetail.data.findings.length, 0)
    const detail = workbenchQuery({}, large, { kind: 'roots.detail', context: { rootId } })
    assert.equal(detail.data.findings.length, 600, 'task detail must not hide findings behind a 50-row slice')
  } finally { large.db.close() }
})

await test('roots.detail is a pure read and does not upsert control projections', () => {
  const pure = openStore(':memory:')
  try {
    const rootId = 'pure-read-root'
    startTaskPolicy(pure, rootId, { mode: 'regular', target: 'https://read.example', budget: { workers: 0 } })
    const before = pure.db.prepare('SELECT total_changes() AS n').get().n
    const detail = workbenchQuery({}, pure, { kind: 'roots.detail', context: { rootId } })
    const after = pure.db.prepare('SELECT total_changes() AS n').get().n
    assert.equal(detail.data.root.rootId, rootId)
    assert.equal(after, before, 'opening task detail must not write business/root metadata')
  } finally { pure.db.close() }
})

await test('status projection: ordinary end is not an attention item; real confirmation is', () => {
  const status = openStore(':memory:')
  try {
    startTaskPolicy(status, 'ended-root', { mode: 'regular', target: 'https://ended.example', budget: { workers: 0 } })
    updateTaskProgress(status, 'ended-root', { planComplete: true, note: 'normal finish' })
    startTaskPolicy(status, 'blocked-root', { mode: 'regular', target: 'https://blocked.example', budget: { workers: 0 } })
    pauseTaskPolicy(status, 'blocked-root', { code: 'needs-user', reason: '需要确认账号归属', evidence: 'test fixture' }, 'workbench')
    const rows = workbenchQuery({}, status, { kind: 'roots.list', page: { limit: 20 } }).data
    const ended = rows.find(row => row.rootId === 'ended-root')
    const blocked = rows.find(row => row.rootId === 'blocked-root')
    assert.equal(ended.businessState, 'ended')
    assert.equal(ended.attention, null)
    assert.equal(blocked.businessState, 'waiting-user')
    assert.equal(blocked.attention.kind, 'root-blocker')
    const attention = workbenchQuery({}, status, { kind: 'attention.list', page: { limit: 20 } }).data
    assert.equal(attention.some(row => row.rootId === 'ended-root'), false)
    assert.equal(attention.some(row => row.rootId === 'blocked-root' && row.kind === 'root-blocker'), true)
  } finally { status.db.close() }
})

await test('duration: terminal, paused and expired tasks stop growing', () => {
  const startedAt = 1_000_000
  assert.equal(taskElapsed({ startedAt, finishedAt: startedAt + 60_000 }, startedAt + 900_000).elapsedMs, 60_000)
  assert.equal(taskElapsed({ startedAt, pausedAt: startedAt + 30_000 }, startedAt + 900_000).elapsedMs, 30_000)
  assert.equal(taskElapsed({ startedAt, budget: { deadline: startedAt + 45_000 } }, startedAt + 900_000).elapsedMs, 45_000)
  const pausedElapsedMs = taskElapsed({ startedAt, pausedElapsedMs: 20_000, blocker: { recordedAt: startedAt + 80_000 } }, startedAt + 300_000)
  assert.equal(pausedElapsedMs.elapsedMs, 60_000)
})

await test('finding detail keeps its owner id and bounds repeated receipts without losing the total', () => {
  const bounded = openStore(':memory:')
  try {
    const rootId = 'finding-receipt-root'
    startTaskPolicy(bounded, rootId, { mode: 'regular', target: 'https://receipts.example', budget: { workers: 0 } })
    saveTaskContext(bounded, rootId, {
      assets: [{ id: 'site', url: 'https://receipts.example', inScope: true }], checks: [], methods: [],
      requests: [{ id: 'req-shared', revision: 'r1', endpoint: 'https://receipts.example/api', authContext: 'anonymous',
        valid: true, request: 'GET /api HTTP/1.1\r\nHost: receipts.example\r\n\r\n', response: 'HTTP/1.1 200 OK\r\n\r\nok' }],
    })
    bounded.db.prepare('INSERT INTO findings(session_id,id,mode,evidence_level,title,summary,severity,status,target,evidence_refs,description,poc,impact,evidence,created_at,updated_at,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(rootId, 'F-receipts', 'pentest', 'partial', 'Repeated receipts', 'summary', 'high', 'pending',
        'https://receipts.example', JSON.stringify([{ kind: 'request', id: 'req-shared' }]), '', '', '', '',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)
    const insertReceipt = bounded.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)')
    for (let index = 0; index < 60; index += 1) {
      insertReceipt.run(rootId, 'receipt-' + index, JSON.stringify({
        requestId: 'req-shared', requestRevision: 'r1', status: 200, completedAt: new Date(1700000000000 + index * 1000).toISOString(),
        outcome: 'response', current: index === 59, integrityValid: true,
      }))
    }
    bounded.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
      .run(rootId, 'file-evidence', '', 'digest', JSON.stringify({ id: 'file-evidence', name: 'evidence.txt', sourceUrl: 'local' }))
    bounded.db.prepare('UPDATE findings SET evidence_refs=? WHERE session_id=? AND id=?')
      .run(JSON.stringify([{ kind: 'request', id: 'req-shared' }, { kind: 'file', id: 'file-evidence' }]), rootId, 'F-receipts')
    const detail = workbenchQuery({}, bounded, { kind: 'findings.detail', context: { rootId, findingId: 'F-receipts' } }).data
    assert.equal(detail.sessionId, rootId)
    assert.equal(detail.receiptTotal, 60)
    assert.equal(detail.receipts.length, 50)
    assert.equal(detail.receipts[0].id, 'receipt-59')
    assert.equal(detail.evidenceReferences[0].location, 'unique-legacy')
    assert.equal(detail.evidenceReferences[0].openRef.type, 'request')
    assert.equal(detail.evidenceReferences[0].receiptCount, 60)
    assert.equal(detail.evidenceReferences[0].reasonCode, 'MULTIPLE_RECEIPTS')
    assert.equal(detail.evidenceReferences[1].location, 'missing')
    assert.equal(detail.evidenceReferences[1].quality, 'invalid')
    const material = workbenchQuery({}, bounded, { kind: 'evidence.material',
      context: { rootId, materialKind: 'file', materialId: 'file-evidence', offset: 0, limit: 8192 } }).data
    assert.equal(material.id, 'file-evidence')
    assert.equal(material.name, 'evidence.txt')
    const summary = workbenchQuery({}, bounded, { kind: 'roots.detail', context: { rootId, detailMode: 'summary' } }).data
    assert.equal(summary.findingsOmitted, true)
    assert.equal(summary.findings.length, 0)
    const full = workbenchQuery({}, bounded, { kind: 'roots.detail', context: { rootId } }).data
    assert.equal(full.findingsOmitted, false)
    assert.equal(full.findings.length, 1)
  } finally { bounded.db.close() }
})

console.log(failed ? `\n${failed} failed` : '\nall workbench list filter tests passed')
store.db.close()
process.exit(failed ? 1 : 0)
