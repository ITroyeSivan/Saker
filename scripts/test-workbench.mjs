import assert from 'node:assert/strict'
import { openStore, registerFinding } from '../plugins/dsh-redteam-results/lib/store.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { startTaskPolicy, taskPolicyStatus } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { workbenchQuery, workbenchCommand } from '../plugins/dsh-redteam-results/lib/workbench.js'
import { createWorkItem } from '../plugins/dsh-redteam-results/lib/role-orchestration.js'

const store = openStore(':memory:')
const ctx = {
  agents: { get: () => null },
  sessions: { get: () => null },
  tools: { schemas: () => [{ name: 'redteam_execution', description: 'execute' }, { name: 'saker_role', description: 'role' }] },
}
try {
  startTaskPolicy(store, 'root-workbench', {
    mode: 'regular', target: 'https://app.workbench.test', question: '检查导出权限', budget: { toolCalls: 30, modelCalls: 10, workers: 1 },
  })
  saveTaskContext(store, 'root-workbench', {
    assets: [{ id: 'asset-1', url: 'https://app.workbench.test', inScope: true, reachable: true }],
    requests: [{ id: 'req-1', revision: 'r1', endpoint: 'https://app.workbench.test/api/export', authContext: 'account-a', kind: 'api' }],
    checks: [], methods: [], maxSupplementAttempts: 2,
  })
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run('root-workbench', 'receipt-asset',
    JSON.stringify({ requestId: 'req-1', request: 'GET https://app.workbench.test/api/export HTTP/1.1', status: 200,
      completedAt: '2026-01-01T00:00:00.000Z', outcome: 'response', integrityValid: true }))
  store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)').run(
    'root-workbench', 'material-1', 'local:fixture.har', 'fixture-digest',
    JSON.stringify({ id: 'material-1', name: 'fixture.har', bytes: 128, summary: { format: 'har' } }))
  registerFinding(store, 'root-workbench', 'pentest', {
    title: '导出记录可能跨账号', severity: 'high', summary: '正常请求显示对象归属可疑。',
    target: 'https://app.workbench.test', status: 'pending',
  })
  createWorkItem(store, 'root-workbench', {
    question: '比较两个账号导出记录的归属', target: 'https://app.workbench.test', assetIds: ['asset-1'],
    successCriterion: '有正常对照与跨账号差异。', falsifier: '共享对象或空响应能解释差异。',
  })

  let failed = 0
  const test = async (name, fn) => { try { await fn(); console.log('ok   ' + name) } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) } }

  await test('dashboard, roots, findings, assets and exploration read the same store', async () => {
    const dashboard = workbenchQuery(ctx, store, { kind: 'dashboard.summary' })
    assert.equal(dashboard.data.roots, 1)
    assert.equal(dashboard.data.pending, 1)
    assert.equal(dashboard.data.runningRoots, 1, 'running KPI follows business state, not only control state')
    assert.equal(dashboard.data.runningRoots <= dashboard.data.roots, true)
    const roots = workbenchQuery(ctx, store, { kind: 'roots.list', page: { limit: 20 } })
    assert.equal(roots.data.length, 1)
    assert.equal(roots.data[0].rootId, 'root-workbench')
    assert.equal(roots.data[0].outcomeSummary.pending, 1)
    const detail = workbenchQuery(ctx, store, { kind: 'roots.detail', context: { rootId: 'root-workbench' } })
    assert.equal(detail.data.root.rootId, 'root-workbench')
    assert.equal(detail.data.findings.length, 1)
    assert.equal(detail.data.context.assets, 1)
    const findings = workbenchQuery(ctx, store, { kind: 'findings.list', context: { rootId: 'root-workbench' } })
    assert.equal(findings.data.length, 1)
    assert.equal(findings.data[0].verificationState, 'needs-recheck')
    const assets = workbenchQuery(ctx, store, { kind: 'assets.list', context: { rootId: 'root-workbench' } })
    assert.equal(assets.data.some(row => row.kind === 'asset' && row.id === 'asset-1'), true)
    assert.equal(assets.data.find(row => row.kind === 'asset' && row.id === 'asset-1').relatedReceipts[0].id, 'receipt-asset')
    const globalAssets = workbenchQuery(ctx, store, { kind: 'assets.list', context: {}, page: { limit: 500 } })
    assert.equal(globalAssets.data.some(row => row.kind === 'material' && row.id === 'material-1'), true,
      'global assets/material view must include saved materials')
    const searchedMaterials = workbenchQuery(ctx, store, { kind: 'assets.list', context: {}, text: 'fixture.har', page: { limit: 500 } })
    assert.equal(searchedMaterials.data.some(row => row.kind === 'material' && row.id === 'material-1'), true,
      'global assets/material search must match the material file name')
    const graph = workbenchQuery(ctx, store, { kind: 'exploration.graph', context: { rootId: 'root-workbench' } })
    assert.equal(graph.data[0].nodes.some(node => node.kind === 'work'), true)
  })

  await test('queries include methods, roles and capability inventory without starting a model', async () => {
    const methods = workbenchQuery(ctx, store, { kind: 'methods.list', context: { rootId: 'root-workbench' } })
    assert.equal(methods.data.length >= 7, true)
    const roles = workbenchQuery(ctx, store, { kind: 'roles.list', context: { rootId: 'root-workbench' } })
    assert.equal(Array.isArray(roles.data), true)
    const capabilities = workbenchQuery(ctx, store, { kind: 'capabilities.list', context: { rootId: 'root-workbench' } })
    assert.equal(capabilities.data.some(row => row.name === 'redteam_execution'), true)
  })

  await test('commands are idempotent and pause/resume never resets the task policy', async () => {
    const commandId = 'cmd-workbench-pause-1'
    const paused = await workbenchCommand(ctx, store, { commandId, kind: 'root.pause', context: { rootId: 'root-workbench' }, payload: { reason: 'test' } })
    assert.equal(paused.ok, true)
    assert.equal(taskPolicyStatus(store, 'root-workbench').phase, 'waiting-info')
    const duplicate = await workbenchCommand(ctx, store, { commandId, kind: 'root.pause', context: { rootId: 'root-workbench' }, payload: { reason: 'test' } })
    assert.equal(duplicate.duplicate, true)
    const resumed = await workbenchCommand(ctx, store, { commandId: 'cmd-workbench-resume-1', kind: 'root.resume', context: { rootId: 'root-workbench' }, payload: {} })
    assert.equal(resumed.ok, true)
    const policy = taskPolicyStatus(store, 'root-workbench').policy
    assert.equal(policy.budget.toolCalls, 30)
    assert.equal(policy.used.toolCalls, 0)
  })

  await test('work.propose, work.guidance, scoped stop and role.define write real records', async () => {
    const proposed = await workbenchCommand(ctx, store, { kind: 'work.propose', context: { rootId: 'root-workbench' },
      payload: { question: '检查导出接口是否允许跨账号读取', target: 'https://app.workbench.test', assetIds: ['asset-1'],
        successCriterion: '有对照与差异。', falsifier: '共享对象能解释差异。' } })
    assert.equal(proposed.result.workId.startsWith('work-'), true)
    const guidance = await workbenchCommand(ctx, store, { kind: 'work.guidance', context: { rootId: 'root-workbench' },
      payload: { workRef: { id: proposed.result.workId }, instruction: '先确认 B 账号是否可登录' } })
    assert.equal(guidance.result.effectiveFrom, 'next-action')
    const stopped = await workbenchCommand(ctx, store, { kind: 'scope.stop', context: { rootId: 'root-workbench' },
      payload: { scopeKind: 'work', scopeId: proposed.result.workId, reason: 'test stop' } })
    assert.equal(stopped.result.controlState, 'stopped')
    const role = await workbenchCommand(ctx, store, { kind: 'role.define', context: { rootId: 'root-workbench' },
      payload: { title: '差异分析员', objective: '判断差异是否来自对象归属。', responsibilities: '读取正常与测试响应。',
        deliverable: '结论、依据和反证。' } })
    assert.equal(role.result.version, 1)
    const again = await workbenchCommand(ctx, store, { kind: 'role.define', context: { rootId: 'root-workbench' },
      payload: { title: '差异分析员', objective: '判断差异是否来自对象归属。', responsibilities: '读取正常与测试响应。',
        deliverable: '结论、依据和反证。' } })
    assert.equal(again.result.version, 1)
    const personal = await workbenchCommand(ctx, store, { kind: 'role.define', context: { rootId: '' },
      payload: { title: '个人复核员', objective: '只读复核已有证据。', responsibilities: '读取原件并给出反证。',
        deliverable: '结论与依据。' } })
    assert.equal(personal.result.role.scope, 'global')
    assert.equal(personal.result.roleId.startsWith('role-'), true)
  })

  await test('an explicitly continued stopped root advances the generation without resetting its limits', async () => {
    const current = taskPolicyStatus(store, 'root-workbench').policy
    const stopped = await workbenchCommand(ctx, store, { kind: 'scope.stop', context: { rootId: 'root-workbench', generation: 1 },
      payload: { scopeKind: 'root', reason: 'test stop before continue' } })
    assert.equal(stopped.ok, true)
    const continued = await workbenchCommand(ctx, store, { kind: 'root.continue', context: { rootId: 'root-workbench', generation: 1 },
      payload: { reason: 'explicit continue' } })
    assert.equal(continued.result.generation, 2)
    assert.equal(continued.result.policy.budget.toolCalls, current.budget.toolCalls)
    assert.equal(continued.result.policy.cancelled, false)
  })

  await test('role.resume goes through the role runtime admission instead of starting a new budget', async () => {
    let called = 0
    const resumed = await workbenchCommand(ctx, store, { kind: 'role.resume', context: { rootId: 'root-workbench' }, payload: { reason: 'queued work resumed' } }, {
      agentFor: () => ({ session: { id: 'root-workbench' } }),
      roleRuntime: { resumeQueued: async () => { called += 1; return { ok: true, resumed: true, childId: 'child-resumed' } } },
    })
    assert.equal(called, 1)
    assert.equal(resumed.result.resumed, true)
  })

  await test('two windows submitting the same commandId join one execution', async () => {
    let called = 0
    let release
    const gate = new Promise(resolve => { release = resolve })
    const services = {
      agentFor: () => ({ session: { id: 'root-workbench' } }),
      roleRuntime: {
        resumeQueued: async () => {
          called += 1
          await gate
          return { ok: true, resumed: true, childId: 'child-shared-command' }
        },
      },
    }
    const command = {
      commandId: 'cmd-shared-command',
      kind: 'role.resume',
      context: { rootId: 'root-workbench' },
      payload: { reason: 'two windows share one command' },
    }
    const first = workbenchCommand(ctx, store, command, services)
    const second = workbenchCommand(ctx, store, command, services)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(called, 1, 'the first window must own the only side effect')
    release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.result.resumed, true)
    assert.equal(b.result.resumed, true)
    assert.equal(a.commandId, 'cmd-shared-command')
    assert.equal(b.commandId, 'cmd-shared-command')
    assert.equal(called, 1, 'the second window must join the in-flight result')
  })

  if (failed) process.exitCode = 1
  console.log(failed ? `${failed} workbench test(s) failed` : 'all workbench tests passed')
} finally { store.close() }
