// One bridge for the official dsh subagent lifecycle.
//
// rc.2 flattens the activation request onto SubagentActivationSpec and removes
// the old single-child drain helper. rc.1 is kept readable only while the
// migration/rollback baseline still needs to start a task; both shapes go
// through this module so callers never guess the Host signature themselves.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function resolveHostRuntime(source = {}) {
  const subagents = source.subagents || source.get?.('subagents');
  const agents = source.agents || source.get?.('agents');
  if (!subagents?.startActivation) throw new Error('Desktop native activation lifecycle unavailable');
  // rc.2 removed the single-child drain helper; rc.1 may also expose the
  // whole-tree drain, so only the presence of drainChildren identifies rc.1.
  const rc2 = typeof subagents.drainChildren !== 'function';
  return { subagents, agents, shape: rc2 ? 'rc2' : 'rc1' };
}

export function createSubagentRunTracker(ctx) {
  const byChild = new Map();
  const start = info => {
    if (!info?.id) return;
    byChild.set(String(info.id), {
      runId: info.runId ? String(info.runId) : '',
      provider: info.provider ? String(info.provider) : '',
      parentSessionId: info.parentSessionId ? String(info.parentSessionId) : '',
      local: info.local === true,
    });
  };
  const end = info => {
    if (!info?.id) return;
    const current = byChild.get(String(info.id));
    if (current) byChild.set(String(info.id), { ...current, endedAt: Date.now(), stopReason: info.stopReason || '' });
  };
  const offStart = ctx?.on?.('subagent/start', start);
  const offEnd = ctx?.on?.('subagent/end', end);
  return {
    get(id) { return byChild.get(String(id || '')) || null; },
    dispose() {
      try { typeof offStart === 'function' ? offStart() : offStart?.dispose?.(); } catch { /* host owns listener cleanup */ }
      try { typeof offEnd === 'function' ? offEnd() : offEnd?.dispose?.(); } catch { /* host owns listener cleanup */ }
    },
  };
}

function hostName(value) {
  const name = String(value || '').trim();
  if (!name) return '';
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || name === 'lead')
    throw new Error('host subagent name must be 1-32 lower-case letters, digits or hyphens, start with a letter, and not be lead');
  return name;
}

export function activationSpec(runtime, spec) {
  const name = hostName(spec.name);
  const request = {
    provider: spec.provider || 'spawn',
    childId: spec.childId,
    label: String(spec.label || '').slice(0, 160),
    signal: spec.signal,
    delivery: spec.delivery || 'parent',
    ...(name ? { name } : {}),
  };
  if (runtime.shape === 'rc2') {
    return {
      ...request,
      parent: spec.parent,
      prompt: spec.prompt,
      ...(spec.maxDepth !== undefined ? { maxDepth: spec.maxDepth } : {}),
      ...(spec.agentOptions ? { agentOptions: spec.agentOptions } : {}),
    };
  }
  return {
    ...request,
    request: {
      parent: spec.parent,
      prompt: spec.prompt,
      ...(spec.maxDepth !== undefined ? { maxDepth: spec.maxDepth } : {}),
      ...(spec.agentOptions ? { agentOptions: spec.agentOptions } : {}),
    },
  };
}

export async function startHostActivation(runtime, spec) {
  const activation = await runtime.subagents.startActivation(activationSpec(runtime, spec));
  if (!activation || String(activation.childId) !== String(spec.childId))
    throw new Error('Host activation returned a different child identity; reconcile before retrying');
  return activation;
}

/**
 * Release exactly one activation and confirm the native child left the live
 * registry. A missing handle is never replaced by a whole-tree drain: that
 * would kill siblings and turn an unknown release into a false success.
 */
export async function releaseHostChild(runtime, { activation, childId, parent, timeoutMs = 2500 } = {}) {
  if (!childId) throw new Error('childId is required for release');
  const live = () => runtime.agents?.get?.(childId);
  if (!live() && !activation) return { released: true, via: 'already-settled' };
  if (activation?.dispose) {
    await activation.dispose();
  } else if (runtime.shape === 'rc1' && typeof runtime.subagents.drainChildren === 'function') {
    await runtime.subagents.drainChildren(parent, [childId]);
  } else {
    throw new Error('exact activation handle unavailable; native child release is unknown');
  }
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 2500);
  while (Date.now() < deadline) {
    if (!live()) return { released: true, via: activation?.dispose ? 'dispose' : 'drain' };
    await sleep(40);
  }
  throw new Error('native child remains live after release');
}
