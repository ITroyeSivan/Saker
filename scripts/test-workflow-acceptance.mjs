import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import {
  startTaskPolicy, readTaskPolicy, effectivePolicy, taskExecutionGuard, taskPolicyStatus,
  chooseTaskMode, chosenTaskOptions, setTaskActionLimits, updateTaskFromChat, applyPendingTaskChange,
  finishTaskOnTurnEnd, resumeTurnEndedTask, isExplicitTaskContinuation,
  normalizeExcludedPaths, updateTaskProgress, taskPromptStable, taskOverview,
} from '../plugins/dsh-redteam-results/lib/task-policy.js'
import {
  normalizeTaskScope, taskScopeAllowsUrl, taskScopePromptText,
} from '../plugins/dsh-redteam-results/lib/task-scope.js'
import { saveTaskContext, readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { executeDirectRequest, executeRecordedRequest } from '../plugins/dsh-redteam-results/lib/execution-receipts.js'
import { executeProjectHttp } from '../plugins/dsh-redteam-results/lib/project-execution.js'
import { createProjectRun, transitionProjectRun, defineProjectChecks } from '../plugins/dsh-redteam-results/lib/project-store.js'
import { createSiteWorkers } from '../plugins/dsh-redteam-results/lib/site-workers.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = path.resolve(root, '..', '_ref', 'tmp')
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log('ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL ' + name + ': ' + (error.stack || error.message))
  }
}

async function memory(fn) {
  const store = openStore(':memory:')
  try { return await fn(store) } finally { store.close() }
}

function start(store, id, extra = {}) {
  return startTaskPolicy(store, id, {
    mode: 'regular',
    target: 'https://app.example.test',
    budget: { workers: 0 },
    ...extra,
  })
}

async function loopbackServer() {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('local acceptance fixture')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    hits: () => hits,
    close: () => new Promise(done => server.close(done)),
  }
}

await test('U05 input punctuation, invalid rows, scoped inference and explicit field clearing are exact', () => {
  const punctuation = 'https://app.example.test/api?ids=1,2;view=full'
  const normalized = normalizeTaskScope({ target: punctuation })
  assert.equal(normalized.target, punctuation)
  assert.deepEqual(normalized.entrypoints.map(row => row.url), [punctuation])

  const mixed = normalizeTaskScope({ target: 'https://ok.example.test\nhttps://\nhttps://two.example.test' })
  assert.deepEqual(mixed.errors.map(row => row.value), ['https://'])
  assert.equal(mixed.terms.include.length, 2)

  const inferred = normalizeTaskScope({ target: 'example.test\nother.test', requestText: 'check example.test and all subdomains' })
  assert(taskScopeAllowsUrl(inferred, 'https://api.example.test'))
  assert(!taskScopeAllowsUrl(inferred, 'https://api.other.test'))

  assert.deepEqual(normalizeExcludedPaths('payment\npay.example.test\n203.0.113.128/25'),
    ['/payment', 'pay.example.test', '203.0.113.128/25'])

  return memory(store => {
    chooseTaskMode(store, 'clear', 'regular', { target: 'https://app.example.test', workers: 0 })
    setTaskActionLimits(store, 'clear', { target: '', allowTargetNetwork: false }, 'desktop-user')
    chooseTaskMode(store, 'clear', 'regular', { target: '', workers: 0 })
    const choice = chosenTaskOptions(store, 'clear')
    assert.equal(choice.target, '')
    assert.deepEqual(choice.scope.include, [])
  })
})

await test('U01 parent exclusions and stale recorded requests cannot grant target access', async () => memory(async store => {
  const parent = start(store, 'scope-parent', { target: '*.example.test', scope: { exclude: ['pay.example.test'] }, budget: { workers: 1 } })
  const child = start(store, 'scope-child', { target: '*.example.test', parentSession: 'scope-parent', purposeTask: true })
  assert(!taskScopeAllowsUrl(parent, 'https://pay.example.test/'))
  assert(!taskScopeAllowsUrl(effectivePolicy(store, child), 'https://pay.example.test/'))

  const service = await loopbackServer()
  try {
    start(store, 'stale-record', { target: service.base })
    const first = await executeDirectRequest(store, 'stale-record', { url: service.base + '/public' })
    assert.equal(service.hits(), 1)
    setTaskActionLimits(store, 'stale-record', { target: 'http://127.0.0.1:1' }, 'desktop-user')
    await assert.rejects(executeRecordedRequest(store, 'stale-record', {
      requestId: first.requestId, requestRevision: first.requestRevision,
    }), /outside the current task scope/)
    assert.equal(service.hits(), 1, 'scope denial happened before the wire')
  } finally { await service.close() }
}))

await test('U01 direct paths, repeated requests and the second project origin share one scope', async () => memory(async store => {
  const service = await loopbackServer()
  const second = service.base.replace('127.0.0.1', 'localhost')
  try {
    start(store, 'direct', { target: service.base, scope: { exclude: [service.base + '/private'] } })
    await assert.rejects(executeDirectRequest(store, 'direct', { url: service.base + '/private' }), /excluded_path/)
    assert.equal(service.hits(), 0)
    await executeDirectRequest(store, 'direct', { url: service.base + '/public' })
    await executeDirectRequest(store, 'direct', { url: service.base + '/public' })
    assert.equal(service.hits(), 2)
    assert.equal(readTaskContext(store, 'direct').assets.length, 1)
    assert.equal(taskOverview(store, 'direct').counts.assets, 1)
    assert.equal(taskOverview(store, 'direct').counts.receipts, 2)

    start(store, 'project-multi', { scenario: 'project', target: service.base + '/one\n' + second + '/two' })
    const run = createProjectRun(store, 'project-multi', { question: 'two local origins' })
    const running = transitionProjectRun(store, 'project-multi', run.runId, 'running', run.controlRev)
    const [check] = defineProjectChecks(store, 'project-multi', run.runId, [{ requirement: 'second origin' }])
    await executeProjectHttp(store, 'project-multi', running.runId, check.checkId, { url: second + '/two' })
    assert.equal(service.hits(), 3)
  } finally { await service.close() }
}))

await test('R01 a relative path never becomes a hostless active scope', async () => memory(async store => {
  assert.throws(() => startTaskPolicy(store, 'path-only', {
    mode: 'regular', target: '/api', budget: { workers: 0 },
  }), /相对路径.*需要.*网址/)
  assert.equal(readTaskPolicy(store, 'path-only'), null)

  const service = await loopbackServer()
  try {
    start(store, 'relative-exclude', { target: service.base, excludedPaths: ['/payment'] })
    await assert.rejects(executeDirectRequest(store, 'relative-exclude', {
      url: service.base + '/payment/checkout',
    }), /excluded_path/)
    assert.equal(service.hits(), 0)
    await executeDirectRequest(store, 'relative-exclude', { url: service.base + '/payments' })
    assert.equal(service.hits(), 1)
  } finally { await service.close() }
}))

await test('R02 protocol-qualified wildcard scope survives child intersection and unrelated edits', () => memory(store => {
  const parent = start(store, 'protocol-parent', {
    target: 'https://*.example.test:8443', budget: { workers: 1 },
  })
  assert.equal(parent.target, 'https://*.example.test:8443')
  assert(taskScopeAllowsUrl(parent, 'https://api.example.test:8443/'))
  assert(!taskScopeAllowsUrl(parent, 'http://api.example.test:8443/'))

  const child = start(store, 'protocol-child', {
    target: 'https://*.example.test:8443', purposeTask: true, parentSession: 'protocol-parent',
  })
  let effective = effectivePolicy(store, child)
  assert(taskScopeAllowsUrl(effective, 'https://api.example.test:8443/'))
  assert(!taskScopeAllowsUrl(effective, 'http://api.example.test:8443/'))
  assert(!taskScopeAllowsUrl(effective, 'https://api.example.test:9443/'))

  setTaskActionLimits(store, 'protocol-parent', { excludedPaths: ['/private'] }, 'desktop-user')
  const edited = readTaskPolicy(store, 'protocol-parent')
  assert(taskScopeAllowsUrl(edited, 'https://api.example.test:8443/'))
  assert(!taskScopeAllowsUrl(edited, 'http://api.example.test:8443/'))
  assert(!taskScopeAllowsUrl(edited, 'https://api.example.test:9443/'))
  assert.throws(() => start(store, 'protocol-wrong-child', {
    target: 'http://*.example.test:8443', purposeTask: true, parentSession: 'protocol-parent',
  }), /cannot expand/)

  const legacy = start(store, 'legacy-wildcard', { target: '*.example.test' })
  assert(taskScopeAllowsUrl(legacy, 'https://api.example.test/'))
  assert(taskScopeAllowsUrl(legacy, 'http://api.example.test:8443/'))
}))

await test('R02 mixed domain, URL and IP intersections cannot widen protocol or port', async () => memory(async store => {
  start(store, 'strict-https-parent', { target: 'https://app.example.test', budget: { workers: 1 } })
  assert.throws(() => start(store, 'bare-domain-child', {
    target: 'app.example.test', purposeTask: true, parentSession: 'strict-https-parent',
  }), /cannot expand/)
  const httpParent = start(store, 'strict-http-parent', {
    target: 'http://app.example.test', budget: { workers: 1 },
  })
  assert(httpParent)
  assert.throws(() => start(store, 'http-parent-bare-child', {
    target: 'app.example.test', purposeTask: true, parentSession: 'strict-http-parent',
  }), /cannot expand/)

  start(store, 'strict-wildcard-parent', {
    target: 'https://*.example.test', budget: { workers: 1 },
  })
  assert.throws(() => start(store, 'wildcard-bare-child', {
    target: 'app.example.test', purposeTask: true, parentSession: 'strict-wildcard-parent',
  }), /cannot expand/)

  start(store, 'bare-domain-parent', { target: 'app.example.test', budget: { workers: 1 } })
  const strictChild = start(store, 'strict-url-child', {
    target: 'https://app.example.test/', purposeTask: true, parentSession: 'bare-domain-parent',
  })
  assert(taskScopeAllowsUrl(strictChild, 'https://app.example.test/'))
  assert(!taskScopeAllowsUrl(strictChild, 'http://app.example.test:8080/'))

  const services = {
    subagents: {
      async listDescendants() { return [] },
      async startActivation() {
        return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
      },
      async drainChildren() {},
    },
    agents: { get() { return undefined } },
  }
  const workers = createSiteWorkers({ get(name) { return services[name] } }, () => store)
  const service = await loopbackServer()
  try {
    start(store, 'worker-mixed-parent', { target: 'https://localhost', budget: { workers: 1 } })
    saveTaskContext(store, 'worker-mixed-parent', {
      assets: [{ id: 'local', url: 'https://localhost' }], requests: [], methods: [], checks: [],
    })
    const agent = {
      session: { id: 'worker-mixed-parent', header: {} },
      ctx: { tools: { schemas: () => ['read', 'redteam_task', 'redteam_context', 'redteam_execution'].map(name => ({ name })) } },
    }
    const delegated = await workers.delegate(agent, {
      site: 'localhost', focus: 'regular', question: 'inspect only the selected HTTPS asset',
      reason: 'independent selected host', need: 'independent-site-research',
    })
    const child = effectivePolicy(store, readTaskPolicy(store, delegated.childId))
    assert(taskScopeAllowsUrl(child, 'https://localhost/'))
    const httpUrl = service.base.replace('127.0.0.1', 'localhost') + '/scope-check'
    assert(!taskScopeAllowsUrl(child, httpUrl))
    await assert.rejects(executeDirectRequest(store, delegated.childId, { url: httpUrl }),
      /outside the current task scope/)
    assert.equal(service.hits(), 0)
  } finally {
    await workers.dispose()
    await service.close()
  }
}))

await test('U02 reference reads and passive asset queries are not target traffic, while shell targets remain scoped', async () => memory(store => {
  start(store, 'reference', { target: 'https://app.example.test' })
  assert.equal(taskExecutionGuard(store, 'reference', 'web_fetch', Date.now(), {
    reserve: false, args: { url: 'https://github.com/example/advisory' },
  }), undefined)
  assert.equal(taskExecutionGuard(store, 'reference', 'pwsh', Date.now(), {
    reserve: false, args: { command: 'git show --stat; # see https://github.com/example/advisory' },
  }), undefined)
  assert.match(String(taskExecutionGuard(store, 'reference', 'pwsh', Date.now(), {
    reserve: false, args: { command: 'curl https://outside.example.org/' },
  })), /outside_scope/)
  assert.equal(taskExecutionGuard(store, 'reference', 'web_fetch', Date.now(), {
    reserve: false, args: { url: 'https://github.com/example/advisory' },
  }), undefined, 'reference fetch remains available')
  chooseTaskMode(store, 'target-disabled', 'regular', {
    target: 'https://app.example.test', allowTargetNetwork: false, workers: 0,
  })
  startTaskPolicy(store, 'target-disabled', { mode: 'regular' })
  assert.match(String(taskExecutionGuard(store, 'target-disabled', 'web_fetch', Date.now(), {
    reserve: false, args: { url: 'https://app.example.test/api/orders' },
  })), /target_network_disabled/)
  assert.equal(taskExecutionGuard(store, 'target-disabled', 'web_fetch', Date.now(), {
    reserve: false, args: { url: 'https://github.com/example/advisory' },
  }), undefined, 'external reference remains available after target access is disabled')

  start(store, 'target-excluded', { target: 'https://app.example.test', scope: { exclude: ['/private'] } })
  assert.match(String(taskExecutionGuard(store, 'target-excluded', 'web_fetch', Date.now(), {
    reserve: false, args: { url: 'https://app.example.test/private/orders' },
  })), /excluded_path/)

  assert.equal(taskExecutionGuard(store, 'no-task-yet', 'asset_candidate_search_batch', Date.now(), {
    reserve: false, args: { queries: [{ query: 'app="Demo"' }], mode: 'native' },
  }), undefined)
  start(store, 'spent', { target: 'https://app.example.test', budget: { toolCalls: 1, workers: 0 } })
  taskExecutionGuard(store, 'spent', 'recorded-http-execution', Date.now())
  assert.equal(taskExecutionGuard(store, 'spent', 'asset_candidate_search_batch', Date.now(), {
    reserve: false, args: { queries: [{ query: 'app="Demo"' }] },
  }), undefined)
}))

await test('U03 only an explicit human continue lifts ordinary turn_ended and preserves the task', () => memory(store => {
  const before = start(store, 'continue')
  finishTaskOnTurnEnd(store, 'continue')
  assert.equal(taskPolicyStatus(store, 'continue').reason, 'turn_ended')
  assert(isExplicitTaskContinuation({ id: 'human-1', source: { kind: 'user' }, content: [{ type: 'text', text: '继续当前任务' }] }))
  assert(!isExplicitTaskContinuation({ id: 'human-2', source: { kind: 'user' }, content: [{ type: 'text', text: '现在进展如何？' }] }))
  for (const text of [
    'Do not continue the current task.',
    '继续当前任务前先不要发请求。',
    '继续当前任务前先不要访问网站，只讨论方案。',
  ]) assert(!isExplicitTaskContinuation({ id: 'human-' + text.length, source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  assert(isExplicitTaskContinuation({ id: 'human-en', source: { kind: 'user' }, content: [{ type: 'text', text: 'Please continue the current task.' }] }))
  const resumed = resumeTurnEndedTask(store, 'continue')
  assert(resumed?.continued)
  assert.equal(taskPolicyStatus(store, 'continue').reason, '')
  assert.equal(readTaskPolicy(store, 'continue').startedAt, before.startedAt)

  start(store, 'cancelled-continue')
  updateTaskProgress(store, 'cancelled-continue', { cancelled: true })
  assert.equal(resumeTurnEndedTask(store, 'cancelled-continue'), null)

  start(store, 'hard-deadline', { budget: { minutes: 1, workers: 0 } })
  const hard = readTaskPolicy(store, 'hard-deadline')
  hard.budget.deadline = Date.now() - 1
  hard.finishedAt = 123456
  store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify(hard), 'hard-deadline')
  assert.equal(taskPolicyStatus(store, 'hard-deadline').reason, 'time_budget_exhausted')
  assert.equal(finishTaskOnTurnEnd(store, 'hard-deadline'), null)
  assert.equal(resumeTurnEndedTask(store, 'hard-deadline'), null)
  updateTaskFromChat(store, 'hard-deadline', { target: 'https://api.example.test' })
  applyPendingTaskChange(store, 'hard-deadline', 'desktop-user')
  assert.equal(readTaskPolicy(store, 'hard-deadline').finishedAt, 123456)
}))

await test('U04 uncapped workers inherit no artificial ceiling, distinct questions create distinct work, and selected materials copy', async () => memory(async store => {
  let starts = 0
  const services = {
    subagents: {
      async listDescendants() { return [] },
      async startActivation() {
        starts += 1
        return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
      },
      async drainChildren() {},
    },
    agents: { get() { return undefined } },
  }
  const workers = createSiteWorkers({ get(name) { return services[name] } }, () => store)
  const agent = {
    session: { id: 'workers', header: {} },
    ctx: { tools: { schemas: () => ['read', 'run_code', 'redteam_task', 'redteam_context', 'redteam_execution'].map(name => ({ name })) } },
  }
  try {
    start(store, 'workers', { budget: { workers: 2 } })
    saveTaskContext(store, 'workers', {
      assets: [{ id: 'app', url: 'https://app.example.test' }], requests: [], methods: [], checks: [],
    })
    const first = await workers.delegate(agent, {
      site: 'https://app.example.test', focus: 'nday', question: 'question one',
      reason: 'independent work', need: 'independent-site-research',
    })
    const second = await workers.delegate(agent, {
      site: 'https://app.example.test', focus: 'regular', question: 'question two',
      reason: 'independent work', need: 'independent-site-research',
    })
    assert.notEqual(first.childId, second.childId)
    assert.equal(starts, 2)
    assert.equal(readTaskPolicy(store, first.childId).budget.toolCalls, null)

    start(store, 'materials', { target: 'https://app.example.test', budget: { workers: 1 } })
    saveTaskContext(store, 'materials', {
      assets: [{ id: 'app', url: 'https://app.example.test' }], requests: [], methods: [], checks: [],
    })
    store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
      .run('materials', 'm1', 'https://app.example.test/source.js', 'digest', JSON.stringify({
        id: 'm1', sourceUrl: 'https://app.example.test/source.js', digest: 'digest',
        site: 'https://app.example.test', hints: [], coverage: {},
      }))
    const materialAgent = {
      session: { id: 'materials', header: {} },
      ctx: { tools: { schemas: () => ['read', 'run_code', 'redteam_task', 'redteam_context', 'redteam_execution'].map(name => ({ name })) } },
    }
    const materialWorker = await workers.delegate(materialAgent, {
      focus: 'regular', question: 'review selected material', reason: 'large-site-materials',
      need: 'large-site-materials', assetIds: ['app'], materialIds: ['m1'],
    })
    assert(store.db.prepare('SELECT 1 FROM business_materials WHERE session_id=? AND id=?').get(materialWorker.childId, 'm1'))
  } finally {
    await workers.dispose()
  }
}))

await test('R05 material workers use exactly the selected authorized assets and file-only review has no invented site', async () => memory(async store => {
  let starts = 0
  const services = {
    subagents: {
      async listDescendants() { return [] },
      async startActivation() {
        starts += 1
        return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
      },
      async drainChildren() {},
    },
    agents: { get() { return undefined } },
  }
  const workers = createSiteWorkers({ get(name) { return services[name] } }, () => store)
  const agent = id => ({
    session: { id, header: {} },
    ctx: { tools: { schemas: () => ['read', 'run_code', 'redteam_task', 'redteam_context', 'redteam_execution'].map(name => ({ name })) } },
  })
  try {
    start(store, 'r05-assets', {
      target: 'https://app.example.test\nhttps://api.example.test',
      scope: { exclude: ['/private'] },
      budget: { workers: 3 },
    })
    saveTaskContext(store, 'r05-assets', {
      assets: [
        { id: 'app', url: 'https://app.example.test' },
        { id: 'api', url: 'https://api.example.test' },
        { id: 'outside', url: 'https://outside.example.net' },
      ],
      requests: [], methods: [], checks: [],
    })
    const base = {
      focus: 'regular', reason: 'independent selected materials', need: 'large-site-materials',
    }
    const both = await workers.delegate(agent('r05-assets'), {
      ...base, question: 'compare both selected assets', assetIds: ['app', 'api'],
    })
    const bothPolicy = effectivePolicy(store, readTaskPolicy(store, both.childId))
    assert(taskScopeAllowsUrl(bothPolicy, 'https://app.example.test/'))
    assert(taskScopeAllowsUrl(bothPolicy, 'https://api.example.test/'))
    assert(!taskScopeAllowsUrl(bothPolicy, 'https://api.example.test/private/orders'))

    const onlyApp = await workers.delegate(agent('r05-assets'), {
      ...base, question: 'review only the app asset', assetIds: ['app'],
    })
    const onlyAppPolicy = effectivePolicy(store, readTaskPolicy(store, onlyApp.childId))
    assert(taskScopeAllowsUrl(onlyAppPolicy, 'https://app.example.test/'))
    assert(!taskScopeAllowsUrl(onlyAppPolicy, 'https://api.example.test/'))

    const startsBeforeRejectedAsset = starts
    await assert.rejects(workers.delegate(agent('r05-assets'), {
      ...base, question: 'must reject an out-of-scope asset', assetIds: ['outside'],
    }), /outside the current task scope/)
    assert.equal(starts, startsBeforeRejectedAsset)

    start(store, 'r05-file-only', { target: 'https://app.example.test', budget: { workers: 1 } })
    saveTaskContext(store, 'r05-file-only', { assets: [], requests: [], methods: [], checks: [] })
    store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
      .run('r05-file-only', 'file-1', 'https://app.example.test/source.js', 'digest-file-1', JSON.stringify({
        id: 'file-1', sourceUrl: 'https://app.example.test/source.js', digest: 'digest-file-1',
        site: 'https://app.example.test', hints: [], coverage: {},
      }))
    const fileOnly = await workers.delegate(agent('r05-file-only'), {
      ...base, question: 'review only the selected local material', materialIds: ['file-1'],
    })
    const filePolicy = readTaskPolicy(store, fileOnly.childId)
    assert.equal(filePolicy.fileOnly, true)
    assert.equal(filePolicy.target, '')
    assert.deepEqual(filePolicy.scope.include, [])
    assert.equal(filePolicy.allowTargetNetwork, false)
    assert(store.db.prepare('SELECT 1 FROM business_materials WHERE session_id=? AND id=?').get(fileOnly.childId, 'file-1'))
    assert.equal(taskExecutionGuard(store, fileOnly.childId, 'read', Date.now(), {
      reserve: false, args: { file_path: 'material://file-1' },
    }), undefined)
  } finally {
    await workers.dispose()
  }
}))

await test('R06 selected material identity, digest revisions and exact repeats separate or reuse work', async () => memory(async store => {
  let starts = 0
  const services = {
    subagents: {
      async listDescendants() { return [] },
      async startActivation() {
        starts += 1
        return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
      },
      async drainChildren() {},
    },
    agents: { get() { return undefined } },
  }
  const workers = createSiteWorkers({ get(name) { return services[name] } }, () => store)
  const agent = {
    session: { id: 'r06-files', header: {} },
    ctx: { tools: { schemas: () => ['read', 'run_code', 'redteam_task', 'redteam_context', 'redteam_execution'].map(name => ({ name })) } },
  }
  const copiedIds = childId => store.db.prepare('SELECT id FROM business_materials WHERE session_id=? ORDER BY id').all(childId).map(row => row.id)
  try {
    start(store, 'r06-files', { target: 'https://app.example.test', budget: { workers: 3 } })
    saveTaskContext(store, 'r06-files', {
      assets: [{ id: 'app', url: 'https://app.example.test' }], requests: [], methods: [], checks: [],
    })
    for (const id of ['m1', 'm2', 'm3']) {
      store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
        .run('r06-files', id, 'https://app.example.test/' + id + '.js', id + '-digest', JSON.stringify({
          id, sourceUrl: 'https://app.example.test/' + id + '.js', digest: id + '-digest',
          site: 'https://app.example.test', hints: [], coverage: {},
        }))
    }
    const input = {
      assetIds: ['app'], focus: 'regular', question: 'review the selected material',
      reason: 'independent selected materials', need: 'large-site-materials',
    }
    const first = await workers.delegate(agent, { ...input, materialIds: ['m1'] })
    assert.deepEqual(copiedIds(first.childId), ['m1'])

    const repeated = await workers.delegate(agent, { ...input, materialIds: ['m1'] })
    assert.equal(repeated.reused, true)
    assert.equal(repeated.childId, first.childId)
    assert.equal(starts, 1)

    const second = await workers.delegate(agent, { ...input, materialIds: ['m2'] })
    assert.equal(second.reused ?? false, false)
    assert.notEqual(second.childId, first.childId)
    assert.deepEqual(copiedIds(second.childId), ['m2'])

    store.db.prepare('UPDATE business_materials SET digest=?,record=? WHERE session_id=? AND id=?')
      .run('m1-digest-v2', JSON.stringify({
        id: 'm1', sourceUrl: 'https://app.example.test/m1.js', digest: 'm1-digest-v2',
        site: 'https://app.example.test', hints: [], coverage: {},
      }), 'r06-files', 'm1')
    const revised = await workers.delegate(agent, { ...input, materialIds: ['m1'] })
    assert.equal(revised.reused ?? false, false)
    assert.notEqual(revised.childId, first.childId)
    assert.deepEqual(copiedIds(revised.childId), ['m1'])
    assert.equal(starts, 3)
    assert(!copiedIds(first.childId).includes('m3'))
    assert(!copiedIds(second.childId).includes('m3'))
    assert(!copiedIds(revised.childId).includes('m3'))
  } finally {
    await workers.dispose()
  }
}))

await test('U06 scope operations, total minutes, pending preservation and transactional apply agree', () => memory(store => {
  const before = start(store, 'changes')
  updateTaskFromChat(store, 'changes', { target: 'https://api.example.test' })
  updateTaskFromChat(store, 'changes', { explain: true })
  assert(readTaskPolicy(store, 'changes').pendingChange)
  applyPendingTaskChange(store, 'changes', 'desktop-user')
  let policy = readTaskPolicy(store, 'changes')
  assert(!taskScopeAllowsUrl(policy, 'https://app.example.test'))
  assert(taskScopeAllowsUrl(policy, 'https://api.example.test'))

  updateTaskFromChat(store, 'changes', { target: 'https://third.example.test', scopeOperation: 'append' })
  applyPendingTaskChange(store, 'changes', 'desktop-user')
  policy = readTaskPolicy(store, 'changes')
  assert(taskScopeAllowsUrl(policy, 'https://api.example.test'))
  assert(taskScopeAllowsUrl(policy, 'https://third.example.test'))

  updateTaskFromChat(store, 'changes', { target: 'https://third.example.test', scopeOperation: 'remove' })
  applyPendingTaskChange(store, 'changes', 'desktop-user')
  assert(!taskScopeAllowsUrl(readTaskPolicy(store, 'changes'), 'https://third.example.test'))

  updateTaskFromChat(store, 'changes', { mode: 'nday', minutes: 30 })
  applyPendingTaskChange(store, 'changes', 'desktop-user')
  policy = readTaskPolicy(store, 'changes')
  assert.equal(policy.mode, 'nday')
  assert.equal(policy.budget.deadline, before.startedAt + 30 * 60000)
  assert.equal(policy.startedAt, before.startedAt)
  assert.deepEqual(policy.used, before.used)

  updateTaskFromChat(store, 'changes', { target: 'https://fourth.example.test' })
  const pendingBefore = readTaskPolicy(store, 'changes').pendingChange
  store.db.exec("CREATE TRIGGER fail_pending_apply BEFORE UPDATE ON task_policy WHEN NEW.session_id='changes' BEGIN SELECT RAISE(ABORT,'injected pending failure'); END")
  assert.throws(() => applyPendingTaskChange(store, 'changes', 'desktop-user'), /injected pending failure/)
  assert.deepEqual(readTaskPolicy(store, 'changes').pendingChange, pendingBefore)
  store.db.exec('DROP TRIGGER fail_pending_apply')
}))

await test('U07 counts describe receipts and workers, and shrink with the current task scope', () => memory(store => {
  start(store, 'overview', { target: 'https://app.example.test' })
  saveTaskContext(store, 'overview', {
    assets: [
      { id: 'app', url: 'https://app.example.test/one' },
      { id: 'api', url: 'https://app.example.test/two' },
      { id: 'outside', url: 'https://outside.example.net/' },
    ],
    requests: [], methods: [], checks: [],
  })
  let overview = taskOverview(store, 'overview')
  assert.equal(overview.counts.assets, 2)
  assert.equal(overview.counts.runningWorkers, 0)
  assert.equal('processed' in overview.counts, false)
  assert.equal('validating' in overview.counts, false)
  setTaskActionLimits(store, 'overview', { target: 'https://outside.example.net' }, 'desktop-user')
  overview = taskOverview(store, 'overview')
  assert.equal(overview.counts.assets, 1)
}))

await test('U08 10, 100 and 1000-entry policies keep a bounded resident snapshot', () => memory(store => {
  const sizes = []
  for (const count of [10, 100, 1000]) {
    const id = 'large-' + count
    const entries = Array.from({ length: count }, (_, index) => `https://asset-${index}.example.test:8443/login?return=/portal`)
    start(store, id, { target: entries.join('\n') })
    const policy = readTaskPolicy(store, id)
    assert.equal(policy.scope.include.length, count)
    const prompt = taskPromptStable(taskPolicyStatus(store, id))
    const bytes = Buffer.byteLength(prompt)
    sizes.push(bytes)
    assert(bytes <= 7000, count + ' entries produced ' + bytes + ' bytes')
    assert(prompt.includes('完整') || prompt.includes('需要精确用量'))
    if (count > 12) assert.equal(taskScopePromptText(policy).includes(entries[count - 1]), false)
  }
  assert(sizes[2] - sizes[0] < 2000, 'snapshot growth is bounded across 10 to 1000 entries')
}))

await test('U09 settings are an exclusive, full-width, scroll-safe drawer with a sticky footer', () => {
  const source = fs.readFileSync(path.join(root, 'plugins/dsh-redteam-results/lib/client.js'), 'utf8')
  assert.match(source, /more\[1\]\(false\);inlineAssetView\[1\]\(false\);/)
  assert(source.includes('useEffect(function(){if(more[0]&&inlineAssetView[0])inlineAssetView[1](false);},[more[0],inlineAssetView[0]]);'))
  assert.match(source, /\.dsh-chat-target input,\.dsh-chat-target textarea\{display:block;width:100%/)
  assert.match(source, /\.dsh-chat-settings-body\{[^}]*overflow:auto/)
  assert.match(source, /\.dsh-chat-settings-actions\{[^}]*position:relative/)
  assert.match(source, /taskScopeDisplay\(overview\.scope/)
  assert.match(source, /工作区账本/)
  assert.match(source, /source\[1\]\('workspace'\);return load\(0,'workspace'\);/)
})

if (failed) {
  console.log(failed + ' workflow acceptance test(s) failed')
  process.exitCode = 1
} else {
  console.log('all workflow acceptance tests passed')
}
