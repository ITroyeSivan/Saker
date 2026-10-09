import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

/** Explicit host preset: a user's selected default is never a control group. */
export async function resolveComparisonPreset(registry, variant) {
  const id = variant === 'plain-agent' ? 'standard' : 'pentest';
  const resolved = await registry.resolve(id);
  if (resolved.id !== id || resolved.broken) throw new Error(`comparison preset ${id} unavailable: ${resolved.broken ?? resolved.id}`);
  const document = await registry.readDocument(id);
  if (variant === 'plain-agent' && /@dsh-external\/|dsh-saker/.test(document.content)) {
    throw new Error('standard preset contains Saker plugins; plain control is contaminated');
  }
  return { id, content: document.content, compositionDigest: createHash('sha256').update(document.content).digest('hex') };
}

/** Shared-interface comparisons have zero workers; stop late local delegation registration. */
export function freezeSingleAgentRows(rows) {
  let changed = 0;
  const visit = entries => entries.map(row => {
    const value = { ...row };
    if (row.group === true && Array.isArray(row.config)) value.config = visit(row.config);
    else if (row.name === '@deepseek-ai/dsh-tool-subagent' && row.config?.modelSelectionSettings === true) {
      value.config = { ...row.config, modelSelectionSettings: false }; changed++;
    }
    return value;
  });
  return { rows: visit(rows), changed };
}

/** Measure admitted work to true idle, independently of RPC polling/cleanup. */
export function createRunClock(now = () => performance.now()) {
  let started = null, ended = null;
  return {
    start() { if (started === null) started = now(); },
    end() { if (started !== null && ended === null) ended = now(); },
    get started() { return started !== null; },
    get finished() { return ended !== null; },
    elapsedMs() { return started === null ? null : Math.max(0, Math.round((ended ?? now()) - started)); },
  };
}

/** All callers observe the same completion; stop is not terminal while cleanup runs. */
export function createRunStopper(cleanup) {
  let completion;
  return reason => completion ??= Promise.resolve().then(() => cleanup(reason));
}
