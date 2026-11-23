import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { createWorkItem, beginAttempt } from '../plugins/dsh-redteam-results/lib/role-orchestration.js'
import { workbenchQuery } from '../plugins/dsh-redteam-results/lib/workbench.js'
import { registerWorkflowTools } from '../plugins/dsh-redteam-results/lib/workflow/tools.js'

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}

await test('探索图包含 work→attempt→子会话 receipt，并能定位真实引用', () => {
  const store = openStore(':memory:')
  try {
    const rootId = 'exploration-root'
    startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://example.com', budget: { workers: 1 } })
    const work = createWorkItem(store, rootId, { question: '验证探索图引用', target: 'https://example.com' }).work
    const attempt = beginAttempt(store, rootId, { workId: work.workId, childId: 'child-session-1' })
    store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(
      'child-session-1', 'execution-child-1',
      JSON.stringify({ request: 'GET https://example.com HTTP/1.1', status: 200, completedAt: '2026-11-14T00:00:00.000Z', outcome: 'response' }),
    )
    const graph = workbenchQuery({}, store, { kind: 'exploration.graph', context: { rootId } }).data[0]
    const kinds = graph.nodes.map(node => node.kind)
    assert.ok(kinds.includes('work'))
    assert.ok(kinds.includes('attempt'))
    assert.ok(kinds.includes('receipt'))
    assert.ok(graph.edges.some(edge => edge.from === work.workId && edge.to === attempt.attemptId && edge.kind === 'attempted'))
    assert.ok(graph.edges.some(edge => edge.from === attempt.attemptId && edge.to === 'execution-child-1' && edge.kind === 'produced'))
    const attemptNode = graph.nodes.find(node => node.kind === 'attempt')
    assert.ok(attemptNode.sourceRefs.some(ref => ref.kind === 'session' && ref.id === 'child-session-1'))
    const traffic = workbenchQuery({}, store, { kind: 'traffic.list', context: { rootId } }).data
    assert.ok(traffic.some(row => row.id === 'execution-child-1'), 'child receipt visible in traffic')
  } finally { store.db.close() }
})

await test('探索图包含真实 workflow run 与步骤状态', async () => {
  const store = openStore(':memory:')
  try {
    const rootId = 'exploration-workflow-root'
    startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://example.com', budget: { workers: 0 } })
    const tools = []
    registerWorkflowTools({ tools: { register: () => {} } }, {
      sessionOf: exec => exec?.session,
      store: () => store,
      liveTools: () => ['read'],
      defineTool: definition => { tools.push(definition); return definition },
    })
    const tool = tools.find(item => item.name === 'saker_workflow')
    const started = await tool.execute({ action: 'start', workflowId: 'web-default' },
      { agent: { session: { id: rootId, mode: 'pentest' } } })
    assert.equal(started.ok, true)
    const graph = workbenchQuery({}, store, { kind: 'exploration.graph', context: { rootId } }).data[0]
    assert.ok(graph.nodes.some(node => node.kind === 'workflow'), 'workflow node')
    assert.ok(graph.nodes.some(node => node.kind === 'step'), 'step node')
    assert.ok(graph.edges.some(edge => edge.kind === 'runs'))
    assert.ok(graph.edges.some(edge => edge.kind === 'contains' && edge.from.startsWith('workflow:')))
  } finally { store.db.close() }
})

await test('Finding 的 request 证据生成版本化请求节点，并由该节点连接自己的回执', () => {
  const store = openStore(':memory:')
  try {
    const rootId = 'exploration-finding-root'
    startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://example.com', budget: { workers: 0 } })
    const at = '2026-11-16T00:00:00.000Z'
    saveTaskContext(store, rootId, {
      assets: [{ id: 'site', url: 'https://example.com', inScope: true }], checks: [], methods: [],
      requests: [{ id: 'request-real-1', revision: 'r1', endpoint: 'https://example.com/api', authContext: 'anonymous',
        valid: true, request: 'GET /api HTTP/1.1\r\nHost: example.com\r\n\r\n', response: 'HTTP/1.1 200 OK\r\n\r\nok' }],
    })
    store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(
      rootId, 'receipt-real-1',
      JSON.stringify({ requestId: 'request-real-1', requestRevision: 'r1', request: 'GET https://example.com/api HTTP/1.1',
        status: 200, completedAt: at, integrityValid: true, outcome: 'response' }),
    )
    store.db.prepare(`INSERT INTO findings(session_id,id,mode,evidence_level,title,summary,severity,status,target,
      evidence_refs,description,poc,impact,evidence,created_at,updated_at,seq)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      rootId, 'finding-real-1', 'pentest', 'partial', '证据链发现', '', 'medium', 'pending',
      'https://example.com', JSON.stringify([{ kind: 'request', id: 'request-real-1', revision: 'r1' }]),
      '', '', '', '', at, at, 1,
    )
    const graph = workbenchQuery({}, store, { kind: 'exploration.graph', context: { rootId } }).data[0]
    assert.ok(graph.nodes.some(node => node.id === 'finding-real-1'))
    assert.ok(graph.nodes.some(node => node.id === 'receipt-real-1'))
    const requestNode = graph.nodes.find(node => node.kind === 'request'
      && node.requestId === 'request-real-1' && node.revision === 'r1')
    assert.ok(requestNode, 'Finding must link to its versioned request original')
    assert.ok(graph.edges.some(edge => edge.from === 'finding-real-1' && edge.to === requestNode.id
      && edge.kind === 'references'), 'Finding must reference the request original')
    assert.ok(graph.edges.some(edge => edge.from === requestNode.id && edge.to === 'receipt-real-1'
      && edge.kind === 'has-receipt'), 'Request original must link to its own receipt')
    assert.equal(graph.meta.unresolvedEvidence.length, 0)
    assert.equal(graph.meta.complete, true)
  } finally { store.db.close() }
})

await test('大图 fit 按容器计算，全图搜索可定位第 301 个未展开节点', () => {
  const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'index.js')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const start = source.indexOf('function SakerGraph(props)')
  const end = source.indexOf('\nfunction ', start + 1)
  assert.ok(start >= 0 && end > start)
  class Hooks {
    constructor() { this.cells = []; this.cursor = 0 }
    useState(initial) {
      const index = this.cursor++
      if (!(index in this.cells)) this.cells[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [this.cells[index].value, value => {
        this.cells[index].value = typeof value === 'function' ? value(this.cells[index].value) : value
      }]
    }
    useRef(initial) {
      const index = this.cursor++
      if (!(index in this.cells)) this.cells[index] = { ref: { current: initial } }
      return this.cells[index].ref
    }
    render(callback) {
      this.cursor = 0
      const result = callback()
      if (this.previousHookCount !== undefined && this.previousHookCount !== this.cursor) {
        throw new Error(`hook count changed from ${this.previousHookCount} to ${this.cursor}`)
      }
      this.previousHookCount = this.cursor
      return result
    }
  }
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined) })
  const walk = (node, predicate, output = []) => {
    if (!node || typeof node !== 'object') return output
    if (predicate(node)) output.push(node)
    for (const child of node.children || []) walk(child, predicate, output)
    return output
  }
  const text = node => typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children || []).map(text).join('') : ''
  const hooks = new Hooks()
  const context = vm.createContext({ h, useRef: hooks.useRef.bind(hooks), useState: hooks.useState.bind(hooks) })
  const helpersStart = source.indexOf('function wbGraphKindLabel(')
  const helpersEnd = source.indexOf('\nfunction ', source.indexOf('function wbNodeStateLabel(') + 1)
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart)
  vm.runInContext(source.slice(helpersStart, helpersEnd), context)
  vm.runInContext(source.slice(start, end), context)
  const graph = { nodes: Array.from({ length: 301 }, (_, index) => ({
    id: 'N' + index, kind: index === 300 ? 'finding' : 'work', title: index === 300 ? 'unique-tail-node' : 'Work ' + index,
    state: 'pending',
  })), edges: [] }
  let tree = hooks.render(() => context.SakerGraph({ graph }))
  const initialSvg = walk(tree, node => node.type === 'svg')[0]
  assert.ok(initialSvg.props.height < 10000, 'large graph should wrap into columns instead of a 20k-pixel single column')
  const fit = walk(tree, node => node.type === 'button' && text(node) === '适合视图')[0]
  fit.props.onClick()
  tree = hooks.render(() => context.SakerGraph({ graph }))
  const fittedSvg = walk(tree, node => node.type === 'svg')[0]
  assert.doesNotMatch(fittedSvg.props.style.transform, /scale\(1\)/)
  const search = walk(tree, node => node.type === 'input')[0]
  search.props.onChange({ target: { value: 'unique-tail-node' } })
  tree = hooks.render(() => context.SakerGraph({ graph }))
  assert.match(text(tree), /命中 1/)
  assert.match(text(tree), /unique-tail-node/)
  assert.doesNotMatch(text(tree), /命中 0/)
  assert.equal(walk(tree, node => node.type === 'g' && node.props.role === 'button').length, 301)
})

await test('空图到有图的更新不会改变 Hook 数量', () => {
  const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'index.js')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const start = source.indexOf('function SakerGraph(props)')
  const end = source.indexOf('\nfunction ', start + 1)
  class Hooks {
    constructor() { this.cells = []; this.cursor = 0 }
    useState(initial) {
      const index = this.cursor++
      if (!(index in this.cells)) this.cells[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [this.cells[index].value, value => {
        this.cells[index].value = typeof value === 'function' ? value(this.cells[index].value) : value
      }]
    }
    useRef(initial) {
      const index = this.cursor++
      if (!(index in this.cells)) this.cells[index] = { ref: { current: initial } }
      return this.cells[index].ref
    }
    render(callback) {
      this.cursor = 0
      const result = callback()
      if (this.previousHookCount !== undefined && this.previousHookCount !== this.cursor) {
        throw new Error(`hook count changed from ${this.previousHookCount} to ${this.cursor}`)
      }
      this.previousHookCount = this.cursor
      return result
    }
  }
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined) })
  const hooks = new Hooks()
  const context = vm.createContext({ h, useRef: hooks.useRef.bind(hooks), useState: hooks.useState.bind(hooks) })
  const helpersStart = source.indexOf('function wbGraphKindLabel(')
  const helpersEnd = source.indexOf('\nfunction ', source.indexOf('function wbNodeStateLabel(') + 1)
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart)
  vm.runInContext(source.slice(helpersStart, helpersEnd), context)
  vm.runInContext(source.slice(start, end), context)
  hooks.render(() => context.SakerGraph({ graph: { nodes: [], edges: [] } }))
  const tree = hooks.render(() => context.SakerGraph({ graph: {
    nodes: [{ id: 'R', kind: 'root', title: '任务根', state: 'active' }], edges: [],
  } }))
  assert.ok(tree)
})

await test('探索图不再静默截断工作、尝试、发现或回执', () => {
  const store = openStore(':memory:')
  try {
    const rootId = 'exploration-no-sampling-root'
    startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://example.com', budget: { workers: 0 } })
    for (let index = 0; index < 120; index += 1) {
      const work = createWorkItem(store, rootId, {
        title: '工作 ' + index, question: '核对独立事实 ' + index, target: 'https://example.com/' + index,
      }).work
      beginAttempt(store, rootId, { workId: work.workId, childId: 'child-sampling-' + index })
    }
    for (let index = 0; index < 90; index += 1) {
      const at = new Date(1700000000000 + index * 1000).toISOString()
      store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(
        rootId, 'receipt-sampling-' + index,
        JSON.stringify({ request: 'GET https://example.com/' + index + ' HTTP/1.1', status: 200,
          completedAt: at, integrityValid: true, outcome: 'response' }),
      )
      store.db.prepare(`INSERT INTO findings(session_id,id,mode,evidence_level,title,summary,severity,status,target,
        evidence_refs,description,poc,impact,evidence,created_at,updated_at,seq)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        rootId, 'finding-sampling-' + index, 'pentest', 'partial', '发现 ' + index, '', 'medium', 'pending',
        'https://example.com', '[]', '', '', '', '', at, at, index,
      )
    }
    const graph = workbenchQuery({}, store, { kind: 'exploration.graph', context: { rootId } }).data[0]
    assert.equal(graph.meta.complete, true)
    assert.equal(graph.meta.sourceCounts.work, 120)
    assert.equal(graph.meta.sourceCounts.attempt, 120)
    assert.equal(graph.meta.sourceCounts.finding, 90)
    assert.equal(graph.meta.sourceCounts.receipt, 90)
    assert.ok(graph.nodes.some(node => node.id === 'finding-sampling-89'))
    assert.ok(graph.nodes.some(node => node.id === 'receipt-sampling-89'))
  } finally { store.db.close() }
})

console.log(failed ? `\n${failed} failed` : '\nall exploration graph tests passed')
process.exit(failed ? 1 : 0)
