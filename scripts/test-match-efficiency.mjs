import assert from 'node:assert/strict'
import './test-home-isolation.mjs'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../plugins/dsh-nday-hunter/lib/index.js'
import { readCatalog, resolveSakerRoot } from '../plugins/dsh-nday-hunter/lib/catalog.js'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'match-efficiency-'))
const catalogFile = path.join(process.env.DSH_HOME, 'refs', 'pentest', 'nday', 'catalog.json')
const fixture = readCatalog(resolveSakerRoot()).entries[0]
const entries = Array.from({ length: 30 }, (_, i) => ({ ...fixture,
  id: `fixture-batch-${i}`, product: 'Controlled Fixture',
  fingerprint: { probes: [
    { id: 'positive', path: '/signal', method: 'GET', weight: 'medium', expect: { bodyContainsAny: ['observed-fixture'] } },
    { id: 'negative', path: '/signal', method: 'GET', weight: 'strong', expect: { bodyContainsAny: ['absent-fixture'] } },
  ] }, verify: { oob: [] }, exploit: { tools: [] }, measurementHints: [] }))
fs.mkdirSync(path.dirname(catalogFile), { recursive: true })
fs.writeFileSync(catalogFile, JSON.stringify({ schema: 'saker.nday.catalog/1', entries }))
let sent = 0, failed = 0
const server = http.createServer((req, res) => {
  sent++
  res.statusCode = req.url === '/signal' ? 200 : 404
  res.end(req.url === '/signal' ? 'observed-fixture' : 'control-fixture')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const tools = []
apply({ tools: { register: tool => tools.push(tool) }, effect() {} }, { exposedTools: ['nday_match'] })
async function check(name, fn) { try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.stack) } }
try {
  await check('production match keeps all 60 predicates with two physical requests and full ledger', async () => {
    const out = await tools[0].execute({ targets: `http://127.0.0.1:${server.address().port}`, scope: '127.0.0.1',
      workspace, entryIds: entries.map(entry => entry.id).join(','), rate: 100 })
    assert.equal(out.ok, true, out.error)
    assert.equal(sent, 2)
    assert.equal(out.summary.requests, 1); assert.equal(out.summary.probeEvaluations, 60)
    assert.equal(out.summary.requestsReused, 59); assert.equal(out.summary.totalRequests, 2)
    assert.equal(out.rows.length, 30)
    assert(out.rows.every(row => row.evidence.length === 1 && row.strongest === 'medium'))
    assert.equal(out.text.split('\n').filter(line => line.startsWith('- http://')).length, 12)
    assert(out.text.includes('其余 18 项见完整台账'))
    const ledger = JSON.parse(fs.readFileSync(path.join(workspace, out.ledger), 'utf8'))
    assert.equal(ledger.rows.length, 30); assert.equal(ledger.summary.totalRequests, sent)
    const rendered = tools[0].output.render({}, out)
    assert.equal(rendered[0].text, out.text)
  })
} finally {
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(workspace, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
