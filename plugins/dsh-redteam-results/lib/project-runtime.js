// W05：项目连续推进。接续只在运行仍有效、存在可执行未完成项、没有在途动作或
// 未知写入时发生；同一进度重复接续达到阈值后暂停，不再反复发“继续”。
import { taskTransaction, writeTaskPolicy } from './task-policy-record.js';
import { readTaskPolicy, taskPolicyStatus, startTaskPolicy, hasUnreleasedWorker, setTaskActionLimits } from './task-policy.js';
import {
  activeProjectRun, readProjectRun, listProjectChecks, listProjectActions,
  readProjectCheck, transitionProjectRun, projectCheckEvidenceProblems,
  createProjectRun, defineProjectChecks, reopenProjectCheck,
  beginProjectAction, finishProjectAction, saveProjectEvidence, recordProjectCheck,
} from './project-store.js';
import { projectProgressFingerprint, projectSourceProgress } from './project-progress.js';
export { projectProgressFingerprint } from './project-progress.js';

const nowIso = () => new Date().toISOString();
const OPEN_STATES = new Set(['pending', 'running', 'paused']);
const NATIVE_FACT_TOOLS = new Set([
  'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'powershell', 'exec_command',
  'run_shell', 'run_code', 'view_image',
]);
const NATIVE_CONCURRENCY_SAFE = new Set(['read', 'glob', 'grep', 'view_image']);
const OPEN_CHECK_STATES = new Set(['pending', 'running', 'paused']);

const textOfContent = value => {
  if (typeof value === 'string') return value;
  const visibleText = item => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    if (item.type && item.type !== 'text') return '';
    return String(item.text || item.content || '');
  };
  if (Array.isArray(value)) return value.map(visibleText).join('');
  if (value && typeof value === 'object') return visibleText(value);
  return '';
};

function nativeToolTarget(value) {
  let args = value;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = null; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  for (const key of ['file_path', 'path', 'url', 'target', 'command', 'cmd']) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim().slice(0, 2000);
  }
  return '';
}

function checkMatchesNativeTarget(check, target) {
  const raw = String(target || '').trim().toLowerCase();
  const requirement = String(check?.requirement || '').toLowerCase();
  if (!raw || !requirement) return false;
  const normalized = raw.replaceAll('/', '\\');
  if (requirement.replaceAll('/', '\\').includes(normalized)) return true;
  const basename = normalized.split('\\').filter(Boolean).at(-1) || '';
  return basename.length >= 4 && requirement.includes(basename);
}

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
    if (previous && previous.scenario !== 'project') throw new Error('当前会话已有其他任务；案例测试请新建会话');
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
    if (Array.isArray(previous?.allowedOrigins) && previous.allowedOrigins.length)
      setTaskActionLimits(store, sessionId, { allowedOrigins: previous.allowedOrigins }, 'desktop-user');
    const run = createProjectRun(store, sessionId, { policyRev: policy.policyRev, question: policy.question,
      sourceSnapshot: input.sourceSnapshot, runtimeId: input.runtimeId,
      executionAuthorized: input.executionAuthorized === true || input.autoStart !== false });
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

export function startProjectRetest(store, sessionId, input = {}) {
  return taskTransaction(store, () => {
    const parentRunId = String(input.parentRunId || '')
    const parent = readProjectRun(store, sessionId, parentRunId)
    if (!parent) throw new Error('project retest parent run not found')
    const selected = new Set((Array.isArray(input.checkIds) ? input.checkIds : []).map(String).filter(Boolean))
    if (!selected.size) throw new Error('select at least one check to retest')
    const checks = listProjectChecks(store, sessionId, parentRunId)
    const chosen = checks.filter(check => selected.has(check.checkId))
    if (chosen.length !== selected.size) throw new Error('selected check is not in the parent run')
    const active = activeProjectRun(store, sessionId)
    if (active?.runId === parentRunId) {
      const retryable = chosen.filter(check => ['blocked', 'needs_check'].includes(check.verdict))
      if (retryable.length !== chosen.length)
        throw Object.assign(new Error('活动运行中只允许对 blocked/needs_check 项显式重试；其他项需等待本次运行结束'), {
          code: 'project-run-active',
        })
      const reopened = chosen.map(check => reopenProjectCheck(store, sessionId, parentRunId, check.checkId, {
        reason: String(input.reason || '用户选择显式重试当前项'),
      }))
      return { run: readProjectRun(store, sessionId, parentRunId), checks: reopened, retryMode: 'same-run', needsStart: true }
    }
    if (active) throw Object.assign(new Error('已有另一个活动运行；先结束或暂停并选择它，再开始独立重测'), {
      code: 'project-run-active',
    })
    if (['preparing', 'running', 'waiting', 'paused'].includes(parent.state))
      throw Object.assign(new Error('活动运行中不能创建独立重测'), { code: 'project-run-active' })
    const byId = new Map(checks.map(check => [check.checkId, check]))
    const closure = new Map()
    const visit = (check, requiredBy) => {
      if (!check) throw new Error('重测前置检查不存在');
      if (!closure.has(check.checkId)) {
        closure.set(check.checkId, check)
        for (const dependencyId of check.dependencies || []) {
          const dependency = byId.get(dependencyId)
          if (!dependency) throw new Error('重测前置检查不存在：' + dependencyId);
          if (!selected.has(dependencyId)) {
            if (dependency.executionState !== 'ended' || ['blocked', 'needs_check'].includes(dependency.verdict))
              throw new Error('重测 ' + check.checkId + ' 的前置条件尚未完成：' + dependencyId
                + '；请先补条件或在本次重测中一并选择前置项');
            closure.set(dependencyId, { ...dependency, inherited: true })
          } else visit(dependency, check.checkId)
        }
      }
    }
    for (const check of chosen) visit(check)
    const run = startProjectTask(store, sessionId, {
      ...input,
      sourceSnapshot: parent.sourceSnapshot || [],
      policy: { ...(input.policy || {}), question: input.question || ('重测 ' + chosen.length + ' 项案例要求') },
      autoStart: false,
      executionAuthorized: true,
    })
    const retestRun = { ...run, progressDocumentCoverage: parent.progressDocumentCoverage || {},
      inheritedFromRunId: parentRunId, updatedAt: nowIso() }
    store.db.prepare('UPDATE project_runs SET record=?,updated_at=? WHERE session_id=? AND run_id=?')
      .run(JSON.stringify(retestRun), retestRun.updatedAt, sessionId, run.runId)
    const copiedChecks = [...closure.values()].map(check => ({
      checkId: check.checkId,
      requirement: check.requirement,
      sourceLocation: check.sourceLocation,
      sourceRefs: check.sourceRefs,
      dependencies: check.dependencies || [],
      provides: check.provides || [],
      requiresFacts: check.requiresFacts || [],
      originRunId: parentRunId,
      originCheckId: check.checkId,
      requirementRevision: check.requirementRevision || check.checkRevision || 1,
      ...(check.inherited ? {
        inherited: true, executionState: 'ended', verdict: check.verdict,
        checkedContent: check.checkedContent, gaps: check.gaps,
        evidenceRefs: check.evidenceRefs || [], completedAt: check.updatedAt,
      } : {}),
    }))
    const copiedIds = new Set(copiedChecks.map(check => check.checkId))
    const copiedDecisions = Object.values(parent.sectionDecisions || {})
      .map(decision => {
        const checkIds = (decision.checkIds || []).filter(checkId => copiedIds.has(checkId))
        const notRetestedRequirement = decision.decision === 'requirements' && !checkIds.length
        return {
          sourceId: decision.sourceId,
          sourceRevision: decision.sourceRevision,
          sectionId: decision.sectionId,
          decision: notRetestedRequirement ? 'reference' : decision.decision,
          rationale: notRetestedRequirement ? '该原表行属于父运行中的其他检查，本轮未选择重测。' : decision.rationale,
          checkIds,
        }
      })
    const copied = defineProjectChecks(store, sessionId, run.runId, copiedChecks, copiedDecisions,
      { programmaticSourceDecisions: true })
    const updated = readProjectRun(store, sessionId, run.runId)
    const next = { ...updated, retest: { parentRunId, selectedCheckIds: chosen.map(check => check.checkId), selectedCount: chosen.length,
      originalTotal: checks.length }, updatedAt: nowIso() }
    store.db.prepare('UPDATE project_runs SET record=?,updated_at=? WHERE session_id=? AND run_id=?')
      .run(JSON.stringify(next), next.updatedAt, sessionId, run.runId)
    return { run: next, checks: copied, retryMode: 'new-run', needsStart: true,
      executedCheckIds: [...selected], inheritedCheckIds: copied.filter(check => check.inherited).map(check => check.checkId) }
  })
}

// Restore only facts owned by a stopped host. A live/permission-protected PID is
// not proof of a stopped host; another host's active work must remain untouched.
export function recoverInterruptedProjectRuns(store, { runtimeId = '', shutdown = false } = {}) {
  return taskTransaction(store, () => {
    const recovered = [];
    const rows = store.db.prepare("SELECT record FROM project_runs WHERE state IN ('preparing','running','waiting','paused')").all();
    for (const row of rows) {
      const run = JSON.parse(row.record);
      if (shutdown) {
        if (!runtimeId || run.ownerRuntimeId !== runtimeId) continue;
      } else if (Number.isSafeInteger(run.ownerPid) && run.ownerPid > 0) {
        try { process.kill(run.ownerPid, 0); continue; }
        catch (error) { if (error.code !== 'ESRCH') continue; }
      }
      const actions = listProjectActions(store, run.sessionId, run.runId);
      const unfinished = actions.filter(action => ['queued', 'dispatched'].includes(action.executionState));
      if (!['preparing', 'running'].includes(run.state) && !unfinished.length) continue;
      const at = nowIso();
      for (const action of unfinished) {
        const dispatched = action.executionState === 'dispatched';
        const unknown = dispatched && !['GET', 'HEAD', 'OPTIONS'].includes(action.method);
        const next = { ...action, executionState: unknown ? 'unknown' : 'failed',
          sideEffectUnknown: unknown || action.sideEffectUnknown === true,
          bodyUnavailable: dispatched, endedAt: at, interruptedAt: at,
          error: dispatched ? '宿主已中断，原动作未取得完整结果' : '宿主已中断，尚未派发的动作已取消' };
        store.db.prepare('UPDATE project_actions SET state=?,record=?,updated_at=? WHERE session_id=? AND run_id=? AND action_id=?')
          .run(next.executionState, JSON.stringify(next), at, run.sessionId, run.runId, action.actionId);
      }
      for (const check of listProjectChecks(store, run.sessionId, run.runId)) {
        if (check.executionState !== 'running') continue;
        store.db.prepare('UPDATE project_checks SET record=?,updated_at=? WHERE session_id=? AND run_id=? AND check_id=?')
          .run(JSON.stringify({ ...check, executionState: 'paused', updatedAt: at }), at, run.sessionId, run.runId, check.checkId);
      }
      const next = { ...run, state: 'paused', controlRev: run.controlRev + 1,
        ownerPid: null, ownerRuntimeId: '', interruptedAt: at, updatedAt: at,
        blocker: { code: 'host-interrupted', reason: unfinished.some(action => action.executionState === 'dispatched')
          ? '上次执行中断；请先核对未收尾的动作，再继续测试' : '上次执行中断；已保留进度，请确认环境后继续' } };
      store.db.prepare('UPDATE project_runs SET state=?,control_rev=?,record=?,updated_at=? WHERE session_id=? AND run_id=?')
        .run(next.state, next.controlRev, JSON.stringify(next), at, run.sessionId, run.runId);
      syncProjectPolicy(store, run.sessionId, next);
      recovered.push({ sessionId: run.sessionId, runId: run.runId });
    }
    return recovered;
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

/**
 * Native host tools are real work too. Bind their call/result to the ordered
 * current case check without asking the model to select or register it.
 */
export function captureProjectNativeEvent(store, sessionId, event) {
  if (!sessionId || !event || !['tool/call', 'tool/result', 'assistant/message'].includes(event.type)) return null;
  if (readTaskPolicy(store, sessionId)?.scenario !== 'project') return null;
  const contextOf = value => ({
    turn: Number.isSafeInteger(value?.data?.turn) ? value.data.turn : null,
    step: Number.isSafeInteger(value?.data?.step) ? value.data.step : null,
  });
  const sameTurn = (reply, current) => {
    if (!reply) return true;
    if (reply.turn !== null && current.turn !== null && reply.turn !== current.turn) return false;
    return true;
  };
  const actionForCall = callId => {
    const row = store.db.prepare('SELECT record FROM project_actions WHERE session_id=? AND action_id=? ORDER BY updated_at DESC LIMIT 1')
      .get(sessionId, callId);
    if (!row) return null;
    try { return JSON.parse(row.record); } catch { return null; }
  };
  const clearPendingReply = (runId, checkId) => taskTransaction(store, () => {
    const check = readProjectCheck(store, sessionId, runId, checkId);
    if (!check) return null;
    const next = { ...check, updatedAt: nowIso() };
    delete next.nativePendingReply;
    store.db.prepare('UPDATE project_checks SET record=?,updated_at=? WHERE session_id=? AND run_id=? AND check_id=?')
      .run(JSON.stringify(next), next.updatedAt, sessionId, runId, checkId);
    return next;
  });

  if (event.type === 'tool/result') {
    const callId = String(event.data?.message?.toolCallId || '').trim();
    if (!callId) return null;
    const action = actionForCall(callId);
    if (!action?.nativeTool) return null;
    if (action.evidenceRef && ['completed', 'failed'].includes(action.executionState))
      return { associated: true, idempotent: true, actionId: action.actionId,
        checkId: action.checkId, evidenceId: action.evidenceRef, actionState: action.executionState };
    const message = event.data?.message || {};
    const fullOutput = textOfContent(message.content);
    const output = fullOutput.slice(0, 8000);
    const ok = message.isError !== true && !event.data?.error;
    const error = ok ? '' : String(event.data?.error?.reason || event.data?.error?.code || 'native tool failed').slice(0, 2000);
    const check = readProjectCheck(store, sessionId, action.runId, action.checkId);
    const currentAttempt = check?.activeAttempt?.attemptId === action.attemptId;
    const evidence = saveProjectEvidence(store, sessionId, action.runId, action.checkId, {
      kind: 'tool',
      sourceType: 'host-native-tool-result',
      toolName: action.toolName,
      callId: action.actionId,
      toolArguments: action.toolArguments,
      ok,
      outcome: ok ? 'completed' : 'failed',
      text: output,
      fullText: fullOutput.length > output.length ? fullOutput : undefined,
      truncated: fullOutput.length > output.length,
      originalBytes: Buffer.byteLength(fullOutput),
      error,
      attemptId: action.attemptId,
      instanceRevision: action.instanceRevision,
      identityRef: action.identityRef,
      identityRevision: action.identityRevision,
      historical: !currentAttempt,
    });
    const recordedAt = nowIso();
    const finished = finishProjectAction(store, sessionId, action.runId, action.actionId, {
      executionState: ok ? 'completed' : 'failed',
      error,
      retainedBytes: Buffer.byteLength(output),
      evidenceRef: evidence.id,
      resultRecordedAt: recordedAt,
    });
    if (currentAttempt) {
      recordProjectCheck(store, sessionId, action.runId, action.checkId, {
        executionState: 'running',
        actionRefs: [...new Set([...(check?.actionRefs || []), action.actionId])],
        evidenceRefs: [...new Set([...(check?.evidenceRefs || []), evidence.id])],
      });
    }
    return { associated: true, actionId: action.actionId, checkId: action.checkId,
      runId: action.runId, evidenceId: evidence.id, actionState: finished.executionState,
      historical: !currentAttempt, ok };
  }

  const run = activeProjectRun(store, sessionId);
  if (!run || !['preparing', 'running'].includes(run.state)) return null;

  if (event.type === 'tool/call') {
    const toolName = String(event.data?.name || '').trim().toLowerCase();
    const callId = String(event.data?.callId || '').trim();
    if (!callId) return null;
    const browserTarget = toolName === 'saker_browser'
      && ['open', 'act'].includes(String(event.data?.arguments?.action || '').trim())
    if (toolName === 'project_request' || browserTarget) {
      const selected = selectProjectCheck(store, sessionId, run.runId)
      const latest = readProjectRun(store, sessionId, run.runId)
      return selected ? {
        associated: true, managedTool: true, checkId: selected.checkId,
        currentCheckId: latest?.currentCheckId || selected.checkId,
      } : { associated: false, reason: 'no-executable-check' }
    }
    if (!NATIVE_FACT_TOOLS.has(toolName)) return null;
    if (actionForCall(callId)) return { associated: true, actionId: callId, idempotent: true };
    let selected;
    const current = run.currentCheckId ? readProjectCheck(store, sessionId, run.runId, run.currentCheckId) : null;
    const target = nativeToolTarget(event.data?.arguments);
    const matches = target ? listProjectChecks(store, sessionId, run.runId)
      .filter(check => OPEN_CHECK_STATES.has(check.executionState) && checkMatchesNativeTarget(check, target)) : [];
    const matched = matches.length === 1 ? matches[0]
      : matches.find(check => check.checkId === current?.checkId) || null;
    const continuation = current?.executionState === 'ended' && current.nativePendingReply
      && sameTurn(current.nativePendingReply, contextOf(event));
    if (matched && matched.checkId !== current?.checkId) {
      if (run.state === 'preparing') setProjectRunState(store, sessionId, run.runId, 'running', run.controlRev);
      selected = matched;
    }
    else if (continuation) {
      selected = taskTransaction(store, () => {
        const latest = readProjectCheck(store, sessionId, run.runId, current.checkId);
        const next = { ...latest, executionState: 'running', verdict: '', checkedContent: '', gaps: '',
          checkRevision: (Number(latest.checkRevision) || 1) + 1, updatedAt: nowIso() };
        delete next.nativePendingReply;
        store.db.prepare('UPDATE project_checks SET record=?,updated_at=? WHERE session_id=? AND run_id=? AND check_id=?')
          .run(JSON.stringify(next), next.updatedAt, sessionId, run.runId, current.checkId);
        return next;
      });
    } else if (current?.executionState === 'running') selected = current;
    else selected = selectProjectCheck(store, sessionId, run.runId);
    if (!selected) return { associated: false, reason: 'no-executable-check' };
    const latestRun = readProjectRun(store, sessionId, run.runId);
    let rawArguments = event.data?.arguments;
    if (rawArguments && typeof rawArguments === 'object') rawArguments = JSON.stringify(rawArguments);
    const begun = beginProjectAction(store, sessionId, run.runId, selected.checkId, {
      actionId: callId,
      toolName,
      toolArguments: String(rawArguments || '').slice(0, 8000),
      nativeTool: true,
      concurrentNative: NATIVE_CONCURRENCY_SAFE.has(toolName),
      targetUrl: nativeToolTarget(event.data?.arguments),
      controlRev: latestRun?.controlRev ?? run.controlRev,
    });
    return { associated: true, actionId: begun.action.actionId, checkId: selected.checkId,
      attemptId: begun.action.attemptId, currentCheckId: begun.run.currentCheckId, continuation };
  }

  const visible = textOfContent(event.data?.message?.content ?? event.data?.content).trim();
  if (!visible || !run.currentCheckId) return null;
  const check = readProjectCheck(store, sessionId, run.runId, run.currentCheckId);
  if (!check || check.executionState !== 'running') return null;
  const nativeActions = listProjectActions(store, sessionId, run.runId)
    .filter(action => action.checkId === check.checkId
      && action.attemptId === check.activeAttempt?.attemptId
      && !!(action.evidenceRef || action.requestRef || action.pageRef));
  if (!nativeActions.length) return null;
  const successful = nativeActions.some(action => action.executionState === 'completed');
  const failed = !successful && nativeActions.some(action => action.executionState === 'failed');
  const recorded = recordProjectCheck(store, sessionId, run.runId, check.checkId, {
    executionState: 'ended',
    verdict: failed ? 'blocked' : 'needs_check',
    checkedContent: visible.slice(0, 20000),
    gaps: failed
      ? '原生工具执行失败；程序已保存原始结果，需补齐条件后重试。'
      : '',
    actionRefs: check.actionRefs || [],
    evidenceRefs: check.evidenceRefs || [],
  });
  const withPending = { ...recorded, nativePendingReply: {
    text: visible.slice(0, 20000), at: nowIso(), ...contextOf(event),
    attemptId: check.activeAttempt?.attemptId || '',
  }, updatedAt: nowIso() };
  store.db.prepare('UPDATE project_checks SET record=?,updated_at=? WHERE session_id=? AND run_id=? AND check_id=?')
    .run(JSON.stringify(withPending), withPending.updatedAt, sessionId, run.runId, check.checkId);
  return { associated: true, checkId: withPending.checkId, verdict: withPending.verdict,
    actionRefs: withPending.actionRefs, evidenceRefs: withPending.evidenceRefs,
    pendingReply: true };
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
  return '继续案例测试：当前检查「' + current.requirement + '」'
    + (current.sourceLocation ? '（来源：' + current.sourceLocation + '）' : '')
    + '。已结束 ' + done + ' 项，可执行 ' + executable.length + ' 项，缺条件 ' + blocked + ' 项。'
    + '程序已绑定当前项；直接完成实际读取或执行，在正常答复中说明观察和缺口。'
    + '缺条件项不要阻塞独立项，也不要为登记另调用管理工具。';
}

/** 返回 null 表示不应自动接续；返回 { text, fingerprint, attempts } 表示可以接续一次。 */
export function projectContinuation(store, sessionId) {
  const run = activeProjectRun(store, sessionId);
  if (!run || run.state !== 'running') return null;
  if (run.executionAuthorized === false) return null;
  if (run.continuationPaused === true) return null;
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
  if (attempts >= 1) {
    setProjectRunState(store, sessionId, run.runId, 'paused', run.controlRev, {
      blocker: { code: 'no-progress', reason: '自动继续未能推进，已暂停', at: nowIso() },
    });
    return null;
  }
  const current = executable[0];
  let selectedRun = run;
  if (run.currentCheckId !== current.checkId) {
    selectProjectCheck(store, sessionId, run.runId);
    selectedRun = readProjectRun(store, sessionId, run.runId) || run;
  }
  return { runId: run.runId, controlRev: selectedRun.controlRev,
    text: continuationMessage(selectedRun, executable, checks), fingerprint, attempts };
}

/**
 * turn-stopping 的项目判定：只在一个地方决定 continue／waiting／completed。
 * 不调用模型、不发网络；调用方按 action 执行宿主 steer 或短事务状态同步。
 */
export function projectTurnDecision(store, sessionId) {
  const run = activeProjectRun(store, sessionId);
  if (!run || !['preparing', 'running'].includes(run.state)) return { action: 'none', run };
  if (run.executionAuthorized === false) return { action: 'none', run, reason: 'execution-not-authorized' };
  if (run.continuationPaused === true) return { action: 'none', run, reason: 'continuation-paused' };
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
    if (attempts >= 1) {
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
      ? '继续案例测试：读取来源 ' + where + '，在正常答复中说明它与当前检查的关系和缺口。程序保存实际读取事实。'
      : '继续案例测试：仍有来源区域待核对，例如 ' + where + '。请继续实际读取并在答复中说明结论；不要为登记另调用管理工具。';
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
    if (attempts >= 1) {
      setProjectRunState(store, sessionId, run.runId, 'paused', run.controlRev, {
        blocker: { code: 'no-progress', reason: '自动继续未能推进，已暂停', at: nowIso() },
      });
      return { action: 'none', run };
    }
    return {
      action: 'continue', run,
      continuation: {
        runId: run.runId, controlRev: run.controlRev, fingerprint, attempts,
        text: '继续案例测试：当前检查「' + current.requirement + '」'
          + (current.sourceLocation ? '（来源：' + current.sourceLocation + '）' : '')
          + '。程序已绑定当前项；直接读取相关原文并完成当前检查，在正常答复中说明观察和缺口。'
          + '缺条件项写清缺口，不要阻塞独立项，也不要为登记另调用管理工具。',
      },
    };
  }
  const blocked = checks.filter(check => check.verdict === 'blocked').length;
  const needsCheck = checks.filter(check => check.verdict === 'needs_check').length;
  const partial = checks.filter(check => check.verdict === 'not_found' && check.gaps).length;
  const expectationMet = checks.filter(check => check.verdict === 'expectation_met').length;
  if (Number(sourceProgress.pendingReview || 0) > 0) {
    return { action: 'waiting', run, blocker: { code: 'pending-source-review', reason: '还有 ' + sourceProgress.pendingReview + ' 个来源区域待核对，相关要求未被声明为完整' } };
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
    return {
      action: 'completed', run,
      summary: {
        ended: checks.length, executed: checks.length, expectationMet, blocked, needsCheck, partial,
        notApplicable: checks.filter(check => check.verdict === 'not_applicable').length,
        executionComplete: true,
        confirmationComplete: needsCheck === 0,
        hasGaps: blocked > 0 || partial > 0,
        coverageComplete: blocked === 0 && needsCheck === 0 && partial === 0,
      },
    };
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

// A provider can reject generation before turn-stopping is emitted. Status reads
// also synchronize terminal policy limits, so the project never stays "running".
export function synchronizeStoppedProjectRun(store, sessionId) {
  const policy = readTaskPolicy(store, sessionId);
  if (policy?.scenario !== 'project') return null;
  const run = activeProjectRun(store, sessionId);
  if (!run || !['preparing', 'running'].includes(run.state)) return run;
  const status = taskPolicyStatus(store, sessionId);
  if (!status.stopped || status.reason === 'plan_complete') return run;
  const reason = policy.modelBudgetBlock?.message || policy.blocker?.reason || ({
    time_budget_exhausted: '本次时间已用完，进度已保留；继续测试请新建下一次测试。',
    tool_budget_exhausted: '本次操作次数已用完，进度已保留；继续测试请新建下一次测试。',
  }[status.reason]) || '本次执行已停止，进度已保留。';
  return policy.cancelled
    ? setProjectRunState(store, sessionId, run.runId, 'cancelled', run.controlRev)
    : pauseProjectRun(store, sessionId, run.runId, { code: policy.modelBudgetBlock ? 'model-limit' : 'execution-stopped', reason }, run.controlRev);
}

/** 恢复前核对：仍在 paused/waiting 才回到 preparing，由执行端重新检查环境与剩余额度。 */
export function resumeProjectRun(store, sessionId, runId, expectedControlRev, runtimeId = '') {
  const run = readProjectRun(store, sessionId, runId);
  if (!run) throw new Error('project run not found');
  if (!['paused', 'waiting'].includes(run.state)) throw new Error('只有暂停或等待中的项目运行可以恢复');
  const unknown = listProjectActions(store, sessionId, runId).filter(action => action.sideEffectUnknown === true);
  if (unknown.length) throw new Error('存在结果未知的写入动作，请先核对业务状态再恢复');
  return taskTransaction(store, () => {
    const next = setProjectRunState(store, sessionId, runId, 'preparing', expectedControlRev ?? run.controlRev,
      { blocker: null, ownerPid: process.pid, ownerRuntimeId: String(runtimeId) });
    const status = taskPolicyStatus(store, sessionId);
    if (status.stopped) throw new Error('当前条件尚不能继续：' + status.reason);
    // 明确的继续重新建立接续窗口，已有已读范围和观测仍保留，不重置额度。
    const resumed = { ...next, lastContinuationFingerprint: '', continuationNoProgress: 0 };
    store.db.prepare('UPDATE project_runs SET record=? WHERE session_id=? AND run_id=?').run(JSON.stringify(resumed), sessionId, runId);
    return resumed;
  });
}

export function pauseProjectContinuation(store, sessionId, reason, expectedControlRev) {
  const run = activeProjectRun(store, sessionId)
  if (!run) throw new Error('没有活动的项目运行')
  if (expectedControlRev !== undefined && run.controlRev !== expectedControlRev)
    throw new Error('项目运行状态已变化，请刷新后重试')
  const next = { ...run, continuationPaused: true, continuationReason: String(reason || '').slice(0, 1000), updatedAt: nowIso() }
  store.db.prepare('UPDATE project_runs SET record=?,updated_at=? WHERE session_id=? AND run_id=?')
    .run(JSON.stringify(next), next.updatedAt, sessionId, run.runId)
  return next
}

export function resumeProjectContinuation(store, sessionId, expectedControlRev) {
  const run = activeProjectRun(store, sessionId)
  if (!run) throw new Error('没有活动的项目运行')
  if (expectedControlRev !== undefined && run.controlRev !== expectedControlRev)
    throw new Error('项目运行状态已变化，请刷新后重试')
  const next = { ...run, continuationPaused: false, continuationReason: '', updatedAt: nowIso() }
  store.db.prepare('UPDATE project_runs SET record=?,updated_at=? WHERE session_id=? AND run_id=?')
    .run(JSON.stringify(next), next.updatedAt, sessionId, run.runId)
  return next
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
  const blocked = checks.filter(check => check.verdict === 'blocked').length;
  const needsCheck = checks.filter(check => check.verdict === 'needs_check').length;
  const partial = checks.filter(check => check.verdict === 'not_found' && String(check.gaps || '').trim()).length;
  return setProjectRunState(store, sessionId, runId, 'completed', run.controlRev, {
    completedSummary: {
      ended: checks.filter(check => check.executionState === 'ended').length,
      executed: checks.filter(check => check.executionState === 'ended').length,
      expectationMet: checks.filter(check => check.verdict === 'expectation_met').length,
      blocked,
      needsCheck,
      partial,
      notApplicable: checks.filter(check => check.verdict === 'not_applicable').length,
      executionComplete: true,
      confirmationComplete: needsCheck === 0,
      hasGaps: blocked > 0 || partial > 0,
      coverageComplete: blocked === 0 && needsCheck === 0 && partial === 0,
    },
  });
}
