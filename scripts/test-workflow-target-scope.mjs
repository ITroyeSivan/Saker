import assert from 'node:assert/strict'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { registerWorkflowTools } from '../plugins/dsh-redteam-results/lib/workflow/tools.js'

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + (error.stack || error)) }
}

await test('workflow start 带 target 时建立任务范围，供后续工具守卫使用', async () => {
  const store = openStore(':memory:')
  try {
    const tools = []
    registerWorkflowTools({ tools: { register: () => {} } }, {
      sessionOf: exec => exec?.session,
      store: () => store,
      liveTools: () => ['read', 'httpx_probe'],
      defineTool: definition => { tools.push(definition); return definition },
    })
    const tool = tools.find(item => item.name === 'saker_workflow')
    assert.ok(tool, 'saker_workflow registered')
    const result = await tool.execute(
      { action: 'start', workflowId: 'web-default', target: 'https://example.com' },
      { agent: { session: { id: 'workflow-scope-test', mode: 'pentest' } } },
    )
    assert.equal(result.ok, true)
    assert.equal(result.scopeStarted, 'https://example.com')
    const policy = readTaskPolicy(store, 'workflow-scope-test')
    assert.ok(policy, 'task policy created')
    assert.match(policy.target, /https:\/\/example\.com/)
    assert.equal(policy.allowTargetNetwork, true)
  } finally { store.db.close() }
})

await test('workflow start 无 target 时不伪造范围', async () => {
  const store = openStore(':memory:')
  try {
    const tools = []
    registerWorkflowTools({ tools: { register: () => {} } }, {
      sessionOf: exec => exec?.session,
      store: () => store,
      liveTools: () => ['read'],
      defineTool: definition => { tools.push(definition); return definition },
    })
    const tool = tools.find(item => item.name === 'saker_workflow')
    const result = await tool.execute(
      { action: 'start', workflowId: 'web-default' },
      { agent: { session: { id: 'workflow-no-scope', mode: 'pentest' } } },
    )
    assert.equal(result.ok, true)
    assert.equal(result.scopeStarted || '', '')
    assert.equal(readTaskPolicy(store, 'workflow-no-scope'), null)
  } finally { store.db.close() }
})

console.log(failed ? `\n${failed} failed` : '\nall workflow scope tests passed')
process.exit(failed ? 1 : 0)
