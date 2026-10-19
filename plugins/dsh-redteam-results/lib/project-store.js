// W02：项目场景的最小持久记录。四类记录各用一张小表加 JSON record：
// 运行、文档来源、检查、动作。这里只负责归属、版本和状态转移；
// 文档解析、浏览器执行和连续推进分别放在各自模块，不堆进本文件。
import { randomUUID } from 'node:crypto';
import { taskTransaction, taskEvent } from './task-policy-record.js';

export const PROJECT_RUN_STATES = ['preparing', 'running', 'waiting', 'paused', 'completed', 'cancelled', 'failed'];
export const PROJECT_ACTIVE_STATES = ['preparing', 'running', 'waiting', 'paused'];
export const PROJECT_CHECK_STATES = ['pending', 'running', 'paused', 'ended'];
export const PROJECT_VERDICTS = ['not_found', 'issue', 'needs_check', 'blocked', 'not_applicable'];

const RUN_TRANSITIONS = {
  preparing: ['running', 'waiting', 'paused', 'cancelled', 'failed'],
  running: ['waiting', 'paused', 'completed', 'cancelled', 'failed'],
  waiting: ['preparing', 'paused', 'cancelled', 'failed'],
  paused: ['preparing', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

const nowIso = () => new Date().toISOString();
const text = (value, label, max = 2000) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > max) throw new Error(label + ' 需要非空文本（不超过 ' + max + ' 字）');
  return result;
};
const optionalText = (value, max = 20000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const parse = (row, label) => {
  try {
    const record = JSON.parse(row.record);
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('not an object');
    return record;
  } catch (error) {
    throw new Error(label + ' 记录格式错误：' + (error?.message || error));
  }
};
const conflict = message => Object.assign(new Error(message), { code: 'project-state-conflict' });

export function readProjectRun(store, sessionId, runId) {
  const row = store.db.prepare('SELECT record FROM project_runs WHERE session_id=? AND run_id=?').get(sessionId, String(runId || ''));
  return row ? parse(row, 'project_run') : null;
}

export function activeProjectRun(store, sessionId) {
  const row = store.db.prepare(
    "SELECT record FROM project_runs WHERE session_id=? AND state IN ('preparing','running','waiting','paused') ORDER BY updated_at DESC LIMIT 1",
  ).get(sessionId);
  return row ? parse(row, 'project_run') : null;
}

export function listProjectRuns(store, sessionId, { limit = 50 } = {}) {
  const rows = store.db.prepare('SELECT record FROM project_runs WHERE session_id=? ORDER BY updated_at DESC LIMIT ?')
    .all(sessionId, Math.max(1, Math.min(200, Number(limit) || 50)));
  return rows.map(row => parse(row, 'project_run'));
}

/** 幂等开始：同一会话最多一个活动运行；两个窗口并发时第二个拿到已有运行，不新建执行者。 */
export function createProjectRun(store, sessionId, input = {}) {
  return taskTransaction(store, () => {
    const existing = activeProjectRun(store, sessionId);
    if (existing) return { ...existing, existing: true };
    const runId = 'project-run-' + randomUUID();
    const run = {
      sessionId, runId, state: 'preparing', controlRev: 1,
      policyRev: Number.isSafeInteger(input.policyRev) ? input.policyRev : null,
      question: optionalText(input.question, 600),
      sourceSnapshot: Array.isArray(input.sourceSnapshot) ? input.sourceSnapshot : [],
      currentCheckId: '', blocker: null,
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    store.db.prepare('INSERT INTO project_runs(session_id,run_id,state,control_rev,record,updated_at) VALUES(?,?,?,?,?,?)')
      .run(sessionId, runId, run.state, run.controlRev, JSON.stringify(run), run.updatedAt);
    taskEvent(store, sessionId, run.policyRev ?? 0, 'project-run-created', { runId, state: run.state });
    return { ...run, existing: false };
  });
}

export function transitionProjectRun(store, sessionId, runId, nextState, expectedControlRev, detail = {}) {
  return taskTransaction(store, () => {
    const run = readProjectRun(store, sessionId, runId);
    if (!run) throw new Error('project run not found');
    if (!PROJECT_RUN_STATES.includes(nextState)) throw new Error('invalid project run state: ' + nextState);
    if (expectedControlRev !== undefined && run.controlRev !== expectedControlRev)
      throw conflict('项目运行状态已变化，请刷新后重试');
    if (!RUN_TRANSITIONS[run.state].includes(nextState))
      throw new Error('invalid project run transition: ' + run.state + ' -> ' + nextState);
    const next = { ...run, ...detail, state: nextState, controlRev: run.controlRev + 1, updatedAt: nowIso() };
    store.db.prepare('UPDATE project_runs SET state=?,control_rev=?,record=?,updated_at=? WHERE session_id=? AND run_id=?')
      .run(next.state, next.controlRev, JSON.stringify(next), next.updatedAt, sessionId, runId);
    taskEvent(store, sessionId, next.policyRev ?? 0, 'project-run-state', { runId, from: run.state, to: nextState });
    return next;
  });
}

export function readProjectSource(store, sessionId, sourceId, sourceRevision) {
  const row = store.db.prepare('SELECT record FROM project_sources WHERE session_id=? AND source_id=? AND source_revision=?')
    .get(sessionId, String(sourceId || ''), String(sourceRevision || ''));
  return row ? parse(row, 'project_source') : null;
}

export function listProjectSources(store, sessionId) {
  return store.db.prepare('SELECT record FROM project_sources WHERE session_id=? ORDER BY updated_at DESC')
    .all(sessionId).map(row => parse(row, 'project_source'));
}

/** 同一来源内容相同可复用磁盘快照，但不同修订各自留档；这里只保存元数据与快照引用。 */
export function upsertProjectSource(store, sessionId, input = {}) {
  return taskTransaction(store, () => {
    const sourceId = input.sourceId ? String(input.sourceId) : 'project-source-' + randomUUID();
    const sourceRevision = input.sourceRevision ? String(input.sourceRevision) : 'rev-1';
    const existing = readProjectSource(store, sessionId, sourceId, sourceRevision);
    const record = {
      ...(existing || {}), sessionId, sourceId, sourceRevision,
      kind: optionalText(input.kind, 40) || 'text',
      displayName: optionalText(input.displayName, 300),
      summary: optionalText(input.summary, 2000),
      snapshotRef: optionalText(input.snapshotRef, 1000),
      parseState: ['ready', 'partial', 'unreadable', 'pending'].includes(input.parseState) ? input.parseState : 'pending',
      sections: Array.isArray(input.sections) ? input.sections : (existing?.sections || []),
      unread: Array.isArray(input.unread) ? input.unread : (existing?.unread || []),
      updatedAt: nowIso(), createdAt: existing?.createdAt || nowIso(),
    };
    store.db.prepare('INSERT INTO project_sources(session_id,source_id,source_revision,record,updated_at) VALUES(?,?,?,?,?) '
      + 'ON CONFLICT(session_id,source_id,source_revision) DO UPDATE SET record=excluded.record,updated_at=excluded.updated_at')
      .run(sessionId, sourceId, sourceRevision, JSON.stringify(record), record.updatedAt);
    return record;
  });
}

export function readProjectCheck(store, sessionId, runId, checkId) {
  const row = store.db.prepare('SELECT record FROM project_checks WHERE session_id=? AND run_id=? AND check_id=?')
    .get(sessionId, String(runId || ''), String(checkId || ''));
  return row ? parse(row, 'project_check') : null;
}

export function listProjectChecks(store, sessionId, runId) {
  return store.db.prepare('SELECT record FROM project_checks WHERE session_id=? AND run_id=? ORDER BY updated_at ASC')
    .all(sessionId, String(runId || '')).map(row => parse(row, 'project_check'))
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

/** 定义本批检查要求；未执行时不要求 endpoint、身份或方法版本。 */
export function defineProjectChecks(store, sessionId, runId, checks = []) {
  return taskTransaction(store, () => {
    const run = readProjectRun(store, sessionId, runId);
    if (!run) throw new Error('project run not found');
    const existingCount = listProjectChecks(store, sessionId, runId).length;
    const out = [];
    for (const [index, item] of checks.entries()) {
      const requirement = text(item?.requirement, 'check.requirement', 4000);
      const checkId = item?.checkId ? String(item.checkId) : 'project-check-' + randomUUID();
      const checkRevision = 1;
      const record = {
        sessionId, runId, checkId, checkRevision,
        sourceLocation: optionalText(item?.sourceLocation, 1000),
        requirement, order: Number.isSafeInteger(item?.order) ? item.order : existingCount + index,
        dependencies: Array.isArray(item?.dependencies) ? item.dependencies.map(value => String(value)) : [],
        executionState: 'pending', verdict: '', checkedContent: '', gaps: '',
        findingRefs: [], actionRefs: [], createdAt: nowIso(), updatedAt: nowIso(),
      };
      store.db.prepare('INSERT INTO project_checks(session_id,run_id,check_id,check_revision,record,updated_at) VALUES(?,?,?,?,?,?)')
        .run(sessionId, runId, checkId, checkRevision, JSON.stringify(record), record.updatedAt);
      out.push(record);
    }
    return out;
  });
}

export function recordProjectCheck(store, sessionId, runId, checkId, patch = {}) {
  return taskTransaction(store, () => {
    const check = readProjectCheck(store, sessionId, runId, checkId);
    if (!check) throw new Error('project check not found');
    if (patch.verdict !== undefined && patch.verdict !== '' && !PROJECT_VERDICTS.includes(patch.verdict))
      throw new Error('invalid project verdict: ' + patch.verdict);
    if (patch.executionState !== undefined && !PROJECT_CHECK_STATES.includes(patch.executionState))
      throw new Error('invalid project check state: ' + patch.executionState);
    const next = {
      ...check,
      executionState: patch.executionState ?? check.executionState,
      verdict: patch.verdict ?? check.verdict,
      checkedContent: patch.checkedContent !== undefined ? optionalText(patch.checkedContent) : check.checkedContent,
      gaps: patch.gaps !== undefined ? optionalText(patch.gaps) : check.gaps,
      findingRefs: Array.isArray(patch.findingRefs) ? patch.findingRefs : check.findingRefs,
      actionRefs: Array.isArray(patch.actionRefs) ? patch.actionRefs : check.actionRefs,
      updatedAt: nowIso(),
    };
    store.db.prepare('UPDATE project_checks SET record=?,updated_at=? WHERE session_id=? AND run_id=? AND check_id=?')
      .run(JSON.stringify(next), next.updatedAt, sessionId, runId, checkId);
    return next;
  });
}

export function readProjectAction(store, sessionId, runId, actionId) {
  const row = store.db.prepare('SELECT record FROM project_actions WHERE session_id=? AND run_id=? AND action_id=?')
    .get(sessionId, String(runId || ''), String(actionId || ''));
  return row ? parse(row, 'project_action') : null;
}

export function listProjectActions(store, sessionId, runId) {
  return store.db.prepare('SELECT record FROM project_actions WHERE session_id=? AND run_id=? ORDER BY updated_at ASC')
    .all(sessionId, String(runId || '')).map(row => parse(row, 'project_action'));
}

/** 领取当前检查 + 建立动作占用 + 保存执行中记录，同一短事务；网络 I/O 不在事务里。 */
export function beginProjectAction(store, sessionId, runId, checkId, input = {}) {
  return taskTransaction(store, () => {
    const run = readProjectRun(store, sessionId, runId);
    if (!run) throw new Error('project run not found');
    if (run.state !== 'running') throw conflict('项目运行当前不可派发新动作');
    if (input.controlRev !== undefined && input.controlRev !== run.controlRev)
      throw conflict('项目运行状态已变化，请刷新后重试');
    const check = readProjectCheck(store, sessionId, runId, checkId);
    if (!check) throw new Error('project check not found');
    const inflight = store.db.prepare("SELECT action_id FROM project_actions WHERE session_id=? AND run_id=? AND state='dispatched' LIMIT 1")
      .get(sessionId, runId);
    if (inflight) throw conflict('同一项目运行同时只能有一个派发中的动作');
    const actionId = 'project-action-' + randomUUID();
    const record = {
      sessionId, runId, checkId, actionId, controlRev: run.controlRev,
      executionState: 'dispatched', identityRef: optionalText(input.identityRef, 300),
      startedAt: nowIso(), endedAt: '', pageRef: '', requestRef: '', attachmentRef: '',
      error: null, sideEffectUnknown: false,
    };
    store.db.prepare('INSERT INTO project_actions(session_id,run_id,action_id,state,record,updated_at) VALUES(?,?,?,?,?,?)')
      .run(sessionId, runId, actionId, 'dispatched', JSON.stringify(record), record.startedAt);
    const nextCheck = { ...check, executionState: 'running', actionRefs: [...new Set([...(check.actionRefs || []), actionId])], updatedAt: nowIso() };
    store.db.prepare('UPDATE project_checks SET record=?,updated_at=? WHERE session_id=? AND run_id=? AND check_id=?')
      .run(JSON.stringify(nextCheck), nextCheck.updatedAt, sessionId, runId, checkId);
    const nextRun = { ...run, currentCheckId: checkId, updatedAt: nowIso() };
    store.db.prepare('UPDATE project_runs SET record=?,updated_at=? WHERE session_id=? AND run_id=?')
      .run(JSON.stringify(nextRun), nextRun.updatedAt, sessionId, runId);
    return { run: nextRun, check: nextCheck, action: record };
  });
}

/** 动作返回后按 actionId 保存真实结果；控制版本过期只补历史，不改当前运行状态。 */
export function finishProjectAction(store, sessionId, runId, actionId, patch = {}) {
  return taskTransaction(store, () => {
    const action = readProjectAction(store, sessionId, runId, actionId);
    if (!action) throw new Error('project action not found');
    const next = {
      ...action,
      executionState: ['dispatched', 'completed', 'failed', 'unknown'].includes(patch.executionState) ? patch.executionState : 'completed',
      endedAt: nowIso(),
      pageRef: patch.pageRef !== undefined ? optionalText(patch.pageRef, 1000) : action.pageRef,
      requestRef: patch.requestRef !== undefined ? optionalText(patch.requestRef, 1000) : action.requestRef,
      attachmentRef: patch.attachmentRef !== undefined ? optionalText(patch.attachmentRef, 1000) : action.attachmentRef,
      error: patch.error === undefined ? action.error : (patch.error ? optionalText(JSON.stringify(patch.error), 2000) : null),
      sideEffectUnknown: patch.sideEffectUnknown === true || action.sideEffectUnknown === true,
    };
    store.db.prepare('UPDATE project_actions SET state=?,record=?,updated_at=? WHERE session_id=? AND run_id=? AND action_id=?')
      .run(next.executionState, JSON.stringify(next), next.endedAt, sessionId, runId, actionId);
    return next;
  });
}
