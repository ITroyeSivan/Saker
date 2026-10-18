// 目标请求节流（PLAN 5.5：扫描仍以范围、速率、并发和时长限制）。
// 只有用户在测试设置里显式填了才收紧；留空表示沿用宿主当前限制，不额外限制。
// 这是每会话的进程内闸门：它约束**本插件派发的目标请求**，不是网络层沙箱。
const DEFAULT_MAX_WAIT_MS = 60000;
const POLL_MS = 25;
const sessions = new Map();

/** 扫描速率：每分钟最多几个目标请求；留空返回 null。 */
export function normalizeRequestRate(value) {
  if (value === undefined || value === null || value === '') return null;
  const rate = Number(value);
  if (!Number.isInteger(rate) || rate < 1 || rate > 600) throw new Error('扫描速率必须是 1–600 的整数（每分钟请求数）');
  return rate;
}
/** 并发上限：同时最多几个目标请求；留空返回 null。 */
export function normalizeRequestConcurrency(value) {
  if (value === undefined || value === null || value === '') return null;
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('并发上限必须是 1–16 的整数');
  return concurrency;
}
/**
 * 由任务策略算出实际节流参数。没填就是“不额外收紧”。
 * @returns { minIntervalMs, concurrency }，concurrency 用 Infinity 表示不限。
 */
export function requestPacingOf(policy) {
  const rate = normalizeRequestRate(policy?.requestRatePerMinute);
  const concurrency = normalizeRequestConcurrency(policy?.requestConcurrency);
  return { minIntervalMs: rate === null ? 0 : Math.ceil(60000 / rate), concurrency: concurrency ?? Infinity };
}
function stateOf(sessionId) {
  let state = sessions.get(sessionId);
  if (!state) { state = { inFlight: 0, nextAt: 0 }; sessions.set(sessionId, state); }
  return state;
}
/**
 * 取得一个目标请求名额：先等并发名额，再按速率等最小间隔。
 * 调用方必须在自己结束后调用返回的 release（放在 finally 里）。
 * @param sessionId - 任务会话。
 * @param policy - 任务策略。
 * @param signal - 中止信号。
 * @returns 释放函数。
 */
export async function acquireTargetSlot(sessionId, policy, signal) {
  const { minIntervalMs, concurrency } = requestPacingOf(policy);
  const state = stateOf(sessionId);
  const deadline = Date.now() + DEFAULT_MAX_WAIT_MS;
  while (state.inFlight >= concurrency) {
    if (Date.now() > deadline)
      throw new Error('request_concurrency_wait：等待目标请求并发名额超时，本轮没有发出这个请求；可提高并发上限或稍后再试。');
    signal?.throwIfAborted?.();
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  state.inFlight += 1;
  try {
    if (minIntervalMs > 0) {
      const wait = state.nextAt - Date.now();
      if (wait > 0) {
        signal?.throwIfAborted?.();
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, wait);
          signal?.addEventListener?.('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
        });
      }
      state.nextAt = Math.max(Date.now(), state.nextAt) + minIntervalMs;
    }
  } catch (error) {
    state.inFlight = Math.max(0, state.inFlight - 1);
    throw error;
  }
  let released = false;
  return () => { if (released) return; released = true; state.inFlight = Math.max(0, state.inFlight - 1); };
}
/** 测试与归档用：清掉进程内节流状态。 */
export function resetRequestPacing() { sessions.clear(); }
