import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../plugins/dsh-nday-hunter/lib/index.js'
import { readCatalog, resolveSakerRoot } from '../plugins/dsh-nday-hunter/lib/catalog.js'
import { buildPriorityPlan } from '../plugins/dsh-nday-hunter/lib/priority.js'
import { buildAttackPlan } from '../plugins/dsh-nday-hunter/lib/plan.js'
import { selectReconCandidates } from '../plugins/dsh-nday-hunter/lib/recon-candidates.js'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-routing-'))
const base = readCatalog(resolveSakerRoot()).entries[0]
const entry = (id, product, route) => ({ ...base, id, product, aliases: [product], vendor: 'Common Vendor',
  fingerprint: { probes: [{ id: 'identity-marker', path: route, method: 'GET', weight: 'medium', expect: { bodyContainsAny: [product] } }] },
  exploit: { tools: [] }, verify: { oob: [] }, measurementHints: [], publishedAt: '2010-01-01' })
const entries = [entry('fixture-a', 'ProductAlpha', '/alpha'), entry('fixture-b', 'ProductBeta', '/beta'),
  entry('generic-java', 'Java', '/generic'), ...Array.from({ length: 40 }, (_, i) => entry(`irrelevant-${i}`, `OtherProduct${i}`, `/other-${i}`))]
const catalogFile = path.join(process.env.DSH_HOME, 'refs', 'pentest', 'nday', 'catalog.json')
fs.mkdirSync(path.dirname(catalogFile), { recursive: true })
fs.writeFileSync(catalogFile, JSON.stringify({ schema: 'saker.nday.catalog/1', entries }))
let mode = 'known', requests = [], failed = 0
const server = http.createServer((req, res) => {
  requests.push({ url: req.url, host: req.headers.host })
  const beta = String(req.headers.host).startsWith('beta.test')
  const product = beta ? 'ProductBeta' : 'ProductAlpha'
  if (mode === 'blocked') { res.writeHead(403); res.end('access denied ProductAlpha'); return }
  if (req.url === '/' && mode === 'unknown') {
    res.end('<title>Java nginx OA</title><form action="/api/import"><input name="file"></form>'); return
  }
  if (req.url === '/') { res.end(`<title>${product}</title>`); return }
  if (req.url === (beta ? '/beta' : '/alpha')) { res.end(product); return }
  res.writeHead(404); res.end('not found')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const target = `http://127.0.0.1:${server.address().port}`
const tools = new Map()
apply({ tools: { register: tool => tools.set(tool.name, tool) }, effect() {} }, { exposedTools: ['nday_match', 'nday_priority_plan'] })
const args = { targets: target, scope: '127.0.0.1', workspace, rate: 100 }
async function check(name, fn) { try { requests = []; await fn(); console.log('ok   ' + name) }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.stack) } }
try {
  await check('generic terms, vendor words and chosen hostnames cannot select products or launch agents', () => {
    assert.equal(selectReconCandidates(entries, { title: 'Common Vendor Java nginx OA', host: 'productalpha.test' }).length, 0)
    assert.equal(selectReconCandidates([entry('prefix', 'weaver', '/x')], { title: 'SAP NetWeaver' }).length, 0)
    const plan = buildAttackPlan(entries, [{ id: 'asset', target, tech: ['ProductAlpha'] }])
    assert.deepEqual(plan.buckets.map(row => row.entryId), ['fixture-a'])
    assert.equal(plan.buckets[0].owner, 'main')
  })
  await check('cold relevant entry survives hot unrelated ranking and unknown context never yields full-catalog queries', () => {
    const hot = entries.slice(1).map(row => ({ ...row, publishedAt: '2026-10-01' }))
    const catalog = { entries: [entries[0], ...hot] }
    const plan = buildPriorityPlan(catalog, { maxCandidates: 1,
      verificationContext: JSON.stringify({ assets: [{ id: 'a', url: target, tech: ['ProductAlpha'] }] }) })
    assert.deepEqual(plan.candidates.map(row => row.id), ['fixture-a'])
    const unknown = buildPriorityPlan(catalog, { verificationContext: { assets: [{ id: 'a', url: target, tech: ['Java'] }] } })
    assert.equal(unknown.candidates.length, 0); assert.equal(unknown.queries.length, 0)
    assert.equal(unknown.reconGaps[0].productState, 'unknown')
    assert.equal(unknown.componentHypotheses[0].component, 'log4j-core')
    assert.equal(unknown.componentHypotheses[0].state, 'unknown')
  })
  await check('production default identifies once and screens only related product, retaining component gap', async () => {
    const out = await tools.get('nday_match').execute(args)
    assert.equal(out.ok, true, out.error); assert.equal(requests.length, 3)
    assert.equal(out.summary.discoveryRequests, 1); assert.equal(out.summary.entries, 1)
    assert.deepEqual(out.rows.map(row => row.entryId), ['fixture-a'])
    assert(requests.every(row => row.url === '/' || row.url === '/alpha' || row.url.startsWith('/.saker-control-')))
    assert.equal(out.reconGaps[0].componentState, 'unassessed')
  })
  await check('unknown product records observed input route after one request, no blind catalog fallback', async () => {
    mode = 'unknown'
    const out = await tools.get('nday_match').execute(args)
    assert.equal(out.ok, true, out.error); assert.equal(requests.length, 1)
    assert.equal(out.summary.entries, 0); assert.equal(out.summary.controlRequests, 0)
    assert.equal(out.reconGaps[0].productState, 'unknown'); assert.equal(out.reconGaps[0].inputObserved, true)
    assert(out.reconGaps[0].surfaces.includes(target + '/api/import'))
    assert.equal(out.reconGaps[0].nextAction, 'observe-valid-input-and-auth-context')
    assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, out.ledger))).discoveryRecords.length, 1)
  })
  await check('access failure stays blocked despite branded error page, never a product hit or refutation', async () => {
    mode = 'blocked'
    const out = await tools.get('nday_match').execute(args)
    assert.equal(out.ok, true, out.error); assert.equal(requests.length, 1)
    assert.equal(out.rows.length, 0); assert.equal(out.reconGaps[0].blocked, 'access-blocked')
    assert(out.text.includes('resolve-access-or-transport'))
  })
  await check('real virtual hosts retain independent routing; inventory clues skip rediscovery and constrain priority tool', async () => {
    mode = 'known'
    fs.writeFileSync(path.join(workspace, 'asset-inventory.json'), JSON.stringify({ schema: 'saker.asset-inventory/1', assets: [
      { id: 'alpha', target, host: 'alpha.test', tech: ['ProductAlpha'] },
      { id: 'beta', target, host: 'beta.test', tech: ['ProductBeta'] },
    ] }))
    const out = await tools.get('nday_match').execute({ ...args, assetSource: 'inventory', scope: '*.test' })
    assert.equal(out.ok, true, out.error); assert.equal(out.summary.assets, 2)
    assert.equal(out.summary.discoveryRequests, 0); assert.equal(requests.length, 4)
    assert.deepEqual(out.rows.map(row => row.entryId).sort(), ['fixture-a', 'fixture-b'])
    assert(requests.some(row => row.host.startsWith('alpha.test') && row.url === '/alpha'))
    assert(requests.some(row => row.host.startsWith('beta.test') && row.url === '/beta'))
    assert(!requests.some(row => row.host.startsWith('alpha.test') && row.url === '/beta'))
    const priority = await tools.get('nday_priority_plan').execute({ workspace, scope: '*.test' })
    assert.equal(priority.ok, true, priority.error)
    assert.deepEqual(priority.plan.candidates.map(row => row.id).sort(), ['fixture-a', 'fixture-b'])
  })
  await check('too many unknown assets reject before sending any baseline and do not silently truncate', async () => {
    const out = await tools.get('nday_match').execute({ ...args, targets: Array.from({ length: 33 }, (_, i) => `http://unknown${i}.test`).join(','), scope: '*.test' })
    assert.equal(out.ok, false); assert(out.error.includes('请求上限')); assert.equal(requests.length, 0)
  })
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(workspace, { recursive: true, force: true }) }
if (failed) process.exitCode = 1
