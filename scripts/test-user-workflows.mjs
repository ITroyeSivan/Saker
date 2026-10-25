import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import {
  applyPendingTaskChange,
  chooseTaskMode,
  effectivePolicy,
  readTaskPolicy,
  setTaskActionLimits,
  setTaskBudget,
  startTaskPolicy,
  taskExecutionGuard,
  taskOverview,
  taskPolicyStatus,
  taskPromptStable,
  updateTaskFromChat,
} from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { readTaskContext, saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { executeDirectRequest } from '../plugins/dsh-redteam-results/lib/execution-receipts.js'
import { createSiteWorkers } from '../plugins/dsh-redteam-results/lib/site-workers.js'
import { normalizeTaskScope, taskScopeAllowsUrl } from '../plugins/dsh-redteam-results/lib/task-scope.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}

await test('one task preserves full URLs, multiple entries, domains, wildcards and CIDR', () => {
  const store = openStore(':memory:')
  try {
    const policy = startTaskPolicy(store, 'inputs', {
      mode: 'regular',
      question: '检查 example.test 及所有子域、两行入口和 203.0.113.0/24',
      target: 'https://app.example.test:8443/login?return=/orders\nhttps://api.example.test/v1\n203.0.113.0/24',
    })
    assert.match(policy.target, /https:\/\/app\.example\.test:8443\/login\?return=\/orders/)
    assert.match(policy.target, /https:\/\/api\.example\.test\/v1/)
    assert.equal(policy.scope.include.includes('203.0.113.0/24'), true)
    assert.equal(taskScopeAllowsUrl(policy, 'https://app.example.test:8443/export'), true)
    assert.equal(taskScopeAllowsUrl(policy, 'https://api.example.test/other'), true)
    assert.equal(taskScopeAllowsUrl(policy, 'http://app.example.test:8443/'), false)
    assert.equal(taskScopeAllowsUrl(policy, 'http://203.0.113.44/'), true)
  } finally { store.close() }
})

await test('desktop-selected target reaches the model prompt and the task start without being restated', () => {
  const store = openStore(':memory:')
  try {
    const target = 'http://127.0.0.1:31873/login?return=/orders\nhttp://127.0.0.1:31873/api/orders?owner=self'
    chooseTaskMode(store, 'desktop-target', 'regular', { target, workers: 0 })
    const prompt = taskPromptStable(taskPolicyStatus(store, 'desktop-target'))
    assert.match(prompt, /127\.0\.0\.1:31873\/login\?return=\/orders/)
    assert.match(prompt, /127\.0\.0\.1:31873\/api\/orders\?owner=self/)
    const policy = startTaskPolicy(store, 'desktop-target', { mode: 'regular', budget: { workers: 0 } })
    assert.match(policy.target, /login\?return=\/orders/)
    assert.match(policy.target, /api\/orders\?owner=self/)
  } finally { store.close() }
})

await test('chat settings exposes a visible task summary and asset entry after start', async () => {
  const store = openStore(':memory:')
  const id = 'chat-overview'
  try {
    startTaskPolicy(store, id, { mode: 'regular', target: 'https://app.example.test/login?next=/orders', budget: { workers: 0 } })
    saveTaskContext(store, id, { assets: [
      { id: 'app', url: 'https://app.example.test/login?next=/orders', reachable: false },
      { id: 'api', url: 'https://app.example.test/api/orders?owner=self', reachable: false },
    ], requests: [], methods: [], checks: [] })
    const overview = taskOverview(store, id)
    assert.equal(overview.counts.assets, 2)
    assert.match(overview.scope.text, /login\?next=\/orders/)
  } finally { store.close() }
})

await test('model-provided inScope cannot expand the user task scope', () => {
  const store = openStore(':memory:')
  try {
    startTaskPolicy(store, 'scope', { mode: 'regular', target: 'https://app.example.test', budget: { workers: 0 } })
    const context = saveTaskContext(store, 'scope', {
      assets: [
        { id: 'app', url: 'https://app.example.test', inScope: true },
        { id: 'outside', url: 'https://outside.example.net', inScope: true },
      ],
      requests: [],
      methods: [],
    })
    assert.equal(context.assets.find(row => row.id === 'app').inScope, true)
    assert.equal(context.assets.find(row => row.id === 'outside').inScope, false)
    assert.equal(readTaskContext(store, 'scope').assets.find(row => row.id === 'outside').inScope, false)
  } finally { store.close() }
})

await test('passive FOFA candidate search needs neither a target website nor scanner allowance', () => {
  const store = openStore(':memory:')
  try {
    chooseTaskMode(store, 'passive', 'regular', { allowTargetNetwork: false, workers: 0 })
    const policy = startTaskPolicy(store, 'passive', {
      mode: 'regular',
      question: '只查询已有 FOFA 候选，不访问候选主机',
      budget: { workers: 0 },
    })
    assert.equal(policy.budget.unmeteredToolCalls, null)
    assert.equal(taskExecutionGuard(store, 'passive', 'asset_candidate_search_batch', Date.now(), {
      args: { queries: [{ id: 'q1', query: 'app:"Example-Portal"' }] },
    }), undefined)
  } finally { store.close() }
})

await test('chat expansion becomes one user-confirmable diff and preserves cumulative budget', () => {
  const store = openStore(':memory:')
  try {
    const before = startTaskPolicy(store, 'chat', {
      mode: 'regular',
      target: 'https://app.example.test',
      budget: { toolCalls: 20, workers: 0 },
    })
    const pending = updateTaskFromChat(store, 'chat', {
      target: 'https://api.example.test', mode: 'nday', toolCalls: 40,
    })
    assert.equal(pending.pendingChange.fields.includes('target'), true)
    assert.equal(readTaskPolicy(store, 'chat').mode, 'regular')
    assert.equal(readTaskPolicy(store, 'chat').target, before.target)
    applyPendingTaskChange(store, 'chat', 'desktop-user')
    const after = readTaskPolicy(store, 'chat')
    assert.equal(after.mode, 'nday')
    assert.match(after.target, /api\.example\.test/)
    assert.equal(after.budget.toolCalls, 40)
    assert.equal(after.startedAt, before.startedAt)
    assert.deepEqual(after.used, before.used)
    const extended = setTaskBudget(store, 'chat', { toolCalls: 60, extendMinutes: 20 }, 'desktop-user')
    assert.equal(extended.budget.toolCalls, 60)
    assert(extended.budget.deadline > Date.now())
    assert.deepEqual(extended.used, before.used)
  } finally { store.close() }
})

await test('direct exploration auto-saves request and response without hypothesis or first-contact counter', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = 'http://127.0.0.1:' + server.address().port
  const store = openStore(':memory:')
  try {
    startTaskPolicy(store, 'direct', { mode: 'regular', target: base, budget: { workers: 0 } })
    const receipt = await executeDirectRequest(store, 'direct', {
      url: base + '/api/health?full=1',
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    assert.equal(receipt.outcome, 'response')
    assert.equal(receipt.status, 200)
    assert.equal(receipt.hypothesisId, 'exploration')
    assert.equal(receipt.taskRecorded, true)
    const context = readTaskContext(store, 'direct')
    assert.equal(context.assets.some(asset => new URL(asset.url).origin === base && asset.reachable === true && asset.inScope === true), true)
    assert.equal(context.requests.some(row => row.endpoint.endsWith('/api/health?full=1') && row.valid === true
      && row.responseReceiptId === receipt.id), true)
  } finally {
    store.close()
    await new Promise(done => server.close(done))
  }
})

await test('a worker can investigate another authorized asset with a different research focus', async () => {
  const store = openStore(':memory:')
  const live = new Map()
  const starts = []
  const services = {
    subagents: {
      async listDescendants() { return [] },
      async startActivation(input) {
        starts.push(input)
        live.set(input.childId, {})
        return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => { live.delete(input.childId) } }
      },
      async drainChildren(_parent, ids) { for (const id of ids) live.delete(id) },
    },
    agents: { get(id) { return live.get(id) } },
  }
  const ctx = { get(name) { return services[name] } }
  const workers = createSiteWorkers(ctx, () => store)
  try {
    startTaskPolicy(store, 'parent', {
      mode: 'regular',
      target: 'https://app.example.test\nhttps://api.example.test',
      question: '检查两个授权资产',
      budget: { toolCalls: 20, workers: 2 },
    })
    saveTaskContext(store, 'parent', {
      assets: [
        { id: 'app', url: 'https://app.example.test', inScope: true, reachable: true },
        { id: 'api', url: 'https://api.example.test', inScope: true, reachable: true },
      ],
      requests: [],
      methods: [],
    })
    const agent = { session: { id: 'parent', header: {} }, ctx: { tools: {
      schemas: () => ['read', 'grep', 'run_code', 'redteam_task', 'redteam_context', 'redteam_research', 'redteam_execution'].map(name => ({ name })),
    } } }
    const result = await workers.delegate(agent, {
      site: 'https://api.example.test',
      focus: 'nday',
      question: '检查 API 的近期 Nday',
      reason: '独立授权资产',
      need: 'independent-site-research',
    })
    assert.equal(starts.length, 1)
    const child = readTaskPolicy(store, result.childId)
    assert.equal(child.mode, 'nday')
    assert.match(child.target, /api\.example\.test/)
    assert.equal(readTaskContext(store, result.childId).assets.some(asset => asset.id === 'api'), true)
  } finally { await workers.dispose(); store.close() }
})

await test('shrinking the parent scope immediately narrows an existing child scope', () => {
  const store = openStore(':memory:')
  try {
    startTaskPolicy(store, 'parent-narrow', {
      mode: 'regular',
      target: 'https://app.example.test\nhttps://api.example.test',
      budget: { workers: 1 },
    })
    store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)')
      .run('parent-narrow', 'child-narrow', 'api', JSON.stringify({
        parentId: 'parent-narrow', childId: 'child-narrow', site: 'https://api.example.test', state: 'running', allowedTools: [],
      }))
    startTaskPolicy(store, 'child-narrow', {
      mode: 'regular',
      target: 'https://api.example.test',
      parentSession: 'parent-narrow',
      budget: { workers: 0 },
    })
    assert.equal(taskScopeAllowsUrl(effectivePolicy(store, readTaskPolicy(store, 'child-narrow')), 'https://api.example.test'), true)
    setTaskActionLimits(store, 'parent-narrow', { target: 'https://app.example.test' }, 'desktop-user')
    assert.equal(taskScopeAllowsUrl(effectivePolicy(store, readTaskPolicy(store, 'child-narrow')), 'https://api.example.test'), false)
  } finally { store.close() }
})

await test('defaults are optional and the UI exposes local status, assets and pending diffs', () => {
  const store = openStore(':memory:')
  try {
    const policy = startTaskPolicy(store, 'optional', { mode: 'regular', target: 'example.test' })
    assert.equal(policy.budget.toolCalls, null)
    assert.equal(policy.budget.deadline, null)
    assert.equal(policy.budget.unmeteredToolCalls, null)
  } finally { store.close() }
  const client = readFileSync(join(root, 'plugins/dsh-redteam-results/lib/client.js'), 'utf8')
  assert.match(client, /测试范围（网址、域名、IP\/CIDR，选填）/)
  assert.match(client, /范围：.*资产.*已发请求\/回执.*运行助手.*待你确认/s)
  assert.match(client, /查看资产/)
  assert.match(client, /待确认的任务变更/)
  assert.doesNotMatch(client, /calls:'30'|minutes:'15'|unmetered:'0'/)
})

console.log(failed ? failed + ' workflow test(s) failed' : 'all user workflow tests passed')
process.exitCode = failed ? 1 : 0
