import assert from 'node:assert/strict'
import { verificationBasis } from '../lib/verification-basis.mjs'
import { parseQueryExpression, everyBranchHasField } from '../lib/query-expression.mjs'
import { buildQueries } from '../plugins/dsh-hunter/lib/adapters.js'
import { parseMeasurementHints, buildCampaignNdayQueries, buildNdaySearchPlan } from '../plugins/dsh-nday-hunter/lib/measurement-query.js'
import { entryTiming, isDomesticEntry, scoreEntry, buildPriorityPlan } from '../plugins/dsh-nday-hunter/lib/priority.js'

let pass = 0, fail = 0
function test(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name) }
  catch (error) { fail++; console.log('FAIL ' + name + ': ' + error.message) }
}
// Evaluate product membership to catch widening/narrowing, not merely a string match.
function matches(tree, record) {
  if (tree.type === 'and') return matches(tree.left, record) && matches(tree.right, record)
  if (tree.type === 'or') return matches(tree.left, record) || matches(tree.right, record)
  if (tree.type === 'not') return !matches(tree.value, record)
  const value = String(record[tree.field] ?? '')
  if (tree.op === '==') return value === tree.value
  if (tree.op === '!=') return !value.includes(tree.value)
  return value.includes(tree.value)
}
test('authored OR/exact expression preserves result membership through provider compilation', () => {
  const authored = '(body="ProductA" || header="ProductA") && title=="Admin"'
  const [extracted] = parseMeasurementHints(['fofa: ' + authored])
  assert(extracted)
  const query = buildQueries(extracted).fofa
  for (const body of ['ProductA', 'unrelated']) for (const header of ['ProductA', 'unrelated']) for (const title of ['Admin', 'Admin old']) {
    const record = { body, header, title }
    assert.equal(matches(parseQueryExpression(query), record), matches(parseQueryExpression(authored), record), JSON.stringify(record))
  }
  assert.equal(parseMeasurementHints(['fofa: ' + authored]).length, 1)
})
test('duplicate fields remain separate clauses instead of overwriting each other', () => {
  const query = buildQueries('body:"alpha" body:"beta"').fofa
  const tree = parseQueryExpression(query)
  assert(!matches(tree, { body: 'alpha' }))
  assert(!matches(tree, { body: 'beta' }))
  assert(matches(tree, { body: 'alpha beta' }))
})
test('malformed expressions reject all of the authored fingerprint', () => {
  for (const expression of ['title="a" ||', '(title="a"', 'body="a" && unknown="b"', 'body="a" XOR title="b"']) {
    assert.throws(() => buildQueries(expression))
    assert.deepEqual(parseMeasurementHints(['fofa: ' + expression]), [], expression)
  }
  assert.throws(() => buildQueries('garbage body:"valid"'))
})
test('unsupported fields/operators never partially downgrade to another provider', () => {
  const fields = buildQueries('body:"a" || fid:"b"')
  assert.equal(fields.hunter, '')
  assert.equal(fields.quake, '')
  const exact = buildQueries('title=="a"')
  assert.equal(exact.hunter, '')
  assert.equal(exact.quake, '')
  assert(buildQueries('title:"a" || body:"b"').hunter.includes(' || '))
})
test('an invalid authored query stays blocked instead of silently falling back to a broad product name', () => {
  const entry = { id: 'broken', product: 'Example Product', aliases: ['Example Product'], status: 'normalized', vulnClass: 'RCE',
    fingerprint: { signals: ['fofa: body="Example" && unknown="value"'], probes: [{ method: 'GET', expect: { bodyContainsAny: ['Example Product'] } }] } }
  const catalog = { entries: [entry] }
  const search = buildNdaySearchPlan(catalog, { focus: 'all' })
  assert.equal(search.selected.length, 0)
  assert.equal(search.rejectedHints[0].entryId, 'broken')
  const ranked = buildPriorityPlan(catalog)
  assert.equal(ranked.queries.length, 0)
  assert.equal(ranked.rejectedHints[0].entryId, 'broken')
})
test('organization condition constrains every product branch', () => {
  const rows = buildCampaignNdayQueries({ selected: [{ query: 'body="A" || header="B"', entryIds: ['v'] }] }, { domains: ['example.com'] })
  assert.equal(rows.length, 1)
  const tree = parseQueryExpression(buildQueries(rows[0].query).fofa)
  assert(!matches(tree, { body: 'A', domain: 'other.com' }))
  assert(!matches(tree, { header: 'B', domain: 'other.com' }))
  assert(matches(tree, { header: 'B', domain: 'example.com' }))
  const identities = new Set(['domain'])
  assert(everyBranchHasField(tree, identities))
  assert(!everyBranchHasField(parseQueryExpression('domain=="example.com" || body="A"'), identities))
  assert(!everyBranchHasField(parseQueryExpression('domain!="example.com"'), identities))
})
test('identity union covers all facets and distinct products before exhausting query cap', () => {
  const selected = Array.from({ length: 30 }, (_, i) => ({ query: `title:"p${i}"`, entryIds: ['p' + i] }))
  const rows = buildCampaignNdayQueries({ selected }, { domains: ['example.com'], icp: 'ICP', organizationName: 'Org' }, 20)
  assert.equal(rows.length, 20)
  assert.equal(new Set(rows.flatMap(row => row.entryIds)).size, 20)
  assert(rows.every(row => row.query.includes('domain:') && row.query.includes('icp:') && row.query.includes('cert.subject.org:')))
  const tree = parseQueryExpression(buildQueries(rows[0].query).fofa)
  assert(matches(tree, { title: 'p0', domain: 'example.com' }))
  assert(matches(tree, { title: 'p0', icp: 'ICP' }))
  assert(!matches(tree, { title: 'p0', domain: 'unrelated.com' }))
})
const now = Date.parse('2026-10-01T00:00:00Z')
const base = { id: 'old', product: 'Example Gateway', vendor: 'Example Vendor', ids: { cve: 'CVE-2021-99999' },
  vulnClass: 'RCE', status: 'normalized', severity: { cvss31: 9.8 }, publishedAt: '2021-01-01', fingerprint: { signals: ['fofa: body="Example Gateway"'] } }
test('actual disclosure date wins over identifier year and review/import dates', () => {
  const backdated = { ...base, publishedAt: '2026-09-20', retrievedAt: '2026-10-01' }
  assert.equal(entryTiming(backdated, now).ageDays, 11)
  const reimported = { ...base, updatedAt: '2026-09-30', lastReviewed: '2026-09-30', sources: [{ title: '2026 writeup', retrieved: '2026-09-30' }] }
  assert(entryTiming(reimported, now).ageDays > 1000)
})
test('verified new exploitation can promote an old CVE without relabeling disclosure', () => {
  const updated = { ...base, developments: [{ kind: 'public-poc', at: '2026-09-30', verified: true }] }
  assert.equal(entryTiming(updated, now).ageDays, 1)
  assert(entryTiming(updated, now).disclosedAt.startsWith('2021'))
  assert(scoreEntry(updated, { now }).score > scoreEntry(base, { now }).score)
  assert(entryTiming({ ...base, developments: [{ kind: 'public-poc', at: '2026-09-30', verified: false }] }, now).ageDays > 1000)
})
test('unknown/future dates do not establish freshness', () => {
  assert.equal(entryTiming({ ids: { cve: 'CVE-2026-0001' }, publishedAt: '2099-01-01' }, now).ageDays, null)
  assert.equal(scoreEntry({ ...base, publishedAt: undefined }, { now }).timing.basis, 'unknown')
})
test('category and article keywords cannot contaminate vendor or product relevance', () => {
  const contaminated = { ...base, product: 'Foreign App', vendor: 'Foreign Inc', category: '国产信创 Java TongWeb', sources: [{ title: '国产 TongWeb 替代方案' }] }
  assert(!isDomesticEntry(contaminated))
  assert(!scoreEntry(contaminated, { targetTerms: 'TongWeb', now }).targetFit)
})
test('high impact outranks isolated CORS/TLS observations at equal cost and freshness', () => {
  const high = { ...base, publishedAt: '2026-09-30' }
  const low = { ...high, id: 'cors', vulnClass: 'CORS configuration', severity: { cvss31: 9.8 } }
  assert(scoreEntry(high, { now }).score > scoreEntry(low, { now }).score)
})
test('Java clue creates an unknown Log4j component branch without claiming vulnerability or spawning workers', () => {
  const plan = buildPriorityPlan({ entries: [base] }, { targetTerms: 'Java', now })
  assert.equal(plan.componentHypotheses[0].component, 'log4j-core')
  assert.equal(plan.componentHypotheses[0].state, 'unknown')
  assert(!plan.candidates[0].targetFit)
  assert.equal(plan.subagentPlan.workers.length, 0)
  assert.equal(plan.task.mode, 'nday')
  assert.equal(buildPriorityPlan({ entries: [base] }, { mode: 'regular' }).task.stop, 'budget')
  assert.equal(buildPriorityPlan({ entries: [base] }, { mode: '0day' }).task.researchEntryRequired, false)
})
const asset = { id: 'site', url: 'https://example.com', inScope: true, reachable: true }
const check = { assetId: 'site', entryId: 'old', endpoint: 'https://example.com/api/import', methodVersion: 'v1',
  authContext: 'anonymous', requestRevision: 'r1', productConfirmed: true, productEvidenceIds: ['product-response'],
  conditions: [{ name: 'affected-component', state: 'satisfied', evidenceIds: ['component-evidence'] }],
  requestValid: true, baselineEvidenceIds: ['normal-response'], methodReviewed: true }
const queuePlan = (checks = [check], history = [], extra = {}, catalog = [base]) => buildPriorityPlan({ entries: catalog }, {
  now, ...extra, verificationContext: JSON.stringify({ assets: [asset], checks, history, ...(extra.context ?? {}) }),
}).verificationQueue
test('unknown condition supplements rather than excludes or runs and stops at its budget', () => {
  const unknown = { ...check, conditions: [{ name: 'component-version', state: 'unknown' }] }
  const first = queuePlan([unknown]).items[0]
  assert.equal(first.action, 'supplement-evidence')
  assert.equal(first.state, 'pending-confirmation')
  assert.equal(first.supplement.remaining, 2)
  const exhausted = queuePlan([unknown], [{ ...unknown, supplementAttempts: 2 }]).items[0]
  assert.equal(exhausted.state, 'blocked')
  assert.equal(exhausted.action, 'record-gap')
})
test('known exclusion requires evidence and valid baseline gates minimal verification', () => {
  assert.equal(queuePlan().items[0].action, 'minimal-check-with-control')
  assert.equal(queuePlan([{ ...check, requestValid: false }]).items[0].action, 'capture-valid-baseline')
  assert.equal(queuePlan([{ ...check, methodReviewed: false }]).items[0].action, 'review-method')
  assert.equal(queuePlan([{ ...check, conditions: [] }]).items[0].action, 'supplement-evidence')
  const excluded = { ...check, conditions: [{ name: 'patched-version', state: 'not-applicable', evidenceIds: ['patch'] }] }
  assert.equal(queuePlan([excluded]).items[0].state, 'not-applicable')
  assert.throws(() => queuePlan([{ ...excluded, conditions: [{ name: 'patched-version', state: 'not-applicable' }] }]), /evidence/)
})
test('history reuse invalidates on identity method endpoint or baseline changes', () => {
  const history = [{ ...check, status: 'mechanism-confirmed', evidenceIds: ['controlled-interaction'], verificationBasis: verificationBasis(check, { assets: [asset] }) }]
  assert.equal(queuePlan([check, check], history).items.length, 1)
  const reused = queuePlan([check], history).items[0]
  assert.equal(reused.action, 'reuse-record')
  assert.equal(reused.findingConfirmed, false)
  for (const field of ['authContext', 'methodVersion', 'requestRevision']) {
    assert.equal(queuePlan([{ ...check, [field]: 'changed' }], history).items[0].reuse, false, field)
  }
  assert.equal(queuePlan([{ ...check, endpoint: 'https://example.com/api/other' }], history).items[0].reuse, false)
  assert.equal(queuePlan([check], [{ ...check, status: 'not-hit', requestValid: false, evidenceIds: ['gateway-denial'] }]).items[0].reuse, false)
})
test('scope and origin reject unrelated endpoints even with matching evidence', () => {
  assert.throws(() => queuePlan([{ ...check, endpoint: 'https://unrelated.com/api' }]), /origin/)
  assert.throws(() => queuePlan([{ ...check, endpoint: 'file:///example.com' }]), /endpoint/)
  assert.equal(queuePlan([check], [], { context: { assets: [{ ...asset, inScope: false }] } }).items[0].action, 'resolve-scope')
})
test('asset evidence survives discovery cap and ready products interleave', () => {
  const fresh = { ...base, id: 'fresh', product: 'New Product', publishedAt: '2026-09-30' }
  const same = { ...base, id: 'same' }
  const plan = buildPriorityPlan({ entries: [base, fresh, same] }, { now, maxCandidates: 1,
    verificationContext: { assets: [asset], checks: [check, { ...check, entryId: 'same' }, { ...check, entryId: 'fresh' }], history: [] } })
  assert.equal(plan.candidates.length, 1)
  assert.equal(plan.verificationQueue.items.length, 3)
  const products = plan.verificationQueue.items.map(item => item.product)
  assert.notEqual(products[0], products[1])
  const readyOld = queuePlan([check, { ...check, entryId: 'fresh', productConfirmed: false }], [], {}, [base, fresh]).items
  assert.equal(readyOld[0].entryId, 'old')
})
test('malformed queue context fails explicitly instead of producing an empty plan', () => {
  assert.throws(() => buildPriorityPlan({ entries: [base] }, { verificationContext: '{broken' }))
  assert.throws(() => queuePlan([{ ...check, authContext: undefined }]), /authContext/)
  assert.throws(() => queuePlan([check], [], { context: { maxSupplementAttempts: -1 } }), /budget/)
})
console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
