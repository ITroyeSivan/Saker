// A workflow is one task, with one clock, operation budget and worker ceiling.
export const FLOW_LABELS = {
  single: '只做当前模式',
  'regular-to-nday': '收集后自动接 Nday',
  'regular-with-nday': '常规与 Nday 同时进行'
};
export function normalizeTaskFlow(kind = 'single', mode = 'regular') {
  if (!Object.hasOwn(FLOW_LABELS, kind) || (kind !== 'single' && mode !== 'regular'))
    throw new Error('衔接流程只能从常规测试开始');
  return { kind, phase: kind === 'regular-with-nday' ? 'parallel' : mode,
    completed: { regular: false, nday: false }, history: [] };
}
export function advanceTaskFlow(policy, input, now) {
  if (input.cancelled) return { ...policy, cancelled: true };
  const flow = structuredClone(policy.flow || normalizeTaskFlow('single', policy.mode));
  if (flow.kind === 'single') {
    if ('regularComplete' in input || 'ndayComplete' in input) throw new Error('当前任务没有常规 / Nday 衔接步骤');
    return { ...policy, ...input };
  }
  const completion = input.planComplete === true || input.queueComplete === true;
  const before = flow.phase;
  if (flow.kind === 'regular-to-nday') {
    if (before === 'regular') {
      if (input.ndayComplete) throw new Error('先完成信息收集，再检查 Nday');
      if (completion || input.regularComplete) { flow.completed.regular = true; flow.phase = 'nday'; flow.needsContinuation = true; }
    } else {
      if (completion || input.ndayComplete) { flow.completed.nday = true; flow.phase = 'done'; flow.needsContinuation = false; }
    }
  } else {
    if (input.regularComplete) flow.completed.regular = true;
    if (input.ndayComplete) flow.completed.nday = true;
    if (input.regularComplete || input.ndayComplete) flow.needsContinuation = true;
    if (completion && !(flow.completed.regular && flow.completed.nday))
      throw new Error('常规与 Nday 必须分别报告完成，不能只结束其中一项就结束整个任务');
    if (flow.completed.regular && flow.completed.nday) { flow.phase = 'done'; flow.needsContinuation = false; }
  }
  if (flow.phase !== before || input.regularComplete || input.ndayComplete) {
    if (input.note !== undefined && (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 1000)) throw new Error('完成说明应为不超过1000字的文字');
    flow.history.push({ from: before, to: flow.phase, at: now, note: input.note || '模型报告本步骤完成，实际证据仍需复核' });
    flow.history = flow.history.slice(-20);
  }
  return { ...policy, flow, ...(flow.phase === 'nday' ? { mode: 'nday' } : {}),
    ...(input.cancelled ? { cancelled: true } : {}),
    planComplete: flow.phase === 'done', queueComplete: flow.phase === 'done' };
}
export function taskFlowPrompt(policy) {
  const flow = policy.flow;
  if (!flow || flow.kind === 'single') return '';
  const state = flow.kind === 'regular-to-nday'
    ? (flow.phase === 'regular'
      ? '先收集范围内的入口、功能和产品证据，保存到redteam_context。完成后cleanup释放全部子代理，再用redteam_task progress {regularComplete:true}；进入同一轮Nday，按已选交互频率自动继续或等桌面确认。'
      : '现在检查Nday：复用已保存的资产、产品条件、请求和已测记录，只挑相关公开漏洞。完成用progress {ndayComplete:true}。没有产品证据就说明缺口，不把指纹当漏洞。')
    : '常规与Nday共同推进：发现可靠产品线索后及时检查相关公开漏洞，同时继续具体业务问题。0个子代理时主代理交替完成；确有必要才delegate focus=nday或regular，同站复用。分别用progress {regularComplete:true}和{ndayComplete:true}报告完成，两项完成才结束。';
  return '流程：' + FLOW_LABELS[flow.kind] + '；当前步骤=' + flow.phase + '。' + state +
    '两个方向共用原范围、已用操作数、截止时间和子代理上限' + policy.workerLimit + '，不能扩范围、另开预算或按模式各派一组代理。按已选交互频率推进，受阻立即停止并汇报。';
}
