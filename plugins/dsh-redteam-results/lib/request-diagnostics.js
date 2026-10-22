// 本次模型输入分项（v6 第 6.3 节）：把当前会话最近一次请求拆成
// 固定说明、工具定义、任务事实、用户消息和历史，敏感字段遮蔽；
// 原始（已遮蔽的）记录另存私有目录，不随公开内容发布。
//
// 只做只读计算：读会话 surface 与最近一次 request/header，不访问目标、不调用模型。

import { redactText } from './redaction.js';

const B = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8');

/** 敏感字段遮蔽：请求原文、Cookie、令牌、私钥与常见密钥赋值都不回显。 */
export const maskSensitive = redactText;

/** 把一段消息内容取成可计量的文本（字符串或块数组都行）。
 * 宿主 system/message 的正文在 data.message，user/message 的正文在 data.content；
 * 两种结构都按同一函数读取，避免把真实系统文字计成 0。 */
function textOf(message) {
  const value = message?.message ?? message;
  const content = value?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('\n');
}

const BUCKETS = ['fixed', 'tools', 'taskFacts', 'user', 'history'];
export const BUCKET_LABELS = {
  fixed: '固定说明', tools: '工具定义', taskFacts: '任务事实', user: '用户消息', history: '历史',
};

/**
 * 从会话事件里算出分项字节数。`events` 为按时间顺序的 `{ type, data }` 列表，
 * `tools` 为最近一次 request/header 里的工具定义（可选）。
 * 运行时上下文快照按 section 名拆分：任务状态进「任务事实」，其余进「固定说明」。
 */
export function breakdownFromEvents(events, tools = []) {
  const buckets = Object.fromEntries(BUCKETS.map(name => [name, { bytes: 0, count: 0 }]));
  const add = (name, bytes) => { buckets[name].bytes += bytes; buckets[name].count += 1; };
  let toolsSeen = false;
  for (const event of events || []) {
    const type = event?.type;
    const data = event?.data;
    if (type === 'request/header') {
      const schemas = data?.header?.tools ?? data?.tools;
      if (Array.isArray(schemas)) { tools = schemas; toolsSeen = true; }
      continue;
    }
    if (type === 'system/message' || type === 'developer/message') { add('fixed', B(textOf(data))); continue; }
    if (type === 'assistant/message') { add('history', B(textOf(data))); continue; }
    if (type === 'tool/result') { add('history', B(textOf(data?.message))); continue; }
    if (type !== 'user/message') continue;
    const source = data?.source || {};
    if (source.kind === 'user') { add('user', B(textOf(data))); continue; }
    if (source.kind === 'runtime-context' && Array.isArray(source.sections)) {
      for (const section of source.sections) {
        const name = String(section?.name || '');
        const text = String(section?.text || '');
        if (name === 'saker-pentest-task-state') add('taskFacts', B(text));
        else add('fixed', B(text));
      }
      continue;
    }
    add('history', B(textOf(data)));
  }
  if (Array.isArray(tools) && tools.length) add('tools', B(tools));
  const items = BUCKETS.map(name => ({ name, label: BUCKET_LABELS[name], bytes: buckets[name].bytes, count: buckets[name].count }));
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  return { items, total, toolsSeen };
}

/** 明细视图用的紧凑文本；空项也保留，界面才能显示"这一项本次为 0"。 */
export function renderBreakdown(breakdown) {
  return (breakdown?.items || []).map(item => `${item.label} ${item.bytes} 字节`).join(' · ');
}

/**
 * 上下文增长（v6 第 10.5 节）：把这一次分项与上一次逐项相减。
 * 只做差值，不做趋势外推；没有上一次记录时返回 null，不编造基线。
 */
export function diagnosticsDelta(previous, current) {
  if (!previous || !current) return null;
  const before = new Map((previous.items || []).map(item => [item.name, Number(item.bytes) || 0]));
  return {
    total: (Number(current.total) || 0) - (Number(previous.total) || 0),
    items: (current.items || []).map(item => ({ name: item.name, label: item.label,
      bytes: (Number(item.bytes) || 0) - (before.get(item.name) || 0) })),
  };
}

/**
 * 私有目录里保存的原始记录（已遮蔽）：逐事件保留类型、字节数与截断后的文本。
 * 只用于本地诊断，不随报告或公开内容发布。
 */
export function maskedRecord(events, { maxChars = 400 } = {}) {
  return (events || []).map(event => {
    const type = event?.type ?? '';
    // request/header 不是文本事件：留工具名清单，方便核对"这次到底带了哪些定义"。
    if (type === 'request/header') {
      const schemas = event?.data?.header?.tools ?? event?.data?.tools ?? [];
      return { type, bytes: Array.isArray(schemas) ? B(schemas) : 0,
        tools: Array.isArray(schemas) ? schemas.map(t => t?.function?.name ?? t?.name).filter(Boolean).slice(0, 200) : [] };
    }
    const text = type === 'tool/result' ? textOf(event?.data?.message) : textOf(event?.data);
    return { type, bytes: B(text), text: maskSensitive(text).slice(0, maxChars) };
  });
}
