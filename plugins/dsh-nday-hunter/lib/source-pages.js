// Recoverable pages over official public APIs. "Complete" is scoped to a
// frozen modification window/query, never a claim of all vulnerability coverage.
import { fetchSourceJson, nvdCandidate, githubAdvisoryCandidate, kevCandidate, matchesQuery, fetchFreeSource } from './free-sources.js'
import { fetchOfficialCvePage } from './cve-official.js'
import { fetchRepositoryPage, REPOSITORY_SOURCES } from './repository-sources.js'
import { fetchOsvExportPage } from './osv-export.js'

export async function fetchSourcePage(source, options, fetchImpl = globalThis.fetch) {
  const { query = '', limit = 50, cursor = null, since, until } = options
  if (source === 'cve-official') return fetchOfficialCvePage(options, fetchImpl)
  if (source === 'osv') return fetchOsvExportPage(options, fetchImpl)
  if (REPOSITORY_SOURCES[source]) return fetchRepositoryPage(source, options, options.gitDeps)
  if (source === 'nvd') {
    const start = cursor === null ? 0 : Number(cursor)
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('Invalid NVD cursor')
    const params = new URLSearchParams({ resultsPerPage: String(limit), startIndex: String(start), lastModStartDate: since, lastModEndDate: until })
    if (query) params.set('keywordSearch', query)
    const data = await fetchSourceJson(`https://services.nvd.nist.gov/rest/json/cves/2.0?${params}`, { label: 'NVD incremental', attempts: 1, maxBytes: 16 * 1024 * 1024 }, fetchImpl)
    if (!Array.isArray(data?.vulnerabilities) || !Number.isSafeInteger(data.totalResults) || data.totalResults < 0 || data.startIndex !== start) throw new Error('NVD pagination metadata missing or inconsistent')
    const raw = data.vulnerabilities
    const next = start + raw.length
    if (next < data.totalResults && raw.length === 0) throw new Error('NVD empty page before end of results')
    const rows = raw.map(({ cve }) => {
      if (!cve?.id) throw new Error('NVD record has no identity')
      return nvdCandidate(cve, options.home)
    })
    return { rows, complete: next >= data.totalResults, nextCursor: next >= data.totalResults ? null : String(next), coverage: 'modification-window', total: data.totalResults }
  }
  if (source === 'github-advisories') {
    // This endpoint rejects millisecond ISO ranges. It accepts calendar dates;
    // retaining the start day on the next run deliberately overlaps updates.
    const params = new URLSearchParams({ per_page: String(limit), sort: 'updated', direction: 'asc', modified: `${since.slice(0, 10)}..${until.slice(0, 10)}` })
    const url = cursor ? new URL(cursor) : new URL(`https://api.github.com/advisories?${params}`)
    // A server-provided cursor is data, not authority to fetch arbitrary URLs.
    if (url.origin !== 'https://api.github.com' || url.pathname !== '/advisories' || url.username || url.password) throw new Error('Untrusted GitHub pagination URL')
    if (cursor && (url.searchParams.get('modified') !== params.get('modified') || url.searchParams.get('per_page') !== String(limit))) throw new Error('GitHub cursor changed the synchronization window')
    let link = ''
    const data = await fetchSourceJson(url.href, { label: 'GitHub incremental', attempts: 1, preferRaw: true, maxBytes: 16 * 1024 * 1024,
      headers: { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
      onResponse: headers => { link = String(headers?.get?.('link') ?? '') },
    }, fetchImpl)
    if (!Array.isArray(data)) throw new Error('GitHub advisory response is not an array')
    const nextCursor = link.split(',').find(part => /rel="next"/.test(part))?.match(/<([^>]+)>/)?.[1] ?? null
    if (nextCursor) {
      const next = new URL(nextCursor)
      if (next.origin !== url.origin || next.pathname !== url.pathname || next.username || next.password || next.searchParams.get('modified') !== params.get('modified') || next.searchParams.get('per_page') !== String(limit)) throw new Error('Untrusted GitHub next-page link')
    }
    const rows = data.filter(row => matchesQuery([row.ghsa_id, row.cve_id, row.summary, row.description, ...(row.vulnerabilities ?? []).map(item => item.package?.name)].join(' '), query)).map(row => {
      if (!row.ghsa_id) throw new Error('GitHub advisory has no identity')
      return githubAdvisoryCandidate(row, options.home)
    })
    return { rows, complete: !nextCursor, nextCursor, coverage: 'reviewed-advisory-day-range-with-overlap' }
  }
  if (source === 'cisa-kev') {
    const data = await fetchSourceJson('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', { label: 'CISA KEV', attempts: 1 }, fetchImpl)
    if (!Array.isArray(data?.vulnerabilities)) throw new Error('CISA KEV catalog is not a vulnerability array')
    const rows = data.vulnerabilities.filter(row => matchesQuery([row.cveID, row.vendorProject, row.product, row.vulnerabilityName, row.shortDescription].join(' '), query)).map(row => {
      if (!row.cveID) throw new Error('CISA KEV entry has no identity')
      return kevCandidate(row, data.dateReleased)
    })
    return { rows, complete: true, nextCursor: null, coverage: 'current-kev-catalog-query', snapshot: !query }
  }
  const rows = await fetchFreeSource(source, { ...options, noCache: true }, fetchImpl)
  return { rows, complete: false, nextCursor: null, coverage: 'limited-discovery', limitation: '该适配器没有可证明完整的增量分页；结果仅作为有限线索。' }
}
