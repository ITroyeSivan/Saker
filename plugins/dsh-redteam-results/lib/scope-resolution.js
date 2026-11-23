import { createHash } from 'node:crypto'

export function scopeError(message, code = 'SCOPE_MISMATCH') {
  return Object.assign(new Error(message), { code })
}

export function sessionWorkspaceIdentity(session) {
  const candidates = [
    session?.workspaceId,
    session?.projectId,
    session?.cwd,
    session?.header?.workspaceId,
    session?.header?.projectId,
    session?.header?.cwd,
    session?.projectionValues?.workspaceId,
    session?.projectionValues?.projectId,
    session?.projectionValues?.cwd,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function workspaceKey(identity) {
  return 'workspace:' + createHash('sha256').update(String(identity)).digest('hex').slice(0, 32)
}

/**
 * Pure scope descriptor. The caller owns Host session lookup and project-row
 * lookup; this function only validates the combination and computes a stable
 * revision. It never reads or writes the database.
 */
export function resolveScopeDescriptor({
  entrySessionId,
  workspaceId,
  session,
  rootSession,
  projectKey,
  rootProjectKey,
  workspaceAccessible = false,
  cwd = '',
} = {}) {
  const entry = String(entrySessionId || '').trim()
  if (!entry) throw scopeError('缺少入口会话', 'MISSING_PREREQUISITE')
  if (!session) throw scopeError('入口会话不存在或当前不可访问')
  const identity = sessionWorkspaceIdentity(session)
  if (!identity) throw scopeError('入口会话缺少可信工作区身份')
  const requested = String(workspaceId || '').trim()
  if (requested && requested !== identity && workspaceAccessible !== true) {
    throw scopeError('工作区不存在或当前不可访问')
  }
  const effectiveWorkspaceId = requested || identity
  const effectiveProjectKey = String(projectKey || '')
  if (!effectiveProjectKey) throw scopeError('知识项目映射不可用')
  const root = String(rootSession || entry)
  const storedRootProject = String(rootProjectKey || '')
  const classification = storedRootProject && storedRootProject !== effectiveProjectKey
    ? 'legacy-unassigned'
    : 'resolved'
  const effectiveCwd = String(cwd || identity)
  const scopeRevision = createHash('sha256')
    .update([entry, root, effectiveWorkspaceId, effectiveProjectKey, effectiveCwd, storedRootProject].join('\0'))
    .digest('hex')
  return {
    entrySessionId: entry,
    rootId: root,
    workspaceId: effectiveWorkspaceId,
    workspaceKey: workspaceKey(effectiveWorkspaceId),
    projectKey: effectiveProjectKey,
    cwd: effectiveCwd,
    classification,
    scopeRevision,
  }
}

/** Reject a query whose root belongs to another project. */
export function assertRootScope({ rootProjectKey, projectKey, allowLegacy = false }) {
  if (!rootProjectKey || !projectKey) return
  if (rootProjectKey === projectKey) return
  if (allowLegacy) return
  throw scopeError('该记录不属于当前项目')
}
