import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseDocumentIsolated } from './project-document-parser.js'

const nowIso = () => new Date().toISOString()
const parse = row => { try { return row ? JSON.parse(row.record) : null } catch { return null } }
const safeText = value => String(value ?? '')

export function listKnowledgeSources(store, sessionId, { limit = 50, offset = 0, query = '' } = {}) {
  const q = safeText(query).trim().toLowerCase()
  const like = '%' + q + '%'
  const take = Math.max(1, Math.min(50, Number(limit) || 50))
  const skip = Math.max(0, Number(offset) || 0)
  const currentRevision = "revision=(SELECT MAX(k2.revision) FROM competition_knowledge k2 WHERE k2.session_id=k.session_id AND k2.source_id=k.source_id AND COALESCE(json_extract(k2.record,'$.hidden'),0)=0)"
  const searchable = q
    ? "AND (lower(COALESCE(json_extract(record,'$.title'),'')) LIKE ? OR lower(COALESCE(json_extract(record,'$.path'),'')) LIKE ? OR lower(substr(COALESCE(json_extract(record,'$.text'),''),1,20000)) LIKE ?)"
    : ''
  const whereArgs = q ? [sessionId, like, like, like] : [sessionId]
  const total = Number(store.db.prepare('SELECT COUNT(*) AS n FROM competition_knowledge k WHERE session_id=? AND COALESCE(json_extract(record,\'$.hidden\'),0)=0 '
    + 'AND ' + currentRevision + ' ' + searchable).get(...whereArgs)?.n || 0)
  const rows = store.db.prepare('SELECT record FROM competition_knowledge k WHERE session_id=? AND COALESCE(json_extract(record,\'$.hidden\'),0)=0 '
    + 'AND ' + currentRevision + ' ' + searchable + ' ORDER BY updated_at DESC, source_id ASC, revision DESC LIMIT ? OFFSET ?')
    .all(...whereArgs, take, skip).map(parse).filter(Boolean)
  return { total, offset: skip, nextOffset: skip + rows.length < total ? skip + rows.length : null,
    rows: rows.map(({ text, ...row }) => ({ ...row, bytes: Buffer.byteLength(text || '') })) }
}

export function importKnowledgePath(store, sessionId, input = {}) {
  const sourcePath = path.resolve(String(input.path || ''))
  if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error('knowledge file not found')
  const buffer = fs.readFileSync(sourcePath)
  return importKnowledgeBuffer(store, sessionId, { ...input, title: input.title || path.basename(sourcePath), path: sourcePath, buffer })
}

export async function importKnowledgeText(store, sessionId, input = {}) {
  const text = safeText(input.text)
  if (!text) throw new Error('knowledge text required')
  return importKnowledgeBuffer(store, sessionId, { ...input, title: input.title || '粘贴的资料', path: '', buffer: Buffer.from(text) })
}

export async function importKnowledgeBuffer(store, sessionId, input) {
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer || '')
  if (!buffer.length) throw new Error('knowledge content is empty')
  if (buffer.length > 20 * 1024 * 1024) throw new Error('knowledge content exceeds 20MiB')
  let text = buffer.toString('utf8')
  let sections = [{ location: '全文', text }]
  let parseState = 'ready'
  if (input.parseDocument !== false && !/\.(?:md|txt|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|c|cc|cpp|h|hpp|json|yaml|yml|xml|html|css|sh|ps1)$/i.test(input.path || '')) {
    try {
      const parsed = await parseDocumentIsolated(buffer, { displayName: input.title || input.path || 'knowledge' })
      sections = Array.isArray(parsed.sections) && parsed.sections.length ? parsed.sections : sections
      text = sections.map(section => safeText(section.text)).join('\n')
      parseState = parsed.unread?.length ? 'partial' : 'ready'
    } catch (error) {
      parseState = 'unreadable'
      text = ''
      sections = []
      input.parseError = error.message
    }
  }
  const digest = createHash('sha256').update(buffer).digest('hex')
  const sourceId = String(input.sourceId || 'knowledge-' + digest.slice(0, 16))
  const previous = store.db.prepare('SELECT record FROM competition_knowledge WHERE session_id=? AND source_id=? ORDER BY revision DESC LIMIT 1').get(sessionId, sourceId)
  const current = parse(previous)
  const revision = current?.digest === digest && current?.hidden !== true ? current.revision : (current?.revision || 0) + 1
  const at = nowIso()
  const materialId = 'knowledge-material-' + digest.slice(0, 24)
  const material = {
    id: materialId, source: 'local-knowledge-snapshot', title: String(input.title || input.path || sourceId),
    digest, bytes: buffer.length, originalBase64: buffer.toString('base64'), text, sections,
    path: String(input.path || ''), parseState, parseError: String(input.parseError || ''),
  }
  store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?) '
    + 'ON CONFLICT(session_id,id) DO UPDATE SET record=excluded.record,digest=excluded.digest')
    .run(sessionId, materialId, String(input.path || ''), digest, JSON.stringify(material))
  const record = {
    sourceId, revision, title: String(input.title || input.path || sourceId), path: String(input.path || ''),
    digest, bytes: buffer.length, materialId, parseState, parseError: String(input.parseError || ''),
    license: String(input.license || ''), sourceUrl: String(input.sourceUrl || ''),
    sectionCount: sections.length, text, hidden: false, createdAt: current?.createdAt || at, updatedAt: at,
  }
  store.db.prepare('INSERT INTO competition_knowledge(session_id,source_id,revision,record,updated_at) VALUES(?,?,?,?,?) '
    + 'ON CONFLICT(session_id,source_id,revision) DO UPDATE SET record=excluded.record,updated_at=excluded.updated_at')
    .run(sessionId, sourceId, revision, JSON.stringify(record), at)
  const { text: _text, ...view } = record
  return view
}

export function searchKnowledge(store, sessionId, { query = '', limit = 5, cursor = '' } = {}) {
  const q = safeText(query).trim()
  if (!q) throw new Error('knowledge query required')
  let sourceOffset = 0
  let hitOffset = 0
  if (cursor.startsWith('knowledge-source:')) {
    const parts = cursor.split(':')
    sourceOffset = Math.max(0, Number(parts[1]) || 0)
    hitOffset = Math.max(0, Number(parts[2]) || 0)
  } else if (cursor.startsWith('knowledge:')) {
    // Backward-compatible cursor from the single-window implementation.
    hitOffset = Math.max(0, Number(cursor.split(':')[1]) || 0)
  }
  const count = Math.max(1, Math.min(20, Number(limit) || 5))
  const like = '%' + q.toLowerCase() + '%'
  const current = "FROM competition_knowledge k WHERE session_id=? AND COALESCE(json_extract(record,'$.hidden'),0)=0 "
    + "AND revision=(SELECT MAX(k2.revision) FROM competition_knowledge k2 WHERE k2.session_id=k.session_id "
    + "AND k2.source_id=k.source_id AND COALESCE(json_extract(k2.record,'$.hidden'),0)=0) "
    + "AND (lower(COALESCE(json_extract(record,'$.title'),'')) LIKE ? "
    + "OR lower(COALESCE(json_extract(record,'$.path'),'')) LIKE ? "
    + "OR lower(COALESCE(json_extract(record,'$.text'),'')) LIKE ?) "
  const totalSources = Number(store.db.prepare('SELECT COUNT(*) AS n ' + current).get(sessionId, like, like, like)?.n || 0)
  // Ten sources per read keeps a broad query bounded. The exact source total is
  // still known, and an opaque cursor advances beyond this window without a
  // hidden hard cap.
  const rows = store.db.prepare('SELECT record ' + current
    + 'ORDER BY updated_at DESC, source_id ASC, revision DESC LIMIT 10 OFFSET ?')
    .all(sessionId, like, like, like, sourceOffset).map(parse).filter(Boolean)
  const page = []
  let nextCursor = null
  outer: for (let sourceIndex = 0; sourceIndex < rows.length; sourceIndex += 1) {
    const row = rows[sourceIndex]
    const title = safeText(row.title), location = safeText(row.path), text = safeText(row.text)
    const lowerTitle = title.toLowerCase(), lowerPath = location.toLowerCase(), lowerText = text.toLowerCase()
    const needle = q.toLowerCase()
    const startHit = sourceIndex === 0 ? hitOffset : 0
    const sourceHits = []
    if (lowerTitle.includes(needle)) {
      sourceHits.push({ sourceId: row.sourceId, revision: row.revision, title, location,
        excerpt: title.slice(0, 280), hitOffset: 0, matchSource: 'title' })
    } else if (lowerPath.includes(needle)) {
      sourceHits.push({ sourceId: row.sourceId, revision: row.revision, title, location,
        excerpt: location.slice(0, 280), hitOffset: 0, matchSource: 'path' })
    } else {
      let from = 0
      while (true) {
        const at = lowerText.indexOf(needle, from)
        if (at < 0) break
        sourceHits.push({ sourceId: row.sourceId, revision: row.revision, title, location,
          excerpt: text.slice(Math.max(0, at - 100), Math.min(text.length, at + needle.length + 180)),
          hitOffset: at, matchSource: 'text' })
        from = at + Math.max(1, needle.length)
      }
    }
    for (let hitIndex = startHit; hitIndex < sourceHits.length; hitIndex += 1) {
      page.push({ ...sourceHits[hitIndex], cursor: 'knowledge-source:' + (sourceOffset + sourceIndex) + ':' + (hitIndex + 1) })
      if (page.length >= count) {
        if (hitIndex + 1 < sourceHits.length) {
          nextCursor = 'knowledge-source:' + (sourceOffset + sourceIndex) + ':' + (hitIndex + 1)
        } else if (sourceOffset + sourceIndex + 1 < totalSources) {
          nextCursor = 'knowledge-source:' + (sourceOffset + sourceIndex + 1) + ':0'
        }
        break outer
      }
    }
  }
  if (!nextCursor && rows.length && totalSources > sourceOffset + rows.length)
    nextCursor = 'knowledge-source:' + (sourceOffset + rows.length) + ':0'
  return { query: q, rows: page, offset: sourceOffset,
    totalHits: totalSources, totalHitsKind: 'matched-sources', totalSources,
    nextCursor, hasMore: nextCursor !== null }
}

export function readKnowledge(store, sessionId, input = {}) {
  const revision = Number(input.revision)
  const row = store.db.prepare('SELECT record FROM competition_knowledge WHERE session_id=? AND source_id=? AND revision=?')
    .get(sessionId, String(input.sourceId || ''), revision)
  const record = parse(row)
  if (!record) throw new Error('knowledge revision not found')
  const cursor = String(input.cursor || '')
  let offset = Math.max(0, Number(input.offset) || 0)
  if (cursor.startsWith('knowledge-read:')) {
    const parts = cursor.split(':')
    if (parts.length >= 5) {
      if ((parts[1] && parts[1] !== record.sourceId) || Number(parts[2]) !== revision || parts[3] !== record.digest)
        throw new Error('knowledge revision changed')
      offset = Math.max(0, Number(parts[4]) || 0)
    } else {
      if (Number(parts[1]) !== revision || parts[2] !== record.digest) throw new Error('knowledge revision changed')
      offset = Math.max(0, Number(parts[3]) || 0)
    }
  }
  const max = Math.max(1, Math.min(8192, Number(input.maxBytes) || 8192))
  const text = safeText(record.text)
  const bytes = Buffer.from(text, 'utf8')
  offset = Math.min(offset, bytes.length)
  const raw = bytes.subarray(offset, Math.min(bytes.length, offset + max + 4))
  const boundary = utf8Boundary(raw, Math.min(raw.length, max))
  const page = raw.subarray(0, boundary)
  const end = offset + page.length
  return {
    sourceId: record.sourceId, revision: record.revision, title: record.title, digest: record.digest,
    text: page.toString('utf8'), offset, nextOffset: end,
    nextCursor: end < bytes.length
      ? 'knowledge-read:' + record.sourceId + ':' + revision + ':' + record.digest + ':' + end
      : null,
    totalBytes: bytes.length, complete: end >= bytes.length,
  }
}

export function deleteKnowledgeSource(store, sessionId, sourceId) {
  const rows = store.db.prepare('SELECT revision,record FROM competition_knowledge WHERE session_id=? AND source_id=? ORDER BY revision DESC').all(sessionId, sourceId)
  if (!rows.length) throw new Error('knowledge source not found')
  const at = nowIso()
  const update = store.db.prepare('UPDATE competition_knowledge SET record=?,updated_at=? WHERE session_id=? AND source_id=? AND revision=?')
  for (const row of rows) {
    const record = parse(row) || {}
    update.run(JSON.stringify({ ...record, hidden: true, hiddenAt: at }), at, sessionId, sourceId, row.revision)
  }
  return { hidden: true, permanent: false, revisions: rows.map(row => row.revision),
    historyReadable: true, note: '普通移除只停止后续检索；已有稳定修订仍可按 sourceId 和 revision 读取。' }
}

function utf8Boundary(buffer, end) {
  if (end <= 0 || end >= buffer.length) return Math.max(0, end)
  let index = end
  while (index > 0 && (buffer[index] & 0xC0) === 0x80) index -= 1
  if (index === end) return end
  const lead = buffer[index]
  const needed = lead < 0x80 ? 1 : lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1
  return index + needed <= end ? end : index
}
