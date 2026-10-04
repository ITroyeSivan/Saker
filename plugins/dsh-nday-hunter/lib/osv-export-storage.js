import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { fetchSourceJson } from './free-sources.js';
export const OSV_DOWNLOAD_CHUNK = 32 * 1024 * 1024;
const verified = new Map();
export const exportDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export function osvCache(home) {
  const parent = path.resolve(home, 'nday-hunter'), root = path.join(parent, 'source-content', 'osv-export');
  fs.mkdirSync(root, { recursive: true });
  const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('OSV export cache is outside source storage');
  return root;
}
export function exportFile(root, name) {
  if (!/^[a-z0-9.-]+$/.test(name)) throw new Error('Invalid OSV cache name');
  const file = path.join(root, name);
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.realpathSync(path.dirname(file)) !== fs.realpathSync(root))) throw new Error('OSV cache is not a regular local file');
  return file;
}
export function immutableExport(root, value) {
  const bytes = Buffer.from(JSON.stringify(value)), digest = exportDigest(bytes), file = exportFile(root, 'snapshot-' + digest + '.json');
  try { fs.writeFileSync(file, bytes, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || exportDigest(fs.readFileSync(file)) !== digest) throw error; }
  return digest;
}
export function readExport(root, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('Invalid OSV snapshot cursor');
  const file = exportFile(root, 'snapshot-' + digest + '.json');
  if (fs.statSync(file).size > 65536) throw new Error('OSV snapshot exceeds metadata limit');
  const bytes = fs.readFileSync(file); if (exportDigest(bytes) !== digest) throw new Error('OSV snapshot digest differs'); return JSON.parse(bytes);
}
export function hashExport(file) {
  const fd = fs.openSync(file, 'r'), bytes = Buffer.alloc(1024 * 1024), sha = createHash('sha256'), md5 = createHash('md5');
  let length = 0;
  try { let count; while ((count = fs.readSync(fd, bytes, 0, bytes.length, null))) { const chunk = bytes.subarray(0, count); sha.update(chunk); md5.update(chunk); length += count; } }
  finally { fs.closeSync(fd); }
  return { sha256: sha.digest('hex'), md5Hash: md5.digest('base64'), size: length };
}
export function verifyExport(file, expected) {
  const stat = fs.statSync(file, { bigint: true }), fingerprint = [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join(':');
  if (!stat.isFile() || Number(stat.size) !== expected.size) throw new Error('OSV export file size differs');
  if (verified.get(file)?.fingerprint === fingerprint && verified.get(file)?.sha256 === expected.sha256) return;
  const actual = hashExport(file);
  if (actual.sha256 !== expected.sha256 || expected.md5Hash && actual.md5Hash !== expected.md5Hash) throw new Error('OSV export digest differs');
  if (verified.size >= 8) verified.delete(verified.keys().next().value);
  verified.set(file, { fingerprint, sha256: expected.sha256 });
}
export async function exportMetadata(name, fetchImpl) {
  if (!['all.zip', 'modified_id.csv'].includes(name)) throw new Error('Unsupported OSV export object');
  const value = await fetchSourceJson(`https://storage.googleapis.com/storage/v1/b/osv-vulnerabilities/o/${name}?fields=generation,size,md5Hash,updated`,
    { label: 'OSV export metadata', preferRaw: true, attempts: 1, maxBytes: 65536 }, fetchImpl);
  const size = Number(value.size);
  if (!/^\d{1,32}$/.test(value.generation ?? '') || !Number.isSafeInteger(size) || size < 1 || size > 8 * 1024 ** 3
    || typeof value.md5Hash !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(value.md5Hash) || !Number.isFinite(Date.parse(value.updated))) throw new Error('Invalid OSV export metadata');
  return { name, generation: value.generation, size, md5Hash: value.md5Hash, updated: value.updated };
}
async function responseFor(url, start, end, fetchImpl) {
  if (fetchImpl !== globalThis.fetch) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try { const response = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` }, signal: controller.signal }); return { response, stop: () => clearTimeout(timer) }; }
    catch (error) { clearTimeout(timer); throw error; }
  }
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { Range: `bytes=${start}-${end}`, 'accept-encoding': 'identity' }, timeout: 30000 }, response => {
      const headers = { get: name => response.headers[name.toLowerCase()] ?? null };
      resolve({ response: { status: response.statusCode, headers, body: response }, stop: () => request.destroy() });
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('OSV export download stalled')));
  });
}
export async function downloadExportChunk(root, metadata, offset, fetchImpl = globalThis.fetch) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > metadata.size) throw new Error('Invalid OSV download offset');
  const prefix = metadata.name.replace('_', '-') + '-' + metadata.generation;
  const receiptFile = exportFile(root, 'receipt-' + prefix + '.json');
  if (fs.existsSync(receiptFile)) {
    if (fs.statSync(receiptFile).size > 4096) throw new Error('OSV export receipt exceeds limit');
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    if (receipt.size !== metadata.size || receipt.md5Hash !== metadata.md5Hash || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')
      || receipt.file !== 'object-' + receipt.sha256 + (metadata.name.endsWith('.zip') ? '.zip' : '.csv')) throw new Error('OSV export receipt differs from snapshot');
    verifyExport(exportFile(root, receipt.file), receipt);
    return { ...receipt, next: metadata.size, complete: true };
  }
  const file = exportFile(root, prefix + '.pending');
  if (!fs.existsSync(file)) { if (offset) throw new Error('OSV pending export is missing'); fs.writeFileSync(file, '', { flag: 'wx' }); }
  const size = fs.statSync(file).size;
  if (size < offset) throw new Error('OSV pending export is shorter than committed cursor');
  // Trailing bytes from a failed/uncommitted page are discarded on retry.
  if (size > offset) fs.truncateSync(file, offset);
  const end = Math.min(metadata.size - 1, offset + OSV_DOWNLOAD_CHUNK - 1);
  if (offset < metadata.size) {
    const url = `https://storage.googleapis.com/download/storage/v1/b/osv-vulnerabilities/o/${metadata.name}?alt=media&generation=${metadata.generation}`;
    const { response, stop } = await responseFor(url, offset, end, fetchImpl);
    let fd, count = 0;
    try {
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${offset}-${end}/${metadata.size}`
        || response.headers.get('x-goog-generation') !== metadata.generation) throw new Error(`OSV export range or generation differs (HTTP ${response.status})`);
      fd = fs.openSync(file, 'r+');
      const write = bytes => { const chunk = Buffer.from(bytes); if (count + chunk.length > end - offset + 1) throw new Error('OSV range exceeds expected bytes'); fs.writeSync(fd, chunk, 0, chunk.length, offset + count); count += chunk.length; };
      if (response.body?.[Symbol.asyncIterator]) for await (const chunk of response.body) write(chunk);
      else if (response.body?.getReader) {
        const reader = response.body.getReader(); try { for (;;) { const next = await reader.read(); if (next.done) break; write(next.value); } } finally { reader.releaseLock(); }
      } else write(await response.arrayBuffer());
      if (count !== end - offset + 1) throw new Error('OSV range ended before expected byte count');
      fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); stop(); }
  }
  const next = offset < metadata.size ? end + 1 : offset;
  if (next < metadata.size) return { next, complete: false };
  const digest = hashExport(file);
  if (digest.size !== metadata.size || digest.md5Hash !== metadata.md5Hash) throw new Error('OSV complete export MD5 differs');
  const final = exportFile(root, 'object-' + digest.sha256 + (metadata.name.endsWith('.zip') ? '.zip' : '.csv'));
  if (fs.existsSync(final)) { verifyExport(final, digest); fs.unlinkSync(file); } else fs.renameSync(file, final);
  verifyExport(final, digest);
  const receipt = { file: path.basename(final), ...digest };
  try { fs.writeFileSync(receiptFile, JSON.stringify(receipt), { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return { next, complete: true, ...receipt };
}
