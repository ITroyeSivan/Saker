// Persistent metadata index. A source page, revision history and cursor commit
// in one SQLite transaction; original files remain in their immutable cache.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dedupKeyOf, enrichCandidate, mergeCandidates, TRUST_RANK } from './source-records.js';
export const SOURCE_INDEX_SCHEMA = 'saker.nday.source-collector/3';
const hash = value => createHash('sha256').update(value).digest('hex');
const compact = state => Object.fromEntries(Object.entries(state).filter(([key]) => !['records', 'candidates', 'recordCount', 'candidateCount'].includes(key)));
const time = value => { const result = Date.parse(value || ''); return Number.isFinite(result) ? result : 0; };
const pairToken = pair => 'u' + [...pair].map(character => character.codePointAt(0).toString(16).padStart(6, '0')).join('');
function shortTokens(text) {
  const result = new Set();
  for (const match of text.matchAll(/[^\x00-\x7f]{2,}/gu)) {
    const characters = [...match[0]];
    for (let index = 1; index < characters.length; index++) result.add(pairToken(characters[index - 1] + characters[index]));
  }
  return [...result].join(' ');
}
function identity(row) {
  if (!row || typeof row.source !== 'string' || !row.source || row.source.length > 60
    || typeof row.id !== 'string' || !row.id || row.id.length > 160) throw new Error('Source record identity is missing or inconsistent');
  return `${row.source}:${row.id}`;
}
export function sourceRecordPreview(row, now = Date.now()) {
  const enriched = enrichCandidate(row, now), result = {};
  for (const key of ['schema', 'source', 'sourceKind', 'id', 'title', 'summary', 'published', 'modified', 'withdrawnAt', 'status', 'url',
    'evidenceLevel', 'publishedAt', 'freshness', 'trust', 'dedupKey', 'revision', 'observedAt', 'removedAt', 'identifierSemantics']) {
    if (enriched[key] !== undefined) result[key] = String(enriched[key]).slice(0, key === 'summary' ? 1200 : key === 'url' ? 1000 : 500);
  }
  for (const key of ['ids', 'products', 'sources']) if (Array.isArray(enriched[key])) result[key] = enriched[key].slice(0, 20).map(value => String(value).slice(0, 160));
  result.ageDays = enriched.ageDays;
  result.requiresSourceReview = enriched.requiresSourceReview === true;
  const metadataPreview = value => Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    !['contentFile', 'contentArchive'].includes(key) && ['string', 'boolean', 'number'].includes(typeof item)).map(([key, item]) => [key, typeof item === 'string' ? item.slice(0, 1500) : item]));
  if (enriched.repositoryFile) result.repositoryFile = metadataPreview(enriched.repositoryFile);
  if (enriched.kev) result.kev = metadataPreview(enriched.kev);
  if (enriched.advisory) result.advisory = metadataPreview(enriched.advisory);
  // Conditions and references can contain megabytes; retrieve the stored
  // revision explicitly rather than adding them to every status response.
  if (enriched.official) {
    const { affected, references, ...metadata } = enriched.official;
    result.official = { ...metadataPreview(metadata), affectedCount: (affected?.length ?? 0) + (metadata.moreAffected ?? 0),
      referenceCount: references?.length ?? 0 };
  }
  return result;
}
function jsonLines(file, visit) {
  if (!fs.existsSync(file)) return;
  const descriptor = fs.openSync(file, 'r'), buffer = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0);
  try {
    let size;
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) {
      pending = Buffer.concat([pending, buffer.subarray(0, size)]);
      let end;
      while ((end = pending.indexOf(10)) >= 0) {
        if (end > 16 * 1024 * 1024) throw new Error('Legacy revision line exceeds byte limit; existing data preserved');
        const line = pending.subarray(0, end).toString('utf8'); pending = pending.subarray(end + 1);
        if (line.trim()) visit(JSON.parse(line));
      }
      if (pending.length > 16 * 1024 * 1024) throw new Error('Legacy revision line exceeds byte limit; existing data preserved');
    }
    if (pending.toString('utf8').trim()) visit(JSON.parse(pending.toString('utf8')));
  } finally { fs.closeSync(descriptor); }
}
export class SourceIndex {
  constructor(paths, legacy = {}, now = Date.now()) {
    this.paths = paths;
    this._statements = new Map();
    fs.mkdirSync(paths.dir, { recursive: true });
    this.db = new DatabaseSync(paths.index);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS records(seq INTEGER PRIMARY KEY, record_key TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL, id TEXT NOT NULL, group_key TEXT NOT NULL, revision TEXT NOT NULL, observed_at TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS records_group ON records(group_key,seq);
        CREATE INDEX IF NOT EXISTS records_source ON records(source,group_key);
        CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY, record_key TEXT NOT NULL, source TEXT NOT NULL,
          revision TEXT NOT NULL, previous_revision TEXT, observed_at TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS revisions_key ON revisions(record_key,seq);
        CREATE TABLE IF NOT EXISTS candidates(seq INTEGER PRIMARY KEY, group_key TEXT NOT NULL UNIQUE,
          trust_rank INTEGER NOT NULL, published_ms INTEGER NOT NULL, title TEXT NOT NULL, search_text TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS candidates_priority ON candidates(trust_rank DESC,published_ms DESC,title,group_key);
        CREATE INDEX IF NOT EXISTS candidates_publication ON candidates(published_ms);
        CREATE VIRTUAL TABLE IF NOT EXISTS candidates_fts USING fts5(search_text,content='candidates',content_rowid='seq',tokenize='trigram');
        CREATE VIRTUAL TABLE IF NOT EXISTS candidates_short_fts USING fts5(tokens,detail=none,columnsize=0);
        CREATE TRIGGER IF NOT EXISTS candidates_insert AFTER INSERT ON candidates BEGIN
          INSERT INTO candidates_fts(rowid,search_text) VALUES(new.seq,new.search_text); END;
        CREATE TRIGGER IF NOT EXISTS candidates_delete AFTER DELETE ON candidates BEGIN
          INSERT INTO candidates_fts(candidates_fts,rowid,search_text) VALUES('delete',old.seq,old.search_text); END;
        CREATE TRIGGER IF NOT EXISTS candidates_update AFTER UPDATE ON candidates BEGIN
          INSERT INTO candidates_fts(candidates_fts,rowid,search_text) VALUES('delete',old.seq,old.search_text);
          INSERT INTO candidates_fts(rowid,search_text) VALUES(new.seq,new.search_text); END;`);
      const initialized = this.statement("SELECT value FROM metadata WHERE key='initialized'").get();
      if (!initialized) {
        if (legacy.schema === SOURCE_INDEX_SCHEMA) throw new Error('Source index missing; compact mirror cannot reconstruct original records');
        this.migrate(legacy, now);
      }
      if (this.metadata('state', {}).schema !== SOURCE_INDEX_SCHEMA) throw new Error('Unsupported source index schema; existing data preserved');
      if (!this.metadata('shortIndex', false)) this.transaction(() => {
        // Upgrade the auxiliary index without loading all candidate bodies.
        let after = 0;
        for (;;) {
          const rows = this.statement('SELECT seq,search_text FROM candidates WHERE seq>? ORDER BY seq LIMIT 1000').all(after);
          if (!rows.length) break;
          for (const row of rows) this.replaceShortIndex(row.seq, row.search_text);
          after = rows.at(-1).seq;
        }
        this.setMetadata('shortIndex', true);
      });
      if (!this.metadata('kevChronology', false)) this.transaction(() => {
        if (this.metadata('kevChronology', false)) return;
        // Correct persisted projections from older adapters without rewriting
        // original records, their revisions or synchronization checkpoints.
        let after = '', changed = false;
        for (;;) {
          const groups = this.statement("SELECT DISTINCT group_key FROM records WHERE source='cisa-kev' AND group_key>? ORDER BY group_key LIMIT 100").all(after);
          if (!groups.length) break;
          for (const row of groups) this.rebuildGroup(row.group_key, now);
          after = groups.at(-1).group_key; changed = true;
        }
        if (changed) this.setMetadata('generation', this.metadata('generation', 0) + 1);
        this.setMetadata('kevChronology', true);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  statement(sql) {
    if (!this._statements.has(sql)) this._statements.set(sql, this.db.prepare(sql));
    return this._statements.get(sql);
  }
  close() { this._statements.clear(); this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  metadata(key, fallback = null) {
    const row = this.statement('SELECT value FROM metadata WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setMetadata(key, value) {
    this.statement('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  migrate(legacy, now) {
    // Preserve the exact old state before the first migration. Never make a
    // compact status file the sole remaining copy of legacy originals.
    if (fs.existsSync(this.paths.state) && (legacy.records || legacy.candidates)) {
      const bytes = fs.readFileSync(this.paths.state), backup = this.paths.state + '.legacy-' + hash(bytes) + '.json';
      if (fs.existsSync(backup)) { if (!fs.readFileSync(backup).equals(bytes)) throw new Error('Legacy state backup differs'); }
      else fs.writeFileSync(backup, bytes, { flag: 'wx' });
    }
    this.transaction(() => {
      if (this.metadata('initialized', false)) return;
      const groups = new Set();
      for (const raw of legacy.records ?? legacy.candidates ?? []) {
        const key = identity(raw), { revision, observedAt, ...row } = raw;
        const body = JSON.stringify(row), digest = revision || hash(body), group = dedupKeyOf(row);
        this.statement('INSERT INTO records(record_key,source,id,group_key,revision,observed_at,body) VALUES(?,?,?,?,?,?,?)')
          .run(key, row.source, row.id, group, digest, observedAt || new Date(now).toISOString(), body);
        groups.add(group);
      }
      jsonLines(this.paths.revisions, entry => {
        if (!entry.record || identity(entry.record) !== entry.key || entry.source !== entry.record.source
          || hash(JSON.stringify(entry.record)) !== entry.revision) throw new Error('Legacy revision identity or digest differs; existing data preserved');
        this.statement('INSERT INTO revisions(record_key,source,revision,previous_revision,observed_at,body) VALUES(?,?,?,?,?,?)')
          .run(entry.key, entry.source, entry.revision, entry.previousRevision ?? null, entry.observedAt, JSON.stringify(entry.record));
      });
      for (const group of groups) this.rebuildGroup(group, now);
      this.setMetadata('state', { ...compact(legacy), schema: SOURCE_INDEX_SCHEMA });
      this.setMetadata('generation', 0);
      this.setMetadata('initialized', true);
      this.setMetadata('shortIndex', true);
      this.setMetadata('kevChronology', true);
    });
  }
  rebuildGroup(group, now) {
    const rows = this.statement('SELECT body,revision,observed_at FROM records WHERE group_key=? ORDER BY seq').all(group)
      .map(row => ({ ...JSON.parse(row.body), revision: row.revision, observedAt: row.observed_at }));
    const candidate = mergeCandidates(rows, now)[0];
    if (!candidate) {
      const before = this.statement('SELECT seq FROM candidates WHERE group_key=?').get(group);
      if (before) this.statement('DELETE FROM candidates_short_fts WHERE rowid=?').run(before.seq);
      this.statement('DELETE FROM candidates WHERE group_key=?').run(group); return;
    }
    const search = rows.map(row => sourceRecordPreview(row, now)).flatMap(row =>
      [row.id, ...(row.ids ?? []), row.title, row.summary, ...(row.products ?? []), row.source])
      .map(value => String(value ?? '')).join(' ').toLowerCase();
    // Store a bounded projection. Full per-source conditions live in records.
    const preview = sourceRecordPreview(candidate, now);
    this.statement(`INSERT INTO candidates(group_key,trust_rank,published_ms,title,search_text,body) VALUES(?,?,?,?,?,?)
      ON CONFLICT(group_key) DO UPDATE SET trust_rank=excluded.trust_rank,published_ms=excluded.published_ms,
        title=excluded.title,search_text=excluded.search_text,body=excluded.body`)
      .run(group, TRUST_RANK[candidate.trust] ?? 0, time(candidate.published), String(candidate.title ?? ''), search, JSON.stringify(preview));
    this.replaceShortIndex(this.statement('SELECT seq FROM candidates WHERE group_key=?').get(group).seq, search);
  }
  replaceShortIndex(sequence, text) {
    this.statement('DELETE FROM candidates_short_fts WHERE rowid=?').run(sequence);
    const tokens = shortTokens(text);
    if (tokens) this.statement('INSERT INTO candidates_short_fts(rowid,tokens) VALUES(?,?)').run(sequence, tokens);
  }
  upsert(raw, observedAt, groups) {
    const { revision: ignoredRevision, observedAt: ignoredObservedAt, ...row } = raw;
    const key = identity(row), body = JSON.stringify(row), revision = hash(body);
    const before = this.statement('SELECT revision,group_key FROM records WHERE record_key=?').get(key);
    if (before?.revision === revision) return;
    const group = dedupKeyOf(row);
    this.statement('INSERT INTO revisions(record_key,source,revision,previous_revision,observed_at,body) VALUES(?,?,?,?,?,?)')
      .run(key, row.source, revision, before?.revision ?? null, observedAt, body);
    this.statement(`INSERT INTO records(record_key,source,id,group_key,revision,observed_at,body) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(record_key) DO UPDATE SET group_key=excluded.group_key,revision=excluded.revision,observed_at=excluded.observed_at,body=excluded.body`)
      .run(key, row.source, row.id, group, revision, observedAt, body);
    if (before) groups.add(before.group_key);
    groups.add(group);
  }
  commitPage(rows, state, { now = Date.now(), snapshotSource = null } = {}) {
    this.transaction(() => {
      const groups = new Set(), observedAt = new Date(now).toISOString();
      for (const row of rows) this.upsert(row, observedAt, groups);
      if (snapshotSource) {
        this.db.exec('CREATE TEMP TABLE IF NOT EXISTS page_present(record_key TEXT PRIMARY KEY); DELETE FROM page_present;');
        const insert = this.statement('INSERT OR IGNORE INTO page_present(record_key) VALUES(?)');
        for (const row of rows) insert.run(identity(row));
        let after = 0;
        for (;;) {
          const removed = this.statement(`SELECT seq,body FROM records WHERE source=? AND seq>?
            AND NOT EXISTS(SELECT 1 FROM page_present WHERE record_key=records.record_key) ORDER BY seq LIMIT 100`).all(snapshotSource, after);
          if (!removed.length) break;
          for (const item of removed) {
            const row = JSON.parse(item.body);
            if (row.status !== 'removed-from-current-catalog') this.upsert({ ...row, status: 'removed-from-current-catalog', removedAt: observedAt }, observedAt, groups);
          }
          after = removed.at(-1).seq;
        }
        this.db.exec('DELETE FROM page_present;');
      }
      for (const group of groups) this.rebuildGroup(group, now);
      if (groups.size) this.setMetadata('generation', this.metadata('generation', 0) + 1);
      this.setMetadata('state', { ...compact(state), schema: SOURCE_INDEX_SCHEMA });
    });
  }
  counts(now = Date.now()) {
    return { recordCount: this.statement('SELECT count(*) AS n FROM records').get().n,
      candidateCount: this.statement('SELECT count(*) AS n FROM candidates').get().n,
      freshCandidates: this.statement('SELECT count(*) AS n FROM candidates WHERE published_ms>=?').get(now - 7 * 86400000).n };
  }
  state(now = Date.now()) {
    const counts = this.counts(now);
    return { ...this.metadata('state', {}), ...counts,
      records: this.statement('SELECT body,revision,observed_at FROM records ORDER BY seq LIMIT 20').all().map(row =>
        sourceRecordPreview({ ...JSON.parse(row.body), revision: row.revision, observedAt: row.observed_at }, now)),
      candidates: this.query({ limit: 20, now }).rows };
  }
  query({ query = '', source = '', limit = 20, cursor = null, now = Date.now() } = {}) {
    if (typeof query !== 'string' || query.length > 300 || typeof source !== 'string' || source.length > 60
      || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid source index query or page size');
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length > 12) throw new Error('Too many source index query terms');
    const selection = hash(JSON.stringify({ query, source, limit })), generation = this.metadata('generation', 0);
    let offset = 0;
    if (cursor !== null) {
      let parsed; try { parsed = JSON.parse(cursor); } catch { throw new Error('Invalid source index cursor'); }
      if (parsed.selection !== selection || parsed.generation !== generation || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0)
        throw new Error('Source index cursor selection or revision changed');
      offset = parsed.offset;
    }
    const predicates = [], params = [], ftsTerms = terms.filter(term => [...term].length >= 3);
    if (ftsTerms.length) {
      predicates.push('c.seq IN (SELECT rowid FROM candidates_fts WHERE candidates_fts MATCH ?)');
      params.push(ftsTerms.map(term => '"' + term.replaceAll('"', '""') + '"').join(' AND '));
    }
    const pairs = terms.filter(term => /^[^\x00-\x7f]{2}$/u.test(term));
    if (pairs.length) {
      predicates.push('c.seq IN (SELECT rowid FROM candidates_short_fts WHERE candidates_short_fts MATCH ?)');
      params.push(pairs.map(pairToken).join(' AND '));
    }
    for (const term of terms) { predicates.push('instr(c.search_text,?)>0'); params.push(term); }
    if (source) { predicates.push('EXISTS(SELECT 1 FROM records r WHERE r.group_key=c.group_key AND r.source=?)'); params.push(source); }
    const where = predicates.length ? ' WHERE ' + predicates.join(' AND ') : '';
    const total = this.statement('SELECT count(*) AS n FROM candidates c' + where).get(...params).n;
    const rows = this.statement('SELECT c.body FROM candidates c' + where + ' ORDER BY c.trust_rank DESC,c.published_ms DESC,c.title,c.group_key LIMIT ? OFFSET ?')
      .all(...params, limit, offset).map(row => sourceRecordPreview(JSON.parse(row.body), now));
    return { rows, total, generation, scope: 'stored-source-metadata',
      nextCursor: offset + rows.length < total ? JSON.stringify({ selection, generation, offset: offset + rows.length }) : null };
  }
  record(source, id, revision = null) {
    const key = identity({ source, id });
    if (revision !== null && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) throw new Error('Invalid source revision hash');
    const row = revision === null
      ? this.statement('SELECT body,revision,observed_at FROM records WHERE record_key=?').get(key)
      : this.statement('SELECT body,revision,observed_at FROM revisions WHERE record_key=? AND revision=? ORDER BY seq DESC LIMIT 1').get(key, revision);
    return row ? { ...JSON.parse(row.body), revision: row.revision, observedAt: row.observed_at } : null;
  }
  history(source, id, { after = 0, limit = 20 } = {}) {
    const key = identity({ source, id });
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid source revision page');
    return this.statement('SELECT seq,revision,previous_revision,observed_at FROM revisions WHERE record_key=? AND seq>? ORDER BY seq LIMIT ?')
      .all(key, after, limit).map(row => ({ sequence: row.seq, source, key, revision: row.revision, previousRevision: row.previous_revision, observedAt: row.observed_at }));
  }
}
