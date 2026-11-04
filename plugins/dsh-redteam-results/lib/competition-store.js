import { createHash, randomUUID } from 'node:crypto'
import { taskTransaction } from './task-policy-record.js'
import { readDocumentSection } from './project-documents.js'

export const COMPETITION_CHALLENGE_STATES = ['open', 'solving', 'blocked', 'solved']
export const COMPETITION_ANSWER_STATES = ['pending', 'accepted', 'rejected', 'unknown']

const nowIso = () => new Date().toISOString()
const text = (value, max = 20000) => String(value ?? '').trim().slice(0, max)
const parse = row => {
  if (!row) return null
  try {
    const value = JSON.parse(row.record)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function challengeTitle(input) {
  const explicit = text(input.title || input.name, 200)
  if (explicit) return explicit
  const prompt = text(input.prompt || input.text, 500)
  return prompt.split(/\r?\n/).find(Boolean)?.slice(0, 80) || '未命名题目'
}

export function listCompetitionChallenges(store, sessionId, { limit = 50, offset = 0, state = '' } = {}) {
  const take = Math.max(1, Math.min(50, Number(limit) || 50))
  const skip = Math.max(0, Number(offset) || 0)
  const where = state ? ' AND state=?' : ''
  const args = state ? [String(sessionId || ''), String(state)] : [String(sessionId || '')]
  const rows = store.db.prepare('SELECT record FROM competition_challenges WHERE session_id=?' + where
    + ' ORDER BY updated_at DESC, challenge_id ASC LIMIT ? OFFSET ?')
    .all(...args, take, skip).map(parse).filter(Boolean)
    .map(row => ({
      challengeId: row.challengeId, title: row.title, state: row.state, revision: row.revision,
      instanceRevision: row.instance?.revision || 1, environment: row.environment?.kind || 'host',
      attachmentCount: Array.isArray(row.attachments) ? row.attachments.length : 0,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    }))
  const total = Number(store.db.prepare('SELECT COUNT(*) AS n FROM competition_challenges WHERE session_id=?' + where).get(...args)?.n || 0)
  return { rows, total, offset: skip, nextOffset: skip + rows.length < total ? skip + rows.length : null,
    hasMore: skip + rows.length < total, stateFilter: state || null }
}

export function readCompetitionChallenge(store, sessionId, challengeId) {
  return parse(store.db.prepare('SELECT record FROM competition_challenges WHERE session_id=? AND challenge_id=?')
    .get(String(sessionId || ''), String(challengeId || '')))
}

export function createCompetitionChallenge(store, sessionId, input = {}) {
  return taskTransaction(store, () => {
    const id = text(input.challengeId, 120) || 'challenge-' + randomUUID()
    if (readCompetitionChallenge(store, sessionId, id)) throw new Error('challenge already exists')
    const at = nowIso()
    const record = {
      challengeId: id,
      sessionId,
      title: challengeTitle(input),
      prompt: text(input.prompt || input.text, 200000),
      attachments: Array.isArray(input.attachments) ? input.attachments.map(item => ({
        id: String(item.id || 'attachment-' + randomUUID()),
        name: text(item.name, 300),
        role: item.role === 'output' ? 'output' : 'input',
        digest: text(item.digest, 128),
        bytes: Number(item.bytes) || 0,
        materialId: text(item.materialId, 200),
        readonly: item.role !== 'output',
      })) : [],
      instance: {
        url: text(input.instance?.url, 2000),
        connection: text(input.instance?.connection, 4000),
        revision: Math.max(1, Number(input.instance?.revision) || 1),
        tokenPresent: input.instance?.tokenPresent === true,
      },
      environment: {
        kind: input.environment?.kind === 'docker' ? 'docker' : 'host',
        image: text(input.environment?.image, 500),
        state: text(input.environment?.state, 100),
        network: ['none', 'bridge'].includes(input.environment?.network) ? input.environment.network : 'bridge',
      },
      state: 'open',
      revision: 1,
      createdAt: at,
      updatedAt: at,
    }
    store.db.prepare('INSERT INTO competition_challenges(session_id,challenge_id,state,revision,record,updated_at) VALUES(?,?,?,?,?,?)')
      .run(sessionId, id, record.state, record.revision, JSON.stringify(record), at)
    return record
  })
}

export function updateCompetitionChallenge(store, sessionId, challengeId, patch = {}) {
  return taskTransaction(store, () => {
    const current = readCompetitionChallenge(store, sessionId, challengeId)
    if (!current) throw new Error('competition challenge not found')
    if (patch.expectedRevision !== undefined && Number(patch.expectedRevision) !== current.revision)
      throw Object.assign(new Error('challenge changed; refresh before updating'), { code: 'competition-conflict' })
    if (patch.state === 'solved' && patch.confirmedBy !== 'user' && patch.confirmedBy !== 'platform')
      throw Object.assign(new Error('solved status requires a user or platform confirmation'), { code: 'competition-confirmation-required' })
    const instancePatch = patch.instance && typeof patch.instance === 'object' ? patch.instance : null
    const instanceChanged = instancePatch && ['url', 'connection', 'tokenPresent'].some(key =>
      instancePatch[key] !== undefined && instancePatch[key] !== current.instance?.[key])
    const explicitInstanceRevision = Number(instancePatch?.revision)
    const currentInstanceRevision = Math.max(1, Number(current.instance?.revision) || 1)
    const nextInstance = instancePatch ? {
      ...current.instance,
      ...instancePatch,
      revision: instanceChanged
        ? Math.max(currentInstanceRevision + 1,
          Number.isSafeInteger(explicitInstanceRevision) && explicitInstanceRevision > 0 ? explicitInstanceRevision : 0)
        : Math.max(currentInstanceRevision,
          Number.isSafeInteger(explicitInstanceRevision) && explicitInstanceRevision > 0 ? explicitInstanceRevision : 0),
    } : current.instance
    const instanceHistory = instanceChanged
      ? [...(current.instanceHistory || []), { ...current.instance, retiredAt: nowIso() }].slice(-50)
      : (current.instanceHistory || [])
    const next = {
      ...current,
      ...(patch.title !== undefined ? { title: text(patch.title, 200) || current.title } : {}),
      ...(patch.prompt !== undefined ? { prompt: text(patch.prompt, 200000) } : {}),
      ...(patch.state !== undefined ? { state: COMPETITION_CHALLENGE_STATES.includes(patch.state) ? patch.state : current.state } : {}),
      ...(instancePatch ? { instance: nextInstance, instanceHistory } : {}),
      ...(patch.environment !== undefined ? { environment: { ...current.environment, ...patch.environment,
        kind: patch.environment?.kind === 'docker' ? 'docker' : patch.environment?.kind === 'host' ? 'host' : current.environment.kind,
        network: ['none', 'bridge'].includes(patch.environment?.network) ? patch.environment.network : current.environment.network || 'bridge' } } : {}),
      ...(Array.isArray(patch.attachments) ? { attachments: patch.attachments } : {}),
      revision: current.revision + 1,
      updatedAt: nowIso(),
    }
    if (instanceChanged && next.state === 'solved') {
      next.state = 'solving'
      delete next.confirmedBy
      delete next.confirmedAt
    }
    store.db.prepare('UPDATE competition_challenges SET state=?,revision=?,record=?,updated_at=? WHERE session_id=? AND challenge_id=?')
      .run(next.state, next.revision, JSON.stringify(next), next.updatedAt, sessionId, next.challengeId)
    return next
  })
}

export function listCompetitionAnswers(store, sessionId, challengeId) {
  return store.db.prepare('SELECT record FROM competition_answers WHERE session_id=? AND challenge_id=? ORDER BY updated_at DESC')
    .all(String(sessionId || ''), String(challengeId || '')).map(parse).filter(Boolean)
}

export function addCompetitionAnswer(store, sessionId, challengeId, input = {}) {
  const challenge = readCompetitionChallenge(store, sessionId, challengeId)
  if (!challenge) throw new Error('competition challenge not found')
  const value = typeof input.value === 'string' ? input.value : ''
  if (!value) throw new Error('candidate answer must preserve non-empty original text')
  const state = COMPETITION_ANSWER_STATES.includes(input.status) ? input.status : 'pending'
  if (state === 'accepted' && input.confirmedBy !== 'user' && input.confirmedBy !== 'platform')
    throw new Error('accepted answer requires a user or platform confirmation source')
  const instanceRevision = Math.max(1, Number(input.instanceRevision) || challenge.instance.revision || 1)
  if (state === 'pending') {
    const existing = listCompetitionAnswers(store, sessionId, challengeId).find(answer =>
      answer.status === 'pending' && answer.value === value && answer.instanceRevision === instanceRevision)
    if (existing) {
      const next = { ...existing, source: text(input.source, 4000) || existing.source,
        evidenceRef: text(input.evidenceRef, 300) || existing.evidenceRef, updatedAt: nowIso() }
      store.db.prepare('UPDATE competition_answers SET record=?,updated_at=? WHERE session_id=? AND challenge_id=? AND answer_id=?')
        .run(JSON.stringify(next), next.updatedAt, sessionId, challengeId, existing.answerId)
      return { ...next, reused: true }
    }
  }
  const id = 'answer-' + randomUUID()
  const at = nowIso()
  const record = {
    answerId: id,
    challengeId,
    sessionId,
    value,
    status: state,
    source: text(input.source, 4000),
    evidenceRef: text(input.evidenceRef, 300),
    instanceRevision,
    confirmedBy: state === 'accepted' ? input.confirmedBy : '',
    confirmationNote: text(input.confirmationNote, 2000),
    createdAt: at,
    updatedAt: at,
  }
  store.db.prepare('INSERT INTO competition_answers(session_id,challenge_id,answer_id,record,updated_at) VALUES(?,?,?,?,?)')
    .run(sessionId, challengeId, id, JSON.stringify(record), at)
  return record
}

export function updateCompetitionAnswer(store, sessionId, challengeId, answerId, patch = {}) {
  const row = store.db.prepare('SELECT record FROM competition_answers WHERE session_id=? AND challenge_id=? AND answer_id=?')
    .get(sessionId, challengeId, answerId)
  const current = parse(row)
  if (!current) throw new Error('competition answer not found')
  const status = patch.status === undefined ? current.status : patch.status
  if (!COMPETITION_ANSWER_STATES.includes(status)) throw new Error('invalid competition answer status')
  if (status === 'accepted' && patch.confirmedBy !== 'user' && patch.confirmedBy !== 'platform')
    throw new Error('accepted answer requires a user or platform confirmation source')
  const next = { ...current, status, ...(patch.confirmedBy ? { confirmedBy: patch.confirmedBy } : {}),
    ...(patch.confirmationNote !== undefined ? { confirmationNote: text(patch.confirmationNote, 2000) } : {}),
    updatedAt: nowIso() }
  store.db.prepare('UPDATE competition_answers SET record=?,updated_at=? WHERE session_id=? AND challenge_id=? AND answer_id=?')
    .run(JSON.stringify(next), next.updatedAt, sessionId, challengeId, answerId)
  return next
}

export function competitionSummary(store, sessionId) {
  const challenges = store.db.prepare('SELECT challenge_id,record FROM competition_challenges WHERE session_id=?').all(sessionId).map(row => ({
    challengeId: row.challenge_id, ...(parse(row) || {}),
  }))
  const answers = store.db.prepare('SELECT challenge_id,record FROM competition_answers WHERE session_id=?').all(sessionId)
    .map(row => ({ challengeId: row.challenge_id, ...(parse(row) || {}) }))
  const acceptedKeys = new Set(answers.filter(answer => answer.status === 'accepted'
    && challenges.some(challenge => challenge.challengeId === answer.challengeId
      && Number(challenge.instance?.revision || 1) === Number(answer.instanceRevision || 1)))
    .map(answer => answer.challengeId))
  const pendingAnswers = answers.filter(answer => answer.status === 'pending').length
  const acceptedAnswerRecords = answers.filter(answer => answer.status === 'accepted').length
  const solved = acceptedKeys.size
  const total = challenges.length
  return {
    challenges: total,
    open: total - solved,
    solved,
    pendingAnswers,
    acceptedAnswers: solved,
    acceptedAnswerRecords,
  }
}

export function setCurrentCompetitionChallenge(store, sessionId, challengeId) {
  const challenge = readCompetitionChallenge(store, sessionId, challengeId)
  if (!challenge) throw new Error('competition challenge not found')
  const row = store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(String(sessionId || ''))
  let scene = {}
  try { scene = row ? JSON.parse(row.record) : {} } catch { scene = {} }
  const at = nowIso()
  store.db.prepare('UPDATE scene_contexts SET record=?,updated_at=? WHERE session_id=?')
    .run(JSON.stringify({ ...scene, currentChallengeId: String(challengeId), currentChallengeUpdatedAt: at }),
      at, String(sessionId || ''))
  return challenge
}

export function readCurrentCompetitionChallenge(store, sessionId) {
  const row = store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(String(sessionId || ''))
  if (!row) return null
  try {
    const currentChallengeId = JSON.parse(row.record)?.currentChallengeId
    return currentChallengeId ? readCompetitionChallenge(store, sessionId, currentChallengeId) : null
  } catch { return null }
}

export function competitionPromptState(store, sessionId) {
  const summary = competitionSummary(store, sessionId)
  const current = readCurrentCompetitionChallenge(store, sessionId)
  const indexed = listCompetitionChallenges(store, sessionId, { limit: 1 }).rows[0]
  const active = current || (indexed ? readCompetitionChallenge(store, sessionId, indexed.challengeId) : null)
  const prompt = String(active?.prompt || '')
  const previewPage = readDocumentSection({ sections: [{ sectionId: 'prompt-preview', text: prompt }] },
    'prompt-preview', { limit: 1200 })
  const promptPreview = previewPage.text
  const instanceDetails = [active?.instance?.url ? 'URL=' + active.instance.url : '',
    active?.instance?.connection ? '连接=' + active.instance.connection : ''].filter(Boolean).join('；')
  return {
    active, summary, prompt, promptPreview,
    state: 'Saker competition state\n'
      + '当前场景=比赛模式；题目=' + (active?.title || '尚未登记') + '；challengeId=' + (active?.challengeId || '')
      + '；题目状态=' + (active?.state || 'none') + '；题目数=' + summary.challenges
      + '；待提交=' + summary.pendingAnswers + '；已通过=' + summary.acceptedAnswers,
    promptLine: promptPreview
      ? '\n当前题面：' + promptPreview + (previewPage.more
        ? '…（用 saker_material action=current offset=' + previewPage.nextCursor + ' 续读）' : '')
      : '',
    instanceLine: instanceDetails
      ? '\n当前实例 revision=' + (active?.instance?.revision || 1) + '：' + instanceDetails.slice(0, 1600)
      : '',
    attachmentLine: (active?.attachments || []).length
      ? '\n当前附件：' + active.attachments.map(item =>
        (item.materialId || item.id) + ' / ' + item.name + ' / ' + item.bytes + 'B').join('；')
      : '',
  }
}

export function competitionFileDigest(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}
