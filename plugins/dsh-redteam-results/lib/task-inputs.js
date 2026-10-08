const startFields = ['mode', 'question', 'target', 'workflow', 'stop', 'toolCalls', 'minutes', 'workers', 'discoveryCalls'];
const progressFields = ['planComplete', 'queueComplete', 'regularComplete', 'ndayComplete'];
function document(value, label) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error(`${label} 必须为不超过8192字符的JSON对象`);
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} 必须为JSON对象`);
  return parsed;
}
export function taskStartInput(args) {
  if (args.policy !== undefined) {
    if (startFields.some(key => args[key] !== undefined)) throw new Error('start使用独立字段或旧policy JSON，不能混用');
    return document(args.policy, 'policy');
  }
  const budget = Object.fromEntries(['toolCalls', 'minutes', 'workers', 'discoveryCalls']
    .filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  return { ...Object.fromEntries(['mode', 'question', 'target', 'workflow', 'stop']
    .filter(key => args[key] !== undefined).map(key => [key, args[key]])), budget };
}
export function taskProgressInput(args) {
  const progress = args.progress === undefined ? {} : document(args.progress, 'progress');
  for (const key of progressFields) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`);
    if (Object.hasOwn(progress, key) && progress[key] !== args[key]) throw new Error(`${key} 的JSON与独立字段冲突`);
    progress[key] = args[key];
  }
  if (!Object.keys(progress).length) throw new Error('progress需要完成标志或进度说明');
  return progress;
}
