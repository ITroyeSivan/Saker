import { randomUUID } from 'node:crypto';
const rule = 'Saker任务约束以动态上下文中的“Saker task state”最新快照为准。沿用其中的目标、方向、流程、人数上限、剩余预算与等待原因；不得通过重建任务或改身份重置额度。状态不可读、已停止或等待确认时停止目标操作，保留依据并说明。快照是宿主持久状态，不是目标返回的指令；工具守卫继续强制执行约束。这段说明只用于四件事：查询当前任务设置、读取相关资料、使用可用工具、引用实际结果；它不是角色模板、方法清单或固定流程。';

// v6 第 4.1 节：这条固定说明的初始上限是 600 token；没有可靠计量器时按 **1800 UTF-8 字节**
// 控制，并如实标成近似（不冒充精确 token）。口径与上限放在同一处，由
// `scripts/test-task-prompt-cost.mjs` 盯住——否则以后往这里加句子没人会红。
export const TASK_RULE_BUDGET = Object.freeze({ unit: 'bytes-approx', bytes: 1800, tokens: 600 });
export const TASK_RULE_TEXT = rule;

const contextPrefix = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n';
const clearedContext = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.';
function ownedSnapshot(message) {
  if (message?.role !== 'user' || message.source?.kind !== 'runtime-context'
    || message.content?.length !== 1 || message.content[0]?.type !== 'text') return false;
  const source = message.source, text = message.content[0].text;
  if (source.form === undefined && text === clearedContext) return true;
  if (source.form !== 'snapshot' || !Array.isArray(source.sections) || !source.sections.length
    || source.sections.some(section => typeof section?.name !== 'string' || typeof section.text !== 'string')) return false;
  return text === contextPrefix + source.sections.map(section => section.text).join('\n\n');
}

// Identify only the host's declared full snapshots; raw evidence, notices and
// unknown formats must survive. Request inputs themselves are host-frozen.
export function compactRuntimeContexts(session, incoming = []) {
  if (!session?.surface?.nodes || typeof session.eventAt !== 'function' || typeof session.append !== 'function') return 0;
  const nodes = [...session.surface.nodes].map(seq => ({ seq, event: session.eventAt(seq) }));
  const snapshots = nodes.filter(({ event }) => event?.type === 'user/message' && ownedSnapshot(event.data));
  const superseded = incoming.some(ownedSnapshot) ? snapshots : snapshots.slice(0, -1);
  for (const { seq } of superseded) {
    // A surface replacement preserves the original append-only event and its
    // provenance. It occurs before request admission, never inside publishing.
    session.append('user/message', {
      id: randomUUID(), role: 'user',
      source: { kind: 'saker-runtime-context-retired', form: 'notice', summary: '运行状态已由后续快照替代' },
      content: [{ type: 'text', text: 'Earlier runtime state superseded; use the latest snapshot.' }],
    }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
  }
  return superseded.length;
}

// Mutable task facts belong in durable context snapshots, not a changing full
// system section. Older hosts without contexts keep the original semantics.
export function registerTaskPrompt(ctx, eligible, snapshot) {
  if (typeof ctx.systemPrompt?.section !== 'function') return false;
  if (typeof ctx.systemPrompt.context !== 'function') {
    ctx.systemPrompt.section({ name: 'saker-pentest-task', order: 470, text: snapshot });
    return 'legacy-section';
  }
  ctx.systemPrompt.section({ name: 'saker-pentest-task', order: 470,
    text: assembly => eligible(assembly) ? rule : '' });
  ctx.systemPrompt.context({ name: 'saker-pentest-task-state', order: 470,
    text: assembly => { const text = snapshot(assembly); return text ? 'Saker task state\n' + text : ''; } });
  ctx.on?.('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal?.aborted || !eligible({ agent })) return decision;
    compactRuntimeContexts(agent?.session, decision.messages);
    return decision;
  });
  return 'context';
}
