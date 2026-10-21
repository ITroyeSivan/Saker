// W05：项目连续推进。接续只在运行仍有效、存在可执行未完成项、没有在途动作或
// 未知写入时发生；同一进度重复接续达到阈值后暂停，不再反复发“继续”。
import { taskTransaction, writeTaskPolicy } from './task-policy-record.js';
import { readTaskPolicy, taskPolicyStatus, startTaskPolicy, hasUnreleasedWorker } from './task-policy.js';
import {
  activeProjectRun, readProjectRun, listProjectChecks, listProjectActions,
  transitionProjectRun, projectCheckEvidenceProblems,
  createProjectRun,
} from './project-store.js';
import { projectProgressFingerprint, projectSourceProgress } from './project-progress.js';
export { projectProgressFingerprint } from './project-progress.js';

const nowIso = () => new Date().toISOString();
const OPEN_STATES = new Set(['pending', 'running', 'paused']);

function syncProjectPolicy(store, sessionId, run) {
  const policy = readTaskPolicy(store, sessionId);
  if (policy?.scenario !== 'project' || (policy.projectRunId && policy.projectRunId !== run.runId)) return;
  const next = { ...policy, projectRunId: run.runId, projectRunState: run.state };
  if (next.blocker?.source === 'project-run') delete next.blocker;
  if (['paused', 'waiting', 'failed'].includes(run.state) && !next.blocker) next.blocker = {
    code: 'needs-user', reason: run.blocker?.reason || '项目运行已暂停', source: 'project-run',
    projectCode: run.blocker?.code || run.state, recordedAt: Date.now(),
  };
  if (run.state === 'cancelled') next.cancelled = true;
  if (policy.scenario === 'project') {
    next.planComplete = run.state === 'completed';
    if (run.state !== 'completed') delete next.finishedAt;
  }
  if (['completed', 'cancelled', 'failed'].includes(run.state)) next.finishedAt = Date.now();
  writeTaskPolicy(store, sessionId, next, 'project-control', { runId: run.runId, state: run.state });
}

/** 原子建立运行与计量；显式再次测试才归档旧轮次，继续不走这里。 */
export function startProjectTask(store, sessionId, input = {}) {
  return taskTransaction(store, () => {
    const existing = activeProjectRun(store, sessionId);
    if (existing) return { ...existing, existing: true };
    const previous = readTaskPolicy(store, sessionId);
    if (previous && previous.scenario !== 'project') throw new Error('当前会话已有其他任务；按文档测试请新建会话');
    if (previous && hasUnreleasedWorker(store, sessionId)) throw new Error('先确认上一轮助手已释放');
    let defaults = {};
    if (previous) {
      const budget = { ...previous.budget };
      if (budget.deadline !== null) budget.minutes = Math.max(1, Math.ceil((budget.deadline - previous.startedAt) / 60000));
      delete budget.deadline;
      defaults = Object.fromEntries(['question', 'target', 'allowTargetNetwork', 'readOnly', 'excludedPaths', 'requestRatePerMinute', 'requestConcurrency']
        .map(key => [key, previous[key]]));
      defaults.budget = budget;
      if (!defaults.target) delete defaults.target;
      store.db.prepare('INSERT INTO task_rounds(session_id,started_at,record) VALUES(?,?,?)')
        .run(sessionId, previous.startedAt, JSON.stringify({ ...previous, endedAt: previous.finishedAt || Date.now(), source: 'project-restart' }));
      store.db.prepare('DELETE FROM task_policy WHERE session_id=?').run(sessionId);
    }
    const policy = startTaskPolicy(store, sessionId, { ...defaults, ...input.policy, scenario: 'project',
      budget: { ...defaults.budget, ...input.policy?.budget, workers: 0 } }, Math.max(Date.now(), (previous?.startedAt || 0) + 1));
    const run = createProjectRun(store, sessionId, { policyRev: policy.policyRev, question: policy.question,
      sourceSnapshot: input.sourceSnapshot });
    syncProjectPolicy(store, sessionId, run);
    return run;
  });
}

export function setProjectRunState(store, sessionId, runId, state, expectedControlRev, detail = {}) {
  return taskTransaction(store, () => {
    const run = transitionProjectRun(store, sessionId, runId, state, expectedControlRev, detail);
    syncProjectPolicy(store, sessionId, run);
    return run;
  });
}

/** 真实工具领取当前项，接通 preparing -> running，不要求模型另改状态。 */
export function selectProjectCheck(store, sessionId, runId) {
  return taskTransaction(store, () => {
    let run = readProjectRun(store, sessionId, runId);
    if (!run || !['preparing', 'running'].includes(run.state)) throw new Error('项目已暂停或停止，不能领取新检查');
    const status = taskPolicyStatus(store, sessionId);
    if (!status.configured || status.stopped) throw new Error('当前任务不可执行：' + status.reason);
    const checks = projectExecutableChecks(store, sessionId, runId);
    const check = checks.find(item => item.checkId === run.currentCheckId) || checks[0];
    if (!check) return null;
    if (run.state === 'preparing') run = setProjectRunState(store, sessionId, runId, 'running', run.controlRev);
    if (run.currentCheckId !== check.checkId) {
      const next = { ...run, currentCheckId: check.checkId, updatedAt: nowIso() };
      store.db.prepare('UPDATE project_runs SET record=?,updated_at=? WHERE session_id=? AND run_id=?')
        .run(JSON.stringify(next), next.updatedAt, sessionId, runId);
    }
    return check;
  });
}

function blockedByDependency(check, checks) {
  if (!Array.isArray(check.dependencies) || !check.dependencies.length) return false;
  const dependencies = [];
  for (const dependencyId of check.dependencies) {
    const dependency = checks.find(item => item.checkId === dependencyId);
    if (!dependency) return true;
    if (dependency.verdict === 'blocked' || OPEN_STATES.has(dependency.executionState)) return true;
    dependencies.push(dependency);
  }
  for (const requiredFact of check.requiresFacts || []) {
    if (!dependencies.some(dependency => dependency.executionState === 'ended'
      && dependency.verdict !== 'blocked' && dependency.verdict !== 'needs_check'
      && (dependency.provides || []).includes(requiredFact))) return true;
  }
  return false;
}

export function projectExecutableChecks(store, sessionId, runId) {
  const checks = listProjectChecks(store, sessionId, runId);
  return checks.filter(check => OPEN_STATES.has(check.executionState) && check.verdict !== 'blocked' && !blockedByDependency(check, checks));
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
    setProjectRunState(store, sessionId, run.runId, 'paused', run.controlRev, {
      blocker: { code: 'no-progress', reason: '自动继续未能推进，已暂停', at: nowIso() },
    });
    return null;
  }
  return { runId: run.runId, controlRev: run.controlRev, text: continuationMessage(run, executable, checks), fingerprint, attempts };
}

/**
 * turn-stopping 的项目判定：只在一个地方决定 continue／waiting／completed。
 * 不调用模型、不发网络；调用方按 action 执行宿主 steer 或短事务状态同步。
 */
export function projectTurnDecision(store, sessionId) {
  const run = activeProjectRun(store, sessionId);
  if (!run || !['preparing', 'running'].includes(run.state)) return { action: 'none', run };
  const policy = readTaskPolicy(store, sessionId);
  if (!policy || policy.cancelled) return { action: 'none', run };
  const state = taskPolicyStatus(store, sessionId);
  if (!state.configured) return { action: 'none', run, reason: state.reason };
  const prematurePlanComplete = state.stopped && state.reason === 'plan_complete';
  if (state.stopped && !prematurePlanComplete) return { action: 'none', run, reason: state.reason };
  const actions = listProjectActions(store, sessionId, run.runId);
  if (actions.some(action => ['queued', 'dispatched'].includes(action.executionState))) return { action: 'none', run, reason: 'in-flight' };
  if (actions.some(action => action.sideEffectUnknown === true)) {
    return { action: 'waiting', run, blocker: { code: 'unknown-side-effect', reason: '存在结果未知的写入动作，请先核对业务状态再继续' } };
  }
  const sourceProgress = projectSourceProgress(store, sessionId, run.runId);
  if (sourceProgress.pending > 0) {
    if (prematurePlanComplete)
      return { action: 'waiting', run, blocker: { code: 'plan-complete-early', reason: '模型提前标记完成，但仍有来源区域未整理' } };
    const fingerprint = projectProgressFingerprint(store, sessionId, run.runId);
    const attempts = run.lastContinuationFingerprint === fingerprint ? (run.continuationNoProgress || 0) + 1 : 0;
    if (attempts >= 2) {
      setProjectRunState(store, sessionId, run.runId, 'paused', run.controlRev, {
        blocker: { code: 'no-progress', reason: '来源区域连续未整理，已暂停', at: nowIso() },
      });
      return { action: 'none', run };
    }
    const first = sourceProgress.items[0];
    const where = first
      ? (first.displayName || first.sourceId) + ' ' + (first.sourceRevision || '')
        + (first.sectionId && first.sectionId !== '#source' ? ' ' + first.sectionId : '')
      : '来源快照';
    const text = sourceProgress.needsRead > 0
      ? '继续按文档测试：先读取来源 ' + where + '。读取后用 project_check define 的 sectionDecisions 明确保存 requirements、reference 或 unreadable；只读取不算整理完成。'
      : '继续按文档测试：仍有未整理来源区域，例如 ' + where + '。对已读区域用 project_check define 的 sectionDecisions 保存决定；requirements 必须关联本次 checks 的 sourceRefs，reference/unreadable 要写明 rationale。';
    return {
      action: 'continue', run,
      continuation: { runId: run.runId, controlRev: run.controlRev, fingerprint, attempts, text },
    };
  }
  const checks = listProjectChecks(store, sessionId, run.runId);
  const executable = projectExecutableChecks(store, sessionId, run.runId);
  if (executable.length) {
    if (prematurePlanComplete)
      return { action: 'waiting', run, blocker: { code: 'plan-complete-early', reason: '模型提前标记完成，但仍有检查未结束' } };
    if (run.state === 'running') {
      const continuation = projectContinuation(store, sessionId);
      return continuation ? { action: 'continue', run, continuation } : { action: 'none', run };
    }
    const current = executable[0];
    const fingerprint = projectProgressFingerprint(store, sessionId, run.runId);
    const attempts = run.lastContinuationFingerprint === fingerprint ? (run.continuationNoProgress || 0) + 1 : 0;
    if (attempts >= 2) {
      setProjectRunState(store, sessionId, run.runId, 'paused', run.controlRev, {
        blocker: { code: 'no-progress', reason: '自动继续未能推进，已暂停', at: nowIso() },
      });
      return { action: 'none', run };
    }
    return {
      action: 'continue', run,
      continuation: {
        runId: run.runId, controlRev: run.controlRev, fingerprint, attempts,
        text: '继续按文档测试：当前检查「' + current.requirement + '」'
          + (current.sourceLocation ? '（来源：' + current.sourceLocation + '）' : '')
          + '。先读取相关原文，再领取并执行当前检查；缺条件项写清缺口，不要阻塞独立项。',
      },
    };
  }
  const blocked = checks.filter(check => check.verdict === 'blocked').length;
  const partial = checks.filter(check => check.verdict === 'not_found' && check.gaps).length;
  if (blocked > 0) {
    return { action: 'waiting', run, blocker: { code: 'waiting-conditions', reason: '可执行部分已结束，还有 ' + blocked + ' 项缺少条件' } };
  }
  if (!checks.length) {
    return { action: 'waiting', run, blocker: { code: 'no-requirements', reason: '没有找到可执行的测试要求，请补充说明要检查什么' } };
  }
  if (checks.every(check => check.executionState === 'ended')) {
    const evidenceProblems = checks.flatMap(check => projectCheckEvidenceProblems(store, sessionId, run.runId, check)
      .map(problem => check.checkId + ':' + problem));
    if (evidenceProblems.length) {
      return {
        action: 'waiting', run,
        blocker: { code: 'evidence-required', reason: '检查结论缺少有效动作、复用观测或已复核 finding：' + evidenceProblems.join('；') },
      };
    }
    return { action: 'completed', run, summary: { ended: checks.length, blocked, partial } };
  }
  return { action: 'waiting', run, blocker: { code: 'waiting-conditions', reason: '还有未完成的检查，请补充条件后继续' } };
}

export function markProjectContinuation(store, sessionId, runId, fingerprint, attempts, expectedControlRev) {
  return taskTransaction(store, () => {
    const run = readProjectRun(store, sessionId, runId);
    if (!run || !['preparing', 'running'].includes(run.state) || (expectedControlRev !== undefined && run.controlRev !== expectedControlRev)) return null;
    const next = { ...run, lastContinuationFingerprint: fingerprint, continuationNoProgress: attempts, updatedAt: nowIso() };
    store.db.prepare('UPDATE project_runs SET record=?,updated_at=? WHERE session_id=? AND run_id=?')
      .run(JSON.stringify(next), next.updatedAt, sessionId, runId);
    return next;
  });
}

export function pauseProjectRun(store, sessionId, runId, blocker, expectedControlRev) {
  const run = readProjectRun(store, sessionId, runId);
  if (!run) throw new Error('project run not found');
  return setProjectRunState(store, sessionId, runId, 'paused', expectedControlRev ?? run.controlRev, { blocker: blocker || null });
}

/** 恢复前核对：仍在 paused/waiting 才回到 preparing，由执行端重新检查环境与剩余额度。 */
export function resumeProjectRun(store, sessionId, runId, expectedControlRev) {
  const run = readProjectRun(store, sessionId, runId);
  if (!run) throw new Error('project run not found');
  if (!['paused', 'waiting'].includes(run.state)) throw new Error('只有暂停或等待中的项目运行可以恢复');
  const unknown = listProjectActions(store, sessionId, runId).filter(action => action.sideEffectUnknown === true);
  if (unknown.length) throw new Error('存在结果未知的写入动作，请先核对业务状态再恢复');
  return taskTransaction(store, () => {
    const next = setProjectRunState(store, sessionId, runId, 'preparing', expectedControlRev ?? run.controlRev, { blocker: null });
    const status = taskPolicyStatus(store, sessionId);
    if (status.stopped) throw new Error('当前条件尚不能继续：' + status.reason);
    // 明确的继续重新建立接续窗口，已有已读范围和观测仍保留，不重置额度。
    const resumed = { ...next, lastContinuationFingerprint: '', continuationNoProgress: 0 };
    store.db.prepare('UPDATE project_runs SET record=? WHERE session_id=? AND run_id=?').run(JSON.stringify(resumed), sessionId, runId);
    return resumed;
  });
}

export function completeProjectRun(store, sessionId, runId) {
  const run = readProjectRun(store, sessionId, runId);
  if (!run) throw new Error('project run not found');
  const actions = listProjectActions(store, sessionId, runId);
  if (actions.some(action => ['queued', 'dispatched'].includes(action.executionState)))
    throw new Error('还有未收尾的项目动作，不能标记本次运行完成');
  if (actions.some(action => action.sideEffectUnknown === true))
    throw new Error('存在结果未知的写入动作，请先核对业务状态再完成');
  const sourceProgress = projectSourceProgress(store, sessionId, runId);
  if (sourceProgress.pending > 0) throw new Error('还有未整理的来源区域，不能标记本次运行完成');
  const checks = listProjectChecks(store, sessionId, runId);
  if (!checks.length) throw new Error('没有检查项，不能标记本次运行完成');
  const remaining = checks.filter(check => OPEN_STATES.has(check.executionState));
  if (remaining.length) throw new Error('还有未结束的检查，不能标记本次运行完成');
  const evidenceProblems = checks.flatMap(check => projectCheckEvidenceProblems(store, sessionId, runId, check)
    .map(problem => check.checkId + ':' + problem));
  if (evidenceProblems.length)
    throw new Error('检查缺少有效动作、复用观测或已复核 finding，不能标记本次运行完成：' + evidenceProblems.join('；'));
  return setProjectRunState(store, sessionId, runId, 'completed', run.controlRev, {
    completedSummary: {
      ended: checks.filter(check => check.executionState === 'ended').length,
      blocked: checks.filter(check => check.verdict === 'blocked').length,
      partial: checks.filter(check => check.verdict === 'not_found' && check.gaps).length,
    },
  });
}
