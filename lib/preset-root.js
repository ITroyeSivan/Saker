import { fileURLToPath } from 'node:url'

export const inject = ['agentPresets']

/**
 * Register the bundle-owned read-only preset root after the agentPresets
 * service exists. The presets stay inside the installed package — no copy is
 * made into the user's DSH_HOME, so updating the bundle swaps the modes
 * atomically and uninstalling removes them without residue.
 *
 * The Saker platform ships only two security modes (pentest / code-audit).
 * The harness's default agentPresets root additionally registers its
 * generic developer presets (cordis / minimal / ptc / standard) which have
 * nothing to do with the security workflow — exposing them on the hero
 * preset picker, settings, and subagent spawns just creates "无关模式" noise.
 * We filter the three public roster surfaces (list / remoteExportList /
 * resolve) to the two Saker presets, and pin the default to `pentest` so a
 * blank session lands on the right mode instead of a missing 'standard'.
 */
const VISIBLE_PRESETS = new Set(['pentest', 'code-audit'])
const DEFAULT_PRESET = 'pentest'

function filterPreset(p) {
  return !!p && typeof p.id === 'string' && VISIBLE_PRESETS.has(p.id)
}

function patchAgentPresets(presets) {
  if (!presets || presets.__sakerRosterPatched) return

  const originalList = presets.list.bind(presets)
  presets.list = async function patchedList(...args) {
    const out = await originalList(...args)
    return Array.isArray(out) ? out.filter(filterPreset) : out
  }

  if (typeof presets.remoteExportList === 'function') {
    const originalExport = presets.remoteExportList.bind(presets)
    presets.remoteExportList = async function patchedExport(...args) {
      const out = await originalExport(...args)
      if (out && Array.isArray(out.presets)) out.presets = out.presets.filter(filterPreset)
      return out
    }
  }

  if (typeof presets.resolve === 'function') {
    const originalResolve = presets.resolve.bind(presets)
    presets.resolve = async function patchedResolve(id, ...rest) {
      if (typeof id === 'string' && !VISIBLE_PRESETS.has(id)) return undefined
      return await originalResolve(id, ...rest)
    }
  }

  // Pin the default to a visible preset so `AgentPresets.defaultId` always
  // resolves — even before the settings scope has been attached.
  if (presets.config && typeof presets.config === 'object') {
    presets.config.default = DEFAULT_PRESET
  }

  Object.defineProperty(presets, '__sakerRosterPatched', { value: true })
}

export function apply(ctx) {
  const root = fileURLToPath(new URL('../preset/', import.meta.url))
  const presets = ctx.get('agentPresets')
  if (!presets.resolvedRoots.some((entry) => entry.path === root)) {
    presets.resolvedRoots.unshift({ path: root, trust: 'system' })
  }
  patchAgentPresets(presets)
}
