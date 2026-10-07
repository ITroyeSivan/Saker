// Routine questions are configurable; task scope and stop conditions are not.
export const INTERACTION_LABELS = {
  continuous: '自主推进',
  milestone: '自主推进', // Saved 0.4.89 preference: autonomous + milestone reports.
  confirm: '关键节点确认',
  guided: '共同研判'
};
export const MAX_SITE_WORKERS = 16;
export function normalizeInteraction(value = 'continuous') {
  if (!Object.hasOwn(INTERACTION_LABELS, value)) throw new Error('invalid interaction frequency');
  return value;
}
export function normalizeReporting(value) {
  if (!['summary', 'milestone'].includes(value)) throw Error('invalid progress reporting');
  return value;
}
export function reportingFor(preference) {
  return normalizeReporting(preference?.reporting ?? (preference?.interaction === 'milestone' ? 'milestone' : 'summary'));
}
export function requiresCheckpoint(value) { return ['guided', 'confirm'].includes(value); }
export function interactionPrompt(value, child = false, reporting) {
  const mode = normalizeInteraction(value);
  const text = mode === 'guided'
    ? '共同研判：人提供入口、业务背景与怀疑点，优先围绕人的具体问题研究。完成当前已给方向后，列出观察事实、支持与反证、下一步候选及需要人判断的问题；先释放子代理，用redteam_task checkpoint等人补充思路或确认方向，避免逐个文件机械提问。'
    : mode === 'confirm'
      ? '关键节点确认：AI整理资料并提出下一步，在切换研究方向或阶段时说明依据、结果、缺口和建议，释放子代理；衔接用progress完成标记，其他节点用redteam_task checkpoint。等待桌面确认，不得自行进入下一步。'
      : '自主推进：在已给范围与预算内自行选择有依据的下一步，连续研究，不要求用户反复说继续。';
  const reports = normalizeReporting(reporting ?? reportingFor({ interaction: mode }));
  return '协作方式：' + INTERACTION_LABELS[mode] + '。' + (child
    ? '子任务向主代理report，用户交互与阶段确认由主代理负责。'
    : text + (reports === 'milestone' ? '进度汇报：每个有实际结果的阶段简短报告；自主推进时汇报后继续，无需等待回复。' : '进度汇报：结束时集中汇总；必要的研判和确认仍即时说明。'))
    + '沿具体入口、JS或请求建立业务假设，按证据反复核对；记录已审与未审、支持与反证，不用第一遍未发现问题推断全站安全。人的新怀疑点优先纳入下一步。'
    + '缺关键资料、需要登录、范围不清、正常访问失败或IP被封时停下说明；协作方式不改变范围或预算。';
}
