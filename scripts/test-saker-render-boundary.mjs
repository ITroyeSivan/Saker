import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
const start = source.indexOf('class SakerRenderBoundary')
const end = source.indexOf('function SakerWorkbenchPage', start)
assert(start >= 0 && end > start, 'render boundary source must exist')

const React = {
  Component: class Component {
    constructor(props) { this.props = props || {}; this.state = {} }
    setState(patch) { this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) } }
  },
  createElement(type, props, ...children) {
    const normalized = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
    const nextProps = { ...(props || {}) }
    if (normalized.length) nextProps.children = normalized.length === 1 ? normalized[0] : normalized
    return { type, props: nextProps, children: normalized }
  },
}
const sandbox = { React, h: React.createElement, console: { error() {} } }
vm.runInNewContext(source.slice(start, end) + ';this.Boundary=SakerRenderBoundary;this.Content=SakerBoundaryContent;', sandbox)
const Boundary = sandbox.Boundary
const Content = sandbox.Content

function text(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return (node.children || []).map(text).join('')
}

function renderNode(node) {
  if (node === null || node === undefined || node === false) return node
  if (typeof node === 'string' || typeof node === 'number') return node
  const type = node.type
  if (typeof type !== 'function') return { ...node, children: node.children.map(renderNode) }
  const instance = new type(node.props)
  if (typeof type.getDerivedStateFromError === 'function') {
    try {
      return renderNode(instance.render())
    } catch (error) {
      instance.state = { ...instance.state, ...type.getDerivedStateFromError(error) }
      return renderNode(instance.render())
    }
  }
  return renderNode(instance.render ? instance.render() : type(node.props))
}

function mount(build, props = {}) {
  const tree = React.createElement(Boundary, props, React.createElement(Content, { build }))
  return { tree: renderNode(tree), boundary: new Boundary(props) }
}

function findButton(node, label) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'button' && text(node).includes(label)) return node
  for (const child of node.children || []) {
    const hit = findButton(child, label)
    if (hit) return hit
  }
  return null
}

let ok = 0
let fail = 0
function test(name, work) {
  try { work(); ok += 1; console.log('ok   ' + name) }
  catch (error) { fail += 1; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) }
}

test('正常页面由边界内构建函数渲染', () => {
  const { tree } = mount(() => React.createElement('div', null, '执行表正常数据'))
  assert.match(text(tree), /执行表正常数据/)
  assert.doesNotMatch(text(tree), /当前页加载失败/)
})

test('生产接线把整页构建函数放进边界内部', () => {
  assert(source.includes('function buildPageContent()'))
  assert(source.includes('h(SakerBoundaryContent, { build: buildPageContent })'))
  assert(!source.includes('h(SakerRenderBoundary, {') || !source.includes('}, pageContent)'))
})

test('构建阶段异常被边界捕获并保留重试与返回', () => {
  const { tree } = mount(() => { throw new Error('SYNTHETIC_RENDER_FAILURE') })
  const rendered = text(tree)
  assert.match(rendered, /当前页加载失败/)
  assert.match(rendered, /SYNTHETIC_RENDER_FAILURE/)
  assert.equal(findButton(tree, '重试')?.type, 'button')
  assert.equal(findButton(tree, '返回测试任务')?.type, 'button')
})

test('重试重建当前页面且不依赖旧错误状态', () => {
  let calls = 0
  let retried = 0
  const tree = renderNode(React.createElement(Boundary, { onRetry() { retried += 1 } },
    React.createElement(Content, { build() {
      calls += 1
      if (calls === 1) throw new Error('FIRST_RENDER_FAILED')
      return React.createElement('div', null, '恢复后的执行表')
    } })))
  assert.match(text(tree), /当前页加载失败/)
  findButton(tree, '重试').props.onClick()
  assert.equal(retried, 1)
  const recovered = renderNode(React.createElement(Boundary, { onRetry() {} },
    React.createElement(Content, { build() { return React.createElement('div', null, '恢复后的执行表') } })))
  assert.match(text(recovered), /恢复后的执行表/)
})

test('返回动作由外层导航处理，不重放页面动作', () => {
  let backed = 0
  const tree = renderNode(React.createElement(Boundary, { onBack() { backed += 1 } },
    React.createElement(Content, { build() { throw new Error('BROKEN_ROW') } })))
  findButton(tree, '返回测试任务').props.onClick()
  assert.equal(backed, 1)
})

console.log(`\n${ok}/${ok + fail} 项通过`)
process.exit(fail ? 1 : 0)
