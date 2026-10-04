import assert from 'node:assert/strict'
import http from 'node:http'
import { groupProbeRequests, executeProbeBatch } from '../plugins/dsh-nday-hunter/lib/probe-batch.js'

const request = (url, extra = {}) => ({ assetIndex: 0, entryIndex: 0,
  plan: { url, method: 'GET', timeoutMs: 1000 }, ...extra })
let failed = 0
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.stack) }
}
await check('transport identity preserves method, path case, vhost, identity and request content', () => {
  const one = request('http://example.test/A')
  const variants = [one, { ...one, entryIndex: 1 }, request('http://example.test/a'),
    request(one.plan.url, { hostHeader: 'other.test' }), request(one.plan.url, { authContext: 'account-a' }),
    { ...one, plan: { ...one.plan, method: 'HEAD' } },
    { ...one, plan: { ...one.plan, headers: { authorization: 'fixture-only' } } },
    { ...one, plan: { ...one.plan, body: 'different' } }]
  const groups = groupProbeRequests(variants)
  assert.equal(groups.length, 7)
  assert.equal(groups[0].consumers.length, 2)
})
await check('actual HTTP transport performs one request and retains every consumer; legacy strategy fails', async () => {
  let sent = 0, gates = 0
  const server = http.createServer((_req, res) => { sent++; res.end('observed-marker') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/same`
    const logical = Array.from({ length: 50 }, (_, entryIndex) => request(url, { entryIndex }))
    const mapLimit = async (items, _limit, run) => Promise.all(items.map(run))
    const run = groups => executeProbeBatch(groups, { mapLimit, concurrency: 2,
      rateGate: async () => { gates++ }, fetchProbe: async plan => ({ body: await (await fetch(plan.url)).text() }) })
    const outcomes = await run(groupProbeRequests(logical))
    assert.equal(sent, 1); assert.equal(gates, 1); assert.equal(outcomes.length, 50)
    assert.deepEqual(outcomes.map(row => row.entryIndex), logical.map(row => row.entryIndex))
    assert(outcomes.every(row => row.response.body === 'observed-marker'))
    // Reverse evidence: the old one-request-per-predicate schedule really sends
    // 50 HTTP requests; it cannot pass the same physical-count assertion.
    sent = 0
    await run(logical.map(item => ({ ...item, consumers: [item] })))
    assert.equal(sent, 50)
    assert.throws(() => assert.equal(sent, 1), /50 !== 1/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
if (failed) process.exitCode = 1
