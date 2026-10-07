// Native Desktop workers. Persist progress, release live children after work.
import { randomUUID } from 'node:crypto';
import { readTaskContext, saveTaskContext } from './task-context.js';
import { startTaskPolicy, taskPolicyStatus, readTaskPolicy, archiveTaskRound } from './task-policy.js';
import { normalizeTaskFlow } from './task-flow.js';
import { copySiteMaterials } from './business-materials.js';
export const SITE_WORKER_SCHEMA = `CREATE TABLE IF NOT EXISTS site_workers (
 parent_session TEXT NOT NULL, child_id TEXT PRIMARY KEY, site TEXT NOT NULL,
 record TEXT NOT NULL, UNIQUE(parent_session,site));`;
const activeStates = new Set(['starting', 'running', 'idle', 'closing', 'cleanup-failed']);
const text = (value, label, max = 1000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + ' must be bounded nonempty text');
  return value.trim();
};
const origin = value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('plain HTTP site required');
  return url.origin;
};
export function siteWorkerRows(store, parentId) {
  return store.db.prepare('SELECT record FROM site_workers WHERE parent_session=? ORDER BY rowid').all(parentId).map(row => JSON.parse(row.record));
}
export function siteWorkerParent(store, childId) {
  return store.db.prepare('SELECT parent_session FROM site_workers WHERE child_id=?').get(childId)?.parent_session;
}
function save(store, row) {
  store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?) ON CONFLICT(child_id) DO UPDATE SET record=excluded.record')
    .run(row.parentId, row.childId, row.site, JSON.stringify(row));
}
export function siteWorkerView(store, parentId) {
  const rows = siteWorkerRows(store, parentId);
  return { active: rows.filter(row => row.state !== 'released').length,
    workers: rows.filter(row => row.state !== 'released').concat(rows.filter(row => row.state === 'released').slice(-8)).map(({ childId, site, question, focus, state, report, error }) => ({ childId, site, question, focus, state,
      ...(report === undefined ? {} : { report }), ...(error === undefined ? {} : { error }) })), more: Math.max(0, rows.filter(row => row.state === 'released').length - 8) };
}
export function createSiteWorkers(ctx, getStore) {
  const service = key => ctx[key] || ctx.get?.(key), parents = new Map(), locks = new Set(), closing = new Map(), reportTimers = new Map();
  const runtime = () => {
    const subagents = service('subagents'), agents = service('agents');
    if (!subagents?.startContinuable || !subagents?.drainContinuableChildren || !subagents?.listDescendants || !agents?.get)
      throw new Error('Desktop native lifecycle controls unavailable; use the main agent');
    return { subagents, agents };
  };
  const parentIdOf = agent => {
    if (!agent?.session?.id || agent.session.header?.parentSession || siteWorkerParent(getStore(), agent.session.id)) throw new Error('only the main agent may manage workers');
    return String(agent.session.id);
  };
  async function reconcile(agent, signal) {
    const parentId = parentIdOf(agent), { subagents, agents } = runtime(), store = getStore();
    const descendants = await subagents.listDescendants(parentId, signal);
    if (descendants.some(row => row.kind === 'diagnostic')) throw new Error('worker inventory uncertain; no new delegation admitted');
    const live = descendants.filter(row => agents.get(row.id));
    for (const row of siteWorkerRows(store, parentId)) {
      if (agents.get(row.childId)) {
        if (row.state === 'released') { row.state = 'running'; save(store, row); }
        continue;
      }
      if (!activeStates.has(row.state) || row.state === 'cleanup-failed') continue;
      if (row.state !== 'starting' || row.runnerPid !== process.pid || descendants.some(child => child.id === row.childId)) await cleanup(agent, row.childId, 'confirm native settlement');
    }
    const retained = siteWorkerRows(store, parentId).filter(row => activeStates.has(row.state));
    return { count: new Set([...live.map(row => row.id), ...retained.map(row => row.childId)]).size };
  }
  async function cleanup(agent, childId, reason = 'task ended') {
    const parentId = parentIdOf(agent), store = getStore();
    const rows = siteWorkerRows(store, parentId).filter(row => !childId || row.childId === childId);
    if (childId && !rows.length) throw new Error('worker not owned by this task');
    if (!rows.length) return siteWorkerView(store, parentId);
    const { subagents, agents } = runtime();
    for (const row of rows) {
      clearTimeout(reportTimers.get(row.childId)); reportTimers.delete(row.childId);
      if (closing.has(row.childId)) { await closing.get(row.childId); continue; }
      if (!activeStates.has(row.state) && !agents.get(row.childId)) continue;
      row.state = 'closing'; row.reason = text(reason, 'reason'); save(store, row);
      const release = (async () => { try {
        if (row.startupRollbackUncertain && row.runnerPid === process.pid) throw new Error('startup rollback was uncertain; restart Desktop before releasing this reservation');
        await subagents.drainContinuableChildren(agent, [row.childId]);
        if (agents.get(row.childId)) throw new Error('native child remains live after release');
        const latest = siteWorkerRows(store, parentId).find(item => item.childId === row.childId);
        if (latest.report) row.report = latest.report;
        row.state = 'released'; row.releasedAt = Date.now(); delete row.error;
      } catch (error) { row.state = 'cleanup-failed'; row.error = String(error.message || error); }
      save(store, row); })();
      closing.set(row.childId, release);
      try { await release; } finally { closing.delete(row.childId); }
    }
    return siteWorkerView(store, parentId);
  }
  async function delegate(agent, input, signal) {
    const parentId = parentIdOf(agent);
    if (locks.has(parentId)) throw new Error('delegation already in progress');
    locks.add(parentId);
    try {
      const { subagents, agents } = runtime(), store = getStore(), state = taskPolicyStatus(store, parentId);
      if (!state.configured || state.stopped) throw new Error('an active bounded task is required');
      const focus = input.focus ?? state.policy.mode;
      if (focus !== state.policy.mode && !(state.policy.flow?.kind === 'regular-with-nday' && ['regular', 'nday'].includes(focus))) throw new Error('子代理方向必须属于当前已选择流程');
      const site = origin(input.site), question = text(input.question, 'question', 600), reason = text(input.reason, 'necessity', 600);
      if (!['large-site-materials', 'independent-site-research'].includes(input.need)) throw new Error('specific delegation need required');
      const context = readTaskContext(store, parentId);
      if (!context?.assets.some(asset => asset.inScope && origin(asset.url) === site)) throw new Error('site must be in the authorized task context');
      if (state.policy.target && origin(state.policy.target) !== site) throw new Error('delegation cannot expand the current site');
      const inventory = await reconcile(agent, signal), previous = siteWorkerRows(store, parentId).find(row => row.site === site);
      if (previous) return { reused: true, childId: previous.childId, ...siteWorkerView(store, parentId), note: 'same site retained; use send for an explicit continuation, no duplicate worker created' };
      if (inventory.count >= (state.policy.workerLimit ?? 1)) throw new Error('worker limit reached, including idle and failed-cleanup workers');
      const childId = randomUUID(), remaining = state.policy.budget.toolCalls - state.policy.used.toolCalls;
      const available = agent.ctx.tools.schemas(agent).map(row => row.name);
      const needsNday = focus === 'nday' || state.policy.flow?.kind === 'regular-to-nday' || state.policy.flow?.kind === 'regular-with-nday';
      if (needsNday && available.includes('tool_pack') && ['nday_catalog', 'nday_match', 'nday_policy_get'].some(name => !available.includes(name)))
        throw new Error('首次分派前请 tool_pack load nday，再重试；子会话会保存原工具清单，事后加载无法补齐');
      const nested = name => /^(?:subagent(?:_|$)|send_message$|interrupt_agent$|list_agents$|list_subagent_models$|workflow$)/.test(name);
      const deny = available.filter(nested);
      if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 12
        || input.tools.some(name => typeof name !== 'string' || !available.includes(name) || nested(name)))) throw new Error('select at most 12 available non-delegating tools');
      // Native cold resume restores the original tool filter. Approved Nday
      // handoff must retain its local catalog tools from the initial admission.
      const needed = name => /^(?:read|glob|grep|skill|redteam_(?:task|context|research|execution|method|finding_register|finding_update|checks)|saker_method|knowledge_(?:search|read))$/.test(name) || (needsNday && /^(?:tool_pack|nday_catalog|nday_match|nday_policy_get)$/.test(name));
      const allow = [...new Set([...available.filter(needed), ...(input.tools || [])])];
      const row = { parentId, childId, site, focus, question, reason, state: 'starting', createdAt: Date.now(), runnerPid: process.pid };
      save(store, row); parents.set(parentId, agent);
      try {
      const belongs = endpoint => { try { return origin(endpoint) === site; } catch { return false; } };
      saveTaskContext(store, childId, { ...context, assets: context.assets.filter(asset => belongs(asset.url)), requests: context.requests.filter(request => belongs(request.endpoint)), checks: context.checks.filter(check => belongs(check.endpoint)) });
      copySiteMaterials(store, parentId, childId, site);
      startTaskPolicy(store, childId, { mode: focus, question, target: site, stop: 'budget', parentSession: parentId,
        budget: { toolCalls: remaining, minutes: 15, discoveryCalls: Math.min(remaining, Math.max(0, state.policy.budget.discoveryCalls - state.policy.used.discoveryCalls)), workers: 0 } });
      const childPolicy = readTaskPolicy(store, childId);
      childPolicy.budget.deadline = Math.min(childPolicy.budget.deadline, state.policy.budget.deadline ?? Infinity);
      store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify(childPolicy), childId);
      const prompt = `Work only on ${site}. Focus: ${focus}. Question: ${question}. Need: ${reason}. Reuse saved redteam_context and task policy; never start/reset budgets or delegate.${needsNday ? ' Before using Nday tools, load the local nday pack via tool_pack; this does not contact the target or expand the saved filter.' : ''} Follow relevant evidence continuously; save unrelated leads without expanding. IP blocking or broken normal access: stop affected requests and report, no repeated workarounds. Before ending/waiting call redteam_task report with document {state:"completed"|"blocked"|"needs-user",summary:"facts, effects, missing conditions, next step"}. Evidence stays in this child session. HTTP 200 and callbacks alone do not prove impact.`;
        await subagents.startContinuable({ provider: 'spawn', childId, label: question.slice(0, 70), signal,
          request: { parent: agent, maxDepth: 1, toolFilter: { allow, deny }, prompt: [{ type: 'text', text: prompt }] } });
        const latest = siteWorkerRows(store, parentId).find(item => item.childId === childId);
        if (latest.state === 'starting') { latest.state = 'running'; save(store, latest); }
        if (!agents.get(childId)) await cleanup(agent, childId, 'confirm native settlement after admission');
        return { childId, ...siteWorkerView(store, parentId) };
      } catch (error) {
        row.state = 'cleanup-failed'; row.error = String(error.message || error); row.startupRollbackUncertain = error instanceof AggregateError; save(store, row);
        await cleanup(agent, childId, 'startup failed'); throw error;
      }
    } finally { locks.delete(parentId); }
  }
  async function send(agent, input, signal) {
    const parentId = parentIdOf(agent), store = getStore(), { subagents, agents } = runtime();
    if (locks.has(parentId)) throw new Error('worker admission already in progress');
    locks.add(parentId);
    try {
    if (!siteWorkerRows(store, parentId).some(row => row.childId === input.childId)) throw new Error('worker not owned by this task');
    const inventory = await reconcile(agent, signal), state = taskPolicyStatus(store, parentId);
    const row = siteWorkerRows(store, parentId).find(row => row.childId === input.childId);
    if (!state.configured || state.stopped) throw new Error('parent task stopped');
    if (['cleanup-failed', 'closing', 'starting'].includes(row.state)) throw new Error('worker lifecycle unresolved');
    if (!agents.get(row.childId) && inventory.count >= (state.policy.workerLimit ?? 1)) throw new Error('worker limit reached');
    const previousPolicy = readTaskPolicy(store, row.childId);
    if (previousPolicy?.parentRound !== state.policy.startedAt) {
      if (row.state !== 'released' || agents.get(row.childId)) throw new Error('previous round worker must be released before continuation');
      const context = readTaskContext(store, parentId), belongs = endpoint => { try { return origin(endpoint) === row.site; } catch { return false; } };
      if ((state.policy.target && state.policy.target !== row.site) || !context?.assets.some(asset => asset.inScope && belongs(asset.url))) throw new Error('continuation site must remain in the current authorized task');
      archiveTaskRound(store, row.childId, 'parent-round-continuation');
      saveTaskContext(store, row.childId, { ...context, assets: context.assets.filter(asset => belongs(asset.url)), requests: context.requests.filter(request => belongs(request.endpoint)), checks: context.checks.filter(check => belongs(check.endpoint)) });
      copySiteMaterials(store, parentId, row.childId, row.site);
      row.focus = state.policy.flow?.kind === 'regular-with-nday' ? (row.focus || state.policy.mode) : state.policy.mode;
      startTaskPolicy(store, row.childId, { mode: row.focus, question: text(input.message, 'continuation', 4000).slice(0,600), target: row.site, stop: 'budget', parentSession: parentId,
        budget: { toolCalls: state.policy.budget.toolCalls-state.policy.used.toolCalls, minutes: 15, discoveryCalls: Math.min(state.policy.budget.toolCalls-state.policy.used.toolCalls, Math.max(0, state.policy.budget.discoveryCalls-state.policy.used.discoveryCalls)), workers: 0 } });
      const next = readTaskPolicy(store, row.childId); next.budget.deadline = Math.min(next.budget.deadline, state.policy.budget.deadline ?? Infinity);
      store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify(next), row.childId);
    }
    if (previousPolicy?.parentRound === state.policy.startedAt && previousPolicy.mode !== state.policy.mode && state.policy.flow?.kind === 'regular-to-nday' && state.policy.flow.phase === 'nday') {
      if (row.state !== 'released' || agents.get(row.childId) || previousPolicy.blocker || previousPolicy.cancelled) throw new Error('先释放并处理子任务阻碍，再继续Nday');
      const next = { ...previousPolicy, mode: 'nday', flow: normalizeTaskFlow('single', 'nday'), planComplete: false, queueComplete: false };
      delete next.finishedAt; row.focus = 'nday';
      store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify(next), row.childId);
    }
    if (taskPolicyStatus(store, row.childId).stopped) throw new Error('child blocked or exhausted; reconcile before continuation');
    parents.set(parentId, agent);
    const message = text(input.message, 'continuation', 4000), previous = structuredClone(row);
    row.reports = [...(row.reports || []), ...(row.report ? [row.report] : [])].slice(-10);
    delete row.report; row.state = 'starting'; row.runnerPid = process.pid; save(store, row);
    try {
      const messageId = await subagents.sendMessage(agent, row.childId, [{ type: 'text', text: message }], { signal });
      const latest = siteWorkerRows(store, parentId).find(item => item.childId === row.childId);
      if (latest.state === 'starting') { latest.state = 'running'; save(store, latest); }
      if (!agents.get(row.childId)) await cleanup(agent, row.childId, 'confirm continuation settled');
      return { childId: row.childId, messageId, ...siteWorkerView(store, parentId) };
    } catch (error) {
      if (agents.get(row.childId)) { row.state = 'cleanup-failed'; row.error = 'continuation admission uncertain: ' + error.message; save(store, row); await cleanup(agent, row.childId, 'continuation failed'); }
      else save(store, previous);
      throw error;
    }
    } finally { locks.delete(parentId); }
  }
  async function report(agent, input, signal) {
    const store = getStore(), parentId = siteWorkerParent(store, agent.session.id);
    if (!parentId) throw new Error('only an owned worker may report');
    const row = siteWorkerRows(store, parentId).find(row => row.childId === agent.session.id);
    if (!['completed', 'blocked', 'needs-user'].includes(input.state)) throw new Error('end/wait report state required');
    row.report = { state: input.state, summary: text(input.summary, 'summary', 4000), at: Date.now(), source: 'submitted-worker-report, not a verified finding' }; save(store, row);
    const { subagents, agents } = runtime(), parent = agents.get(parentId); let delivered = false;
    try { if (!taskPolicyStatus(store, parentId).policy?.cancelled) { await subagents.sendMessage(agent, parentId, [{ type: 'text', text: `Site ${row.site}, worker ${row.childId}: ${input.state}. ${row.report.summary}. Read actual child evidence before accepting findings.` }], { signal }); delivered = true; } }
    catch (error) { row.error = 'report delivery failed: ' + String(error.message || error); save(store, row); }
    // Let the report tool settle and the child finish its final message first.
    // A bounded fallback releases a child that keeps going after reporting done.
    if (parent && !reportTimers.has(row.childId)) {
      const timeout = setTimeout(() => cleanup(parent, row.childId, 'reported end; final turn grace expired').catch(error => ctx.logger?.warn?.('worker cleanup: %s', error.message)), 15000);
      timeout.unref?.(); reportTimers.set(row.childId, timeout);
    }
    return { saved: true, delivered, releaseAfterTurn: !!parent };
  }
  ctx.on?.('agent/disposed', ({ agent }) => {
    const store = getStore(), parentId = siteWorkerParent(store, agent.session.id);
    if (parentId) {
      clearTimeout(reportTimers.get(agent.session.id)); reportTimers.delete(agent.session.id);
      const row = siteWorkerRows(store, parentId).find(row => row.childId === agent.session.id);
      if (row.state !== 'cleanup-failed') { row.state = 'released'; row.releasedAt = Date.now(); save(store, row); }
    }
    if (parents.has(agent.session.id)) { parents.delete(agent.session.id); return cleanup(agent, undefined, 'parent disposed'); }
  });
  ctx.on?.('agent/turn-stopping', async ({ agent, turn }) => {
    const store = getStore(), parentId = siteWorkerParent(store, agent.session.id);
    if (!parentId || agent.inbox?.hasPending === true) return;
    const row = siteWorkerRows(store, parentId).find(item => item.childId === agent.session.id);
    if (row.report) {
      const parent = service('agents')?.get(parentId);
      if (parent) setTimeout(() => cleanup(parent, row.childId, 'reported task ended').catch(error => ctx.logger?.warn?.('worker cleanup: %s', error.message)), 0);
      return;
    }
    let latest;
    if (agent.session.eventAt && Number.isSafeInteger(agent.session.seq)) {
      for (let index = agent.session.seq-1; index >= 0; index--) {
        const event = agent.session.eventAt(index);
        if (event?.type === 'assistant/message' && event.data.turn === turn) { latest=event; break; }
      }
    } else latest = agent.session.events?.findLast(event => event.type === 'assistant/message' && event.data.turn === turn);
    const message = latest?.data.message;
    const summary = message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 4000);
    await report(agent, { state: 'completed', summary: summary || '本轮子任务结束；未收到文字总结，请查看子会话的实际证据，不据此确认漏洞。' }, AbortSignal.timeout(5000));
    const parent = service('agents')?.get(parentId);
    if (parent) setTimeout(() => cleanup(parent, row.childId, 'task ended').catch(error => ctx.logger?.warn?.('worker cleanup: %s', error.message)), 0);
  });
  async function stopAndReport(parent, row, state) {
    if (closing.has(row.childId)) return;
    const { subagents, agents } = runtime(), store = getStore();
    if (!row.report) {
      row.report = { state: 'blocked', summary: state.policy?.blocker?.reason || ('子任务停止：' + state.reason),
        at: Date.now(), source: 'host-task-state', evidence: state.policy?.blocker?.evidence }; save(store, row);
      const child = agents.get(row.childId);
      if (child && !taskPolicyStatus(store, row.parentId).policy?.cancelled) {
        try { await subagents.sendMessage(child, row.parentId, [{ type: 'text', text: `站点${row.site}已停止请求：${row.report.summary}。证据：${row.report.evidence || row.childId}。不能继续绕行；请向用户汇报实际阻碍。` }], { signal: AbortSignal.timeout(5000) }); }
        catch (error) { row.error = 'stop report delivery failed: ' + error.message; save(store, row); }
      }
    }
    await cleanup(parent, row.childId, 'stopped or timed out');
  }
  const timer = setInterval(() => {
    for (const [id, parent] of parents) {
      try {
        for (const row of siteWorkerRows(getStore(), id)) if (activeStates.has(row.state)) {
          const state = taskPolicyStatus(getStore(), row.childId);
          if (state.stopped) stopAndReport(parent, row, state).catch(error => ctx.logger?.warn?.('worker cleanup: %s', error.message));
        }
      }
      catch (error) { ctx.logger?.warn?.('worker status: %s', error.message); }
    }
  }, 2000); timer.unref?.();
  return { delegate, send, report, cleanup, async status(agent, signal) { const id = parentIdOf(agent); parents.set(id, agent); await reconcile(agent, signal); return siteWorkerView(getStore(), id); },
    async dispose() { clearInterval(timer); for (const timeout of reportTimers.values()) clearTimeout(timeout); reportTimers.clear(); await Promise.allSettled([...parents.values()].map(parent => cleanup(parent, undefined, 'plugin unloaded'))); } };
}
