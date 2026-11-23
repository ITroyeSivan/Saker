import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'src', 'client', 'index.js'), 'utf8')

function extract(name) {
  const start = source.indexOf('function ' + name + '(')
  const end = start >= 0 ? source.indexOf('\nfunction ', start + 1) : -1
  if (start < 0 || end < 0) throw new Error('missing client function: ' + name)
  return source.slice(start, end)
}

function storage() {
  const values = new Map()
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

function runtime(sharedStorage, apiHandler) {
  const calls = []
  const context = vm.createContext({
    JSON, Date, Math, String, Object, Array, Promise, Error, console,
    window: { localStorage: sharedStorage },
    WB_COMMAND_STORAGE_PREFIX: 'saker.command.v1.',
    wbCommandRecords: {},
    crypto: { randomUUID },
    scopeContextFor: () => Promise.resolve({}),
    api: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return apiHandler(endpoint, payload, calls)
    },
  })
  for (const name of [
    'wbStableJson', 'wbIntentKey', 'wbNewCommandId', 'wbResponseError',
    'wbDispatchCommand', 'wbReconcileCommand', 'wbCommandHash',
    'wbCommandPayloadHasSecret', 'wbLoadPersistedCommand', 'wbPersistUnknownCommand',
    'wbClearPersistedCommand', 'wbCommand',
  ]) vm.runInContext(extract(name), context)
  return { context, calls }
}

let failed = 0
async function test(name, callback) {
  try {
    await callback()
    console.log('ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL ' + name + ': ' + (error.stack || error.message))
  }
}

await test('未知命令跨模块重载保留原 commandId，并先恢复服务端结果', async () => {
  const shared = storage()
  let firstCommandId = ''
  const first = runtime(shared, async () => {
    throw new Error('connection lost after dispatch')
  })
  await assert.rejects(
    () => first.context.wbCommand(null, 'work.retest', { rootId: 'R', sessionId: 'R' }, { findingRef: { id: 'F1' } }),
    error => error && error.unknown === true && Boolean(error.commandId),
  )
  firstCommandId = first.calls[0].payload.commandId
  const persisted = [...shared.values.values()][0]
  assert.ok(persisted && persisted.includes(firstCommandId))
  assert.doesNotMatch(persisted, /"context"|"payload"|authorization|cookie|secret|password/i,
    'recovery pointer must not persist the original context, payload or credentials')

  const second = runtime(shared, async () => ({
    ok: true,
    data: { status: 'completed', result: { accepted: true, recovered: true } },
  }))
  const recovered = await second.context.wbCommand(
    null, 'work.retest', { rootId: 'R', sessionId: 'R' }, { findingRef: { id: 'F1' } },
  )
  assert.deepEqual(recovered, { accepted: true, recovered: true })
  assert.equal(second.calls.length, 1)
  assert.equal(second.calls[0].endpoint, 'workbench.query')
  assert.equal(second.calls[0].payload.kind, 'command.status')
  assert.equal(second.calls[0].payload.context.commandId, firstCommandId)
  assert.equal(shared.values.size, 0, 'successful recovery clears the non-secret pointer')
})

await test('敏感上下文不写入本地恢复指针', async () => {
  const shared = storage()
  const runtimeA = runtime(shared, async () => {
    throw new Error('connection lost')
  })
  await assert.rejects(
    () => runtimeA.context.wbCommand(null, 'work.retest',
      { rootId: 'R', sessionId: 'R', authorization: 'Bearer should-not-stick' },
      { findingRef: { id: 'F1' }, cookie: 'should-not-stick' }),
  )
  assert.equal(shared.values.size, 0)
})

console.log(failed ? `\n${failed} failed` : '\nall command recovery tests passed')
process.exit(failed ? 1 : 0)
