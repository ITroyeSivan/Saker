/**
 * Install reversible wrappers around the host preset roster.
 *
 * Kept separate from `preset-root.js` so the ownership/restore contract can be
 * tested without loading the YAML preset materializer.
 */
export function patchAgentPresets(presets, { filterPreset = () => true, defaultPreset = 'pentest' } = {}) {
  if (!presets || presets.__sakerRosterPatched) return () => {}

  const originalListValue = presets.list
  const originalList = presets.list.bind(presets)
  let active = true
  const patchedList = async function patchedList(...args) {
    const out = await originalList(...args)
    return active && Array.isArray(out) ? out.filter(filterPreset) : out
  }
  presets.list = patchedList

  let originalExportValue, patchedExport
  if (typeof presets.remoteExportList === 'function') {
    originalExportValue = presets.remoteExportList
    const originalExport = presets.remoteExportList.bind(presets)
    patchedExport = async function patchedExport(...args) {
      const out = await originalExport(...args)
      if (active && out && Array.isArray(out.presets)) return { ...out, presets: out.presets.filter(filterPreset) }
      return out
    }
    presets.remoteExportList = patchedExport
  }

  let originalResolveValue, patchedResolve
  if (typeof presets.resolve === 'function') {
    originalResolveValue = presets.resolve
    const originalResolve = presets.resolve.bind(presets)
    patchedResolve = async function patchedResolve(id, ...rest) {
      // Roster visibility is not a resolution permission. The host resolves
      // undefined to its configured default, and old hidden sessions must resume.
      return await originalResolve(id, ...rest)
    }
    presets.resolve = patchedResolve
  }

  const hasConfig = !!(presets.config && typeof presets.config === 'object')
  const hadDefault = hasConfig && Object.hasOwn(presets.config, 'default')
  const originalDefault = hadDefault ? presets.config.default : undefined
  if (hasConfig) presets.config.default = defaultPreset

  Object.defineProperty(presets, '__sakerRosterPatched', { value: true, configurable: true })
  return function restoreAgentPresets() {
    if (!active) return
    active = false
    if (presets.list === patchedList) presets.list = originalListValue
    if (originalExportValue !== undefined && presets.remoteExportList === patchedExport) presets.remoteExportList = originalExportValue
    if (originalResolveValue !== undefined && presets.resolve === patchedResolve) presets.resolve = originalResolveValue
    if (hasConfig && presets.config.default === defaultPreset) {
      if (hadDefault) presets.config.default = originalDefault
      else { try { delete presets.config.default } catch { /* config may be frozen */ } }
    }
    try { delete presets.__sakerRosterPatched } catch { /* already restored */ }
  }
}
