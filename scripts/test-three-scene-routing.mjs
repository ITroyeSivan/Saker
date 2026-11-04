import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import * as results from '../plugins/dsh-redteam-results/lib/index.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-scene-routing-'))
process.env.DSH_HOME = home
const db = path.join(home, 'redteam-results', 'results.db')
const store = openStore(db)
const sessions = new Map([
  ['free', { id: 'free', header: { agentPreset: 'pentest' } }],
  ['related', { id: 'related', header: { agentPreset: 'pentest' } }],
  ['competition', { id: 'competition', header: { agentPreset: 'ctf-solver' } }],
  ['standard', { id: 'standard', header: { agentPreset: 'standard' } }],
])
const followups = [], tools = new Map(), disposers = []
let boundaryReads = 0
const agents = {
  get: id => sessions.has(id) ? { id, session: sessions.get(id), status: 'idle', followup: value => followups.push(value) } : undefined,
  turnBoundaryOf: () => { boundaryReads++; return { lastTurn: 0, openTurnStartSeq: null } },
}
const ctx = {
  sessions: { get: id => sessions.get(id) },
  agents,
  sessionProjections: { stateOf: () => { throw new Error('deprecated projection read must not run when the owning service is available') } },
  tools: { register: tool => tools.set(tool.name, tool), guard: () => {}, schemas: () => [...tools.keys()].map(name => ({ name })) },
  systemPrompt: { section: () => {}, context: () => {} },
  webServer: { register: () => () => {} },
  effect: fn => { const value = fn(); if (typeof value === 'function') disposers.push(value); return value },
  provide: () => {},
  on: () => {},
  get: () => null,
  emit: () => {},
}
const applyDispose = results.apply(ctx)
if (typeof applyDispose === 'function') disposers.push(applyDispose)

let failed = 0
async function test(name, work) { try { await work(); console.log('ok   ' + name) } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) } }
try {
  await test('scene.get is read-only and standard host presets are not mislabeled', async () => {
    const free = await results.dispatch(ctx, store, 'scene.get', { sessionId: 'free', hasDraft: false })
    assert.equal(free.ok, true)
    assert.equal(free.sceneId, 'free')
    assert.equal(free.canSwitchInPlace, true)
    assert.equal(boundaryReads, 1)
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM scene_contexts').get().n, 0)
    const standard = await results.dispatch(ctx, store, 'scene.get', { sessionId: 'standard' })
    assert.equal(standard.saker, false)
    const missing = await results.dispatch(ctx, store, 'scene.get', { sessionId: '' })
    assert.equal(missing.ok, true)
    assert.equal(missing.saker, false)
  })

  await test('scene.select switches free to cases only through the scene contract', async () => {
    const value = await results.dispatch(ctx, store, 'scene.select', {
      sessionId: 'free', scene: 'cases', expectedRevision: 0, requestId: 'scene-routing-one', hasDraft: false,
    })
    assert.equal(value.sceneId, 'cases')
    assert.equal(value.sceneRevision, 1)
    const settings = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'free' })
    assert.equal(settings.ok, true)
    assert.equal(settings.scene.sceneId, 'cases')
    assert.equal(settings.configured, false)
    assert.equal(followups.length, 0, 'scene changes do not call the model')
  })

  await test('competition bind and knowledge toggle follow the ctf preset', async () => {
    const bound = await results.dispatch(ctx, store, 'scene.bind', {
      sessionId: 'competition', scene: 'competition', expectedRevision: 0, requestId: 'scene-routing-two',
    })
    assert.equal(bound.sceneId, 'competition')
    const toggled = await results.dispatch(ctx, store, 'scene.knowledge', {
      sessionId: 'competition', enabled: true, expectedRevision: bound.sceneRevision,
    })
    assert.equal(toggled.scene.knowledgeEnabled, true)
    const settings = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'competition' })
    assert.equal(settings.ok, true)
    assert.equal(settings.scene.sceneId, 'competition')
  })

  await test('competition APIs are local-only and expose bounded challenge data', async () => {
    const created = await results.dispatch(ctx, store, 'competition.create', {
      sessionId: 'competition', title: 'fixture', prompt: 'find flag', environment: { kind: 'host' },
    })
    assert.equal(created.ok, true)
    const status = await results.dispatch(ctx, store, 'competition.status', { sessionId: 'competition', limit: 50 })
    assert.equal(status.ok, true)
    assert.equal(status.challenges.rows.length, 1)
    assert.equal(Object.hasOwn(status.challenges.rows[0], 'prompt'), false)
    assert.equal(followups.length, 0, 'viewing challenge state never starts a model turn')
  })

  await test('prompt library is scene-filtered without starting a task', async () => {
    const before = store.db.prepare('SELECT count(*) AS n FROM task_policy').get().n
    const library = await results.dispatch(ctx, store, 'prompt.library', { sessionId: 'competition', action: 'list' })
    assert.equal(library.ok, true)
    assert.equal(library.scene, 'competition')
    assert(library.builtin.every(template => template.scene.includes('competition')))
    assert(library.builtin.some(template => template.id === 'competition.solve.v1'))
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_policy').get().n, before)
  })
} finally {
  for (const dispose of disposers.reverse()) { try { await dispose() } catch { /* closing */ } }
  store.close()
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
console.log(failed ? failed + ' failed' : 'all passed')
if (failed) process.exitCode = 1
