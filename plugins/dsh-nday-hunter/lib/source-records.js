const SOURCE_TRUST = Object.freeze({
  'cisa-kev': 'high',
  nvd: 'high',
  'cve-official': 'high',
  'cve-official-git': 'high',
  'github-research-files': 'medium',
  'nuclei-files': 'medium-high',
  'afrog-files': 'medium-high',
  osv: 'high',
  'github-advisories': 'medium-high',
  github: 'medium-high',
  nuclei: 'medium-high',
  wechat: 'medium-low',
})

export const TRUST_RANK = Object.freeze({ high: 4, 'medium-high': 3, medium: 2, 'medium-low': 1, unknown: 0 })

function clean(value, max = 300) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) }
function asTime(value) { const parsed = Date.parse(String(value ?? '')); return Number.isFinite(parsed) ? parsed : null }

export function freshnessOf(published, now = Date.now()) {
  const time = asTime(published)
  if (time === null) return { publishedAt: '', ageDays: null, freshness: 'unknown' }
  const ageDays = Math.max(0, Math.floor((now - time) / 86400000))
  const freshness = ageDays <= 7 ? 'fresh' : ageDays <= 30 ? 'recent' : ageDays <= 90 ? 'aging' : 'stale'
  return { publishedAt: new Date(time).toISOString(), ageDays, freshness }
}

export function dedupKeyOf(candidate) {
  const ids = Array.isArray(candidate?.ids) ? candidate.ids : []
  const firstId = ids.map((value) => clean(value, 160)).find(Boolean)
  if (firstId) return `id:${firstId.toLowerCase()}`
  const url = clean(candidate?.url, 500).replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
  if (url) return `url:${url}`
  const products = (Array.isArray(candidate?.products) ? candidate.products : [])
    .map((value) => clean(value, 120).toLowerCase()).filter(Boolean).sort().join(',')
  return `title:${clean(candidate?.title, 300).toLowerCase()}|${products}`
}

export function enrichCandidate(candidate, now = Date.now()) {
  const source = clean(candidate?.source, 60).toLowerCase()
  // KEV dateAdded is a catalogue event, including for legacy records whose
  // old adapter stored it in published. It never establishes disclosure age.
  const published = source === 'cisa-kev' ? '' : candidate?.published
  const freshness = freshnessOf(published, now)
  return {
    ...candidate,
    source,
    published,
    ...(source === 'cisa-kev' ? { kev: { ...candidate?.kev, dateAdded: candidate?.kev?.dateAdded || candidate?.published || '' } } : {}),
    sourceKind: clean(candidate?.sourceKind, 60) || 'public',
    trust: SOURCE_TRUST[source] || 'unknown',
    ...freshness,
    dedupKey: dedupKeyOf(candidate),
  }
}

export function mergeCandidates(rows, now = Date.now()) {
  const needsReview = row => Boolean(row.withdrawnAt || /withdrawn|rejected|removed-from|content-not-indexed/i.test(row.status ?? ''))
  const sourceRecord = row => ({ source: row.source, id: row.id, url: row.url, published: row.published,
    modified: row.modified, status: row.status, withdrawnAt: row.withdrawnAt, revision: row.revision })
  const merged = new Map()
  for (const raw of Array.isArray(rows) ? rows : []) {
    const candidate = enrichCandidate(raw, now)
    const existing = merged.get(candidate.dedupKey)
    if (!existing) {
      merged.set(candidate.dedupKey, {
        ...candidate,
        sources: [candidate.source],
        sourceRecords: [sourceRecord(candidate)],
        requiresSourceReview: needsReview(candidate),
      })
      continue
    }
    const existingTrust = TRUST_RANK[existing.trust] ?? 0
    const candidateTrust = TRUST_RANK[candidate.trust] ?? 0
    const preferred = candidateTrust > existingTrust
      || (candidateTrust === existingTrust && (asTime(candidate.published) ?? 0) > (asTime(existing.published) ?? 0))
      ? candidate
      : existing
    merged.set(candidate.dedupKey, {
      ...existing,
      ...preferred,
      sources: [...new Set([...(existing.sources ?? []), candidate.source])],
      ids: [...new Set([...(existing.ids ?? []), ...(candidate.ids ?? [])])],
      products: [...new Set([...(existing.products ?? []), ...(candidate.products ?? [])])].slice(0, 20),
      requiresSourceReview: existing.requiresSourceReview || needsReview(candidate),
      sourceRecords: [...(existing.sourceRecords ?? []), sourceRecord(candidate)]
        .filter((row, index, all) => all.findIndex((other) => other.source === row.source && other.url === row.url) === index)
        .slice(0, 12),
    })
  }
  return [...merged.values()].sort((left, right) =>
    (TRUST_RANK[right.trust] ?? 0) - (TRUST_RANK[left.trust] ?? 0)
    || (asTime(right.published) ?? 0) - (asTime(left.published) ?? 0)
    || String(left.title).localeCompare(String(right.title)))
}
