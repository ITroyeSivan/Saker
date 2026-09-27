const DEFAULT_VISIBLE = ['pentest', 'code-audit', 'standard']
const COMPATIBILITY_ONLY = new Set(['ctf-solver'])

export function createPresetVisibility(extra = process.env.SAKER_VISIBLE_PRESETS || '') {
  const visible = new Set([
    ...DEFAULT_VISIBLE,
    ...String(extra).split(',').map((id) => id.trim()).filter(Boolean),
  ])

  return Object.freeze({
    isVisible: (preset) => !!preset && typeof preset.id === 'string' && visible.has(preset.id),
    canResolve: (id) => typeof id !== 'string' || visible.has(id) || COMPATIBILITY_ONLY.has(id),
  })
}
