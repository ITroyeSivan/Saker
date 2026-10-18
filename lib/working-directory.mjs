import process from 'node:process'

/**
 * dsh 0.2.1 keeps `session.header.cwd` as the original project and exposes the
 * effective, user-switchable directory through the `workingDirectory` service.
 * Plugins that resolve relative paths must read the service, not the header.
 */
export function workingDirectoryService(ctx) {
  try {
    return ctx?.get?.('workingDirectory') ?? ctx?.workingDirectory ?? null
  } catch {
    return null
  }
}

/** Read the committed directory without filesystem I/O. */
export function sessionWorkingDirectory(ctx, session, fallback = process.cwd()) {
  const service = workingDirectoryService(ctx)
  if (service?.get && session) {
    try {
      const value = service.get(session)
      if (typeof value === 'string' && value) return value
    } catch {
      // Fall through to the legacy header only when the host service cannot
      // answer; a genuine host error is still visible to the caller below.
    }
  }
  const header = session?.header?.cwd ?? session?.cwd
  return typeof header === 'string' && header ? header : fallback
}

/** Validate the current directory before an operation that needs a live path. */
export async function ensureWorkingDirectory(ctx, agent, signal, fallback) {
  const service = workingDirectoryService(ctx)
  if (service?.ensure && agent) return await service.ensure(agent, signal)
  const header = agent?.session?.header?.cwd ?? agent?.session?.cwd
  if (typeof header === 'string' && header) return header
  if (fallback !== undefined) return fallback
  throw new Error('会话工作目录缺失')
}
