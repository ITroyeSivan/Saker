// 任务归档（v6 第 9.2 节）：一致快照 + 校验清单 + 隔离恢复。
//
// 归档包含会话设置、工作、发现、必要原文、引用与知识使用记录，以及 schema 版本与逐节摘要；
// 账号密钥不进归档（secretsExcluded），恢复后先标“未确认”，由用户重新绑定。
// 恢复写到一个**新任务 id**，不在日常数据上覆盖；调用方应在隔离目录先 verify 再导入。
import { createHash, randomUUID } from 'node:crypto';
import { SCHEMA_VERSION } from './store.js';

export const TASK_ARCHIVE_SCHEMA = 'saker.task-archive/1';

// 只有带 session_id 的表会进归档；表名是内部常量，不来自用户输入。
const TABLES = Object.freeze([
  'task_policy', 'task_flow_choice', 'task_choice', 'task_context', 'task_context_records',
  'findings', 'counters', 'execution_receipts', 'business_materials', 'task_policy_events',
  'task_rounds', 'knowledge_usage', 'work_leases', 'task_knowledge',
]);

const sha = value => createHash('sha256').update(value).digest('hex');
const hasColumn = (store, table, column) => store.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);

function archiveTables(store) {
  return TABLES.filter(table => hasColumn(store, table, 'session_id'));
}
function rowsOf(store, table, sessionId) {
  return store.db.prepare(`SELECT * FROM ${table} WHERE session_id=?`).all(sessionId);
}

/**
 * 导出一致快照：单个事务内读完所有分节，并给每节算摘要。
 * 秘密不进归档，只记标记；确保调用方不会把脱敏报告当成备份。
 */
export function exportTaskArchive(store, sessionId, { now = Date.now() } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('需要有效任务');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const sections = {};
    for (const table of archiveTables(store)) sections[table] = rowsOf(store, table, sessionId);
    store.db.exec('COMMIT');
    const digests = {};
    const counts = {};
    for (const [table, rows] of Object.entries(sections)) {
      digests[table] = sha(JSON.stringify(rows));
      counts[table] = rows.length;
    }
    return {
      manifest: { schema: TASK_ARCHIVE_SCHEMA, schemaVersion: SCHEMA_VERSION, sourceSession: sessionId,
        exportedAt: new Date(now).toISOString(), secretsExcluded: true, restoredState: 'unconfirmed',
        sections: counts, digests, note: '完整备份含必要原文；账号密钥不在此文件，恢复后需重新绑定。' },
      sections,
    };
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

/** 校验归档：schema、版本、逐节摘要与行列字段；返回 {ok, problems}。 */
export function verifyTaskArchive(archive) {
  const problems = [];
  if (!archive || typeof archive !== 'object') return { ok: false, problems: ['归档不是对象'] };
  const { manifest, sections } = archive;
  if (!manifest || manifest.schema !== TASK_ARCHIVE_SCHEMA) problems.push('归档 schema 不匹配');
  if (manifest && !Number.isInteger(manifest.schemaVersion)) problems.push('缺少 schema 版本');
  if (!sections || typeof sections !== 'object') problems.push('缺少分节数据');
  if (sections && manifest?.digests) {
    for (const [table, rows] of Object.entries(sections)) {
      if (!Array.isArray(rows)) { problems.push(table + ' 不是行数组'); continue; }
      if (manifest.digests[table] && sha(JSON.stringify(rows)) !== manifest.digests[table]) problems.push(table + ' 摘要不一致');
      for (const row of rows) {
        if (!row || typeof row !== 'object' || typeof row.session_id !== 'string') { problems.push(table + ' 行缺少 session_id'); break; }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 隔离恢复：先校验，再写入**新任务 id**；不改动源任务，恢复状态先标未确认。 */
export function importTaskArchive(store, archive, { sessionId = 'restored-' + randomUUID(), now = Date.now() } = {}) {
  const verdict = verifyTaskArchive(archive);
  if (!verdict.ok) throw Object.assign(new Error('归档校验失败：' + verdict.problems.join('；')), { code: 'task-archive-invalid', details: verdict });
  const existing = store.db.prepare('SELECT session_id FROM task_policy WHERE session_id=?').get(sessionId);
  if (existing) throw new Error('恢复目标已存在任务，请换一个新的任务 id，不要在已有数据上覆盖');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const [table, rows] of Object.entries(archive.sections)) {
      if (!rows.length) continue;
      // 自增整型主键（如 task_policy_events.id）由目标库重新分配，不能照抄原值，否则撞主键。
      const auto = new Set(store.db.prepare(`PRAGMA table_info(${table})`).all()
        .filter(column => column.pk === 1 && /INT/i.test(String(column.type))).map(column => column.name));
      const columns = Object.keys(rows[0]).filter(column => !auto.has(column));
      const placeholders = columns.map(() => '?').join(',');
      const statement = store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${placeholders})`);
      for (const row of rows) {
        const values = columns.map(column => column === 'session_id' ? sessionId : row[column]);
        statement.run(...values);
      }
    }
    // 恢复状态先标未确认：旧 Cookie/令牌不冒充可用，由用户重新绑定后再确认。
    const policyRow = store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(sessionId);
    if (policyRow) {
      const policy = JSON.parse(policyRow.record);
      policy.restored = { at: new Date(now).toISOString(), fromSession: archive.manifest.sourceSession, state: 'unconfirmed', secretsNeedRebind: true };
      store.db.prepare('UPDATE task_policy SET record=?,updated_at=? WHERE session_id=?').run(JSON.stringify(policy), new Date().toISOString(), sessionId);
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return { sessionId, restoredFrom: archive.manifest.sourceSession, state: 'unconfirmed', secretsNeedRebind: true,
    sections: archive.manifest.sections, note: '已写入新任务；账号密钥需重新绑定后再继续。' };
}
