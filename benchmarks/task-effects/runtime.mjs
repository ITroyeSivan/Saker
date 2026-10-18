import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

/** Explicit host preset: a user's selected default is never a control group. */
/**
 * 解析对照用的 preset 文档。**摘要前要做路径归一**：pentest 文档里会带上
 * `<DSH_HOME>\profiles\desktop\skills\` 这类绝对路径（技能目录），不同隔离 home
 * 的同一 preset 会得到不同摘要 —— 实测（probea/probeb 两次隔离实例）pentest 摘要不同、
 * standard 相同。归一后摘要只反映组合本身，跨实例契约才成立。
 */
export async function resolveComparisonPreset(registry, variant, { normalizePaths = [] } = {}) {
  const id = variant === 'plain-agent' ? 'standard' : 'pentest';
  const resolved = await registry.resolve(id);
  if (resolved.id !== id || resolved.broken) throw new Error(`comparison preset ${id} unavailable: ${resolved.broken ?? resolved.id}`);
  const document = await registry.readDocument(id);
  if (variant === 'plain-agent' && /@dsh-external\/|dsh-saker/.test(document.content)) {
    throw new Error('standard preset contains Saker plugins; plain control is contaminated');
  }
  const normalize = text => {
    let out = text;
    for (const value of [...new Set(normalizePaths)].filter(path => typeof path === 'string' && path.trim()).sort((a, b) => b.length - a.length)) {
      for (const form of [value, value.replaceAll('\\', '/')]) out = out.split(form).join('<root>');
    }
    return out;
  };
  return { id, content: document.content, compositionDigest: createHash('sha256').update(normalize(document.content)).digest('hex') };
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
