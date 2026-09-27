/**
 * Cross-version helpers for reading plugin configuration.
 *
 * dsh <= 0.1.6 exposed settings namespaces through `ctx.settings.get()` and
 * `ctx.settings.register()`. dsh 0.1.7 projects volatile Cordis Config fields
 * through the profile entry id instead: a plugin receives a stable `Volatile`
 * reference and other plugins read the resolved section from
 * `ctx.settings.describe()`.
 */

/** Return the plain object behind a 0.1.7 volatile Config reference. */
export function plainConfig(value, fallback = {}) {
  if (value && typeof value.get === 'function') {
    try {
      const current = value.get()
      if (current && typeof current === 'object') return current
    } catch {
      // Fall through to the caller-provided baseline.
    }
  }
  return value && typeof value === 'object' ? value : fallback
}

/** Read one plugin entry by profile entry id on both settings APIs. */
export function readSettingsSection(settings, namespace, fallback = undefined) {
  if (!settings) return fallback
  if (typeof settings.get === 'function') {
    try {
      const current = settings.get(namespace)
      return current === undefined ? fallback : current
    } catch {
      return fallback
    }
  }
  if (typeof settings.describe === 'function') {
    try {
      const row = settings.describe().find((candidate) => candidate?.ns === namespace)
      return row?.value === undefined ? fallback : row.value
    } catch {
      return fallback
    }
  }
  return fallback
}

/** Subscribe to committed volatile Config updates when the host exposes them. */
export function onVolatileUpdate(ctx, listener) {
  try {
    return ctx.on?.('loader/volatile-update', listener)
  } catch {
    return undefined
  }
}
