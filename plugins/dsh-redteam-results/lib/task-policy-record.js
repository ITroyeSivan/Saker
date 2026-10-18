import { parseRowRecord } from './row-record.js';
export function taskTransaction(store, work) {
  const own = !store.db.isTransaction;
  if (own) store.db.exec('BEGIN IMMEDIATE');
  try { const result = work(); if (own) store.db.exec('COMMIT'); return result; }
  catch (error) { if (own) store.db.exec('ROLLBACK'); throw error; }
}
export function policyRecord(store, sessionId) {
  const row = store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(sessionId);
  if (!row) return null;
  const record = parseRowRecord(row, { table: 'task_policy', id: sessionId });
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error('task_policy 任务记录格式错误：' + sessionId);
  return record;
}
/** Durable ownership includes completed and uncertain purpose activations, not just site workers. */
export function ownedPurposeTasks(store, parentId) {
  return store.db.prepare("SELECT session_id,record FROM task_policy WHERE parent_session=? AND task_kind='purpose'").all(parentId)
    .map(row => ({ childId: row.session_id, ...parseRowRecord(row, { table: 'task_policy', id: row.session_id }) }))
    .filter(row => row.purposeTask === true && row.parentSession === parentId);
}
export function childAllowedTools(store, childId) {
  const policy = policyRecord(store, childId);
  if (policy?.purposeTask === true) return policy.allowedTools ?? [];
  const row = store.db.prepare('SELECT record FROM site_workers WHERE child_id=?').get(childId);
  return row ? (parseRowRecord(row, { table: 'site_workers', id: childId }).allowedTools ?? []) : undefined;
}
export function taskEvent(store, sessionId, revision, kind, record) {
  store.db.prepare('INSERT INTO task_policy_events(session_id,revision,kind,record,created_at) VALUES(?,?,?,?,?)')
    .run(sessionId, revision, kind, JSON.stringify(record), new Date().toISOString());
}
/**
 * 任务事件流（v6 第 9.3 节）：按自增 id 作游标补发，支持去重与乱序保护。
 * 早于当前 policyRev 的事件标为 stale——旧版本结果只作历史，不能覆盖当前状态。
 */
export function listTaskEvents(store, sessionId, { afterCursor = 0, limit = 50 } = {}) {
  if (!Number.isInteger(afterCursor) || afterCursor < 0) throw new Error('事件游标无效');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('事件数量无效');
  const rows = store.db.prepare('SELECT id,revision,kind,record,created_at FROM task_policy_events WHERE session_id=? AND id>? ORDER BY id LIMIT ?')
    .all(sessionId, afterCursor, limit);
  const currentRevision = policyRecord(store, sessionId)?.policyRev ?? 0;
  const events = [];
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(row.record); } catch { continue; } // 坏事件跳过，不阻断补发
    // 任务/工作/执行引用（v6 第 9.3 节）：事件必须能指回它属于哪个任务、哪份工作或哪次执行，
    // 否则补发到客户端只是一串无法归因的状态变化。
    const refs = { task: sessionId, work: detail.workId ?? detail.childId ?? null,
      execution: detail.executionId ?? detail.receiptId ?? null };
    events.push({ cursor: row.id, revision: row.revision, kind: row.kind, detail, refs, at: row.created_at,
      stale: row.revision < currentRevision });
  }
  const last = rows.length ? rows[rows.length - 1].id : afterCursor;
  const remaining = store.db.prepare('SELECT count(*) AS n FROM task_policy_events WHERE session_id=? AND id>?').get(sessionId, last).n;
  return { sessionId, currentRevision, events, nextCursor: last, more: remaining,
    note: '按 cursor 递增补发；重复请求同一 cursor 不会重复返回，stale 事件不得覆盖当前状态。' };
}
/** 会被用户当成「设置」看的字段（v6 第 4.2 节）：变更摘要只覆盖这些，不把进度/用量算进去。 */
const SETTING_LABELS = {
  mode: '方向', interaction: '什么时候问我', reporting: '什么时候汇报', explain: '解释原理',
  workerLimit: '助手上限', allowTargetNetwork: '允许访问网站', readOnly: '不改动网站数据',
  excludedPaths: '排除路径', requestRatePerMinute: '扫描速率', requestConcurrency: '并发上限',
  startMode: '起步方式', workerModel: '助手模型',
  // 预算也算「设置」（v6 第 4.2 节）：聊天里只能收紧，但收紧同样是用户要看懂的变更。
  'budget.toolCalls': '工具调用上限', 'budget.deadline': '时间上限',
};
/** 支持 `budget.toolCalls` 这类嵌套字段；取不到按 null 处理，与"未设置"一致。 */
function fieldValue(record, field) {
  return field.split('.').reduce((value, key) => (value === null || value === undefined ? null : value[key]), record) ?? null;
}
function settingsDiff(previous, next) {
  if (!previous || !next) return [];
  const out = [];
  for (const field of Object.keys(SETTING_LABELS)) {
    const before = fieldValue(previous, field), after = fieldValue(next, field);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    out.push({ field, label: SETTING_LABELS[field], from: before, to: after });
  }
  return out;
}
export function writeTaskPolicy(store, sessionId, record, kind = 'policy-updated', detail = {}) {
  return taskTransaction(store, () => {
    const previous = policyRecord(store, sessionId);
    if (previous && (record.policyRev ?? 0) !== (previous.policyRev ?? 0))
      throw Object.assign(Error('任务状态已变化，请刷新后重试'), { code: 'task-policy-conflict' });
    const policyRev = (previous?.policyRev ?? record.policyRev ?? 0) + 1;
    if (!Number.isSafeInteger(policyRev) || policyRev < 1) throw Error('任务修订号无效');
    const next = { ...record, policyRev };
    store.db.prepare('INSERT INTO task_policy(session_id,parent_session,task_kind,record,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET parent_session=excluded.parent_session,task_kind=excluded.task_kind,record=excluded.record,updated_at=excluded.updated_at')
      .run(sessionId, next.parentSession || '', next.purposeTask === true ? 'purpose' : '', JSON.stringify(next), new Date().toISOString());
    // 设置变更摘要（v6 第 4.2 节）：范围、预算或执行偏好被改动时，把差异记进事件，
    // 界面可以据此在消息旁/概览里回看；没有变化就不记。
    const settings = settingsDiff(previous, next);
    taskEvent(store, sessionId, policyRev, kind, settings.length ? { ...detail, settings } : detail);
    return next;
  });
}
