// Bounded, redacted visible message and tool-result text plus accounting metadata
// from the official session feed. Hidden reasoning, credentials, request headers
// and estimated model prices are not stored here.
import { siteWorkerRows } from './site-workers.js';
import { ownedPurposeTasks, policyRecord } from './task-policy-record.js';
import { redactText } from './redaction.js';
export const TASK_COST_SCHEMA = `CREATE TABLE IF NOT EXISTS task_cost_events (
 session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL,
 kind TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(session_id,seq));`;
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
const backfilled = new WeakMap();
// The admission ledger observes each managed dispatch, including provider retries and
// auxiliary streams. It replaces (never adds to) session message accounting for that
// session after its first managed dispatch. Earlier historical calls still come
// from session events, so starting a task does not erase prior session usage.
function dispatchUsage(store, sessionId, since) {
  const calls = store.db.prepare('SELECT record FROM task_model_calls WHERE session_id=? ORDER BY rowid').all(sessionId)
    .map(row => JSON.parse(row.record)).filter(row => row.at >= since && ['dispatched', 'unknown', 'settled'].includes(row.state));
  if (!calls.length) return null;
  const known = calls.filter(row => row.state === 'settled' && row.usage);
  return { accountingSource: 'model-dispatch-ledger', firstDispatchAt: Math.min(...calls.map(row => row.at)), modelCalls: calls.length,
    attemptCalls: calls.filter(row => row.state === 'unknown').length,
    auxiliaryCalls: calls.filter(row => row.purpose && row.purpose !== 'conversation').length,
    unknownUsageCalls: calls.length - known.length,
    ...Object.fromEntries(fields.map(key => [key, known.some(row => Number.isFinite(row.usage[key]))
      ? known.reduce((total, row) => total + (row.usage[key] ?? 0), 0) : null])) };
}
export function captureTaskCost(store, session, event) {
  if (!session?.id || !Number.isSafeInteger(event?.seq) || !Number.isFinite(event.time)
    || !['assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'turn/start', 'turn/end'].includes(event.type)) return;
  const chunks = (event.data?.stream || []).filter(item => item?.type === 'chunk').map(item => item.chunk);
  const usage = event.data?.usage ?? chunks.findLast(item => item?.type === 'usage')?.usage;
  const finish = chunks.findLast(item => item?.type === 'finish')?.reason;
  const callState = event.data?.interrupted === true || finish?.kind === 'aborted' ? 'interrupted'
    : finish?.kind === 'error' ? 'failed' : event.type === 'assistant/message' ? 'returned'
      : finish ? 'returned' : 'unknown';
  const toolCallId = event.type === 'tool/call' ? event.data?.callId : event.type === 'tool/result' ? event.data?.message?.toolCallId : undefined;
  const toolName = event.type === 'tool/call' ? event.data?.name : event.type === 'tool/result' ? event.data?.message?.name : undefined;
  const usageRecord = Object.fromEntries(fields.map(key =>
    [key, Number.isFinite(usage?.[key]) && usage[key] >= 0 ? usage[key] : null]));
  const contentText = value => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value
      .filter(item => item?.type === 'text' || (item?.type === undefined && (item?.text !== undefined || item?.content !== undefined)))
      .map(item => item?.text || item?.content || '').join('')
    return value && typeof value === 'object' ? String(value.text || value.content || '') : ''
  };
  const rawMessageText = redactText(contentText(event.data?.message?.content ?? event.data?.content ?? ''));
  const messageText = rawMessageText.slice(0, 200000);
  const record = event.type.startsWith('turn/')
    ? { turn: event.data?.turn ?? null }
    : event.type === 'tool/call'
      ? { toolName: String(toolName ?? ''), callId: String(toolCallId ?? '') }
      : event.type === 'tool/result'
        ? { toolName: String(toolName ?? ''), callId: String(toolCallId ?? ''),
            ok: event.data?.message?.isError !== true,
            error: event.data?.error ? String(event.data.error.reason || event.data.error.code || event.data.error.name || '').slice(0, 200) : '',
            output: messageText }
        : event.type === 'assistant/message'
          ? { turn: event.data?.turn ?? null, step: event.data?.step ?? null, messageId: String(event.data?.message?.id ?? ''),
              text: messageText, preview: messageText.slice(0, 4000), truncated: rawMessageText.length > messageText.length,
              originalChars: [...rawMessageText].length, includedChars: [...messageText].length,
              omittedFrom: rawMessageText.length > messageText.length ? [...messageText].length + 1 : null,
              omittedTo: rawMessageText.length > messageText.length ? [...rawMessageText].length : null,
              originalBytes: Buffer.byteLength(rawMessageText), callState, ...usageRecord }
          : event.type === 'assistant/attempt'
            ? { turn: event.data?.turn ?? null, step: event.data?.step ?? null, callState,
                streamCount: Array.isArray(event.data?.stream) ? event.data.stream.length : 0, ...usageRecord }
            : usageRecord;
  store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?) ON CONFLICT(session_id,seq) DO UPDATE SET record=excluded.record')
    .run(session.id, event.seq, event.time, event.type, JSON.stringify(record));
}

export function listOrdinaryReports(store, sessionId, { limit = 20 } = {}) {
  const take = Math.max(1, Math.min(50, Number(limit) || 20));
  const roundStartedAt = Number(policyRecord(store, String(sessionId || ''))?.startedAt) || 0;
  const rows = store.db.prepare('SELECT seq,at,kind,record FROM task_cost_events WHERE session_id=? ORDER BY seq ASC')
    .all(String(sessionId || '')).filter(row => row.at >= roundStartedAt);
  const completedTurns = new Set();
  for (const row of rows) {
    if (row.kind !== 'turn/end') continue;
    try {
      const turn = JSON.parse(row.record)?.turn;
      if (Number.isSafeInteger(turn)) completedTurns.add(turn);
    } catch { /* a damaged event cannot prove a completed turn */ }
  }
  const byTurn = new Map();
  for (const row of rows) {
    if (row.kind !== 'assistant/message') continue;
    try {
      const record = JSON.parse(row.record);
      const text = String(record.text || '').trim();
      if (!text || record.callState !== 'returned') continue;
      const key = Number.isSafeInteger(record.turn)
        ? 'turn:' + record.turn
        : record.messageId ? 'message:' + record.messageId : 'seq:' + row.seq;
      const report = {
        id: 'report-' + row.seq, seq: row.seq, at: row.at, turn: record.turn,
        messageId: record.messageId || '', text,
        preview: record.preview || text.slice(0, 4000),
        truncated: record.truncated === true,
        originalChars: record.originalChars ?? text.length,
        includedChars: record.includedChars ?? text.length,
        omittedRange: record.truncated === true
          ? { from: record.omittedFrom ?? text.length + 1, to: record.omittedTo ?? null }
          : null,
        complete: record.truncated !== true,
        source: record.truncated === true ? 'stored-prefix' : 'session-visible-text',
        callState: record.callState || '',
        inProgress: Number.isSafeInteger(record.turn) && !completedTurns.has(record.turn),
      };
      const prior = byTurn.get(key);
      if (!prior || row.seq > prior.seq) byTurn.set(key, report);
    } catch { /* ignore damaged event text */ }
  }
  const reports = [...byTurn.values()].sort((left, right) => right.seq - left.seq);
  const finalReports = reports.filter(report => !report.inProgress);
  const selected = finalReports.length ? finalReports : reports.slice(0, 1);
  return selected.slice(0, take);
}
export function taskCostOverview(ctx, store, sessionId, since = 0) {
  const round = policyRecord(store, sessionId)?.startedAt;
  const ids = [...new Set([sessionId, ...siteWorkerRows(store, sessionId).map(row => row.childId),
    ...ownedPurposeTasks(store, sessionId).filter(row => !since || row.parentRound === round).map(row => row.childId)])];
  let sessions;
  try { sessions = ctx.sessions || ctx.get?.('sessions'); } catch { /* explicit unavailable count below */ }
  const rows = ids.map(id => {
    const session = sessions?.get(id);
    if (session) {
      if (!backfilled.has(store)) backfilled.set(store, new Map());
      const cursors = backfilled.get(store), length = Number.isSafeInteger(session.seq) ? session.seq : (session.events?.length || 0), previous = cursors.get(id) || 0;
      for (let index = previous <= length ? previous : 0; index < length; index++) {
        if (session.isOwnSeq && !session.isOwnSeq(index)) continue;
        captureTaskCost(store, session, session.eventAt ? session.eventAt(index) : session.events[index]);
      }
      cursors.set(id, length);
    }
    const all = store.db.prepare('SELECT kind,record,at FROM task_cost_events WHERE session_id=? ORDER BY seq').all(id), saved = all.filter(row=>row.at>=since);
    const dispatch = dispatchUsage(store, id, since);
    const fallback = dispatch ? saved.filter(row => row.at < dispatch.firstDispatchAt) : saved;
    const messages = fallback.filter(row => row.kind === 'assistant/message').map(row => JSON.parse(row.record));
    const attempts = fallback.filter(row => row.kind === 'assistant/attempt').map(row => JSON.parse(row.record));
    const fallbackUsage = Object.fromEntries(fields.map(key => [key, [...messages, ...attempts].some(row => row[key] !== null)
      ? [...messages, ...attempts].reduce((total, row) => total + (row[key] ?? 0), 0) : null]));
    const unknownFallback = [...messages, ...attempts].filter(row => row.totalTokens === null).length;
    const starts=new Map(), intervals=[];
    for(const event of all){const turn=JSON.parse(event.record).turn;if(event.kind==='turn/start')starts.set(turn,event.at);else if(event.kind==='turn/end'&&starts.has(turn)){const start=starts.get(turn);starts.delete(turn);if(event.at>=since)intervals.push([Math.max(start,since),event.at]);}}
    for(const start of starts.values())intervals.push([Math.max(start,since),Date.now()]);
    return { sessionId: id, role: id === sessionId ? 'main' : 'child', available: !!dispatch || saved.length > 0 || !!(session && (session.eventAt || Array.isArray(session.events))),
      accountingSource: 'official-session-events', auxiliaryCalls: null,
      modelCalls: messages.length + attempts.length, attemptCalls: attempts.length, toolCalls: saved.filter(row => row.kind === 'tool/call').length,
      unknownUsageCalls: unknownFallback,
      intervals,
      ...fallbackUsage, ...(dispatch ? { ...dispatch,
        modelCalls: dispatch.modelCalls + messages.length + attempts.length,
        attemptCalls: dispatch.attemptCalls + attempts.length,
        unknownUsageCalls: dispatch.unknownUsageCalls + unknownFallback,
        ...Object.fromEntries(fields.map(key => [key, dispatch[key] !== null || fallbackUsage[key] !== null
          ? (dispatch[key] ?? 0) + (fallbackUsage[key] ?? 0) : null])),
      } : {}) };
  });
  const intervals=rows.flatMap(row=>row.intervals).sort((a,b)=>a[0]-b[0]), merged=[];
  for(const interval of intervals){const last=merged.at(-1);if(last&&interval[0]<=last[1])last[1]=Math.max(last[1],interval[1]);else merged.push([...interval]);}
  return { source: rows.some(row => row.accountingSource === 'model-dispatch-ledger') ? 'model-dispatch-ledger-with-session-fallback' : 'official-session-events', scope: since ? 'current-round' : 'session-and-owned-children',
    sessions: rows.map(({intervals,...row})=>row), unavailableSessions: rows.filter(row => !row.available).length,
    elapsedModelMs: intervals.length ? merged.reduce((n,[start,end])=>n+Math.max(0,end-start),0) : null,
    modelCalls: rows.reduce((n, row) => n + row.modelCalls, 0), attemptCalls: rows.reduce((n, row) => n + row.attemptCalls, 0), toolCalls: rows.reduce((n, row) => n + row.toolCalls, 0),
    unknownUsageCalls: rows.reduce((n, row) => n + row.unknownUsageCalls, 0),
    auxiliaryCalls: rows.some(row => row.auxiliaryCalls !== null) ? rows.reduce((n, row) => n + (row.auxiliaryCalls ?? 0), 0) : null,
    ...Object.fromEntries(fields.map(key => [key, rows.some(row => row[key] !== null)
      ? rows.reduce((total, row) => total + (row[key] ?? 0), 0) : null])),
    limit: 'Token sums include cache. Managed dispatches include retries and auxiliary streams with a session ID; session events are a fallback, never added twice. Unknown usage, streams without task ownership and monetary prices remain unverified.' };
}
