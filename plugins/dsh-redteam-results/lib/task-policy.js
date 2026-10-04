// Persistent task limits evaluated by the official desktop's monotonic tool guard.
// Counts tool executions, including shell calls; it does not count HTTP requests
// launched inside a command. Such requests still need their separate tool limits.
import { allFindings } from './store.js';
import { findingDeliveryState } from './delivery.js';
import { readTaskContext } from './task-context.js';
import { readChecks } from './checked.js';
import { researchOperationBlock, hasResearch, researchNext } from './research.js';

const modes = new Set(['nday', 'regular', '0day']);
const stops = new Set(['first-high', 'first-rce', 'queue', 'budget']);
const localTools = new Set(['redteam_task', 'redteam_context', 'redteam_checks', 'redteam_delivery',
  'redteam_method', 'redteam_research', 'redteam_execution',
  'redteam_finding_register', 'redteam_finding_update', 'redteam_finding_delete', 'redteam_chain_reconcile',
  'read', 'write', 'edit', 'glob', 'grep', 'run_code', 'skill', 'tool_pack', 'saker_method',
  // Local catalog/status reads do not contact a target and need no invented scope.
  'nday_catalog', 'nday_policy_get', 'nday_metrics']);
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(label + ' must be an integer between ' + min + ' and ' + max);
  return value;
}
function boundedText(value, label, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + ' must be bounded nonempty text');
  return value.trim();
}
function siteOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid task target');
  return url.origin;
}
export function pauseTaskPolicy(store, sessionId, input, source = 'submitted-interruption-report') {
  const policy = readTaskPolicy(store, sessionId);
  if (!policy) throw new Error('task policy missing');
  if (!['ip-blocked', 'login-expired', 'normal-access-failed', 'service-unavailable', 'safety-policy', 'tool-policy', 'needs-user'].includes(input?.code)) throw new Error('invalid blocker');
  const blocker = { code: input.code, reason: boundedText(input.reason, 'reason'),
    evidence: boundedText(input.evidence, 'evidence'), source, recordedAt: Date.now(), conclusion: 'unknown; stop affected requests' };
  return write(store, sessionId, { ...policy, blocker });
}
export function resumeTaskPolicy(store, sessionId, note, source) {
  if (source !== 'desktop-user') throw new Error('resume requires the user to resolve the blocker');
  const policy = readTaskPolicy(store, sessionId);
  if (!policy?.blocker) throw new Error('task is not paused');
  const history = [...(policy.blockerHistory || []), { ...policy.blocker, resolvedAt: Date.now(), resolution: boundedText(note, 'resolution') }].slice(-20);
  const { blocker, ...rest } = policy;
  return write(store, sessionId, { ...rest, blockerHistory: history, needsBaselineRecheck: true });
}
export function acceptBaselineRecheck(store, sessionId, receiptId) {
  const policy = readTaskPolicy(store, sessionId);
  if (!policy?.needsBaselineRecheck) return;
  const row = store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?').get(sessionId, receiptId);
  const receipt = row && JSON.parse(row.record);
  if (!receipt || receipt.source !== 'host-http-execution' || receipt.outcome !== 'response' || receipt.status < 200 || receipt.status >= 300)
    throw new Error('successful host baseline recheck required');
  return write(store, sessionId, { ...policy, needsBaselineRecheck: false, baselineRechecked: { receiptId, at: Date.now(), limit: 'HTTP baseline restored; business permission still requires verification' } });
}
export function readTaskPolicy(store, sessionId) {
  const row = store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(sessionId);
  return row ? JSON.parse(row.record) : null;
}
export function chooseTaskMode(store, sessionId, mode) {
  if (!modes.has(mode)) throw new Error('invalid task mode');
  if (readTaskPolicy(store, sessionId)) throw new Error('任务已开始，不能切换流程或重置预算');
  store.db.prepare('INSERT INTO task_choice (session_id,mode) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode').run(sessionId, mode);
  return mode;
}
export function chosenTaskMode(store, sessionId) {
  return store.db.prepare('SELECT mode FROM task_choice WHERE session_id=?').get(sessionId)?.mode || null;
}
export function archiveTaskRound(store, sessionId, source, now = Date.now()) {
  if (!['desktop-user', 'parent-round-continuation'].includes(source)) throw new Error('new round requires an explicit Desktop action');
  const current = readTaskPolicy(store, sessionId);
  if (!current) throw new Error('no previous round');
  if (current.blocker || (source === 'desktop-user' && current.parentSession)) throw new Error('受阻任务或子任务不能自行开启新一轮');
  if (source === 'desktop-user' && (!taskPolicyStatus(store, sessionId, now).stopped || current.blocker))
    throw new Error('先结束当前任务；访问阻碍必须先处理，不能通过新一轮绕过');
  if (store.db.prepare('SELECT record FROM site_workers WHERE parent_session=?').all(sessionId)
    .some(row => JSON.parse(row.record).state !== 'released')) throw new Error('先确认全部子代理已释放');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('INSERT INTO task_rounds(session_id,started_at,record) VALUES(?,?,?)').run(sessionId, current.startedAt, JSON.stringify({ ...current, endedAt: now, source }));
    for (const row of store.db.prepare('SELECT id,record FROM research_hypotheses WHERE session_id=?').all(sessionId)) {
      const record = JSON.parse(row.record);
      if (!['active', 'supported'].includes(record.state)) continue;
      record.state = 'stopped'; record.reason = 'previous round archived; evidence and pending leads retained';
      store.db.prepare('UPDATE research_hypotheses SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(record), sessionId, row.id);
    }
    store.db.prepare('DELETE FROM task_policy WHERE session_id=?').run(sessionId);
    store.db.prepare('DELETE FROM task_choice WHERE session_id=?').run(sessionId);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return { archived: true, previousStartedAt: current.startedAt };
}
function write(store, sessionId, record) {
  const updatedAt = new Date().toISOString();
  store.db.prepare('INSERT INTO task_policy (session_id,record,updated_at) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record,updated_at=excluded.updated_at')
    .run(sessionId, JSON.stringify(record), updatedAt);
  return record;
}
export function startTaskPolicy(store, sessionId, input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('policy must be an object');
  const mode = input.mode === 'campaign' ? 'nday' : input.mode;
  const stop = input.stop || 'budget';
  if (!modes.has(mode) || !stops.has(stop)) throw new Error('invalid task mode or stop policy');
  const chosen = chosenTaskMode(store, sessionId);
  if (chosen && chosen !== mode) throw new Error('mode differs from the selected Desktop workflow');
  if (readTaskPolicy(store, sessionId)) throw new Error('task already started; budgets cannot be reset in this session');
  const toolCalls = integer(input.budget?.toolCalls, 'budget.toolCalls', 1, 10000);
  const discoveryCalls = mode === '0day' ? integer(input.budget?.discoveryCalls ?? Math.min(5, toolCalls), 'budget.discoveryCalls', 0, toolCalls) : 0;
  const minutes = input.budget?.minutes === undefined ? null : integer(input.budget.minutes, 'budget.minutes', 1, 10080);
  const question = input.question === undefined ? '有限观察已有目标，向用户建议具体研究问题' : boundedText(input.question, 'question', 600);
  const target = input.target === undefined ? '' : siteOrigin(input.target);
  const workerLimit = integer(input.budget?.workers ?? 1, 'budget.workers', 0, 2);
  const parentSession = store.db.prepare('SELECT parent_session FROM site_workers WHERE child_id=?').get(sessionId)?.parent_session;
  if (input.parentSession && input.parentSession !== parentSession) throw new Error('unowned worker parent');
  return write(store, sessionId, { mode, stop, question, target, workerLimit, ...(parentSession ? { parentSession } : {}),
    ...(parentSession ? { parentRound: readTaskPolicy(store, parentSession)?.startedAt } : {}),
    budget: { toolCalls, discoveryCalls, deadline: minutes === null ? null : now + minutes * 60000 },
    used: { toolCalls: 0, discoveryCalls: 0 }, startedAt: now, cancelled: false, planComplete: false, queueComplete: false });
}
export function updateTaskProgress(store, sessionId, input) {
  const current = readTaskPolicy(store, sessionId);
  if (!current) throw new Error('task policy missing');
  for (const key of Object.keys(input)) {
    if (!['cancelled', 'planComplete', 'queueComplete'].includes(key) || typeof input[key] !== 'boolean') throw new Error('progress accepts only boolean completion/cancellation fields');
    if (current[key] && !input[key]) throw new Error('finished task state cannot be reopened');
  }
  return write(store, sessionId, { ...current, ...input,
    ...(!current.finishedAt && (input.cancelled || input.planComplete || input.queueComplete) ? { finishedAt: Date.now() } : {}) });
}
export function researchReady(context) {
  // Input gate is also enforced by zday_pattern against the selected baseline.
  return !!context?.requests?.some(request => ['backend', 'api', 'web'].includes(request.kind) && request.valid === true
    && request.request?.trim() && /^HTTP\/\S+\s+2\d\d\b/i.test(request.response || '')
    && request.inputs?.some(input => input.name?.trim() && ['query', 'body', 'path', 'header'].includes(input.location) && input.evidenceIds?.includes(request.id))
    && context.assets?.some(asset => { try { return asset.inScope === true && asset.reachable === true && new URL(asset.url).origin === new URL(request.endpoint).origin; } catch { return false; } }));
}
export function taskPolicyStatus(store, sessionId, now = Date.now()) {
  const policy = readTaskPolicy(store, sessionId);
  if (!policy) return { configured: false, choice: chosenTaskMode(store, sessionId), stopped: false, reason: 'task_policy_missing' };
  const findings = allFindings(store, sessionId, 'pentest').filter(finding => {
    const state = findingDeliveryState(finding);
    return state.ready && state.reproductionVerified;
  });
  let reason = '';
  if (policy.blocker) reason = 'paused:' + policy.blocker.code;
  else if (policy.cancelled) reason = 'cancelled';
  else if (policy.stop === 'queue' && policy.queueComplete) reason = 'queue_complete';
  else if (policy.stop === 'budget' && policy.planComplete) reason = 'plan_complete';
  else if (policy.budget.deadline !== null && now >= policy.budget.deadline) reason = 'time_budget_exhausted';
  else if (policy.used.toolCalls >= policy.budget.toolCalls) reason = 'tool_budget_exhausted';
  else if (policy.stop === 'first-rce' && findings.some(finding => finding.proofKind === 'execution')) reason = 'first_verified_rce';
  else if (policy.stop === 'first-high' && findings.some(finding => ['high', 'critical'].includes(finding.secondRating))) reason = 'first_verified_high';
  const ready = policy.mode === '0day' ? researchReady(readTaskContext(store, sessionId)) : false;
  if (!reason && policy.parentSession) {
    const parent = taskPolicyStatus(store, policy.parentSession, now);
    if (!parent.configured || parent.stopped) reason = 'parent_task_stopped:' + parent.reason;
  }
  return { configured: true, stopped: !!reason, reason, policy, researchReady: ready,
    observationExhausted: policy.mode === '0day' && !ready && policy.used.discoveryCalls >= policy.budget.discoveryCalls,
    reviewedReproducedFindings: findings.length };
}
export function taskPrompt(state) {
  if (!state.configured) return state.choice ? '用户选择了/pentest-'+state.choice+'。围绕给定站点和具体问题设置有限预算；选择菜单没有开始测试。' : '渗透测试：先明确本轮站点和小问题；用户已给则直接推进，只有URL先有限观察并建议方向。';
  const policy=state.policy;
  return '本轮问题：'+policy.question+'；站点：'+(policy.target||'按已给授权范围，不能自行扩大')+'；重点='+policy.mode+'；操作='+policy.used.toolCalls+'/'+policy.budget.toolCalls+'；停止规则='+policy.stop+'。不要重置预算。相关线索连续推进，无关线索待办；缺关键资料、有效路径走不通或任务完成才集中讨论。小任务直接做，确需站点深入才delegate，结束或等待资料report/cleanup；子代理不能再派代理。'+(state.stopped?'目标操作已停止：'+state.reason+'。'+(policy.blocker?policy.blocker.reason+'；先向用户汇报，不能自动绕行或自行解除。':'只整理证据与交付。'):policy.needsBaselineRecheck?'用户已处理阻碍，先用redteam_execution run purpose=baseline复查已存正常GET/HEAD请求，然后继续原问题。':state.observationExhausted?'观察额度已用完。继续分析已有请求和相关材料，形成具体假设后再验证；没有有效入口才向用户说明缺少的资料。':'使用实际正常对照和影响证据；回执不等于漏洞，0Day材料研究不要求先有后台接口。');
}
export function taskOverview(store, sessionId) {
  const state = taskPolicyStatus(store, sessionId);
  const context = readTaskContext(store, sessionId);
  const checks = readChecks(store, sessionId);
  const gaps = (context?.checks || []).flatMap(check => {
    const missing = [];
    if (!check.productConfirmed) missing.push('产品待确认');
    if (!check.requestValid) missing.push('请求或身份待确认');
    if (!check.methodReviewed) missing.push('方法待审阅');
    for (const condition of check.conditions || []) if (condition.state === 'unknown') missing.push(condition.name + '未知');
    return missing.length ? [{ id: check.entryId, endpoint: check.endpoint, missing }] : [];
  });
  return { ...state, ...(state.configured && !state.stopped ? { next: researchNext(store, sessionId) } : {}), counts: { assets: context?.assets.length || 0, requests: context?.requests.length || 0,
    methods: context?.methods.length || 0, checks: checks.length, blocked: checks.filter(row => row.status === 'blocked').length,
    notTested: checks.filter(row => row.status === 'not-tested').length }, gaps: gaps.slice(0, 20), moreGaps: Math.max(0, gaps.length - 20) };
}
export function taskExecutionGuard(store, sessionId, name, now = Date.now(), { onReserve, baselineRecheck = false } = {}) {
  if (localTools.has(name)) return undefined;
  if (/^(?:subagent(?:_|$)|workflow$|send_message$)/.test(name)) return 'managed_delegation_required：小任务主代理直接做；确有必要使用redteam_task delegate/send，禁止绕过站点数量与清理限制。';
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const state = taskPolicyStatus(store, sessionId, now);
    let reason;
      if (!state.configured) reason = 'task_policy_missing：先调用redteam_task设置模式和任务预算，再执行目标操作。';
      else if (state.policy.parentSession && JSON.parse(store.db.prepare('SELECT record FROM site_workers WHERE child_id=?').get(sessionId)?.record || '{}').report)
        reason = 'worker_reported_finished：子任务已报告结束；只能整理最终回复，不能继续目标操作。';
    else if (state.stopped) reason = '任务已停止：' + state.reason + '；仅继续证据整理与交付，不能重置预算或继续目标操作。';
    else if (state.policy.needsBaselineRecheck && !baselineRecheck) reason = 'baseline_recheck_required：用户已处理阻碍，先用redteam_execution run purpose=baseline复查已存正常GET/HEAD请求，不能直接重试探针。';
    else if (!baselineRecheck && state.policy.parentSession && state.policy.mode === '0day' && !state.researchReady && name !== 'zday_pattern' && !hasResearch(store, sessionId)
      && readTaskPolicy(store, state.policy.parentSession).used.discoveryCalls >= readTaskPolicy(store, state.policy.parentSession).budget.discoveryCalls)
      reason = 'parent_observation_budget_exhausted：主任务共享观察额度已用完；分析已存材料，不能由另一个子代理继续扩大观察。';
    else if (!baselineRecheck && state.observationExhausted && name !== 'zday_pattern' && !hasResearch(store, sessionId)) reason = 'observation_budget_exhausted：停止扩大观察；先分析已有材料、请求和业务问题，形成具体假设，确实缺资料再讨论。';
    else if (!baselineRecheck && state.policy.mode === '0day' && name !== 'zday_pattern' && (state.researchReady || hasResearch(store, sessionId))) reason = researchOperationBlock(store, sessionId, { reserve: true }) || undefined;
    else if (!baselineRecheck && hasResearch(store, sessionId) && !['zday_pattern', 'nday_match', 'nday_scope_hunt', 'nday_priority_plan', 'attack_plan', 'asset_search', 'asset_search_batch', 'hunter'].includes(name)) {
      reason = researchOperationBlock(store, sessionId, { reserve: true }) || undefined;
    }
    if (!reason && state.configured && !state.stopped) {
      const policy = state.policy;
      policy.used.toolCalls++;
      if (policy.mode === '0day' && !state.researchReady) policy.used.discoveryCalls++;
      write(store, sessionId, policy);
      if (policy.parentSession) {
        const parent = readTaskPolicy(store, policy.parentSession);
        parent.used.toolCalls++;
        if (policy.mode === '0day' && !state.researchReady && parent.mode === '0day') parent.used.discoveryCalls++;
        write(store, policy.parentSession, parent);
      }
      if (onReserve) onReserve();
    }
    store.db.exec('COMMIT');
    return reason;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
