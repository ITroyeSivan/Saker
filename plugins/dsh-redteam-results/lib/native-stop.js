// A native user cancellation reaches plugins as an aborted
// agent/turn-stopping signal. Persist that as a managed-root pause before any
// later continuation or child work can reuse the old admission epoch.
import { readTaskPolicy, pauseTaskPolicy } from './task-policy.js'

export function pauseRootForNativeStop(store, sessionId, {
  reason = '用户停止了当前生成',
  evidence = 'host agent/turn-stopping signal aborted',
} = {}) {
  const policy = readTaskPolicy(store, sessionId)
  if (!policy || policy.parentSession || policy.purposeTask || policy.cancelled || policy.blocker) return null
  return pauseTaskPolicy(store, sessionId, { code: 'needs-user', reason, evidence }, 'host-user-stop')
}
