// 工作键与租约（v6 第 8.3 节）：跨进程领取唯一，接手提高 generation，迟到结果只作历史。
//
// 唯一键包含目标入口、问题、身份关系与必要资料版本。领取/续租/完成都在事务里比较
// generation，旧工作者迟到的结果不会覆盖当前结果。租约过期不等于可以重放未知调用——
// 这里只标记可接手，是否重发由调用方按第 8.2 节先核对状态。
import { createHash, randomUUID } from 'node:crypto';
import { parseRowRecord } from './row-record.js';

export const WORK_LEASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_leases (
 work_key TEXT PRIMARY KEY, parent_session TEXT NOT NULL, worker TEXT NOT NULL,
 generation INTEGER NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL,
 heartbeat_at INTEGER NOT NULL, record TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_work_leases_parent ON work_leases(parent_session, state);
`;

/** 工作唯一键：目标入口 + 问题 + 身份关系 + 必要资料版本；大小写与空白归一。 */
export function workKey(input = {}) {
  const parts = ['endpoint', 'question', 'identity', 'materialRevision'].map(field => String(input[field] ?? '').trim().toLowerCase());
  const endpoint = (() => { try { return new URL(input.endpoint).href; } catch { return parts[0]; } })();
  return createHash('sha256').update(JSON.stringify([endpoint, parts[1], parts[2], parts[3]])).digest('hex');
}

function read(store, key) {
  const row = store.db.prepare('SELECT * FROM work_leases WHERE work_key=?').get(key);
  if (!row) return null;
  let record;
  try { record = parseRowRecord({ record: row.record }, { table: 'work_leases', id: key }); }
  catch { record = { history: [], result: null }; }
  return { ...record, workKey: row.work_key, parentSession: row.parent_session, worker: row.worker,
    generation: row.generation, state: row.state, expiresAt: row.expires_at, heartbeatAt: row.heartbeat_at };
}
/** 依赖资料 ID 列表：去重、去空、限长，避免把任意输入整段塞进租约记录。 */
function normalizeMaterialIds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const id = String(item ?? '').trim().slice(0, 200);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= 50) break;
  }
  return out;
}
function write(store, key, row) {
  store.db.prepare('INSERT INTO work_leases(work_key,parent_session,worker,generation,state,expires_at,heartbeat_at,record,updated_at) VALUES(?,?,?,?,?,?,?,?,?) '
    + 'ON CONFLICT(work_key) DO UPDATE SET worker=excluded.worker,generation=excluded.generation,state=excluded.state,expires_at=excluded.expires_at,heartbeat_at=excluded.heartbeat_at,record=excluded.record,updated_at=excluded.updated_at')
    .run(key, row.parentSession, row.worker, row.generation, row.state, row.expiresAt, row.heartbeatAt,
      JSON.stringify({ history: row.history ?? [], result: row.result ?? null, materialIds: normalizeMaterialIds(row.materialIds) }), new Date().toISOString());
  return read(store, key);
}
const inTx = (store, work) => { store.db.exec('BEGIN IMMEDIATE'); try { const out = work(); store.db.exec('COMMIT'); return out; } catch (error) { store.db.exec('ROLLBACK'); throw error; } };

// 租约按父任务隔离：同一目标+问题在不同任务里是不同的工作，不能互相撞键。
const scopedKey = (parentSession, key) => String(parentSession) + ':' + key;

/** 领取或接手：无人持有、已释放或已过期时接手并把 generation+1；同一 worker 在租约内续租；其他持有者未过期时拒绝。 */
export function claimWork(store, parentSession, input = {}) {
  const prefix = String(parentSession) + ':';
  const key = typeof input.workKey === 'string' && input.workKey.startsWith(prefix)
    ? input.workKey
    : scopedKey(parentSession, input.workKey || workKey(input));
  const ttlMs = Number.isInteger(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : 5 * 60 * 1000;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  return inTx(store, () => {
    const current = read(store, key);
    if (current && current.state === 'claimed' && current.worker !== input.worker && current.expiresAt > now) {
      throw Object.assign(new Error('工作已被其他工作者领取，且租约未过期'), { code: 'work-lease-held', details: { worker: current.worker, expiresAt: current.expiresAt } });
    }
    const generation = current ? (current.state === 'claimed' && current.worker === input.worker ? current.generation : current.generation + 1) : 1;
    return write(store, key, { parentSession, worker: input.worker, generation, state: 'claimed', expiresAt: now + ttlMs, heartbeatAt: now,
      history: current?.history ?? [], result: current?.result ?? null,
      materialIds: input.materialIds !== undefined ? input.materialIds : (current?.materialIds ?? []) });
  });
}

/**
 * 依赖某条资料的工作（v6 第 8.3 节）：只返回声明了该 materialId 的租约，不做全局广播。
 * 调用方据此决定是否唤醒；这里不自己发消息，也不改工作状态。
 */
export function listWorkDependingOnMaterial(store, parentSession, materialId) {
  const id = String(materialId ?? '').trim();
  if (!id || !parentSession) return [];
  const out = [];
  let rows = [];
  try { rows = store.db.prepare('SELECT work_key FROM work_leases WHERE parent_session=?').all(parentSession); }
  catch { return out; }
  for (const row of rows) {
    const work = read(store, row.work_key);
    if (work && normalizeMaterialIds(work.materialIds).includes(id)) {
      out.push({ workKey: work.workKey, worker: work.worker, generation: work.generation, state: work.state });
    }
  }
  return out;
}

/** 续租：只有当前 generation 的持有者能续；否则视为丢失租约。 */
export function heartbeatWork(store, key, input = {}) {
  const ttlMs = Number.isInteger(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : 5 * 60 * 1000;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  return inTx(store, () => {
    const current = read(store, key);
    if (!current) throw new Error('工作不存在');
    if (current.state !== 'claimed') throw new Error('工作已结束，不能再续租');
    if (current.worker !== input.worker || current.generation !== input.generation) {
      throw Object.assign(new Error('租约已转移，本次续租无效'), { code: 'work-lease-lost', details: { generation: current.generation, worker: current.worker } });
    }
    return write(store, key, { ...current, expiresAt: now + ttlMs, heartbeatAt: now });
  });
}

/** 完成：只有当前 generation 能写结果；旧 generation 的迟到结果只追加到 history，不改变当前结果与状态。 */
export function completeWork(store, key, input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  return inTx(store, () => {
    const current = read(store, key);
    if (!current) throw new Error('工作不存在');
    if (current.generation !== input.generation || current.worker !== input.worker) {
      const history = [...(current.history || []), { generation: input.generation, worker: input.worker, result: input.result ?? null, at: now, superseded: true }].slice(-20);
      return { ...write(store, key, { ...current, history }), superseded: true };
    }
    return { ...write(store, key, { ...current, state: 'done', result: input.result ?? null, expiresAt: now }), superseded: false };
  });
}

export function releaseWork(store, key, input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  return inTx(store, () => {
    const current = read(store, key);
    if (!current) throw new Error('工作不存在');
    if (current.generation !== input.generation || current.worker !== input.worker) return { ...current, superseded: true };
    return write(store, key, { ...current, state: 'released', expiresAt: now });
  });
}

/** 把过期未续租的 claimed 工作标为 expired，供后续接手（不自动重放副作用）。 */
export function expireWorkLeases(store, parentSession, now = Date.now()) {
  const rows = store.db.prepare('SELECT work_key FROM work_leases WHERE parent_session=? AND state=? AND expires_at<=?').all(parentSession, 'claimed', now);
  for (const row of rows) store.db.prepare('UPDATE work_leases SET state=?,updated_at=? WHERE work_key=?').run('expired', new Date().toISOString(), row.work_key);
  return rows.map(row => row.work_key);
}

export function listWorkLeases(store, parentSession) {
  return store.db.prepare('SELECT work_key FROM work_leases WHERE parent_session=? ORDER BY updated_at DESC').all(parentSession)
    .map(row => { const lease = read(store, row.work_key);
      return { workKey: row.work_key, worker: lease.worker, generation: lease.generation, state: lease.state,
        expiresAt: lease.expiresAt, heartbeatAt: lease.heartbeatAt, result: lease.result, history: lease.history?.length ?? 0,
        materialIds: normalizeMaterialIds(lease.materialIds) }; });
}

export function newWorkerId() { return 'w-' + randomUUID(); }
