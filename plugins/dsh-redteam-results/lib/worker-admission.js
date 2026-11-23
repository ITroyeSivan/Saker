// Persistent short-lived worker reservations. The SQLite transaction closes the
// check-then-start race between two Desktop host processes; the process-local
// map remains only as a compatibility fallback for callers that have no store.
const localReservations = new Map();

export const WORKER_ADMISSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS worker_admissions (
  parent_session TEXT NOT NULL,
  token TEXT NOT NULL,
  owner_pid INTEGER NOT NULL DEFAULT 0,
  owner_runtime TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY(parent_session, token)
);
CREATE INDEX IF NOT EXISTS idx_worker_admissions_expiry
  ON worker_admissions(parent_session, expires_at);
`;

const isStore = value => !!(value && value.db && typeof value.db.prepare === 'function');
const localSet = parentId => {
  let set = localReservations.get(parentId);
  if (!set) {
    set = new Set();
    localReservations.set(parentId, set);
  }
  return set;
};
const ownerPid = value => {
  const pid = Number(value === undefined ? process.pid : value);
  return Number.isSafeInteger(pid) && pid >= 0 ? pid : 0;
};
const ownerRuntime = value => String(value || 'node').trim().slice(0, 120) || 'node';
const ownerAlive = pid => {
  const value = Number(pid);
  if (!Number.isSafeInteger(value) || value < 1) return false;
  try { process.kill(value, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH' && error?.code !== 'EINVAL'; }
};
const inTx = (store, work) => {
  store.db.exec('BEGIN IMMEDIATE');
  try { const out = work(); store.db.exec('COMMIT'); return out; }
  catch (error) { try { store.db.exec('ROLLBACK'); } catch { /* already closed */ } throw error; }
};
const pruneDead = (store, parentId) => {
  const rows = store.db.prepare('SELECT token,owner_pid FROM worker_admissions WHERE parent_session=?').all(parentId);
  for (const row of rows) {
    if (ownerAlive(row.owner_pid)) continue;
    store.db.prepare('DELETE FROM worker_admissions WHERE parent_session=? AND token=?').run(parentId, row.token);
  }
};

export function reserveWorkerSlot(storeOrParent, parentOrLimit, limitOrOccupied, occupiedOrToken, tokenOrOptions, maybeOptions) {
  // Old signature: reserveWorkerSlot(parentId, limit, occupied, token)
  if (!isStore(storeOrParent)) {
    const parentId = storeOrParent;
    const limit = parentOrLimit;
    const occupied = limitOrOccupied;
    const token = occupiedOrToken;
    if (!parentId || !token || !Number.isInteger(limit) || limit <= 0) return false;
    const set = localSet(parentId);
    if (occupied + set.size >= limit) return false;
    set.add(token);
    return true;
  }
  const store = storeOrParent;
  const parentId = String(parentOrLimit || '');
  const limit = Number(limitOrOccupied);
  const occupied = Number(occupiedOrToken) || 0;
  const token = String(tokenOrOptions || '');
  const options = maybeOptions || {};
  if (!parentId || !token || !Number.isInteger(limit) || limit <= 0) return false;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 5 * 60 * 1000;
  const pid = ownerPid(options.ownerPid);
  const runtime = ownerRuntime(options.ownerRuntime);
  return inTx(store, () => {
    pruneDead(store, parentId);
    const existing = store.db.prepare('SELECT owner_pid,owner_runtime FROM worker_admissions WHERE parent_session=? AND token=?').get(parentId, token);
    if (existing) {
      if (ownerAlive(existing.owner_pid) && Number(existing.owner_pid) !== pid) return false;
      store.db.prepare('UPDATE worker_admissions SET owner_pid=?,owner_runtime=?,expires_at=?,record=? WHERE parent_session=? AND token=?')
        .run(pid, runtime, now + ttlMs, JSON.stringify({ parentSession: parentId, token, ownerPid: pid, ownerRuntime: runtime, expiresAt: now + ttlMs }), parentId, token);
      return true;
    }
    const count = Number(store.db.prepare('SELECT count(*) AS n FROM worker_admissions WHERE parent_session=?').get(parentId)?.n || 0);
    if (occupied + count >= limit) return false;
    store.db.prepare('INSERT INTO worker_admissions(parent_session,token,owner_pid,owner_runtime,expires_at,created_at,record) VALUES(?,?,?,?,?,?,?)')
      .run(parentId, token, pid, runtime, now + ttlMs, now,
        JSON.stringify({ parentSession: parentId, token, ownerPid: pid, ownerRuntime: runtime, expiresAt: now + ttlMs }));
    return true;
  });
}

export function releaseWorkerSlot(storeOrParent, parentOrToken, tokenOrOptions, maybeOptions) {
  if (!isStore(storeOrParent)) {
    const parentId = storeOrParent;
    const token = parentOrToken;
    const set = localReservations.get(parentId);
    if (!set) return false;
    const removed = set.delete(token);
    if (set.size === 0) localReservations.delete(parentId);
    return removed;
  }
  const store = storeOrParent;
  const parentId = String(parentOrToken || '');
  const token = String(tokenOrOptions || '');
  const options = maybeOptions || {};
  if (!parentId || !token) return false;
  if (options.ownerPid !== undefined) {
    const result = store.db.prepare('DELETE FROM worker_admissions WHERE parent_session=? AND token=? AND owner_pid=?')
      .run(parentId, token, ownerPid(options.ownerPid));
    return Number(result.changes) > 0;
  }
  const result = store.db.prepare('DELETE FROM worker_admissions WHERE parent_session=? AND token=?').run(parentId, token);
  return Number(result.changes) > 0;
}

export function reservedWorkerCount(storeOrParent, parentOrOptions, maybeOptions) {
  if (!isStore(storeOrParent)) return localReservations.get(storeOrParent)?.size ?? 0;
  const store = storeOrParent;
  const parentId = String(parentOrOptions || '');
  const options = maybeOptions || {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return inTx(store, () => {
    pruneDead(store, parentId);
    // An expired row with a live owner is still an active reservation; expiry
    // alone must not make the last slot look free. Dead owners were pruned.
    return Number(store.db.prepare('SELECT count(*) AS n FROM worker_admissions WHERE parent_session=?').get(parentId)?.n || 0);
  });
}
