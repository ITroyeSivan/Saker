// Session-local evidence shared by planning tools; this never executes requests.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkedKey, normalizeCheck } from './checked.js';
import { activeMethodPackage } from './method-packages.js';
import { taskScopeAllowsAsset } from './task-scope.js';
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u001f]/.test(value)) throw new Error(label + ' must be a bounded nonempty string');
  return value.trim();
};
function endpoint(value, label = 'endpoint') {
  const raw = required(value, label);
  let url;
  try { url = new URL(raw); }
  catch {
    // 实测（用例 J2）：模型会把请求入口写成 /rest/products/search 这类路径，然后在
    // 一句 "Invalid URL" 上反复烧预算。这里直接说清要什么、给个正确例子。
    throw new Error(label + ' 需要完整 HTTP(S) URL（例如 http://127.0.0.1:3000/rest/products/search），不能用 /path 或裸主机名');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid HTTP endpoint');
  url.hash = ''; return url.href;
}
/**
 * 由结构化字段拼出完整 HTTP/1.1 报文（用例 J5 实测：模型自然写 method/endpoint/headers/body，
 * 不会去拼 "\r\n\r\n" 原文；执行层却只认原文）。
 * 返回 '' 表示字段不够，交给上层按原文规则报错。
 */
function normalizeSuppliedHeaders(value) {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) return typeof value === 'object' ? value : null;
  const headers = {}, seen = new Set();
  for (const entry of value) {
    let name, raw;
    if (Array.isArray(entry) && entry.length >= 2) [name, raw] = entry;
    else if (entry && typeof entry === 'object') { name = entry.name; raw = entry.value ?? entry.valueString; }
    else return null;
    if (typeof name !== 'string' || !/^[A-Za-z0-9-]+$/.test(name) || raw === undefined || raw === null) return null;
    const lower = name.toLowerCase();
    if (seen.has(lower)) return null;
    seen.add(lower);
    headers[name] = raw;
  }
  return headers;
}
function composeRequestPacket(row) {
  const method = String(row.method || 'GET').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) return '';
  let endpoint;
  try { endpoint = new URL(String(row.endpoint || '')); } catch { return ''; }
  const target = endpoint.pathname + (endpoint.search || '');
  // 材料导入的 HAR headers 是 [{name,value}]；模型会原样存回上下文。若只接受对象，
  // Cookie/Authorization 会被静默丢掉，执行回执看起来成功却换了身份（E09 实测）。
  const supplied = normalizeSuppliedHeaders(row.headers);
  if (!supplied) return '';
  const lower = new Set(Object.keys(supplied).map(key => key.toLowerCase()));
  const headers = [];
  if (!lower.has('host')) headers.push(['Host', endpoint.host]);
  for (const [key, value] of Object.entries(supplied)) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) return '';
    headers.push([key, String(value).replace(/[\r\n]+/g, ' ')]);
  }
  const body = typeof row.body === 'string' ? row.body : '';
  if (body && !lower.has('content-length')) headers.push(['Content-Length', String(Buffer.byteLength(body))]);
  return method + ' ' + target + ' HTTP/1.1\r\n' + headers.map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n' + body;
}
export function normalizeTaskContext(input, { legacyRead = false, methodStore, scopeOrigin = '', scopePolicy, receiptLookup } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('task context must be an object');
  const context = { assets: input.assets ?? [], checks: input.checks ?? [], requests: input.requests ?? [], methods: input.methods ?? [], maxSupplementAttempts: input.maxSupplementAttempts ?? 2 };
  for (const field of ['assets', 'checks', 'requests', 'methods']) {
    if (!Array.isArray(context[field]) || context[field].length > 10000) throw new Error(field + ' must be an array of at most 10000 items');
  }
  if (!Number.isInteger(context.maxSupplementAttempts) || context.maxSupplementAttempts < 0 || context.maxSupplementAttempts > 10) throw new Error('invalid supplement budget');
  const assets = new Map();
  context.assets = context.assets.map(asset => {
    // 契约字段是 url（完整 HTTP(S) URL）；模型常写成 target。两者指同一件事，接受别名，
    // 别让一次字段名猜测把整个可计量路径卡死。
    const id = required(asset.id, 'asset.id'), url = endpoint(asset.url ?? asset.target, 'asset.url');
    if (assets.has(id)) throw new Error('duplicate asset');
    const row = { ...asset, id, url };
    // 用户在建任务时写的 target 就是本次授权范围：origin 与它一致的资产默认算在范围内，
    // 省掉一次布尔字段猜测；范围外的资产**不**自动标记（不自行扩大范围）。
    if (scopePolicy && row.inScope !== false) row.inScope = taskScopeAllowsAsset(scopePolicy, { url, host: new URL(url).hostname });
    else if (row.inScope === undefined && scopeOrigin && new URL(url).origin === scopeOrigin) row.inScope = true;
    assets.set(id, row); return row;
  });
  const requestKeys = new Set(), methodKeys = new Set();
  context.requests = context.requests.map(request => {
    const row = { ...request, id: required(request.id, 'request.id'), endpoint: endpoint(request.endpoint, 'request.endpoint'),
      authContext: required(request.authContext, 'request.authContext'), revision: required(request.revision, 'request.revision') };
    // 注意：不要在这里注入默认 inputs:[]（J11d 式防御放在消费端 (row.inputs ?? [])）——
    // 补齐字段会改变已保存字节与派生哈希（shared-verification 的核查印章测过这一点）。
    const key = JSON.stringify([row.id, row.revision]);
    if (requestKeys.has(key)) throw new Error('duplicate request revision'); requestKeys.add(key);
    // 缺原文（或给了非字符串）时用结构化字段拼一份；执行层随后仍按完整报文校验。
    if (typeof row.request !== 'string' || !row.request.trim()) {
      const composed = composeRequestPacket(row);
      if (composed) row.request = composed;
    }
    // 用宿主回执回填原文（用例 J8/J9 实测）：模型不该手抄 base64 响应——
    // 给了 responseReceiptId 就按回执的字节回填 request/response，交付证据的逐字比对才能稳定成立。
    // 只有保存路径会传 receiptLookup：读路径（readTaskContext）保持宽松，已回填过的行直接原样返回。
    if (typeof row.responseReceiptId === 'string' && row.responseReceiptId.trim() && typeof receiptLookup === 'function') {
      const receipt = receiptLookup(row.responseReceiptId.trim());
      // 回执是权威：以实际发出的报文与收到的响应为准，不保留模型手写/auto 拼的版本。
      if (receipt.request) row.request = String(receipt.request);
      row.response = String(receipt.responseHead || '') + '\r\n\r\n' + Buffer.from(receipt.responseBodyBase64 || '', 'base64').toString('utf8');
    }
    for (const field of ['request', 'response']) {
      if (row[field] !== undefined && (typeof row[field] !== 'string' || Buffer.byteLength(row[field]) > 65536)) throw new Error(field + ' must be text of at most 64KB');
    }
    if (row.valid === true && (!row.request?.trim() || !row.response?.trim()))
      throw new Error('request ' + row.id + ' 标了 valid:true，但没有真实请求/响应原文。'
        + '顺序是：先用 redteam_execution run 发一次并拿到回执 → 再把该请求标 valid:true 并给 responseReceiptId（宿主会按回执回填 request/response 原文）；'
        + '还没执行过的请求不要写 valid:true，否则整包都会被拒。');
    return row;
  });
  context.methods = context.methods.map(method => {
    const row = { ...method, id: required(method.id, 'method.id'), version: required(method.version, 'method.version') };
    const key = JSON.stringify([row.id, row.version]);
    if (methodKeys.has(key)) throw new Error('duplicate method version'); methodKeys.add(key);
    if (row.packageDigest !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(row.packageDigest)) throw new Error('invalid method package digest');
      const pkg = methodStore ? activeMethodPackage(methodStore, row.packageId || row.id) : null;
      if (row.reviewed === true && (!pkg || pkg.digest !== row.packageDigest || pkg.version !== row.version)) {
        if (legacyRead) row.reviewed = false;
        else throw new Error('reviewed packaged method must reference the active trusted digest and version');
      }
    }
    return row;
  });
  const keys = new Set();
  context.checks = context.checks.map(check => {
    const row = { ...check, endpoint: endpoint(check.endpoint, 'check.endpoint') };
    for (const field of ['assetId', 'entryId', 'methodVersion', 'authContext', 'requestRevision']) row[field] = required(check[field], field);
    const key = checkedKey(row);
    if (keys.has(key)) throw new Error('duplicate check context'); keys.add(key);
    const asset = assets.get(row.assetId);
    if (!asset || new URL(asset.url).origin !== new URL(row.endpoint).origin) throw new Error('check must belong to an observed asset origin');
    if (!Array.isArray(row.conditions)) throw new Error('conditions must be an array');
    for (const condition of row.conditions) {
      required(condition.name, 'condition.name');
      if (!['satisfied', 'not-applicable', 'unknown'].includes(condition.state)) throw new Error('invalid condition state');
      if (condition.state !== 'unknown' && (!Array.isArray(condition.evidenceIds) || !condition.evidenceIds.length)) throw new Error('known condition needs evidence');
    }
    if (row.requestValid === true) {
      const baselines = context.requests.filter(request => request.endpoint === row.endpoint && request.authContext === row.authContext
        && request.revision === row.requestRevision && row.baselineEvidenceIds?.includes(request.id));
      if (baselines.length !== 1 || baselines[0].valid !== true) {
        if (legacyRead) row.requestValid = false;
        else throw new Error('valid check must reference one valid baseline with matching endpoint identity and revision');
      }
    }
    if (row.methodReviewed === true) {
      const method = context.methods.find(method => method.id === (row.methodId || row.entryId) && method.version === row.methodVersion);
      if (method?.reviewed !== true) {
        if (legacyRead) row.methodReviewed = false;
        else throw new Error('reviewed check must reference the exact reviewed method version');
      }
    }
    return row;
  });
  if (JSON.stringify(context).length > 8 * 1024 * 1024) throw new Error('task context exceeds 8MB');
  return context;
}
export function taskContextView(context, selector = {}) {
  if (!context) {
    if (selector.kind !== undefined) throw new Error('record not found in current session');
    return { item: null, text: '本会话尚未保存共享上下文' };
  }
  if (selector.kind !== undefined) {
    const field = { asset: 'assets', request: 'requests', method: 'methods' }[selector.kind];
    if (!field) throw new Error('kind must be asset, request or method');
    required(selector.id, 'id');
    const matches = context[field].filter(row => row.id === selector.id && (selector.version === undefined || (row.revision || row.version) === selector.version));
    if (matches.length !== 1) throw new Error(matches.length ? 'multiple revisions; specify version' : 'record not found in current session');
    return { item: matches[0], text: JSON.stringify(matches[0], null, 2) };
  }
  if (selector.id !== undefined || selector.version !== undefined) throw new Error('detail lookup requires kind and id');
  const offset = selector.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('invalid index offset');
  const lines = [`资产 ${context.assets.length}；入口检查 ${context.checks.length}；请求 ${context.requests.length}；方法 ${context.methods.length}；索引offset=${offset}`];
  for (const [field, kind] of [['assets', 'asset'], ['requests', 'request'], ['methods', 'method']]) {
    lines.push(`${kind}索引（最多20条；详情用kind/id/version读取）：`);
    for (const row of context[field].slice(offset, offset + 20)) lines.push(JSON.stringify({ id: row.id, version: row.revision || row.version, endpoint: row.endpoint || row.url, authContext: row.authContext, valid: row.valid, reviewed: row.reviewed }));
  }
  return { item: null, text: lines.join('\n') };
}
export function saveTaskContext(store, sessionId, input) {
  required(sessionId, 'sessionId');
  // 实测（用例 J10）：模型建完研究方向后再存一次快照，把已经 valid 的基线降级回未验证，
  // 后续成对对照全部失效。同 id+revision 的请求此前已确认、而这次**没写** valid 字段时，
  // 把已观察到的证据字段补回去；显式写 valid:false 仍然尊重（那是明确的降级）。
  const prior = readTaskContext(store, sessionId);
  if (prior && input && Array.isArray(input.requests)) {
    const known = new Map((prior.requests || []).map(row => [JSON.stringify([row.id, row.revision]), row]));
    input = { ...input, requests: input.requests.map(row => {
      const old = known.get(JSON.stringify([row?.id, row?.revision]));
      if (!old || old.valid !== true || row?.valid !== undefined) return row;
      return { ...row, valid: true,
        ...(old.response !== undefined ? { response: old.response } : {}),
        ...(old.responseReceiptId ? { responseReceiptId: old.responseReceiptId } : {}),
        ...(old.kind !== undefined && row.kind === undefined ? { kind: old.kind } : {}),
        ...(Array.isArray(old.inputs) && row.inputs === undefined ? { inputs: old.inputs } : {}) };
    }) };
  }
  // 直接读策略表拿用户设定的 target（不从 task-policy.js import，避免循环依赖）。
  let scopeOrigin = '', scopePolicy = null;
  try {
    const row = store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(sessionId);
    scopePolicy = row ? JSON.parse(row.record) : null;
    const target = scopePolicy?.primaryTarget || '';
    if (target) scopeOrigin = new URL(target).origin;
  } catch { scopeOrigin = ''; }
  const receiptLookup = id => {
    const row = store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?').get(sessionId, id);
    if (!row) throw new Error('responseReceiptId 指向的执行回执不存在：' + id);
    return JSON.parse(row.record);
  };
  const context = normalizeTaskContext(input, { methodStore: store, scopeOrigin, scopePolicy, receiptLookup });
  store.db.exec('BEGIN IMMEDIATE');
  try {
  const previous = readTaskContext(store, sessionId);
  for (const field of ['requests', 'methods']) {
    const versionField = field === 'requests' ? 'revision' : 'version';
    for (const row of context[field]) {
      const archived = store.db.prepare('SELECT record FROM task_context_records WHERE session_id=? AND kind=? AND record_id=? AND version=?')
        .get(sessionId, field, row.id, row[versionField]);
      const old = archived ? JSON.parse(archived.record) : previous?.[field].find(old => old.id === row.id && old[versionField] === row[versionField]);
      if (!old) continue;
      const content = value => {
        if (field === 'requests') return JSON.stringify([value.endpoint, value.authContext, value.request, value.response]);
        const { reviewed, reviewedAt, reviewer, reviewNotes, ...body } = value;
        return JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))));
      };
      // 带 responseReceiptId 的请求：request/response 由宿主回执回填，回填就是把"模型手写"换成
      // "实际发出的字节"，语义没变，因此这一行不做内容不可变校验（回执本身按 id 固定）。
      if (!(field === 'requests' && row.responseReceiptId) && content(old) !== content(row))
        throw new Error('immutable ' + field + ' content changed; use a new ' + versionField);
    }
  }
  for (const field of ['requests', 'methods']) {
    const versionField = field === 'requests' ? 'revision' : 'version';
    for (const row of [...(previous?.[field] ?? []), ...context[field]]) {
      store.db.prepare('INSERT INTO task_context_records (session_id,kind,record_id,version,record) VALUES (?,?,?,?,?) ON CONFLICT(session_id,kind,record_id,version) DO UPDATE SET record=excluded.record')
        .run(sessionId, field, row.id, row[versionField], JSON.stringify(row));
    }
  }
  store.db.prepare('INSERT INTO task_context (session_id,record,updated_at) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record,updated_at=excluded.updated_at')
    .run(sessionId, JSON.stringify(context), new Date().toISOString());
  store.db.exec('COMMIT');
  return context;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
export function readTaskRecord(store, sessionId, kind, id, version) {
  const field = { request: 'requests', method: 'methods' }[kind];
  if (!field) return null;
  for (const [value, label] of [[sessionId, 'sessionId'], [id, 'id'], [version, 'version']]) required(value, label);
  const row = store.db.prepare('SELECT record FROM task_context_records WHERE session_id=? AND kind=? AND record_id=? AND version=?')
    .get(sessionId, field, id, version);
  return row ? JSON.parse(row.record) : null;
}
export function readTaskContext(store, sessionId) {
  required(sessionId, 'sessionId');
  const row = store.db.prepare('SELECT record FROM task_context WHERE session_id=?').get(sessionId);
  return row ? normalizeTaskContext(JSON.parse(row.record), { legacyRead: true, methodStore: store }) : null;
}
export function readSavedVerification(home, sessionId) {
  const unavailable = reason => ({ available: false, reason, context: null, history: [] });
  if (!sessionId) return unavailable('session-unavailable');
  const file = path.join(home, 'redteam-results', 'results.db');
  if (!fs.existsSync(file)) return unavailable('task-store-missing');
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!tables.has('checked_items')) return unavailable('task-store-needs-migration');
    const row = tables.has('task_context') ? db.prepare('SELECT record FROM task_context WHERE session_id=?').get(sessionId) : undefined;
    const context = row ? normalizeTaskContext(JSON.parse(row.record), { legacyRead: true,
      methodStore: tables.has('method_package_active') ? { db } : undefined }) : null;
    const history = db.prepare('SELECT record FROM checked_items WHERE session_id=?').all(sessionId).map(row => normalizeCheck(JSON.parse(row.record)));
    return { available: true, reason: '', context, history };
  } catch { return unavailable('task-store-unreadable'); }
  finally { db?.close(); }
}
