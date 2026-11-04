export const SAKER_SCENES = Object.freeze([
  Object.freeze({
    id: 'free',
    label: '自由测试',
    description: '按你的目标和思路开展测试。',
    presetId: 'pentest',
  }),
  Object.freeze({
    id: 'competition',
    label: '比赛模式',
    description: '根据题面、附件和实例解题。',
    presetId: 'ctf-solver',
  }),
  Object.freeze({
    id: 'cases',
    label: '案例测试',
    description: '按已有案例或测试要求逐项执行。',
    presetId: 'pentest',
  }),
])

const BY_ID = new Map(SAKER_SCENES.map(scene => [scene.id, scene]))
const LEGACY = new Map([
  ['pentest', 'free'],
  ['project', 'cases'],
  ['ctf', 'competition'],
  ['ctf-solver', 'competition'],
])

export function sceneById(id) {
  return BY_ID.get(String(id || '')) || null
}

export function scenePreset(id) {
  const scene = sceneById(id)
  if (!scene) throw new Error('unknown Saker scene: ' + String(id || '(empty)'))
  return scene.presetId
}

export function sceneLabel(id, fallback = '') {
  return sceneById(id)?.label || fallback
}

export function normalizeScene(value, presetId = '') {
  const raw = String(value || '').trim()
  if (LEGACY.has(raw)) return LEGACY.get(raw)
  if (BY_ID.has(raw)) return raw
  if (raw) throw new Error('unknown Saker scene: ' + raw)
  if (presetId === 'ctf-solver') return 'competition'
  if (presetId === 'pentest') return 'free'
  return ''
}

export function sceneView(id) {
  const scene = sceneById(id)
  if (!scene) throw new Error('unknown Saker scene: ' + String(id || '(empty)'))
  return { ...scene }
}

export function isSakerPreset(presetId) {
  return presetId === 'pentest' || presetId === 'ctf-solver'
}
