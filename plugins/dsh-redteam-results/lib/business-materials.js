// Offline, bounded source indexing. Text hints never establish live routes or impact.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readTaskContext } from './task-context.js';
import { readTaskPolicy } from './task-policy.js';
import { parseRowRecord } from './row-record.js';
import { taskScopeAllowsUrl } from './task-scope.js';
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
  if (!policy || !taskScopeAllowsUrl(policy, site)) throw new Error('materials cannot expand the current task scope');
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
  // `updatedIds`：本次真正写进库的材料 id（同一 URL 换了内容 = 同一 id 的新版本）。
  // 调用方按它唤醒依赖该资料的工作（v6 第 8.3 节）；只被复用/未变的材料不算事件。
  const updatedIds = prepared.filter(row => !row.reused).map(row => row.record.id);
  return { ...businessMaterialView(store, sessionId, { changedIds: updatedIds,
    indexed: updatedIds.length, reused: prepared.filter(row => row.reused || row.record.reusedContent).length }), updatedIds };
}
export function businessMaterialView(store, sessionId, options = {}) {
  const all = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? ORDER BY rowid').all(sessionId)
    .map(row => parseRowRecord(row, { table: 'business_materials', id: sessionId }));
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
  // v6 第 5.4.1 节：新一批材料的变化通知按 **480 UTF-8 字节** 封顶（无 tokenizer 时的降级口径），
  // 超过就少给线索、只留计数与游标，不把正文堆进通知；关键字段（总数/类型/相关引用）优先保留。
  const summary = { operation: options.changedIds ? 'index-selected-files' : 'read-existing-index',
    // v6 第 5.4.1 节：无 tokenizer 时的 480 字节上限必须**标近似**，不能让人当成精确 token。
    // 这个字段最后才删（见下面的收缩顺序），否则一超限就先把口径说明丢掉。
    unit: 'bytes-approx',
    indexed: options.indexed ?? 0, reused: options.reused ?? 0, files: all.length, hints: hints.length,
    relevant: hints.filter(hint => hint.relevant).slice(0, 3).map(hint => ({ materialId: hint.materialId, value: String(hint.value).slice(0, 60) })),
    unresolved: rows.filter(row => row.coverage.dynamicCallsUnresolved || row.coverage.capped).map(row => row.id),
    next: hints.length ? 'redteam_context search=<关键词> 取定位结果；kind=material id=<materialId> 读单个材料' : null,
    detail: 'redteam_context kind=material id=material-ID',
    note: '线索不等于接口或漏洞；须核对实际请求后再下结论。' };
  let text = JSON.stringify(summary);
  const bytes = () => Buffer.byteLength(text, 'utf8');
  // 收缩顺序：先丢解释文案，再少给线索，再折叠未解析列表，最后丢续读提示；`unit` 不参与收缩。
  if (bytes() > 480) { delete summary.note; text = JSON.stringify(summary); }
  while (bytes() > 480 && summary.relevant.length) { summary.relevant.pop(); text = JSON.stringify(summary); }
  if (bytes() > 480 && summary.unresolved.length) { summary.unresolvedCount = summary.unresolved.length; summary.unresolved = []; text = JSON.stringify(summary); }
  if (bytes() > 480) { delete summary.detail; text = JSON.stringify(summary); }
  return { ...summary, text };
}
export function copySiteMaterials(store, parentId, childId, site) {
  for (const row of store.db.prepare('SELECT record FROM business_materials WHERE session_id=?').all(parentId)) {
    const record = JSON.parse(row.record); if (record.site !== site) continue;
    store.db.prepare('INSERT OR REPLACE INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)').run(childId, record.id, record.sourceUrl, record.digest, row.record);
  }
}
