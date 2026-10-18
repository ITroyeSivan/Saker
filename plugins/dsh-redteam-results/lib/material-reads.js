// 模型读取资料原文的记录（v6 第 5.4 节「模型是否读过」）。
//
// 只记**模型真的通过工具读了这条材料的原文**那一次；用户在本地点开详情、或把引用插进输入框，
// 都不算——那两种都不增加模型输入（第 5.4.1 节）。列表用 `kind:id` 作键，重读只更新最后一次。
export const MATERIAL_READS_SCHEMA = `
CREATE TABLE IF NOT EXISTS material_reads (
 session_id  TEXT NOT NULL,
 material_id TEXT NOT NULL,
 at          INTEGER NOT NULL,
 bytes       INTEGER NOT NULL DEFAULT 0,
 offset      INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (session_id, material_id)
);`;

// 本地查看记录（v6 第 5.4 节「'本地查看过'与'模型收到过'分别保存」）：
// 只记用户在本地点开过这条材料的详情；与模型读取分开保存，互不覆盖。
// 打开详情不创建模型回合、不增加模型输入（第 5.4.1 节），这里只是本地状态。
export const MATERIAL_VIEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS material_views (
 session_id  TEXT NOT NULL,
 material_id TEXT NOT NULL,
 at          INTEGER NOT NULL,
 PRIMARY KEY (session_id, material_id)
);`;

/** 列表/详情共用的键：请求用 `request:<id>:<revision>`，文件用 `file:<材料id>`。 */
export const materialReadKey = (kind, id) => String(kind || '') + ':' + String(id || '');

/** 记一次模型读取；同一材料只保留最后一次（读了多少、从哪开始、什么时候）。 */
export function recordMaterialRead(store, sessionId, { materialId, bytes = 0, offset = 0, at = Date.now() } = {}) {
  const key = String(materialId || '').trim();
  if (!sessionId || !key) throw new Error('记录模型读取需要会话与材料 id');
  const size = Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0;
  const from = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  const time = Number.isFinite(at) ? at : Date.now();
  store.db.prepare('INSERT INTO material_reads(session_id,material_id,at,bytes,offset) VALUES(?,?,?,?,?) '
    + 'ON CONFLICT(session_id,material_id) DO UPDATE SET at=excluded.at,bytes=excluded.bytes,offset=excluded.offset')
    .run(sessionId, key, time, size, from);
  return { materialId: key, at: time, bytes: size, offset: from };
}

/** 本会话已读过的材料（键 → 最后一次读取信息）；坏行不可能出现（列都是数值），只做空值兜底。 */
export function listMaterialReads(store, sessionId) {
  const out = new Map();
  if (!sessionId) return out;
  let rows = [];
  try { rows = store.db.prepare('SELECT material_id,at,bytes,offset FROM material_reads WHERE session_id=?').all(sessionId); }
  catch { return out; } // 老库还没建表时按"没读过"处理，不阻断列表
  for (const row of rows) out.set(String(row.material_id), { at: Number(row.at) || 0, bytes: Number(row.bytes) || 0, offset: Number(row.offset) || 0 });
  return out;
}

/** 记一次本地查看；同一材料只保留最后一次。 */
export function recordMaterialView(store, sessionId, { materialId, at = Date.now() } = {}) {
  const key = String(materialId || '').trim();
  if (!sessionId || !key) throw new Error('记录本地查看需要会话与材料 id');
  const time = Number.isFinite(at) ? at : Date.now();
  store.db.prepare('INSERT INTO material_views(session_id,material_id,at) VALUES(?,?,?) '
    + 'ON CONFLICT(session_id,material_id) DO UPDATE SET at=excluded.at')
    .run(sessionId, key, time);
  return { materialId: key, at: time };
}

/** 本会话本地看过的材料（键 → 最后一次查看时间）。 */
export function listMaterialViews(store, sessionId) {
  const out = new Map();
  if (!sessionId) return out;
  let rows = [];
  try { rows = store.db.prepare('SELECT material_id,at FROM material_views WHERE session_id=?').all(sessionId); }
  catch { return out; } // 老库还没建表时按"没看过"处理，不阻断列表
  for (const row of rows) out.set(String(row.material_id), { at: Number(row.at) || 0 });
  return out;
}
