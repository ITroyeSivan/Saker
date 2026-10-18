// 三用途模型选择的统一规范化：provider/model 必须成对、长度有界，空值表示继承当前会话。
export function normalizeModelChoice(value, label = '模型') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw Error(label + '设置格式错误');
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const reasoningEffort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : '';
  if (!provider || !model) throw Error(label + '需要同时给出 provider 和 model');
  if (provider.length > 100 || model.length > 200 || reasoningEffort.length > 40) throw Error(label + '名称过长');
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}
