// Offline hybrid retrieval for the knowledge hub.
//
// The engine deliberately stays dependency-free:
//   · node:sqlite DatabaseSync provides a durable FTS5 index
//   · Chinese text is expanded into bigrams before indexing, so two-character
//     terms such as 盲注/提权 are recallable without a tokenizer sidecar
//   · BM25 supplies the semantic-adjacent ranking; metadata and exact IDs add
//     deterministic boosts, while EDB hits are merged by the caller
//
// It is a retrieval-augmented tool, not a chat transcript store: chunks are
// returned only when the model explicitly calls knowledge_search/read.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export const INDEX_VERSION = 2

export const TEXT_EXTS = new Set([
  '.md', '.txt', '.yaml', '.yml', '.json', '.csv',
  '.py', '.ps1', '.sh', '.bash', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.html', '.htm', '.xml', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.rs', '.go', '.java', '.php', '.rb', '.pl', '.lua', '.sql',
])

const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.cache', '.index',
  'images', 'img', 'assets', 'static', 'dist', 'build', 'coverage',
])

function isIndexablePath(rel) {
  const ext = path.extname(rel).toLowerCase()
  if (TEXT_EXTS.has(ext) || ext === '.pdf') return true
  return rel.startsWith('_gtfobins/') || rel.includes('/_gtfobins/')
}

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILES = 60000
const MAX_CHUNK_CHARS = 1400
const CHUNK_OVERLAP_LINES = 4
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20
const ROOTS_FINGERPRINT_TTL_MS = 60_000

function nowIso() {
  return new Date().toISOString()
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
}

function isHan(ch) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(ch)
}

/**
 * Build a search-friendly string. The original text is retained by callers for
 * display; this function only exists for the FTS column.
 */
export function searchableText(value) {
  const text = normalizeText(value)
  const out = []
  const runs = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) || []
  for (const run of runs) {
    if (run.length === 1) out.push(run)
    else {
      for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
    }
  }
  // Latin/CVE terms are indexed from the original columns. This extra field
  // stores only Han bigrams, avoiding a full duplicate of 50MB+ of source text.
  return out.join(' ')
}

function splitQueryTerms(query) {
  const q = normalizeText(query).trim().toLowerCase()
  if (!q) return []
  const terms = []
  const latin = q.match(/[a-z0-9][a-z0-9_.:/@+-]*/gi) || []
  for (const token of latin) terms.push(token)
  const hanRuns = q.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) || []
  for (const run of hanRuns) {
    if (run.length === 1) terms.push(run)
    else {
      for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2))
    }
  }
  return [...new Set(terms.filter((t) => t.length > 0))].slice(0, 16)
}

function quoteFtsTerm(term) {
  return `"${String(term).replace(/"/g, '""')}"`
}

function ftsQuery(query, mode = 'and') {
  const terms = splitQueryTerms(query)
  if (terms.length === 0) return ''
  return terms.map(quoteFtsTerm).join(mode === 'or' ? ' OR ' : ' AND ')
}

function safeFilePath(root, file) {
  const resolved = path.resolve(file)
  const base = path.resolve(root)
  return resolved === base || resolved.startsWith(base + path.sep)
}

function walkFiles(root, maxFiles = MAX_FILES) {
  const out = []
  const stack = ['']
  while (stack.length && out.length < maxFiles) {
    const relDir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) stack.push(rel)
      } else if (entry.isFile() && isIndexablePath(rel)) {
        out.push(rel)
        if (out.length >= maxFiles) break
      }
    }
  }
  return out
}

function readTextFile(file) {
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
  if (path.extname(file).toLowerCase() === '.pdf') {
    const title = path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ')
    return { text: `# ${title}\n\nPDF document. Search matches its title and path; extract the PDF contents locally when the full text is needed.`, stat: st }
  }
  try {
    return { text: normalizeText(fs.readFileSync(file, 'utf8')), stat: st }
  } catch {
    return null
  }
}

function lineCount(text) {
  return text.length === 0 ? 0 : text.split('\n').length
}

function isHeadingLine(line) {
  return /^\s{0,3}#{1,6}\s+/.test(line) || /^\s{0,3}(?:=+|-{3,})\s*$/.test(line)
}

function headingOf(lines, index) {
  const line = String(lines[index] || '').trim()
  const atx = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/)
  if (atx) return atx[1].trim()
  if (index > 0 && /^\s{0,3}(?:=+|-{3,})\s*$/.test(line)) return String(lines[index - 1] || '').trim()
  return ''
}

/**
 * Heading-aware chunking. The returned text keeps original line breaks and
 * carries exact 1-based line bounds for knowledge_read(hitId).
 */
export function chunkText(value, options = {}) {
  const text = normalizeText(value)
  const maxChars = Math.max(300, Number(options.maxChars) || MAX_CHUNK_CHARS)
  if (!text) return []
  const lines = text.split('\n')
  const chunks = []
  let current = []
  let currentChars = 0
  let startLine = 1
  let activeHeading = ''
  let pendingHeading = ''

  const flush = (endLine) => {
    if (current.length === 0) return
    const body = current.join('\n').trim()
    if (!body) {
      current = []
      currentChars = 0
      return
    }
    chunks.push({
      text: body,
      heading: activeHeading || pendingHeading || '',
      startLine,
      endLine: Math.max(startLine, endLine),
    })
    const tail = current.slice(-CHUNK_OVERLAP_LINES)
    current = tail.length ? tail.slice() : []
    currentChars = current.join('\n').length
    startLine = Math.max(startLine, endLine - current.length + 1)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1
    if (isHeadingLine(line)) {
      const h = headingOf(lines, i)
      if (h) {
        flush(lineNo - 1)
        activeHeading = h
        pendingHeading = h
        startLine = lineNo
      }
    }
    if (current.length === 0) startLine = lineNo
    current.push(line)
    currentChars += line.length + 1
    if (currentChars >= maxChars) flush(lineNo)
  }
  flush(lines.length)
  return chunks
}

function makeTitle(rel, body) {
  const heading = normalizeText(body).match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/m)
  if (heading) return heading[1].trim().slice(0, 160)
  return path.basename(rel, path.extname(rel)).replace(/[-_]+/g, ' ').slice(0, 160)
}

function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex')
}

function sourceIdOf(source) {
  return `${source.kind}:${source.mode || 'general'}:${source.packId || source.id || 'root'}`
}

function sourceModeMatches(source, mode) {
  if (!mode) return true
  if (!source.mode) return true
  return source.mode === mode
}

function scoreBoost(query, row) {
  const q = normalizeText(query).toLowerCase().trim()
  const hay = `${row.title || ''}\n${row.heading || ''}\n${row.path || ''}`.toLowerCase()
  const body = String(row.body || '').toLowerCase()
  let boost = 0
  if (q && row.title && String(row.title).toLowerCase().includes(q)) boost += 8
  if (q && row.heading && String(row.heading).toLowerCase().includes(q)) boost += 5
  if (q && row.path && String(row.path).toLowerCase().includes(q)) boost += 3
  if (q && body.includes(q)) boost += 2
  const terms = splitQueryTerms(query)
  if (terms.length > 1 && terms.every((term) => body.includes(term) || hay.includes(term))) boost += 2
  boost += Math.min(3, Number(row.priority) || 0)
  return boost
}

function snippetFor(body, query, maxChars = 260) {
  const text = normalizeText(body)
  const terms = splitQueryTerms(query)
  let index = -1
  let matched = ''
  for (const term of terms) {
    const at = text.toLowerCase().indexOf(term.toLowerCase())
    if (at >= 0 && (index < 0 || at < index)) {
      index = at
      matched = term
    }
  }
  if (index < 0) index = 0
  const before = Math.floor(maxChars * 0.3)
  const start = Math.max(0, index - before)
  const end = Math.min(text.length, start + maxChars)
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) snippet = '…' + snippet
  if (end < text.length) snippet += '…'
  return { snippet, matched }
}

function lineAtMatch(row, query) {
  const body = normalizeText(row.body)
  const terms = splitQueryTerms(query)
  let best = -1
  for (const term of terms) {
    const at = body.toLowerCase().indexOf(term.toLowerCase())
    if (at >= 0 && (best < 0 || at < best)) best = at
  }
  if (best < 0) return Number(row.start_line) || 0
  return (Number(row.start_line) || 1) + body.slice(0, best).split('\n').length - 1
}

export class KnowledgeIndex {
  constructor(options = {}) {
    this.dbPath = String(options.dbPath || '')
    this.roots = Array.isArray(options.roots) ? options.roots : []
    this.logger = options.logger || console
    this.db = null
    this.lastError = ''
    this.lastBuild = null
    this.rebuildCount = 0
    this.dirty = false
    this.dirtyAt = 0
    this.rootsFingerprint = null
    this.rootsFingerprintAt = 0
    // 计数缓存：status() 原来每次都 `COUNT(*)` 整表（8.4 万+ chunk，实测 ~140ms），
    // 而 ensureKnowledgeIndex() 每次检索都会问一次 status —— 于是每次知识检索都在全表计数。
    // 计数只在重建/失效时变，缓存后按需刷新（status({ counts: true })）。
    this.counts = null
  }

  open() {
    if (this.db) return this.db
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
    const db = new DatabaseSync(this.dbPath)
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA wal_autocheckpoint=1000;
      PRAGMA temp_store=MEMORY;
      PRAGMA cache_size=-65536;
      CREATE TABLE IF NOT EXISTS knowledge_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_docs (
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        sha1 TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (source_id, path)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks USING fts5(
        source_id UNINDEXED,
        kind UNINDEXED,
        scope UNINDEXED,
        pack_id UNINDEXED,
        license UNINDEXED,
        priority UNINDEXED,
        path,
        path_search,
        title,
        title_search,
        heading,
        heading_search,
        body,
        body_search,
        start_line UNINDEXED,
        end_line UNINDEXED,
        tokenize='unicode61 remove_diacritics 2'
      );
    `)
    this.db = db
    return db
  }

  close() {
    if (!this.db) return
    try {
      this.db.close()
    } catch {
      // already closed
    }
    this.db = null
  }

  invalidate() {
    this.lastBuild = null
    this.counts = null
    this.rootsFingerprint = null
    this.rootsFingerprintAt = 0
    this.dirty = true
    this.dirtyAt = Date.now()
  }

  markClean() {
    this.dirty = false
    this.dirtyAt = 0
  }

  countFiles() {
    let count = 0
    for (const source of this.roots) {
      if (!source || !source.root || !fs.existsSync(source.root)) continue
      count += walkFiles(source.root, Math.max(0, MAX_FILES - count)).length
      if (count >= MAX_FILES) break
    }
    return count
  }

  /**
   * Durable source fingerprint used to detect knowledge changes made while the
   * host was not running (git pack sync, external file drops, manual edits).
   * Counting alone misses same-count edits, so the hash includes each indexed
   * file's path, size and mtime.
   */
  currentRootsFingerprint() {
    const hash = crypto.createHash('sha1')
    let files = 0
    for (const source of this.roots) {
      if (!source || !source.root || !fs.existsSync(source.root)) continue
      hash.update(`${source.id}\0${source.root}\0`)
      for (const rel of walkFiles(source.root)) {
        let stat
        try {
          stat = fs.statSync(path.join(source.root, rel))
        } catch {
          continue
        }
        hash.update(`${rel}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}\0`)
        files += 1
      }
    }
    return { hash: hash.digest('hex'), files }
  }

  status(options = {}) {
    const db = this.open()
    const one = (key) => {
      try {
        return db.prepare('SELECT value FROM knowledge_meta WHERE key = ?').get(key)?.value || ''
      } catch {
        return ''
      }
    }
    let chunks = Number(this.counts?.chunks || 0)
    let docs = Number(this.counts?.docs || 0)
    if (options.counts === true || this.counts === null) {
      try {
        chunks = Number(db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get().n || 0)
        docs = Number(db.prepare('SELECT COUNT(*) AS n FROM knowledge_docs').get().n || 0)
        this.counts = { chunks, docs }
      } catch {
        // empty or partially created index
      }
    }
    const now = Date.now()
    if (
      options.refreshFingerprint === true
      || this.rootsFingerprint === null
      || now - this.rootsFingerprintAt >= ROOTS_FINGERPRINT_TTL_MS
    ) {
      const current = this.currentRootsFingerprint()
      this.rootsFingerprint = current.hash
      this.rootsFingerprintAt = now
      const stored = one('roots_fingerprint')
      if (!stored || stored !== current.hash) {
        if (!this.dirty) {
          this.dirty = true
          this.dirtyAt = now
        }
      }
    }
    return {
      version: INDEX_VERSION,
      dbPath: this.dbPath,
      docs,
      chunks,
      indexedAt: one('indexed_at'),
      lastError: this.lastError,
      dirty: this.dirty,
      dirtyAt: this.dirtyAt,
    }
  }

  rebuild(options = {}) {
    const db = this.open()
    const force = !!options.force
    const started = Date.now()
    const stats = { filesSeen: 0, filesIndexed: 0, filesSkipped: 0, filesRemoved: 0, chunks: 0, errors: 0 }
    const seenBySource = new Map()
    const activeSources = new Set()

    const begin = db.prepare('BEGIN')
    const commit = db.prepare('COMMIT')
    const rollback = db.prepare('ROLLBACK')
    begin.run()
    try {
      if (force) {
        db.exec('DELETE FROM knowledge_chunks; DELETE FROM knowledge_docs;')
      }
      const selectDoc = db.prepare('SELECT mtime_ms, size, sha1, chunk_count FROM knowledge_docs WHERE source_id = ? AND path = ?')
      const upsertDoc = db.prepare(`
        INSERT INTO knowledge_docs(source_id, path, mtime_ms, size, sha1, chunk_count, indexed_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, path) DO UPDATE SET
          mtime_ms=excluded.mtime_ms,
          size=excluded.size,
          sha1=excluded.sha1,
          chunk_count=excluded.chunk_count,
          indexed_at=excluded.indexed_at
      `)
      const deleteDoc = db.prepare('DELETE FROM knowledge_docs WHERE source_id = ? AND path = ?')
      const deleteChunks = db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ? AND path = ?')
      const insertChunk = db.prepare(`
        INSERT INTO knowledge_chunks(
          source_id, kind, scope, pack_id, license, priority,
          path, path_search, title, title_search, heading, heading_search,
          body, body_search, start_line, end_line
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      for (const source of this.roots) {
        if (!source || !source.root || !fs.existsSync(source.root)) continue
        const sourceStarted = Date.now()
        const root = fs.realpathSync(source.root)
        const sourceId = sourceIdOf({ ...source, root })
        activeSources.add(sourceId)
        if (!seenBySource.has(sourceId)) seenBySource.set(sourceId, new Set())
        const seen = seenBySource.get(sourceId)
        const files = walkFiles(root)
        for (const rel of files) {
          if (stats.filesSeen >= MAX_FILES) break
          stats.filesSeen++
          const docPath = source.pathPrefix ? `${String(source.pathPrefix).replace(/\/+$/, '')}/${rel}` : rel
          const file = path.join(root, rel)
          if (!safeFilePath(root, file)) continue
          const data = readTextFile(file)
          if (!data) {
            stats.errors++
            continue
          }
          const size = data.stat.size
          const mtimeMs = data.stat.mtimeMs
          const sha1 = hashText(data.text)
          const previous = selectDoc.get(sourceId, docPath)
          if (!force && previous && Number(previous.size) === size && Number(previous.mtime_ms) === mtimeMs && previous.sha1 === sha1) {
            seen.add(docPath)
            stats.filesSkipped++
            stats.chunks += Number(previous.chunk_count || 0)
            continue
          }
          const chunks = chunkText(data.text)
          const title = makeTitle(rel, data.text)
          if (!force) deleteChunks.run(sourceId, docPath)
          const indexedAt = nowIso()
          upsertDoc.run(sourceId, docPath, mtimeMs, size, sha1, chunks.length, indexedAt)
          seen.add(docPath)
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]
            insertChunk.run(
              sourceId,
              String(source.kind || ''),
              String(source.mode || ''),
              String(source.packId || ''),
              String(source.license || ''),
              Number(source.priority || 0),
              docPath,
              searchableText(docPath),
              title,
              searchableText(title),
              chunk.heading || '',
              searchableText(chunk.heading || ''),
              chunk.text,
              searchableText(chunk.text),
              chunk.startLine,
              chunk.endLine,
            )
          }
          stats.filesIndexed++
          stats.chunks += chunks.length
          if (process.env.KH_INDEX_DEBUG === '1' && stats.filesIndexed % 250 === 0) {
            console.error('[kh-index] indexed=%d seen=%d chunks=%d source=%s', stats.filesIndexed, stats.filesSeen, stats.chunks, sourceId)
          }
        }
        if (process.env.KH_INDEX_DEBUG === '1') {
          console.error('[kh-index] source=%s files=%d indexed=%d ms=%d', sourceId, files.length, stats.filesIndexed, Date.now() - sourceStarted)
        }
      }

      // Remove documents that disappeared from any source. The active source
      // set also removes imports the user deleted.
      const allDocs = db.prepare('SELECT source_id, path FROM knowledge_docs').all()
      for (const row of allDocs) {
        const seen = seenBySource.get(row.source_id)
        if ((!activeSources.has(row.source_id) || !seen || !seen.has(row.path))) {
          deleteChunks.run(row.source_id, row.path)
          deleteDoc.run(row.source_id, row.path)
          stats.filesRemoved++
        }
      }

      const meta = db.prepare('INSERT INTO knowledge_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      const fingerprint = this.currentRootsFingerprint()
      meta.run('version', String(INDEX_VERSION))
      meta.run('indexed_at', nowIso())
      meta.run('build_ms', String(Date.now() - started))
      meta.run('stats', JSON.stringify(stats))
      meta.run('roots_fingerprint', fingerprint.hash)
      meta.run('roots_files', String(fingerprint.files))
      commit.run()
      this.lastError = ''
      this.lastBuild = { ...stats, ms: Date.now() - started, indexedAt: nowIso() }
      this.rebuildCount++
      this.dirty = false
      this.dirtyAt = 0
      this.rootsFingerprint = fingerprint.hash
      this.rootsFingerprintAt = Date.now()
      return this.lastBuild
    } catch (error) {
      try {
        rollback.run()
      } catch {
        // preserve the original failure
      }
      this.lastError = error instanceof Error ? error.message : String(error)
      this.logger.error?.('[dsh-knowledge-hub] index rebuild failed: %s', this.lastError)
      throw error
    }
  }

  search(query, options = {}) {
    const text = normalizeText(query).trim()
    if (!text) return []
    const db = this.open()
    const mode = String(options.mode || '')
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(options.limit) || DEFAULT_LIMIT))
    const requestedSources = Array.isArray(options.sources) && options.sources.length ? new Set(options.sources) : null
    // 混合语种查询的召回坑（2026-09-18 实测）：CJK bigram 数量远多于拉丁术语时，
    // 单条 BM25 排序会被中文文档淹没——"Sigma 检测规则 powershell 编码命令" 的 AND 计划
    // 只命中一篇无关中文文档，`sigma-rules/...powershell_base64_encoded_*.yml` 根本进不了
    // 取数窗口（每计划只取 max(80, limit*12) 行）。加一条**只含拉丁术语**的计划，
    // 让 powershell / cve-xxxx / 工具名这类高精度词单独有进榜机会，命中给 -1.5 的回落罚分
    // （与别名扩展同量级），保证 AND 全量命中的结果仍排在前。
    const allTerms = splitQueryTerms(text)
    const latinTerms = allTerms.filter((term) => /^[\x00-\x7f]+$/.test(term))
    const mixed = latinTerms.length > 0 && latinTerms.length < allTerms.length
    const plans = [
      { expr: ftsQuery(text, 'and'), penalty: 0 },
      { expr: mixed ? ftsQuery(latinTerms.join(' '), 'and') : '', penalty: -1.5 },
      { expr: ftsQuery(text, 'or'), penalty: 0 },
    ].filter((plan) => plan.expr)
    // 每个计划都跑（不再"凑够 limit 就提前退出"）：提前退出会让**后置的兜底计划**
    // 把**主计划的召回**挤掉——实测 persist-zh 因此丢了原本命中的中文文档。
    // 同一行在多计划里出现时取权重最高的一份（权重 = |bm25| + 计划罚分）。
    const bestByRow = new Map()
    for (const plan of plans) {
      try {
        const result = db.prepare(`
          SELECT rowid, source_id, kind, scope, pack_id, license, priority,
                 path, title, heading, body, start_line, end_line,
                 bm25(
                   knowledge_chunks,
                   0, 0, 0, 0, 0, 0,
                   4.0, 4.0, 8.0, 8.0, 5.0, 5.0, 0, 1.0, 0, 0
                 ) AS rank
          FROM knowledge_chunks
          WHERE knowledge_chunks MATCH ?
          ORDER BY rank ASC
          LIMIT ?
        `).all(plan.expr, Math.max(80, limit * 12))
        for (const row of result) {
          if (!sourceModeMatches({ mode: row.scope }, mode)) continue
          if (requestedSources && !requestedSources.has(row.source_id)) continue
          const weight = Math.abs(Number(row.rank || 0)) + plan.penalty
          const previous = bestByRow.get(row.rowid)
          if (!previous || weight > previous.weight) bestByRow.set(row.rowid, { row, planPenalty: plan.penalty, weight })
        }
      } catch (error) {
        // Invalid FTS syntax or an index created by a different version:
        // fall back to the legacy scanner at the caller.
        this.lastError = error instanceof Error ? error.message : String(error)
      }
    }

    const perPath = new Map()
    for (const entry of bestByRow.values()) {
      const row = entry.row
      const rank = Math.abs(Number(row.rank || 0))
      const score = rank + scoreBoost(text, row) + Number(entry.planPenalty || 0)
      const key = `${row.source_id}\u0000${row.path}`
      const previous = perPath.get(key)
      if (!previous || score > previous.score) {
        const local = snippetFor(row.body, text)
        perPath.set(key, {
          source: row.kind || 'import',
          mode: row.scope || '',
          path: row.path,
          line: lineAtMatch(row, text),
          preview: local.snippet,
          title: row.title || '',
          heading: row.heading || '',
          startLine: Number(row.start_line) || 0,
          endLine: Number(row.end_line) || 0,
          chunkId: String(row.rowid),
          packId: row.pack_id || '',
          license: row.license || '',
          score: Number(score.toFixed(6)),
          matched: local.matched,
        })
      }
    }

    const ranked = [...perPath.values()].sort((a, b) => b.score - a.score)
    const perSource = new Map()
    const selected = []
    for (const hit of ranked) {
      const count = perSource.get(hit.source) || 0
      if (count >= 3 && selected.length < limit) continue
      perSource.set(hit.source, count + 1)
      selected.push(hit)
      if (selected.length >= limit) break
    }
    return selected
  }

  getChunk(chunkId) {
    const id = Number(chunkId)
    if (!Number.isInteger(id) || id <= 0) return null
    const db = this.open()
    try {
      return db.prepare(`
        SELECT rowid, source_id, kind, scope, pack_id, license, path, title, heading,
               body, start_line, end_line
        FROM knowledge_chunks
        WHERE rowid = ?
      `).get(id) || null
    } catch {
      return null
    }
  }
}

export function defaultTextExtensions() {
  return new Set(TEXT_EXTS)
}
