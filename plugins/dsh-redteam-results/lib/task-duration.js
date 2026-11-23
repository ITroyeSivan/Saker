/**
 * Actual task duration. Once a round has a terminal timestamp, is paused, or
 * reaches its hard deadline, the value must stop growing. Paused intervals are
 * excluded so a resumed task does not suddenly absorb wall-clock idle time.
 */
export function taskElapsed(policy, now = Date.now()) {
  const startedAt = Number(policy?.startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return { elapsedMs: null, startedAt: null, endedAt: null, cappedBy: 'unknown' };
  }
  let end = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  let cappedBy = 'now';
  const cap = (value, label) => {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0 && number < end) {
      end = number;
      cappedBy = label;
    }
  };
  cap(policy.finishedAt, 'finished');
  cap(policy.budget?.deadline, 'deadline');
  if (policy.pausedAt || policy.blocker?.recordedAt) cap(policy.pausedAt || policy.blocker.recordedAt, 'paused');
  const pausedElapsedMs = Math.max(0, Number(policy.pausedElapsedMs) || 0);
  const elapsedMs = Math.max(0, end - startedAt - pausedElapsedMs);
  return {
    elapsedMs,
    startedAt,
    endedAt: end < Number(now) ? end : null,
    cappedBy,
  };
}
