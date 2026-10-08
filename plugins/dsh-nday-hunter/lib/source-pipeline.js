// Persistent public-source collection for Nday discovery.
//
// Source records, revisions and page checkpoints commit together in SQLite.
// The JSON state is a small inspection mirror, never the record database.

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { resolveDshHome } from './home.js'
export { freshnessOf, dedupKeyOf, enrichCandidate, mergeCandidates } from './source-records.js'
import { SourceIndex, SOURCE_INDEX_SCHEMA } from './source-index.js'
import { fetchSourcePage } from './source-pages.js'
import { assessSourceDocument } from './source-applicability.js'
import { NDAY_SOURCE_REGISTRY, sourceRegistrySummary } from './source-registry.js'
import { readSourceZipEntry } from './source-zip.js'
import { verifyExport } from './osv-export-storage.js'
import { normalizeSubscriptions, repositoryDescriptor } from './source-subscriptions.js'

export const COLLECTOR_SCHEMA = SOURCE_INDEX_SCHEMA
export const DEFAULT_COLLECTOR_CONFIG = Object.freeze({
  // Keep scheduled network work opt-in; the settings panel exposes the toggle.
  enabled: false,
  intervalHours: 24,
  sources: Object.freeze(['cisa-kev', 'nvd', 'osv', 'github-advisories', 'nuclei']),
  query: '',
  lastDays: 30,
  limit: 50,
  wechatQuery: '',
  maxPagesPerRun: 5,
  repositories: Object.freeze([]),
  reviewSources: Object.freeze([]),
  reviewPerRun: 3,
  reviewPer24Hours: 10,
})

function nowIso(now = Date.now()) {
  return new Date(now).toISOString()
}

function clean(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function asTime(value) {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : null
}

export function collectorPaths(home = resolveDshHome()) {
  const dir = path.join(home, 'nday-hunter')
  return {
    dir,
    config: path.join(dir, 'collector.json'),
    state: path.join(dir, 'collector-state.json'),
    index: path.join(dir, 'source-index.sqlite'),
    lock: path.join(dir, 'collector.lock'),
    revisions: path.join(dir, 'source-revisions.jsonl'),
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const pending = `${file}.pending-${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    fs.renameSync(pending, file)
  } finally { if (fs.existsSync(pending)) fs.unlinkSync(pending) }
}

function sourceIds(values, fallback = DEFAULT_COLLECTOR_CONFIG.sources, repositories = []) {
  const known = new Set(NDAY_SOURCE_REGISTRY.map((row) => row.id))
  for (const row of repositories) known.add(row.id)
  const selected = (Array.isArray(values) ? values : fallback)
    .map((value) => clean(value, 40).toLowerCase())
    .filter((value) => known.has(value))
  return [...new Set(selected)]
}

function integer(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

export function normalizeCollectorConfig(value = {}) {
  const merged = { ...DEFAULT_COLLECTOR_CONFIG, ...(value && typeof value === 'object' ? value : {}) }
  const repositories = normalizeSubscriptions(merged.repositories)
  return {
    enabled: merged.enabled !== false,
    intervalHours: integer(merged.intervalHours, DEFAULT_COLLECTOR_CONFIG.intervalHours, 1, 168),
    sources: sourceIds(merged.sources, DEFAULT_COLLECTOR_CONFIG.sources, repositories),
    query: clean(merged.query, 240),
    lastDays: integer(merged.lastDays, DEFAULT_COLLECTOR_CONFIG.lastDays, 1, 365),
    limit: integer(merged.limit, DEFAULT_COLLECTOR_CONFIG.limit, 1, 100),
    wechatQuery: clean(merged.wechatQuery, 240),
    maxPagesPerRun: integer(merged.maxPagesPerRun, 5, 1, 100),
    repositories,
    reviewSources: sourceIds(merged.reviewSources, [], repositories),
    reviewPerRun: integer(merged.reviewPerRun, 3, 1, 20),
    reviewPer24Hours: integer(merged.reviewPer24Hours, 10, 1, 100),
  }
}

export function readCollectorConfig(home = resolveDshHome()) {
  return normalizeCollectorConfig(readJson(collectorPaths(home).config, {}))
}

export function writeCollectorConfig(value, home = resolveDshHome()) {
  const config = normalizeCollectorConfig(value)
  writeJson(collectorPaths(home).config, config)
  return config
}

function readCollectorMirror(home) {
  const file = collectorPaths(home).state
  let state
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`Collector state unreadable; existing data preserved: ${error.message}`)
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || (state.records !== undefined && !Array.isArray(state.records))) throw new Error('Collector state invalid; existing data preserved')
  return state
}

function openSourceIndex(home, now = Date.now()) {
  return new SourceIndex(collectorPaths(home), readCollectorMirror(home), now)
}

export function readCollectorState(home = resolveDshHome(), now = Date.now()) {
  const index = openSourceIndex(home, now)
  try { return index.state(now) } finally { index.close() }
}

export function querySourceCandidates(options = {}, home = resolveDshHome()) {
  const index = openSourceIndex(home, options.now)
  try { return index.query(options) } finally { index.close() }
}

export function readSourceRecord(source, id, home = resolveDshHome(), revision = null) {
  const index = openSourceIndex(home)
  try { return index.record(source, id, revision) } finally { index.close() }
}

export function readSourceHistory(source, id, options = {}, home = resolveDshHome()) {
  const index = openSourceIndex(home)
  try { return index.history(source, id, options) } finally { index.close() }
}

function loadSourceContent(source, id, revision, home) {
  const row = readSourceRecord(source, id, home, revision ?? null)
  if (!row) throw new Error('Stored source record not found')
  const metadata = row.repositoryFile ?? row.official ?? row.advisory
  if (!(metadata?.contentFile || metadata?.contentArchive) || !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? '') || metadata.contentAvailable === false)
    throw new Error('Original source content is unavailable; coverage gap retained')
  const root = fs.realpathSync(path.join(collectorPaths(home).dir, 'source-content'))
  const file = fs.realpathSync(metadata.contentFile ?? metadata.contentArchive)
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Original source path is outside its cache')
  const stat = fs.statSync(file)
  let bytes
  if (metadata.contentArchive) {
    if (source !== 'osv' || metadata.format !== 'osv' || metadata.archiveEntry?.name !== id + '.json' || !stat.isFile() || stat.size > 8 * 1024 ** 3) throw new Error('Original source archive metadata differs')
    verifyExport(file, { size: metadata.archiveEntry.archiveSize, sha256: metadata.archiveSha256, md5Hash: metadata.archiveMd5Hash })
    bytes = readSourceZipEntry(file, metadata.archiveEntry)
  } else {
    if (!stat.isFile() || stat.size > (metadata.format === 'osv' ? 32 : 8) * 1024 * 1024) throw new Error('Original source file exceeds byte limit')
    bytes = fs.readFileSync(file)
  }
  if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error('Original source content digest differs')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return { row, metadata, bytes, text }
}

export function readSourceApplicability(source, id, environment, options = {}, home = resolveDshHome()) {
  const { row, metadata, text } = loadSourceContent(source, id, options.revision, home)
  const format = row.advisory?.format ?? 'unsupported-source-format'
  const assessment = assessSourceDocument(['osv', 'nvd-cve-2.0'].includes(format) ? JSON.parse(text) : {}, format, environment)
  return { ...assessment, source, id, revision: row.revision, sha256: metadata.sha256 }
}

export function readSourceContent(source, id, options = {}, home = resolveDshHome()) {
  const { row, metadata, bytes, text } = loadSourceContent(source, id, options.revision, home)
  const offset = options.offset ?? 0, limit = options.limit ?? 12000
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || !Number.isInteger(limit) || limit < 1 || limit > 16000)
    throw new Error('Invalid original source text page')
  const excerpt = text.slice(offset, offset + limit)
  return { source, id, revision: row.revision, sha256: metadata.sha256, representation: metadata.representation ?? 'original-file', totalBytes: bytes.length,
    totalCharacters: text.length, offset, text: excerpt, nextOffset: offset + excerpt.length < text.length ? offset + excerpt.length : null }
}

async function withLock(home, fn) {
  const paths = collectorPaths(home)
  fs.mkdirSync(paths.dir, { recursive: true })
  let descriptor
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = fs.openSync(paths.lock, 'wx')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let stale = false
      try {
        const [rawPid, rawAt] = fs.readFileSync(paths.lock, 'utf8').split(/\r?\n/)
        const pid = Number(rawPid)
        const at = Number(rawAt)
        if (!Number.isFinite(pid) || pid <= 0) stale = true
        else {
          try {
            process.kill(pid, 0)
            // A live owner keeps its lock even during a slow synchronization.
          } catch (probeError) {
            if (probeError?.code === 'ESRCH') stale = true
            else if (probeError?.code !== 'EPERM') stale = true
          }
        }
      } catch {
        stale = true
      }
      if (stale && attempt === 0) {
        try { fs.unlinkSync(paths.lock) } catch { /* another process may have won the race */ }
        continue
      }
      return { skipped: true, reason: 'collector already running' }
    }
  }
  if (descriptor === undefined) return { skipped: true, reason: 'collector lock unavailable' }
  try {
    fs.writeSync(descriptor, `${process.pid}\n${Date.now()}\n`)
    return await fn()
  } finally {
    fs.closeSync(descriptor)
    try { fs.unlinkSync(paths.lock) } catch { /* best effort */ }
  }
}

// Desktop/model responses carry summaries; original source records stay in storage.
export function collectorResponse(state, { includeCandidates = false, limit = 20 } = {}) {
  const candidates = Array.isArray(state.candidates) ? state.candidates : []
  const page = includeCandidates ? candidates.slice(0, integer(limit, 20, 1, 100)).map(row => ({
    id: clean(row.id, 160), title: clean(row.title, 300), summary: clean(row.summary, 800),
    source: clean(row.source, 60), sources: (row.sources ?? []).slice(0, 12).map(value => clean(value, 60)),
    url: clean(row.url, 1000), published: clean(row.published, 40), publishedAt: clean(row.publishedAt, 40),
    trust: clean(row.trust, 30), freshness: clean(row.freshness, 30), status: clean(row.status, 80),
    requiresSourceReview: row.requiresSourceReview === true,
  })) : []
  return {
    ok: state.ok, skipped: state.skipped, reason: state.reason, schema: state.schema,
    lastRunAt: state.lastRunAt, nextDueAt: state.nextDueAt, running: state.running,
    summary: state.summary ?? null, sources: state.sources ?? [], checkpoints: state.checkpoints ?? {},
    recordCount: state.recordCount ?? (Array.isArray(state.records) ? state.records.length : 0),
    candidateCount: state.candidateCount ?? candidates.length, candidates: page,
    candidatesTruncated: includeCandidates && page.length < (state.candidateCount ?? candidates.length),
  }
}

export function collectorStatus(home = resolveDshHome(), now = Date.now(), options = {}) {
  const config = readCollectorConfig(home)
  const registryRows = [...NDAY_SOURCE_REGISTRY, ...config.repositories.map(row => ({ id: row.id, label: row.repository,
    category: 'research-project', integration: 'git', auth: 'public-git', implemented: true,
    configuredVia: '漏洞情报更新 → GitHub 仓库订阅', detail: row.mode === 'ai' ? '增量同步并由 AI 整理；待复核知识条目' : '固定提交增量同步原始资料' }))]
  const state = readCollectorState(home, now)
  const nextDue = asTime(state.nextDueAt)
  // A persisted running flag survives a crash. Only a live lock owner means
  // the collector is still running; otherwise the UI must allow resumption.
  let running = false
  try {
    const pid = Number(fs.readFileSync(collectorPaths(home).lock, 'utf8').split(/\r?\n/)[0])
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); running = true }
      catch (error) { running = error.code === 'EPERM' }
    }
  } catch { /* No readable lock owner: allow a new attempt through withLock. */ }
  return {
    ...collectorResponse(state, options),
    schema: COLLECTOR_SCHEMA,
    config,
    lastRunAt: state.lastRunAt || null,
    nextDueAt: state.nextDueAt || null,
    due: config.enabled && (nextDue === null || nextDue <= now),
    running,
    interrupted: Boolean(state.running) && !running,
    summary: state.summary ? { ...state.summary, mergedCandidates: state.candidateCount, freshCandidates: state.freshCandidates } : null,
    sources: state.sources ?? [],
    registry: { summary: sourceRegistrySummary(registryRows), rows: registryRows },
  }
}

export async function runCollector(options = {}, deps = {}) {
  const home = deps.home ?? resolveDshHome()
  const now = deps.now ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const config = normalizeCollectorConfig({ ...readCollectorConfig(home), ...options })
  return withLock(home, async () => {
    const indexStore = openSourceIndex(home, now)
    try {
    const startedAt = nowIso(now)
    const previous = indexStore.metadata('state', {})
    const checkpoints = { ...(previous.checkpoints ?? {}) }
    const sourceRows = []
    let collectedCount = 0
    const state = { ...previous, schema: COLLECTOR_SCHEMA, lastRunAt: startedAt,
      nextDueAt: startedAt, running: true, checkpoints, sources: sourceRows }
    const save = (rows = [], snapshotSource = null) => {
      indexStore.commitPage(rows, state, { now, snapshotSource })
      // A failed mirror write cannot roll back an already committed cursor.
      // The next run reads the authoritative database, not this stale mirror.
      try { writeJson(collectorPaths(home).state, { ...state, ...indexStore.counts(now) }) }
      catch (error) { state.mirrorWarning = `Inspection mirror write failed; database committed: ${String(error.message).slice(0, 300)}` }
    }
    save()
    for (const source of config.sources) {
      const query = source === 'wechat' ? config.wechatQuery : config.query
      if (source === 'wechat' && !query) {
        sourceRows.push({ source, ok: false, skipped: true, error: '未配置公众号检索词，跳过公众号源' })
        continue
      }
      const subscription = config.repositories.find(row => row.id === source)
      const descriptor = subscription ? repositoryDescriptor(subscription) : undefined
      const selection = JSON.stringify({ query, limit: config.limit, lastDays: config.lastDays,
        ...(subscription ? { repository: subscription.repository } : {}) })
      const retained = checkpoints[source]
      const checkpoint = retained?.selection === selection ? retained : { selection, watermark: null, failures: 0 }
      checkpoints[source] = checkpoint
      if (asTime(checkpoint.retryAt) > now && options.noCache !== true) {
        sourceRows.push({ source, ok: false, skipped: true, status: 'backoff', error: checkpoint.error, retryAt: checkpoint.retryAt })
        continue
      }
      if (!checkpoint.window) {
        // NVD modification windows cannot exceed 120 days. Catch up in bounded
        // windows instead of jumping the watermark over an offline interval.
        const watermark = asTime(checkpoint.watermark)
        const since = watermark === null ? now - Math.min(source === 'nvd' ? 120 : 365, config.lastDays) * 86400000
          : watermark - (source === 'osv' ? 86400000 : 0)
        const until = source === 'nvd' ? Math.min(now, since + 119 * 86400000) : now
        checkpoint.window = { since: nowIso(since), until: nowIso(until), cursor: null }
        checkpoint.contentGaps = 0
      }
      let count = 0
      try {
        let page
        for (let index = 0; index < config.maxPagesPerRun; index++) {
          const window = checkpoint.window
          page = await (deps.fetchPage ?? fetchSourcePage)(source, { query, limit: config.limit,
            lastDays: config.lastDays, home, revision: checkpoint.revision ?? null, gitDeps: deps.gitDeps,
            repositoryDescriptor: descriptor, ...window }, fetchImpl)
          if (!Array.isArray(page?.rows) || typeof page.complete !== 'boolean') throw new Error('Invalid source page result')
          if (!page.complete && page.nextCursor !== null && page.nextCursor === window.cursor) throw new Error('Source pagination cursor made no progress')
          const coveredUntil = page.coveredUntil ?? window.until
          if (page.complete && (asTime(coveredUntil) === null || asTime(coveredUntil) < asTime(window.since) || asTime(coveredUntil) > asTime(window.until))) throw new Error('Source coverage exceeds or invalidates the synchronization window')
          if (page.completedRevision !== undefined && (!page.complete || !/^[a-f0-9]{40}$/.test(page.completedRevision))) throw new Error('Source completion revision is invalid')
          if (page.unreadable !== undefined && (!Number.isSafeInteger(page.unreadable) || page.unreadable < 0)) throw new Error('Source content gap count is invalid')
          for (const row of page.rows) {
            if (row.source !== source || !row.id) throw new Error('Source record identity is missing or inconsistent')
          }
          const beforeCheckpoint = structuredClone(checkpoint)
          checkpoint.coverage = page.coverage
          for (const key of ['downloadBytes', 'downloadTotalBytes']) if (page[key] !== undefined) {
            if (!Number.isSafeInteger(page[key]) || page[key] < 0 || page[key] > 8 * 1024 ** 3) throw new Error('Source download progress invalid')
            checkpoint[key] = page[key]
          }
          checkpoint.contentGaps = (checkpoint.contentGaps ?? 0) + (page.unreadable ?? 0)
          checkpoint.failures = 0
          checkpoint.retryAt = null
          checkpoint.error = ''
          if (page.complete) {
            checkpoint.watermark = coveredUntil
            if (page.completedRevision !== undefined) checkpoint.revision = page.completedRevision
            checkpoint.window = null
            checkpoint.lastCompleteAt = startedAt
            checkpoint.status = 'complete'
            checkpoint.pendingFollowup = page.baselineComplete === true
          } else {
            if (page.nextCursor) {
              checkpoint.window.cursor = page.nextCursor
              checkpoint.status = 'partial'
            } else {
              checkpoint.window = null
              checkpoint.status = 'limited'
              checkpoint.lastDiscoveryAt = startedAt
            }
          }
          try { save(page.rows, page.snapshot === true && page.complete ? source : null) }
          catch (error) {
            for (const key of Object.keys(checkpoint)) delete checkpoint[key]
            Object.assign(checkpoint, beforeCheckpoint)
            throw error
          }
          collectedCount += page.rows.length
          count += page.rows.length
          if (page.complete || !page.nextCursor) break
        }
        sourceRows.push({ source, ok: true, count, status: checkpoint.status,
          complete: checkpoint.status === 'complete', coverage: checkpoint.coverage,
          watermark: checkpoint.watermark, cursor: checkpoint.window?.cursor ?? null,
          revision: checkpoint.revision ?? null, contentGaps: checkpoint.contentGaps ?? 0,
          downloadBytes: checkpoint.downloadBytes ?? 0, downloadTotalBytes: checkpoint.downloadTotalBytes ?? 0,
          error: '', limitation: page?.limitation ?? '' })
      } catch (error) {
        checkpoint.failures = (checkpoint.failures ?? 0) + 1
        checkpoint.error = String(error?.message || error).slice(0, 1000)
        checkpoint.retryAt = nowIso(now + Math.min(24 * 3600000, 60000 * 2 ** Math.min(checkpoint.failures - 1, 10)))
        checkpoint.status = count ? 'partial-failed' : 'failed'
        sourceRows.push({ source, ok: false, count, status: checkpoint.status, complete: false,
          error: checkpoint.error, watermark: checkpoint.watermark, cursor: checkpoint.window?.cursor ?? null, retryAt: checkpoint.retryAt })
        save()
      }
    }
    const counts = indexStore.counts(now)
    const pendingAt = Object.values(checkpoints).filter(row => row.window || row.pendingFollowup).map(row => asTime(row.retryAt) ?? now + 60000)
    Object.assign(state, {
      nextDueAt: nowIso(Math.min(now + config.intervalHours * 3600000, ...pendingAt)), running: false,
      summary: {
        sourceCount: sourceRows.length,
        okSources: sourceRows.filter((row) => row.ok).length,
        completeSources: sourceRows.filter(row => row.complete).length,
        partialSources: sourceRows.filter(row => row.status?.startsWith('partial')).length,
        limitedSources: sourceRows.filter(row => row.status === 'limited').length,
        failedSources: sourceRows.filter((row) => !row.ok && !row.skipped).length,
        skippedSources: sourceRows.filter((row) => row.skipped).length,
        rawCandidates: collectedCount,
        mergedCandidates: counts.candidateCount,
        freshCandidates: counts.freshCandidates,
      },
    })
    save()
    return { ok: sourceRows.every(row => row.ok || row.skipped), ...indexStore.state(now) }
    } finally { indexStore.close() }
  })
}

export async function runCollectorIfDue(options = {}, deps = {}) {
  const home = deps.home ?? resolveDshHome()
  const now = deps.now ?? Date.now()
  const config = readCollectorConfig(home)
  const state = readCollectorState(home)
  const nextDue = asTime(state.nextDueAt)
  if (!config.enabled && options.force !== true) {
    return { skipped: true, reason: 'collector disabled', config, state }
  }
  if (nextDue !== null && nextDue > now && options.force !== true) {
    return { skipped: true, reason: 'collector not due', config, state }
  }
  return runCollector(options, { ...deps, home, now })
}
