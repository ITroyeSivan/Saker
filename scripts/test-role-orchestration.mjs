import assert from 'node:assert/strict'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { readTaskContext, saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { startTaskPolicy, taskPolicyStatus, updateTaskProgress } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { workbenchCommand, workbenchQuery } from '../plugins/dsh-redteam-results/lib/workbench.js'
import { createSiteWorkers, siteWorkerParent, siteWorkerRows } from '../plugins/dsh-redteam-results/lib/site-workers.js'
import {
  createRoleSpec,
  createWorkItem,
  createRoleOrchestrator,
  listRoleQueue,
  readRoleInstance,
  readRoleSpec,
  readWorkItem,
  reconcileOrphanedRoles,
  roleStatus,
  updateWorkItem,
} from '../plugins/dsh-redteam-results/lib/role-orchestration.js'
import { reconcileOrphanedSiteWorkers } from '../plugins/dsh-redteam-results/lib/site-workers.js'

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) }
}

function fixture(store, rootId = 'role-root', workers = 2) {
  startTaskPolicy(store, rootId, {
    mode: 'regular', target: 'https://app.fixture.test',
    budget: { toolCalls: 30, modelCalls: 20, workers },
  })
  saveTaskContext(store, rootId, {
    assets: [{ id: 'asset-app', url: 'https://app.fixture.test', inScope: true, reachable: true }],
    requests: [], checks: [], methods: [], maxSupplementAttempts: 2,
  })
  const children = new Map(), starts = [], sends = [], hooks = new Map(), failures = new Set()
  const ctx = {
    on(name, fn) { hooks.set(name, fn) },
    logger: { warn() {}, info() {}, error() {} },
    subagents: {
      async startActivation(spec) {
        starts.push(spec)
        const child = { session: { id: spec.childId, header: { agentPreset: 'pentest' } } }
        children.set(spec.childId, child)
        return {
          childId: spec.childId,
          result: new Promise(() => {}),
          dispose: async () => {
            if (failures.has(spec.childId)) {
              failures.delete(spec.childId)
              throw new Error('fixture native release failure')
            }
            children.delete(spec.childId)
          },
        }
      },
      async sendMessage(sender, to, parts, options) {
        const messageId = 'host-msg-' + (sends.length + 1)
        sends.push({ sender: sender?.session?.id, to, text: parts?.map(part => part.text).join('\n'), options, messageId })
        return messageId
      },
      async drainChildren(_parent, ids) { for (const id of ids) children.delete(id) },
      listDescendants() { return [...children.keys()].map(id => ({ id, kind: 'agent' })) },
    },
    agents: { get(id) { return children.get(id) } },
    tools: {
      schemas: () => ['read', 'grep', 'pwsh', 'redteam_execution', 'saker_material', 'saker_role', 'saker_assist', 'redteam_task']
        .map(name => ({ name })),
    },
  }
  const manager = createSiteWorkers(ctx, () => store)
  const roles = createRoleOrchestrator({
    ctx, getStore: () => store, siteWorkers: manager,
    taskStatus: taskPolicyStatus, siteParent: siteWorkerParent,
  })
  const root = {
    session: { id: rootId, header: { agentPreset: 'pentest' } },
    ctx: { tools: { schemas: () => ctx.tools.schemas() } },
  }
  return { ctx, manager, roles, root, children, starts, sends, hooks, failures }
}

const roleInput = {
  title: '导出权限审查员',
  objective: '判断当前导出接口是否允许账号读取其他账号的数据。',
  responsibilities: '读取现有请求与账号材料，建立正常对照，提出最小跨账号请求，区分缓存、空响应和共享对象。',
  deliverable: '返回正常对照、异常对照、原始回执、结论和未覆盖范围。',
  capabilities: ['http-replay', 'identity-comparison'],
  tools: ['read', 'redteam_execution', 'saker_material', 'saker_role'],
  model: { provider: 'fixture', model: 'role-model', reasoningEffort: 'low' },
}
const workInput = {
  title: 'A 账号能否读取 B 账号的导出记录',
  question: '比较两个账号对同一导出接口的结果，确认对象归属是否能被跨账号读取。',
  target: 'https://app.fixture.test',
  assetIds: ['asset-app'],
  identityRef: 'account-a',
  normalControl: 'A 读取自己的导出记录',
  successCriterion: 'A 使用自己的凭据读取到 B 的可识别数据，并有正常对照。',
  falsifier: '权限拒绝、空壳响应或共享对象能够解释差异。',
}

await test('a role version is immutable and identical retries are idempotent', async () => {
  const store = openStore(':memory:')
  try {
    const base = {
      roleId: 'role-immutable', title: '导出审查员', scope: 'root',
      objective: 'first objective', responsibilities: 'read the request and compare owners',
      deliverable: 'facts, controls, gaps', capabilities: ['http-replay'],
    }
    const first = createRoleSpec(store, 'role-immutable-root', { ...base, version: 1 })
    const retry = createRoleSpec(store, 'role-immutable-root', { ...base, version: 1 })
    assert.equal(retry.duplicate, true)
    assert.equal(retry.role.digest, first.role.digest)
    assert.equal(retry.role.objective, 'first objective')
    assert.throws(
      () => createRoleSpec(store, 'role-immutable-root', { ...base, objective: 'replacement objective', version: 1 }),
      /already exists with different execution content/,
    )
    const second = createRoleSpec(store, 'role-immutable-root', { ...base, objective: 'replacement objective', version: 2 })
    assert.equal(second.role.version, 2)
    assert.equal(readRoleSpec(store, 'role-immutable-root', 'role-immutable', 1).objective, 'first objective')
  } finally { store.close() }
})

await test('a work item rejects stale revisions and cannot be reopened after stop', async () => {
  const store = openStore(':memory:')
  try {
    const work = createWorkItem(store, 'role-cas-root', { question: 'Check whether account A can export account B records.' }).work
    assert.throws(
      () => updateWorkItem(store, 'role-cas-root', work.workId, { expectedRevision: 99, state: 'active' }),
      /work revision conflict/,
    )
    const active = updateWorkItem(store, 'role-cas-root', work.workId, { expectedRevision: 1, state: 'active' })
    const stopped = updateWorkItem(store, 'role-cas-root', work.workId, { expectedRevision: active.revision, state: 'stopped' })
    assert.equal(stopped.state, 'stopped')
    assert.throws(
      () => updateWorkItem(store, 'role-cas-root', work.workId, { expectedRevision: stopped.revision, state: 'active' }),
      /cannot be reopened/,
    )
    assert.equal(readWorkItem(store, 'role-cas-root', work.workId).state, 'stopped')
  } finally { store.close() }
})

await test('a model-defined non-preset role reaches the first Host request with its own brief and work', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store)
  try {
    const result = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
    assert.equal(result.ok, true)
    assert.equal(result.queued, false)
    assert.equal(fx.starts.length, 1)
    const prompt = fx.starts[0].request.prompt.map(part => part.text).join('\n')
    assert.match(prompt, /Dynamic role: 导出权限审查员 v1/)
    assert.match(prompt, /Role responsibilities: 读取现有请求与账号材料/)
    assert.match(prompt, /Work item: work-/)
    assert.match(prompt, /Logical parent: root \(depth 1\)/)
    assert.equal(fx.starts[0].request.agentOptions.model, 'role-model')
    const row = siteWorkerRows(store, 'role-root').find(item => item.childId === result.childId)
    assert.equal(row.role.title, '导出权限审查员')
    const status = roleStatus(store, 'role-root')
    assert.equal(status.roles.length, 1)
    assert.equal(status.workItems[0].state, 'active')
    assert.equal(status.instances[0].roleTitle, '导出权限审查员')
    assert.equal(status.attempts.length, 1)
  } finally { await fx.manager.dispose(); store.close() }
})

await test('a parent receipt referenced by the copied context is carried into the child once', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'role-receipt', 2)
  try {
    const receipt = {
      id: 'receipt-role-1',
      request: 'GET /version HTTP/1.1\r\nHost: app.fixture.test\r\n\r\n',
      responseHead: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2',
      responseBodyBase64: Buffer.from('ok').toString('base64'),
      status: 200,
    }
    store.db.prepare('INSERT INTO execution_receipts (session_id,id,record) VALUES (?,?,?)')
      .run('role-receipt', receipt.id, JSON.stringify(receipt))
    saveTaskContext(store, 'role-receipt', {
      assets: [{ id: 'asset-app', url: 'https://app.fixture.test', inScope: true, reachable: true }],
      requests: [{ id: 'req-version', revision: 'r1', endpoint: 'https://app.fixture.test/version',
        authContext: 'account-a', valid: true, responseReceiptId: receipt.id }],
      checks: [], methods: [], maxSupplementAttempts: 2,
    })
    const started = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
    assert.equal(started.ok, true)
    const child = readTaskContext(store, started.childId)
    assert.equal(child.requests.length, 1)
    assert.equal(child.requests[0].responseReceiptId, receipt.id)
    assert.match(child.requests[0].response, /ok$/)
    const copied = store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?')
      .get(started.childId, receipt.id)
    assert(copied, 'child session can resolve the referenced receipt')
    assert.deepEqual(JSON.parse(copied.record), receipt)
  } finally { await fx.manager.dispose(); store.close() }
})

await test('a missing referenced receipt fails with a concrete recovery path, not a retry loop', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'role-receipt-missing', 2)
  try {
    const receipt = {
      id: 'receipt-role-gone',
      request: 'GET /version HTTP/1.1\r\nHost: app.fixture.test\r\n\r\n',
      responseHead: 'HTTP/1.1 200 OK\r\nContent-Length: 2',
      responseBodyBase64: Buffer.from('ok').toString('base64'),
      status: 200,
    }
    store.db.prepare('INSERT INTO execution_receipts (session_id,id,record) VALUES (?,?,?)')
      .run('role-receipt-missing', receipt.id, JSON.stringify(receipt))
    saveTaskContext(store, 'role-receipt-missing', {
      assets: [{ id: 'asset-app', url: 'https://app.fixture.test', inScope: true, reachable: true }],
      requests: [{ id: 'req-version', revision: 'r1', endpoint: 'https://app.fixture.test/version',
        authContext: 'account-a', valid: true, responseReceiptId: receipt.id }],
      checks: [], methods: [], maxSupplementAttempts: 2,
    })
    store.db.prepare('DELETE FROM execution_receipts WHERE session_id=? AND id=?').run('role-receipt-missing', receipt.id)
    const error = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
      .then(() => null, reason => reason)
    assert(error, 'missing receipt must not be silently dropped')
    assert.match(String(error.message), /父任务上下文引用的执行回执/)
    assert.match(String(error.message), /不要原样重试/)
    assert.equal(fx.starts.length, 0, 'no child Host request before the issue is resolved')
  } finally { await fx.manager.dispose(); store.close() }
})

await test('a root can propose a child role/work, queue at the same root limit, and resume after release', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'role-queue', 1)
  try {
    const first = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
    const child = fx.children.get(first.childId)
    assert(child, 'child activation exists')
    const proposed = await fx.roles.propose(child, {
      role: { ...roleInput, title: '证据反证审查员', objective: '专门寻找会否定当前结论的解释。' },
      work: { ...workInput, parentWorkId: first.work.workId, title: '反证检查', question: '找出缓存和共享对象解释。' },
    })
    assert.equal(proposed.status, 'proposed')
    assert.equal(proposed.work.logicalParent, first.childId)
    const queued = await fx.roles.start(fx.root, {
      roleId: proposed.role.roleId, roleVersion: proposed.role.version,
      workId: proposed.work.workId, logicalParent: first.childId,
    }, new AbortController().signal)
    assert.equal(queued.queued, true)
    assert.equal(fx.starts.length, 1)
    assert.equal(queued.instance, undefined)
    assert.equal(queued.childId, undefined)
    assert.equal(queued.queue.generation, 1)
    assert.equal(listRoleQueue(store, 'role-queue').find(item => item.queueId === queued.queueRef.id).state, 'queued')
    await fx.roles.stop(fx.root, { instanceId: first.childId, reason: 'hand off' }, new AbortController().signal)
    const resumed = await fx.roles.resumeQueued(fx.root, {}, new AbortController().signal)
    assert.equal(resumed.resumed, true)
    assert.equal(listRoleQueue(store, 'role-queue').find(item => item.queueId === queued.queueRef.id).state, 'resumed')
    assert.equal(fx.starts.length, 2)
    const resumePrompt = fx.starts[1].request.prompt.map(part => part.text).join('\n')
    assert.match(resumePrompt, /Handoff context:/)
    assert.match(resumePrompt, /parent work:/)
    assert.equal(readWorkItem(store, 'role-queue', proposed.work.workId).state, 'active')
  } finally { await fx.manager.dispose(); store.close() }
})

await test('queued role is a durable request with the actual generation and no fake Host child id', async () => {
  const store = openStore(':memory:')
  try {
    startTaskPolicy(store, 'role-gen2', { mode: 'regular', budget: { workers: 1 } })
    updateTaskProgress(store, 'role-gen2', { cancelled: true })
    const continued = await workbenchCommand({}, store, {
      commandId: 'cmd-role-gen2', kind: 'root.continue',
      context: { rootId: 'role-gen2', sessionId: 'role-gen2', generation: 1 },
      payload: { reason: 'generation two' },
    })
    assert.equal(continued.result.generation, 2)
    let hostSpawns = 0
    const roles = createRoleOrchestrator({
      ctx: {}, getStore: () => store, siteParent: () => '',
      taskStatus: () => ({ configured: true, stopped: false, policy: { workerLimit: 1 } }),
      siteWorkers: {
        status: async () => ({ active: 1 }),
        assist: async () => { hostSpawns += 1; throw new Error('should not spawn') },
      },
    })
    const queued = await roles.start({ session: { id: 'role-gen2' } }, {
      role: { title: 'Generation two analyst', objective: 'Check one fact', responsibilities: 'One bounded question', deliverable: 'Evidence refs' },
      work: { title: 'Generation two work', question: 'Check one owned object' },
    }, new AbortController().signal)
    assert.equal(queued.queued, true)
    assert.equal(hostSpawns, 0)
    assert.equal(queued.instance, undefined)
    assert.equal(queued.childId, undefined)
    assert.equal(queued.queue.generation, 2)
    assert.equal(queued.queueRef.generation, 2)
    assert.equal(queued.queue.queueId.startsWith('role-queue-'), true)
  } finally { store.db.close() }
})

await test('messages are persistent, idempotent and can carry a handoff without waking twice', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'role-msg', 2)
  try {
    const first = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
    const second = await fx.roles.start(fx.root, {
      role: { ...roleInput, title: '交接执行员' },
      work: { ...workInput, title: '接手验证', question: '从现有材料继续验证同一导出问题。' },
    }, new AbortController().signal)
    const message = {
      messageId: 'handoff-1', fromInstance: first.childId, toInstance: second.childId,
      kind: 'handoff', workId: second.work.workId, materialRefs: ['request-a', 'receipt-a'],
      sourceRevision: 'r1', message: '已试过正常对照；请从跨账号差分继续。',
    }
    const sent = await fx.roles.message(fx.root, message, new AbortController().signal)
    assert.equal(sent.ok, true)
    const duplicate = await fx.roles.message(fx.root, message, new AbortController().signal)
    assert.equal(duplicate.duplicate, true)
    assert.equal(fx.sends.length, 1, 'duplicate message must not send again')
    const status = roleStatus(store, 'role-msg')
    assert.equal(status.messages.length, 1)
    assert.equal(status.messages[0].kind, 'handoff')
    assert.deepEqual(status.messages[0].materialRefs, ['request-a', 'receipt-a'])
    const childMessage = {
      messageId: 'child-steer-1', fromInstance: first.childId, toInstance: second.childId,
      kind: 'evidence', message: '这是第一项证据，请不要重复采集。',
    }
    await fx.roles.message(fx.children.get(first.childId), childMessage, new AbortController().signal)
    assert.equal(fx.sends.length, 2)
    assert.equal(fx.sends[1].sender, first.childId)
    const byInstanceId = await fx.roles.message(fx.root, {
      messageId: 'alias-instance-1', instanceId: second.childId, message: '按实例 ID 投递。',
    }, new AbortController().signal)
    assert.equal(byInstanceId.ok, true)
    const byWorkId = await fx.roles.message(fx.root, {
      messageId: 'alias-work-1', workId: second.work.workId, message: '按工作 ID 投递。',
    }, new AbortController().signal)
    assert.equal(byWorkId.ok, true)
    assert.equal(fx.sends.length, 4)
  } finally { await fx.manager.dispose(); store.close() }
})

await test('stopping an instance does not revive it and only releases the root slot after host settlement', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'role-stop', 1)
  try {
    const started = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
    const stopped = await fx.roles.stop(fx.root, { instanceId: started.childId, reason: 'user stopped' }, new AbortController().signal)
    assert.equal(stopped.ok, true)
    assert.equal(readRoleInstance(store, 'role-stop', started.childId).state, 'stopped')
    assert.equal(readWorkItem(store, 'role-stop', started.work.workId).state, 'stopped')
    assert.equal(fx.children.has(started.childId), false)
    const againStop = await fx.roles.stop(fx.root, { instanceId: started.childId, reason: 'repeat stop' }, new AbortController().signal)
    assert.equal(againStop.ok, true)
    assert.equal(againStop.stopped.length, 0)
    assert.equal(againStop.alreadyCompleted, true)
    assert.equal(againStop.already[0].childId, started.childId)
    const again = await fx.roles.message(fx.root, {
      messageId: 'late', toInstance: started.childId, message: 'must not revive',
    }, new AbortController().signal).catch(error => error)
    assert.match(String(again), /not active|not found/)
  } finally { await fx.manager.dispose(); store.close() }
})

await test('F01a completed business work still stops the live Host child', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'role-f01a', 1)
  try {
    const started = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
    updateWorkItem(store, 'role-f01a', started.work.workId, { state: 'completed' }, 'fixture-business-complete')
    assert.equal(fx.children.has(started.childId), true)
    const stopped = await fx.roles.stop(fx.root, { instanceId: started.childId, reason: 'stop live child after business completion' }, new AbortController().signal)
    assert.equal(stopped.ok, true)
    assert.equal(stopped.stopped.length, 1)
    assert.equal(stopped.pending.length, 0)
    assert.equal(stopped.alreadyCompleted, false)
    assert.equal(fx.children.has(started.childId), false)
    const instance = readRoleInstance(store, 'role-f01a', started.childId)
    assert.equal(instance.state, 'stopped')
    assert.equal(instance.releaseState, 'released')
    const work = readWorkItem(store, 'role-f01a', started.work.workId)
    assert.equal(work.state, 'completed')
    assert.equal(work.executionState, 'stopped')
    assert.equal(work.releaseState, 'released')
  } finally { await fx.manager.dispose(); store.close() }
})

await test('F01b failed Host release is retried with a new attempt instead of alreadyCompleted', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'role-f01b', 1)
  try {
    const started = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
    fx.failures.add(started.childId)
    const first = await fx.roles.stop(fx.root, { instanceId: started.childId, reason: 'first release attempt' }, new AbortController().signal)
    assert.equal(first.ok, false)
    assert.equal(first.stopped.length, 0)
    assert.equal(first.pending.length, 1)
    assert.equal(first.alreadyCompleted, false)
    assert.equal(fx.children.has(started.childId), true)
    const failed = readRoleInstance(store, 'role-f01b', started.childId)
    assert.equal(failed.state, 'cleanup-failed')
    assert.equal(failed.releaseState, 'cleanup-failed')
    assert.equal(failed.releaseAttempt, 1)
    await assert.rejects(
      () => fx.roles.start(fx.root, { roleId: started.role.roleId, workId: started.work.workId }, new AbortController().signal),
      /release is cleanup-failed|resolve the existing stop/
    )
    const second = await fx.roles.stop(fx.root, { instanceId: started.childId, reason: 'retry release attempt' }, new AbortController().signal)
    assert.equal(second.ok, true)
    assert.equal(second.stopped.length, 1)
    assert.equal(second.pending.length, 0)
    assert.equal(fx.children.has(started.childId), false)
    const released = readRoleInstance(store, 'role-f01b', started.childId)
    assert.equal(released.state, 'stopped')
    assert.equal(released.releaseState, 'released')
    assert.equal(released.releaseAttempt, 2)
  } finally { await fx.manager.dispose(); store.close() }
})

await test('a released or reconciled worker settles the role, work and attempt instead of staying active', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'role-settle', 2)
  try {
    const started = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
    const row = siteWorkerRows(store, 'role-settle').find(item => item.childId === started.childId)
    row.report = { state: 'completed', summary: 'child finished' }
    store.db.prepare('UPDATE site_workers SET record=? WHERE child_id=?').run(JSON.stringify(row), started.childId)
    fx.roles.settleWorker(row, 'released')
    assert.equal(readRoleInstance(store, 'role-settle', started.childId).state, 'completed')
    assert.equal(readWorkItem(store, 'role-settle', started.work.workId).state, 'completed')
    assert.equal(roleStatus(store, 'role-settle').attempts[0].state, 'completed')
  } finally { await fx.manager.dispose(); store.close() }
})

await test('restart reconciliation marks missing active children unknown and leaves queued work queued', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'role-restart', 2)
  try {
    const first = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
    const second = await fx.roles.start(fx.root, {
      role: { ...roleInput, title: '第二执行员' },
      work: { ...workInput, title: '第二工作', question: '并行检查同一导出接口。' },
    }, new AbortController().signal)
    const queued = await fx.roles.start(fx.root, {
      role: { ...roleInput, title: '排队执行员' },
      work: { ...workInput, title: '排队工作', question: '等待前两个释放后再检查。' },
    }, new AbortController().signal)
    assert.equal(first.queued, false)
    assert.equal(second.queued, false)
    assert.equal(queued.queued, true)

    const roles = reconcileOrphanedRoles(store, 'role-restart', () => false)
    assert.equal(roles.changed, 2)
    for (const started of [first, second]) {
      const instance = readRoleInstance(store, 'role-restart', started.childId)
      assert.equal(instance.state, 'stopped')
      assert.equal(instance.cleanupState, 'unknown')
      assert.match(instance.error, /no automatic replay/)
      assert.equal(readWorkItem(store, 'role-restart', started.work.workId).state, 'blocked')
    }
    assert.equal(queued.instance, undefined)
    assert.equal(listRoleQueue(store, 'role-restart').find(item => item.queueId === queued.queueRef.id).state, 'queued')
    assert.equal(readWorkItem(store, 'role-restart', queued.work.workId).state, 'queued')
    const workers = reconcileOrphanedSiteWorkers(store, 'role-restart', () => false)
    assert.equal(workers.changed, 2)
    for (const row of siteWorkerRows(store, 'role-restart')) {
      assert.equal(row.state, 'cleanup-failed')
      assert.match(row.error, /cleanup unconfirmed/)
    }
  } finally { await fx.manager.dispose(); store.close() }
})

await test('restart reconciliation leaves a genuinely running child untouched', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'role-live', 2)
  try {
    const started = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
    const roles = reconcileOrphanedRoles(store, 'role-live', () => true)
    assert.equal(roles.changed, 0)
    assert.equal(readRoleInstance(store, 'role-live', started.childId).state, 'active')
    assert.equal(readWorkItem(store, 'role-live', started.work.workId).state, 'active')
    const workers = reconcileOrphanedSiteWorkers(store, 'role-live', () => true)
    assert.equal(workers.changed, 0)
    assert.equal(siteWorkerRows(store, 'role-live')[0].state, 'running')
  } finally { await fx.manager.dispose(); store.close() }
})

await test('a late release event from an older generation cannot close the current root state', async () => {
  const store = openStore(':memory:')
  const fx = fixture(store, 'role-late-generation', 2)
  try {
    const started = await fx.roles.start(fx.root, { role: roleInput, work: workInput }, new AbortController().signal)
    const before = readRoleInstance(store, 'role-late-generation', started.childId)
    store.db.prepare('INSERT INTO task_rounds(session_id,started_at,record) VALUES(?,?,?)')
      .run('role-late-generation', Date.now(), JSON.stringify({ reason: 'new generation' }))
    const worker = siteWorkerRows(store, 'role-late-generation').find(item => item.childId === started.childId)
    worker.state = 'released'
    worker.report = { state: 'completed', summary: 'late old activation' }
    store.db.prepare('UPDATE site_workers SET record=? WHERE child_id=?').run(JSON.stringify(worker), started.childId)
    const settled = fx.roles.settleWorker(worker, 'released')
    const after = readRoleInstance(store, 'role-late-generation', started.childId)
    assert.equal(settled.state, 'active')
    assert.equal(after.state, 'active')
    assert.equal(after.releaseState, 'unreleased')
    assert.equal(after.updatedAt, before.updatedAt)
    const reconcile = await workbenchCommand({}, store, {
      commandId: 'cmd-role-late-generation-reconcile',
      kind: 'roles.reconcile',
      context: { rootId: 'role-late-generation', sessionId: 'role-late-generation', generation: 2 },
      payload: {},
    })
    assert.equal(reconcile.result.changed, 0)
    assert.equal(reconcile.result.skipped[0].reason, 'generation-mismatch')
  } finally { await fx.manager.dispose(); store.close() }
})

await test('M02：详情与角色快照五类状态均纯读，释放对账只在显式生命周期执行', async () => {
  const store = openStore(':memory:')
  const managers = []
  const make = async rootId => {
    const fx = fixture(store, rootId, 2)
    managers.push(fx.manager)
    return fx
  }
  const changes = () => store.db.prepare('SELECT total_changes() n').get().n
  const readAll = rootId => {
    workbenchQuery({}, store, { kind: 'roots.detail', context: { rootId } })
    workbenchQuery({}, store, { kind: 'roles.list', context: { rootId } })
    roleStatus(store, rootId)
  }
  try {
    await make('role-read-empty')
    let before = changes()
    readAll('role-read-empty')
    assert.equal(changes(), before, 'no-role reads must not write')

    const active = await make('role-read-active')
    const activeStart = await active.roles.start(active.root, { role: roleInput, work: workInput }, new AbortController().signal)
    before = changes()
    readAll('role-read-active')
    assert.equal(changes(), before, 'active-role reads must not write')
    assert.equal(readRoleInstance(store, 'role-read-active', activeStart.childId).state, 'active')

    const released = await make('role-read-released')
    const releasedStart = await released.roles.start(released.root, { role: roleInput, work: workInput }, new AbortController().signal)
    const releasedWorker = siteWorkerRows(store, 'role-read-released').find(item => item.childId === releasedStart.childId)
    releasedWorker.state = 'released'
    releasedWorker.report = { state: 'completed', summary: 'controlled release' }
    store.db.prepare('UPDATE site_workers SET record=? WHERE child_id=?').run(JSON.stringify(releasedWorker), releasedStart.childId)
    before = changes()
    readAll('role-read-released')
    const pendingSnapshot = roleStatus(store, 'role-read-released')
    assert.equal(changes(), before, 'released-pending reads must not reconcile or write')
    assert.equal(pendingSnapshot.instances[0].state, 'active')
    assert.equal(pendingSnapshot.instances[0].settlement.status, 'pending-settlement')
    assert.match(pendingSnapshot.workItems[0].settlement.label, /待对账/)
    const reconciled = await workbenchCommand({}, store, {
      commandId: 'cmd-role-reconcile-1', kind: 'roles.reconcile',
      context: { rootId: 'role-read-released', sessionId: 'role-read-released', generation: 1 }, payload: {},
    })
    assert.equal(reconciled.result.changed, 1)
    assert.equal(readRoleInstance(store, 'role-read-released', releasedStart.childId).state, 'completed')
    assert.equal(readWorkItem(store, 'role-read-released', releasedStart.work.workId).state, 'completed')
    const completedRevision = readWorkItem(store, 'role-read-released', releasedStart.work.workId).revision
    assert.equal((await workbenchCommand({}, store, {
      commandId: 'cmd-role-reconcile-2', kind: 'roles.reconcile',
      context: { rootId: 'role-read-released', sessionId: 'role-read-released', generation: 1 }, payload: {},
    })).result.changed, 0)
    assert.equal(readWorkItem(store, 'role-read-released', releasedStart.work.workId).revision, completedRevision,
      'repeated release events must not advance terminal revision')

    const failed = await make('role-read-failed')
    const failedStart = await failed.roles.start(failed.root, { role: roleInput, work: workInput }, new AbortController().signal)
    const failedWorker = siteWorkerRows(store, 'role-read-failed').find(item => item.childId === failedStart.childId)
    failedWorker.state = 'cleanup-failed'
    store.db.prepare('UPDATE site_workers SET record=? WHERE child_id=?').run(JSON.stringify(failedWorker), failedStart.childId)
    before = changes()
    readAll('role-read-failed')
    const failedSnapshot = roleStatus(store, 'role-read-failed')
    assert.equal(changes(), before, 'cleanup-failed reads must not write')
    assert.equal(failedSnapshot.instances[0].settlement.status, 'pending-settlement')
    assert.equal(failedSnapshot.instances[0].settlement.observedWorkerState, 'cleanup-failed')
    assert.equal((await workbenchCommand({}, store, {
      commandId: 'cmd-role-reconcile-failed', kind: 'roles.reconcile',
      context: { rootId: 'role-read-failed', sessionId: 'role-read-failed', generation: 1 }, payload: {},
    })).result.changed, 1)
    assert.equal(readRoleInstance(store, 'role-read-failed', failedStart.childId).state, 'cleanup-failed')

    const stale = await make('role-read-stale')
    const staleStart = await stale.roles.start(stale.root, { role: roleInput, work: workInput }, new AbortController().signal)
    const staleInstance = readRoleInstance(store, 'role-read-stale', staleStart.childId)
    store.db.prepare('UPDATE role_instances SET generation=?,record=? WHERE session_id=? AND child_id=?')
      .run(2, JSON.stringify({ ...staleInstance, generation: 2 }), 'role-read-stale', staleStart.childId)
    const staleWorker = siteWorkerRows(store, 'role-read-stale').find(item => item.childId === staleStart.childId)
    staleWorker.state = 'released'
    store.db.prepare('UPDATE site_workers SET record=? WHERE child_id=?').run(JSON.stringify(staleWorker), staleStart.childId)
    before = changes()
    readAll('role-read-stale')
    const staleSnapshot = roleStatus(store, 'role-read-stale')
    assert.equal(changes(), before, 'cross-generation reads must not write')
    assert.equal(staleSnapshot.instances[0].settlement.status, 'stale-release')
    assert.match(staleSnapshot.instances[0].settlement.label, /旧代/)
    const staleResult = await workbenchCommand({}, store, {
      commandId: 'cmd-role-reconcile-stale', kind: 'roles.reconcile',
      context: { rootId: 'role-read-stale', sessionId: 'role-read-stale', generation: 2 }, payload: {},
    })
    assert.equal(staleResult.result.changed, 0)
    assert.equal(staleResult.result.skipped[0].reason, 'generation-mismatch')
    assert.equal(readRoleInstance(store, 'role-read-stale', staleStart.childId).state, 'active')
  } finally {
    for (const manager of managers) await manager.dispose()
    store.close()
  }
})

if (failed) process.exitCode = 1
console.log(failed ? `${failed} failed` : 'all role orchestration tests passed')
