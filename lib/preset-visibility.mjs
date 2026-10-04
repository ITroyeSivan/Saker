const DEFAULT_VISIBLE = ['pentest', 'standard']
const COMPATIBILITY_ONLY = new Set(['code-audit', 'ctf-solver'])

export function createPresetVisibility(extra = process.env.SAKER_VISIBLE_PRESETS || '') {
  const visible = new Set([
    ...DEFAULT_VISIBLE,
    ...String(extra).split(',').map((id) => id.trim()).filter(id => id && !COMPATIBILITY_ONLY.has(id)),
  ])

  return Object.freeze({
    isVisible: (preset) => !!preset && typeof preset.id === 'string' && visible.has(preset.id),
    canResolve: (id) => typeof id !== 'string' || visible.has(id) || COMPATIBILITY_ONLY.has(id),
  })
}
