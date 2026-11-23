// Bounded target-component -> public upstream research.
//
// This is intentionally a one-shot research helper, not a repository monitor.
// It records every query and candidate, keeps candidate confidence separate
// from trust, and never turns a commit message into a vulnerability finding.
import { createHash, randomUUID } from 'node:crypto'
import {
  compareComponentVersions,
  ensureComponentSchema,
  normalizeComponentProduct,
  readComponentFact,
} from './component-research.js'

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const NOW = () => new Date().toISOString()
const npmBase = () => String(process.env.SAKER_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '')
const githubBase = () => String(process.env.SAKER_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '')
const timeout = ms => AbortSignal.timeout(ms)

const fetchJson = async (url, options = {}) => {
  let response
  try {
    response = await fetch(url, { ...options, signal: timeout(12000), headers: { accept: 'application/json', 'user-agent': 'Saker-upstream-research', ...(options.headers || {}) } })
  } catch (error) {
    throw new Error(`upstream request failed: ${error?.message || error}`)
  }
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { /* preserve non-JSON diagnostics below */ }
  if (!response.ok) throw new Error(`upstream request ${response.status}: ${String(body?.message || text || response.statusText).slice(0, 500)}`)
  return body
}

const repoParts = value => {
  let raw = String(value || '').trim().replace(/^git\+/, '')
  if (!raw) return null
  if (/^github:/i.test(raw)) raw = 'https://github.com/' + raw.slice(7)
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) raw = 'https://github.com/' + raw
  let parsed
  try { parsed = new URL(raw) } catch { return null }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null
  const host = parsed.hostname.toLowerCase()
  const allowed = host === 'github.com' || host === 'www.github.com' || host === '127.0.0.1' || host === 'localhost'
  if (!allowed) return null
  const segments = parsed.pathname.replace(/\.git$/i, '').split('/').filter(Boolean)
  if (segments.length < 2) return null
  return { owner: segments[0], repo: segments[1], url: `https://github.com/${segments[0]}/${segments[1]}` }
}

const candidateKey = candidate => normalizeComponentProduct(candidate.packageName || candidate.name || '')
const candidateScore = (candidate, productKey) => {
  let score = 0
  if (candidateKey(candidate) === productKey) score += 20
  if (normalizeComponentProduct(candidate.repoName || '') === productKey) score += 10
  if (candidateKey(candidate).startsWith(productKey) || productKey.startsWith(candidateKey(candidate))) score += 3
  return score
}

function readMapping(store, sessionId, id) {
  const row = store.db.prepare('SELECT record FROM component_upstreams WHERE session_id=? AND id=?').get(sessionId, String(id || ''))
  if (!row) return null
  try { return JSON.parse(row.record) } catch { throw new Error('component upstream record is corrupt') }
}

export function listComponentUpstreams(store, sessionId, factId = '') {
  ensureComponentSchema(store)
  const rows = store.db.prepare('SELECT record FROM component_upstreams WHERE session_id=? ORDER BY rowid DESC').all(sessionId)
  return rows.map(row => {
    try { return JSON.parse(row.record) } catch { return null }
  }).filter(Boolean).filter(item => !factId || item.factId === factId)
}

async function discoverCandidates(fact, input = {}) {
  const productKey = normalizeComponentProduct(fact.product)
  const candidates = []
  const queries = []
  if (input.repositoryUrl) {
    const parts = repoParts(input.repositoryUrl)
    if (!parts) throw new Error('repositoryUrl must be a public GitHub repository URL')
    candidates.push({ source: 'user-supplied-url', packageName: '', repoName: parts.repo,
      repositoryUrl: parts.url, score: 100, confidence: 'explicit-url' })
  }
  if (!candidates.length || input.searchRegistry !== false) {
    const url = npmBase() + '/-/v1/search?text=' + encodeURIComponent(fact.product) + '&size=5'
    queries.push(url)
    try {
      const body = await fetchJson(url)
      for (const row of body?.objects || []) {
        const pkg = row?.package || {}
        const parts = repoParts(pkg.links?.repository || pkg.links?.homepage)
        if (!parts) continue
        const candidate = {
          source: 'npm-search',
          packageName: String(pkg.name || '').slice(0, 200),
          packageVersion: String(pkg.version || '').slice(0, 120),
          repoName: parts.repo,
          repositoryUrl: parts.url,
          homepage: String(pkg.links?.homepage || '').slice(0, 500),
          published: String(pkg.date || '').slice(0, 80),
        }
        candidate.score = candidateScore(candidate, productKey)
        candidate.confidence = candidate.score >= 20 ? 'exact-package-name' : candidate.score >= 10 ? 'exact-repository-name' : 'search-candidate'
        candidates.push(candidate)
      }
    } catch (error) {
      queries.push({ url, error: String(error?.message || error) })
    }
  }
  if (!candidates.length) {
    const url = githubBase() + '/search/repositories?q=' + encodeURIComponent(fact.product + ' in:name') + '&per_page=5'
    queries.push(url)
    try {
      const body = await fetchJson(url)
      for (const row of body?.items || []) {
        const parts = repoParts(row.html_url)
        if (!parts) continue
        const candidate = {
          source: 'github-search', packageName: '', repoName: parts.repo,
          repositoryUrl: parts.url, homepage: String(row.homepage || '').slice(0, 500),
          description: String(row.description || '').slice(0, 500), stars: Number(row.stargazers_count) || 0,
        }
        candidate.score = candidateScore(candidate, productKey)
        candidate.confidence = candidate.score >= 10 ? 'exact-repository-name' : 'search-candidate'
        candidates.push(candidate)
      }
    } catch (error) {
      queries.push({ url, error: String(error?.message || error) })
    }
  }
  return {
    queries,
    candidates: candidates.sort((a, b) => b.score - a.score || String(a.repositoryUrl).localeCompare(String(b.repositoryUrl))).slice(0, 8),
  }
}

export async function mapComponentUpstream(store, sessionId, input = {}) {
  ensureComponentSchema(store)
  const fact = readComponentFact(store, sessionId, input.factId || input.componentId)
  if (!fact) throw new Error('component fact not found in current session')
  const discovered = await discoverCandidates(fact, input)
  const exact = discovered.candidates.find(candidate => candidate.score >= 10) || null
  const mapping = {
    schema: 'saker.component-upstream/1',
    id: 'upstream-' + randomUUID(),
    factId: fact.id,
    product: fact.product,
    productKey: normalizeComponentProduct(fact.product),
    version: fact.version,
    targetMapped: fact.targetMapped === true,
    sourceKind: 'public-registry-discovery',
    status: exact ? 'candidate' : discovered.candidates.length ? 'needs-selection' : 'not-found',
    selected: exact,
    candidates: discovered.candidates,
    queries: discovered.queries,
    observedAt: NOW(),
    boundary: 'Repository association is a candidate based on public metadata. It is not proof that the target ships that source tree or that a commit is security-relevant.',
  }
  store.db.prepare(`INSERT INTO component_upstreams(session_id,id,fact_id,status,record,created_at)
    VALUES(?,?,?,?,?,?)`).run(sessionId, mapping.id, fact.id, mapping.status, JSON.stringify(mapping), NOW())
  return { ok: true, mapping }
}

const versionFromTag = name => {
  const raw = String(name || '').trim().replace(/^refs\/tags\//, '').replace(/^v(?=\d)/i, '')
  return raw || ''
}

const securityText = value => /(?:security|cve|vuln|auth(?:entication|orization)?|permission|saniti[sz]e|xss|csrf|ssrf|rce|traversal|injection|overflow)/i.test(String(value || ''))

export async function researchComponentUpstream(store, sessionId, input = {}) {
  ensureComponentSchema(store)
  const mapping = readMapping(store, sessionId, input.mappingId)
  if (!mapping) throw new Error('component upstream mapping not found')
  const index = Number.isInteger(Number(input.candidateIndex)) ? Number(input.candidateIndex) : 0
  const selected = input.repositoryUrl
    ? { ...(repoParts(input.repositoryUrl) || {}), confidence: 'explicit-url', source: 'user-supplied-url' }
    : (mapping.selected || mapping.candidates[index])
  if (!selected?.repositoryUrl) throw new Error('mapping has no selectable upstream repository')
  const parts = repoParts(selected.repositoryUrl)
  if (!parts) throw new Error('selected upstream repository is not a supported public GitHub URL')
  const repoMeta = await fetchJson(`${githubBase()}/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}`)
  const tagsBody = await fetchJson(`${githubBase()}/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/tags?per_page=100`)
  const tags = (Array.isArray(tagsBody) ? tagsBody : []).map(item => ({
    name: String(item.name || ''), version: versionFromTag(item.name), sha: String(item.commit?.sha || ''),
  })).filter(item => item.name && item.version)
  const targetVersion = String(mapping.version || '')
  let base = null, head = null
  for (const tag of tags) {
    const toTarget = targetVersion ? compareComponentVersions(tag.version, targetVersion) : null
    const toBase = base && targetVersion ? compareComponentVersions(tag.version, base.version) : null
    if (toTarget === 0 && !base) base = tag
    else if (toTarget !== null && toTarget < 0 && (!base || toBase > 0)) base = tag
    if (toTarget !== null && toTarget > 0 && (!head || compareComponentVersions(tag.version, head.version) < 0)) head = tag
  }
  if (!base && tags.length) base = tags[0]
  if (!head && base) head = tags.find(tag => compareComponentVersions(tag.version, base.version) > 0) || null
  let compared = null
  if (base && head && base.sha !== head.sha) {
    compared = await fetchJson(`${githubBase()}/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/compare/${encodeURIComponent(base.name)}...${encodeURIComponent(head.name)}`)
  }
  const commits = (compared?.commits || []).map(item => ({
    sha: String(item.sha || '').slice(0, 80),
    message: String(item.commit?.message || '').split('\n')[0].slice(0, 500),
  }))
  const files = (compared?.files || []).slice(0, 100).map(item => ({
    filename: String(item.filename || '').slice(0, 500),
    status: String(item.status || '').slice(0, 40),
    additions: Number(item.additions) || 0,
    deletions: Number(item.deletions) || 0,
  }))
  const securityCommits = commits.filter(item => securityText(item.message) || files.some(file => securityText(file.filename)))
  const materialId = 'upstream-material-' + randomUUID()
  const research = {
    schema: 'saker.component-upstream-research/1',
    repository: parts,
    verifiedRepository: String(repoMeta?.full_name || `${parts.owner}/${parts.repo}`),
    defaultBranch: String(repoMeta?.default_branch || ''),
    targetVersion,
    base,
    head,
    commits,
    files,
    securityCommits,
    status: head && base
      ? (securityCommits.length ? 'security-change-candidate' : 'relevant-window-no-security-message')
      : 'no-reliable-version-window',
    observedAt: NOW(),
    boundary: 'Tag selection and security keyword matching only narrow the review. They do not prove impact, a CVE, or that the deployed target contains the change.',
  }
  const material = {
    id: materialId,
    name: `${parts.owner}-${parts.repo}-${base?.name || 'unknown'}..${head?.name || 'unknown'}.json`,
    source: 'public-upstream-api',
    sourceUrl: `${parts.url}/compare/${encodeURIComponent(base?.name || '')}...${encodeURIComponent(head?.name || '')}`,
    digest: digest(research),
    record: research,
  }
  store.db.prepare('INSERT OR REPLACE INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
    .run(sessionId, materialId, material.sourceUrl, material.digest, JSON.stringify(material))
  const advisoryDraft = securityCommits.length && head ? {
    kind: 'security-change',
    product: mapping.product,
    sourceRef: materialId,
    sourceKind: 'upstream-api',
    sourceLabel: `${parts.owner}/${parts.repo} ${base?.name || '?'}..${head.name}`,
    upstreamUrl: parts.url,
    commit: securityCommits[0]?.sha || '',
    fixedVersion: head.version,
    changedFiles: files.map(file => file.filename),
    changeSummary: securityCommits.map(item => item.message).join(' | ').slice(0, 2000),
    // The compare proves a changed window, not the complete affected range.
    // The model must fill a sourced range before importing/evaluating it.
    affected: [],
    conditions: [],
  } : null
  const updated = { ...mapping, selected, research, materialId, advisoryDraft, status: research.status, researchedAt: NOW() }
  store.db.prepare('UPDATE component_upstreams SET status=?,record=? WHERE session_id=? AND id=?')
    .run(updated.status, JSON.stringify(updated), sessionId, mapping.id)
  return { ok: true, mapping: updated, research, material, advisoryDraft }
}

export function componentUpstreamStatus(store, sessionId, factId = '') {
  return { ok: true, mappings: listComponentUpstreams(store, sessionId, factId) }
}
