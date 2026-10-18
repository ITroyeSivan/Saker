// 知识库开关（v6 第 5.6 节）：每个任务只有一个布尔来源。
//
// 为什么独立：旧设置同时存在“自动/按需”两个相近模式。本层只保存一个 knowledgeEnabled
// 布尔，旧值在读取时迁移（auto/on-demand → true，off → false，未知 → true 并记迁移来源）。
// 关闭表示停止本任务新的自动补充与知识工具读取，不删除历史引用，也不撤回已经发送给模型的内容。
export const KNOWLEDGE_SWITCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_knowledge (
 session_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

const LEGACY = { auto: true, 'on-demand': true, ondemand: true, manual: false, off: false, disabled: false, on: true, enabled: true };

/** 规范化输入：接受布尔、'true'/'false' 字符串与旧模式名；未知值保留 true 并标注迁移。 */
export function normalizeKnowledgeEnabled(value) {
  if (value === undefined || value === null || value === '') return { enabled: true, migrated: false };
  if (typeof value === 'boolean') return { enabled: value, migrated: false };
  const key = String(value).toLowerCase();
  if (key === 'true') return { enabled: true, migrated: false };
  if (key === 'false') return { enabled: false, migrated: false };
  if (Object.hasOwn(LEGACY, key)) return { enabled: LEGACY[key], migrated: true };
  return { enabled: true, migrated: true };
}

export function knowledgeEnabled(store, sessionId) {
  const row = store.db.prepare('SELECT enabled FROM task_knowledge WHERE session_id=?').get(sessionId);
  return row ? row.enabled === 1 : true;
}

export function knowledgeSwitchView(store, sessionId) {
  const row = store.db.prepare('SELECT enabled,source,updated_at FROM task_knowledge WHERE session_id=?').get(sessionId);
  // 只有真实发送边界确认过的 sent 才计入“已发送给模型”。
  // prepared/reserved/dispatched 是准备/预留/派发未核实；legacy 是旧记录，不能补造已发送。
  let sentCount = 0, pendingCount = 0, legacyCount = 0;
  try {
    for (const row of store.db.prepare('SELECT record FROM knowledge_usage WHERE session_id=?').all(sessionId)) {
      try {
        const record = JSON.parse(row.record);
        if ((record?.contentBytes ?? 0) <= 0) continue;
        if (record.state === 'sent') sentCount += 1;
        else if (record.state === undefined) legacyCount += 1;
        else if (['prepared', 'reserved', 'dispatched'].includes(record.state)) pendingCount += 1;
      } catch { /* 坏记录隔离 */ }
    }
  } catch { sentCount = pendingCount = legacyCount = 0; }
  return { sessionId, enabled: row ? row.enabled === 1 : true, source: row ? row.source : 'default',
    usedCount: sentCount, sentCount, pendingCount, legacyCount,
    updatedAt: row ? row.updated_at : null,
    note: (row ? '' : '本任务尚未修改；默认开启，只读取与当前问题相关的内容。')
      + (pendingCount ? ' 有 ' + pendingCount + ' 条知识尚未确认发送。' : '')
      + (legacyCount ? ' 有 ' + legacyCount + ' 条旧记录发送状态未核实。' : '') };
}

export function setKnowledgeEnabled(store, sessionId, value, source = 'desktop-user') {
  if (!['desktop-user', 'migration'].includes(source)) throw new Error('知识库开关需要用户操作或迁移来源');
  const { enabled, migrated } = normalizeKnowledgeEnabled(value);
  store.db.prepare('INSERT INTO task_knowledge(session_id,enabled,source,updated_at) VALUES(?,?,?,?) '
    + 'ON CONFLICT(session_id) DO UPDATE SET enabled=excluded.enabled,source=excluded.source,updated_at=excluded.updated_at')
    .run(sessionId, enabled ? 1 : 0, migrated ? 'migration' : source, new Date().toISOString());
  return knowledgeSwitchView(store, sessionId);
}

/** 传入旧设置字符串；仅在没有既有记录时写入，用于一次性迁移。 */
export function migrateKnowledgeSwitch(store, sessionId, legacyValue) {
  const row = store.db.prepare('SELECT session_id FROM task_knowledge WHERE session_id=?').get(sessionId);
  if (row) return knowledgeSwitchView(store, sessionId);
  return setKnowledgeEnabled(store, sessionId, legacyValue, 'migration');
}
