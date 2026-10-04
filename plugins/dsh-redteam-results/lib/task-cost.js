// Only accounting metadata from the official session feed; no message bodies,
// credentials, request headers or estimated model prices are stored here.
import { siteWorkerRows } from './site-workers.js';
export const TASK_COST_SCHEMA = `CREATE TABLE IF NOT EXISTS task_cost_events (
 session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL,
 kind TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(session_id,seq));`;
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
const backfilled = new WeakMap();
export function captureTaskCost(store, session, event) {
  if (!session?.id || !Number.isSafeInteger(event?.seq) || !Number.isFinite(event.time)
    || !['assistant/message', 'assistant/attempt', 'tool/call', 'turn/start', 'turn/end'].includes(event.type)) return;
  const usage = event.data?.usage;
  const record = event.type.startsWith('turn/') ? { turn: event.data?.turn ?? null } : event.type === 'tool/call' ? {} : Object.fromEntries(fields.map(key =>
    [key, Number.isFinite(usage?.[key]) && usage[key] >= 0 ? usage[key] : null]));
  store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?) ON CONFLICT(session_id,seq) DO UPDATE SET record=excluded.record')
    .run(session.id, event.seq, event.time, event.type, JSON.stringify(record));
}
export function taskCostOverview(ctx, store, sessionId, since = 0) {
  const ids = [sessionId, ...siteWorkerRows(store, sessionId).map(row => row.childId)];
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
    const messages = saved.filter(row => ['assistant/message','assistant/attempt'].includes(row.kind)).map(row => JSON.parse(row.record));
    const starts=new Map(), intervals=[];
    for(const event of all){const turn=JSON.parse(event.record).turn;if(event.kind==='turn/start')starts.set(turn,event.at);else if(event.kind==='turn/end'&&starts.has(turn)){const start=starts.get(turn);starts.delete(turn);if(event.at>=since)intervals.push([Math.max(start,since),event.at]);}}
    for(const start of starts.values())intervals.push([Math.max(start,since),Date.now()]);
    return { sessionId: id, role: id === sessionId ? 'main' : 'child', available: saved.length > 0 || !!(session && (session.eventAt || Array.isArray(session.events))),
      modelCalls: messages.length, toolCalls: saved.filter(row => row.kind === 'tool/call').length,
      unknownUsageCalls: messages.filter(row => row.totalTokens === null).length,
      intervals,
      ...Object.fromEntries(fields.map(key => [key, messages.some(row => row[key] !== null)
        ? messages.reduce((total, row) => total + (row[key] ?? 0), 0) : null])) };
  });
  const intervals=rows.flatMap(row=>row.intervals).sort((a,b)=>a[0]-b[0]), merged=[];
  for(const interval of intervals){const last=merged.at(-1);if(last&&interval[0]<=last[1])last[1]=Math.max(last[1],interval[1]);else merged.push([...interval]);}
  return { source: 'official-session-events', scope: since ? 'current-round' : 'session-and-owned-children',
    sessions: rows.map(({intervals,...row})=>row), unavailableSessions: rows.filter(row => !row.available).length,
    elapsedModelMs: intervals.length ? merged.reduce((n,[start,end])=>n+Math.max(0,end-start),0) : null,
    modelCalls: rows.reduce((n, row) => n + row.modelCalls, 0), toolCalls: rows.reduce((n, row) => n + row.toolCalls, 0),
    unknownUsageCalls: rows.reduce((n, row) => n + row.unknownUsageCalls, 0),
    ...Object.fromEntries(fields.map(key => [key, rows.some(row => row[key] !== null)
      ? rows.reduce((total, row) => total + (row[key] ?? 0), 0) : null])),
    limit: 'Token sums include cache. Unknown usage and unavailable sessions remain visible. Background title requests and monetary prices are not included.' };
}
