// 知识库真实使用记录（v6 第 6.3 节）：只记内容确实交给模型的那一次。
//
// 记录 triggerId、查询、文档/片段位置、提供原因、本次字节数、时间与用途；
// 不保存账号、Cookie、业务响应原文。命中次数不作为效果指标。
import { randomUUID } from 'node:crypto';
import { parseRowRecord } from './row-record.js';

export const KNOWLEDGE_USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_usage (
 session_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(session_id,id));
CREATE INDEX IF NOT EXISTS idx_knowledge_usage_at ON knowledge_usage(session_id, at);
`;

const bounded = (value, label, max) => {
  if (value === undefined || value === null || value === '') return '';
  const text = String(value);
  if (text.length > max) throw new Error(label + '过长');
  return text;
};

/** 片段按字符裁到上限，不抛错：记录的是"实际送出的那一段"，宁可截断也不丢整条。 */
const clipped = (value, max) => {
  if (value === undefined || value === null || value === '') return '';
  const text = String(value);
  return text.length > max ? text.slice(0, max) + '…' : text;
};

const USAGE_STATES = new Set(['prepared', 'reserved', 'dispatched', 'sent', 'failed', 'cancelled']);
const normalizeState = value => USAGE_STATES.has(value) ? value : 'prepared';

function usageRows(store, sessionId) {
  try { return store.db.prepare('SELECT id, record FROM knowledge_usage WHERE session_id=?').all(sessionId); }
  catch { return []; }
}

/**
 * 记录一次知识使用。默认 state=prepared：内容已经准备进入某次请求，但还没有在真实发送边界确认。
 * contentBytes 为实际交给模型的片段字节数；不计 token 估算，也不把“命中”当成“已采用”。
 */
export function recordKnowledgeUsage(store, sessionId, entry = {}) {
  if (!sessionId) throw new Error('sessionId required');
  const record = {
    id: entry.id || 'ku-' + randomUUID(),
    at: Number.isFinite(entry.at) ? entry.at : Date.now(),
    trigger: bounded(entry.trigger, 'trigger', 60) || 'manual',
    query: bounded(entry.query, 'query', 500),
    docPath: bounded(entry.docPath, 'docPath', 500),
    docVersion: bounded(entry.docVersion, 'docVersion', 120),
    chunkId: bounded(entry.chunkId, 'chunkId', 120),
    title: bounded(entry.title, 'title', 200),
    // 实际送入模型的片段（v6 第 6.3 节）：条目列表要能直接看，不用再回原文。
    excerpt: clipped(entry.excerpt, 800),
    reason: bounded(entry.reason, 'reason', 300) || '按需检索',
    contentBytes: Number.isFinite(entry.contentBytes) && entry.contentBytes >= 0 ? Math.floor(entry.contentBytes) : 0,
    source: bounded(entry.source, 'source', 60) || 'knowledge-hub',
    // 片段唯一引用：最终发送块里带 ref=<deliveryId>，只有请求正文确实含这个标记才会绑定。
    deliveryId: bounded(entry.deliveryId, 'deliveryId', 160) || 'kh-' + randomUUID(),
    chunkRange: bounded(entry.chunkRange, 'chunkRange', 200),
    // 生命周期：prepared → reserved → dispatched → sent；取消/失败不冒充已发送。
    state: normalizeState(entry.state),
    requestId: bounded(entry.requestId, 'requestId', 120),
    requestBoundAt: bounded(entry.requestBoundAt, 'requestBoundAt', 40),
    dispatchedAt: bounded(entry.dispatchedAt, 'dispatchedAt', 40),
    sentAt: bounded(entry.sentAt, 'sentAt', 40),
    renderedBytes: Number.isFinite(entry.renderedBytes) && entry.renderedBytes >= 0
      ? Math.floor(entry.renderedBytes) : (Number.isFinite(entry.contentBytes) ? Math.floor(entry.contentBytes) : 0),
  };
  store.db.prepare('INSERT INTO knowledge_usage(session_id,id,at,record) VALUES(?,?,?,?)')
    .run(sessionId, record.id, record.at, JSON.stringify(record));
  return record;
}

/**
 * 在模型准入时，只绑定「请求正文确实包含 ref=<deliveryId>」的 prepared 记录。
 * 这一步只到 reserved，不把预留当成已发送；真正发送边界再转 dispatched/sent。
 */
export function bindKnowledgeUsageForRequest(store, sessionId, requestId, options, at = Date.now()) {
  const id = bounded(requestId, 'requestId', 120);
  if (!sessionId || !id) return 0;
  let requestText = '';
  try { requestText = typeof options === 'string' ? options : JSON.stringify(options ?? ''); } catch { return 0; }
  let bound = 0;
  for (const row of usageRows(store, sessionId)) {
    let record;
    try { record = parseRowRecord({ record: row.record }, { table: 'knowledge_usage', id: row.id }); } catch { continue; }
    if (record.state !== 'prepared' || record.requestId || !record.deliveryId) continue;
    if (!requestText.includes('ref=' + record.deliveryId)) continue;
    record.state = 'reserved';
    record.requestId = id;
    record.requestBoundAt = new Date(Number.isFinite(at) ? at : Date.now()).toISOString();
    store.db.prepare('UPDATE knowledge_usage SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(record), sessionId, row.id);
    bound += 1;
  }
  return bound;
}

/** 兼容旧调用：没有 options 时不再整批绑定，避免把预留误当已发送。 */
export function bindPendingKnowledgeUsage(store, sessionId, requestId, at = Date.now(), options) {
  return bindKnowledgeUsageForRequest(store, sessionId, requestId, options, at);
}

/** 模型调用已派发（还没有真实 wire 证据）：reserved → dispatched。 */
export function markKnowledgeUsageDispatched(store, requestId, at = Date.now()) {
  return transitionKnowledgeUsage(store, requestId, ['reserved'], 'dispatched', at, 'dispatchedAt');
}

/** 真实发送边界已授权：reserved/dispatched → sent。 */
export function markKnowledgeUsageSent(store, requestId, at = Date.now()) {
  return transitionKnowledgeUsage(store, requestId, ['reserved', 'dispatched'], 'sent', at, 'sentAt');
}

/** 预留被取消或派发前停止：回到 prepared，允许后续请求重新绑定。 */
export function releaseKnowledgeUsageReservation(store, requestId) {
  const id = bounded(requestId, 'requestId', 120);
  if (!id) return 0;
  let released = 0;
  try {
    const rows = store.db.prepare('SELECT session_id,id,record FROM knowledge_usage').all();
    for (const row of rows) {
      let record;
      try { record = parseRowRecord({ record: row.record }, { table: 'knowledge_usage', id: row.id }); } catch { continue; }
      if (record.requestId !== id || !['reserved', 'dispatched'].includes(record.state)) continue;
      record.state = 'prepared';
      record.requestId = '';
      record.requestBoundAt = '';
      record.dispatchedAt = '';
      store.db.prepare('UPDATE knowledge_usage SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(record), row.session_id, row.id);
      released += 1;
    }
  } catch { return 0; }
  return released;
}

function transitionKnowledgeUsage(store, requestId, fromStates, toState, at, timeField) {
  const id = bounded(requestId, 'requestId', 120);
  if (!id) return 0;
  let changed = 0;
  try {
    const rows = store.db.prepare('SELECT session_id,id,record FROM knowledge_usage').all();
    for (const row of rows) {
      let record;
      try { record = parseRowRecord({ record: row.record }, { table: 'knowledge_usage', id: row.id }); } catch { continue; }
      if (record.requestId !== id || !fromStates.includes(record.state)) continue;
      record.state = toState;
      record[timeField] = new Date(Number.isFinite(at) ? at : Date.now()).toISOString();
      store.db.prepare('UPDATE knowledge_usage SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(record), row.session_id, row.id);
      changed += 1;
    }
  } catch { return 0; }
  return changed;
}

export function listKnowledgeUsage(store, sessionId, { page = 1, pageSize = 50 } = {}) {
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Error('页号无效');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('每页数量无效');
  // 列表列有正文的条目，并带 deliveryState；UI 只把 sent 当作“已发送”，
  // prepared/reserved/dispatched 只显示待发送或发送未核实。
  // 自动补充会额外写一行 contentBytes=0 的事实记账行用于去重，那不是"查阅的漏洞资料"。
  // 同一毫秒内按插入顺序（rowid）倒序，避免随机 UUID 让“最近优先”偶发乱序。
  const rows = store.db.prepare('SELECT id,at,record FROM knowledge_usage WHERE session_id=? ORDER BY at DESC, rowid DESC').all(sessionId);
  const delivered = [];
  for (const row of rows) {
    try {
      const item = parseRowRecord(row, { table: 'knowledge_usage', id: row.id });
      if ((item.contentBytes ?? 0) > 0) delivered.push({ ...item, deliveryState: item.state ?? 'legacy' });
    } catch { /* 坏记录隔离 */ }
  }
  const total = delivered.length;
  const items = delivered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  // v6 第 6.2 节：没有可用的 token 计量器时，上限按 UTF-8 字节控制，必须**明确标出来**，
  // 不能让人把这里的字节数当成 token。这一行是用户唯一能看到计量口径的地方。
  return { page, pageSize, total, items, more: Math.max(0, total - (page - 1) * pageSize - items.length),
    note: '按 UTF-8 字节控制（当前没有可用的 token 计量器，不冒充精确 token）；'
      + 'deliveryState=sent 表示已在真实发送边界确认；prepared/reserved/dispatched 尚未确认送达。' };
}
