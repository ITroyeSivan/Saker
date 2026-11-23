// I3：模型用量按账本归属、轮次和稳定调用 ID 对账；未知保持可见。
import './test-stub-register.mjs'
import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { startTaskPolicy, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { workbenchQuery } from '../plugins/dsh-redteam-results/lib/workbench.js'
import { modelBudgetOverview } from '../plugins/dsh-redteam-results/lib/model-budget.js'

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}
const store = openStore(':memory:')

function saveCall(root, roundAt, id, record) {
  record = { reservedTokens: 0, ...record }
  store.db.prepare('INSERT INTO task_model_calls(id,root_session,round_at,session_id,state,record) VALUES(?,?,?,?,?,?)')
    .run(id, root, roundAt, record.sessionId || root, record.state, JSON.stringify({ id, root, roundAt, ...record }))
}
const usage = { inputTokens: 2, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 1, totalTokens: 11 }

try {
  startTaskPolicy(store, 'usage-root', { mode: 'regular', target: 'https://fixture.test',
    budget: { toolCalls: 50, modelCalls: 40, tokens: 500 } })
  const rootPolicy = readTaskPolicy(store, 'usage-root')
  const roundAt = rootPolicy.startedAt
  let at = 1_700_000_000_000
  for (let i = 0; i < 17; i += 1) {
    saveCall('usage-root', roundAt, 'settled-' + i, { id: 'settled-' + i, state: 'settled', wire: true,
      readOnly: i === 16, provider: 'fixture', model: 'fixture-model', purpose: 'conversation',
      at: at + i, settledAt: at + i + 1, usage })
  }
  saveCall('usage-root', roundAt, 'settled-zero', { id: 'settled-zero', state: 'settled', wire: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    provider: 'fixture', model: 'fixture-model', purpose: 'conversation', at: at + 20, settledAt: at + 21 })
  saveCall('usage-root', roundAt, 'unknown-a', { id: 'unknown-a', state: 'unknown', wire: true,
    provider: 'fixture', model: 'fixture-model', purpose: 'conversation', at: at + 30 })
  saveCall('usage-root', roundAt, 'unknown-b', { id: 'unknown-b', state: 'unknown', wire: true,
    provider: 'fixture', model: 'fixture-model', purpose: 'conversation', at: at + 31 })
  saveCall('usage-root', roundAt, 'inflight-wire', { id: 'inflight-wire', state: 'dispatched', wire: { sha256: 'fixture-wire', bytes: 42 },
    provider: 'fixture', model: 'fixture-model', purpose: 'conversation', at: at + 40 })
  saveCall('usage-root', roundAt, 'queued-no-wire', { id: 'queued-no-wire', state: 'dispatched', wire: false,
    provider: 'fixture', model: 'fixture-model', purpose: 'conversation', at: at + 41 })
  saveCall('usage-root', roundAt, 'cancelled-before', { id: 'cancelled-before', state: 'cancelled', wire: false,
    provider: 'fixture', model: 'fixture-model', purpose: 'conversation', at: at + 42 })
  // 干扰：其它轮次、其它根、任务级知识整理。
  saveCall('usage-root', roundAt - 1000, 'other-round', { id: 'other-round', state: 'settled', wire: true,
    provider: 'fixture', model: 'fixture-model', at: at, settledAt: at + 1, usage: { ...usage, totalTokens: 99 } })
  saveCall('other-root', roundAt, 'other-root-call', { id: 'other-root-call', state: 'settled', wire: true,
    provider: 'fixture', model: 'fixture-model', at: at, settledAt: at + 1, usage: { ...usage, totalTokens: 99 } })
  store.db.prepare(`INSERT INTO knowledge_curations(request_id,root_session,project_key,source_key,source_digest,
    model_snapshot,state,usage,wire_attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run('curation-1', 'usage-root', 'p', 's', 'd', '{}', 'saved', JSON.stringify(usage), 1, Date.now(), Date.now())

  const query = (context = {}, page = { limit: 20 }) => workbenchQuery({}, store, {
    kind: 'usage.round', context: { rootId: 'usage-root', ...context }, page,
  })

  await test('I3-01 固定夹具的 23 行、20 次 wire、18 已知、2 未知、2 处理中、1 撤销、1 未观测、1 只读', () => {
    const response = query()
    const data = response.data
    assert.equal(data.unavailable, false)
    assert.equal(data.roundAt, roundAt)
    assert.equal(data.currentRound, true)
    assert.equal(data.usage.totalCalls, 23)
    assert.equal(data.usage.observedWireAttempts, 20)
    assert.equal(data.usage.settledUsageCount, 18)
    assert.equal(data.usage.unknownUsageCount, 2)
    assert.equal(data.usage.inFlightCount, 2)
    assert.equal(data.usage.unobservedDispatchCount, 1)
    assert.equal(data.usage.cancelledBeforeDispatch, 1)
    assert.equal(data.usage.excludedFromBudgetCount, 1)
    assert.equal(data.usage.knownTokens, 187)
    assert.equal(data.usage.inputTokens, 34)
    assert.equal(data.usage.outputTokens, 51)
    assert.equal(data.usage.cacheReadTokens, 85)
    assert.equal(data.usage.cacheWriteTokens, 17)
    assert.equal(data.usage.partial, true)
    assert.equal(data.usage.cashCost, 'unknown')
    assert.equal(data.rows.length, 20)
    assert.equal(response.page.hasMore, true)
    assert.equal(data.rows.find(row => row.id === 'inflight-wire').wire, true,
      'a real wire observation is an object, not the boolean true')
    for (const row of data.rows.filter(item => item.state === 'unknown' || item.state === 'dispatched' || item.state === 'cancelled'))
      assert.notEqual(row.usage, 0, 'unknown usage must not be rendered as zero')
  })

  await test('I3-01 两页明细稳定 ID 无重复，逐笔已知用量之和等于汇总', () => {
    const first = query({}, { limit: 20 })
    const second = query({}, { limit: 20, cursor: first.page.nextCursor })
    const ids = [...first.data.rows, ...second.data.rows].map(row => row.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(ids.length, 23)
    const sum = [...first.data.rows, ...second.data.rows]
      .filter(row => row.usage).reduce((total, row) => total + row.usage.totalTokens, 0)
    assert.equal(sum, 187)
    assert.equal(second.page.hasMore, false)
  })

  await test('I3-01 其它轮次、其它根和任务级知识整理不进入本轮合计', () => {
    const data = query().data
    const ids = data.rows.map(row => row.id)
    assert.equal(ids.includes('other-round'), false)
    assert.equal(ids.includes('other-root-call'), false)
    assert.equal(data.taskAuxiliary.label, '知识整理｜整个任务')
    assert.equal(data.taskAuxiliary.wireAttempts, 1)
    assert.equal(data.taskAuxiliary.knownTokens, 11)
    assert.equal(data.usage.knownTokens, 187)
  })

  await test('I3-01 一条未知以同 ID 结算 11 tokens 后：19 已知、1 未知、198 tokens，其它计数不变', () => {
    const record = JSON.parse(store.db.prepare("SELECT record FROM task_model_calls WHERE id='unknown-a'").get().record)
    const next = { ...record, state: 'settled', settledAt: Date.now(), usage }
    store.db.prepare("UPDATE task_model_calls SET state='settled',record=? WHERE id='unknown-a'").run(JSON.stringify(next))
    const data = query().data
    assert.equal(data.usage.settledUsageCount, 19)
    assert.equal(data.usage.unknownUsageCount, 1)
    assert.equal(data.usage.knownTokens, 198)
    assert.equal(data.usage.observedWireAttempts, 20)
    assert.equal(data.usage.inFlightCount, 2)
    assert.equal(data.usage.unobservedDispatchCount, 1)
    assert.equal(data.usage.cancelledBeforeDispatch, 1)
    assert.equal(data.usage.excludedFromBudgetCount, 1)
    assert.equal(data.usage.totalCalls, 23)
  })

  await test('I3 旧游标在账本变化后回到第一页并提示刷新', () => {
    const first = query({}, { limit: 20 })
    saveCall('usage-root', roundAt, 'late-settled', { id: 'late-settled', state: 'settled', wire: true,
      provider: 'fixture', model: 'fixture-model', purpose: 'conversation', at: at + 90, settledAt: at + 91, usage })
    const stale = query({}, { limit: 20, cursor: first.page.nextCursor })
    assert.equal(stale.data.staleCursor, true)
    assert.equal(stale.notices[0].includes('变化'), true)
    assert.equal(stale.data.rows.length, 20)
  })

  await test('I3 当前轮附预算口径；只读行单列但不并入预算 charged 判定', () => {
    const data = query().data
    assert.equal(data.budget.limits.modelCalls, 40)
    assert.equal(data.budget.limits.tokens, 500)
    const overview = modelBudgetOverview(store, 'usage-root')
    assert.equal(overview.chargedCalls, data.budget.chargedCalls)
    assert.equal(data.budget.knownTokens, overview.knownTokens)
    assert.equal(data.usage.knownTokens > data.budget.knownTokens, true, '用量口径含只读行，预算口径不含')
  })

  await test('I3 子会话请求使用账本归属根，不把工作台 root 当账本 owner', () => {
    startTaskPolicy(store, 'usage-child', { mode: 'regular', target: 'https://fixture.test',
      purposeTask: true, parentSession: 'usage-root', parentRound: roundAt, budget: { toolCalls: 2 } })
    const data = workbenchQuery({}, store, { kind: 'usage.round', context: { rootId: 'usage-child' }, page: { limit: 20 } }).data
    assert.equal(data.rootId, 'usage-child')
    assert.equal(data.ledgerRoot, 'usage-root')
    assert.equal(data.roundAt, roundAt)
    assert.equal(data.usage.totalCalls >= 23, true)
  })

  await test('I3 打开明细不新增任何账本事件', () => {
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM task_model_calls').get().n
    for (let i = 0; i < 3; i += 1) query()
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_model_calls').get().n, before)
  })

  await test('I3 无已结算样本时分量为 null；无法确认归属时显示不可用而不是 0', () => {
    startTaskPolicy(store, 'usage-empty', { mode: 'regular', target: 'https://fixture.test', budget: { toolCalls: 2 } })
    const data = workbenchQuery({}, store, { kind: 'usage.round', context: { rootId: 'usage-empty' }, page: { limit: 20 } }).data
    assert.equal(data.usage.knownTokens, null)
    assert.equal(data.usage.unknownUsageCount, 0)
    const missing = workbenchQuery({}, store, { kind: 'usage.round', context: { rootId: 'no-such-root' }, page: { limit: 20 } }).data
    assert.equal(missing.unavailable, true)
    assert.equal(missing.usage.knownTokens, null)
    assert.equal(missing.reason.length > 0, true)
  })
} finally {
  store.close()
}
console.log(failed ? '\n' + failed + ' usage round checks failed' : '\nusage round reconciliation passed')
process.exitCode = failed ? 1 : 0
