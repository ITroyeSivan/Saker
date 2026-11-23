import assert from 'node:assert/strict'
import { openStore, registerFinding } from '../plugins/dsh-redteam-results/lib/store.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { createWorkItem } from '../plugins/dsh-redteam-results/lib/role-orchestration.js'
import { workbenchQuery, workbenchCommand } from '../plugins/dsh-redteam-results/lib/workbench.js'
import { readModulePreference, writeModulePreference } from '../plugins/dsh-redteam-results/lib/test-module-registry.js'

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) }
}

const store = openStore(':memory:')
const rootId = 'wb-module-root'
startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://wb.module.test', budget: { toolCalls: 30, modelCalls: 20, workers: 2 } })
const work = createWorkItem(store, rootId, { question: '核对模块命令闭环', target: 'https://wb.module.test' }).work
const ctx = { agents: { get: () => null }, tools: { schemas: () => [] } }
const context = { rootId, generation: 1, sessionId: rootId, workspaceKey: 'w', projectKey: 'p' }

await test('查询：modules.list/detail 走 workbench.query', () => {
  const list = workbenchQuery(ctx, store, { kind: 'modules.list', context, filter: { text: '已知漏洞' }, page: { limit: 20 } })
  assert.equal(list.ok, true)
  assert.ok(list.data.items.some(item => item.id === 'nday-match'))
  assert.equal(list.data.taxonomy.primaryCategories.length, 7)
  const detail = workbenchQuery(ctx, store, { kind: 'modules.detail', context, moduleRef: { id: 'nday-match' } })
  assert.match(detail.data.instructions, /可独立调用/)
})

await test('查询：findings.detail 必须带 root+finding，空值不落到 SQLite', () => {
  const finding = registerFinding(store, rootId, 'pentest', {
    title: '工作台发现详情', summary: '真实详情查询', target: 'https://wb.module.test', severity: 'high',
  })
  const detail = workbenchQuery(ctx, store, { kind: 'findings.detail', context: { rootId, findingId: finding.id } })
  assert.equal(detail.data.findingId, finding.id)
  assert.equal(detail.data.title, '工作台发现详情')
  store.db.prepare('UPDATE findings SET evidence_refs=? WHERE session_id=? AND id=?')
    .run(JSON.stringify([{ kind: 'request', id: 'request-test-1' }]), rootId, finding.id)
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)')
    .run(rootId, 'execution-test-1', JSON.stringify({ id: 'execution-test-1', requestId: 'request-test-1', status: 200, completedAt: '2026-11-14T00:00:00.000Z', current: true, integrityValid: true }))
  const withReceipt = workbenchQuery(ctx, store, { kind: 'findings.detail', context: { rootId, findingId: finding.id } })
  assert.equal(withReceipt.data.receipts[0].id, 'execution-test-1')
  assert.equal(withReceipt.data.receipts[0].requestId, 'request-test-1')
  assert.throws(() => workbenchQuery(ctx, store, { kind: 'findings.detail', context: { rootId, findingId: '' } }), /findingId/)
  assert.throws(() => workbenchQuery(ctx, store, { kind: 'findings.detail', context: { rootId: '', findingId: finding.id } }), /rootId/)
})

await test('命令：module.define 产生本任务草稿并可查询；同 commandId 幂等', async () => {
  const payload = {
    commandId: 'cmd-define-1', kind: 'module.define', context,
    payload: { id: 'wb-local-module', title: '工作台专项', purpose: '核对工作台命令', instructions: '只用真实材料，缺材料输出 unknown。' },
  }
  const first = await workbenchCommand(ctx, store, payload)
  assert.equal(first.status, 'completed')
  assert.equal(first.result.moduleSnapshotRef.id, 'wb-local-module')
  const again = await workbenchCommand(ctx, store, payload)
  assert.equal(again.duplicate, true)
  const detail = workbenchQuery(ctx, store, { kind: 'modules.detail', context,
    moduleRef: first.result.moduleSnapshotRef })
  assert.equal(detail.data.title, '工作台专项')
})

await test('命令：module.begin 固定任务包，并可用 command.status 查询', async () => {
  const begun = await workbenchCommand(ctx, store, {
    commandId: 'cmd-begin-1', kind: 'module.begin', context,
    expected: { workRevision: work.revision },
    payload: { workRef: { id: work.workId, revision: work.revision }, moduleSnapshotRef: { id: 'nday-match', version: 1 }, operation: 'auto',
      inputRefs: [{ kind: 'component-fact', id: 'C1', revision: 1 }] },
  })
  assert.equal(begun.status, 'completed')
  assert.equal(begun.result.invocationRef.state, 'active')
  assert.match(begun.result.taskPack.instructions, /可独立调用/)
  const status = workbenchQuery(ctx, store, { kind: 'command.status', context, payload: { context }, commandId: 'cmd-begin-1' })
  assert.equal(status.data.status, 'completed')
  assert.equal(status.data.kind, 'module.begin')
})

await test('命令：module.finish 空产物拒绝，真实产物完成；错误调用不可 cancel', async () => {
  store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
    .run(context.rootId, 'material-workbench-1', 'https://module.fixture.test/workbench', 'digest-workbench',
      JSON.stringify({ name: 'workbench output', kind: 'material', text: '已有材料正文，用作工作台分析来源。' }))
  const active = workbenchQuery(ctx, store, { kind: 'modules.invocations.list', context, filter: { state: 'active' } }).data.items
  assert.equal(active.length, 1)
  const invocationRef = active[0].invocationRef
  await assert.rejects(() => workbenchCommand(ctx, store, {
    commandId: 'cmd-finish-empty', kind: 'module.finish', context,
    payload: { invocationRef, outcome: 'analysis-complete', outputRefs: [] },
  }), error => error.code === 'OUTPUT_CONTRACT_UNSATISFIED'
    && Boolean(error.details?.allowed?.artifactRefs?.length)
    && Boolean(error.details?.missing?.length))
  await assert.rejects(() => workbenchCommand(ctx, store, {
    commandId: 'cmd-finish-missing', kind: 'module.finish', context,
    payload: { invocationRef, outcome: 'verification-observed', outputRefs: [{ kind: 'receipt', id: 'does-not-exist' }] },
  }), /不存在|不属于当前任务/)
  const finished = await workbenchCommand(ctx, store, {
    commandId: 'cmd-finish-1', kind: 'module.finish', context,
    payload: { invocationRef, outcome: 'analysis-complete', outputRefs: [
      { kind: 'material', id: 'material-workbench-1', revision: 1 },
      {
      kind: 'artifact',
      artifact: { kind: 'analysis', title: '工作台组件结论',
        detail: '基于当前输入形成结构化分析；不把版本命中当成漏洞。',
        sourceRefs: [{ kind: 'material', id: 'material-workbench-1' }] },
      },
    ] },
  })
  assert.equal(finished.result.invocationRef.state, 'completed')
  assert.equal(finished.result.validation.productStatus, 'satisfied')
  assert.equal(store.db.prepare('SELECT state FROM role_work_items WHERE session_id=? AND work_id=?').get(rootId, work.workId).state, 'completed',
    'module completion advances the associated work item when no sibling invocation is still active')
  const detail = workbenchQuery(ctx, store, { kind: 'modules.invocations.detail', context, invocationId: invocationRef.id })
  assert.equal(detail.data.state, 'completed')
  await assert.rejects(() => workbenchCommand(ctx, store, {
    commandId: 'cmd-cancel-done', kind: 'module.cancel', context,
    payload: { invocationRef: finished.result.invocationRef, reason: 'late cancel' },
  }), /已结束/)
})

await test('命令：module.prefer 在没有 root 的会话也能保存下一项偏好', async () => {
  const saved = await workbenchCommand(ctx, store, {
    commandId: 'cmd-prefer-noroot', kind: 'module.prefer',
    context: { sessionId: 'session-noroot', workspaceKey: 'w', projectKey: 'p' },
    payload: { moduleSnapshotRef: { id: 'web-liveness', version: 1 }, operation: 'auto', sessionRef: 'session-noroot' },
  })
  assert.equal(saved.status, 'completed')
  assert.equal(saved.result.preferenceRevision, 1)
  const row = readModulePreference(store, { hostSession: 'session-noroot', workspaceKey: 'w', projectKey: 'p' })
  assert.equal(row.revision, 1)
  assert.equal(row.state, 'pending')
})

await test('命令：begin 未显式指定模块时消费下一项偏好并绑定', async () => {
  writeModulePreference(store, {
    hostSession: rootId, workspaceKey: 'w', projectKey: 'p',
    moduleSnapshotRef: { id: 'web-liveness', version: 1 }, operation: 'auto',
  }, { expectedRevision: 0 })
  const work2 = createWorkItem(store, rootId, { question: '偏好消费验证', target: 'https://wb.module.test/2' }).work
  const begun = await workbenchCommand(ctx, store, {
    commandId: 'cmd-begin-pref', kind: 'module.begin', context,
    expected: { workRevision: work2.revision },
    payload: { workRef: { id: work2.workId, revision: work2.revision } },
  })
  assert.equal(begun.result.taskPack.moduleRef.id, 'web-liveness')
  assert.equal(begun.result.consumedPreference.workId, work2.workId)
  const pref = readModulePreference(store, { hostSession: rootId, workspaceKey: 'w', projectKey: 'p' })
  assert.equal(pref.state, 'bound')
  assert.equal(pref.bound_work_ref, work2.workId)
})

await test('负例：未知查询拒绝；command.status 跨根拒绝', async () => {
  assert.throws(() => workbenchQuery(ctx, store, { kind: 'no.such.query', context }), /unknown workbench query/)
  assert.throws(() => workbenchQuery(ctx, store, {
    kind: 'command.status', context: { rootId: 'other-root', generation: 1, sessionId: rootId },
    payload: { context: { rootId: 'other-root', generation: 1, sessionId: rootId } }, commandId: 'cmd-begin-1',
  }), /不属于当前范围/)
})

store.db.close()
console.log(failed ? `\n${failed} failed` : '\nall workbench module tests passed')
process.exit(failed ? 1 : 0)
