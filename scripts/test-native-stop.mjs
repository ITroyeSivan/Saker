import assert from 'node:assert/strict'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { startTaskPolicy, readTaskPolicy, updateTaskProgress } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { pauseRootForNativeStop } from '../plugins/dsh-redteam-results/lib/native-stop.js'

const store = openStore(':memory:')
let failed = 0
const test = (name, fn) => { try { fn(); console.log('ok   ' + name) } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) } }

test('an aborted native turn pauses the managed root and records the host signal', () => {
  startTaskPolicy(store, 'native-stop', { mode: 'regular', target: 'https://native.test', budget: { toolCalls: 10 } })
  const paused = pauseRootForNativeStop(store, 'native-stop')
  assert.equal(paused.blocker.code, 'needs-user')
  assert.match(paused.blocker.evidence, /turn-stopping/)
  assert.equal(paused.cancelled, false)
  assert.equal(pauseRootForNativeStop(store, 'native-stop'), null, 'a second stop must not overwrite the first blocker')
})

test('native stop does not pause a child purpose policy or an already cancelled root', () => {
  startTaskPolicy(store, 'native-child', { mode: 'regular', target: 'https://native.test', purposeTask: true, parentSession: 'native-stop', budget: { toolCalls: 5 } })
  assert.equal(pauseRootForNativeStop(store, 'native-child'), null)
  startTaskPolicy(store, 'native-cancelled', { mode: 'regular', target: 'https://native.test', budget: { toolCalls: 5 } })
  updateTaskProgress(store, 'native-cancelled', { cancelled: true })
  assert.equal(pauseRootForNativeStop(store, 'native-cancelled'), null)
  assert.equal(readTaskPolicy(store, 'native-cancelled').blocker, undefined)
})

store.close()
if (failed) process.exitCode = 1
console.log(failed ? `${failed} native stop test(s) failed` : 'all native stop tests passed')
