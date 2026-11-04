import { createHash, randomUUID } from 'node:crypto'
import {
  SAKER_SCENES,
  isSakerPreset,
  normalizeScene,
  sceneById,
  scenePreset,
  sceneView,
} from 'dsh-saker/scene-context'
import { taskTransaction } from './task-policy-record.js'

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const nowIso = () => new Date().toISOString()
const BUDGET_FIELDS = ['toolCalls', 'modelCalls', 'tokens']

export function normalizeCompetitionBudgetLimit(value, field) {
  if (value === undefined) return undefined
  if (value === '' || value === null) return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('competition ' + field + ' limit must be a positive safe integer or empty')
  return number
}

function parseRecord(row) {
  if (!row) return null
  try {
    const value = JSON.parse(row.record)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function inferredScene(store, sessionId, presetId) {
  const policyRow = store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(sessionId)
  const policy = parseRecord(policyRow)
  if (policy?.scenario) {
    try { return normalizeScene(policy.scenario, presetId) } catch { /* malformed history stays explicit below */ }
  }
  const flowRow = store.db.prepare('SELECT record FROM task_flow_choice WHERE session_id=?').get(sessionId)
  const flow = parseRecord(flowRow)
  if (flow?.scenario) {
    try { return normalizeScene(flow.scenario, presetId) } catch { /* malformed history stays explicit below */ }
  }
  const run = store.db.prepare('SELECT 1 AS found FROM project_runs WHERE session_id=? LIMIT 1').get(sessionId)
  if (run) return 'cases'
  return normalizeScene('', presetId)
}

export function sceneRootSession(store, sessionId) {
  let root = String(sessionId || '')
  for (let depth = 0; depth < 4 && root; depth += 1) {
    let parent = ''
    try { parent = store.db.prepare('SELECT parent_session FROM site_workers WHERE child_id=?').get(root)?.parent_session || '' }
    catch { /* purpose task ownership is checked below */ }
    if (!parent) {
      try { parent = store.db.prepare('SELECT parent_session FROM task_policy WHERE session_id=?').get(root)?.parent_session || '' }
      catch { /* malformed history has no inheritable scene */ }
    }
    if (!parent || parent === root) break
    root = String(parent)
  }
  return root
}

function publicRecord(record) {
  if (!record) return null
  const { lastRequest, ...safe } = record
  return {
    ...safe,
    scene: sceneView(record.sceneId),
    scenes: SAKER_SCENES.map(scene => ({ ...scene })),
    knowledgeEnabled: record.knowledgeEnabled === true,
    continuationPaused: record.continuationPaused === true,
  }
}

export function readSceneContext(store, sessionId, presetId = '') {
  const id = String(sessionId || '')
  if (!id) throw new Error('sessionId required')
  const rootSession = sceneRootSession(store, id)
  const row = store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(id)
  const stored = parseRecord(row)
  if (stored) {
    const sceneId = normalizeScene(stored.sceneId, presetId)
    if (!sceneById(sceneId)) throw new Error('scene context is invalid')
    if (presetId && isSakerPreset(presetId) && stored.presetId && stored.presetId !== presetId)
      throw new Error('scene context conflicts with the current Agent preset')
    return publicRecord({ ...stored, sceneId, presetId: presetId || stored.presetId || scenePreset(sceneId), rootSession })
  }
  if (rootSession && rootSession !== id) {
    const rootRow = store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(rootSession)
    const rootStored = parseRecord(rootRow)
    if (rootStored) {
      const sceneId = normalizeScene(rootStored.sceneId, presetId)
      if (presetId && isSakerPreset(presetId) && rootStored.presetId && rootStored.presetId !== presetId)
        throw new Error('scene context conflicts with the current Agent preset')
      return publicRecord({
        ...rootStored, sessionId: id, contextId: rootStored.contextId || rootSession,
        rootSession, sceneId, presetId: presetId || rootStored.presetId || scenePreset(sceneId),
      })
    }
  }
  const sceneId = inferredScene(store, id, presetId)
  if (!sceneId) return null
  return publicRecord({
    sessionId: id,
    sceneId,
    presetId: presetId || scenePreset(sceneId),
    contextId: id,
    sceneRevision: 0,
    rootSession,
    knowledgeEnabled: false,
    continuationPaused: false,
  })
}

export function writeSceneContext(store, sessionId, targetScene, input = {}) {
  const id = String(sessionId || '')
  if (!id) throw new Error('sessionId required')
  const sceneId = normalizeScene(targetScene)
  const presetId = String(input.presetId || scenePreset(sceneId))
  if (presetId !== scenePreset(sceneId)) throw new Error('scene and Agent preset do not match')
  const requestId = String(input.requestId || randomUUID())
  const request = {
    sceneId,
    presetId,
    expectedRevision: Number.isSafeInteger(input.expectedRevision) ? input.expectedRevision : null,
  }
  const requestFingerprint = fingerprint(request)
  return taskTransaction(store, () => {
    const current = readSceneContext(store, id, presetId)
    const row = store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(id)
    const stored = parseRecord(row)
    if (stored?.lastRequest?.id === requestId) {
      if (stored.lastRequest.fingerprint !== requestFingerprint)
        throw Object.assign(new Error('same scene requestId has different content'), { code: 'scene-conflict' })
      return { ...publicRecord(stored), idempotent: true }
    }
    const revision = Number.isSafeInteger(current?.sceneRevision) ? current.sceneRevision : 0
    if (request.expectedRevision !== null && request.expectedRevision !== revision)
      throw Object.assign(new Error('scene context changed; refresh before selecting'), {
        code: 'scene-conflict',
        details: { expectedRevision: request.expectedRevision, actualRevision: revision },
      })
    if (stored && current?.sceneId === sceneId) return { ...current, idempotent: true }
    const next = {
      sessionId: id,
      sceneId,
      presetId,
      contextId: stored?.contextId || id,
      sceneRevision: revision + 1,
      knowledgeEnabled: sceneId === 'competition' ? stored?.knowledgeEnabled === true : false,
      continuationPaused: stored?.continuationPaused === true,
      continuationReason: String(stored?.continuationReason || ''),
      updatedAt: nowIso(),
      lastRequest: { id: requestId, fingerprint: requestFingerprint },
    }
    store.db.prepare(
      'INSERT INTO scene_contexts(session_id,scene_id,preset_id,revision,record,updated_at) VALUES(?,?,?,?,?,?) '
      + 'ON CONFLICT(session_id) DO UPDATE SET scene_id=excluded.scene_id,preset_id=excluded.preset_id,'
      + 'revision=excluded.revision,record=excluded.record,updated_at=excluded.updated_at',
    ).run(id, next.sceneId, next.presetId, next.sceneRevision, JSON.stringify(next), next.updatedAt)
    return { ...publicRecord(next), idempotent: false }
  })
}

export function setCompetitionKnowledge(store, sessionId, enabled, input = {}) {
  const id = String(sessionId || '')
  return taskTransaction(store, () => {
    const current = readSceneContext(store, id, 'ctf-solver')
    if (!current || current.sceneId !== 'competition') throw new Error('competition scene required')
    const expectedRevision = Number.isSafeInteger(input.expectedRevision) ? input.expectedRevision : current.sceneRevision
    if (expectedRevision !== current.sceneRevision)
      throw Object.assign(new Error('scene context changed; refresh before changing knowledge'), {
        code: 'scene-conflict',
        details: { expectedRevision, actualRevision: current.sceneRevision },
      })
    const row = store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(id)
    const stored = parseRecord(row) || {
      sessionId: id, sceneId: 'competition', presetId: 'ctf-solver', contextId: id,
      sceneRevision: current.sceneRevision,
    }
    const next = {
      ...stored,
      knowledgeEnabled: enabled === true,
      sceneRevision: current.sceneRevision + 1,
      knowledgeRevision: (Number(stored.knowledgeRevision) || 0) + 1,
      knowledgeUpdatedAt: nowIso(),
      updatedAt: nowIso(),
    }
    store.db.prepare(
      'INSERT INTO scene_contexts(session_id,scene_id,preset_id,revision,record,updated_at) VALUES(?,?,?,?,?,?) '
      + 'ON CONFLICT(session_id) DO UPDATE SET record=excluded.record,revision=excluded.revision,updated_at=excluded.updated_at',
    ).run(id, 'competition', 'ctf-solver', next.sceneRevision, JSON.stringify(next), next.updatedAt)
    return publicRecord(next)
  })
}

export function setSceneContinuation(store, sessionId, paused, reason = '') {
  const id = String(sessionId || '')
  const current = readSceneContext(store, id)
  if (!current) throw new Error('scene context unavailable')
  const row = store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(id)
  const stored = parseRecord(row) || {}
  const next = {
    ...stored,
    sessionId: id,
    sceneId: current.sceneId,
    presetId: current.presetId,
    contextId: current.contextId,
    sceneRevision: current.sceneRevision,
    continuationPaused: paused === true,
    continuationReason: paused === true ? String(reason || '').trim().slice(0, 1000) : '',
    updatedAt: nowIso(),
  }
  store.db.prepare(
    'INSERT INTO scene_contexts(session_id,scene_id,preset_id,revision,record,updated_at) VALUES(?,?,?,?,?,?) '
    + 'ON CONFLICT(session_id) DO UPDATE SET record=excluded.record,updated_at=excluded.updated_at',
  ).run(id, next.sceneId, next.presetId, next.sceneRevision, JSON.stringify(next), next.updatedAt)
  return publicRecord(next)
}

export function setCompetitionPreferences(store, sessionId, input = {}) {
  const id = String(sessionId || '')
  return taskTransaction(store, () => {
    const current = readSceneContext(store, id, 'ctf-solver')
    if (!current || current.sceneId !== 'competition') throw new Error('competition scene required')
    const expected = input.expectedRevision
    if (expected !== undefined && Number(expected) !== Number(current.sceneRevision))
      throw Object.assign(new Error('scene context changed; refresh before saving settings'), {
        code: 'scene-conflict', details: { expectedRevision: expected, actualRevision: current.sceneRevision },
      })
    const row = store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(id)
    let stored = {}
    try { stored = row ? JSON.parse(row.record) : {} } catch { stored = {} }
    const prior = stored.preferences || {}
    const priorBudget = prior.budget || {}
    const requestedMinutes = input.minutes === undefined ? priorBudget.minutes
      : input.minutes === '' || input.minutes === null ? null : Number(input.minutes)
    if (requestedMinutes !== null && requestedMinutes !== undefined
      && (!Number.isFinite(requestedMinutes) || requestedMinutes <= 0))
      throw new Error('competition time limit must be a positive number of minutes')
    // Changing a limit changes the cap, not the accounting round. Existing
    // elapsed time and used calls remain charged to the same competition.
    const budgetStartedAt = requestedMinutes === null || requestedMinutes === undefined
      ? undefined
      : (priorBudget.startedAt || nowIso())
    const normalizedLimits = Object.fromEntries(BUDGET_FIELDS
      .map(field => [field, normalizeCompetitionBudgetLimit(input[field], field)])
      .filter(([, value]) => value !== undefined))
    const nextBudget = { ...priorBudget,
      ...(input.minutes !== undefined ? { minutes: requestedMinutes } : {}),
      ...(budgetStartedAt ? { startedAt: budgetStartedAt } : {}),
      ...normalizedLimits,
    }
    const requestedConcurrency = input.modelConcurrency === undefined
      ? prior.modelConcurrency
      : input.modelConcurrency === '' || input.modelConcurrency === null ? null : Number(input.modelConcurrency)
    if (requestedConcurrency !== null && requestedConcurrency !== undefined
      && (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 16))
      throw new Error('competition local model concurrency must be an integer from 1 to 16')
    if (!nextBudget.roundStartedAt && BUDGET_FIELDS.some(field => nextBudget[field] !== null && nextBudget[field] !== undefined))
      nextBudget.roundStartedAt = nowIso()
    if (requestedMinutes === null || requestedMinutes === undefined) delete nextBudget.startedAt
    const nextPreferences = {
      ...prior,
      workers: Number.isInteger(Number(input.workers)) ? Math.max(0, Number(input.workers)) : (prior.workers ?? 0),
      interaction: input.interaction || prior.interaction || 'auto',
      reporting: input.reporting || prior.reporting || 'end',
      explain: input.explain === undefined ? prior.explain === true : input.explain === true,
      budget: nextBudget,
      ...(input.modelConcurrency !== undefined ? { modelConcurrency: requestedConcurrency } : {}),
      ...(input.workerModel !== undefined ? { workerModel: input.workerModel } : {}),
      ...(input.reviewModel !== undefined ? { reviewModel: input.reviewModel } : {}),
      ...(input.reportModel !== undefined ? { reportModel: input.reportModel } : {}),
      revision: (Number(prior.revision) || 0) + 1,
      updatedAt: nowIso(),
    }
    let modelBudgetBlock = prior.modelBudgetBlock || null
    if (modelBudgetBlock?.code === 'model_calls_exhausted' && normalizedLimits.modelCalls !== undefined)
      modelBudgetBlock = null
    if (modelBudgetBlock?.code === 'tokens_exhausted' && normalizedLimits.tokens !== undefined)
      modelBudgetBlock = null
    if (modelBudgetBlock) nextPreferences.modelBudgetBlock = modelBudgetBlock
    else delete nextPreferences.modelBudgetBlock
    const next = { ...stored, sceneId: 'competition', presetId: 'ctf-solver',
      contextId: stored.contextId || id, sceneRevision: current.sceneRevision + 1,
      preferences: nextPreferences, updatedAt: nowIso() }
    store.db.prepare('UPDATE scene_contexts SET revision=?,record=?,updated_at=? WHERE session_id=?')
      .run(next.sceneRevision, JSON.stringify(next), next.updatedAt, id)
    return publicRecord(next)
  })
}

export function reconcileSceneFromTask(store, sessionId, scenario, presetId = '') {
  let sceneId
  try { sceneId = normalizeScene(scenario, presetId) } catch { return null }
  if (!sceneId) return null
  const current = readSceneContext(store, sessionId, scenePreset(sceneId))
  if (current?.sceneId === sceneId) return current
  return writeSceneContext(store, sessionId, sceneId, {
    presetId: presetId || scenePreset(sceneId),
    expectedRevision: current?.sceneRevision ?? null,
  })
}

export { SAKER_SCENES, normalizeScene, scenePreset }
