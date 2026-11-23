import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { deriveRequest, importRequestMaterial } from '../plugins/dsh-redteam-results/lib/request-import.js'
import { executeRecordedRequest, readExecutionReceipt } from '../plugins/dsh-redteam-results/lib/execution-receipts.js'

const tmpRoot = fileURLToPath(new URL('../../_ref/tmp/', import.meta.url))
const work = fs.mkdtempSync(path.join(tmpRoot, 'request-import-test-'))
const materialFile = path.join(work, 'orders.http')
const materialFileBeta = path.join(work, 'orders-beta.http')
const secretToken = 'SECRET-TOKEN-DO-NOT-LEAK'
const secretCookie = 'SESSION=SECRET-COOKIE-DO-NOT-LEAK'
const received = []
const server = http.createServer((req, res) => {
  received.push({ method: req.method, url: req.url, headers: req.headers })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, owner: 'fixture' }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port
const endpoint = base + '/api/orders?owner=me'
const host = new URL(base).host
const raw = [
  'GET /api/orders?owner=me HTTP/1.1',
  'Host: ' + host,
  'Authorization: Bearer ' + secretToken,
  'Cookie: ' + secretCookie,
  'Accept: application/json',
  '',
  '',
].join('\r\n')
fs.writeFileSync(materialFile, raw, 'utf8')
fs.writeFileSync(materialFileBeta, raw.replace(secretToken, 'SECRET-TOKEN-BETA')
  .replace(secretCookie, 'SESSION=SECRET-COOKIE-BETA'), 'utf8')

const store = openStore(':memory:')
try {
  const digest = 'a'.repeat(64)
  store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
    .run('request-import', 'material-orders', 'local:orders.http', digest,
      JSON.stringify({ id: 'material-orders', file: materialFile, name: 'orders.http', digest, summary: { format: 'http' } }))
  store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
    .run('request-import', 'material-orders-beta', 'local:orders-beta.http', 'b'.repeat(64),
      JSON.stringify({ id: 'material-orders-beta', file: materialFileBeta, name: 'orders-beta.http', digest: 'b'.repeat(64), summary: { format: 'http' } }))
  startTaskPolicy(store, 'request-import', {
    mode: 'regular',
    target: base,
    question: '验证原始请求可按引用重放',
    budget: { toolCalls: 10 },
  })
  const imported = importRequestMaterial(store, 'request-import', { materialId: 'material-orders' })
  assert.equal(imported.requests.length, 1)
  assert.equal(imported.requests[0].method, 'GET')
  assert.equal(imported.requests[0].endpoint, endpoint)
  assert.match(imported.requests[0].credentialRef, /^credential-/)
  assert.deepEqual(imported.requests[0].credentialHeaderKinds.sort(), ['authorization', 'cookie'])
  const rendered = JSON.stringify(imported)
  assert(!rendered.includes(secretToken), 'import result must not expose Authorization')
  assert(!rendered.includes(secretCookie), 'import result must not expose Cookie')
  const importedBeta = importRequestMaterial(store, 'request-import', { materialId: 'material-orders-beta' })
  assert.notEqual(importedBeta.requests[0].requestRef, imported.requests[0].requestRef,
    'same public bytes with a different credential must produce a distinct requestRef')
  assert.notEqual(importedBeta.requests[0].credentialRef, imported.requests[0].credentialRef)

  const context = readTaskContext(store, 'request-import')
  const row = context.requests.find(item => item.id === imported.requests[0].requestId)
  assert(row)
  assert.equal(row.authContext, 'request-material')
  assert.match(row.request, /^GET \/api\/orders\?owner=me HTTP\/1\.1/)
  assert(!row.request.includes(secretToken), 'stored public request must not contain the token')
  assert(!row.request.includes(secretCookie), 'stored public request must not contain the cookie')

  const receipt = await executeRecordedRequest(store, 'request-import', {
    requestId: row.id,
    requestRevision: row.revision,
    purpose: 'first-contact',
  })
  assert.equal(receipt.status, 200)
  assert.equal(receipt.identitySource, 'request-material')
  assert.equal(receipt.identityBound, false)
  assert.equal(receipt.identityLabel, 'request-material')
  assert.equal(receipt.credentialRef, imported.requests[0].credentialRef)
  assert.equal(received.length, 1)
  assert.equal(received[0].headers.authorization, 'Bearer ' + secretToken)
  assert.equal(received[0].headers.cookie, secretCookie)
  const detail = readExecutionReceipt(store, 'request-import', receipt.id)
  assert.equal(detail.current, true)
  assert.equal(detail.integrityValid, true)
  assert(!detail.request.includes(secretToken), 'receipt wire request must keep secrets out')
  assert(!detail.request.includes(secretCookie), 'receipt wire request must keep cookies out')

  const reused = importRequestMaterial(store, 'request-import', { materialId: 'material-orders' })
  assert.equal(reused.requests[0].requestRef, imported.requests[0].requestRef)
  assert.equal(reused.requests[0].reused, true)
  const derived = deriveRequest(store, 'request-import', {
    sourceRequestRef: imported.requests[0].requestRef,
    query: { owner: 'beta' },
  })
  assert.match(derived.endpoint, /\?owner=beta$/)
  assert.equal(derived.credentialRef, imported.requests[0].credentialRef)
  const derivedReceipt = await executeRecordedRequest(store, 'request-import', {
    requestId: derived.requestId,
    requestRevision: derived.requestRevision,
  })
  assert.equal(derivedReceipt.status, 200)
  assert.equal(received.length, 2)
  assert.equal(received[1].url, '/api/orders?owner=beta')
  assert.equal(received[1].headers.authorization, 'Bearer ' + secretToken)
  const betaReceipt = await executeRecordedRequest(store, 'request-import', {
    requestId: importedBeta.requests[0].requestId,
    requestRevision: importedBeta.requests[0].requestRevision,
  })
  assert.equal(betaReceipt.status, 200)
  assert.equal(received.length, 3)
  assert.equal(received[2].headers.authorization, 'Bearer SECRET-TOKEN-BETA')
  console.log('ok   raw .http import produces requestRef/credentialRef without exposing secrets')
  console.log('ok   hidden request credential is applied at dispatch and omitted from receipt bytes')
  console.log('ok   derived query request keeps the credentialRef and changes only the selected input')
  console.log('ok   byte-identical public requests from two identities keep separate credentials')
} finally {
  store.close()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(work, { recursive: true, force: true })
}

console.log('\n4 request import checks passed')
