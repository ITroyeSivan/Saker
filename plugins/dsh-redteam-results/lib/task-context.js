// Session-local evidence shared by planning tools; this never executes requests.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkedKey, normalizeCheck } from './checked.js';
import { activeMethodPackage } from './method-packages.js';
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u001f]/.test(value)) throw new Error(label + ' must be a bounded nonempty string');
  return value.trim();
};
function endpoint(value) {
  const url = new URL(required(value, 'endpoint'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid HTTP endpoint');
  url.hash = ''; return url.href;
}
export function normalizeTaskContext(input, { legacyRead = false, methodStore } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('task context must be an object');
  const context = { assets: input.assets ?? [], checks: input.checks ?? [], requests: input.requests ?? [], methods: input.methods ?? [], maxSupplementAttempts: input.maxSupplementAttempts ?? 2 };
  for (const field of ['assets', 'checks', 'requests', 'methods']) {
    if (!Array.isArray(context[field]) || context[field].length > 2000) throw new Error(field + ' must be an array of at most 2000 items');
  }
  if (!Number.isInteger(context.maxSupplementAttempts) || context.maxSupplementAttempts < 0 || context.maxSupplementAttempts > 10) throw new Error('invalid supplement budget');
  const assets = new Map();
  context.assets = context.assets.map(asset => {
    const id = required(asset.id, 'asset.id'), url = endpoint(asset.url);
    if (assets.has(id)) throw new Error('duplicate asset');
    const row = { ...asset, id, url }; assets.set(id, row); return row;
  });
  const requestKeys = new Set(), methodKeys = new Set();
  context.requests = context.requests.map(request => {
    const row = { ...request, id: required(request.id, 'request.id'), endpoint: endpoint(request.endpoint),
      authContext: required(request.authContext, 'request.authContext'), revision: required(request.revision, 'request.revision') };
    const key = JSON.stringify([row.id, row.revision]);
    if (requestKeys.has(key)) throw new Error('duplicate request revision'); requestKeys.add(key);
    for (const field of ['request', 'response']) {
      if (row[field] !== undefined && (typeof row[field] !== 'string' || Buffer.byteLength(row[field]) > 65536)) throw new Error(field + ' must be text of at most 64KB');
    }
    if (row.valid === true && (!row.request?.trim() || !row.response?.trim())) throw new Error('valid baseline needs actual request and response');
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
    const row = { ...check, endpoint: endpoint(check.endpoint) };
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
  if (JSON.stringify(context).length > 1024 * 1024) throw new Error('task context exceeds 1MB');
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
  if (!Number.isInteger(offset) || offset < 0 || offset > 2000) throw new Error('invalid index offset');
  const lines = [`资产 ${context.assets.length}；入口检查 ${context.checks.length}；请求 ${context.requests.length}；方法 ${context.methods.length}；索引offset=${offset}`];
  for (const [field, kind] of [['assets', 'asset'], ['requests', 'request'], ['methods', 'method']]) {
    lines.push(`${kind}索引（最多20条；详情用kind/id/version读取）：`);
    for (const row of context[field].slice(offset, offset + 20)) lines.push(JSON.stringify({ id: row.id, version: row.revision || row.version, endpoint: row.endpoint || row.url, authContext: row.authContext, valid: row.valid, reviewed: row.reviewed }));
  }
  return { item: null, text: lines.join('\n') };
}
export function saveTaskContext(store, sessionId, input) {
  required(sessionId, 'sessionId');
  const context = normalizeTaskContext(input, { methodStore: store });
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
      if (content(old) !== content(row)) throw new Error('immutable ' + field + ' content changed; use a new ' + versionField);
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
