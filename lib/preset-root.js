import { fileURLToPath } from 'node:url'

export const inject = ['agentPresets']

/**
 * Register the bundle-owned read-only preset root after the agentPresets
 * service exists. The presets stay inside the installed package — no copy is
 * made into the user's DSH_HOME, so updating the bundle swaps the modes
 * atomically and uninstalling removes them without residue.
 *
 * The Saker platform ships three security modes (pentest / code-audit /
 * ctf-solver) and keeps the harness's generic `standard` preset visible: Saker
 * is mounted as the deployment's only preset root, so filtering `standard` out
 * would leave the operator with no general-purpose mode at all — the workbench
 * becomes unusable for everyday (non-security) sessions.
 *
 * `ctf-solver` is the CTF challenge-solving mode: same agent-plane skeleton as
 * pentest (tool rows / skills registry / delegation), but its own persona and
 * playbook — the deliverable is the flag plus the minimal reproduction path,
 * not a vulnerability report.
 *
 * The remaining harness dev presets (cordis / minimal / ptc) stay hidden: they
 * are harness-internal shapes with nothing to do with the workflow, and showing
 * them on the hero picker, settings, and subagent spawns is pure "无关模式" noise.
 * Operators who do want them can opt in without a code change via
 * `SAKER_VISIBLE_PRESETS` (comma-separated ids, appended to the defaults).
 *
 * We filter the three public roster surfaces (list / remoteExportList /
 * resolve), and pin the default to `pentest` so a blank session lands on the
 * product's primary mode.
 */
const DEFAULT_VISIBLE = ['pentest', 'code-audit', 'ctf-solver', 'standard']
const VISIBLE_PRESETS = new Set([
  ...DEFAULT_VISIBLE,
  ...String(process.env.SAKER_VISIBLE_PRESETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
])
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
