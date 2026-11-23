import assert from 'node:assert/strict'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { createSiteWorkers, siteWorkerRows } from '../plugins/dsh-redteam-results/lib/site-workers.js'
import { createRoleOrchestrator, readRoleInstance } from '../plugins/dsh-redteam-results/lib/role-orchestration.js'

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) }
}

function fixture(store, rootId, { failDispose = false } = {}) {
  startTaskPolicy(store, rootId, {
    mode: 'regular', target: 'https://app.rc2.test',
    budget: { toolCalls: 30, modelCalls: 20, workers: 2 },
  })
  saveTaskContext(store, rootId, {
    assets: [{ id: 'asset-rc2', url: 'https://app.rc2.test', inScope: true, reachable: true }],
    requests: [], checks: [], methods: [], maxSupplementAttempts: 2,
  })
  const live = new Map(), starts = [], hooks = new Map()
  const subagents = {
    async startActivation(spec) {
      starts.push(spec)
      const child = { session: { id: spec.childId, header: { agentPreset: 'pentest', parentSession: spec.parent.session.id } } }
      live.set(spec.childId, child)
      hooks.get('subagent/start')?.({ id: spec.childId, runId: 'run-' + spec.childId, provider: 'spawn',
        parentSessionId: spec.parent.session.id, local: true })
      return {
        childId: spec.childId,
        name: spec.name || 'agent',
        result: new Promise(() => {}),
        dispose: async () => {
          if (failDispose) throw new Error('fixture teardown failure')
          live.delete(spec.childId)
          hooks.get('subagent/end')?.({ id: spec.childId, runId: 'run-' + spec.childId, provider: 'spawn',
            parentSessionId: spec.parent.session.id, local: true, stopReason: 'completed' })
        },
      }
    },
    async listDescendants() { return [...live.keys()].map(id => ({ id, kind: 'agent' })) },
    async drainDescendants() { throw new Error('whole-tree drain must not be used for one role') },
  }
  const ctx = {
    subagents,
    agents: { get: id => live.get(id) },
    on(name, fn) { hooks.set(name, fn) },
    logger: { warn() {}, info() {}, error() {} },
    tools: { schemas: () => ['read', 'redteam_execution', 'saker_role'].map(name => ({ name })) },
  }
  const manager = createSiteWorkers(ctx, () => store)
  const roles = createRoleOrchestrator({
    ctx, getStore: () => store, siteWorkers: manager,
    taskStatus: status => ({ configured: true, stopped: false, policy: { workerLimit: 2, budget: { toolCalls: 30 }, used: { toolCalls: 0 } } }),
    siteParent: () => null,
  })
  const root = { session: { id: rootId, header: { agentPreset: 'pentest' } }, ctx }
  return { ctx, manager, roles, root, live, starts }
}

const role = {
  title: 'rc.2 角色', objective: '验证 rc.2 激活参数被正确展平。',
  responsibilities: '读取请求并返回证据。', deliverable: '事实与缺项。',
  capabilities: ['http-replay'], tools: ['read', 'redteam_execution'],
}
const work = {
  title: 'rc.2 激活验收', question: '确认 Host 收到顶层 parent/prompt/maxDepth。',
  target: 'https://app.rc2.test', assetIds: ['asset-rc2'],
  successCriterion: '首个请求包含角色职责与工作问题。', falsifier: '参数缺失或仍嵌套在 request 中。',
}

await test('rc.2 activation is flattened and exact dispose releases one child', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'rc2-root')
  try {
    const started = await fx.roles.start(fx.root, { role, work }, new AbortController().signal)
    assert.equal(started.ok, true)
    assert.equal(fx.starts.length, 1)
    const spec = fx.starts[0]
    assert.equal(spec.request, undefined, 'rc.2 must not receive the old request wrapper')
    assert.equal(spec.parent.session.id, 'rc2-root')
    assert.equal(spec.maxDepth, 1)
    assert.equal(Array.isArray(spec.prompt), true)
    assert.match(spec.prompt.map(part => part.text).join('\n'), /Dynamic role: rc\.2 角色/)
    assert.match(spec.name, /^saker-[a-z0-9-]{1,26}$/)
    const row = siteWorkerRows(store, 'rc2-root').find(item => item.childId === started.childId)
    assert.equal(row.activationRunId, 'run-' + started.childId)
    const stopped = await fx.roles.stop(fx.root, { instanceId: started.childId }, new AbortController().signal)
    assert.equal(stopped.ok, true)
    assert.equal(fx.live.has(started.childId), false)
    assert.equal(readRoleInstance(store, 'rc2-root', started.childId).state, 'stopped')
  } finally { await fx.manager.dispose(); store.close() }
})

await test('a failed exact dispose leaves cleanup-failed and does not pretend the slot is free', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'rc2-fail-root', { failDispose: true })
  try {
    const started = await fx.roles.start(fx.root, { role, work }, new AbortController().signal)
    const stopped = await fx.roles.stop(fx.root, { instanceId: started.childId }, new AbortController().signal)
    assert.equal(stopped.ok, false)
    const row = readRoleInstance(store, 'rc2-fail-root', started.childId)
    assert.equal(row.state, 'cleanup-failed')
    assert.match(row.error, /teardown failure/)
    assert.equal(fx.live.has(started.childId), true, 'unconfirmed child remains owned')
  } finally {
    // This fixture intentionally cannot release; remove its live child without
    // invoking the failed dispose so the in-memory store can close cleanly.
    fx.live.clear()
    await fx.manager.dispose()
    store.close()
  }
})

if (failed) process.exitCode = 1
console.log(failed ? `${failed} failed` : 'all rc.2 host bridge tests passed')
