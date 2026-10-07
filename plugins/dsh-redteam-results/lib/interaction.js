// Routine questions are configurable; task scope and stop conditions are not.
export const INTERACTION_LABELS = {
  continuous: '仅必要时询问',
  milestone: '阶段汇报，自动继续',
  confirm: '阶段完成后等我确认'
};
export function normalizeInteraction(value = 'continuous') {
  if (!Object.hasOwn(INTERACTION_LABELS, value)) throw new Error('invalid interaction frequency');
  return value;
}
export function interactionPrompt(value, child = false) {
  const mode = normalizeInteraction(value);
  const text = mode === 'continuous'
    ? '仅必要时询问：在已给范围与预算内连续完成相关工作，不逐个疑点提问，不要求用户反复说继续；结束时集中汇总。'
    : mode === 'milestone'
      ? '阶段汇报，自动继续：每完成一个有实际结果的阶段，简短报告结果、缺口和下一步；汇报后继续，无需等待回复。'
      : '阶段完成后等我确认：完成一个阶段后汇报结果、缺口和下一步，释放子代理；衔接流程用progress完成标记，其他阶段用redteam_task checkpoint。等桌面“确认并继续”，不得自行进入下一阶段。';
  return '交互频率：' + INTERACTION_LABELS[mode] + '。' + (child
    ? '子任务向主代理report，用户交互与阶段确认由主代理负责。'
    : text) + '缺关键资料、需要登录、范围不清、正常访问失败或IP被封时立即停下集中说明；不因低交互设置绕过阻碍或预算。';
}
