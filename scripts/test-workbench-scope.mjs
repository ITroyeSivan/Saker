// Regression probes for the 0.9.30 front-end scope/async fixes.
// These extract the production functions and drive them with a minimal hook
// scheduler. They are not a substitute for the official Desktop acceptance.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceFile = path.join(root, 'src', 'client', 'index.js')
const source = fs.readFileSync(sourceFile, 'utf8')

function fn(name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('missing production function ' + name)
  const end = source.indexOf('\nfunction ', start + 1)
  if (end < 0) throw new Error('missing function boundary ' + name)
  return source.slice(start, end)
}
function block(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error('missing source anchors ' + startMarker)
  return source.slice(start, end)
}
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false) })
function walk(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) walk(child, predicate, out)
  return out
}
const text = node => typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children || []).map(text).join('') : ''
class Hooks {
  cells = []; cursor = 0; effects = []
  useState = (initial) => {
    const i = this.cursor++
    if (!(i in this.cells)) this.cells[i] = { value: typeof initial === 'function' ? initial() : initial }
    return [this.cells[i].value, value => { this.cells[i].value = typeof value === 'function' ? value(this.cells[i].value) : value }]
  }
  useRef = (initial) => {
    const i = this.cursor++
    if (!(i in this.cells)) this.cells[i] = { ref: { current: initial } }
    return this.cells[i].ref
  }
  useEffect = (effect, deps) => {
    const i = this.cursor++
    const old = this.cells[i]
    if (!old || deps.some((x, n) => !Object.is(x, old.deps[n]))) {
      this.cells[i] = { deps, cleanup: old?.cleanup }
      this.effects.push(() => { old?.cleanup?.(); this.cells[i].cleanup = effect() })
    }
  }
  render(callback) {
    this.cursor = 0; this.effects = []
    const result = callback()
    for (const effect of this.effects) effect()
    return result
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
function context(extra = {}) {
  return vm.createContext({ h, JSON, Date, Math, Number, String, Array, Object, Set, Map, Promise, Error,
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) }, console, setTimeout, clearTimeout, ...extra })
}

let failed = 0
async function test(name, callback) {
  try { await callback(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}

await test('scope: switching ROOT-A to ROOT-B never returns A data as B', async () => {
  const hooks = new Hooks()
  const pending = []
  const ctx = context({
    useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect,
    scopeContextFor: () => Promise.resolve({}),
    api: (_name, payload) => new Promise(resolve => pending.push({ payload, resolve })),
  })
  for (const name of ['wbStableJson', 'wbQueryKey', 'wbResponseError', 'useWorkbenchQuery']) vm.runInContext(fn(name), ctx)
  const render = rootId => hooks.render(() => ctx.useWorkbenchQuery('roots.detail', { rootId }, 0, true))
  render('ROOT-A'); await flush()
  pending[0].resolve({ data: { root: { rootId: 'ROOT-A', title: 'A material' } } }); await flush()
  assert.equal(render('ROOT-A').data.root.rootId, 'ROOT-A')
  const firstB = render('ROOT-B')
  const pendingB = render('ROOT-B')
  assert.equal(firstB.data, null, 'B must not inherit A data')
  await flush()
  assert.equal(pendingB.data, null, 'B must not inherit A data while loading')
  pending[1].resolve({ data: { root: { rootId: 'ROOT-B', title: 'B material' } } }); await flush()
  assert.equal(render('ROOT-B').data.root.rootId, 'ROOT-B')
})

await test('scope: disabling a query invalidates its late response', async () => {
  const hooks = new Hooks()
  const pending = []
  const ctx = context({
    useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect,
    scopeContextFor: () => Promise.resolve({}),
    api: (_name, payload) => new Promise(resolve => pending.push({ payload, resolve })),
  })
  for (const name of ['wbStableJson', 'wbQueryKey', 'wbResponseError', 'useWorkbenchQuery']) vm.runInContext(fn(name), ctx)
  const render = enabled => hooks.render(() => ctx.useWorkbenchQuery('findings.list', { rootId: 'ROOT-A' }, 0, enabled, { page: { limit: 50 } }))
  render(true); await flush()
  render(false)
  pending[0].resolve({ data: [{ findingId: 'late' }] }); await flush()
  const after = render(false)
  assert.equal(after.data, null, 'a disabled/unmounted query must not surface a late response')
})

await test('module page: root change reloads and drops the previous task draft', async () => {
  const hooks = new Hooks()
  const calls = []
  const ctx = context({
    useState: hooks.useState, useEffect: hooks.useEffect, useRef: hooks.useRef,
    localStorage: { getItem: () => null, setItem: () => {} },
    api: async (_name, payload) => {
      calls.push(payload)
      return { data: { items: [{ id: 'from-' + payload.context.rootId, title: payload.context.rootId + '-only', source: 'custom', version: 1 }] },
        taxonomy: { primaryCategories: [] }, facetCounts: { categories: {}, subcategories: {} }, page: { total: 1, hasMore: false, nextCursor: null } }
    },
    SakerListToolbar: () => null, SakerQueryError: () => null, SakerPager: () => null, SakerMethodCombos: () => null,
  })
  vm.runInContext(fn('SakerModulesPage'), ctx)
  hooks.render(() => ctx.SakerModulesPage({ rootId: 'ROOT-A', tick: 0, run: () => {} })); await flush()
  hooks.render(() => ctx.SakerModulesPage({ rootId: 'ROOT-A', tick: 0, run: () => {} }))
  const tree = hooks.render(() => ctx.SakerModulesPage({ rootId: 'ROOT-B', tick: 0, run: () => {} })); await flush()
  const roots = calls.map(call => call.context.rootId)
  assert.ok(roots.includes('ROOT-B'), 'ROOT-B must trigger a request')
  assert.equal(text(tree).includes('ROOT-A-only'), false, 'A draft must not render under B')
})

await test('quick module picker: late JS response cannot overwrite FOFA', async () => {
  const pending = []
  const observed = {}
  const ctx = context({
    props: { sessionId: 'SESSION' }, scopeContextFor: () => Promise.resolve({}),
    moduleReq: { current: 0 }, moduleTimer: { current: null },
    moduleError: [null, x => { observed.error = x }], moduleList: [null, x => { observed.list = x }],
    chatError: x => String(x && x.error || x),
    api: (_name, payload) => new Promise(resolve => pending.push({ payload, resolve })),
  })
  vm.runInContext(block('  function loadModules(text,categoryValue,statusValue){', '  function openModules(){'), ctx)
  ctx.loadModules('JS', '', ''); ctx.loadModules('FOFA', '', ''); await flush()
  pending[1].resolve({ ok: true, data: { items: [{ id: 'asset-discovery' }], query: 'FOFA' } }); await flush()
  pending[0].resolve({ ok: true, data: { items: [{ id: 'js-analysis' }], query: 'JS' } }); await flush()
  assert.equal(observed.list.query, 'FOFA')
})

await test('unknown command: retry keeps the original commandId and queries it first', async () => {
  const calls = []
    const stored = new Map()
  let step = 0
  const ctx = context({
    scopeContextFor: () => Promise.resolve({}),
    wbCommandRecords: {},
      WB_COMMAND_STORAGE_PREFIX: 'saker.command.v1.',
      window: { localStorage: {
        getItem: key => stored.get(key) || null,
        setItem: (key, value) => stored.set(key, String(value)),
        removeItem: key => stored.delete(key),
      } },
    api: async (_name, payload) => {
      calls.push({ endpoint: _name, payload })
      step += 1
      if (step === 1) throw new Error('connection lost after dispatch')
      if (_name === 'workbench.query') return { ok: true, data: { status: 'unknown' } }
      return { ok: true, result: { accepted: true } }
    },
  })
  for (const name of ['wbStableJson', 'wbIntentKey', 'wbNewCommandId', 'wbResponseError', 'wbDispatchCommand',
    'wbReconcileCommand', 'wbCommandHash', 'wbCommandPayloadHasSecret', 'wbLoadPersistedCommand',
    'wbPersistUnknownCommand', 'wbClearPersistedCommand', 'wbCommand']) vm.runInContext(fn(name), ctx)
  await assert.rejects(() => ctx.wbCommand(null, 'work.retest', { rootId: 'ROOT' }, { findingRef: { id: 'F1' } }), /connection lost/)
  await ctx.wbCommand(null, 'work.retest', { rootId: 'ROOT' }, { findingRef: { id: 'F1' } })
  const first = calls[0]
  const status = calls.find(call => call.endpoint === 'workbench.query')
  const retried = calls[calls.length - 1]
  assert.ok(status, 'unknown retry must query command.status')
  assert.equal(first.payload.commandId, status.payload.context.commandId)
  assert.equal(first.payload.commandId, retried.payload.commandId)
})

await test('findings: local F001 from two roots get distinct React keys', () => {
  const ctx = context({ wbTime: x => x, wbVerificationLabel: x => x })
  vm.runInContext(fn('SakerFindingsTable'), ctx)
  const tree = ctx.SakerFindingsTable({ rows: [
    { sessionId: 'A', findingId: 'F001', title: 'A' }, { sessionId: 'B', findingId: 'F001', title: 'B' }], showRoot: true })
  const keys = walk(tree, node => node.type === 'tr').slice(1).map(node => node.props.key)
  assert.equal(keys.length, 2)
  assert.notEqual(keys[0], keys[1])
})

await test('traffic: rows expose a real detail action', () => {
  const ctx = context({ wbTime: x => x })
  vm.runInContext(fn('SakerTrafficTable'), ctx)
  let opened = null
  const tree = ctx.SakerTrafficTable({ rows: [{ rootId: 'R', id: 'E1', at: 1, method: 'GET', url: 'https://example.invalid', integrityValid: true }],
    onSelect: row => { opened = row } })
  const rows = walk(tree, node => node.type === 'tr').slice(1)
  assert.equal(rows.length, 1)
  assert.equal(typeof rows[0].props.onClick, 'function')
  rows[0].props.onClick()
  assert.equal(opened.id, 'E1')
})

await test('graph: 201 nodes are all rendered and zoom/fit controls exist', () => {
  const hooks = new Hooks()
  const ctx = context({ useState: hooks.useState, useRef: hooks.useRef })
  vm.runInContext(fn('wbGraphKindLabel'), ctx)
  vm.runInContext(fn('wbNodeStateLabel'), ctx)
  vm.runInContext(fn('SakerGraph'), ctx)
  const graph = { nodes: Array.from({ length: 201 }, (_, i) => ({ id: 'N' + i, kind: 'work', title: 'Work ' + i, state: 'active' })), edges: [] }
  const tree = hooks.render(() => ctx.SakerGraph({ graph }))
  const nodes = walk(tree, node => node.type === 'g' && node.props.role === 'button')
  assert.equal(nodes.length, 201)
  const labels = walk(tree, node => node.type === 'button').map(text)
  assert.ok(labels.includes('放大'))
  assert.ok(labels.includes('缩小'))
  assert.ok(labels.includes('适合视图'))
  assert.equal(text(tree).includes('共 201 个节点'), false, 'default limit is 300 so no truncation notice for 201')
})

await test('source: no first-root fallback remains in the workbench', () => {
  assert.equal(source.includes('rootRows[0]'), false)
  assert.equal(/setView\(item\.id\); setRootId\(""\)/.test(source), false)
  assert.equal(source.includes('h("SakerGraphInspector"'), false, 'graph inspector must be mounted as a component, not a host tag')
})

await test('state labels: role instance states render in Chinese', () => {
  const ctx = context()
  vm.runInContext(fn('wbNodeStateLabel'), ctx)
  assert.equal(ctx.wbNodeStateLabel('stopped'), '已停止')
  assert.equal(ctx.wbNodeStateLabel('active'), '进行中')
  assert.equal(ctx.wbNodeStateLabel('released'), '已释放')
  assert.equal(ctx.wbNodeStateLabel('cleanup-failed'), '释放未确认')
  assert.equal(ctx.wbNodeStateLabel('verified'), '已验证')
})

await test('search inputs do not query while an IME composition is active', () => {
  assert.match(source, /var composing = useRef\(false\)/)
  assert.match(source, /var scopeComposing = useRef\(false\)/)
  assert.match(source, /var composingSearch = useRef\(false\)/)
  assert.match(source, /composing\.current \|\| \(event\.nativeEvent && event\.nativeEvent\.isComposing\)/)
  assert.match(source, /scopeComposing\.current \|\| \(event\.nativeEvent && event\.nativeEvent\.isComposing\)/)
  assert.match(source, /composingSearch\.current \|\| \(event\.nativeEvent && event\.nativeEvent\.isComposing\)/)
})

console.log(failed ? `\n${failed} failed` : '\nall workbench scope tests passed')
process.exit(failed ? 1 : 0)
