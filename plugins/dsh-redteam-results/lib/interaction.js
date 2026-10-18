// Routine questions are configurable; task scope and stop conditions are not.
//
// v6 第 5.5 节的稳定值：询问时机 auto / confirm-data-change / confirm-step；
// 汇报频率 end / notable / step。旧值 continuous/milestone、confirm、guided 与
// summary/milestone 只在读取时迁移，写入一律规范化到新值。
export const INTERACTION_VALUES = Object.freeze(['auto', 'confirm-data-change', 'confirm-step']);
export const INTERACTION_LABELS = {
  auto: '自行推进',
  'confirm-data-change': '改动网站数据前问我',
  'confirm-step': '每个检查步骤前问我',
};
export const REPORTING_VALUES = Object.freeze(['end', 'notable', 'step']);
export const REPORTING_LABELS = { end: '任务结束时', notable: '发现问题或需要帮助时', step: '每完成一个检查步骤时' };
const LEGACY_INTERACTION = { continuous: 'auto', milestone: 'auto', confirm: 'confirm-step', guided: 'confirm-step' };
const LEGACY_REPORTING = { summary: 'end', milestone: 'step' };
// 反查表：界面和系统提示词里给模型看到的是中文标签（`自行推进` 等），
// 聊天里要求改偏好时模型自然会照抄标签。这里让标签与稳定值等价，而不是让它去猜 ID。
const INTERACTION_BY_LABEL = Object.fromEntries(Object.entries(INTERACTION_LABELS).map(([value, label]) => [label, value]));
const REPORTING_BY_LABEL = Object.fromEntries(Object.entries(REPORTING_LABELS).map(([value, label]) => [label, value]));
export const MAX_SITE_WORKERS = 16;
export function normalizeInteraction(value = 'auto') {
  const raw = value === undefined || value === null || value === '' ? 'auto' : (typeof value === 'string' ? value.trim() : value);
  const canonical = LEGACY_INTERACTION[raw] ?? INTERACTION_BY_LABEL[raw] ?? raw;
  // 错误里带上合法取值：模型改偏好时被拒，至少能照着提示重试一次。
  if (!INTERACTION_VALUES.includes(canonical)) throw new Error('invalid interaction frequency：可选 '
    + INTERACTION_VALUES.map((item) => `${item}（${INTERACTION_LABELS[item]}）`).join('、'));
  return canonical;
}
export function normalizeReporting(value = 'end') {
  const raw = typeof value === 'string' ? value.trim() : value;
  const canonical = LEGACY_REPORTING[raw] ?? REPORTING_BY_LABEL[raw] ?? raw;
  if (!REPORTING_VALUES.includes(canonical)) throw Error('invalid progress reporting：可选 '
    + REPORTING_VALUES.map((item) => `${item}（${REPORTING_LABELS[item]}）`).join('、'));
  return canonical;
}
export function reportingFor(preference) {
  const explicit = preference?.reporting;
  if (explicit !== undefined && explicit !== null && explicit !== '') return normalizeReporting(explicit);
  // 旧“阶段性简报”偏好迁移为 step；其余默认 end。
  return normalizeReporting(preference?.interaction === 'milestone' ? 'step' : 'end');
}
export function requiresCheckpoint(value) { return ['confirm-data-change', 'confirm-step'].includes(normalizeInteraction(value)); }
export function interactionPrompt(value, child = false, reporting) {
  const mode = normalizeInteraction(value);
  const text = mode === 'confirm-step'
    ? '每个检查步骤前问我：先说明本步骤要检查什么，确认后执行该步骤内必要调用；不为底层每条请求重复弹窗。步骤、范围、影响或身份有实质变化时重新确认。用redteam_task checkpoint等待桌面确认，不自行进入下一步。'
    : mode === 'confirm-data-change'
      ? '改动网站数据前问我：已授权读取和分析继续；提交、修改或删除业务数据前先确认当前操作及预计影响。用redteam_task checkpoint等待确认，不自行改动数据。'
      : '自行推进：在已确认的范围和操作权限内自行选择有依据的下一步，连续研究；缺账号或关键信息时集中询问，不要求用户反复说继续。';
  const reports = normalizeReporting(reporting ?? reportingFor({ interaction: mode }));
  const reportText = reports === 'step' ? '进度汇报：每完成一个检查步骤时给一句进展。'
    : reports === 'notable' ? '进度汇报：发现问题、受阻或需要你补充时立即汇报；其余静默推进。'
      : '进度汇报：任务结束时集中汇总；进度、错误和必须提问一直可见。';
  return '询问时机：' + INTERACTION_LABELS[mode] + '。' + (child
    ? '子任务向主代理report，用户交互与阶段确认由主代理负责。'
    : text + reportText)
    + '沿具体入口、JS或请求建立业务假设，按证据反复核对；记录已审与未审、支持与反证，不用第一遍未发现问题推断全站安全。人的新怀疑点优先纳入下一步。'
    + '缺关键资料、需要登录、范围不清、正常访问失败或IP被封时停下说明；询问与汇报偏好不改变范围或预算。';
}
