// W05：项目连续推进。接续只在运行仍有效、存在可执行未完成项、没有在途动作或
// 未知写入时发生；同一进度重复接续达到阈值后暂停，不再反复发“继续”。
import { taskTransaction } from './task-policy-record.js';
import { readTaskPolicy, taskPolicyStatus } from './task-policy.js';
import {
  activeProjectRun, readProjectRun, listProjectChecks, listProjectActions, listProjectSources,
  transitionProjectRun,
} from './project-store.js';

const nowIso = () => new Date().toISOString();
const OPEN_STATES = new Set(['pending', 'running', 'paused']);

function blockedByDependency(check, checks) {
  if (!Array.isArray(check.dependencies) || !check.dependencies.length) return false;
  for (const dependencyId of check.dependencies) {
    const dependency = checks.find(item => item.checkId === dependencyId);
    if (!dependency) return true;
    if (dependency.verdict === 'blocked' || OPEN_STATES.has(dependency.executionState)) return true;
  }
  return false;
}

export function projectExecutableChecks(store, sessionId, runId) {
  const checks = listProjectChecks(store, sessionId, runId);
  return checks.filter(check => OPEN_STATES.has(check.executionState) && check.verdict !== 'blocked' && !blockedByDependency(check, checks));
}

export function projectProgressFingerprint(store, sessionId, runId) {
  const checks = listProjectChecks(store, sessionId, runId)
    .map(check => [check.checkId, check.executionState, check.verdict])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const actions = listProjectActions(store, sessionId, runId).length;
  const sources = listProjectSources(store, sessionId).length;
  return JSON.stringify({ checks, actions, sources });
}

function continuationMessage(run, executable, checks) {
  const current = executable[0];
  const done = checks.filter(check => check.executionState === 'ended').length;
  const blocked = checks.filter(check => check.verdict === 'blocked').length;
  return '继续按文档测试：当前检查「' + current.requirement + '」'
    + (current.sourceLocation ? '（来源：' + current.sourceLocation + '）' : '')
    + '。已结束 ' + done + ' 项，可执行 ' + executable.length + ' 项，缺条件 ' + blocked + ' 项。'
    + '完成本项后用 project_check record 保存实际结果和缺口，再取下一项；缺条件项不要阻塞独立项。';
}

/** 返回 null 表示不应自动接续；返回 { text, fingerprint, attempts } 表示可以接续一次。 */
export function projectContinuation(store, sessionId) {
  const run = activeProjectRun(store, sessionId);
  if (!run || run.state !== 'running') return null;
  const policy = readTaskPolicy(store, sessionId);
  if (!policy || policy.cancelled) return null;
  const state = taskPolicyStatus(store, sessionId);
  if (!state.configured || state.stopped) return null;
  const actions = listProjectActions(store, sessionId, run.runId);
  if (actions.some(action => action.executionState === 'dispatched')) return null;
  if (actions.some(action => action.sideEffectUnknown === true)) return null;
  const checks = listProjectChecks(store, sessionId, run.runId);
  const executable = projectExecutableChecks(store, sessionId, run.runId);
  if (!executable.length) return null;
  const fingerprint = projectProgressFingerprint(store, sessionId, run.runId);
  const attempts = run.lastContinuationFingerprint === fingerprint ? (run.continuationNoProgress || 0) + 1 : 0;
  if (attempts >= 2) {
    transitionProjectRun(store, sessionId, run.runId, 'paused', run.controlRev, {
      blocker: { code: 'no-progress', reason: '自动继续未能推进，已暂停', at: nowIso() },
    });
    return null;
  }
  return { runId: run.runId, text: continuationMessage(run, executable, checks), fingerprint, attempts };
}

export function markProjectContinuation(store, sessionId, runId, fingerprint, attempts) {
  return taskTransaction(store, () => {
    const run = readProjectRun(store, sessionId, runId);
    if (!run) return null;
    const next = { ...run, lastContinuationFingerprint: fingerprint, continuationNoProgress: attempts, updatedAt: nowIso() };
    store.db.prepare('UPDATE project_runs SET record=?,updated_at=? WHERE session_id=? AND run_id=?')
      .run(JSON.stringify(next), next.updatedAt, sessionId, runId);
    return next;
  });
}

export function pauseProjectRun(store, sessionId, runId, blocker) {
  const run = readProjectRun(store, sessionId, runId);
  if (!run) throw new Error('project run not found');
  return transitionProjectRun(store, sessionId, runId, 'paused', run.controlRev, { blocker: blocker || null });
}

/** 恢复前核对：仍在 paused/waiting 才回到 preparing，由执行端重新检查环境与剩余额度。 */
export function resumeProjectRun(store, sessionId, runId) {
  const run = readProjectRun(store, sessionId, runId);
  if (!run) throw new Error('project run not found');
  if (!['paused', 'waiting'].includes(run.state)) throw new Error('只有暂停或等待中的项目运行可以恢复');
  const unknown = listProjectActions(store, sessionId, runId).filter(action => action.sideEffectUnknown === true);
  if (unknown.length) throw new Error('存在结果未知的写入动作，请先核对业务状态再恢复');
  return transitionProjectRun(store, sessionId, runId, 'preparing', run.controlRev, { blocker: null });
}

export function completeProjectRun(store, sessionId, runId) {
  const run = readProjectRun(store, sessionId, runId);
  if (!run) throw new Error('project run not found');
  const checks = listProjectChecks(store, sessionId, runId);
  const remaining = checks.filter(check => OPEN_STATES.has(check.executionState));
  if (remaining.length) throw new Error('还有未结束的检查，不能标记本次运行完成');
  return transitionProjectRun(store, sessionId, runId, 'completed', run.controlRev, {
    completedSummary: {
      ended: checks.filter(check => check.executionState === 'ended').length,
      blocked: checks.filter(check => check.verdict === 'blocked').length,
      partial: checks.filter(check => check.verdict === 'not_found' && check.gaps).length,
    },
  });
}
