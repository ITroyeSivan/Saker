import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore, registerFinding, updateFinding } from '../plugins/dsh-redteam-results/lib/store.js'
import { createProjectRun, defineProjectChecks, listProjectActions, readProjectRun, recordProjectCheck, reopenProjectCheck, saveProjectEvidence, transitionProjectRun, upsertProjectSource } from '../plugins/dsh-redteam-results/lib/project-store.js'
import { selectProjectCheck, startProjectTask, startProjectRetest } from '../plugins/dsh-redteam-results/lib/project-runtime.js'
import { buildProjectDeliveryFiles } from '../plugins/dsh-redteam-results/lib/project-delivery.js'
import { competitionSummary, competitionPromptState, createCompetitionChallenge, listCompetitionChallenges, readCurrentCompetitionChallenge, setCurrentCompetitionChallenge, updateCompetitionAnswer, updateCompetitionChallenge, addCompetitionAnswer } from '../plugins/dsh-redteam-results/lib/competition-store.js'
import { importKnowledgeText, listKnowledgeSources, readKnowledge, searchKnowledge, deleteKnowledgeSource } from '../plugins/dsh-redteam-results/lib/competition-knowledge.js'
import { readCompetitionExecution, readCompetitionOutput, recoverCompetitionExecutions, runCompetitionExecution, stopAllCompetitionExecutions } from '../plugins/dsh-redteam-results/lib/competition-execution.js'
import { readSceneContext, setCompetitionKnowledge, setCompetitionPreferences, setSceneContinuation, writeSceneContext } from '../plugins/dsh-redteam-results/lib/scene-context.js'
import { localModelServiceKey, modelBudgetOverview, modelBudgetOwner, modelConcurrency } from '../plugins/dsh-redteam-results/lib/model-budget.js'
import { identityRequestHeaders } from '../plugins/dsh-redteam-results/lib/identity-binding.js'
import { startTaskPolicy, taskExecutionGuard } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { findingDeliveryState } from '../plugins/dsh-redteam-results/lib/delivery.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const tempRoot = path.resolve(here, '..', '..', '_ref', 'tmp')
fs.mkdirSync(tempRoot, { recursive: true })
const home = fs.mkdtempSync(path.join(tempRoot, 'saker-three-scenes-remediation-'))
process.env.DSH_HOME = home
const store = openStore(path.join(home, 'results.db'))
let failed = 0
async function test(name, work) {
  try { await work(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) }
}

try {
  await test('R08 every competition execution has isolated raw output and byte cursors', async () => {
    const challenge = createCompetitionChallenge(store, 'execution-session', { title: 'isolated output' })
    const first = runCompetitionExecution(store, 'execution-session', challenge.challengeId, {
      requestId: 'execution-a', command: 'echo ONLY_A', environment: 'host',
    })
    const duplicate = runCompetitionExecution(store, 'execution-session', challenge.challengeId, {
      requestId: 'execution-a', command: 'echo ONLY_A', environment: 'host',
    })
    const second = runCompetitionExecution(store, 'execution-session', challenge.challengeId, {
      requestId: 'execution-b', command: 'echo ONLY_B', environment: 'host',
    })
    assert.equal(duplicate.executionId, first.executionId)
    await new Promise(resolve => setTimeout(resolve, 300))
    const a = readCompetitionOutput(store, 'execution-session', challenge.challengeId, first.executionId)
    const b = readCompetitionOutput(store, 'execution-session', challenge.challengeId, second.executionId)
    assert.notEqual(first.stdoutFile, second.stdoutFile)
    assert.match(a.stdout.text, /ONLY_A/)
    assert.doesNotMatch(a.stdout.text, /ONLY_B/)
    assert.match(b.stdout.text, /ONLY_B/)
    assert.equal(typeof a.nextStdoutOffset, 'number')
    assert.equal(typeof a.nextStderrOffset, 'number')
  })

  await test('R09 recovered executions remain unknown instead of pretending to be stopped', () => {
    store.db.prepare('INSERT INTO competition_executions(session_id,challenge_id,execution_id,state,record,updated_at) VALUES(?,?,?,?,?,?)')
      .run('recovery', 'challenge', 'lost', 'running', JSON.stringify({
        sessionId: 'recovery', challengeId: 'challenge', executionId: 'lost', state: 'running',
        pid: 99999999, stdoutFile: '', stderrFile: '', command: 'echo unknown', environment: 'host', updatedAt: new Date().toISOString(),
      }), new Date().toISOString())
    recoverCompetitionExecutions(store)
    const row = store.db.prepare('SELECT state,record FROM competition_executions WHERE session_id=? AND execution_id=?').get('recovery', 'lost')
    assert.equal(row.state, 'unknown')
    assert.match(row.record, /owner-process-not-observed/)
  })

  await test('R13 knowledge search returns every hit through cursor and reads UTF-8 byte budgets', async () => {
    await importKnowledgeText(store, 'knowledge', {
      title: 'many-hits.txt', text: ('needle ' + '.'.repeat(600) + '\n').repeat(12),
    })
    let cursor = ''
    const hits = []
    do {
      const page = searchKnowledge(store, 'knowledge', { query: 'needle', limit: 5, cursor })
      assert(page.rows.length <= 5)
      hits.push(...page.rows)
      cursor = page.nextCursor || ''
    } while (cursor)
    assert.equal(hits.length, 12)
    const source = await importKnowledgeText(store, 'knowledge', { title: '中文.txt', text: '中🙂'.repeat(5000) })
    let offset = 0
    let bytes = 0
    do {
      const page = readKnowledge(store, 'knowledge', { sourceId: source.sourceId, revision: source.revision, offset, maxBytes: 8192 })
      bytes += Buffer.byteLength(page.text)
      assert(Buffer.byteLength(page.text) <= 8192)
      assert.doesNotMatch(page.text, /\uFFFD/)
      offset = page.nextOffset
      if (page.complete) break
    } while (true)
    assert.equal(bytes, Buffer.byteLength('中🙂'.repeat(5000)))
  })

  await test('R13 broad knowledge search continues past 200 matched sources with an exact source total', async () => {
    for (let index = 0; index < 205; index += 1) {
      await importKnowledgeText(store, 'knowledge-broad-window', {
        sourceId: 'broad-' + String(index).padStart(3, '0'),
        title: 'broad-' + index + '.txt',
        text: 'broad-needle document ' + index,
      })
    }
    let cursor = ''
    let rows = 0
    const seen = new Set()
    do {
      const page = searchKnowledge(store, 'knowledge-broad-window', { query: 'broad-needle', limit: 20, cursor })
      assert.equal(page.totalSources, 205)
      assert.equal(page.totalHitsKind, 'matched-sources')
      for (const row of page.rows) {
        assert(!seen.has(row.sourceId), 'cursor must not repeat a source-level hit')
        seen.add(row.sourceId)
      }
      rows += page.rows.length
      cursor = page.nextCursor || ''
    } while (cursor)
    assert.equal(rows, 205)
    assert.equal(seen.size, 205)
  })

  await test('R14 removing knowledge hides search but preserves old revision references', async () => {
    const source = await importKnowledgeText(store, 'knowledge-delete', { title: 'keep.txt', text: 'historical evidence' })
    deleteKnowledgeSource(store, 'knowledge-delete', source.sourceId)
    assert.equal(searchKnowledge(store, 'knowledge-delete', { query: 'historical' }).rows.length, 0)
    assert.equal(listKnowledgeSources(store, 'knowledge-delete').rows.length, 0)
    assert.match(readKnowledge(store, 'knowledge-delete', { sourceId: source.sourceId, revision: source.revision }).text, /historical evidence/)
  })

  await test('R14 scene knowledge toggles use revision CAS', () => {
    const initial = writeSceneContext(store, 'knowledge-cas', 'competition', { presetId: 'ctf-solver' })
    const changed = setCompetitionKnowledge(store, 'knowledge-cas', true, { expectedRevision: initial.sceneRevision })
    assert.equal(changed.sceneRevision, initial.sceneRevision + 1)
    assert.throws(() => setCompetitionKnowledge(store, 'knowledge-cas', false, { expectedRevision: initial.sceneRevision }), /changed/)
  })

  await test('R01 project evidence command keeps local work usable and blocks explicit target traffic', () => {
    startTaskPolicy(store, 'evidence-policy', {
      scenario: 'project', question: 'offline', allowTargetNetwork: false, budget: { minutes: 5 },
    })
    assert.equal(taskExecutionGuard(store, 'evidence-policy', 'project_evidence', Date.now(), {
      args: { action: 'command', command: 'echo LOCAL_ONLY' },
    }), undefined)
    const denial = taskExecutionGuard(store, 'evidence-policy', 'project_evidence', Date.now(), {
      args: { action: 'command', command: 'pwsh -Command "Invoke-WebRequest https://example.test/private"' },
    })
    assert.match(String(denial), /target_network_disabled/)
    assert.equal(taskExecutionGuard(store, 'evidence-policy', 'project_evidence', Date.now(), {
      args: { action: 'list' },
    }), undefined)
  })

  await test('R03 R04 typed evidence binds the active attempt and is exported with missing-material truth', () => {
    const sid = 'evidence-export'
    startTaskPolicy(store, sid, { scenario: 'project', question: 'typed evidence', budget: { minutes: 5 } })
    const run = createProjectRun(store, sid, { question: 'typed evidence', instanceRevision: 3 })
    transitionProjectRun(store, sid, run.runId, 'running', run.controlRev)
    const [check] = defineProjectChecks(store, sid, run.runId, [{ checkId: 'typed', requirement: 'export typed evidence' }])
    const file = path.join(home, 'evidence.txt')
    fs.writeFileSync(file, 'observed output')
    const evidence = saveProjectEvidence(store, sid, run.runId, check.checkId, {
      kind: 'file', path: file, text: 'observed output', sha256: 'fixture-digest', complete: true,
    })
    const completed = recordProjectCheck(store, sid, run.runId, check.checkId, {
      executionState: 'ended', verdict: 'expectation_met', checkedContent: 'observed output', evidenceRefs: [evidence.id],
    })
    assert.equal(completed.lastAttemptId, check.activeAttempt.attemptId)
    const bundle = buildProjectDeliveryFiles(store, sid, run.runId)
    const body = Object.values(bundle.files).map(value => String(value)).join('\n')
    assert.match(body, new RegExp(evidence.id))
    assert.match(body, /host-file-read/)
    reopenProjectCheck(store, sid, run.runId, check.checkId, { reason: 'new instance observation required', force: true })
    assert.throws(() => recordProjectCheck(store, sid, run.runId, check.checkId, {
      executionState: 'ended', verdict: 'expectation_met', checkedContent: 'old evidence claimed as new',
      evidenceRefs: [evidence.id],
    }), /依据.*不属于/)
    const [missingCheck] = defineProjectChecks(store, sid, run.runId, [{ checkId: 'missing', requirement: 'detect removed material' }])
    const missingEvidence = saveProjectEvidence(store, sid, run.runId, missingCheck.checkId, {
      kind: 'file', path: file, text: 'missing later', sha256: 'fixture-missing', complete: true,
    })
    recordProjectCheck(store, sid, run.runId, missingCheck.checkId, {
      executionState: 'ended', verdict: 'expectation_met', checkedContent: 'will lose material', evidenceRefs: [missingEvidence.id],
    })
    store.db.prepare('DELETE FROM business_materials WHERE session_id=? AND id=?').run(sid, missingEvidence.id)
    const missing = buildProjectDeliveryFiles(store, sid, run.runId)
    assert(missing.missing.some(item => item.kind === 'typed-evidence' && item.id === missingEvidence.id))
  })

  await test('R05 account A never silently reuses request Cookie B', () => {
    const identity = { accountId: 'account-a', name: 'A', matched: true, status: 'valid', secret: 'Cookie: user=A' }
    const conflict = identityRequestHeaders({ headers: { Cookie: 'user=B' } }, identity)
    assert.equal(conflict.conflict, true)
    const replacement = identityRequestHeaders({ headers: { Cookie: 'user=B' } }, identity, { authSource: 'account' })
    assert.equal(replacement.headers.cookie, 'user=A')
    const original = identityRequestHeaders({ headers: { Cookie: 'user=B' } }, identity, { authSource: 'request' })
    assert.equal(original.headers.Cookie, 'user=B')
    assert.equal(original.source, 'request')
  })

  await test('R12 model cannot solve a challenge and accepted answers count distinct challenges', () => {
    const challenge = createCompetitionChallenge(store, 'solved', { title: 'answer status' })
    assert.throws(() => updateCompetitionChallenge(store, 'solved', challenge.challengeId, { state: 'solved' }), /confirmation/)
    const first = addCompetitionAnswer(store, 'solved', challenge.challengeId, { value: 'FLAG{a}', status: 'pending' })
    const duplicate = addCompetitionAnswer(store, 'solved', challenge.challengeId, { value: 'FLAG{a}', status: 'pending' })
    assert.equal(duplicate.answerId, first.answerId)
    updateCompetitionAnswer(store, 'solved', challenge.challengeId, first.answerId, {
      status: 'accepted', confirmedBy: 'user', confirmationNote: 'platform confirmed',
    })
    const second = addCompetitionAnswer(store, 'solved', challenge.challengeId, { value: 'FLAG{b}', status: 'pending' })
    updateCompetitionAnswer(store, 'solved', challenge.challengeId, second.answerId, {
      status: 'accepted', confirmedBy: 'user', confirmationNote: 'platform confirmed another record',
    })
    const summary = competitionSummary(store, 'solved')
    assert.equal(summary.acceptedAnswers, 1)
    assert.equal(summary.acceptedAnswerRecords, 2)
  })

  await test('R12 challenge state filtering uses SQL pagination without empty false pages', () => {
    createCompetitionChallenge(store, 'filtered', { challengeId: 'older', title: 'wanted' })
    const newer = createCompetitionChallenge(store, 'filtered', { challengeId: 'newer', title: 'skip' })
    updateCompetitionChallenge(store, 'filtered', newer.challengeId, { state: 'solving' })
    const page = listCompetitionChallenges(store, 'filtered', { limit: 1, state: 'open' })
    assert.equal(page.rows.length, 1)
    assert.equal(page.rows[0].challengeId, 'older')
    assert.equal(page.total, 1)
    assert.equal(page.nextOffset, null)
  })

  await test('competition limits accept one field, preserve the billing round, and never reset consumed calls', async () => {
    const sid = 'competition-budget-cas'
    writeSceneContext(store, sid, 'competition', { presetId: 'ctf-solver' })
    let scene = setCompetitionPreferences(store, sid, { modelCalls: 2 })
    assert.equal(scene.preferences.budget.modelCalls, 2)
    assert.equal(modelBudgetOverview(store, sid).limits.modelCalls, 2, 'an unset token limit must remain empty, not invalid')
    scene = setCompetitionPreferences(store, sid, { tokens: 1000 })
    assert.equal(scene.preferences.budget.tokens, 1000)
    assert.equal(modelBudgetOverview(store, sid).limits.tokens, 1000)
    scene = setCompetitionPreferences(store, sid, { toolCalls: 1, minutes: 5 })
    const round = scene.preferences.budget.roundStartedAt
    const started = scene.preferences.budget.startedAt
    assert(round)
    assert(started)
    const challenge = createCompetitionChallenge(store, sid, { title: 'budget CAS', environment: { kind: 'host' } })
    const first = runCompetitionExecution(store, sid, challenge.challengeId, { command: 'echo FIRST', environment: 'host' })
    assert(first.executionId)
    await new Promise(resolve => setTimeout(resolve, 250))
    scene = setCompetitionPreferences(store, sid, { toolCalls: 2, modelCalls: 3, minutes: 8 })
    assert.equal(scene.preferences.budget.roundStartedAt, round, 'raising a cap must not create a new billing round')
    assert.equal(scene.preferences.budget.startedAt, started, 'editing minutes must not reset elapsed time')
    const second = runCompetitionExecution(store, sid, challenge.challengeId, { command: 'echo SECOND', environment: 'host' })
    assert(second.executionId)
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.throws(() => runCompetitionExecution(store, sid, challenge.challengeId, {
      command: 'echo THIRD', environment: 'host',
    }), /budget exhausted/)
    assert.throws(() => setCompetitionPreferences(store, sid, { modelCalls: 0 }), /positive safe integer/)
    assert.throws(() => setCompetitionPreferences(store, sid, { toolCalls: 1.5 }), /positive safe integer/)
  })

  await test('competition pause blocks new commands and model calls while idempotent output reads stay available', async () => {
    const sid = 'competition-pause-guard'
    writeSceneContext(store, sid, 'competition', { presetId: 'ctf-solver' })
    setCompetitionPreferences(store, sid, { workers: 1 })
    const challenge = createCompetitionChallenge(store, sid, { title: 'pause guard', environment: { kind: 'host' } })
    setSceneContinuation(store, sid, true, '用户切换场景前暂停')
    const before = store.db.prepare('SELECT count(*) AS n FROM competition_executions WHERE session_id=?').get(sid).n
    assert.throws(() => runCompetitionExecution(store, sid, challenge.challengeId, {
      requestId: 'paused-command', command: 'echo AFTER_PAUSE > after-pause.txt', environment: 'host',
    }), /paused or cancelled/)
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM competition_executions WHERE session_id=?').get(sid).n, before)
    const owner = modelBudgetOwner(store, sid)
    assert(owner, 'competition owner remains present even without a model quota')
    setSceneContinuation(store, sid, false)
    const resumed = runCompetitionExecution(store, sid, challenge.challengeId, {
      requestId: 'paused-command', command: 'echo AFTER_PAUSE > after-pause.txt', environment: 'host',
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(readCompetitionExecution(store, sid, challenge.challengeId, resumed.executionId).state, 'completed')
  })

  await test('model service identity uses the configured URL instead of provider names', () => {
    const left = localModelServiceKey({ provider: 'team-gateway', baseURL: 'http://127.0.0.1:9000/v1' })
    const right = localModelServiceKey({ provider: 'office-vllm-alias', baseURL: 'http://127.0.0.1:9000/v1/chat/completions' })
    assert.equal(left, right, 'two aliases for the same URL must share one service key')
    assert.notEqual(left, localModelServiceKey({ provider: 'team-gateway', baseURL: 'http://127.0.0.1:9001/v1' }))
    assert.equal(localModelServiceKey({ provider: 'cloud-api', model: 'local-small' }), null,
      'a cloud route whose model name contains local must not be throttled by a name guess')
    const sid = 'model-service-root'
    writeSceneContext(store, sid, 'competition', { presetId: 'ctf-solver' })
    setCompetitionPreferences(store, sid, { modelConcurrency: 2 })
    assert.equal(modelConcurrency(store, sid, left), 2)
    assert.equal(store.db.prepare('SELECT concurrency FROM task_model_services WHERE service_key=?').get(left).concurrency, 2)
  })

  await test('competition child work inherits the root challenge and root budget owner', () => {
    const root = 'competition-child-root';
    writeSceneContext(store, root, 'competition', { presetId: 'ctf-solver' });
    setCompetitionPreferences(store, root, { workers: 1, modelCalls: 4 })
    const challenge = createCompetitionChallenge(store, root, { title: 'root challenge', prompt: 'ROOT_PROMPT_MARKER' })
    setCurrentCompetitionChallenge(store, root, challenge.challengeId)
    startTaskPolicy(store, root, { mode: 'regular', question: 'competition root', target: 'http://127.0.0.1:1', budget: { toolCalls: 10, workers: 1 } })
    const child = 'competition-child-purpose';
    startTaskPolicy(store, child, { mode: 'regular', purposeTask: true, parentSession: root,
      question: 'inspect current challenge', target: 'http://127.0.0.1:1', budget: { toolCalls: 2, workers: 0 } })
    const childScene = readSceneContext(store, child, 'ctf-solver')
    assert.equal(childScene.sceneId, 'competition')
    assert.equal(childScene.contextId, root)
    assert.equal(childScene.currentChallengeId, challenge.challengeId)
    const owner = modelBudgetOwner(store, child)
    assert.equal(owner.root, root)
    assert.equal(owner.policy.budget.modelCalls, 4)
  })

  await test('competition model owner remains readable before any settings object exists', () => {
    const sid = 'competition-owner-defaults'
    writeSceneContext(store, sid, 'competition', { presetId: 'ctf-solver' })
    const owner = modelBudgetOwner(store, sid)
    assert.equal(owner.root, sid)
    assert.equal(owner.policy.modelBudgetBlock, null)
    assert.equal(owner.policy.budget.modelCalls, null)
  })

  await test('R11 current challenge persists independently of update time and instance changes increment revision', () => {
    const sid = 'current-challenge'
    writeSceneContext(store, sid, 'competition', { presetId: 'ctf-solver' })
    const older = createCompetitionChallenge(store, sid, { challengeId: 'older', title: 'older selected', instance: { url: 'http://one.test' } })
    const newer = createCompetitionChallenge(store, sid, { challengeId: 'newer', title: 'newer updated later' })
    setCurrentCompetitionChallenge(store, sid, older.challengeId)
    updateCompetitionChallenge(store, sid, newer.challengeId, { title: 'newest title' })
    assert.equal(readCurrentCompetitionChallenge(store, sid).challengeId, older.challengeId)
    const changed = updateCompetitionChallenge(store, sid, older.challengeId, { instance: { url: 'http://two.test' } })
    assert.equal(changed.instance.revision, 2)
    assert.equal(changed.instanceHistory.length, 1)
    assert.equal(changed.instanceHistory[0].url, 'http://one.test')
  })

  await test('R09 competition model context includes prompt, instance connection and attachment references', () => {
    const sid = 'competition-prompt-state'
    writeSceneContext(store, sid, 'competition', { presetId: 'ctf-solver' })
    const challenge = createCompetitionChallenge(store, sid, {
      challengeId: 'prompt-context',
      title: 'prompt context',
      prompt: 'PROMPT_CONTEXT_MARKER_7D2A',
      instance: { url: 'http://127.0.0.1:19090', connection: 'nc 127.0.0.1 19090' },
      attachments: [{ id: 'attachment-1', materialId: 'pasted-context', name: 'notes.txt', bytes: 42, role: 'input' }],
    })
    setCurrentCompetitionChallenge(store, sid, challenge.challengeId)
    const state = competitionPromptState(store, sid)
    assert.match(state.state, /prompt context/)
    assert.match(state.promptLine, /PROMPT_CONTEXT_MARKER_7D2A/)
    assert.match(state.instanceLine, /http:\/\/127\.0\.0\.1:19090/)
    assert.match(state.instanceLine, /nc 127\.0\.0\.1 19090/)
    assert.match(state.attachmentLine, /pasted-context/)
    assert.match(state.attachmentLine, /notes\.txt/)
  })

  await test('R07 active-run retest rejects silent parent mutation and retries only explicit retryable checks', () => {
    const sid = 'active-retest'
    const run = startProjectTask(store, sid, { policy: { question: 'original' } })
    defineProjectChecks(store, sid, run.runId, [
      { checkId: 'pending', requirement: 'not retryable yet' },
      { checkId: 'blocked', requirement: 'credential dependent' },
    ])
    assert.throws(() => startProjectRetest(store, sid, { parentRunId: run.runId, checkIds: ['pending'] }), /blocked\/needs_check/)
    const preparing = readProjectRun(store, sid, run.runId)
    store.db.prepare('UPDATE project_runs SET record=?,updated_at=? WHERE session_id=? AND run_id=?')
      .run(JSON.stringify({ ...preparing, currentCheckId: 'blocked' }), new Date().toISOString(), sid, run.runId)
    selectProjectCheck(store, sid, run.runId)
    recordProjectCheck(store, sid, run.runId, 'blocked', {
      executionState: 'ended', verdict: 'blocked', checkedContent: 'login required', gaps: 'credentials required',
    })
    const retry = startProjectRetest(store, sid, { parentRunId: run.runId, checkIds: ['blocked'] })
    assert.equal(retry.retryMode, 'same-run')
    assert.equal(retry.run.runId, run.runId)
    assert.equal(retry.checks[0].executionState, 'pending')
    assert.equal(retry.checks[0].activeAttempt.attemptId !== retry.checks[0].attempts[0].attemptId, true)
  })

  await test('R07 completed retest inherits an ended dependency and reruns only the selected check', () => {
    const sid = 'completed-retest-valid'
    const run = startProjectTask(store, sid, { policy: { question: 'valid dependency' } })
    defineProjectChecks(store, sid, run.runId, [
      { checkId: 'login', requirement: 'prepare session', provides: ['authenticated'] },
      { checkId: 'access', requirement: 'check access', dependencies: ['login'], requiresFacts: ['authenticated'] },
    ])
    const running = readProjectRun(store, sid, run.runId)
    transitionProjectRun(store, sid, run.runId, 'running', running.controlRev)
    const proof = path.join(home, 'completed-retest-login.txt')
    fs.writeFileSync(proof, 'session prepared')
    const evidence = saveProjectEvidence(store, sid, run.runId, 'login', {
      kind: 'file', path: proof, text: 'session prepared', sha256: 'completed-retest-login', complete: true,
    })
    recordProjectCheck(store, sid, run.runId, 'login', {
      executionState: 'ended', verdict: 'expectation_met', checkedContent: 'session prepared', evidenceRefs: [evidence.id],
    })
    const completed = readProjectRun(store, sid, run.runId)
    transitionProjectRun(store, sid, run.runId, 'completed', completed.controlRev)
    const retest = startProjectRetest(store, sid, { parentRunId: run.runId, checkIds: ['access'] })
    assert.equal(retest.retryMode, 'new-run')
    assert.deepEqual(retest.executedCheckIds, ['access'])
    assert.deepEqual(retest.inheritedCheckIds, ['login'])
    assert.equal(retest.checks.find(check => check.checkId === 'login').inherited, true)
    assert.equal(retest.checks.find(check => check.checkId === 'access').inherited, false)
  })

  await test('R07 case retest preserves source mappings and does not require a second manual document read', () => {
    const sid = 'completed-retest-source-map'
    upsertProjectSource(store, sid, {
      sourceId: 'retest-sheet', sourceRevision: 'r1', displayName: 'retest.xlsx', kind: 'xlsx', parseState: 'ready',
      sections: [
        { sectionId: 'row-2', location: { kind: 'row', sheet: 'Cases', row: 2 }, kind: 'row',
          cells: [{ ref: 'A2', value: '读取 retest.txt' }] },
        { sectionId: 'row-3', location: { kind: 'row', sheet: 'Cases', row: 3 }, kind: 'row',
          cells: [{ ref: 'A3', value: '另一个不重测的要求' }] },
      ],
    })
    const run = createProjectRun(store, sid, {
      question: 'source mapping retest',
      sourceSnapshot: [{ sourceId: 'retest-sheet', sourceRevision: 'r1' }],
    })
    defineProjectChecks(store, sid, run.runId, [
      { checkId: 'case-1', requirement: '读取 retest.txt',
        sourceRefs: [{ sourceId: 'retest-sheet', sourceRevision: 'r1', sectionId: 'row-2' }] },
      { checkId: 'case-2', requirement: '另一个不重测的要求',
        sourceRefs: [{ sourceId: 'retest-sheet', sourceRevision: 'r1', sectionId: 'row-3' }] },
    ], [
      { sourceId: 'retest-sheet', sourceRevision: 'r1', sectionId: 'row-2',
        decision: 'requirements', rationale: '原表要求', checkIds: ['case-1'] },
      { sourceId: 'retest-sheet', sourceRevision: 'r1', sectionId: 'row-3',
        decision: 'requirements', rationale: '原表另一项', checkIds: ['case-2'] },
    ], { programmaticSourceDecisions: true })
    const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev)
    transitionProjectRun(store, sid, run.runId, 'cancelled', running.controlRev)
    const retest = startProjectRetest(store, sid, { parentRunId: run.runId, checkIds: ['case-1'] })
    assert.deepEqual(retest.checks[0].sourceRefs, [{ sourceId: 'retest-sheet', sourceRevision: 'r1', sectionId: 'row-2' }])
    assert.equal(Object.values(retest.run.sectionDecisions).find(item => item.sectionId === 'row-2').decision, 'requirements')
    assert.equal(Object.values(retest.run.sectionDecisions).find(item => item.sectionId === 'row-3').decision, 'reference')
  })

  await test('R07 completed retest reports an invalid dependency instead of silently dropping it', () => {
    const sid = 'completed-retest-invalid'
    const run = startProjectTask(store, sid, { policy: { question: 'invalid dependency' } })
    defineProjectChecks(store, sid, run.runId, [
      { checkId: 'login', requirement: 'prepare session', provides: ['authenticated'] },
      { checkId: 'access', requirement: 'check access', dependencies: ['login'], requiresFacts: ['authenticated'] },
    ])
    const running = readProjectRun(store, sid, run.runId)
    transitionProjectRun(store, sid, run.runId, 'running', running.controlRev)
    recordProjectCheck(store, sid, run.runId, 'login', {
      executionState: 'ended', verdict: 'blocked', gaps: 'credentials missing',
    })
    const completed = readProjectRun(store, sid, run.runId)
    transitionProjectRun(store, sid, run.runId, 'completed', completed.controlRev)
    assert.throws(
      () => startProjectRetest(store, sid, { parentRunId: run.runId, checkIds: ['access'] }),
      /前置条件尚未完成.*login/,
    )
  })

  await test('R18 fresh task uses zero helpers while explicit choice survives', () => {
    const sid = 'worker-default'
    const policy = startTaskPolicy(store, sid, { mode: 'regular', question: 'default helpers' })
    assert.equal(policy.workerLimit, 0)
  })

  await test('R18 competition deadline has a stable start and stops an in-flight execution', async () => {
    const sid = 'competition-deadline'
    writeSceneContext(store, sid, 'competition', { presetId: 'ctf-solver' })
    const configured = setCompetitionPreferences(store, sid, { minutes: 0.005, workers: 0, interaction: 'auto' })
    const startedAt = configured.preferences.budget.startedAt
    const updated = setCompetitionPreferences(store, sid, { toolCalls: 4 })
    assert.equal(updated.preferences.budget.startedAt, startedAt, 'editing another setting must not extend the deadline')
    const challenge = createCompetitionChallenge(store, sid, { title: 'deadline' })
    const script = path.join(home, 'competition-timeout.mjs')
    fs.writeFileSync(script, "setTimeout(()=>process.stdout.write('TOO_LATE'), 1000)\n")
    const execution = runCompetitionExecution(store, sid, challenge.challengeId, {
      command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(script), environment: 'host',
    })
    assert.equal(execution.deadlineAt, Date.parse(startedAt) + 300)
    await new Promise(resolve => setTimeout(resolve, 900))
    const output = readCompetitionOutput(store, sid, challenge.challengeId, execution.executionId)
    assert.equal(output.timedOut, true)
    assert.equal(output.stopReason, 'time_limit_exhausted')
    assert.notEqual(output.state, 'running')
  })

  await test('R18 competition rejects unsupported confirmation and enforces its concurrent execution limit', async () => {
    const sid = 'competition-limits'
    writeSceneContext(store, sid, 'competition', { presetId: 'ctf-solver' })
    setCompetitionPreferences(store, sid, { workers: 0, interaction: 'confirm-step' })
    const challenge = createCompetitionChallenge(store, sid, { title: 'limits' })
    assert.throws(() => runCompetitionExecution(store, sid, challenge.challengeId, {
      command: 'echo blocked', environment: 'host',
    }), /interaction confirmation/)
    setCompetitionPreferences(store, sid, { workers: 0, interaction: 'auto' })
    const script = path.join(home, 'competition-concurrency.mjs')
    fs.writeFileSync(script, "setTimeout(()=>{}, 700)\n")
    const command = JSON.stringify(process.execPath) + ' ' + JSON.stringify(script)
    const first = runCompetitionExecution(store, sid, challenge.challengeId, { command, environment: 'host' })
    assert.throws(() => runCompetitionExecution(store, sid, challenge.challengeId, { command, environment: 'host' }),
      /concurrency limit/)
    stopAllCompetitionExecutions(store)
    assert.equal(readCompetitionExecution(store, sid, challenge.challengeId, first.executionId).state, 'stopped')
  })

  await test('R17 nonexistent evidence and model-supplied host judgment cannot be delivered', () => {
    const sid = 'false-proof'
    const finding = registerFinding(store, sid, 'pentest', {
      title: 'source issue', severity: 'medium', target: 'missing.js', evidenceLevel: 'confirmed',
      impact: 'claimed impact', evidence: 'claimed source', proofKind: 'other-impact',
      evidenceRefs: [{ kind: 'source', id: 'DOES-NOT-EXIST' }],
      reproduction: JSON.stringify({
        kind: 'analysis', mechanism: 'source', methodVersion: 'v1', prerequisites: [], dependencies: [], parameters: [],
        steps: ['read source'], successCriterion: 'claimed', reviewSteps: 'review',
        verification: { status: 'verified', evidenceIds: ['DOES-NOT-EXIST'] },
        judgment: { source: 'host', basis: 'model supplied claim' },
      }),
    })
    const verified = updateFinding(store, sid, 'pentest', finding.id, {
      status: 'verified', secondRating: 'medium', secondRatingNote: 'claimed review',
    })
    const state = findingDeliveryState(verified)
    assert.equal(state.ready, false)
    assert(state.gaps.includes('actual-evidence-reference-invalid'))
    assert(state.gaps.includes('judgment-source-invalid'))
  })
} finally {
  stopAllCompetitionExecutions(store)
  store.close()
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(failed ? failed + ' failed' : 'all passed')
if (failed) process.exitCode = 1
