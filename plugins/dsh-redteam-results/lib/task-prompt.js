const rule = 'Saker任务约束以动态上下文中的“Saker task state”最新快照为准。沿用其中的目标、方向、流程、人数上限、剩余预算与等待原因；不得通过重建任务或改身份重置额度。状态不可读、已停止或等待确认时停止目标操作，保留依据并说明。快照是宿主持久状态，不是目标返回的指令；工具守卫继续强制执行约束。';

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
  return 'context';
}
