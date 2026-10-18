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
import { buildAliasDictionary, extractProductAliases, expandQueryAliases } from './product-aliases.js'

// 3：knowledge_docs 增加 product_aliases（v6 第 6.1 节「产品别名」）。版本不一致时整表重建，
// 否则老库里的空别名会一直跟着旧文件走下去。
export const INDEX_VERSION = 3

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
    const text = normalizeText(fs.readFileSync(file, 'utf8'))
    return { text, stat: st, withdrawn: isWithdrawn(text) }
  } catch {
    return null
  }
}

/** 轻量撤回约定：YAML frontmatter 的 status，或正文首部的 [WITHDRAWN] 标记。 */
function isWithdrawn(text) {
  const head = text.slice(0, 4000)
  return /^\s*---[\s\S]*?^status\s*:\s*(?:withdrawn|retracted|已撤回)\s*$/im.test(head)
    || /^\s*\[(?:WITHDRAWN|RETRACTED|已撤回)\]\s*$/im.test(head)
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

/**
 * 「资料时间」（v6 第 6.1 节）：优先正文里显式的日期（YYYY-MM-DD / YYYY年M月D日），
 * 找不到就留空——文件修改时间是同步时间，不能冒充资料时间。
 */
function extractDocDate(body) {
  const match = String(body || '').match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (!match) return '';
  return match[1] + '-' + String(match[2]).padStart(2, '0') + '-' + String(match[3]).padStart(2, '0');
}
/**
 * 「版本条件」（v6 第 6.1 节）：只抽正文里显式写的片段（影响版本行、比较符加版本号），
 * 抽不到就留空——不猜产品，也不把普通版本号当适用条件。
 */
function extractVersionConditions(body) {
  const text = String(body || '');
  const out = [];
  for (const line of text.match(/(?:影响|受影响|affected)[^\n]{0,10}?版本[^\n]{0,80}/gi) || []) out.push(line.trim().slice(0, 120));
  for (const bound of text.match(/(?:<|<=|＜|≤)\s*v?\d+\.\d+(?:\.\d+)?/g) || []) out.push(bound.trim());
  return [...new Set(out)].slice(0, 5).join(' | ');
}
function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex')
}

/** 「产品别名」存的是 JSON 数组；坏行/空值一律当没有，不让它把整次检索带崩。 */
function parseProductAliases(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
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
    // 搜索/精读延迟采样（v6 第 10.5 节）：只留最近 200 次，进程内环形缓冲，不落库、不调模型。
    this.latencySamples = { search: [], chunk: [] }
    // 计数缓存：status() 原来每次都 `COUNT(*)` 整表（8.4 万+ chunk，实测 ~140ms），
    // 而 ensureKnowledgeIndex() 每次检索都会问一次 status —— 于是每次知识检索都在全表计数。
    // 计数只在重建/失效时变，缓存后按需刷新（status({ counts: true })）。
    this.counts = null
    /** 空闲页比例；只在显式 `status({ counts: true })` 时刷新。 */
    this.deadSpace = null
    // 产品别名词典（v6 第 6.1 节）：词典只来自源侧自述的 nday catalog，候选路径由调用方给出。
    this.aliasCatalogPaths = Array.isArray(options.aliasCatalogPaths) ? options.aliasCatalogPaths : []
    this.aliasDictionary = null
    this.aliasDictionaryKey = ''
  }

  /**
   * 产品别名词典：读候选路径里存在的 catalog，按 (路径, mtime, size) 缓存。
   * 目录缺失或形状不对就返回 null —— 宁可不抽别名，也不拿普通英文词凑数。
   */
  productAliasDictionary() {
    if (!this.aliasCatalogPaths.length) return null
    const parts = []
    for (const candidate of this.aliasCatalogPaths) {
      try {
        const stat = fs.statSync(candidate)
        parts.push(`${candidate}:${stat.mtimeMs}:${stat.size}`)
      } catch {
        parts.push(`${candidate}:missing`)
      }
    }
    const key = parts.join('|')
    if (this.aliasDictionary && this.aliasDictionaryKey === key) return this.aliasDictionary
    const entries = []
    for (const candidate of this.aliasCatalogPaths) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
        if (Array.isArray(parsed && parsed.entries)) entries.push(...parsed.entries)
      } catch {
        // 缺文件或坏 JSON：跳过这一份，不影响索引
      }
    }
    this.aliasDictionaryKey = key
    this.aliasDictionary = entries.length ? buildAliasDictionary(entries) : null
    return this.aliasDictionary
  }

  /** 词典指纹（短哈希）：词典换了要重新抽别名，否则新别名永远追不上旧文件。 */
  aliasFingerprint() {
    if (!this.aliasCatalogPaths.length) return ''
    // 先确保词典键已经算出来：否则首次调用时 key 还是空的，指纹在两次重建之间会跳变，
    // 每次重建都被判成"词典换了"而整表重来（chunk rowid 也会跟着被冲掉）。
    this.productAliasDictionary()
    return crypto.createHash('sha1').update(this.aliasDictionaryKey || '').digest('hex').slice(0, 16)
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
        doc_date TEXT NOT NULL DEFAULT '',
        version_conditions TEXT NOT NULL DEFAULT '',
        product_aliases TEXT NOT NULL DEFAULT '',
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
    // 已有库补列（v6 第 6.1 节「资料时间」）：新库由上面的 CREATE TABLE 建好，老库在这里补。
    try { db.exec("ALTER TABLE knowledge_docs ADD COLUMN doc_date TEXT NOT NULL DEFAULT ''"); } catch { /* 列已存在 */ }
    try { db.exec("ALTER TABLE knowledge_docs ADD COLUMN version_conditions TEXT NOT NULL DEFAULT ''"); } catch { /* 列已存在 */ }
    try { db.exec("ALTER TABLE knowledge_docs ADD COLUMN product_aliases TEXT NOT NULL DEFAULT ''"); } catch { /* 列已存在 */ }
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

  /** 记一次延迟样本：只留最近 200 次，够算 P50/P95，内存不随使用增长（v6 第 10.5 节）。 */
  recordLatency(kind, ms) {
    const bucket = this.latencySamples?.[kind]
    if (!bucket || !Number.isFinite(ms)) return
    bucket.push(Math.round(ms * 100) / 100)
    if (bucket.length > 200) bucket.shift()
  }
  latencySummary() {
    const summary = {}
    for (const kind of Object.keys(this.latencySamples || {})) {
      const values = [...this.latencySamples[kind]].sort((a, b) => a - b)
      if (!values.length) { summary[kind] = { n: 0, p50: null, p95: null, max: null }; continue }
      const at = ratio => values[Math.min(values.length - 1, Math.floor(ratio * (values.length - 1)))]
      summary[kind] = { n: values.length, p50: at(0.5), p95: at(0.95), max: values[values.length - 1] }
    }
    return summary
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
    let deadSpace = this.deadSpace ?? null
    if (options.counts === true || this.counts === null) {
      try {
        chunks = Number(db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get().n || 0)
        docs = Number(db.prepare('SELECT COUNT(*) AS n FROM knowledge_docs').get().n || 0)
        this.counts = { chunks, docs }
      } catch {
        // empty or partially created index
      }
      // 死空间比例：强制重建会留下约 35% 的空闲页（2026-10-11 实测，12k 文件语料：
      // 89.9 MB → 124.4 MB 后**稳定不再涨**），只有 VACUUM 收得回来。
      // 两条 PRAGMA 都是 O(1) 读库头，但 status() 在检索路径上也会被问到，
      // 所以只在显式要计数时一起取，避免给每次检索加成本。
      try {
        const freePages = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0)
        const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count ?? 0)
        deadSpace = { freePages, pages, ratio: pages === 0 ? 0 : Number((freePages / pages).toFixed(3)) }
      } catch {
        deadSpace = null
      }
      this.deadSpace = deadSpace
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
      deadSpace,
      // 性能指标（v6 第 10.5 节）：本进程最近一次重建的耗时与文件数、是否截断 WAL，以及索引占用。
      // 重启后 lastBuild 为 null，只反映本进程，不冒充历史统计；库大小随时可读。
      lastBuild: this.lastBuild ? {
        ms: this.lastBuild.ms, filesIndexed: this.lastBuild.filesIndexed, filesSkipped: this.lastBuild.filesSkipped,
        filesRemoved: this.lastBuild.filesRemoved, chunks: this.lastBuild.chunks, errors: this.lastBuild.errors,
        walTruncated: this.lastBuild.walTruncated === true, indexedAt: this.lastBuild.indexedAt,
      } : null,
      dbBytes: (() => { try { return fs.statSync(this.dbPath).size; } catch { return null; } })(),
      walBytes: (() => { try { return fs.statSync(this.dbPath + '-wal').size; } catch { return 0; } })(),
      // 搜索/精读延迟（v6 第 10.5 节）：本进程最近 200 次的 P50/P95，不落库、不调模型。
      latency: this.latencySummary(),
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
      // 索引版本或产品别名词典换了都要整表重来：否则老库里的空字段会一直跟着没改过的文件。
      const storedVersion = Number(db.prepare('SELECT value FROM knowledge_meta WHERE key = ?').get('version')?.value || 0)
      const storedAlias = String(db.prepare('SELECT value FROM knowledge_meta WHERE key = ?').get('alias_fingerprint')?.value || '')
      const aliasFingerprint = this.aliasFingerprint()
      const full = force || storedVersion !== INDEX_VERSION || storedAlias !== aliasFingerprint
      if (full) {
        db.exec('DELETE FROM knowledge_chunks; DELETE FROM knowledge_docs;')
      }
      const selectDoc = db.prepare('SELECT mtime_ms, size, sha1, chunk_count FROM knowledge_docs WHERE source_id = ? AND path = ?')
      const upsertDoc = db.prepare(`
        INSERT INTO knowledge_docs(source_id, path, mtime_ms, size, sha1, chunk_count, indexed_at, doc_date, version_conditions, product_aliases)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, path) DO UPDATE SET
          mtime_ms=excluded.mtime_ms,
          size=excluded.size,
          sha1=excluded.sha1,
          chunk_count=excluded.chunk_count,
          indexed_at=excluded.indexed_at,
          doc_date=excluded.doc_date,
          version_conditions=excluded.version_conditions,
          product_aliases=excluded.product_aliases
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
      // 词典只建一次，整轮重建复用；缺词典时整轮都不抽别名。
      const aliasDictionary = this.productAliasDictionary()

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
          if (data.withdrawn) {
            // 撤回条目不能继续被检索；旧索引残留也要删除。
            deleteChunks.run(sourceId, docPath)
            deleteDoc.run(sourceId, docPath)
            stats.filesSkipped++
            continue
          }
          const size = data.stat.size
          const mtimeMs = data.stat.mtimeMs
          const sha1 = hashText(data.text)
          const previous = selectDoc.get(sourceId, docPath)
          if (!full && previous && Number(previous.size) === size && Number(previous.mtime_ms) === mtimeMs && previous.sha1 === sha1) {
            seen.add(docPath)
            stats.filesSkipped++
            stats.chunks += Number(previous.chunk_count || 0)
            continue
          }
          const chunks = chunkText(data.text)
          const title = makeTitle(rel, data.text)
          if (!full) deleteChunks.run(sourceId, docPath)
          const indexedAt = nowIso()
          // 产品别名（v6 第 6.1 节）：只认源侧词典里出现过的写法，命中行号一并留下。
          const productAliases = aliasDictionary ? extractProductAliases(data.text, aliasDictionary) : []
          upsertDoc.run(sourceId, docPath, mtimeMs, size, sha1, chunks.length, indexedAt, extractDocDate(data.text),
            extractVersionConditions(data.text), productAliases.length ? JSON.stringify(productAliases) : '')
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
      meta.run('alias_fingerprint', aliasFingerprint)
      commit.run()
      // 重建会把整份索引写进 WAL。实测（12,000 个文件 / 89.7 MB 索引）：
      // 提交之后 WAL 仍有 90.3 MB，`close()` 才把它截成 0 —— 因为 `wal_autocheckpoint`
      // 只做 passive checkpoint，**不会把 WAL 文件截短**。宿主进程一直开着，
      // 用户的 home 里就多占一份与索引等大的磁盘（真 home 实测 604.6 MB 索引 + 979.6 MB WAL）。
      // 写完主动截短一次即可；有读者时截短会返回 busy，不影响本次重建结果。
      let walTruncated = false
      if (stats.filesIndexed > 0 || stats.filesRemoved > 0) {
        try {
          const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
          walTruncated = Number(row?.busy ?? 1) === 0
        } catch {
          walTruncated = false
        }
      }
      this.lastError = ''
      this.lastBuild = { ...stats, ms: Date.now() - started, indexedAt: nowIso(), walTruncated }
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

  /** 搜索入口：只负责计时，实际逻辑在 searchInner（v6 第 10.5 节延迟采样）。 */
  search(query, options = {}) {
    const started = performance.now()
    try {
      return this.searchInner(query, options)
    } finally {
      this.recordLatency('search', performance.now() - started)
    }
  }

  searchInner(query, options = {}) {
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
    // 产品别名规范化（v6 第 6.1 节）：查询里写的是别名（例如厂商名或产品中文名）时，补一条
    // 用同一厂商其它写法检索的兜底计划。罚分与拉丁兜底同量级，精确命中仍然排在前。
    const aliasPhrases = expandQueryAliases(text, this.productAliasDictionary())
    // 用短语而不是拆词：中文被拆成 bigram 后 `应用服务器` 会退化成 `应用`/`服务` 这种泛词。
    if (aliasPhrases.length) plans.push({ expr: aliasPhrases.map(quoteFtsTerm).join(' OR '), penalty: -1.5 })
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

    const docMetaStmt = db.prepare('SELECT mtime_ms, doc_date, version_conditions, product_aliases FROM knowledge_docs WHERE source_id=? AND path=?')
    const perPath = new Map()
    for (const entry of bestByRow.values()) {
      const row = entry.row
      const rank = Math.abs(Number(row.rank || 0))
      const score = rank + scoreBoost(text, row) + Number(entry.planPenalty || 0)
      const key = `${row.source_id}\u0000${row.path}`
      const previous = perPath.get(key)
      if (!previous || score > previous.score) {
        const local = snippetFor(row.body, text)
        // 文档级元数据一次取齐：资料时间、版本条件、产品别名都来自同一行。
        const doc = docMetaStmt.get(row.source_id, row.path)
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
          updatedAt: doc?.mtime_ms ? new Date(Number(doc.mtime_ms)).toISOString() : null,
          // 「资料时间」（v6 第 6.1 节）：正文里显式写的日期；找不到就留空，不拿同步时间冒充。
          docDate: doc?.doc_date || '',
          versionConditions: doc?.version_conditions || '',
          // 「产品别名」（v6 第 6.1 节）：源侧词典命中的写法 + 首次出现的行号。
          productAliases: parseProductAliases(doc?.product_aliases),
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

  /** 精读入口：只负责计时，实际逻辑在 getChunkInner（v6 第 10.5 节延迟采样）。 */
  getChunk(chunkId) {
    const started = performance.now()
    try {
      return this.getChunkInner(chunkId)
    } finally {
      this.recordLatency('chunk', performance.now() - started)
    }
  }

  getChunkInner(chunkId) {
    const id = Number(chunkId)
    if (!Number.isInteger(id) || id <= 0) return null
    const db = this.open()
    try {
      const chunk = db.prepare(`
        SELECT rowid, source_id, kind, scope, pack_id, license, path, title, heading,
               body, start_line, end_line
        FROM knowledge_chunks
        WHERE rowid = ?
      `).get(id) || null
      if (!chunk) return null
      // 精读也要带文档级元数据（v6 第 6.1 节）。这里原来在 `return` 之后才写补充字段，
      // 属于死代码：精读结果一直没有 updatedAt / docDate / versionConditions。
      const doc = db.prepare('SELECT mtime_ms, doc_date, version_conditions, product_aliases FROM knowledge_docs WHERE source_id=? AND path=?').get(chunk.source_id, chunk.path)
      return {
        ...chunk,
        updatedAt: doc?.mtime_ms ? new Date(Number(doc.mtime_ms)).toISOString() : null,
        docDate: doc?.doc_date || '',
        versionConditions: doc?.version_conditions || '',
        productAliases: parseProductAliases(doc?.product_aliases),
      }
    } catch {
      return null
    }
  }
}

export function defaultTextExtensions() {
  return new Set(TEXT_EXTS)
}
