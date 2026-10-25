import assert from 'node:assert/strict'
import { isPassiveBrowserDependency, normalizeTaskScope, taskScopeAllowsAsset, taskScopeAllowsUrl, taskTermInPolicy } from '../plugins/dsh-redteam-results/lib/task-scope.js'

const full = 'https://app.example.test:8443/login?return=/orders'
const normalized = normalizeTaskScope({ target: full })
assert.equal(normalized.target, full)
assert.equal(normalized.entrypoints[0].url, full)
assert.equal(taskScopeAllowsUrl(normalized, 'https://app.example.test:8443/api/orders'), true)
assert.equal(taskScopeAllowsUrl(normalized, 'https://app.example.test/api/orders'), false, 'explicit port remains restricted')
assert.equal(taskScopeAllowsUrl(normalized, 'https://other.example.test:8443/'), false)

const multiple = normalizeTaskScope({ target: 'https://a.example.test/login\nhttps://b.example.test/api?x=1' })
assert.deepEqual(multiple.entrypoints.map(row => row.url), ['https://a.example.test/login', 'https://b.example.test/api?x=1'])
assert.equal(taskScopeAllowsUrl(multiple, 'https://a.example.test/export'), true)
assert.equal(taskScopeAllowsUrl(multiple, 'https://b.example.test/other'), true)
assert.equal(taskScopeAllowsUrl(multiple, 'https://ab.example.test/'), false, 'two lines must not concatenate hosts')

const mixed = normalizeTaskScope({
  target: 'example.test\n*.example.test\n203.0.113.0/24\n198.51.100.8',
  excluded: ['pay.example.test', '203.0.113.128/25'],
})
assert.equal(taskScopeAllowsUrl(mixed, 'https://example.test/'), true)
assert.equal(taskScopeAllowsUrl(mixed, 'https://oa.example.test/'), true)
assert.equal(taskScopeAllowsUrl(mixed, 'https://deep.oa.example.test/'), true)
assert.equal(taskScopeAllowsUrl(mixed, 'https://pay.example.test/'), false)
assert.equal(taskScopeAllowsAsset(mixed, { url: 'https://example.test', host: 'example.test' }), true)
assert.equal(taskScopeAllowsAsset(mixed, { host: '203.0.113.44', ip: '203.0.113.44' }), true)
assert.equal(taskScopeAllowsAsset(mixed, { host: '203.0.113.200', ip: '203.0.113.200' }), false)
assert.equal(taskScopeAllowsAsset(mixed, { host: '198.51.100.8', ip: '198.51.100.8' }), true)
assert.equal(taskScopeAllowsAsset(mixed, { host: '198.51.100.9', ip: '198.51.100.9' }), false)

const inferred = normalizeTaskScope({
  target: 'example.test',
  requestText: '检查 example.test 及所有子域的近期 Nday',
})
assert.equal(taskScopeAllowsUrl(inferred, 'https://api.example.test/'), true)
assert.equal(taskScopeAllowsUrl(inferred, 'https://example.net/'), false)

const company = normalizeTaskScope({
  target: 'https://shared.example.test/',
  requestText: '找这家公司可能遗漏的后台，公司名 ACME',
})
assert.equal(taskScopeAllowsUrl(company, 'https://outside.example.net/'), false, 'company names never infer authorization')

const parent = normalizeTaskScope({ target: '*.example.test\n203.0.113.0/24' })
assert.equal(taskTermInPolicy(parent, 'https://app.example.test'), true)
assert.equal(taskTermInPolicy(parent, 'https://example.test'), false)
assert.equal(taskTermInPolicy(parent, '203.0.113.0/25'), true)
assert.equal(taskTermInPolicy(parent, '203.0.114.0/24'), false)

const pathOnly = normalizeTaskScope({ target: '/api' })
assert.equal(pathOnly.terms.include.length, 0, 'a relative path cannot create a hostless active scope')
assert.match(pathOnly.errors[0].reason, /相对路径.*需要.*网址/)
assert.equal(taskScopeAllowsUrl(pathOnly, 'https://outside.example.net/api/orders'), false)

const relativeExclude = normalizeTaskScope({
  target: 'https://app.example.test',
  excluded: ['/payment'],
})
assert.equal(taskScopeAllowsUrl(relativeExclude, 'https://app.example.test/payment/checkout'), false)
assert.equal(taskScopeAllowsUrl(relativeExclude, 'https://app.example.test/payments'), true)

const protocolWildcard = normalizeTaskScope({ target: 'https://*.example.test:8443' })
assert.equal(protocolWildcard.target, 'https://*.example.test:8443')
assert.equal(taskScopeAllowsUrl(protocolWildcard, 'https://api.example.test:8443/'), true)
assert.equal(taskScopeAllowsUrl(protocolWildcard, 'http://api.example.test:8443/'), false)
assert.equal(taskScopeAllowsUrl(protocolWildcard, 'https://api.example.test:9443/'), false)
assert.equal(taskTermInPolicy(protocolWildcard, 'https://*.example.test:8443'), true)
assert.equal(taskTermInPolicy(protocolWildcard, 'http://*.example.test:8443'), false)
assert.equal(taskTermInPolicy(protocolWildcard, 'https://*.example.test:9443'), false)
assert.equal(taskTermInPolicy(protocolWildcard, 'app.example.test'), false,
  'a bare domain allows HTTP and arbitrary ports, so a strict HTTPS wildcard cannot contain it')

const unqualifiedWildcard = normalizeTaskScope({ target: '*.example.test' })
assert.equal(taskScopeAllowsUrl(unqualifiedWildcard, 'https://api.example.test/'), true)
assert.equal(taskScopeAllowsUrl(unqualifiedWildcard, 'http://api.example.test:8443/'), true)
assert.equal(taskTermInPolicy(unqualifiedWildcard, 'app.example.test'), true)

const strictHttpsOrigin = normalizeTaskScope({ target: 'https://app.example.test' })
assert.equal(taskTermInPolicy(strictHttpsOrigin, 'https://app.example.test/'), true)
assert.equal(taskTermInPolicy(strictHttpsOrigin, 'app.example.test'), false)
assert.equal(taskTermInPolicy(strictHttpsOrigin, 'http://app.example.test/'), false)
assert.equal(taskTermInPolicy(strictHttpsOrigin, 'https://app.example.test:8443/'), false)

const strictHttpOrigin = normalizeTaskScope({ target: 'http://app.example.test' })
assert.equal(taskTermInPolicy(strictHttpOrigin, 'app.example.test'), false)

const bareDomain = normalizeTaskScope({ target: 'app.example.test' })
assert.equal(taskTermInPolicy(bareDomain, 'app.example.test'), true)
assert.equal(taskTermInPolicy(bareDomain, 'https://app.example.test/'), true)

const strictHttpIp = normalizeTaskScope({ target: 'http://198.51.100.8' })
const bareIp = normalizeTaskScope({ target: '198.51.100.8' })
const ipNetwork = normalizeTaskScope({ target: '198.51.100.0/24' })
assert.equal(taskTermInPolicy(strictHttpIp, '198.51.100.8'), false,
  'a bare IP allows every protocol and port, so one HTTP origin cannot contain it')
assert.equal(taskTermInPolicy(bareIp, '198.51.100.8'), true)
assert.equal(taskTermInPolicy(ipNetwork, '198.51.100.8'), true)

const many = Array.from({ length: 40 }, (_, index) => `https://asset-${index}.example.test`).join('\n')
assert.equal(normalizeTaskScope({ target: many }).terms.include.length, 40, 'related entries are not capped at 30')
assert.equal(isPassiveBrowserDependency({ url: 'https://cdn.example.net/app.js', method: 'GET', resourceType: 'Script' }), true)
assert.equal(isPassiveBrowserDependency({ url: 'https://api.example.net/orders', method: 'GET', resourceType: 'Fetch' }), false)
assert.equal(isPassiveBrowserDependency({ url: 'https://api.example.net/orders', method: 'POST', resourceType: 'Script' }), false)

console.log('ok   task scope supports URLs, domains, wildcards, IP/CIDR, exclusions and passive browser dependencies')
console.log('all task scope tests passed')
