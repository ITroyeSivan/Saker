// 按需的复核/报告原生任务：默认继承当前会话模型；用户显式选择时只覆盖 provider/model。
// 任务是有界的、按需创建的，不常驻三个助手；模型调用计入父任务共享预算。
import { randomUUID } from 'node:crypto';
import { readTaskPolicy, startTaskPolicy, taskPolicyStatus } from './task-policy.js';
import { writeTaskPolicy, ownedPurposeTasks } from './task-policy-record.js';
import { siteWorkerView, hostWorkerLimit } from './site-workers.js';
import { reserveWorkerSlot, releaseWorkerSlot } from './worker-admission.js';
import { readTaskContext } from './task-context.js';

const PURPOSE = Object.freeze({
  review: { label: '复核结果', question: '独立复核当前发现与证据', toolCalls: 6, modelCalls: 4, minutes: 5 },
  report: { label: '整理报告', question: '整理当前报告草稿', toolCalls: 3, modelCalls: 3, minutes: 5 },
});

export function createPurposeTasks(ctx, getStore) {
  const active = new Map();
  const service = key => ctx[key] || ctx.get?.(key);
  const runtime = () => {
    const subagents = service('subagents');
    if (!subagents?.startActivation) throw new Error('Desktop native activation lifecycle unavailable');
    return subagents;
  };

  async function run(parentAgent, purpose, signal) {
    if (!PURPOSE[purpose]) throw new Error('purpose must be review or report');
    const store = getStore();
    const parentId = parentAgent?.session?.id;
    if (!parentId) throw new Error('parent session required');
    const state = taskPolicyStatus(store, parentId);
    if (!state.configured || state.stopped) throw new Error('an active bounded task is required');
    const limit = Math.min(state.policy.workerLimit ?? 0, hostWorkerLimit(ctx));
    const siteActive = siteWorkerView(store, parentId).active;
    const token = randomUUID();
    if (!reserveWorkerSlot(parentId, limit, siteActive, token)) {
      throw new Error('worker limit reached; finish or release another subtask before starting ' + purpose);
    }
    const entry = { childId: token, parentId, parentAgent, controller: new AbortController() };
    entry.done = new Promise(resolve => { entry.settled = resolve; });
    active.set(token, entry);
    try {
      return await runAdmitted(parentAgent, purpose, entry, signal);
    } finally {
      releaseWorkerSlot(parentId, token);
      if (!readTaskPolicy(store, token)) active.delete(token);
      entry.finished = true;
      entry.settled();
    }
  }

  async function runAdmitted(parentAgent, purpose, entry, signal) {
    const spec = PURPOSE[purpose];
    if (!spec) throw new Error('purpose must be review or report');
    const store = getStore();
    const parentId = parentAgent?.session?.id;
    if (!parentId) throw new Error('parent session required');
    const state = taskPolicyStatus(store, parentId);
    if (!state.configured || state.stopped) throw new Error('an active bounded task is required');
    const selected = purpose === 'review' ? state.policy.reviewModel : state.policy.reportModel;
    let parentOptions;
    try {
      const subagentModule = await import('@deepseek-ai/dsh-subagent');
      parentOptions = subagentModule.parentAgentOptionsForDelegation(parentAgent);
    } catch { parentOptions = undefined; }
    const childAgentOptions = selected
      ? { ...(parentOptions || {}), provider: selected.provider, model: selected.model,
          ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) }
      : parentOptions;
    if (childAgentOptions?.provider && childAgentOptions?.model) {
      const llm = service('llm');
      if (typeof llm?.resolveModelInfo === 'function') {
        try {
          await llm.resolveModelInfo(childAgentOptions.provider, childAgentOptions.model, AbortSignal.timeout(10000));
        } catch (error) {
          throw new Error(`child LLM route preflight failed: ${error?.message || error?.code || String(error)}`);
        }
      }
    }
    const childId = entry.childId;
    signal?.throwIfAborted();
    entry.controller.signal.throwIfAborted();
    if (taskPolicyStatus(store, parentId).stopped) throw new Error('parent task stopped during activation preparation');
    startTaskPolicy(store, childId, {
      mode: state.policy.mode, question: spec.question, ...(state.policy.target ? { target: state.policy.target } : {}), stop: 'budget', parentSession: parentId,
      purposeTask: true,
      budget: { toolCalls: spec.toolCalls, minutes: spec.minutes, workers: 0 },
    });
    writeTaskPolicy(store, childId, { ...readTaskPolicy(store, childId), purpose,
      activationState: 'starting', runnerPid: process.pid, modelOptions: childAgentOptions || null,
      allowTargetNetwork: purpose === 'report' ? false : state.policy.allowTargetNetwork !== false,
      allowedTools: ['run_code', 'read', 'glob', 'grep', 'redteam_context', 'redteam_checks',
        'redteam_delivery', 'redteam_execution', 'redteam_research', 'knowledge_list', 'knowledge_search',
        'knowledge_read', 'nday_catalog', 'nday_metrics', 'nday_policy_get'],
    }, 'purpose-task-starting', { childId, purpose });
    // Persisted ownership takes over the reservation without an asynchronous gap.
    releaseWorkerSlot(parentId, childId);
    const context = readTaskContext(store, parentId);
    const counts = { findings: store.db.prepare("SELECT count(*) AS n FROM findings WHERE session_id=? AND mode='pentest'").get(parentId).n,
      requests: context?.requests?.length || 0, assets: context?.assets?.length || 0,
      checks: store.db.prepare('SELECT count(*) AS n FROM checked_items WHERE session_id=?').get(parentId).n,
      materials: store.db.prepare('SELECT count(*) AS n FROM business_materials WHERE session_id=?').get(parentId).n,
      receipts: store.db.prepare('SELECT count(*) AS n FROM execution_receipts WHERE session_id=?').get(parentId).n };
    const access = `父任务 ${parentId} 的当前已存记录数量：${JSON.stringify(counts)}。这些是本次实际统计；全为0表示没有可整理的记录，直接说明缺少资料并结束，不搜索、不猜ID。非空时：redteam_context kind=finding读发现索引，加id读详情；省略kind读请求/资产索引；kind=material读文件索引；redteam_checks读检查记录；redteam_execution action=detail加实际回执id读证据。工具自动定位父任务，不传sessionId，不读数据库、会话文件或插件源码。不调用redteam_delivery，它会写ZIP而非读取发现。`;
    const prompt = access + (purpose === 'review'
      ? '独立复核已有事实，不扩大授权范围。确需新发目标请求时遵守父任务当前范围、只读、确认和预算限制。最后直接回答结论（确认/挑战/条件不足）、事实、影响、缺项和下一步；不要调用redteam_task action=report。'
      : '整理已有内容为报告草稿；禁止新发任何目标请求。最后直接输出报告要点和缺项，不调用redteam_task action=report。');
    const subagents = runtime();
    let activation;
    try {
      activation = await subagents.startActivation({
        provider: 'spawn', childId, label: spec.label,
        signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(spec.minutes * 60 * 1000), ...(signal ? [signal] : [])]), delivery: 'caller',
        request: { parent: parentAgent, maxDepth: 1, prompt: [{ type: 'text', text: prompt }],
          ...(childAgentOptions ? { agentOptions: childAgentOptions } : {}) },
      });
    } catch (error) {
      const nested = Array.isArray(error?.errors) ? error.errors.map(item => item?.message || String(item)).join('; ') : '';
      // Aggregate rollback errors mean the host could not confirm release.
      if (error instanceof AggregateError || error?.errors?.length) {
        markChild(store, childId, 'cleanup-failed', String(error?.message || error));
      } else {
        markChild(store, childId, 'released'); active.delete(childId);
      }
      throw new Error(`purpose ${purpose} activation failed: ${error?.message || error?.code || nested || String(error)}`);
    }
    entry.activation = activation;
    markChild(store, childId, 'running');
    const abort = () => { cleanup(entry).catch(error => ctx.logger?.warn?.('purpose cleanup: %s', error.message)); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || entry.controller.signal.aborted) abort();
    try {
      const result = await activation.result;
      const output = (result?.output || []).filter(part => part?.type === 'text').map(part => String(part.text || '')).join('\n').trim();
      const stopReason = result?.stopReason || 'unknown';
      const diagnostic = String(result?.diagnostic || '').trim();
      const released = await cleanup(entry);
      return { ok: stopReason === 'completed' && released, childId, purpose, model: selected || null,
        stopReason, output, diagnostic,
        ...(!released ? { cleanupFailed: true, error: '助手释放未确认，名额已保留；请重试清理。' } : {}),
        ...(stopReason === 'completed' ? {} : { error: diagnostic || output || `purpose ${purpose} ended with ${stopReason}` }) };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (active.has(childId) && readTaskPolicy(store, childId)?.activationState !== 'cleanup-failed') await cleanup(entry);
    }
  }

  function markChild(store, childId, activationState, cleanupError) {
    const current = readTaskPolicy(store, childId);
    if (!current) return;
    writeTaskPolicy(store, childId, { ...current, activationState, cleanupError: cleanupError || null,
      ...(activationState === 'released' ? { cancelled: true, finishedAt: Date.now() } : {}) },
    'purpose-task-' + activationState, { childId });
  }
  async function cleanup(entry) {
    if (entry.cleanup) return entry.cleanup;
    if (!entry.activation && !entry.finished) { entry.controller.abort(); return false; }
    entry.cleanup = (async () => {
      try {
        markChild(getStore(), entry.childId, 'closing');
        if (entry.activation) await entry.activation.dispose();
        else {
          const agents = service('agents'), subagents = runtime();
          if (!agents?.get || !subagents.drainChildren) throw new Error('native cleanup confirmation unavailable');
          await subagents.drainChildren(entry.parentAgent, [entry.childId]);
        }
        if (service('agents')?.get?.(entry.childId)) throw new Error('native child remains live after release');
        markChild(getStore(), entry.childId, 'released');
        active.delete(entry.childId);
        return true;
      } catch (error) {
        markChild(getStore(), entry.childId, 'cleanup-failed', String(error?.message || error));
        return false;
      } finally { entry.cleanup = null; }
    })();
    return entry.cleanup;
  }
  const timer = setInterval(() => {
    for (const entry of active.values()) {
      try {
        if (taskPolicyStatus(getStore(), entry.parentId).stopped) {
          entry.controller.abort();
          cleanup(entry).catch(error => ctx.logger?.warn?.('purpose cleanup: %s', error.message));
        }
      } catch (error) { ctx.logger?.warn?.('purpose status: %s', error.message); }
    }
  }, 2000); timer.unref?.();
  ctx.on?.('agent/disposed', async ({ agent }) => {
    for (const entry of active.values()) if (entry.parentId === agent?.session?.id) {
      entry.controller.abort(); await cleanup(entry);
    }
  });

  return {
    run,
    activeCount: () => active.size,
    async cleanup(parentAgent, childId) {
      const parentId = parentAgent?.session?.id;
      for (const entry of active.values()) if (entry.parentId === parentId && (!childId || entry.childId === childId)) {
        entry.controller.abort(); await cleanup(entry);
        if (!entry.activation) await entry.done;
      }
      // Cold recovery must ask the official host to drain the recorded child before freeing capacity.
      for (const row of ownedPurposeTasks(getStore(), parentId)) {
        if (row.activationState === 'released' || (childId && row.childId !== childId) || active.has(row.childId)) continue;
        try {
          const agents = service('agents'), subagents = runtime();
          if (!agents?.get || !subagents.drainChildren) throw new Error('native cleanup confirmation unavailable');
          await subagents.drainChildren(parentAgent, [row.childId]);
          if (agents.get(row.childId)) throw new Error('native child remains live after release');
          markChild(getStore(), row.childId, 'released');
        } catch (error) { markChild(getStore(), row.childId, 'cleanup-failed', String(error?.message || error)); }
      }
      return ownedPurposeTasks(getStore(), parentId).filter(row => row.activationState !== 'released');
    },
    async dispose() {
      clearInterval(timer);
      for (const entry of active.values()) { entry.controller.abort(); await cleanup(entry); if (!entry.activation) await entry.done; }
      if (active.size) ctx.logger?.warn?.('purpose activations not confirmed released: %s', [...active.keys()].join(', '));
    },
  };
}
