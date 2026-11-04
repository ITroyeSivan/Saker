import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore, registerFinding, updateFinding } from '../plugins/dsh-redteam-results/lib/store.js'
import { normalizeScene, scenePreset } from '../lib/scene-context.mjs'
import { readSceneContext, reconcileSceneFromTask, setCompetitionKnowledge, writeSceneContext } from '../plugins/dsh-redteam-results/lib/scene-context.js'
import { addCompetitionAnswer, competitionSummary, createCompetitionChallenge, listCompetitionChallenges, updateCompetitionAnswer } from '../plugins/dsh-redteam-results/lib/competition-store.js'
import { importKnowledgeText, readKnowledge, searchKnowledge } from '../plugins/dsh-redteam-results/lib/competition-knowledge.js'
import { readCompetitionOutput, runCompetitionExecution, stopCompetitionExecution, writeCompetitionInput } from '../plugins/dsh-redteam-results/lib/competition-execution.js'
import { computeScenarioDeny } from '../plugins/dsh-tool-scope/lib/rules.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { createProjectRun, transitionProjectRun, defineProjectChecks, recordProjectCheck, saveProjectEvidence, reopenProjectCheck } from '../plugins/dsh-redteam-results/lib/project-store.js'
import { completeProjectRun, pauseProjectContinuation, projectExecutableChecks, projectTurnDecision, startProjectRetest } from '../plugins/dsh-redteam-results/lib/project-runtime.js'
import { findingDeliveryState } from '../plugins/dsh-redteam-results/lib/delivery.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-three-scenes-'))
process.env.DSH_HOME = home
const store = openStore(path.join(home, 'redteam-results', 'results.db'))
let failed = 0
async function test(name, work) { try { await work(); console.log('ok   ' + name) } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) } }

try {
  await test('scene IDs are stable and legacy values never fall through to free', () => {
    assert.equal(normalizeScene('pentest'), 'free')
    assert.equal(normalizeScene('project'), 'cases')
    assert.equal(normalizeScene('ctf-solver'), 'competition')
    assert.equal(normalizeScene('competition'), 'competition')
    assert.equal(scenePreset('free'), 'pentest')
    assert.equal(scenePreset('cases'), 'pentest')
    assert.equal(scenePreset('competition'), 'ctf-solver')
    assert.throws(() => normalizeScene('unknown'), /unknown Saker scene/)
  })

  await test('scene context persists revisions, idempotency, conflicts and knowledge state', () => {
    const first = writeSceneContext(store, 'scene-session', 'free', { presetId: 'pentest', expectedRevision: 0, requestId: 'r1' })
    assert.equal(first.sceneId, 'free')
    assert.equal(first.sceneRevision, 1)
    const same = writeSceneContext(store, 'scene-session', 'free', { presetId: 'pentest', expectedRevision: 0, requestId: 'r1' })
    assert.equal(same.idempotent, true)
    assert.throws(() => writeSceneContext(store, 'scene-session', 'free', {
      presetId: 'pentest', expectedRevision: 1, requestId: 'r1',
    }), /same scene requestId/)
    assert.throws(() => writeSceneContext(store, 'scene-session', 'cases', { presetId: 'pentest', expectedRevision: 0, requestId: 'r2' }), /changed/)
    const cases = writeSceneContext(store, 'scene-session', 'cases', { presetId: 'pentest', expectedRevision: 1, requestId: 'r3' })
    assert.equal(cases.sceneId, 'cases')
    assert.equal(reconcileSceneFromTask(store, 'scene-session', 'project', 'pentest').sceneId, 'cases')
    writeSceneContext(store, 'competition-session', 'competition', { presetId: 'ctf-solver', expectedRevision: 0 })
    assert.equal(setCompetitionKnowledge(store, 'competition-session', true).knowledgeEnabled, true)
    assert.equal(readSceneContext(store, 'competition-session', 'ctf-solver').knowledgeEnabled, true)
  })

  await test('tool visibility is scene-specific and unknown scenes do not default to free', () => {
    const known = ['redteam_execution', 'project_check', 'project_evidence', 'competition_challenge', 'competition_knowledge']
    assert.deepEqual(computeScenarioDeny('free', known), ['competition_challenge', 'competition_knowledge', 'project_check', 'project_evidence'])
    assert.deepEqual(computeScenarioDeny('cases', known), ['competition_challenge', 'competition_knowledge', 'project_check', 'project_evidence', 'redteam_execution'])
    assert.deepEqual(computeScenarioDeny('competition', known, { knowledgeEnabled: false }), ['competition_challenge', 'competition_knowledge', 'project_check', 'project_evidence', 'redteam_execution'])
    assert.deepEqual(computeScenarioDeny('competition', known, { knowledgeEnabled: true }), ['competition_challenge', 'project_check', 'project_evidence', 'redteam_execution'])
    assert.deepEqual(computeScenarioDeny('unknown', known), [])
  })

  await test('competition preserves exact answers and never lets the model mark accepted', () => {
    const challenge = createCompetitionChallenge(store, 'competition-session', {
      title: 'login-backup', prompt: 'Find the exact flag', environment: { kind: 'host' },
    })
    const answer = addCompetitionAnswer(store, 'competition-session', challenge.challengeId, {
      value: 'FLAG{Case Sensitive }', source: 'stdout at output/run.log', status: 'pending',
    })
    assert.equal(answer.value, 'FLAG{Case Sensitive }')
    assert.throws(() => updateCompetitionAnswer(store, 'competition-session', challenge.challengeId, answer.answerId, { status: 'accepted' }), /confirmation/)
    const accepted = updateCompetitionAnswer(store, 'competition-session', challenge.challengeId, answer.answerId, {
      status: 'accepted', confirmedBy: 'user', confirmationNote: 'user confirmed from platform output',
    })
    assert.equal(accepted.status, 'accepted')
    assert.equal(listCompetitionChallenges(store, 'competition-session').rows.length, 1)
  })

  await test('competition lists stay bounded and omit full prompt bodies at scale', () => {
    const at = new Date().toISOString()
    store.db.exec('BEGIN IMMEDIATE')
    try {
      const insert = store.db.prepare('INSERT INTO competition_challenges(session_id,challenge_id,state,revision,record,updated_at) VALUES(?,?,?,?,?,?)')
      for (let index = 0; index < 1000; index += 1) {
        const id = 'bulk-' + index
        insert.run('bulk-competition', id, index % 3 === 0 ? 'solved' : 'open', 1,
          JSON.stringify({ challengeId: id, title: 'Challenge ' + index, prompt: 'x'.repeat(10000), state: index % 3 === 0 ? 'solved' : 'open',
            revision: 1, instance: { revision: 1 }, environment: { kind: 'host' }, attachments: [], createdAt: at, updatedAt: at }), at)
      }
      store.db.exec('COMMIT')
    } catch (error) {
      store.db.exec('ROLLBACK')
      throw error
    }
    const page = listCompetitionChallenges(store, 'bulk-competition', { limit: 50, offset: 0 })
    assert.equal(page.rows.length, 50)
    assert.equal(page.total, 1000)
    assert.equal(Object.hasOwn(page.rows[0], 'prompt'), false)
    assert.equal(competitionSummary(store, 'bulk-competition').challenges, 1000)
    assert.equal(competitionSummary(store, 'bulk-competition').solved, 0,
      'a syntactically solved challenge row without a confirmed answer is not a solved result')
  })

  await test('knowledge search and read preserve revisions and page at 8KiB', async () => {
    const text = 'GDB remote debugging\n' + 'x'.repeat(9000) + '\nneedle=value'
    const source = await importKnowledgeText(store, 'competition-session', { title: 'gdb-tools', text: text.repeat(2) })
    const found = searchKnowledge(store, 'competition-session', { query: 'needle', limit: 5 })
    assert.equal(found.rows.length, 2)
    assert.match(found.rows[0].excerpt, /needle=value/)
    const page = readKnowledge(store, 'competition-session', { sourceId: source.sourceId, revision: source.revision, maxBytes: 8192 })
    assert.equal(page.text.length <= 8192, true)
    assert(page.nextCursor)
    await importKnowledgeText(store, 'competition-session', { sourceId: source.sourceId, title: 'gdb-tools-v2', text: text + '\nnew revision' })
    const oldRevision = readKnowledge(store, 'competition-session', { sourceId: source.sourceId, revision: source.revision, cursor: page.nextCursor })
    assert.equal(oldRevision.revision, source.revision, 'old cursors continue on the immutable revision')
  })

  await test('interactive command keeps stdin, output, process ownership and stop state', async () => {
    const challenge = listCompetitionChallenges(store, 'competition-session').rows[0]
    const script = path.join(home, 'interactive.mjs')
    fs.writeFileSync(script, "process.stdout.write('READY\\n');process.stdin.once('data',d=>{process.stdout.write('GOT:'+d.toString().trim()+'\\n');process.exit(0)})\n")
    const execution = runCompetitionExecution(store, 'competition-session', challenge.challengeId, {
      command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(script), environment: 'host',
    })
    assert.equal(execution.state, 'running')
    assert.equal(Object.hasOwn(execution, 'child'), false)
    assert.deepEqual(JSON.parse(JSON.stringify(execution)), execution)
    writeCompetitionInput(store, 'competition-session', challenge.challengeId, execution.executionId, { text: 'input-line' })
    const deadline = Date.now() + 8000
    let output
    do {
      await new Promise(resolve => setTimeout(resolve, 100))
      output = readCompetitionOutput(store, 'competition-session', challenge.challengeId, execution.executionId, { maxBytes: 65536 })
    } while (output.state === 'running' && Date.now() < deadline)
    assert.match(output.stdout.text, /READY/)
    assert.match(output.stdout.text, /GOT:input-line/)
    assert.notEqual(output.state, 'running')
    assert.equal(output.workDir.startsWith(home), true)

    const longExecution = runCompetitionExecution(store, 'competition-session', challenge.challengeId, {
      command: JSON.stringify(process.execPath) + ' -e "setInterval(function(){},1000)"', environment: 'host',
    })
    assert.deepEqual(JSON.parse(JSON.stringify(longExecution)), longExecution)
    assert.equal(stopCompetitionExecution(store, 'competition-session', challenge.challengeId, longExecution.executionId).state, 'stopped')
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(readCompetitionOutput(store, 'competition-session', challenge.challengeId, longExecution.executionId).state, 'stopped')
  })

  await test('case results use typed evidence without requiring a formal finding or 40-character note', async () => {
    const sid = 'case-session'
    startTaskPolicy(store, sid, { scenario: 'project', question: 'typed evidence', budget: { minutes: 5 } })
    const run = createProjectRun(store, sid, { question: 'typed evidence' })
    transitionProjectRun(store, sid, run.runId, 'running', run.controlRev)
    const [expectation, issue] = defineProjectChecks(store, sid, run.runId, [
      { checkId: 'expect', requirement: 'Export contains only approved fields' },
      { checkId: 'issue', requirement: 'A user cannot read another user order' },
    ])
    const evidenceFile = path.join(home, 'evidence.txt')
    fs.writeFileSync(evidenceFile, 'order=OWNER-B\nfield=approved\n')
    const evidence = saveProjectEvidence(store, sid, run.runId, issue.checkId, {
      kind: 'file', path: evidenceFile, offset: 0, text: fs.readFileSync(evidenceFile, 'utf8'),
      sha256: 'fixture-sha256', complete: true,
    })
    const completedIssue = recordProjectCheck(store, sid, run.runId, issue.checkId, {
      executionState: 'ended', verdict: 'issue', checkedContent: 'owner A reads owner B order', evidenceRefs: [evidence.id],
    })
    assert.equal(completedIssue.verdict, 'issue')
    assert.equal(completedIssue.findingRefs.length, 0)
    const expectationEvidence = saveProjectEvidence(store, sid, run.runId, expectation.checkId, {
      kind: 'file', path: evidenceFile, offset: 0, text: fs.readFileSync(evidenceFile, 'utf8'),
      sha256: 'fixture-file-sha256', complete: true,
    })
    const completedExpectation = recordProjectCheck(store, sid, run.runId, expectation.checkId, {
      executionState: 'ended', verdict: 'expectation_met', checkedContent: 'actual export matched approved fields',
      evidenceRefs: [expectationEvidence.id],
    })
    assert.equal(completedExpectation.verdict, 'expectation_met')
    assert.equal(projectTurnDecision(store, sid).action, 'completed')
    assert.equal(completeProjectRun(store, sid, run.runId).completedSummary.coverageComplete, true)
    const retest = startProjectRetest(store, sid, { parentRunId: run.runId, checkIds: [issue.checkId], policy: { minutes: 5 } })
    assert.equal(retest.run.retest.parentRunId, run.runId)
    assert.equal(retest.run.retest.selectedCount, 1)
    assert.equal(retest.run.retest.originalTotal, 2)
    assert.equal(retest.checks.length, 1)
    assert.equal(retest.checks[0].originCheckId, issue.checkId)
    assert.equal(projectExecutableChecks(store, sid, retest.run.runId).length, 1)
    const paused = pauseProjectContinuation(store, sid, 'follow one lead first', retest.run.controlRev)
    assert.equal(paused.continuationPaused, true)
    assert.equal(projectTurnDecision(store, sid).action, 'none')
  })

  await test('free analysis can keep a factual model judgment without fabricating HTTP evidence or 40 characters', () => {
    const sid = 'free-factual'
    startTaskPolicy(store, sid, { mode: 'regular', question: 'source review', budget: { toolCalls: 5 } })
    store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
      .run(sid, 'src-auth-41-53', 'src/auth.js', 'fixture-source-digest', JSON.stringify({
        id: 'src-auth-41-53', source: 'fixture-source', bytes: 120, digest: 'fixture-source-digest',
        text: 'if (a[i] !== b[i]) return false',
      }))
    const created = registerFinding(store, sid, 'pentest', {
      title: 'Bearer token comparison uses non-constant time',
      severity: 'medium', target: 'src/auth.js', evidenceLevel: 'confirmed',
      impact: 'A caller with timing observations may reduce token guessing cost.',
      evidence: 'src/auth.js lines 41-53 and the saved command observation',
      proofKind: 'other-impact', evidenceRefs: [{ kind: 'source', id: 'src-auth-41-53' }],
      reproduction: JSON.stringify({ kind: 'analysis', mechanism: 'source comparison', methodVersion: 'v1',
        prerequisites: [], dependencies: [], parameters: [], steps: ['Read the token comparison implementation'],
        successCriterion: 'Comparison does not short-circuit on the first differing byte',
        reviewSteps: 'Inspect the current source revision and call path',
        verification: { status: 'verified', evidenceIds: ['src-auth-41-53'] },
        judgment: { source: 'model', basis: 'The compared byte is indexed in an unbounded loop' } }),
    })
    const verified = updateFinding(store, sid, 'pentest', created.id, {
      status: 'verified', secondRating: 'medium', secondRatingNote: 'reviewed against current source',
    })
    const state = findingDeliveryState(verified)
    assert.equal(state.ready, true, state.gaps.join(','))
    assert.equal(state.judgmentSource, 'model')
  })
} finally {
  store.close()
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(failed ? failed + ' failed' : 'all passed')
if (failed) process.exitCode = 1
