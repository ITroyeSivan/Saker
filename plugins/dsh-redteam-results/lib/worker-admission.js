// Process-local admission reservations shared by site workers and purpose tasks.
// The host runs one Desktop host process, so an in-memory reservation closes the
// check-then-start gap that two independent async checks otherwise leave open.
const reservations = new Map();

function setFor(parentId) {
  let set = reservations.get(parentId);
  if (!set) {
    set = new Set();
    reservations.set(parentId, set);
  }
  return set;
}

export function reserveWorkerSlot(parentId, limit, occupied, token) {
  if (!parentId || !token || !Number.isInteger(limit) || limit <= 0) return false;
  const set = setFor(parentId);
  if (occupied + set.size >= limit) return false;
  set.add(token);
  return true;
}

export function releaseWorkerSlot(parentId, token) {
  const set = reservations.get(parentId);
  if (!set) return false;
  const removed = set.delete(token);
  if (set.size === 0) reservations.delete(parentId);
  return removed;
}

export function reservedWorkerCount(parentId) {
  return reservations.get(parentId)?.size ?? 0;
}
