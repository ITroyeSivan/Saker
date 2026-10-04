import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStore, registerFinding, updateFinding, getFinding, removeFinding, allFindings } from '../plugins/dsh-redteam-results/lib/store.js'
import { parseReproduction, findingDeliveryState, outcomeSummary, renderReproduction } from '../plugins/dsh-redteam-results/lib/delivery.js'
import { summarizeMetrics, recordFeedbackMetric, recordSearchMetric, readOutcomeMetrics } from '../plugins/dsh-nday-hunter/lib/metrics.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name) }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message) }
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-outcomes-'))
const previousHome = process.env.DSH_HOME, previousAtlas = process.env.DSH_ATLAS_DB
process.env.DSH_HOME = home
process.env.DSH_ATLAS_DB = path.join(home, 'absent-atlas.db')
const { dispatch, apply, verifyMessage, releaseChainRefs } = await import('../plugins/dsh-redteam-results/lib/index.js')
const disposers = []
let store
const method = { kind: 'method', mechanism: 'fixture-controlled-execution', methodVersion: 'fixture-v1',
  endpoint: 'https://example.test/api/import', prerequisites: ['Authorized fixture account'], dependencies: [],
  parameters: ['Read identity from the test environment'], steps: ['Send the recorded fixture request and compare the marker response with the baseline.'],
  successCriterion: 'Fixture response contains the expected execution marker; negative control does not.',
  reviewSteps: 'Repeat against the fixture with an independent marker and negative control.', recovery: 'No persistent changes in this fixture.',
  verification: { status: 'verified', evidenceIds: ['fixture-replay-response'] } }
const input = { title: 'Fixture execution', severity: 'high', type: 'RCE', target: 'https://example.test',
  evidenceLevel: 'impact', impact: 'Recorded controlled fixture execution', evidence: 'fixture-execution-response',
  requestPkt: 'POST /api/import HTTP/1.1\nHost: example.test\n\nfixture-marker', responsePkt: 'HTTP/1.1 200 OK\n\nexpected-marker',
  proofKind: 'execution', reproduction: JSON.stringify(method) }
const review = { status: 'verified', secondRating: 'high', secondRatingNote: 'Independent fixture replay with a fresh marker and a negative control reproduced the recorded execution effect.' }
const confirmed = session => {
  const finding = registerFinding(store, session, 'pentest', input)
  return updateFinding(store, session, 'pentest', finding.id, review)
}
try {
  store = openStore(path.join(home, 'redteam-results', 'results.db'))
  let first
  await test('method identity and evidence metadata persist through SQLite register update and read', () => {
    const pending = registerFinding(store, 's1', 'pentest', input)
    assert.equal(getFinding(store, 's1', pending.id).proofKind, 'execution')
    assert.equal(getFinding(store, 's1', pending.id).delivery.ready, false)
    first = updateFinding(store, 's1', 'pentest', pending.id, review)
    assert.equal(getFinding(store, 's1', first.id).delivery.ready, false)
    assert(getFinding(store, 's1', first.id).delivery.gaps.includes('host-execution-evidence-missing'))
    assert(getFinding(store, 's1', first.id).delivery.gaps.includes('independent-impact-verification-missing'))
    assert.equal(JSON.parse(getFinding(store, 's1', first.id).reproduction).methodVersion, 'fixture-v1')
  })
  await test('duplicate feedback counts cannot inflate independently reviewed RCE outcomes', () => {
    recordSearchMetric({ runId: 'run', startedAt: '2026-10-01T00:00:00Z', home })
    for (let i = 0; i < 3; i++) recordFeedbackMetric({ kind: 'confirmed-rce', count: 999, runId: 'run', sessionId: 's1', findingId: first.id,
      finishedAt: '2026-10-01T00:00:10Z', home })
    const summary = summarizeMetrics(home)
    assert.equal(summary.confirmedRce, 0)
    assert.equal(summary.rceFeedbackReports, 3)
    assert.equal(summary.averageQueryToRceMs, null)
    assert.equal(summary.reproducibleDeliveryRate, null)
  })
  await test('claimed execution in multiple sessions cannot replace host execution and independent impact verification', () => {
    confirmed('s1')
    confirmed('s2')
    assert.equal(summarizeMetrics(home).confirmedRce, 0)
    assert.equal(summarizeMetrics(home, { sessionId: 's1' }).confirmedRce, 0)
  })
  await test('interaction and legacy verified rows do not become execution outcomes', () => {
    const interaction = { ...getFinding(store, 's1', first.id), sessionId: 's1', proofKind: 'interaction' }
    assert.equal(outcomeSummary([interaction]).confirmedRce, 0)
    assert.equal(outcomeSummary([{ ...interaction, proofKind: '', reproduction: '' }]).confirmedFindings, 0)
    assert.equal(findingDeliveryState(interaction).ready, false)
  })
  await test('not-run reproduction cannot count as confirmed RCE or complete delivery', () => {
    const pendingMethod = { ...method, verification: { status: 'not-run', evidenceIds: [] } }
    const row = { ...getFinding(store, 's1', first.id), sessionId: 's1', reproduction: JSON.stringify(pendingMethod) }
    const summary = outcomeSummary([row])
    assert.equal(summary.confirmedRce, 0)
    assert.equal(summary.confirmedFindings, 0)
    assert.equal(findingDeliveryState(row).ready, false)
    assert(findingDeliveryState(row).gaps.includes('reproduction-not-executed'))
    assert.equal(summary.reproducedFindings, 0)
    assert.match(renderReproduction(pendingMethod), /尚未运行/)
  })
  await test('incomplete malformed or cross-entry HTTP evidence never counts as a confirmed effect', () => {
    const row = getFinding(store, 's1', first.id)
    for (const patch of [{ requestPkt: '' }, { responsePkt: '' }, { requestPkt: 'I ran the exploit successfully' },
      { responsePkt: 'The target is definitely vulnerable' },
      { requestPkt: 'POST /another-entry HTTP/1.1\r\nHost: example.test\r\n\r\nmarker' },
      { requestPkt: 'POST https://another.test/api/import HTTP/1.1\r\n\r\nmarker' },
      { requestPkt: 'POST /api/import HTTP/1.1\r\nHost: another.test\r\n\r\nmarker' }]) {
      const changed = { ...row, ...patch }
      assert.equal(findingDeliveryState(changed).ready, false)
      assert(findingDeliveryState(changed).gaps.some(gap => gap === 'request-response-evidence-invalid' || gap === 'request-response-evidence-missing'))
      assert.equal(outcomeSummary([changed]).confirmedFindings, 0)
    }
    const virtualHost = { ...row, requestPkt: 'POST /api/import HTTP/1.1\r\nHost: service.example.test\r\n\r\nmarker',
      reproduction: JSON.stringify({ ...method, hostHeader: 'service.example.test' }) }
    assert.equal(findingDeliveryState(virtualHost).ready, false, 'valid Host syntax cannot replace execution proof')
    assert(!findingDeliveryState(virtualHost).gaps.includes('request-response-evidence-invalid'))
  })
  await test('production Desktop list groups and export filters keep unexecuted claimed results out of ready delivery', async () => {
    try {
    const make = (sid, patch = {}) => {
      const pending = registerFinding(store, sid, 'pentest', { ...input, title: 'View fixture evidence', ...patch })
      return updateFinding(store, sid, 'pentest', pending.id, review)
    }
    make('view'); make('view'); make('view-other')
    make('view', { reproduction: JSON.stringify({ ...method, verification: { status: 'not-run', evidenceIds: [] } }) })
    for (let i = 0; i < 12; i++) registerFinding(store, 'view', 'pentest', { ...input, title: 'View fixture pending ' + i })
    const base = { mode: 'pentest', scope: 'all', sessionId: 'view', q: 'View fixture', pageSize: 1 }
    const ready = await dispatch({}, store, 'findings.list', { ...base, delivery: 'ready' })
    assert.equal(ready.list.total, 0); assert.equal(ready.list.pages, 1); assert.equal(ready.list.rows.length, 0)
    const second = await dispatch({}, store, 'findings.list', { ...base, delivery: 'ready', page: 2 })
    assert.equal(second.list.rows.length, 0)
    const incomplete = await dispatch({}, store, 'findings.list', { ...base, delivery: 'incomplete', pageSize: 100 })
    assert.equal(incomplete.list.total, 16); assert(incomplete.list.rows.every(row => !row.delivery.ready))
    const all = await dispatch({}, store, 'findings.list', { ...base, delivery: 'all', pageSize: 100 })
    assert.equal(all.list.total, 16, 'all evidence and duplicate history remain visible')
    const groups = await dispatch({}, store, 'findings.groups', { ...base, delivery: 'ready' })
    assert.equal(groups.groups.flatMap(group => group.items).length, 0)
    assert.equal((await dispatch({}, store, 'findings.list', { sessionId: 'view', mode: 'pentest', delivery: 'ready' })).list.total, 0)
    assert.equal((await dispatch({}, store, 'findings.groups', { sessionId: 'view', mode: 'pentest', delivery: 'ready' })).groups.length, 0)
    } finally {
      for (const sid of ['view', 'view-other']) {
        for (const row of allFindings(store, sid, 'pentest')) removeFinding(store, sid, row.id)
        assert.equal(allFindings(store, sid, 'pentest').length, 0)
      }
    }
  })
  await test('complete-looking method claims remain readable but cannot export as confirmed delivery without host and impact proof', async () => {
    await assert.rejects(dispatch({}, store, 'finding.delivery', { sessionId: 's1', id: first.id }), /host-execution-evidence-missing/)
    for (const required of [method.endpoint, method.methodVersion, method.prerequisites[0], method.steps[0], method.recovery]) assert(renderReproduction(method).includes(required))
    const pending = registerFinding(store, 'pending-session', 'pentest', input)
    await assert.rejects(dispatch({}, store, 'finding.delivery', { sessionId: 'pending-session', id: pending.id }), /incomplete/)
    assert.equal((await dispatch({}, store, 'finding.delivery', { sessionId: 'other', id: first.id })).ok, false)
  })
  await test('malformed or links-only reproduction rejects without silently truncating or consuming IDs', () => {
    for (const hostHeader of ['example.test\r\nInjected: value', 'name@example.test', 'example.test/other', 42]) assert.throws(() => parseReproduction({ ...method, hostHeader }), /Host/)
    assert.throws(() => parseReproduction({ ...method, steps: ['https://example.test/poc'] }), /actionable/)
    assert.throws(() => registerFinding(store, 'invalid-session', 'pentest', { ...input, reproduction: '{invalid' }))
    assert.throws(() => registerFinding(store, 'invalid-session', 'pentest', { ...input, reproduction: JSON.stringify({ ...method, steps: ['x'.repeat(21000)] }) }), /20000/)
    assert.equal(registerFinding(store, 'invalid-session', 'pentest', input).seq, 1)
  })
  await test('downgrade deletion and changed impact evidence immediately revoke confirmed metrics', () => {
    for (const row of allFindings(store, 's1', 'pentest')) updateFinding(store, 's1', 'pentest', row.id, { status: 'false-positive' })
    assert.equal(summarizeMetrics(home, { sessionId: 's1' }).confirmedRce, 0)
    for (const row of allFindings(store, 's2', 'pentest')) removeFinding(store, 's2', row.id)
    assert.equal(summarizeMetrics(home).confirmedRce, 0)
    assert.equal(summarizeMetrics(home).averageQueryToRceMs, null)
    const revoked = confirmed('revoked')
    updateFinding(store, 'revoked', 'pentest', revoked.id, { evidence: '' })
    assert.equal(summarizeMetrics(home).confirmedRce, 0)
  })
  await test('missing damaged or unmigrated result databases are unknown and never rewritten by metrics', () => {
    const missing = path.join(home, 'missing')
    assert.equal(readOutcomeMetrics(missing).confirmedRce, null)
    assert.equal(fs.existsSync(path.join(missing, 'redteam-results')), false)
    const legacy = path.join(home, 'legacy', 'redteam-results')
    fs.mkdirSync(legacy, { recursive: true })
    const file = path.join(legacy, 'results.db')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE findings (id TEXT)'); db.close()
    const bytes = fs.readFileSync(file)
    assert.equal(readOutcomeMetrics(path.join(home, 'legacy')).reason, 'result-store-needs-migration')
    assert.deepEqual(fs.readFileSync(file), bytes)
    const damaged = path.join(home, 'damaged', 'redteam-results')
    fs.mkdirSync(damaged, { recursive: true }); fs.writeFileSync(path.join(damaged, 'results.db'), 'broken')
    assert.equal(readOutcomeMetrics(path.join(home, 'damaged')).confirmedRce, null)
    assert.equal(fs.readFileSync(path.join(damaged, 'results.db'), 'utf8'), 'broken')
  })
  await test('proof classification and method metadata survive closing and reopening the database', () => {
    store.close(); store = openStore(path.join(home, 'redteam-results', 'results.db'))
    assert.equal(getFinding(store, 's1', first.id).proofKind, 'execution')
    assert.equal(JSON.parse(getFinding(store, 's1', first.id).reproduction).methodVersion, 'fixture-v1')
  })
  await test('old result schema migrates without deleting rows or fabricating reproduction metadata', () => {
    store.close()
    const db = new DatabaseSync(path.join(home, 'redteam-results', 'results.db'))
    db.exec('ALTER TABLE findings DROP COLUMN proof_kind; ALTER TABLE findings DROP COLUMN reproduction;'); db.close()
    assert.equal(readOutcomeMetrics(home).reason, 'result-store-needs-migration')
    store = openStore(path.join(home, 'redteam-results', 'results.db'))
    const legacy = getFinding(store, 's1', first.id)
    assert.equal(legacy.title, input.title)
    assert.equal(legacy.proofKind, '')
    assert.equal(legacy.reproduction, '')
    assert.equal(legacy.delivery.ready, false)
    assert.equal(readOutcomeMetrics(home).available, true)
  })
  await test('registered model tools preserve reproduction proof and reviewer context through actual execution', async () => {
    const tools = new Map()
    apply({ tools: { register: tool => tools.set(tool.name, tool) }, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
      webServer: { register: () => () => {} } })
    const exec = { agent: { session: { id: 'tool-session', header: { agentPreset: 'pentest' } } } }
    const result = await tools.get('redteam_finding_register').execute({ ...input, summary: 'Controlled fixture outcome' }, exec)
    assert.equal(result.ok, true)
    const reviewed = await tools.get('redteam_finding_update').execute({ id: result.id, ...review }, exec)
    assert.equal(reviewed.ok, true)
    const row = getFinding(store, 'tool-session', result.id)
    assert.equal(row.proofKind, 'execution')
    assert.equal(row.delivery.ready, false)
    assert(verifyMessage(row).includes(method.methodVersion))
    await tools.get('redteam_finding_update').execute({ id: result.id, proofKind: 'interaction' }, exec)
    assert.equal(getFinding(store, 'tool-session', result.id).delivery.ready, false)
  })
} finally {
  for (const dispose of disposers.reverse()) await dispose()
  releaseChainRefs(); store?.close()
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
  if (previousAtlas === undefined) delete process.env.DSH_ATLAS_DB; else process.env.DSH_ATLAS_DB = previousAtlas
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
