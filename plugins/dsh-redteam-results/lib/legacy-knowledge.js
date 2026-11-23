import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { boundedJson, buildExcerpt, ftsExpression, queryConcepts, scoreKnowledgeSection } from './knowledge-retrieval.js';

const sha = value => createHash('sha256').update(String(value)).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const decode = value => {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
};

export function legacyKnowledgePath(options = {}) {
  if (options.legacyDbPath) return path.resolve(options.legacyDbPath);
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'refs', '.index', 'knowledge.sqlite');
}

function openLegacy(options = {}) {
  const file = legacyKnowledgePath(options);
  if (!fs.existsSync(file)) return null;
  return { file, db: new DatabaseSync(file, { readOnly: true }) };
}

export function legacyKnowledgeStatus(options = {}) {
  const handle = openLegacy(options);
  if (!handle) return { available: false, documents: 0, chunks: 0, path: legacyKnowledgePath(options) };
  try {
    const documents = Number(handle.db.prepare('SELECT COUNT(*) AS n FROM knowledge_docs').get()?.n) || 0;
    const chunks = Number(handle.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get()?.n) || 0;
    return { available: true, documents, chunks, path: handle.file };
  } catch {
    return { available: false, documents: 0, chunks: 0, path: handle.file };
  } finally { handle.db.close(); }
}

export function searchLegacyKnowledge(queryText, input = {}, options = {}) {
  const query = String(queryText || input.query || '').trim();
  const concepts = queryConcepts(query);
  const expression = ftsExpression(concepts.conceptual);
  const queryHash = sha(query).slice(0, 16);
  const handle = openLegacy(options);
  if (!handle) return null;
  try {
    if (!expression) return boundedJson({ ok: true, status: 'no_match', query: query.slice(0, 300), queryHash,
      rows: [], source: 'legacy', legacy: true, note: '旧库没有可检索词。' }, 3072);
    let chunks = [];
    try {
      chunks = handle.db.prepare(`SELECT c.source_id,c.path,c.title,c.heading,c.body,c.start_line,c.end_line,
        d.sha1,d.version_conditions,d.product_aliases,bm25(knowledge_chunks) AS rank
        FROM knowledge_chunks c JOIN knowledge_docs d ON d.source_id=c.source_id AND d.path=c.path
        WHERE knowledge_chunks MATCH ? ORDER BY rank LIMIT 100`).all(expression);
    } catch {
      chunks = [];
    }
    const scored = [];
    for (const chunk of chunks) {
      const row = { ...chunk, text: chunk.body, product: '', version: '' };
      const score = scoreKnowledgeSection(row, concepts.conceptual, {
        cves: concepts.cves, paths: concepts.paths, product: input.product, version: input.version,
      });
      if (score) scored.push({ chunk, score });
    }
    scored.sort((a, b) => b.score.coverage - a.score.coverage || b.score.exact - a.score.exact
      || b.score.titleHits - a.score.titleHits || b.score.headingHits - a.score.headingHits
      || b.score.score - a.score.score);
    const perDoc = new Map(), selected = [];
    for (const item of scored) {
      const key = item.chunk.source_id + '\0' + item.chunk.path;
      const count = perDoc.get(key) || 0;
      if (count >= 2) continue;
      perDoc.set(key, count + 1);
      selected.push(item);
      if (selected.length >= Math.max(5, Math.min(5, Number(input.limit) || 5))) break;
    }
    const rows = selected.slice(0, 5).map(({ chunk }) => ({
      ref: 'legacy:' + encode({ kind: 'legacy', sourceId: chunk.source_id, path: chunk.path,
        startLine: chunk.start_line, endLine: chunk.end_line, sha1: chunk.sha1, queryHash }),
      title: chunk.title || path.basename(chunk.path),
      section: chunk.heading || '正文',
      excerpt: buildExcerpt(chunk.body, concepts.conceptual),
      sourceKind: 'local', sourceLabel: '内置资料 · ' + chunk.path,
      revision: chunk.sha1, product: null, version: null, applicability: 'unknown',
      sourceDate: null, stale: 'unknown', legacy: true,
    }));
    return boundedJson({ ok: true, status: rows.length ? 'hits' : 'no_match', query: query.slice(0, 300), queryHash,
      rows, source: 'legacy', legacy: true, note: '旧版只读资料库；正文按 sourceId/path 打开。' }, 3072);
  } finally { handle.db.close(); }
}

export function mergeKnowledgeSearch(primary, legacy, maximum = 3072) {
  if (!legacy || legacy.status === 'error') return primary;
  const seen = new Set(), rows = [];
  for (const row of [...(primary?.rows || []), ...(legacy.rows || [])]) {
    const key = String(row.title || '') + '\0' + String(row.section || '') + '\0' + String(row.sourceLabel || '');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    if (rows.length >= 5) break;
  }
  const merged = boundedJson({ ...(primary || {}), ok: primary?.ok !== false || rows.length > 0,
    status: rows.length ? 'hits' : (primary?.status === 'error' ? 'error' : 'no_match'),
    rows, legacyMatched: legacy.rows?.length || 0,
    indexRevision: [primary?.indexRevision, legacy.indexRevision].filter(Boolean).join(' + ') || undefined,
    note: '结果只用于定位；读取正文按来源和字节上限分页。' }, maximum);
  return merged;
}

export function readLegacyKnowledgeRef(ref, input = {}, options = {}) {
  const decoded = typeof ref === 'string' ? decode(String(ref).replace(/^legacy:/, '')) : ref;
  if (!decoded || decoded.kind !== 'legacy' || !decoded.sourceId || !decoded.path)
    throw Object.assign(new Error('legacy knowledge ref invalid'), { code: 'ref_invalid' });
  const handle = openLegacy(options);
  if (!handle) throw Object.assign(new Error('legacy knowledge index unavailable'), { code: 'index_unavailable' });
  try {
    const row = handle.db.prepare(`SELECT c.source_id,c.path,c.title,c.heading,c.body,c.start_line,c.end_line,d.sha1
      FROM knowledge_chunks c JOIN knowledge_docs d ON d.source_id=c.source_id AND d.path=c.path
      WHERE c.source_id=? AND c.path=? AND c.start_line=? AND c.end_line=? LIMIT 1`)
      .get(decoded.sourceId, decoded.path, decoded.startLine, decoded.endLine);
    if (!row) throw Object.assign(new Error('legacy knowledge source changed or removed'), { code: 'ref_expired' });
    if (decoded.sha1 && row.sha1 !== decoded.sha1)
      throw Object.assign(new Error('legacy knowledge source changed; search again'), { code: 'ref_expired' });
    const cursor = input.cursor ? decode(input.cursor) : null;
    if (input.cursor && (!cursor || cursor.sourceId !== decoded.sourceId || cursor.path !== decoded.path
      || cursor.startLine !== decoded.startLine || cursor.endLine !== decoded.endLine || cursor.sha1 !== row.sha1))
      throw Object.assign(new Error('legacy read cursor expired'), { code: 'cursor_expired' });
    const text = String(row.body || '');
    const bytes = Buffer.from(text, 'utf8');
    const offset = Math.max(0, Number(cursor?.offset) || 0);
    const maximum = Math.max(1, Math.min(8192, Number(input.maxBytes) || 8192));
    let end = Math.min(bytes.length, offset + maximum);
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    return { ok: true, status: 'read', ref: String(ref), title: row.title || path.basename(row.path),
      section: row.heading || '正文', text: bytes.subarray(offset, end).toString('utf8'),
      sourceKind: 'local', sourceLabel: '内置资料 · ' + row.path, revision: row.sha1,
      offset, bytes: end - offset, complete: end >= bytes.length, sectionBytes: bytes.length,
      nextCursor: end < bytes.length ? encode({ sourceId: decoded.sourceId, path: decoded.path,
        startLine: decoded.startLine, endLine: decoded.endLine, sha1: row.sha1, offset: end }) : null,
      legacy: true };
  } finally { handle.db.close(); }
}
