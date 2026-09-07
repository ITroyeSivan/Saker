import { fileURLToPath } from 'node:url'

export const inject = ['agentPresets']

/**
 * Register the bundle-owned read-only preset root after the agentPresets
 * service exists. The presets stay inside the installed package — no copy is
 * made into the user's DSH_HOME, so updating the bundle swaps the modes
 * atomically and uninstalling removes them without residue.
 */
export function apply(ctx) {
  const root = fileURLToPath(new URL('../preset/', import.meta.url))
  const presets = ctx.get('agentPresets')
  if (!presets.resolvedRoots.some((entry) => entry.path === root)) {
    presets.resolvedRoots.unshift({ path: root, trust: 'system' })
  }
}
