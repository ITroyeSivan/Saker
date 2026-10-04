import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCollector, readCollectorState, writeCollectorConfig, collectorPaths, collectorStatus, collectorResponse, readSourceHistory, readSourceRecord, querySourceCandidates } from '../plugins/dsh-nday-hunter/lib/source-pipeline.js'
import { fetchSourcePage } from '../plugins/dsh-nday-hunter/lib/source-pages.js'

const home = mkdtempSync(join(tmpdir(), 'nday-incremental-'))
const now = Date.parse('2026-10-01T00:00:00Z')
const requests = []
let phase = 'failure'
const cve = (id, status = 'Analyzed') => ({ cve: { id, vulnStatus: status, published: '2021-01-01T00:00:00Z',
  lastModified: '2026-09-30T00:00:00Z', descriptions: [{ lang: 'en', value: `${id} ${status}` }] } })
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  requests.push(url)
  res.setHeader('content-type', 'application/json')
  if (url.pathname.includes('/cves/')) {
    const index = Number(url.searchParams.get('startIndex'))
    if (phase === 'failure' && index === 2) { res.writeHead(503); res.end('{}'); return }
    const rows = phase === 'withdrawal' ? [cve('CVE-2021-1001', 'Rejected')]
      : index === 0 ? [cve('CVE-2021-1001'), cve('CVE-2021-1002')] : [cve('CVE-2021-1003')]
    res.end(JSON.stringify({ vulnerabilities: rows, startIndex: index, totalResults: phase === 'withdrawal' ? 1 : 3 }))
  } else if (url.pathname === '/advisories') {
    if (!url.searchParams.has('after')) {
      const next = new URL(`https://api.github.com/advisories?${url.searchParams}`)
      next.searchParams.set('after', 'cursor-1')
      res.setHeader('link', `<${next}>; rel="next"`)
    }
    res.end(JSON.stringify([{ ghsa_id: url.searchParams.has('after') ? 'GHSA-second' : 'GHSA-first',
      summary: 'irrelevant fixture', published_at: '2021-01-01T00:00:00Z', updated_at: '2026-09-30T00:00:00Z' }]))
  } else if (url.pathname.includes('known_exploited')) {
    res.end(JSON.stringify({ dateReleased: '2026-09-30', vulnerabilities: Array.from({ length: phase === 'kev-removal' ? 1 : 601 }, (_, i) => ({
      cveID: `CVE-2026-${1000 + i}`, vulnerabilityName: `fixture ${i}`, dateAdded: '2026-09-30' })) }))
  } else { res.writeHead(404); res.end('{}') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const proxyFetch = (url, options) => {
  const original = new URL(url)
  return fetch(`http://127.0.0.1:${server.address().port}${original.pathname}${original.search}`, options)
}
let failures = 0
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failures++; console.log('FAIL ' + name + ': ' + error.stack) }
}
try {
  writeCollectorConfig({ enabled: true, sources: ['nvd'], limit: 2, maxPagesPerRun: 5 }, home)
  await check('failed second page commits first page and cursor without advancing source watermark', async () => {
    const result = await runCollector({}, { home, now, fetchImpl: proxyFetch })
    assert.equal(result.ok, false)
    assert.equal(result.records.length, 2)
    assert.equal(result.checkpoints.nvd.watermark, null)
    assert.equal(result.checkpoints.nvd.window.cursor, '2')
    assert.equal(result.sources[0].status, 'partial-failed')
    assert.equal(result.summary.completeSources, 0)
  })
  await check('backoff prevents repeated network work and preserves pending page', async () => {
    const count = requests.length
    const result = await runCollector({}, { home, now: now + 1000, fetchImpl: proxyFetch })
    assert.equal(requests.length, count)
    assert.equal(result.sources[0].status, 'backoff')
    assert.equal(readCollectorState(home).checkpoints.nvd.window.cursor, '2')
  })
  await check('restart resumes persisted page in frozen modification window and only then advances watermark', async () => {
    phase = 'resume'
    const before = readCollectorState(home).checkpoints.nvd.window
    const count = requests.length
    const result = await runCollector({}, { home, now: now + 61000, fetchImpl: proxyFetch })
    assert.equal(requests.length, count + 1)
    const request = requests.at(-1)
    assert.equal(request.searchParams.get('startIndex'), '2')
    assert.equal(request.searchParams.get('lastModStartDate'), before.since)
    assert.equal(request.searchParams.get('lastModEndDate'), before.until)
    assert.equal(result.records.length, 3)
    assert.equal(result.checkpoints.nvd.watermark, before.until)
    assert.equal(result.checkpoints.nvd.window, null)
    assert.equal(result.sources[0].complete, true)
  })
  await check('modified old CVE and withdrawal replace current source record while preserving revisions', async () => {
    phase = 'withdrawal'
    const result = await runCollector({}, { home, now: now + 120000, fetchImpl: proxyFetch })
    assert.equal(result.records.length, 3)
    const row = result.candidates.find(item => item.id === 'CVE-2021-1001')
    assert.equal(row.status, 'Rejected')
    assert.equal(row.requiresSourceReview, true)
    const history = readSourceHistory('nvd', 'CVE-2021-1001', {}, home)
    assert.equal(history.length, 2)
    assert.equal(history[1].previousRevision, history[0].revision)
    assert.notEqual(history[1].revision, history[0].revision)
  })
  await check('GitHub follows Link cursor even when local filtering makes first page empty', async () => {
    const options = { query: 'never-matches', limit: 2, since: '2026-09-01T00:00:00Z', until: '2026-10-01T00:00:00Z', cursor: null }
    const first = await fetchSourcePage('github-advisories', options, proxyFetch)
    assert.equal(first.rows.length, 0)
    assert.equal(first.complete, false)
    assert.match(first.nextCursor, /after=cursor-1/)
    const second = await fetchSourcePage('github-advisories', { ...options, cursor: first.nextCursor }, proxyFetch)
    assert.equal(second.complete, true)
    assert.equal(requests.at(-1).searchParams.get('modified'), '2026-09-01..2026-10-01')
  })
  await check('untrusted or changed GitHub cursor is refused before a network request', async () => {
    const count = requests.length
    const options = { limit: 2, since: '2026-09-01', until: '2026-10-01' }
    await assert.rejects(fetchSourcePage('github-advisories', { ...options, cursor: 'https://evil.example/advisories' }, proxyFetch), /Untrusted/)
    await assert.rejects(fetchSourcePage('github-advisories', { ...options, cursor: 'https://api.github.com/advisories?modified=changed' }, proxyFetch), /changed/)
    assert.equal(requests.length, count)
  })
  await check('full KEV snapshot and later source failure retain more than 500 historical candidates', async () => {
    const snapshot = await runCollector({ sources: ['cisa-kev'], limit: 1 }, { home, now, fetchImpl: proxyFetch })
    assert.equal(snapshot.sources[0].complete, true)
    assert.equal(snapshot.recordCount, 604)
    assert.equal(snapshot.records.length, 20)
    const status = collectorStatus(home, now)
    assert.equal(status.recordCount, 604)
    assert.equal(status.candidateCount, 604)
    assert.deepEqual(status.candidates, [])
    assert.equal(status.records, undefined)
    const preview = collectorResponse(snapshot, { includeCandidates: true, limit: 20 })
    assert.equal(preview.candidates.length, 20)
    assert.equal(preview.candidatesTruncated, true)
    assert.equal(preview.candidateCount, 604)
    assert(!JSON.stringify(preview).includes('sourceRecords'))
    assert.equal(readCollectorState(home).recordCount, 604)
    let cursor = null, reached = 0
    do {
      const page = querySourceCandidates({ limit: 100, cursor }, home)
      reached += page.rows.length
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(reached, 604)
    const broken = await runCollector({ sources: ['cisa-kev'] }, { home, now: now + 1000, fetchImpl: async () => { throw new Error('offline') } })
    assert.equal(broken.ok, false)
    assert.equal(broken.recordCount, snapshot.recordCount)
    assert.equal(broken.candidateCount, snapshot.candidateCount)
    assert.equal(readSourceRecord('cisa-kev', 'CVE-2026-1600', home).id, 'CVE-2026-1600')
  })
  await check('complete catalog removals keep historical records and mark independent source review', async () => {
    phase = 'kev-removal'
    const result = await runCollector({ sources: ['cisa-kev'] }, { home, now: now + 62000, fetchImpl: proxyFetch })
    assert.equal(result.recordCount, 604)
    const removed = querySourceCandidates({ query: 'CVE-2026-1001' }, home).rows[0]
    assert.equal(removed.status, 'removed-from-current-catalog')
    assert.equal(removed.requiresSourceReview, true)
    assert.equal(readSourceRecord('cisa-kev', 'CVE-2026-1000', home).status, 'active')
  })
  await check('limited discovery never advances a watermark or forces one-minute re-fetches', async () => {
    const result = await runCollector({ sources: ['nuclei'] }, { home, now,
      fetchPage: async () => ({ rows: [], complete: false, nextCursor: null, coverage: 'limited-discovery' }) })
    assert.equal(result.sources[0].status, 'limited')
    assert.equal(result.checkpoints.nuclei.watermark, null)
    assert.equal(result.checkpoints.nuclei.window, null)
    assert.equal(Date.parse(result.nextDueAt), now + 24 * 3600000)
  })
  await check('damaged state refuses synchronization without overwriting evidence', async () => {
    const file = collectorPaths(home).state
    writeFileSync(file, '{invalid-json')
    let called = false
    await assert.rejects(runCollector({}, { home, now, fetchPage: async () => { called = true } }), /state unreadable/)
    assert.equal(called, false)
    assert.equal(readFileSync(file, 'utf8'), '{invalid-json')
  })
} finally {
  await new Promise(resolve => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
