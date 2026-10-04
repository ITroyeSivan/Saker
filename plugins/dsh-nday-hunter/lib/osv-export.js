// Recoverable full OSV export baseline and frozen modified-ID selection.
// ZIP blobs remain intact; source JSON is read by a validated byte index.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sourceZipDirectory, sourceZipEntries, readSourceZipEntry } from './source-zip.js';
import { osvCache, exportFile, immutableExport, readExport, exportMetadata, downloadExportChunk, hashExport, verifyExport, exportDigest } from './osv-export-storage.js';
import { fetchSourceJson, osvCandidate, matchesQuery } from './free-sources.js';
import { resolveDshHome } from './home.js';
const schema = 'saker.osv-export/1';
const sha1 = value => createHash('sha1').update(value).digest('hex');
// Upstream database IDs may contain internal spaces. They are opaque values;
// cache paths are content-addressed and API URLs encode the complete ID.
const validId = value => typeof value === 'string' && /^[^/\\\x00-\x1f\x7f]{1,160}$/.test(value) && value === value.trim() && !value.includes('..');
function openManifest(file) {
  const db = new DatabaseSync(file); db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;');
  db.exec('CREATE TABLE IF NOT EXISTS records(ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, entry TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);'); return db;
}
async function manifest(root, snapshot) {
  const object = exportFile(root, snapshot.object.file), pending = exportFile(root, 'm-' + sha1(JSON.stringify([snapshot.object.sha256, snapshot.kind, snapshot.since, snapshot.until])) + '.pending');
  for (const name of [path.basename(pending), path.basename(pending) + '-journal']) {
    const old = exportFile(root, name); if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  const db = openManifest(pending), insert = db.prepare('INSERT INTO records(ordinal,id,entry) VALUES(?,?,?)');
  let count = 0, latest = null;
  try {
    db.exec('BEGIN');
    if (snapshot.kind === 'baseline') {
      const directory = sourceZipDirectory(object);
      for (const entry of sourceZipEntries(object, directory)) {
        const id = entry.name.slice(0, -5); if (!validId(id)) throw new Error('OSV ZIP record identity invalid');
        insert.run(count++, id, JSON.stringify(entry));
        if (count % 10000 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      if (count !== directory.count) throw new Error('OSV ZIP manifest count differs');
    } else {
      const fd = fs.openSync(object, 'r'), chunk = Buffer.alloc(65536); let pendingLine = Buffer.alloc(0), previous = Infinity;
      const upsert = db.prepare('INSERT OR IGNORE INTO records(ordinal,id,entry) VALUES(?,?,?)');
      const line = bytes => {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r$/, ''); if (!text) return false;
        const separator = text.indexOf(','), date = text.slice(0, separator), name = text.slice(separator + 1), modified = Date.parse(date);
        const split = name.lastIndexOf('/'), ecosystem = name.slice(0, split), id = name.slice(split + 1);
        if (separator < 1 || !Number.isFinite(modified) || modified > previous || split < 1 || ecosystem.includes('..') || /[\\\x00-\x1f]/.test(ecosystem) || !validId(id)) throw new Error('OSV modified index identity or reverse chronology invalid');
        previous = modified; if (latest === null) latest = modified;
        if (modified < Date.parse(snapshot.since)) return true;
        if (modified <= Date.parse(snapshot.until)) { const result = upsert.run(count, id, JSON.stringify({ modified: date, path: name })); if (result.changes) count++; }
        return false;
      };
      try {
        let size, done = false;
        while (!done && (size = fs.readSync(fd, chunk, 0, chunk.length, null))) {
          const bytes = Buffer.concat([pendingLine, chunk.subarray(0, size)]); let start = 0, end;
          while ((end = bytes.indexOf(10, start)) >= 0) { if (end - start > 4096) throw new Error('OSV modified index line exceeds limit'); done = line(bytes.subarray(start, end)); start = end + 1; if (done) break; }
          pendingLine = bytes.subarray(start); if (!done && pendingLine.length > 4096) throw new Error('OSV modified index line exceeds limit');
        }
        if (!done && pendingLine.length) line(pendingLine);
      } finally { fs.closeSync(fd); }
      if (latest === null || Date.parse(snapshot.metadata.updated) < Date.parse(snapshot.since)) throw new Error('OSV modified export has not reached requested start');
    }
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('count', String(count)); db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
  const digest = hashExport(pending), final = exportFile(root, 'manifest-' + digest.sha256 + '.sqlite');
  if (fs.existsSync(final)) { verifyExport(final, digest); fs.unlinkSync(pending); } else fs.renameSync(pending, final);
  return { file: path.basename(final), ...digest, count, coveredUntil: snapshot.kind === 'baseline' ? snapshot.since : new Date(Math.min(Date.parse(snapshot.metadata.updated), Date.parse(snapshot.until))).toISOString() };
}
function archiveCandidate(data, bytes, snapshot, entry, archive) {
  const result = osvCandidate(data);
  return { ...result, advisory: { ...result.advisory, representation: 'original-export-json', sha256: exportDigest(bytes), totalBytes: bytes.length,
    contentAvailable: true, contentArchive: archive, archiveSha256: snapshot.object.sha256, archiveMd5Hash: snapshot.object.md5Hash,
    exportGeneration: snapshot.metadata.generation, archiveEntry: entry } };
}
export async function fetchOsvExportPage(options, fetchImpl = globalThis.fetch) {
  const { since, until, query = '', limit = 50, cursor = null, revision = null, home = resolveDshHome() } = options;
  if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until)) || Date.parse(since) > Date.parse(until) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid OSV synchronization window or size');
  const root = osvCache(home); let state, snapshot;
  if (cursor === null) {
    const kind = revision ? 'incremental' : 'baseline', metadata = await exportMetadata(kind === 'baseline' ? 'all.zip' : 'modified_id.csv', fetchImpl);
    const digest = immutableExport(root, { schema, kind, metadata, since, until, query, limit }); state = { digest, stage: 'download', offset: 0 };
  } else { try { state = JSON.parse(cursor); } catch { throw new Error('Invalid OSV cursor'); } }
  if (!state || !['download', 'records'].includes(state.stage) || !Number.isSafeInteger(state.offset) || state.offset < 0) throw new Error('Invalid OSV cursor');
  snapshot = readExport(root, state.digest);
  if (snapshot.schema !== schema || !['baseline', 'incremental'].includes(snapshot.kind) || snapshot.since !== since || snapshot.until !== until || snapshot.query !== query || snapshot.limit !== limit
    || snapshot.metadata.name !== (snapshot.kind === 'baseline' ? 'all.zip' : 'modified_id.csv')) throw new Error('OSV cursor changed synchronization selection');
  if (state.stage === 'download') {
    const object = await downloadExportChunk(root, snapshot.metadata, state.offset, fetchImpl);
    if (!object.complete) return { rows: [], complete: false, nextCursor: JSON.stringify({ ...state, offset: object.next }), coverage: 'osv-export-download',
      downloadBytes: object.next, downloadTotalBytes: snapshot.metadata.size };
    snapshot = { ...snapshot, object }; snapshot.manifest = await manifest(root, snapshot);
    state = { digest: immutableExport(root, snapshot), stage: 'records', offset: 0 };
  }
  const index = snapshot.manifest;
  if (!index || state.offset > index.count) throw new Error('OSV manifest cursor exceeds record count');
  const file = exportFile(root, index.file); verifyExport(file, index);
  const object = exportFile(root, snapshot.object.file); verifyExport(object, snapshot.object);
  const db = new DatabaseSync(file, { readOnly: true }); let entries;
  try { entries = db.prepare('SELECT ordinal,id,entry FROM records WHERE ordinal>=? ORDER BY ordinal LIMIT ?').all(state.offset, limit); }
  finally { db.close(); }
  if (entries.length !== Math.min(limit, index.count - state.offset)) throw new Error('OSV manifest page is incomplete');
  const rows = [];
  for (const item of entries) {
    let row;
    if (snapshot.kind === 'baseline') {
      const entry = JSON.parse(item.entry), bytes = readSourceZipEntry(object, entry), data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (data.id !== item.id || !Number.isFinite(Date.parse(data.modified))) throw new Error('OSV ZIP source identity or modified time differs');
      row = archiveCandidate(data, bytes, snapshot, entry, object);
    } else {
      const signal = JSON.parse(item.entry), data = await fetchSourceJson(`https://api.osv.dev/v1/vulns/${encodeURIComponent(item.id)}`,
        { label: 'OSV incremental record', attempts: 1, preferRaw: true, maxBytes: 32 * 1024 * 1024 }, fetchImpl);
      if (data.id !== item.id || !Number.isFinite(Date.parse(data.modified)) || Date.parse(data.modified) < Date.parse(signal.modified)) throw new Error('OSV current record has not reached modified index revision');
      row = osvCandidate(data, home);
    }
    if (matchesQuery([row.id, row.title, row.summary, ...(row.products ?? [])].join(' '), query)) rows.push(row);
  }
  const next = state.offset + entries.length, complete = next === index.count;
  return { rows, complete, nextCursor: complete ? null : JSON.stringify({ ...state, offset: next }), coveredUntil: index.coveredUntil,
    downloadBytes: snapshot.object.size, downloadTotalBytes: snapshot.metadata.size,
    coverage: snapshot.kind === 'baseline' ? 'pinned-full-osv-export-query' : 'pinned-osv-modified-id-window-query', total: index.count,
    ...(complete ? { completedRevision: sha1(state.digest), baselineComplete: snapshot.kind === 'baseline' } : {}),
    limitation: snapshot.kind === 'baseline' ? '全量范围为固定官方导出；保留起始水位以继续重叠增量，不声称导出和实时API是同一全局事务。'
      : '索引固定版本；逐条保留完整当前API记录和摘要，当前记录可能比索引新。删除来源记录的语义由OSV上游决定。' };
}
