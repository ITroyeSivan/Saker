// 复测记录（v6 第 9.2 节）：**新建版本记录**，引用原发现与本次 execution；不覆盖历史发现。
// 结论只有三种：仍可复现 / 本次未复现 / 无法确认。
// 登录失败、不可达、接口迁移和服务端错误都只能记「无法确认」——不能拿"没打中"冒充"已修复"。
import { randomUUID } from 'node:crypto';
import { readExecutionReceipt, requireFreshExecutions } from './execution-receipts.js';
import { policyRecord } from './task-policy-record.js';

export const RETEST_SCHEMA = `CREATE TABLE IF NOT EXISTS finding_retests (
 session_id TEXT NOT NULL, id TEXT NOT NULL, finding_id TEXT NOT NULL, at INTEGER NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(session_id,id)
);
CREATE INDEX IF NOT EXISTS idx_finding_retests ON finding_retests(session_id,finding_id,at);
-- 「复测中」的可观察状态（v6 第 5.3 节）：复核/复测消息投递成功就登记，写入复测记录或人工标记后清除。
CREATE TABLE IF NOT EXISTS finding_verify_runs (
 session_id TEXT NOT NULL, finding_id TEXT NOT NULL, at INTEGER NOT NULL,
 PRIMARY KEY(session_id, finding_id)
);`;

export const RETEST_VERDICTS = ['still-reproducible', 'not-reproduced', 'inconclusive'];
export const RETEST_LABELS = { 'still-reproducible': '仍可复现', 'not-reproduced': '本次未复现', inconclusive: '无法确认' };

/** 登记「复测已发起」；同一发现只留最近一次。 */
export function markVerifyStarted(store, sessionId, findingId, at = Date.now()) {
  const id = String(findingId || '').trim();
  if (!sessionId || !id) return;
  store.db.prepare('INSERT INTO finding_verify_runs(session_id,finding_id,at) VALUES(?,?,?) '
    + 'ON CONFLICT(session_id,finding_id) DO UPDATE SET at=excluded.at').run(sessionId, id, at);
}

/** 复测有结论（写了复测记录或人工标记）就清掉「复测中」。 */
export function clearVerifyStarted(store, sessionId, findingId) {
  const id = String(findingId || '').trim();
  if (!sessionId || !id) return;
  store.db.prepare('DELETE FROM finding_verify_runs WHERE session_id=? AND finding_id=?').run(sessionId, id);
}

/** 本会话正在复测的发现（finding id → 发起时间）。老库没这张表时按"没有"处理。 */
export function listVerifyStarted(store, sessionId) {
  const out = new Map();
  if (!sessionId) return out;
  let rows = [];
  try { rows = store.db.prepare('SELECT finding_id,at FROM finding_verify_runs WHERE session_id=?').all(sessionId); }
  catch { return out; }
  for (const row of rows) out.set(String(row.finding_id), Number(row.at) || 0);
  return out;
}

const text = (value, label, max = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + ' 需要非空文本（不超过 ' + max + ' 字）');
  return value.trim();
};

const sameOrigin = (a, b) => {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
};

/** 目标实例校验：finding.target 不是 URL 时无法比对，按"未声明"处理。 */
function requireFindingTarget(store, sessionId, findingId, execution, role) {
  const target = String(store.db.prepare('SELECT target FROM findings WHERE session_id=? AND id=?').get(sessionId, findingId)?.target || '');
  if (!target) return;
  let declared;
  try { declared = new URL(target).origin; } catch { return; }
  let actual;
  try { actual = new URL(execution.endpoint).origin; } catch { actual = ''; }
  if (declared !== actual) throw new Error(role + '回执与当前发现的目标实例不一致，请重新执行本次复测');
}

/** 记录一次复测。返回新版本记录；不修改原发现。
 * 时间由服务器决定；测试需要固定时钟时只走 options.now 显式注入，不接受请求体覆盖留档时间。 */
export function recordRetest(store, sessionId, input = {}, options = {}) {
  const findingId = text(input.findingId, 'findingId', 200);
  if (!store.db.prepare('SELECT id FROM findings WHERE session_id=? AND id=?').get(sessionId, findingId)) throw new Error('复测只能针对本会话已有的发现');
  const verdict = String(input.verdict || '');
  if (!RETEST_VERDICTS.includes(verdict)) throw new Error('复测结论只能是仍可复现、本次未复现或无法确认');
  const note = text(input.note, 'note', 4000);
  const executionId = input.executionId === undefined || input.executionId === '' ? '' : text(input.executionId, 'executionId', 200);
  const controlExecutionId = input.controlExecutionId === undefined || input.controlExecutionId === '' ? '' : text(input.controlExecutionId, 'controlExecutionId', 200);
  let execution = null;
  if (executionId) {
    try { execution = readExecutionReceipt(store, sessionId, executionId); }
    catch { throw new Error('复测引用的执行回执不属于本会话'); }
  }
  let control = null;
  if (controlExecutionId) {
    try { control = readExecutionReceipt(store, sessionId, controlExecutionId); }
    catch { throw new Error('正常功能对照回执不属于本会话'); }
  }
  if (verdict === 'still-reproducible' && !execution) throw new Error('仍可复现必须引用本次实际执行回执');
  if (verdict === 'not-reproduced') {
    if (!execution) throw new Error('本次未复现必须引用本次实际执行回执');
    if (!control) throw new Error('本次未复现必须同时引用本次正常功能对照回执（controlExecutionId）：单独一张目标回执不能证明修复');
    if (controlExecutionId === executionId) throw new Error('正常功能对照必须是与目标请求不同的实际执行回执');
    // 没拿到响应、被阻断、服务端错误都说明"这次没验证成"，不是"已修复"。
    if (execution.outcome !== 'response') throw new Error('本次执行结果是 ' + execution.outcome + '：只能记无法确认，不能记本次未复现');
    if (Number(execution.status) >= 500) throw new Error('服务端错误不能证明已修复：只能记无法确认');
    if ([401, 407, 429].includes(Number(execution.status))) throw new Error('登录失效或请求受限不能证明已修复：只能记无法确认');
    requireCurrentRetestExecution(store, sessionId, findingId, control, { role: '正常功能对照' });
    if (control.outcome !== 'response' || Number(control.status) < 200 || Number(control.status) >= 300)
      throw new Error('正常功能对照必须取得 2xx 业务响应，才能证明当前身份和正常功能仍然可用');
    if (!sameOrigin(control.endpoint, execution.endpoint))
      throw new Error('正常功能对照与目标回执不属于同一目标实例，不能证明修复');
    if (control.authContext !== execution.authContext)
      throw new Error('正常功能对照与目标回执身份不一致，不能证明当前身份仍然有效');
  }
  if (execution && verdict !== 'inconclusive') {
    requireCurrentRetestExecution(store, sessionId, findingId, execution);
  }
  const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
  const record = { id: 'retest-' + randomUUID(), findingId, verdict, verdictLabel: RETEST_LABELS[verdict], note,
    executionId, executionOutcome: execution?.outcome || '', executionStatus: execution?.status ?? null,
    controlExecutionId, controlStatus: control?.status ?? null, at: new Date(now).toISOString() };
  store.db.prepare('INSERT INTO finding_retests(session_id,id,finding_id,at,record) VALUES(?,?,?,?,?)')
    .run(sessionId, record.id, findingId, now, JSON.stringify(record));
  // 有结论就不再是「复测中」。
  clearVerifyStarted(store, sessionId, findingId);
  return record;
}

/** Recheck at both recording and the later fixed transition; stored history is not current proof. */
export function requireCurrentRetestExecution(store, sessionId, findingId, execution, { role = '执行' } = {}) {
  if (execution?.current !== true || execution.integrityValid !== true) throw new Error(role + '回执已失效或与当前请求不匹配，请重新执行本次复测');
  if (execution.outcome !== 'response') throw new Error(role + '没有取得目标响应：只能记无法确认');
  requireFreshExecutions([execution]);
  requireFindingTarget(store, sessionId, findingId, execution, role);
  const roundStarted = Number(policyRecord(store, sessionId)?.startedAt);
  const verifyStarted = listVerifyStarted(store, sessionId).get(findingId) || 0;
  if (!Number.isFinite(Date.parse(execution.startedAt))
    || Date.parse(execution.startedAt) < Math.max(Number.isFinite(roundStarted) ? roundStarted : 0, verifyStarted))
    throw new Error(role + '回执早于本轮任务或本次复测，请重新执行');
}

export function requireCurrentRepairRetest(store, sessionId, findingId) {
  const latest = listRetests(store, sessionId, findingId, { limit: 1 })[0];
  if (latest?.verdict !== 'not-reproduced' || !latest.executionId)
    throw new Error('fixed 需要最新的「本次未复现」记录；最新结论为无法确认或仍可复现时，请重新复测');
  if (!latest.controlExecutionId) throw new Error('本次未复现缺少正常功能对照回执，不能标记已修复；请重新完成带对照的复测');
  const execution = readExecutionReceipt(store, sessionId, latest.executionId);
  requireCurrentRetestExecution(store, sessionId, findingId, execution);
  if ([401, 407, 429].includes(Number(execution.status)) || Number(execution.status) >= 500)
    throw new Error('本次执行未能确认正常功能：只能记无法确认，不能标记已修复');
  const control = readExecutionReceipt(store, sessionId, latest.controlExecutionId);
  requireCurrentRetestExecution(store, sessionId, findingId, control, { role: '正常功能对照' });
  if (control.outcome !== 'response' || Number(control.status) < 200 || Number(control.status) >= 300)
    throw new Error('正常功能对照已经失效或不再是 2xx，不能标记已修复；请重新完成带对照的复测');
  if (!sameOrigin(control.endpoint, execution.endpoint) || control.authContext !== execution.authContext)
    throw new Error('正常功能对照与目标回执不再同源同身份，不能标记已修复；请重新完成带对照的复测');
}

/** 读取某发现的复测历史（新→旧）。坏行隔离，只读。 */
export function listRetests(store, sessionId, findingId, { limit = 20 } = {}) {
  const rows = store.db.prepare('SELECT record FROM finding_retests WHERE session_id=? AND finding_id=? ORDER BY at DESC, rowid DESC').all(sessionId, String(findingId || ''));
  const out = [];
  for (const row of rows) {
    try { out.push(JSON.parse(row.record)); } catch { /* 坏行隔离 */ }
  }
  return out.slice(0, Math.max(1, Math.floor(Number(limit) || 20)));
}

/** 列表用的摘要：次数 + 最新结论。 */
export function retestSummary(store, sessionId, findingId) {
  const rows = listRetests(store, sessionId, findingId, { limit: 1 });
  if (!rows.length) return null;
  return { count: store.db.prepare('SELECT count(*) AS n FROM finding_retests WHERE session_id=? AND finding_id=?').get(sessionId, String(findingId)).n,
    latest: { verdict: rows[0].verdict, verdictLabel: rows[0].verdictLabel || RETEST_LABELS[rows[0].verdict] || rows[0].verdict, at: rows[0].at } };
}
