import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { listCompetitionChallenges } from '../plugins/dsh-redteam-results/lib/competition-store.js'
import { importKnowledgeText, searchKnowledge } from '../plugins/dsh-redteam-results/lib/competition-knowledge.js'
import { createProjectRun } from '../plugins/dsh-redteam-results/lib/project-store.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-three-scene-perf-'))
process.env.DSH_HOME = home
const store = openStore(path.join(home, 'redteam-results', 'results.db'))
const disposers = []
let modelCalls = 0
const percentile = (values, ratio) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1]

async function sample(count, work) {
  const values = []
  for (let index = 0; index < count; index += 1) {
    const started = performance.now()
    await work(index)
    values.push(performance.now() - started)
  }
  return { samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values), values: values.map(value => Math.round(value * 100) / 100) }
}

try {
  const at = new Date().toISOString()
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const insert = store.db.prepare('INSERT INTO competition_challenges(session_id,challenge_id,state,revision,record,updated_at) VALUES(?,?,?,?,?,?)')
    for (let index = 0; index < 1000; index += 1) {
      const id = 'perf-challenge-' + index
      insert.run('perf-competition', id, 'open', 1, JSON.stringify({
        challengeId: id, title: 'Scale challenge ' + index, prompt: 'x'.repeat(4096), state: 'open',
        revision: 1, instance: { revision: 1 }, environment: { kind: 'host' }, attachments: [], createdAt: at, updatedAt: at,
      }), at)
    }
    store.db.exec('COMMIT')
  } catch (error) {
    store.db.exec('ROLLBACK')
    throw error
  }

  for (let index = 0; index < 20; index += 1) {
    await importKnowledgeText(store, 'perf-competition', {
      title: 'fixture-' + index,
      text: ('Saker local knowledge fixture ' + index + '\n').repeat(1200) + 'needle-' + index + '=value',
    })
  }

  const knowledge = await sample(25, index => {
    const result = searchKnowledge(store, 'perf-competition', { query: 'needle-' + (index % 20), limit: 5 })
    assert(result.rows.length > 0)
  })
  const challengeList = await sample(25, index => {
    const page = listCompetitionChallenges(store, 'perf-competition', { offset: (index % 10) * 50, limit: 50 })
    assert.equal(page.rows.length, 50)
    assert.equal(Object.hasOwn(page.rows[0], 'prompt'), false)
  })

  const results = await import('../plugins/dsh-redteam-results/lib/index.js')
  const ctx = {
    sessions: { get: id => ({ id, header: { agentPreset: 'pentest' } }) },
    tools: { register: () => {}, guard: () => {} },
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    systemPrompt: { section: () => {}, context: () => {} },
    webServer: { register: () => () => {} },
    llm: new Proxy({}, { get: () => () => { modelCalls += 1; throw new Error('local read attempted a model call') } }),
  }
  results.apply(ctx)
  const run = createProjectRun(store, 'perf-cases', { question: 'performance' })
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const insert = store.db.prepare('INSERT INTO project_checks(session_id,run_id,check_id,check_revision,record,updated_at) VALUES(?,?,?,?,?,?)')
    for (let index = 0; index < 10000; index += 1) {
      const checkId = 'perf-check-' + index
      insert.run('perf-cases', run.runId, checkId, 1, JSON.stringify({
        sessionId: 'perf-cases', runId: run.runId, checkId, checkRevision: 1, requirement: 'Requirement ' + index,
        order: index, executionState: 'pending', verdict: '', checkedContent: '', gaps: '',
        findingRefs: [], actionRefs: [], evidenceRefs: [], createdAt: at, updatedAt: at,
      }), at)
    }
    store.db.exec('COMMIT')
  } catch (error) {
    store.db.exec('ROLLBACK')
    throw error
  }
  const projectPaging = await sample(25, index => {
    return results.dispatch(ctx, store, 'project.status', {
      sessionId: 'perf-cases', runId: run.runId, checkOffset: (index % 10) * 50, checkLimit: 50,
    }).then(page => {
      assert.equal(page.ok, true, page.error)
      assert.equal(page.checks.length, 50)
      assert.equal(page.checkTotal, 10000)
    })
  })

  assert(knowledge.p95Ms <= 500, `knowledge search p95 ${knowledge.p95Ms}ms > 500ms`)
  assert(challengeList.p95Ms <= 300, `challenge paging p95 ${challengeList.p95Ms}ms > 300ms`)
  assert(projectPaging.p95Ms <= 300, `project paging p95 ${projectPaging.p95Ms}ms > 300ms`)
  assert.equal(modelCalls, 0)
  console.log('ok   knowledge search p95=' + knowledge.p95Ms.toFixed(2) + 'ms')
  console.log('ok   challenge paging p95=' + challengeList.p95Ms.toFixed(2) + 'ms')
  console.log('ok   project paging p95=' + projectPaging.p95Ms.toFixed(2) + 'ms')
  console.log('ok   local list/search/paging model calls=' + modelCalls)
  console.log(JSON.stringify({ knowledge, challengeList, projectPaging, modelCalls,
    fixture: { challenges: 1000, knowledgeSources: 20, projectChecks: 10000 } }, null, 2))
} finally {
  for (const dispose of disposers.reverse()) { try { await dispose() } catch { /* already closed */ } }
  store.close()
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
