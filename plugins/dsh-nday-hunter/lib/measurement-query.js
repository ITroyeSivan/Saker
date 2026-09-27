const QUERY_FIELDS = new Set([
  'app', 'title', 'body', 'header', 'icon_hash', 'fid', 'cert', 'port', 'protocol', 'domain', 'ip',
  'server', 'banner', 'jarm', 'base_protocol', 'status_code',
  'product', 'product.version', 'category', 'header_hash', 'banner_hash', 'banner_fid',
  'cert.issuer.org', 'cert.issuer.cn', 'cert.subject.org', 'cert.subject.cn', 'cert.domain', 'cert.sn',
  'tls.ja3s', 'tls.version',
])

const FIELD_PATTERN = [...QUERY_FIELDS]
  .sort((a, b) => b.length - a.length)
  .map((field) => field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')
const FIELD_QUERY = new RegExp(`\\b(${FIELD_PATTERN})\\s*(==|=)\\s*(?:"((?:\\\\.|[^"\\\\])*)"|(-?\\d+)|([A-Za-z0-9_.:-]+))`, 'gi')
const GENERIC_PRODUCT_ALIASES = new Set([
  'oa', 'erp', 'rce', 'cve', 'weaver', '泛微', '金蝶', 'kingdee', '用友', 'yonyou', '大华', 'dahua', 'apache', 'php',
])
const GENERIC_PROBE_MARKERS = new Set([
  'admin', 'console', 'content-type', 'error', 'html', 'index', 'jsencrypt.min.js', 'login', 'nginx',
  'page', 'server', 'set-cookie:', 'sessionname', 'status', 'text/html', 'version', 'welcome',
])

function dslTerm(field, rawValue) {
  const key = String(field || '').toLowerCase()
  const value = String(rawValue ?? '').trim()
  if (!QUERY_FIELDS.has(key) || !value || /[\r\n]/.test(value)) return ''
  return `${key}:"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function normalizeMeasurementSource(source) {
  return source.replace(/(\bfofa(?:-query)?\s*[:：]\s*)"((?:\\.|[^"\\])*)"/i,
    (_match, prefix, query) => `${prefix}${query.replace(/\\(?=")/g, '')}`)
}

/**
 * Extract only field expressions the shared asset_search DSL can execute.
 * Prose around a signature is ignored; provider-specific Shodan/Google hints
 * are never sent to FOFA or translated to another provider.
 */
export function parseMeasurementHints(lines = []) {
  const out = []
  for (const raw of Array.isArray(lines) ? lines : [lines]) {
    const source = String(raw ?? '').trim()
    if (!source || /^\s*(?:shodan|google|zoomeye|quake|hunter)(?:-query)?\s*[:：]/i.test(source)) continue
    const matches = [...normalizeMeasurementSource(source).matchAll(FIELD_QUERY)]
    if (matches.length === 0) continue

    let branch = []
    const flush = () => {
      if (branch.length) out.push(branch.join(' '))
      branch = []
    }
    for (let i = 0; i < matches.length; i += 1) {
      const match = matches[i]
      const value = match[3] !== undefined
        ? match[3].replace(/\\(["\\])/g, '$1')
        : match[4] ?? match[5]
      const term = dslTerm(match[1], value)
      if (!term) continue
      if (i > 0) {
        const previous = matches[i - 1]
        const gap = source.slice(previous.index + previous[0].length, match.index).trim()
        if (/^(?:&&|&|and|与|并且|且)$/i.test(gap)) {
          // Keep documented conjuncts together. A different connector or prose
          // starts a separate, broader fingerprint alternative.
        } else {
          flush()
        }
      }
      branch.push(term)
    }
    flush()
  }
  return [...new Set(out)]
}

export function expansionQueries(entry) {
  const authored = parseMeasurementHints([
    ...(entry?.fingerprint?.signals ?? []),
    ...(entry?.fingerprint?.mappingHints ?? []),
  ])
  return authored.length > 0 ? authored : probeMeasurementQueries(entry)
}

/**
 * Derive passive service signatures only from concrete GET/HEAD response
 * matchers already recorded in the catalog. These remain product/candidate
 * fingerprints, never vulnerability verdicts; generic HTTP boilerplate is
 * excluded to keep the query plan useful.
 */
export function probeMeasurementQueries(entry) {
  const queries = []
  for (const probe of entry?.fingerprint?.probes ?? []) {
    if (!['GET', 'HEAD'].includes(String(probe?.method || 'GET').toUpperCase())) continue
    for (const [field, matcher] of [['body', 'bodyContainsAny'], ['header', 'headerContainsAny']]) {
      for (const raw of probe?.expect?.[matcher] ?? []) {
        const value = String(raw ?? '').trim()
        const normalized = value.toLowerCase().replace(/\s+/g, ' ').replace(/^["'`]+|["'`]+$/g, '')
        if (value.length < 4 || value.length > 120 || GENERIC_PROBE_MARKERS.has(normalized)) continue
        if (/^(?:content-type|set-cookie):?$/i.test(value) || /^text\/(?:html|plain)$/i.test(value)) continue
        const term = dslTerm(field, value)
        if (term) queries.push(term)
      }
    }
  }
  return [...new Set(queries)]
}

function entryDate(entry) {
  const dates = [
    entry?.lastReviewed,
    entry?.verification?.date,
    ...(entry?.sources ?? []).map((source) => source?.retrieved),
  ].map((value) => Date.parse(String(value ?? ''))).filter(Number.isFinite)
  return dates.length ? Math.max(...dates) : 0
}

function entryScore(entry, query) {
  let score = 0
  const vuln = `${entry?.vulnClass ?? ''} ${(entry?.exploit?.primitives ?? []).join(' ')}`
  if (/\bRCE\b|remote code execution|远程代码执行|命令执行|反序列化|表达式执行/i.test(vuln)) score += 100
  if (entry?.status === 'verified' || entry?.verification?.reproduced === true) score += 12
  const cvss = Number(entry?.severity?.cvss31)
  if (Number.isFinite(cvss)) score += Math.round(Math.max(0, Math.min(10, cvss)) * 2)
  if (/^(?:none|no|无需认证|未认证)$/i.test(String(entry?.auth ?? '').trim())) score += 8
  if (/icon_hash/.test(query)) score += 12
  if (/fid:/.test(query)) score += 12
  if (/app:/.test(query)) score += 10
  if (/(?:product(?:\.version)?|category):/.test(query)) score += 10
  if (/\b(?:body|header|title):/.test(query)) score += 4
  if (/\bport:/.test(query)) score += 5
  if (/\s/.test(query.trim())) score += 4
  if ((entry?.exploit?.tools ?? []).length > 0) score += 4
  return score
}

function entryHaystack(entry) {
  return [
    entry?.id, entry?.product, entry?.vendor, entry?.category, entry?.vulnClass,
    ...(entry?.aliases ?? []), entry?.ids?.cve, entry?.ids?.cnvd, entry?.ids?.qvd,
  ].filter(Boolean).join(' ').toLowerCase()
}

function productFallbackQuery(entry) {
  const aliases = Array.isArray(entry?.aliases) ? entry.aliases : []
  const candidate = aliases.find((value) => {
    const alias = String(value ?? '').trim()
    const normalized = alias.toLowerCase().replace(/\s+/g, ' ')
    return alias.length >= 3
      && !GENERIC_PRODUCT_ALIASES.has(normalized)
      && !/^cve[- ]?\d{4}/i.test(alias)
      && !/\b(?:rce|exploit|vulnerability)\b/i.test(alias)
  }) || String(entry?.product ?? '').split(/[（(]/, 1)[0].trim()
  if (!candidate || GENERIC_PRODUCT_ALIASES.has(candidate.toLowerCase())) return ''
  // `app` is FOFA's curated, enumerated fingerprint classifier. Arbitrary
  // aliases from Nday entries are not valid classifier names (the live API
  // returns 820300 for values such as TongWeb/OFBiz). Use the widely available
  // title field for this deliberately low-confidence fallback instead.
  return dslTerm('title', candidate)
}

function productPortRefinements(entry, productQuery) {
  if (!productQuery) return []
  const ports = [...new Set((entry?.fingerprint?.ports ?? [])
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))].slice(0, 2)
  return ports.map((port) => `${productQuery} ${dslTerm('port', port)}`)
}

/** Build a ranked, de-duplicated passive query plan from the current catalog. */
export function buildNdaySearchPlan(catalog, options = {}) {
  const requestedIds = [...new Set(String(options.entryIds ?? '').split(',').map((value) => value.trim()).filter(Boolean))]
  const requestedSet = new Set(requestedIds)
  const keyword = String(options.keyword ?? '').trim().toLowerCase()
  const focus = options.focus === 'all' ? 'all' : 'rce'
  const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 20)))
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0))
  const knownIds = new Set((catalog?.entries ?? []).map((entry) => entry.id))
  const unknownEntryIds = requestedIds.filter((id) => !knownIds.has(id))
  const candidates = (catalog?.entries ?? []).filter((entry) => {
    if (requestedSet.size > 0 && !requestedSet.has(entry.id)) return false
    if (entry.status === 'legacy-unreviewed' || entry.status === 'deprecated') return false
    if (keyword && !entryHaystack(entry).includes(keyword)) return false
    if (focus === 'rce') {
      const vuln = `${entry.vulnClass ?? ''} ${(entry.exploit?.primitives ?? []).join(' ')}`
      if (!/\bRCE\b|remote code execution|远程代码执行|命令执行|反序列化|表达式执行/i.test(vuln)) return false
    }
    return true
  })

  const groups = new Map()
  const withoutQuery = []
  const catalogFingerprintEntries = []
  const probeSignatureEntries = []
  const fallbackEntries = []
  const portRefinedEntries = []
  const basisRank = { 'catalog-fingerprint': 0, 'probe-signature': 1, 'port-refinement': 2, 'product-alias': 3 }
  const basisPenalty = { 'catalog-fingerprint': 0, 'probe-signature': 8, 'port-refinement': 25, 'product-alias': 45 }
  for (const entry of candidates) {
    const catalogQueries = parseMeasurementHints([
      ...(entry?.fingerprint?.signals ?? []),
      ...(entry?.fingerprint?.mappingHints ?? []),
    ])
    const probeQueries = probeMeasurementQueries(entry).filter((query) => !catalogQueries.includes(query))
    const productQuery = catalogQueries.length === 0 ? productFallbackQuery(entry) : ''
    const portQueries = productPortRefinements(entry, productQuery)
    const queryRecords = [
      ...catalogQueries.map((query) => ({ query, basis: 'catalog-fingerprint' })),
      ...probeQueries.map((query) => ({ query, basis: 'probe-signature' })),
      ...portQueries.map((query) => ({ query, basis: 'port-refinement' })),
      ...(productQuery ? [{ query: productQuery, basis: 'product-alias' }] : []),
    ]
    if (catalogQueries.length > 0) catalogFingerprintEntries.push(entry.id)
    if (probeQueries.length > 0) probeSignatureEntries.push(entry.id)
    if (productQuery) fallbackEntries.push(entry.id)
    if (portQueries.length > 0) portRefinedEntries.push(entry.id)
    if (queryRecords.length === 0) {
      withoutQuery.push(entry.id)
      continue
    }
    for (const { query, basis } of queryRecords) {
      let group = groups.get(query)
      if (!group) {
        group = { query, entryIds: [], products: [], score: 0, latestSourceDate: '', basis }
        groups.set(query, group)
      }
      if ((basisRank[basis] ?? 99) < (basisRank[group.basis] ?? 99)) group.basis = basis
      if (!group.entryIds.includes(entry.id)) group.entryIds.push(entry.id)
      if (entry.product && !group.products.includes(entry.product)) group.products.push(entry.product)
      const score = entryScore(entry, query) - basisPenalty[basis]
      group.score = Math.max(group.score, score)
      const date = entryDate(entry)
      if (date > (group._latestDate ?? 0)) {
        group._latestDate = date
        group.latestSourceDate = date ? new Date(date).toISOString().slice(0, 10) : ''
      }
    }
  }

  const allGroups = [...groups.values()].map((group) => {
    const { _latestDate = 0, ...publicGroup } = group
    publicGroup.score += Math.min(20, Math.max(0, publicGroup.entryIds.length - 1) * 2)
    return { ...publicGroup, _latestDate }
  }).sort((a, b) => b.score - a.score || b._latestDate - a._latestDate || a.query.localeCompare(b.query))
  const selected = allGroups.slice(offset, offset + limit).map(({ _latestDate, ...group }) => group)
  const queryGroupBasis = allGroups.reduce((counts, group) => {
    counts[group.basis] = (counts[group.basis] ?? 0) + 1
    return counts
  }, {})
  return {
    catalogUpdated: String(catalog?.updated ?? ''),
    focus,
    matchedEntries: candidates.length,
    queryGroups: allGroups.length,
    offset,
    limit,
    selected,
    nextOffset: offset + selected.length < allGroups.length ? offset + selected.length : null,
    withoutQuery,
    queryGroupBasis,
    catalogFingerprintEntries,
    probeSignatureEntries,
    fallbackEntries,
    portRefinedEntries,
    unknownEntryIds,
  }
}
