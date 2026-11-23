import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { redactText } from './redaction.js';
import {
  boundedJson,
  buildExcerpt,
  ftsExpression,
  normalizedSearchText,
  queryConcepts,
  scoreKnowledgeSection,
  versionApplicability,
} from './knowledge-retrieval.js';

const nowIso = () => new Date().toISOString();
const HAN_BREAK = /(?<=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])(?=[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])|(?<=[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/u;
const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS knowledge_index_meta (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_documents (
 doc_id TEXT PRIMARY KEY,
 project_key TEXT NOT NULL,
 visibility TEXT NOT NULL,
 source_id TEXT NOT NULL,
 source_kind TEXT NOT NULL,
 source_label TEXT NOT NULL,
 source_url TEXT NOT NULL DEFAULT '',
 title TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT '',
 digest TEXT NOT NULL,
 product TEXT NOT NULL DEFAULT '',
 version TEXT NOT NULL DEFAULT '',
 applicability TEXT NOT NULL DEFAULT 'unknown',
 source_date TEXT NOT NULL DEFAULT '',
 imported_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 status TEXT NOT NULL,
 revision INTEGER NOT NULL,
 metadata TEXT NOT NULL DEFAULT '{}',
 hidden INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_source
 ON knowledge_documents(project_key,visibility,source_id);
CREATE TABLE IF NOT EXISTS knowledge_sections (
 doc_id TEXT NOT NULL,
 section_id TEXT NOT NULL,
 position INTEGER NOT NULL,
 heading TEXT NOT NULL DEFAULT '',
 text TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 PRIMARY KEY(doc_id,section_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
 doc_id UNINDEXED,
 section_id UNINDEXED,
 title,
 heading,
 tokens,
 text,
 tokenize='unicode61'
);
`;
const MAX_SECTION_CHARS = 1400;
const MAX_CANDIDATES = 100;

export function knowledgeHome(options = {}) {
  if (options.home) return path.resolve(options.home);
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'redteam-results', 'knowledge');
}
function open(options = {}) {
  const home = knowledgeHome(options);
  fs.mkdirSync(path.join(home, 'entries'), { recursive: true });
  const file = options.dbPath ? path.resolve(options.dbPath) : path.join(home, 'index-v1.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  return { db, home, file };
}
function close(handle) { try { handle.db.close(); } catch { /* already closed */ } }
function readMeta(db, key, fallback = '') {
  return db.prepare('SELECT value FROM knowledge_index_meta WHERE key=?').get(key)?.value ?? fallback;
}
function bumpRevision(db) {
  const next = Number(readMeta(db, 'index_revision', '0')) + 1;
  db.prepare("INSERT INTO knowledge_index_meta(key,value) VALUES('index_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(next));
  return next;
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function safeSegment(value) { return sha(String(value)).slice(0, 24); }
function documentId(projectKey, visibility, sourceId) {
  return 'k-' + sha([projectKey, visibility, sourceId].join('\0')).slice(0, 32);
}
function contentPath(handle, docId, digest) {
  return path.join(handle.home, 'entries', docId + '-' + String(digest).slice(0, 16) + '.txt');
}
const MIGRATION_SEMANTIC_KEYS = ['conditions', 'sources', 'verification', 'license'];
function normalizeSemanticValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return [...new Set(value.map(normalizeSemanticValue).filter(item => item !== ''))]
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (typeof value === 'object') {
    const normalized = {};
    for (const key of Object.keys(value).sort()) normalized[key] = normalizeSemanticValue(value[key]);
    return normalized;
  }
  return String(value).replace(/\r\n?/g, '\n').trim()
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
function semanticMetadataSignature(value) {
  let metadata = value;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
  const selected = {};
  for (const key of MIGRATION_SEMANTIC_KEYS) {
    if (metadata[key] !== undefined) selected[key] = normalizeSemanticValue(metadata[key]);
  }
  return JSON.stringify(selected);
}
function sameMigratableDocument(left, right) {
  return left && right
    && left.digest === right.digest
    && left.title === right.title
    && left.source_kind === right.source_kind
    && left.source_label === right.source_label
    && left.source_url === right.source_url
    && left.product === right.product
    && left.version === right.version
    && left.applicability === right.applicability
    && String(left.source_date || '') === String(right.source_date || '')
    && semanticMetadataSignature(left.metadata) === semanticMetadataSignature(right.metadata);
}
function uniqueMigratedIdentity(db, projectKey, visibility, sourceId, digest) {
  const base = String(sourceId || '');
  let candidate = base;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (attempt) candidate = base + '::legacy-' + String(digest).slice(0, 8) + '-' + (attempt + 1);
    const docId = documentId(projectKey, visibility, candidate);
    const byId = db.prepare('SELECT doc_id FROM knowledge_documents WHERE doc_id=?').get(docId);
    const bySource = db.prepare(`SELECT doc_id FROM knowledge_documents
      WHERE project_key=? AND visibility=? AND source_id=?`).get(projectKey, visibility, candidate);
    if (!byId && !bySource) return { docId, sourceId: candidate };
  }
  throw new Error('cannot allocate a unique legacy knowledge identity');
}
function rekeyIndexDocument(handle, row, next) {
  const oldDocId = row.doc_id;
  const newDocId = next.docId;
  if (!newDocId) throw new Error('knowledge document identity required');
  if (oldDocId === newDocId) {
    if (next.projectKey || next.sourceId || next.location !== undefined || next.updatedAt || next.metadata) {
      handle.db.prepare(`UPDATE knowledge_documents SET project_key=COALESCE(?,project_key),
        source_id=COALESCE(?,source_id),location=COALESCE(?,location),updated_at=COALESCE(?,updated_at),
        metadata=COALESCE(?,metadata) WHERE doc_id=?`)
        .run(next.projectKey || null, next.sourceId || null, next.location ?? null,
          next.updatedAt || null, next.metadata ?? null, oldDocId);
    }
    return;
  }
  const ftsRows = handle.db.prepare(`SELECT doc_id,section_id,title,heading,tokens,text
    FROM knowledge_fts WHERE doc_id=?`).all(oldDocId);
  handle.db.prepare('DELETE FROM knowledge_fts WHERE doc_id=?').run(oldDocId);
  handle.db.prepare('UPDATE knowledge_sections SET doc_id=? WHERE doc_id=?').run(newDocId, oldDocId);
  handle.db.prepare(`UPDATE knowledge_documents SET doc_id=?,project_key=COALESCE(?,project_key),
    source_id=COALESCE(?,source_id),location=COALESCE(?,location),updated_at=COALESCE(?,updated_at),
    metadata=COALESCE(?,metadata) WHERE doc_id=?`)
    .run(newDocId, next.projectKey || null, next.sourceId || null, next.location ?? null,
      next.updatedAt || null, next.metadata ?? null, oldDocId);
  for (const row of ftsRows) {
    handle.db.prepare(`INSERT INTO knowledge_fts(doc_id,section_id,title,heading,tokens,text)
      VALUES(?,?,?,?,?,?)`).run(newDocId, row.section_id, row.title, row.heading, row.tokens, row.text);
  }
}
function encode(value) { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
function decode(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}
function isHeading(line) { return /^\s{0,3}#{1,6}\s+\S/.test(line); }
export function chunkKnowledgeText(text, maximum = MAX_SECTION_CHARS) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
  let first = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) first = end + 1;
  }
  const chunks = [];
  let heading = '', body = [], chars = 0, start = 0;
  let fence = '';
  const flush = end => {
    const value = body.join('\n').trim();
    if (value) chunks.push({ heading: heading.slice(0, 240), text: value, startLine: start + 1, endLine: Math.max(start + 1, end) });
    body = []; chars = 0;
  };
  for (let index = first; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMarker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]?.[0] || '';
    if (fenceMarker) {
      if (!fence) fence = fenceMarker;
      else if (fence === fenceMarker) fence = '';
    }
    const headingLine = !fence && !fenceMarker && isHeading(line);
    if (headingLine && body.length) {
      flush(index);
      heading = line.replace(/^\s*#+\s*/, '').trim();
      start = index;
    } else if (headingLine) {
      heading = line.replace(/^\s*#+\s*/, '').trim();
      start = index;
    }
    if (!body.length) start = index;
    body.push(line);
    chars += line.length + 1;
    if (chars >= maximum) flush(index + 1);
  }
  flush(lines.length);
  if (!chunks.length) chunks.push({ heading: '', text: '', startLine: 1, endLine: 1 });
  return chunks;
}
function searchTokens(value) {
  const tokens = [];
  for (const run of String(value || '').normalize('NFKC').toLowerCase().match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) || []) {
    if (run.length === 1) tokens.push(run);
    else for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2));
  }
  for (const token of String(value || '').match(/[a-z0-9][a-z0-9_.:@+-]{1,}/gi) || []) tokens.push(token);
  return [...new Set(tokens)].slice(0, 96).join(' ');
}

export function indexKnowledgeEntry(input, options = {}) {
  if (!input || typeof input !== 'object') throw new Error('knowledge entry required');
  const projectKey = String(input.projectKey || '');
  if (!projectKey) throw new Error('knowledge projectKey required');
  const sourceId = String(input.sourceId || '');
  if (!sourceId) throw new Error('knowledge sourceId required');
  const title = String(input.title || sourceId).trim().slice(0, 240);
  const text = String(input.text ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  if (!text.trim()) throw new Error('knowledge content is empty');
  const digest = sha(Buffer.from(text, 'utf8'));
  const visibility = input.visibility === 'global' ? 'global' : 'project';
  const docId = documentId(projectKey, visibility, sourceId);
  const handle = open(options);
  try {
    let existing = handle.db.prepare('SELECT * FROM knowledge_documents WHERE doc_id=?').get(docId);
    if (!existing) {
      const bySource = handle.db.prepare(`SELECT * FROM knowledge_documents
        WHERE project_key=? AND visibility=? AND source_id=? LIMIT 1`).get(projectKey, visibility, sourceId);
      if (bySource && bySource.doc_id !== docId) existing = bySource;
    }
    const needsRekey = !!existing && existing.doc_id !== docId;
    if (existing && existing.digest === digest && existing.hidden === 0 && !needsRekey) {
      return { ...documentView(existing), reused: true, indexRevision: Number(readMeta(handle.db, 'index_revision', '0')) };
    }
    const revision = (Number(existing?.revision) || 0) + 1;
    const at = nowIso();
    const contentFile = contentPath(handle, docId, digest);
    const temporary = contentFile + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, contentFile);
    const staleContent = needsRekey ? contentPath(handle, existing.doc_id, existing.digest) : '';
    const sections = chunkKnowledgeText(text).map((section, index) => ({
      ...section,
      sectionId: sha([docId, digest, index, section.heading, section.text].join('\0')).slice(0, 24),
    }));
    handle.db.exec('BEGIN IMMEDIATE');
    try {
      if (needsRekey) {
        rekeyIndexDocument(handle, existing, {
          docId, projectKey, sourceId, location: existing.location,
          updatedAt: at, metadata: existing.metadata,
        });
      }
      handle.db.prepare(`INSERT INTO knowledge_documents
        (doc_id,project_key,visibility,source_id,source_kind,source_label,source_url,title,location,digest,
         product,version,applicability,source_date,imported_at,updated_at,status,revision,metadata,hidden)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
        ON CONFLICT(doc_id) DO UPDATE SET project_key=excluded.project_key,visibility=excluded.visibility,
        source_kind=excluded.source_kind,source_label=excluded.source_label,source_url=excluded.source_url,
        title=excluded.title,location=excluded.location,digest=excluded.digest,product=excluded.product,
        version=excluded.version,applicability=excluded.applicability,source_date=excluded.source_date,
        updated_at=excluded.updated_at,status=excluded.status,revision=excluded.revision,
        metadata=excluded.metadata,hidden=0`)
        .run(docId, projectKey, visibility, sourceId, String(input.sourceKind || 'local'),
          String(input.sourceLabel || '内部资料').slice(0, 160), String(input.sourceUrl || ''), title,
          String(input.location || contentFile), digest, String(input.product || ''), String(input.version || ''),
          String(input.applicability || 'unknown'), String(input.sourceDate || ''), existing?.imported_at || at, at,
          String(input.status || 'ready'), revision,
          JSON.stringify(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}));
      handle.db.prepare('DELETE FROM knowledge_fts WHERE doc_id=?').run(docId);
      handle.db.prepare('DELETE FROM knowledge_sections WHERE doc_id=?').run(docId);
      for (let index = 0; index < sections.length; index += 1) {
        const section = sections[index];
        handle.db.prepare('INSERT INTO knowledge_sections(doc_id,section_id,position,heading,text,bytes) VALUES(?,?,?,?,?,?)')
          .run(docId, section.sectionId, index, section.heading, section.text, Buffer.byteLength(section.text, 'utf8'));
        handle.db.prepare('INSERT INTO knowledge_fts(doc_id,section_id,title,heading,tokens,text) VALUES(?,?,?,?,?,?)')
          .run(docId, section.sectionId, title, section.heading,
            searchTokens([title, section.heading, section.text].join('\n')), section.text);
      }
      const indexRevision = bumpRevision(handle.db);
      handle.db.exec('COMMIT');
      const row = handle.db.prepare('SELECT * FROM knowledge_documents WHERE doc_id=?').get(docId);
      if (staleContent && staleContent !== contentFile) {
        try { fs.unlinkSync(staleContent); } catch { /* older content may already be absent */ }
      }
      return { ...documentView(row), sections: sections.length, indexRevision };
    } catch (error) {
      handle.db.exec('ROLLBACK');
      try { fs.unlinkSync(temporary); } catch { /* already moved */ }
      throw error;
    }
  } finally { close(handle); }
}

function documentView(row) {
  if (!row) return null;
  let metadata = {};
  try {
    const parsed = JSON.parse(row.metadata || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
  } catch { metadata = {}; }
  const sources = String(metadata.sources || '').trim();
  const sourceState = row.source_kind !== 'curation' ? 'source-indexed'
    : !sources ? 'source-missing'
      : /(?:^|\n)\s*(request|file|material|execution|source|asset):\S+/i.test(sources) ? 'source-reference'
        : 'source-unverified';
  return {
    docId: row.doc_id, projectKey: row.project_key, visibility: row.visibility,
    sourceId: row.source_id, sourceKind: row.source_kind, sourceLabel: row.source_label,
    sourceUrl: row.source_url, title: row.title, location: row.location, digest: row.digest,
    product: row.product || null, version: row.version || null,
    applicability: row.applicability || 'unknown', sourceDate: row.source_date || null,
    importedAt: row.imported_at, updatedAt: row.updated_at, status: row.status,
    revision: Number(row.revision) || 0, hidden: row.hidden === 1,
    review: {
      verification: String(metadata.verification || ''),
      conditions: redactText(String(metadata.conditions || '')).slice(0, 2000),
      sources: redactText(sources).slice(0, 2000),
      sourceState,
      sourceStateLabel: ({ 'source-indexed': '已索引来源', 'source-missing': '未记录来源',
        'source-reference': '含可定位引用', 'source-unverified': '来源待核' })[sourceState],
    },
  };
}
export function listKnowledgeEntries(projectKey, options = {}) {
  const handle = open(options);
  try {
    const offset = Math.max(0, Number(options.offset) || 0);
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 30));
    const query = String(options.query || '').trim().toLowerCase();
    const rows = handle.db.prepare(`SELECT * FROM knowledge_documents
      WHERE hidden=0 AND (project_key=? OR visibility='global')
      ${query ? "AND (lower(title) LIKE ? OR lower(location) LIKE ? OR lower(source_label) LIKE ?)" : ''}
      ORDER BY updated_at DESC, doc_id LIMIT ? OFFSET ?`)
      .all(...(query ? [projectKey, '%' + query + '%', '%' + query + '%', '%' + query + '%'] : [projectKey]),
        limit + 1, offset);
    const more = rows.length > limit;
    return { offset, nextOffset: more ? offset + limit : null,
      rows: rows.slice(0, limit).map(documentView),
      indexRevision: 'local:' + readMeta(handle.db, 'index_revision', '0'),
      note: '只列出当前项目可见条目；正文只在模型或用户明确读取时返回。' };
  } finally { close(handle); }
}
export function deleteKnowledgeEntry(projectKey, sourceId, options = {}) {
  const handle = open(options);
  try {
    const row = handle.db.prepare('SELECT doc_id FROM knowledge_documents WHERE project_key=? AND source_id=? AND hidden=0')
      .get(projectKey, String(sourceId || ''));
    if (!row) throw new Error('knowledge source not found in current project');
    handle.db.exec('BEGIN IMMEDIATE');
    try {
      handle.db.prepare('UPDATE knowledge_documents SET hidden=1,updated_at=? WHERE doc_id=?').run(nowIso(), row.doc_id);
      const indexRevision = bumpRevision(handle.db);
      handle.db.exec('COMMIT');
      return { hidden: true, sourceId, indexRevision };
    } catch (error) { handle.db.exec('ROLLBACK'); throw error; }
  } finally { close(handle); }
}
export function knowledgeEntryIdentity(projectKey, sourceId, options = {}) {
  const handle = open(options);
  try {
    const row = handle.db.prepare(`SELECT * FROM knowledge_documents
      WHERE project_key=? AND source_id=? AND hidden=0 LIMIT 1`).get(projectKey, String(sourceId || ''));
    if (!row) return null;
    let metadata = {};
    try {
      const parsed = JSON.parse(row.metadata || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    } catch { /* an unreadable metadata blob still identifies the document */ }
    return { ...documentView(row), metadata };
  } finally { close(handle); }
}
function candidateRows(handle, projectKey, concepts) {
  const expression = ftsExpression(concepts);
  if (expression) {
    try {
      return handle.db.prepare(`SELECT d.*,s.section_id,s.position,s.heading,s.text,s.bytes,bm25(knowledge_fts) AS rank
        FROM knowledge_fts JOIN knowledge_documents d ON d.doc_id=knowledge_fts.doc_id
        JOIN knowledge_sections s ON s.doc_id=knowledge_fts.doc_id AND s.section_id=knowledge_fts.section_id
        WHERE knowledge_fts MATCH ? AND d.hidden=0 AND d.status='ready' AND (d.project_key=? OR d.visibility='global')
        ORDER BY rank LIMIT ?`).all(expression, projectKey, MAX_CANDIDATES);
    } catch { /* malformed FTS input falls back to a bounded local scan */ }
  }
  return handle.db.prepare(`SELECT d.*,s.section_id,s.position,s.heading,s.text,s.bytes,0 AS rank
    FROM knowledge_documents d JOIN knowledge_sections s ON s.doc_id=d.doc_id
    WHERE d.hidden=0 AND d.status='ready' AND (d.project_key=? OR d.visibility='global')
    ORDER BY d.updated_at DESC LIMIT 500`).all(projectKey);
}
export function searchKnowledgeIndex(projectKey, input = {}, options = {}) {
  const query = String(input.query || '').trim();
  const queryHash = sha(query).slice(0, 16);
  const concepts = queryConcepts(query);
  const strategy = options.strategy || 'knowledge-first';
  const cursor = decode(input.cursor);
  if (input.cursor && !cursor) throw new Error('knowledge cursor invalid');
  if (cursor && cursor.queryHash !== queryHash) throw new Error('knowledge cursor expired');
  const offset = Math.max(0, Number(cursor?.offset) || 0);
  const handle = open(options);
  try {
    const currentRevision = Number(readMeta(handle.db, 'index_revision', '0'));
    if (cursor && cursor.indexRevision !== currentRevision) throw new Error('knowledge index changed; search again');
    const rows = candidateRows(handle, projectKey, concepts.conceptual);
    const scored = [];
    const seen = new Set();
    for (const row of rows) {
      const scoredRow = scoreKnowledgeSection(row, concepts.conceptual, {
        cves: concepts.cves, paths: concepts.paths,
        product: input.product, version: input.version,
        phrase: concepts.phrase, requireAll: options.requireAll === true,
      });
      if (!scoredRow) continue;
      const key = [row.doc_id, row.heading, row.text].join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
      scored.push({ row, ...scoredRow });
    }
    scored.sort((a, b) => b.coverage - a.coverage || b.exact - a.exact || b.phraseHit - a.phraseHit
      || b.titleHits - a.titleHits || b.headingHits - a.headingHits || b.score - a.score);
    const perDoc = new Map();
    const merged = [];
    for (const item of scored) {
      const count = perDoc.get(item.row.doc_id) || 0;
      if (count >= 2) continue;
      perDoc.set(item.row.doc_id, count + 1);
      merged.push(item);
    }
    const limit = Math.max(1, Math.min(5, Number(input.limit) || 5));
    const page = merged.slice(offset, offset + limit);
    const nextCursor = offset + page.length < merged.length
      ? encode({ queryHash, offset: offset + page.length, indexRevision: currentRevision }) : null;
    const sources = page.map(item => {
      const ref = encode({ kind: 'local', projectKey, docId: item.row.doc_id, sectionId: item.row.section_id,
        digest: item.row.digest, indexRevision: currentRevision, queryHash: sha(query).slice(0, 16) });
      return {
        ref, title: item.row.title, section: item.row.heading || '正文',
        excerpt: buildExcerpt(item.row.text, concepts.conceptual),
        sourceKind: 'local', sourceLabel: item.row.source_label,
        revision: item.row.digest, product: item.row.product || null,
        version: item.row.version || null, applicability: item.applicability || 'unknown',
        sourceDate: item.row.source_date || null, stale: item.row.metadata?.stale === true ? true : 'unknown',
      };
    });
    const payload = boundedJson({
      ok: true, status: sources.length ? 'hits' : 'no_match',
      query: query.length > 300 ? query.slice(0, 300) + '…' : query,
      queryHash, strategy, indexRevision: 'local:' + currentRevision,
      rows: sources, nextCursor, fallbackAvailable: true,
      note: '短结果只用于定位；读取正文按 8192 字节分段。',
    }, Number(input.maxBytes) || 3072);
    return payload;
  } finally { close(handle); }
}
export function knowledgeIndexStatus(projectKey, options = {}) {
  const handle = open(options);
  try {
    const row = handle.db.prepare(`SELECT COUNT(*) AS documents FROM knowledge_documents
      WHERE hidden=0 AND status='ready' AND (project_key=? OR visibility='global')`).get(projectKey);
    return { status: 'ready', documents: Number(row?.documents) || 0,
      indexRevision: 'local:' + readMeta(handle.db, 'index_revision', '0'),
      path: handle.file, note: '打开状态只做常数规模配置查询，不检索正文。' };
  } catch (error) {
    return { status: /no such|not a database|malformed/i.test(String(error.message)) ? 'index_corrupt' : 'index_unavailable',
      documents: 0, error: String(error.message) };
  } finally { close(handle); }
}
export function findKnowledgeDuplicate(projectKey, { title = '', text = '', product = '', version = '' } = {}, options = {}) {
  const handle = open(options);
  try {
    const digest = sha(Buffer.from(String(text || ''), 'utf8'));
    const exactRow = handle.db.prepare(`SELECT * FROM knowledge_documents
      WHERE hidden=0 AND digest=? AND (project_key=? OR visibility='global') LIMIT 1`).get(digest, projectKey);
    if (exactRow) return { kind: 'exact', entry: documentView(exactRow) };
    const titleKey = String(title || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    if (!titleKey) return null;
    const rows = handle.db.prepare(`SELECT * FROM knowledge_documents
      WHERE hidden=0 AND (project_key=? OR visibility='global')
      ORDER BY updated_at DESC LIMIT 200`).all(projectKey);
    for (const row of rows) {
      const key = String(row.title || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
      if (key !== titleKey) continue;
      if (product && row.product && normalizedSearchText(row.product) !== normalizedSearchText(product)) continue;
      if (version && row.version && versionApplicability(row.version, version) === 'excluded') continue;
      return { kind: 'similar', entry: documentView(row) };
    }
    return null;
  } finally { close(handle); }
}
export function readKnowledgeIndexRef(ref, input = {}, options = {}) {
  const decoded = typeof ref === 'string' ? decode(ref) : ref;
  if (!decoded || decoded.kind !== 'local') throw Object.assign(new Error('knowledge ref invalid'), { code: 'ref_invalid' });
  const expectedProject = String(options.projectKey || input.projectKey || decoded.projectKey || '');
  if (expectedProject && decoded.projectKey !== expectedProject)
    throw Object.assign(new Error('knowledge ref belongs to another project'), { code: 'ref_forbidden' });
  const handle = open(options);
  try {
    const currentRevision = Number(readMeta(handle.db, 'index_revision', '0'));
    if (decoded.indexRevision !== currentRevision) throw Object.assign(new Error('knowledge index changed; search again'), { code: 'ref_expired' });
    const row = handle.db.prepare(`SELECT d.*,s.section_id,s.position,s.heading,s.text,s.bytes
      FROM knowledge_documents d JOIN knowledge_sections s ON s.doc_id=d.doc_id
      WHERE d.doc_id=? AND s.section_id=? AND d.hidden=0 AND (d.project_key=? OR d.visibility='global')`)
      .get(decoded.docId, decoded.sectionId, expectedProject || decoded.projectKey);
    if (!row || row.digest !== decoded.digest) throw Object.assign(new Error('knowledge source changed or removed'), { code: 'ref_expired' });
    const cursor = input.cursor ? decode(input.cursor) : null;
    if (input.cursor && !cursor) throw new Error('knowledge read cursor invalid');
    if (cursor && (cursor.docId !== decoded.docId || cursor.sectionId !== decoded.sectionId || cursor.digest !== decoded.digest))
      throw Object.assign(new Error('knowledge read cursor expired'), { code: 'cursor_expired' });
    const offset = Math.max(0, Number(cursor?.offset) || 0);
    const maximum = Math.max(1, Math.min(8192, Number(input.maxBytes) || 8192));
    const bytes = Buffer.from(row.text, 'utf8');
    if (offset > bytes.length) throw new Error('knowledge read cursor out of range');
    let end = Math.min(bytes.length, offset + maximum);
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    const page = bytes.subarray(offset, end);
    const nextCursor = end < bytes.length ? encode({ docId: decoded.docId, sectionId: decoded.sectionId,
      digest: decoded.digest, offset: end }) : null;
    return {
      ok: true, status: 'read', ref: typeof ref === 'string' ? ref : encode(decoded),
      title: row.title, section: row.heading || '正文', text: page.toString('utf8'),
      sourceKind: 'local', sourceLabel: row.source_label, revision: row.digest,
      product: row.product || null, version: row.version || null,
      applicability: row.applicability || 'unknown', sourceDate: row.source_date || null,
      offset, nextCursor, complete: end >= bytes.length, sectionBytes: bytes.length,
      bytes: page.length,
    };
  } finally { close(handle); }
}

export function readKnowledgeSource(projectKey, sourceId, input = {}, options = {}) {
  const handle = open(options);
  try {
    const source = String(sourceId || '');
    const doc = handle.db.prepare(`SELECT doc_id,digest,title,source_label FROM knowledge_documents d
      WHERE d.source_id=? AND d.hidden=0 AND d.status='ready' AND (d.project_key=? OR d.visibility='global')
      ORDER BY CASE WHEN d.project_key=? THEN 0 ELSE 1 END LIMIT 1`).get(source, projectKey, projectKey);
    if (!doc) throw Object.assign(new Error('knowledge source not found'), { code: 'source_not_found' });
    const sections = handle.db.prepare(`SELECT section_id,position,heading,text,bytes FROM knowledge_sections
      WHERE doc_id=? ORDER BY position`).all(doc.doc_id);
    if (!sections.length) throw Object.assign(new Error('knowledge source has no readable section'), { code: 'source_empty' });
    const cursor = input.cursor ? decode(input.cursor) : null;
    if (input.cursor && (!cursor || cursor.kind !== 'source' || cursor.projectKey !== projectKey || cursor.sourceId !== source
      || cursor.docId !== doc.doc_id || cursor.digest !== doc.digest))
      throw Object.assign(new Error('knowledge read cursor expired'), { code: 'cursor_expired' });
    const sectionIndex = Math.max(0, Math.min(sections.length - 1, Number(cursor?.sectionIndex) || 0));
    const section = sections[sectionIndex];
    if (cursor && cursor.sectionId !== section.section_id)
      throw Object.assign(new Error('knowledge read cursor expired'), { code: 'cursor_expired' });
    const bytes = Buffer.from(section.text, 'utf8');
    const offset = Math.max(0, Number(cursor?.offset) || 0);
    const maximum = Math.max(1, Math.min(8192, Number(input.maxBytes) || 8192));
    let end = Math.min(bytes.length, offset + maximum);
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    let nextCursor = null;
    if (end < bytes.length) nextCursor = encode({ kind: 'source', projectKey, sourceId: source, docId: doc.doc_id,
      digest: doc.digest, sectionId: section.section_id, sectionIndex, offset: end });
    else if (sectionIndex + 1 < sections.length) nextCursor = encode({ kind: 'source', projectKey, sourceId: source,
      docId: doc.doc_id, digest: doc.digest, sectionId: sections[sectionIndex + 1].section_id,
      sectionIndex: sectionIndex + 1, offset: 0 });
    const page = bytes.subarray(offset, end);
    return {
      ok: true, status: 'read', title: doc.title, section: section.heading || '正文', text: page.toString('utf8'),
      sourceKind: 'local', sourceLabel: doc.source_label, revision: doc.digest,
      offset, bytes: page.length, complete: !nextCursor, sectionBytes: bytes.length,
      sectionIndex, sectionCount: sections.length, nextCursor,
    };
  } finally { close(handle); }
}

export function importLegacyCompetitionKnowledge(store, sessionId, options = {}) {
  const sourceSessionId = String(options.sourceSessionId || sessionId);
  const destinationProjectKey = String(options.destinationProjectKey || sessionId);
  const rows = store.db.prepare(`SELECT record FROM competition_knowledge k
    WHERE session_id=? AND COALESCE(json_extract(record,'$.hidden'),0)=0
    AND revision=(SELECT MAX(k2.revision) FROM competition_knowledge k2
      WHERE k2.session_id=k.session_id AND k2.source_id=k.source_id
      AND COALESCE(json_extract(k2.record,'$.hidden'),0)=0)`).all(sourceSessionId);
  let imported = 0, failed = 0;
  for (const row of rows) {
    try {
      const record = JSON.parse(row.record);
      if (!record?.text) continue;
      const originalSourceId = String(record.sourceId || '').trim();
      if (!originalSourceId) { failed += 1; continue; }
      const projectedSourceId = originalSourceId + '::legacy-root-' + sha(sourceSessionId).slice(0, 12);
      indexKnowledgeEntry({
        projectKey: destinationProjectKey, sourceId: projectedSourceId, sourceKind: 'local',
        sourceLabel: record.title || '旧比赛资料', title: record.title || originalSourceId,
        location: record.path || '', text: record.text, product: record.product,
        version: record.version, applicability: record.applicability || 'unknown',
        sourceDate: record.sourceDate, metadata: {
          legacy: true, legacyRootSessionId: sourceSessionId, legacySourceId: originalSourceId,
          revision: record.revision,
        },
      }, options);
      imported += 1;
    } catch { failed += 1; /* bad legacy rows remain isolated and visible to the caller */ }
  }
  return { imported, failed };
}

export function migrateKnowledgeProject(sourceSessionId, destinationProjectKey, options = {}) {
  const source = String(sourceSessionId || '');
  const destination = String(destinationProjectKey || '');
  if (!source || !destination || source === destination) return { updated: 0, merged: 0, conflicts: 0 };
  const handle = open(options);
  const contentToRemove = [];
  const contentToMove = [];
  try {
    const rows = handle.db.prepare('SELECT * FROM knowledge_documents WHERE project_key=?').all(source);
    if (!rows.length) return { updated: 0, merged: 0, conflicts: 0 };
    let updated = 0, merged = 0, conflicts = 0;
    handle.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const existing = handle.db.prepare(`SELECT * FROM knowledge_documents
          WHERE project_key=? AND visibility=? AND source_id=? LIMIT 1`).get(destination, row.visibility, row.source_id);
        if (existing && existing.hidden === 0 && sameMigratableDocument(existing, row)) {
          handle.db.prepare('DELETE FROM knowledge_fts WHERE doc_id=?').run(row.doc_id);
          handle.db.prepare('DELETE FROM knowledge_sections WHERE doc_id=?').run(row.doc_id);
          handle.db.prepare('DELETE FROM knowledge_documents WHERE doc_id=?').run(row.doc_id);
          contentToRemove.push(contentPath(handle, row.doc_id, row.digest));
          merged += 1;
        } else {
          const identity = uniqueMigratedIdentity(handle.db, destination, row.visibility, row.source_id, row.digest);
          let metadata = {};
          try {
            const parsed = JSON.parse(row.metadata || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
          } catch { /* preserve a readable conflict marker even if old metadata is corrupt */ }
          metadata.migrationSourceRoot = source;
          metadata.migrationOriginalSourceId = row.source_id;
          metadata.migratedAt = nowIso();
          if (existing) {
            metadata.migrationConflict = {
              originalSourceId: row.source_id,
              collidingDocId: existing.doc_id,
              collidingDigest: existing.digest,
              sourceDigest: row.digest,
              detectedAt: nowIso(),
            };
            conflicts += 1;
          }
          const oldPath = contentPath(handle, row.doc_id, row.digest);
          const newPath = contentPath(handle, identity.docId, row.digest);
          const hasOldContent = (() => { try { return fs.existsSync(oldPath); } catch { return false; } })();
          rekeyIndexDocument(handle, row, {
            docId: identity.docId,
            projectKey: destination,
            sourceId: identity.sourceId,
            location: row.location,
            updatedAt: nowIso(),
            metadata: JSON.stringify(metadata),
          });
          if (hasOldContent && oldPath !== newPath) contentToMove.push({
            oldPath, newPath, docId: identity.docId, previousLocation: row.location,
          });
          updated += 1;
        }
      }
      if (updated || merged) bumpRevision(handle.db);
      handle.db.exec('COMMIT');
    } catch (error) { handle.db.exec('ROLLBACK'); throw error; }
    for (const file of contentToRemove) {
      try { fs.unlinkSync(file); } catch { /* already absent */ }
    }
    for (const file of contentToMove) {
      let moved = false;
      try {
        if (fs.existsSync(file.newPath)) moved = true;
        else {
          fs.renameSync(file.oldPath, file.newPath);
          moved = true;
        }
      } catch { moved = false; }
      if (moved && (!file.previousLocation || file.previousLocation === file.oldPath)) {
        try {
          handle.db.prepare('UPDATE knowledge_documents SET location=? WHERE doc_id=?')
            .run(file.newPath, file.docId);
        } catch { /* content remains indexed in sections even if the mirror path is stale */ }
      }
    }
    return { updated, merged, conflicts };
  } finally { close(handle); }
}
