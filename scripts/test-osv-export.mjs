import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { sourceCrc32, sourceZipDirectory, sourceZipEntries, readSourceZipEntry } from '../plugins/dsh-nday-hunter/lib/source-zip.js';
import { downloadExportChunk, OSV_DOWNLOAD_CHUNK, osvCache } from '../plugins/dsh-nday-hunter/lib/osv-export-storage.js';
import { fetchOsvExportPage } from '../plugins/dsh-nday-hunter/lib/osv-export.js';
import { attachApiDocument } from '../plugins/dsh-nday-hunter/lib/api-source-document.js';
import { fetchOsv } from '../plugins/dsh-nday-hunter/lib/free-sources.js';
import { runCollector, readSourceContent, readSourceHistory, querySourceCandidates, writeCollectorConfig } from '../plugins/dsh-nday-hunter/lib/source-pipeline.js';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'osv-export-')), now = Date.parse('2026-10-02T00:00:00Z');
const md5 = bytes => createHash('md5').update(bytes).digest('base64');
const document = (id, extra = {}) => ({ id, modified: '2026-10-01T00:00:00Z', published: '2020-01-01T00:00:00Z', summary: id,
  affected: [{ package: { ecosystem: 'npm', name: 'fixture' }, versions: ['1.0.0'] }], ...extra });
function zip(items, zip64 = false) {
  const local = [], central = []; let offset = 0;
  for (const [name, content] of items) {
    const bytes = Buffer.from(content), compressed = deflateRawSync(bytes), label = Buffer.from(name), crc = sourceCrc32(bytes), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(label.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(label.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, label, compressed); central.push(directory, label); offset += header.length + label.length + compressed.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(zip64 ? 65535 : items.length, 8); end.writeUInt16LE(zip64 ? 65535 : items.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  if (!zip64) return Buffer.concat([...local, index, end]);
  const extended = Buffer.alloc(56), locator = Buffer.alloc(20); extended.writeUInt32LE(0x06064b50); extended.writeBigUInt64LE(44n, 4); extended.writeUInt16LE(45, 12); extended.writeUInt16LE(45, 14);
  extended.writeBigUInt64LE(BigInt(items.length), 24); extended.writeBigUInt64LE(BigInt(items.length), 32); extended.writeBigUInt64LE(BigInt(index.length), 40); extended.writeBigUInt64LE(BigInt(offset), 48);
  locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + index.length), 8); locator.writeUInt32LE(1, 16);
  return Buffer.concat([...local, index, extended, locator, end]);
}
const requests = []; let archive = zip(Array.from({ length: 25 }, (_, i) => [`OSV-${i}.json`, JSON.stringify(document('OSV-' + i))]), true);
let csv = '2026-10-01T12:00:00Z,npm/OSV-0\n2026-10-01T12:00:00Z,PyPI/OSV-0\n2026-10-01T11:00:00Z,npm/OSV-new\n2020-01-01T00:00:00Z,npm/old\n';
let badRecord = false, generation = '100', rangeBroken = false;
const fakeFetch = async (url, options = {}) => {
  const parsed = new URL(url); requests.push({ url: String(url), range: options.headers?.Range });
  if (parsed.pathname.startsWith('/storage/v1/')) {
    const bytes = parsed.pathname.endsWith('all.zip') ? archive : Buffer.from(csv);
    return new Response(JSON.stringify({ generation, size: String(bytes.length), md5Hash: md5(bytes), updated: '2026-10-02T00:00:00Z' }));
  }
  if (parsed.pathname.includes('/download/storage/')) {
    const bytes = parsed.pathname.endsWith('all.zip') ? archive : Buffer.from(csv), match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'x-goog-generation': rangeBroken ? 'wrong' : parsed.searchParams.get('generation') } });
  }
  if (parsed.hostname === 'api.osv.dev') {
    const id = decodeURIComponent(parsed.pathname.split('/').pop()); if (badRecord && id === 'OSV-new') return new Response('{}', { status: 503 });
    return new Response(JSON.stringify(document(id, { modified: '2026-10-01T13:00:00Z', ...(id === 'OSV-0' ? { withdrawn: '2026-10-01T12:30:00Z' } : {}) })));
  }
  throw new Error('Unexpected request: ' + url);
};
let failures = 0;
async function check(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failures++; console.log('FAIL ' + name + ': ' + error.stack); } }
try {
  await check('Large OSV originals retain every byte while OSV and NVD capacity limits remain distinct', async () => {
    const data = document('OSV-large', { details: 'x'.repeat(17 * 1024 * 1024) }), original = JSON.stringify(data);
    const file = path.join(temp, 'large.zip'); fs.writeFileSync(file, zip([['OSV-large.json', original]]));
    const entry = [...sourceZipEntries(file, sourceZipDirectory(file))][0];
    assert.equal(readSourceZipEntry(file, entry).toString('utf8'), original);
    assert.equal(attachApiDocument({ id: data.id }, data, 'osv').advisory.totalBytes, Buffer.byteLength(original));
    const fetched = await fetchOsv({ id: data.id, fetchImpl: async () => new Response(original) });
    assert.equal(fetched[0].advisory.totalBytes, Buffer.byteLength(original));
    assert.throws(() => attachApiDocument({ id: data.id }, data, 'nvd-cve-2.0'), /exceeds 8 MiB/);
    assert.throws(() => attachApiDocument({ id: data.id }, { ...data, details: 'x'.repeat(32 * 1024 * 1024) }, 'osv'), /exceeds 32 MiB/);
    const corrupted = Buffer.from(fs.readFileSync(file)); corrupted.writeUInt32LE((entry.crc32 ^ 1) >>> 0, entry.directoryOffset + 16);
    fs.writeFileSync(file, corrupted); const changed = [...sourceZipEntries(file, sourceZipDirectory(file))][0];
    assert.throws(() => readSourceZipEntry(file, changed), /CRC|checksum/i);
  });
  await check('OSV ZIP64 deflated JSON retains full original bytes without filesystem extraction', () => {
    const file = path.join(temp, 'fixture.zip'); fs.writeFileSync(file, archive); const directory = sourceZipDirectory(file), entries = [...sourceZipEntries(file, directory)];
    assert.equal(directory.count, 25); assert.equal(entries.length, 25); assert.deepEqual(JSON.parse(readSourceZipEntry(file, entries[24])), document('OSV-24'));
    const bad = Buffer.from(archive); bad[31] ^= 1; fs.writeFileSync(file, bad); assert.throws(() => readSourceZipEntry(file, entries[0]), /identity differs/);
    fs.writeFileSync(file, zip([['../OSV-0.json', '{}']])); assert.throws(() => [...sourceZipEntries(file, sourceZipDirectory(file))], /flat JSON/);
  });
  const home = path.join(temp, 'collector'); writeCollectorConfig({ enabled: true, sources: ['osv'], limit: 3, maxPagesPerRun: 1 }, home);
  await check('OSV full baseline spans every page and keeps source bytes in one pinned archive', async () => {
    let result = await runCollector({}, { home, now, fetchImpl: fakeFetch }); assert.equal(result.sources[0].status, 'partial'); assert.equal(result.checkpoints.osv.watermark, null);
    generation = '101';
    for (let i = 0; i < 20 && result.checkpoints.osv.window; i++) result = await runCollector({}, { home, now, fetchImpl: fakeFetch });
    assert.equal(result.ok, true); assert.equal(result.checkpoints.osv.status, 'complete'); assert.equal(result.recordCount, 25);
    assert.equal(result.checkpoints.osv.watermark, new Date(now - 30 * 86400000).toISOString()); assert.equal(result.nextDueAt, new Date(now + 60000).toISOString());
    assert.equal(requests.filter(row => new URL(row.url).pathname.startsWith('/storage/v1/') && row.url.includes('all.zip')).length, 1);
    const body = readSourceContent('osv', 'OSV-24', {}, home); assert.equal(body.representation, 'original-export-json'); assert.deepEqual(JSON.parse(body.text), document('OSV-24'));
    const list = querySourceCandidates({ query: 'OSV-24' }, home); assert(!JSON.stringify(list).includes('contentArchive')); assert.equal(list.rows.length, 1);
  });
  await check('OSV modified index deduplicates ecosystems and retries a failed page without advancing watermark', async () => {
    badRecord = true; const before = readSourceHistory('osv', 'OSV-0', {}, home).length;
    const failed = await runCollector({}, { home, now: now + 60000, fetchImpl: fakeFetch }); assert.equal(failed.ok, false); assert.equal(failed.checkpoints.osv.watermark, new Date(now - 30 * 86400000).toISOString());
    assert.equal(readSourceHistory('osv', 'OSV-0', {}, home).length, before); badRecord = false;
    const resumed = await runCollector({ noCache: true }, { home, now: now + 120000, fetchImpl: fakeFetch });
    assert.equal(resumed.ok, true); assert.equal(resumed.sources[0].count, 2); assert.equal(resumed.recordCount, 26);
    assert.equal(resumed.checkpoints.osv.watermark, '2026-10-02T00:00:00.000Z');
    assert.equal(JSON.parse(readSourceContent('osv', 'OSV-0', {}, home).text).withdrawn, '2026-10-01T12:30:00Z');
    assert.deepEqual(JSON.parse(readSourceContent('osv', 'OSV-0', { revision: readSourceHistory('osv', 'OSV-0', {}, home)[0].revision }, home).text), document('OSV-0'));
  });
  await check('OSV frozen manifest rejects changed window malformed chronology and archive corruption', async () => {
    const options = { home: path.join(temp, 'selection'), since: '2026-09-01T00:00:00Z', until: '2026-10-02T00:00:00Z', limit: 1 };
    const first = await fetchOsvExportPage(options, fakeFetch); await assert.rejects(fetchOsvExportPage({ ...options, limit: 2, cursor: first.nextCursor }, fakeFetch), /changed synchronization/);
    const source = first.rows[0].advisory.contentArchive; const saved = fs.readFileSync(source); const changed = Buffer.from(saved); changed[50] ^= 1; fs.writeFileSync(source, changed);
    await assert.rejects(fetchOsvExportPage({ ...options, cursor: first.nextCursor }, fakeFetch), /digest differs/); fs.writeFileSync(source, saved);
    csv = '2026-10-01T00:00:00Z,npm/OSV-0\n2026-10-02T00:00:00Z,npm/OSV-new\n'; generation = '102';
    await assert.rejects(fetchOsvExportPage({ ...options, revision: 'baseline' }, fakeFetch), /reverse chronology/);
    rangeBroken = true; generation = '103'; await assert.rejects(fetchOsvExportPage({ ...options, home: path.join(temp, 'range') }, fakeFetch), /generation differs/); rangeBroken = false;
  });
  await check('OSV chunk retry drops uncommitted trailing bytes and never loads the entire download', async () => {
    const root = osvCache(path.join(temp, 'chunks')), payload = Buffer.alloc(OSV_DOWNLOAD_CHUNK + 9, 65), metadata = { name: 'all.zip', generation: '500', size: payload.length, md5Hash: md5(payload) };
    const fetchChunk = async (url, options) => { const [start, end] = options.headers.Range.slice(6).split('-').map(Number); return new Response(payload.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'x-goog-generation': '500' } }); };
    const first = await downloadExportChunk(root, metadata, 0, fetchChunk); assert.equal(first.complete, false); assert.equal(first.next, OSV_DOWNLOAD_CHUNK);
    // More stale bytes than the final chunk: overwriting alone must not pass.
    fs.appendFileSync(path.join(root, 'all.zip-500.pending'), Buffer.alloc(100, 66)); const second = await downloadExportChunk(root, metadata, first.next, fetchChunk);
    assert.equal(second.complete, true); assert.equal(fs.statSync(path.join(root, second.file)).size, payload.length);
    const repeated = await downloadExportChunk(root, metadata, first.next, async () => { throw Error('receipt should avoid network'); }); assert.equal(repeated.sha256, second.sha256);
  });
  await check('OSV opaque upstream IDs with internal spaces retain exact identity and original content', async () => {
    generation = '104'; const id = 'SUSE-SU-403 Forbidden-1'; archive = zip([[id + '.json', JSON.stringify(document(id))]]);
    const result = await fetchOsvExportPage({ home: path.join(temp, 'spaced-id'), since: '2026-09-01T00:00:00Z', until: '2026-10-02T00:00:00Z', limit: 1 }, fakeFetch);
    assert.equal(result.rows[0].id, id); assert.equal(result.rows[0].advisory.archiveEntry.name, id + '.json'); assert.equal(result.complete, true);
  });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
process.exitCode = failures ? 1 : 0;
