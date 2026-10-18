// 从 DB 行里解出 JSON record 的统一入口。
//
// 为什么要专门做一层：直接把 `JSON.parse(row.record)` 写进各处，坏行冒出来的是
// "Unexpected token i in JSON at position 0" —— 用户看不到是哪张表、哪条会话，
// 只能看到一个"点了没反应"。这里把表名、会话/主键和原因一起带上，并且**失败即停**：
// 调用方不允许把坏行当成"没有这一行"（那会静默放宽额度或漏掉子代理占用）。
export class CorruptRecordError extends Error {
  constructor(table, key, id, cause) {
    super(`${table} 的行记录已损坏（${key}=${id}）：${cause?.message ?? '无法解析 JSON'}。`
      + '该行需要人工确认后再修复或删除；在此之前相关操作会明确失败，不会按默认值继续。');
    this.name = 'CorruptRecordError';
    this.code = 'record-corrupt';
    this.table = table;
    this.rowKey = key;
    this.rowId = id;
    this.cause = cause;
  }
}

export function parseRowRecord(row, { table, key = 'session_id', id } = {}) {
  if (!row) return null;
  try { return JSON.parse(row.record); }
  catch (cause) { throw new CorruptRecordError(table ?? 'unknown', key, id ?? row[key] ?? '?', cause); }
}
