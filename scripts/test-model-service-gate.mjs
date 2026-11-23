import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { createModelServiceGate } from '../plugins/dsh-redteam-results/lib/model-budget.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-model-service-'))
const store = openStore(path.join(home, 'redteam-results', 'results.db'))
let failed = 0
const test = async (name, work) => { try { await work(); console.log('ok   ' + name) } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) } }

try {
  await test('two gate instances share one persistent service lease', async () => {
    const gateA = createModelServiceGate(() => store)
    const gateB = createModelServiceGate(() => store)
    const first = await gateA.acquire('model-service:fixture', 1)
    assert.equal(typeof first.release, 'function')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('fixture timeout')), 150)
    await assert.rejects(() => gateB.acquire('model-service:fixture', 1, controller.signal), /cancelled|timeout/)
    clearTimeout(timeout)
    first.release()
    const second = await gateB.acquire('model-service:fixture', 1, AbortSignal.timeout(1000))
    second.release()
    assert.equal(gateA.stats().find(row => row.key === 'model-service:fixture')?.active || 0, 0)
  })

  await test('a dead owner lease is pruned instead of blocking the service', async () => {
    const gate = createModelServiceGate(() => store)
    const now = Date.now()
    store.db.prepare('INSERT INTO model_service_leases(service_key,token,owner_pid,owner_runtime,expires_at,created_at,record) VALUES(?,?,?,?,?,?,?)')
      .run('model-service:dead', 'dead-token', 999999, 'test', now + 60000, now, '{}')
    const lease = await gate.acquire('model-service:dead', 1, AbortSignal.timeout(1000))
    lease.release()
  })

  await test('a live owner lease survives expiry until release', async () => {
    const gateA = createModelServiceGate(() => store)
    const gateB = createModelServiceGate(() => store)
    const lease = await gateA.acquire('model-service:live', 1)
    store.db.prepare("UPDATE model_service_leases SET expires_at=1 WHERE service_key='model-service:live'").run()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('still held')), 150)
    await assert.rejects(() => gateB.acquire('model-service:live', 1, controller.signal), /still held/)
    clearTimeout(timeout)
    lease.release()
  })
} finally {
  store.close()
  fs.rmSync(home, { recursive: true, force: true })
}
console.log(failed ? `${failed} model service test(s) failed` : 'all model service gate tests passed')
if (failed) process.exitCode = 1
