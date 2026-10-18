// 执行记录页（v6 第 5.3 节）：只列真实发生的调用、时间、成功/失败/未知与用量。
//
// 不保存第二份请求原文：原文字节仍在测试资料里，这里只保留 requestId:revision 引用与回执 ID。
// 摘要来自 host 捕获的执行回执；用量来自 task_cost_events（只读计数，不含消息正文）。
import { parseRowRecord } from './row-record.js';
import { readTaskContext } from './task-context.js';
import { readTaskPolicy } from './task-policy.js';

const RESULTS = new Set(['all', 'returned', 'failed', 'unknown']);

/**
 * 调用状态（v6 第 8.2 节）：已返回 / 失败 / 取消 / 结果未知。
 * 「未派发 / 已派发」属于准入与预留账本，不写进执行回执，这里不编造。
 */
export function callStateOf(outcome) {
  if (outcome === 'interrupted') return 'cancelled';
  if (outcome === 'response' || outcome === 'redirect-not-followed' || outcome === 'response-limit') return 'returned';
  if (outcome === 'timeout' || outcome === 'transport-error') return 'failed';
  return 'unknown';
}

/** 执行回执的调用结果分类：已返回 / 失败 / 结果未知。成功的一次交换不等于影响成立。 */
function resultOf(outcome) {
  if (outcome === 'response' || outcome === 'redirect-not-followed' || outcome === 'response-limit') return 'returned';
  if (outcome === 'timeout' || outcome === 'transport-error') return 'failed';
  return 'unknown';
}

function costUsage(store, sessionId) {
  const rows = store.db.prepare('SELECT kind,record FROM task_cost_events WHERE session_id=?').all(sessionId);
  let toolCalls = 0, modelCalls = 0, unknownUsageCalls = 0;
  let attemptCalls = 0;
  for (const row of rows) {
    if (row.kind === 'tool/call') { toolCalls += 1; continue; }
    if (row.kind === 'assistant/message') {
      modelCalls += 1;
      try { if (JSON.parse(row.record).totalTokens === null) unknownUsageCalls += 1; } catch { /* 坏用量行不影响计数 */ }
    } else if (row.kind === 'assistant/attempt') {
      modelCalls += 1;
      attemptCalls += 1;
      try { if (JSON.parse(row.record).totalTokens === null) unknownUsageCalls += 1; } catch { /* 坏用量行不影响计数 */ }
    }
  }
  return { toolCalls, modelCalls, attemptCalls, unknownUsageCalls };
}

/**
 * 执行台账：按时间倒序分页列出本会话的执行回执，并提供结果分类计数与用量摘要。
 * result 过滤为 all/returned/failed/unknown。
 */
export function executionLedger(store, sessionId, options = {}) {
  const result = options.result ?? 'all';
  if (!RESULTS.has(result)) throw new Error('执行结果筛选只能是全部、已返回、失败或结果未知');
  const page = options.page ?? 1, pageSize = options.pageSize ?? 50;
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Error('页号无效');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('每页数量无效');

  const all = [];
  // 身份引用（v6 第 8.1 节）：回执只带 requestId:revision，身份从本任务的请求记录里按 id 取，不复制秘密。
  const context = readTaskContext(store, sessionId);
  const requestById = new Map((context?.requests || []).map((request) => [String(request.id), request]));
  // 任务引用（v6 第 8.1 节）：回执按完成时间落在哪一轮任务里匹配；匹配不到就落到当前轮。
  // channel 就是回执自带的 source（HTTP 适配器写 host-http-execution），不另造一个字段。
  const policy = readTaskPolicy(store, sessionId);
  const rounds = (() => { try { return store.db.prepare('SELECT started_at, record FROM task_rounds WHERE session_id=? ORDER BY started_at').all(sessionId); } catch { return []; } })();
  const taskIdFor = (atIso) => {
    const fallback = policy?.startedAt ? sessionId + ':' + policy.startedAt : '';
    const at = Date.parse(String(atIso || ''));
    if (!Number.isFinite(at)) return fallback;
    for (const row of rounds) {
      let endedAt = Infinity;
      try { endedAt = Number(JSON.parse(row.record || '{}').endedAt) || Infinity; } catch { /* 坏行按未结束处理 */ }
      const from = Number(row.started_at) || 0;
      if (at >= from && at <= endedAt) return sessionId + ':' + from;
    }
    return fallback;
  };
  for (const row of store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? ORDER BY rowid DESC').all(sessionId)) {
    let record;
    try { record = parseRowRecord(row, { table: 'execution_receipts', id: sessionId }); } catch { continue; } // 坏回执隔离
    if (!record || typeof record !== 'object') continue;
    const bucket = resultOf(record.outcome);
    let path = '';
    try { path = new URL(record.endpoint).pathname; } catch { /* endpoint 已在校验时保证合法 */ }
    all.push({ id: record.id, at: record.completedAt || record.startedAt || null, source: record.source || 'host-http-execution',
      kind: 'http', callId: String(record.callId || ''),
      target: record.endpoint || '', host: (() => { try { return new URL(record.endpoint).hostname; } catch { return ''; } })(), path,
      hypothesisId: record.hypothesisId || '', requestRef: record.requestId ? record.requestId + ':' + record.requestRevision : '',
      taskId: taskIdFor(record.completedAt || record.startedAt),
      identity: (() => { const request = requestById.get(String(record.requestId || '')); return request ? String(request.authContext || '') : ''; })(),
      outcome: record.outcome || '', status: record.status ?? null, attempts: record.requestAttempts ?? null,
      callState: callStateOf(record.outcome),
      elapsedMs: record.elapsedMs ?? null, result: bucket, impactVerified: record.impactVerified === true });
  }
  // 统一执行列表（R06）：HTTP 回执之外，把官方 session 的工具调用与模型尝试也列出来。
  // redteam_execution 的 HTTP 回执已经单独列出，避免同一次调用算两条。
  const toolCalls = new Map(), toolResults = new Map(), modelMessages = [], modelAttempts = [];
  try {
    for (const row of store.db.prepare('SELECT seq,at,kind,record FROM task_cost_events WHERE session_id=? ORDER BY seq').all(sessionId)) {
      let record = {};
      try { record = JSON.parse(row.record || '{}'); } catch { record = {}; }
      if (row.kind === 'tool/call') {
        const callId = String(record.callId || '');
        if (callId) toolCalls.set(callId, { seq: row.seq, at: row.at, toolName: String(record.toolName || '') });
      } else if (row.kind === 'tool/result') {
        const callId = String(record.callId || '');
        if (callId) toolResults.set(callId, { ok: record.ok !== false, error: String(record.error || '') });
      } else if (row.kind === 'assistant/message') {
        modelMessages.push({ seq: row.seq, at: row.at, record });
      } else if (row.kind === 'assistant/attempt') {
        modelAttempts.push({ seq: row.seq, at: row.at, record });
      }
    }
  } catch { /* 旧库没有该表时保持回执列表 */ }
  const receiptCalls = new Set(all.filter(entry => entry.kind === 'http' && entry.callId).map(entry => entry.callId));
  for (const [callId, call] of toolCalls) {
    const result = toolResults.get(callId), at = new Date(call.at).toISOString();
    if (receiptCalls.has(callId) && result?.ok) continue;
    all.push({ id: 'tool-' + callId, at, source: 'session-tool-call', kind: 'tool',
      target: '', host: '', path: '', hypothesisId: '', requestRef: '', taskId: taskIdFor(at), identity: '',
      outcome: result ? (result.ok ? 'completed' : 'error') : '', status: result ? (result.ok ? 'ok' : 'error') : null,
      attempts: null, callState: result ? (result.ok ? 'returned' : 'failed') : 'unknown', elapsedMs: null,
      result: result ? (result.ok ? 'returned' : 'failed') : 'unknown', impactVerified: false,
      toolName: call.toolName, callId, detail: result?.error || '' });
  }
  for (const message of modelMessages) {
    const at = new Date(message.at).toISOString();
    const state = message.record.callState || 'returned';
    const bucket = state === 'failed' ? 'failed' : state === 'returned' ? 'returned' : 'unknown';
    all.push({ id: 'model-message-' + message.seq, at, source: 'session-model-call', kind: 'model',
      target: '', host: '', path: '', hypothesisId: '', requestRef: '', taskId: taskIdFor(at), identity: '',
      outcome: 'message', status: state, attempts: null, callState: state, elapsedMs: null,
      result: bucket, impactVerified: false, toolName: 'model', callId: '', detail: '', usage: message.record });
  }
  for (const attempt of modelAttempts) {
    const at = new Date(attempt.at).toISOString();
    const state = attempt.record.callState || 'unknown';
    const bucket = state === 'failed' ? 'failed' : state === 'returned' ? 'returned' : 'unknown';
    all.push({ id: 'model-attempt-' + attempt.seq, at, source: 'session-model-call', kind: 'model-attempt',
      target: '', host: '', path: '', hypothesisId: '', requestRef: '', taskId: taskIdFor(at), identity: '',
      outcome: 'attempt', status: state, attempts: null, callState: state, elapsedMs: null,
      result: bucket, impactVerified: false, toolName: 'model', callId: '', detail: '未形成正常模型消息的尝试', usage: attempt.record });
  }
  all.sort((a, b) => (Date.parse(b.at || '') || 0) - (Date.parse(a.at || '') || 0));
  const counts = { all: all.length, returned: 0, failed: 0, unknown: 0 };
  for (const entry of all) counts[entry.result] += 1;
  const filtered = result === 'all' ? all : all.filter(entry => entry.result === result);
  const offset = (page - 1) * pageSize, rows = filtered.slice(offset, offset + pageSize);
  return { result, page, pageSize, total: filtered.length, counts, rows, more: Math.max(0, filtered.length - offset - rows.length),
    usage: costUsage(store, sessionId),
    note: '这里是实际调用记录：HTTP 回执、会话工具调用和模型尝试；请求原文在测试资料页，回执不等于影响成立。' };
}
