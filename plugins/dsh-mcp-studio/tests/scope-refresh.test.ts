import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StudioScope } from '../src/client/studio-scope.ts'

test('settings loaded once must refresh when another panel adds a server', async () => {
  let revision = 0
  let servers: Array<{ name: string }> = []
  const scope = new StudioScope(async () => ({ ok: true, value: { revision, value: { servers }, writable: true } }))
  await scope.refresh()
  assert.deepEqual((scope.getSnapshot().value as { servers: unknown[] }).servers, [])
  servers = [{ name: 'restored' }]
  revision = 1
  await scope.refresh()
  assert.deepEqual((scope.getSnapshot().value as { servers: unknown[] }).servers, servers)
  revision = 0
  servers = []
  await scope.refresh()
  assert.equal(scope.getSnapshot().revision, 1, 'a late old read must not revoke the current rows')
})
