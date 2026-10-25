import { isIP } from 'node:net'
import { matchesScope } from 'dsh-saker/asset-inventory'

const MAX_SCOPE_TERMS = 2000

function clean(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max)
}

function splitValues(value) {
  if (value === undefined || value === null || value === '') return []
  const rows = Array.isArray(value) ? value : [value]
  const out = []
  for (const row of rows) {
    for (const line of String(row).split(/\r\n|\r|\n/)) {
      const text = line.trim()
      if (!text) continue
      if (text.includes('://') || text.startsWith('*.')) out.push(text)
      else out.push(...text.split(/\s+/).filter(Boolean))
    }
  }
  return out
}

function wildcardUrlTerm(raw) {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)?\*\.([^/?#]+)(?:[/?#].*)?$/i.exec(raw)
  if (!match) return null
  const hostPort = match[2].toLowerCase()
  const hash = hostPort.lastIndexOf(':')
  const host = (hash > 0 && /^\d+$/.test(hostPort.slice(hash + 1)) ? hostPort.slice(0, hash) : hostPort).replace(/\.+$/, '')
  const port = hash > 0 && /^\d+$/.test(hostPort.slice(hash + 1)) ? hostPort.slice(hash + 1) : ''
  const protocol = match[1] ? match[1].slice(0, -3).toLowerCase() : ''
  return {
    // Authorization identity includes protocol and port. Rewriting this to a
    // display-only host form made a later child intersection or exclusion edit
    // silently widen HTTPS to any scheme.
    raw: `${protocol ? protocol + '://' : ''}*.${host}${port ? ':' + port : ''}`,
    kind: 'wildcard',
    host,
    port,
    protocol,
  }
}

function normalizeTerm(raw, { exclude = false } = {}) {
  let text = clean(raw)
  if (!text) return null
  text = text.replace(/\\/g, '/')
  // A bare path is a portable exclusion rule: apply it to every in-scope host.
  // Keep it relative rather than manufacturing a host that the user never gave.
  if (text.startsWith('/')) {
    if (!exclude) return null
    if (text.length > 1000 || /[\u0000-\u001f]/.test(text)) return null
    let parsed
    try { parsed = new URL(text, 'https://scope-relative.invalid') } catch { return null }
    return {
      raw: parsed.pathname + parsed.search,
      kind: 'path',
      host: '',
      port: '',
      protocol: '',
      pathname: parsed.pathname,
      search: parsed.search,
    }
  }
  const wildcard = wildcardUrlTerm(text)
  if (wildcard) return wildcard
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
      url.hash = ''
      if (exclude && (url.pathname !== '/' || url.search)) return {
        raw: url.href,
        kind: 'path',
        host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
        port: url.port || (url.protocol === 'https:' ? '443' : '80'),
        protocol: url.protocol.slice(0, -1),
        pathname: url.pathname,
        search: url.search,
      }
      return {
        raw: url.href,
        kind: 'origin',
        origin: url.origin,
        host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
        port: url.port || (url.protocol === 'https:' ? '443' : '80'),
        protocol: url.protocol.slice(0, -1),
      }
    } catch {
      return null
    }
  }
  if (text.includes('/') && isIP(text.split('/')[0]) === 4) {
    const [network, bitsText] = text.split('/')
    const bits = Number(bitsText)
    if (isIP(network) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) return null
    return { raw: `${network}/${bits}`, kind: 'cidr', host: network, cidr: `${network}/${bits}` }
  }
  const unbracketed = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  if (isIP(unbracketed)) return { raw: unbracketed.toLowerCase(), kind: 'ip', host: unbracketed.toLowerCase() }
  text = text.toLowerCase().replace(/\.+$/, '').replace(/\/+$/, '')
  if (!/^[a-z0-9.-]+$/.test(text) || text.includes('..') || text.startsWith('.') || text.endsWith('.')) return null
  return { raw: text, kind: 'domain', host: text }
}

function normalizedTerms(values, options) {
  const terms = []
  const errors = []
  const seen = new Set()
  for (const value of splitValues(values)) {
    const term = normalizeTerm(value, options)
    if (!term) {
      const pathOnly = !options?.exclude && String(value).trim().startsWith('/')
      errors.push({
        value: String(value),
        reason: pathOnly
          ? '相对路径不能单独作为主动测试范围，需要同时给出网址、域名或 IP'
          : '不是可识别的 HTTP(S) URL、域名、通配域、IP 或 CIDR',
      })
      continue
    }
    if (seen.has(term.raw)) continue
    seen.add(term.raw)
    terms.push(term)
    if (terms.length > MAX_SCOPE_TERMS) throw new Error(`测试范围最多 ${MAX_SCOPE_TERMS} 项`)
  }
  return { terms, errors }
}

function domainFromText(text) {
  return [...String(text || '').matchAll(/\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})\b/gi)]
    .map(match => match[1].toLowerCase())
    .filter((host, index, rows) => rows.indexOf(host) === index)
}

function inferSubdomains(values, requestText) {
  const out = []
  for (const value of splitValues(values)) {
    const term = normalizeTerm(value)
    if (!term || !['domain', 'origin'].includes(term.kind)) continue
    const escaped = term.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const after = new RegExp(`${escaped}[^\\n]{0,40}(?:all\\s+subdomains?|所有子域|全部子域|及子域|包括子域)`, 'i')
    const before = new RegExp(`(?:all\\s+subdomains?|所有子域|全部子域)[^\\n]{0,40}${escaped}`, 'i')
    if (!after.test(String(requestText || '')) && !before.test(String(requestText || ''))) continue
    const explicitPort = term.kind === 'origin' ? (() => { try { return new URL(term.raw).port } catch { return '' } })() : ''
    out.push(`${term.protocol ? term.protocol + '://' : ''}*.${term.host}${explicitPort ? ':' + explicitPort : ''}`)
  }
  return out
}

export function normalizeTaskScope({ target, scope, allowedOrigins, excluded = [], requestText = '' } = {}) {
  const targetValues = splitValues(target)
  const explicitScope = splitValues(scope && typeof scope === 'object' && !Array.isArray(scope) ? scope.include ?? [] : scope)
  const originValues = splitValues(allowedOrigins)
  const inferred = inferSubdomains([...targetValues, ...explicitScope], requestText)
  const includeRows = normalizedTerms([...targetValues, ...explicitScope, ...originValues, ...inferred])
  const excludeRows = normalizedTerms(excluded, { exclude: true })
  const include = [...new Map(includeRows.terms.map(term => [term.raw, term])).values()]
  const exclude = [...new Map(excludeRows.terms.map(term => [term.raw, term])).values()]
  const errors = [...includeRows.errors, ...excludeRows.errors]
  const entrypoints = include.filter(term => term.kind === 'origin').map((term, index) => ({
    id: `entry-${index + 1}`,
    url: term.raw,
  }))
  const displayValues = include.map(term => term.raw)
  return {
    target: displayValues.join('\n'),
    primaryTarget: entrypoints[0]?.url || displayValues[0] || '',
    entrypoints,
    scope: { include: include.map(term => term.raw), exclude: exclude.map(term => term.raw) },
    terms: { include, exclude },
    errors,
  }
}

function pathPrefixMatches(pathname, entry) {
  const base = entry.endsWith('/') ? entry.slice(0, -1) : entry
  if (!base) return false
  return pathname === base || pathname.startsWith(base + '/')
}

function hostMatchesTerm(term, host, port = '', protocol = '', pathname = '', search = '') {
  if (!host) return false
  if (term.kind === 'domain') return host === term.host
  if (term.kind === 'wildcard') {
    if (host === term.host || !host.endsWith(`.${term.host}`)) return false
    if (term.port && String(port) !== term.port) return false
    if (term.protocol && String(protocol).replace(/:$/, '') !== term.protocol) return false
    return true
  }
  if (term.kind === 'ip') return host === term.host
  if (term.kind === 'cidr') return matchesScope({ host, ip: host }, term.cidr)
  if (term.kind === 'origin') {
    if (host !== term.host) return false
    if (term.port && String(port) !== term.port) return false
    if (term.protocol && String(protocol).replace(/:$/, '') !== term.protocol) return false
    return true
  }
  if (term.kind === 'path') {
    if (term.host && host !== term.host) return false
    if (term.port && String(port) !== term.port) return false
    if (term.protocol && String(protocol).replace(/:$/, '') !== term.protocol) return false
    if (!pathPrefixMatches(pathname || '/', term.pathname || '/')) return false
    return !term.search || search === term.search
  }
  return false
}

function termsForPolicy(policy) {
  const base = policy?.scopeTerms?.include ? policy.scopeTerms
    : policy?.terms?.include ? policy.terms
      : normalizeTaskScope({
        target: policy?.target,
        scope: policy?.scope?.include,
        allowedOrigins: policy?.allowedOrigins,
        excluded: policy?.scope?.exclude,
      }).terms
  const legacy = normalizedTerms(policy?.excludedPaths, { exclude: true }).terms
  return {
    // Old builds could persist a hostless path as include. It never authorizes
    // arbitrary hosts and remains valid only on the exclude side.
    include: (base.include || []).filter(term => term.kind !== 'path'),
    exclude: [...new Map([...(base.exclude || []), ...legacy].map(term => [term.raw, term])).values()],
  }
}

export function taskScopeExcluded(policy, value) {
  let url
  try { url = value instanceof URL ? value : new URL(String(value)) } catch { return false }
  if (!['http:', 'https:'].includes(url.protocol)) return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return termsForPolicy(policy).exclude.some(term => hostMatchesTerm(term, host, port, url.protocol, url.pathname, url.search))
}

export function taskScopeIncludesUrl(policy, value) {
  let url
  try { url = value instanceof URL ? value : new URL(String(value)) } catch { return false }
  if (!['http:', 'https:'].includes(url.protocol)) return false
  const terms = termsForPolicy(policy)
  if (!terms.include.length) return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return terms.include.some(term => hostMatchesTerm(term, host, port, url.protocol, url.pathname, url.search))
}

export function taskScopeAllowsUrl(policy, value) {
  let url
  try { url = value instanceof URL ? value : new URL(String(value)) } catch { return false }
  return taskScopeIncludesUrl(policy, url) && !taskScopeExcluded(policy, url)
}

export function taskScopeAllowsAsset(policy, asset) {
  let url = ''
  try { url = String(asset?.url || asset?.target || '') } catch { url = '' }
  if (url && taskScopeAllowsUrl(policy, url)) return true
  const terms = termsForPolicy(policy)
  if (!terms.include.length) return false
  const candidates = [asset?.host, asset?.ip].filter(Boolean)
  const pathname = (() => { try { return new URL(url).pathname } catch { return '' } })()
  const search = (() => { try { return new URL(url).search } catch { return '' } })()
  if (terms.exclude.some(term => candidates.some(host => hostMatchesTerm(term, String(host).toLowerCase(), asset?.port, asset?.protocol, pathname, search)))) return false
  if (candidates.some(host => terms.include.some(term => hostMatchesTerm(term, String(host).toLowerCase(), asset?.port, asset?.protocol)))) return true
  try {
    if (matchesScope(asset, terms.include.filter(term => ['domain', 'wildcard', 'ip', 'cidr'].includes(term.kind)).map(term => term.raw).join(' '))) return true
  } catch {}
  return false
}

export function taskScopeSummary(policy) {
  const terms = termsForPolicy(policy)
  const preview = 12
  const bounded = value => {
    const text = String(value)
    return text.length > 180 ? text.slice(0, 177) + '...' : text
  }
  return {
    include: terms.include.map(term => term.raw),
    exclude: terms.exclude.map(term => term.raw),
    text: terms.include.map(term => term.raw).join('、') || '未指定',
    includePreview: terms.include.slice(0, preview).map(term => bounded(term.raw)),
    excludePreview: terms.exclude.slice(0, preview).map(term => bounded(term.raw)),
    includeCount: terms.include.length,
    excludeCount: terms.exclude.length,
    moreInclude: Math.max(0, terms.include.length - preview),
    moreExclude: Math.max(0, terms.exclude.length - preview),
    entrypoints: terms.include.filter(term => term.kind === 'origin').map(term => term.raw),
  }
}

/** Bounded text for resident model snapshots; full values remain in the policy. */
export function taskScopePromptText(policy) {
  const summary = taskScopeSummary(policy)
  const include = summary.includeCount
    ? summary.includePreview.join('、') + (summary.moreInclude ? ` 等 ${summary.includeCount} 项` : '')
    : '未指定'
  const exclude = summary.excludeCount
    ? '；排除：' + summary.excludePreview.join('、') + (summary.moreExclude ? ` 等 ${summary.excludeCount} 项` : '')
    : ''
  return include + exclude
}

export function taskTermAllowsUrl(termValue, value) {
  const term = normalizeTerm(termValue)
  if (!term) return false
  let url
  try { url = value instanceof URL ? value : new URL(String(value)) } catch { return false }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return hostMatchesTerm(term, host, port, url.protocol, url.pathname, url.search)
}

function ipv4Int(value) {
  const parts = String(value || '').split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}

function cidrContains(outer, inner) {
  const [outerIp, outerBitsText] = String(outer || '').split('/')
  const [innerIp, innerBitsText] = String(inner || '').split('/')
  const outerBits = Number(outerBitsText), innerBits = Number(innerBitsText)
  if (isIP(outerIp) !== 4 || isIP(innerIp) !== 4 || !Number.isInteger(outerBits) || !Number.isInteger(innerBits)
    || outerBits < 0 || outerBits > 32 || innerBits < outerBits || innerBits > 32) return false
  const mask = outerBits === 0 ? 0 : (0xffffffff << (32 - outerBits)) >>> 0
  return ((ipv4Int(outerIp) & mask) >>> 0) === ((ipv4Int(innerIp) & mask) >>> 0)
}

/** True when one requested worker scope is a subset of the user's task scope. */
export function taskTermInPolicy(policy, termValue) {
  const term = normalizeTerm(termValue)
  if (!term) return false
  if (term.kind === 'origin') return taskScopeAllowsUrl(policy, term.raw)
  if (term.kind === 'ip') {
    return termsForPolicy(policy).include.some(item =>
      (item.kind === 'ip' && item.host === term.host)
      || (item.kind === 'cidr' && matchesScope({ ip: term.host }, item.cidr)))
  }
  if (term.kind === 'cidr') {
    return termsForPolicy(policy).include.some(item => item.kind === 'cidr' && cidrContains(item.cidr, term.cidr))
  }
  if (term.kind === 'domain') {
    // A bare domain allows every protocol and port. A strict origin or
    // protocol/port-qualified wildcard contains only a narrower URL, not this
    // broader term.
    return termsForPolicy(policy).include.some(item => {
      if (!['domain', 'wildcard'].includes(item.kind) || item.protocol || item.port) return false
      return term.host === item.host || (item.kind === 'wildcard' && term.host.endsWith(`.${item.host}`))
    })
  }
  if (term.kind === 'wildcard') {
    return termsForPolicy(policy).include.some(item => item.kind === 'wildcard'
      && (item.host === term.host || term.host.endsWith(`.${item.host}`))
      && (!item.protocol || item.protocol === term.protocol)
      && (!item.port || item.port === term.port))
  }
  return false
}

export function isPassiveBrowserDependency({ url, method, resourceType } = {}) {
  if (String(method || '').toUpperCase() !== 'GET') return false
  try {
    const parsed = new URL(String(url || ''))
    if (!['http:', 'https:'].includes(parsed.protocol)) return false
  } catch { return false }
  return new Set(['stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'manifest', 'signedexchange'])
    .has(String(resourceType || '').toLowerCase())
}

export function inferredDomainsFromText(text) {
  return domainFromText(text)
}
