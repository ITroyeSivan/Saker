// Offline, bounded source indexing. Text hints never establish live routes or impact.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readTaskContext } from './task-context.js';
import { readTaskPolicy } from './task-policy.js';
export const BUSINESS_MATERIAL_SCHEMA = `CREATE TABLE IF NOT EXISTS business_materials (
 session_id TEXT NOT NULL, id TEXT NOT NULL, source_url TEXT NOT NULL, digest TEXT NOT NULL,
 record TEXT NOT NULL, PRIMARY KEY(session_id,id));`;
const hash = value => createHash('sha256').update(value).digest('hex');
const safeUrl = value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('plain HTTP source URL required');
  url.hash = ''; return url;
};
const redact = value => value.replace(/((?:authorization|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["'])[^"']+/gi, '$1[redacted]')
  .replace(/([?&](?:token|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|signature)=)[^&#\s"'`]+/gi, '$1[redacted]');
const displayUrl = value => redact(String(value));
// Mask before selecting excerpts: an excerpt can start halfway through a secret.
// Preserve character offsets so line numbers and source positions remain accurate.
const maskSource = value => value
  .replace(/((?:authorization|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["'])([^"']+)/gi,
    (_, prefix, secret) => prefix + '*'.repeat(secret.length))
  .replace(/([?&](?:token|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|signature)=)([^&#\s"'`]+)/gi,
    (_, prefix, secret) => prefix + '*'.repeat(secret.length));
function rebaseHints(record, sourceUrl) {
  return { coverage: record.coverage, hints: record.hints.map(hint => {
    const { candidateUrl, inSourceOrigin, assumption, ...rest } = hint;
    if (!['call', 'route', 'chunk', 'source-map'].includes(hint.kind) || hint.value.includes('${') || hint.value.includes('[redacted]')) return rest;
    try {
      const url = safeUrl(new URL(hint.value, sourceUrl).href);
      return { ...rest, candidateUrl: displayUrl(url.href), inSourceOrigin: url.origin === new URL(sourceUrl).origin,
        assumption: 'resolved against source URL; client baseURL and live use remain unverified' };
    } catch { return rest; }
  }) };
}
export function extractBusinessHints(source, sourceUrl) {
  const masked = maskSource(source);
  const hints = [], seen = new Set(), lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const lineAt = offset => { let low = 0, high = lineStarts.length; while (low + 1 < high) { const mid = (low + high) >> 1; if (lineStarts[mid] <= offset) low = mid; else high = mid; } return low + 1; };
  const add = (kind, value, offset, confidence = 'text-hint') => {
    const key = JSON.stringify([kind, value]); if (seen.has(key) || hints.length >= 120) return;
    seen.add(key);
    let candidateUrl, inSourceOrigin;
    if (['call', 'route', 'chunk', 'source-map'].includes(kind) && value && !value.includes('${')) {
      try { const resolved = new URL(value, sourceUrl); if (['http:', 'https:'].includes(resolved.protocol) && !resolved.username && !resolved.password) { candidateUrl = resolved.href; inSourceOrigin = resolved.origin === new URL(sourceUrl).origin; } } catch { /* unresolved literal */ }
    }
    hints.push({ kind, value: redact(value).slice(0, 300), line: lineAt(offset), offset, confidence,
      snippet: masked.slice(Math.max(0, offset - 70), Math.min(source.length, offset + 250)).slice(0, 320),
      ...(candidateUrl ? { candidateUrl: displayUrl(candidateUrl), inSourceOrigin, assumption: 'resolved against source URL; client baseURL and live use remain unverified' } : {}) });
  };
  for (const match of source.matchAll(/\b(?:fetch|axios(?:\.(?:get|post|put|patch|delete|head))?|\$http\.(?:get|post|put|patch|delete))\s*\(\s*(["'`])([^"'`\r\n]{1,400})\1/g)) add('call', match[2], match.index);
  for (const match of source.matchAll(/\b(?:url|path|baseURL)\s*:\s*(["'`])([^"'`\r\n]{1,400})\1/g)) add(match[0].startsWith('baseURL') ? 'client-base' : 'route', match[2], match.index);
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*(["'])([^"'\r\n]{1,300})\1/g)) add('chunk', match[2], match.index);
  for (const match of source.matchAll(/sourceMappingURL\s*=\s*([^\s*]{1,500})/g)) {
    if (match[1].startsWith('data:')) add('source-map', '[inline source map; inspect separately within byte budget]', match.index);
    else add('source-map', match[1], match.index);
  }
  for (const match of source.matchAll(/\b(?:Authorization|refreshToken|accessToken|beforeEach|beforeEnter|roleId|roleid|permission|FormData|multipart|upload|export|download)\b/g)) add('business-clue', match[0], match.index);
  const dynamic = /\b(?:fetch|axios(?:\.[a-z]+)?)\s*\(\s*[^\s"'`]/.test(source) || /\b(?:fetch|axios)\s*\([^\n]{0,160}\$\{/.test(source);
  return { hints, coverage: { parser: 'bounded text extraction; comments and unused code may match', dynamicCallsUnresolved: dynamic,
    capped: hints.length >= 120, liveUseVerified: false, note: 'Not a complete JS audit. Validate relevant call chains and actual requests.' } };
}
function resolveFile(cwd, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('source path required');
  const supplied = value.startsWith('file:') ? fileURLToPath(value) : value;
  const file = fs.realpathSync(path.resolve(cwd, supplied)), root = fs.realpathSync(cwd), relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('source must stay inside the session workspace');
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 512 * 1024) throw new Error('each source must be a file of at most 512KB; split larger sources with a tracked source position');
  return file;
}
export function indexBusinessMaterials(store, sessionId, cwd, input) {
  if (!input || !Array.isArray(input.files) || !input.files.length || input.files.length > 30) throw new Error('provide 1..30 selected source files');
  const context = readTaskContext(store, sessionId), policy = readTaskPolicy(store, sessionId), site = safeUrl(input.site).origin;
  if (!context?.assets.some(asset => asset.inScope && new URL(asset.url).origin === site)) throw new Error('source site must be in current authorized context');
  if (policy?.target && new URL(policy.target).origin !== site) throw new Error('materials cannot expand the current site');
  const prepared = [], existingIds = new Set(store.db.prepare('SELECT id FROM business_materials WHERE session_id=?').all(sessionId).map(row => row.id)); let bytes = 0;
  for (const supplied of input.files) {
    const sourceUrl = safeUrl(supplied.url);
    if (sourceUrl.origin !== site) throw new Error('source belongs to another site; do not mix origins');
    const file = resolveFile(cwd, supplied.path), content = fs.readFileSync(file); bytes += content.length;
    if (bytes > 5 * 1024 * 1024) throw new Error('selected source batch exceeds 5MB');
    const digest = hash(content), id = 'material-' + hash(sourceUrl.href).slice(0, 24);
    const previous = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sessionId, id);
    const cached = previous && JSON.parse(previous.record);
    if (!existingIds.has(id) && existingIds.size >= 200) throw new Error('session material limit is 200 sources; select the relevant files instead of indexing the entire site');
    existingIds.add(id);
    if (cached?.digest === digest) { prepared.push({ record: { ...cached, file }, reused: true }); continue; }
    const sameContent = prepared.find(row => row.record.digest === digest)?.record
      || (() => { const row = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND digest=? LIMIT 1').get(sessionId, digest); return row && JSON.parse(row.record); })();
    prepared.push({ record: { id, sourceUrl: displayUrl(sourceUrl.href), file, digest, bytes: content.length, site,
      originEvidence: 'user-provided URL/file mapping, not a network fetch', ...(sameContent ? rebaseHints(sameContent, sourceUrl.href) : extractBusinessHints(content.toString('utf8'), sourceUrl.href)),
      reusedContent: !!sameContent, indexedAt: Date.now() }, reused: false });
  }
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const { record } of prepared) store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET digest=excluded.digest,record=excluded.record')
      .run(sessionId, record.id, record.sourceUrl, record.digest, JSON.stringify(record));
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return businessMaterialView(store, sessionId, { changedIds: prepared.filter(row => !row.reused).map(row => row.record.id),
    indexed: prepared.filter(row => !row.reused).length, reused: prepared.filter(row => row.reused || row.record.reusedContent).length });
}
export function businessMaterialView(store, sessionId, options = {}) {
  const all = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? ORDER BY rowid').all(sessionId).map(row => JSON.parse(row.record));
  if (options.id) {
    const item = all.find(row => row.id === options.id); if (!item) throw new Error('material not found in current session');
    let current = false; try { current = fs.statSync(item.file).size <= 512 * 1024 && hash(fs.readFileSync(item.file)) === item.digest; } catch { /* original source unavailable */ }
    return { item: { ...item, current }, text: JSON.stringify({ ...item, current }, null, 2) };
  }
  const question = readTaskPolicy(store, sessionId)?.question || '';
  const categories = [ [/教师|员工|人员|档案|teacher|staff|employee/i, /teacher|staff|employee|profile/i], [/权限|角色|登录|凭证|token|auth/i, /role|permission|auth|token|login/i], [/文件|上传|导出|logo|upload|export/i, /file|upload|export|download|logo|multipart/i] ];
  const rows = options.changedIds ? all.filter(row => options.changedIds.includes(row.id)) : all;
  const hints = rows.flatMap(row => row.hints.map(hint => ({ ...hint, materialId: row.id, sourceUrl: row.sourceUrl,
    relevant: categories.some(([q, h]) => q.test(question) && h.test(hint.value)) }))).sort((a, b) => Number(b.relevant) - Number(a.relevant));
  const summary = { operation: options.changedIds ? 'index-selected-files' : 'read-existing-index', indexed: options.indexed ?? 0, reused: options.reused ?? 0, files: all.length, shown: hints.slice(0, 12), omitted: Math.max(0, hints.length - 12),
    unresolved: rows.filter(row => row.coverage.dynamicCallsUnresolved || row.coverage.capped).map(row => row.id),
    detail: 'redteam_context kind=material id=material-ID', note: 'Text clues only; related names do not prove active interfaces or vulnerabilities. Inspect relevant chains, then validate actual requests.' };
  return { ...summary, text: JSON.stringify(summary, null, 2) };
}
export function copySiteMaterials(store, parentId, childId, site) {
  for (const row of store.db.prepare('SELECT record FROM business_materials WHERE session_id=?').all(parentId)) {
    const record = JSON.parse(row.record); if (record.site !== site) continue;
    store.db.prepare('INSERT OR REPLACE INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)').run(childId, record.id, record.sourceUrl, record.digest, row.record);
  }
}
