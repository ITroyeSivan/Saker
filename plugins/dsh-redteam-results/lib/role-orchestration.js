// Persistent organization layer for model-defined roles and concrete work.
//
// This module intentionally does not spawn agents. It stores the RoleSpec,
// WorkItem, activation and communication records around the existing Host
// worker manager. That keeps one root budget/lease implementation while
// allowing arbitrary roles instead of a review/report enum.
import { createHash, randomUUID } from 'node:crypto'

export const ROLE_ORCHESTRATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS role_specs (
  owner_session TEXT NOT NULL,
  role_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  record TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_session, role_id, version)
);
CREATE TABLE IF NOT EXISTS role_work_items (
  session_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  parent_work_id TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(session_id, work_id)
);
CREATE INDEX IF NOT EXISTS idx_role_work_state
  ON role_work_items(session_id,state,updated_at);
CREATE TABLE IF NOT EXISTS role_instances (
  session_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  role_version INTEGER NOT NULL,
  work_id TEXT NOT NULL,
  logical_parent TEXT NOT NULL DEFAULT '',
  generation INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  record TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(session_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_role_instances_work
  ON role_instances(session_id,work_id,state);
CREATE TABLE IF NOT EXISTS role_queue (
  session_id TEXT NOT NULL,
  queue_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  role_version INTEGER NOT NULL,
  work_id TEXT NOT NULL,
  logical_parent TEXT NOT NULL DEFAULT '',
  depth INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  record TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(session_id, queue_id)
);
CREATE INDEX IF NOT EXISTS idx_role_queue_state
  ON role_queue(session_id,state,created_at);
CREATE TABLE IF NOT EXISTS role_attempts (
  session_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  record TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(session_id, attempt_id),
  UNIQUE(session_id, work_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS role_messages (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  from_instance TEXT NOT NULL,
  to_instance TEXT NOT NULL,
  kind TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  record TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_role_messages_to
  ON role_messages(session_id,to_instance,created_at);
`

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()
const clampText = (value, label, max = 4000) => {
  const result = String(value ?? '').trim()
  if (!result || result.length > max) throw new Error(`${label} must be 1-${max} characters`)
  return result
}
const optionalText = (value, max = 1000) => String(value ?? '').trim().slice(0, max)
const textList = (value, label, maxItems = 32, maxLength = 300) => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))]
    .slice(0, maxItems).map(item => {
      if (item.length > maxLength) throw new Error(`${label} item exceeds ${maxLength} characters`)
      return item
    })
}
const parseRecord = row => {
  if (!row) return null
  try { return JSON.parse(row.record) } catch { return null }
}
const readHostWorker = (store, childId) => childId
  ? parseRecord(store.db.prepare('SELECT record FROM site_workers WHERE child_id=?').get(String(childId)))
  : null
const validState = new Set([
  'proposed', 'queued', 'starting', 'active', 'waiting', 'blocked',
  'completed', 'stopped', 'released', 'cleanup-failed',
])
const checkState = value => {
  const state = String(value || '').trim()
  if (!validState.has(state)) throw new Error('invalid role/work state')
  return state
}
const normalizeModel = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const provider = optionalText(value.provider, 100)
  const model = optionalText(value.model, 200)
  const reasoningEffort = optionalText(value.reasoningEffort, 40)
  if (!provider && !model && !reasoningEffort) return null
  if (!provider || !model) throw new Error('role model preference needs provider and model')
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

export function ensureRoleSchema(store) {
  store.db.exec(ROLE_ORCHESTRATION_SCHEMA)
}

export function createRoleSpec(store, rootSession, input = {}) {
  ensureRoleSchema(store)
  const root = clampText(rootSession, 'root session', 200)
  const global = input.scope === 'global'
  const owner = global ? 'global' : root
  const title = clampText(input.title || input.name || input.role, 'role title', 160)
  const objective = clampText(input.objective || input.mission || input.question, 'role objective', 4000)
  const responsibilities = clampText(
    input.responsibilities || input.responsibility || input.instructions || objective,
    'role responsibilities', 6000,
  )
  const deliverable = clampText(
    input.deliverable || input.successCriterion || input.output || 'Return facts, evidence references, gaps and a next step.',
    'role deliverable', 3000,
  )
  const capabilities = textList(input.capabilities, 'role capabilities')
  const tools = textList(input.tools, 'role tools', 16, 160)
  const roleId = optionalText(input.roleId || input.id, 160) || 'role-' + randomUUID()
  if (!/^role-[A-Za-z0-9._-]+$/.test(roleId)) throw new Error('roleId must start with role- and contain only safe characters')
  // The execution content is immutable per roleId/version. Display timestamps and
  // creator metadata are intentionally excluded so an idempotent retry with the
  // same brief returns the stored version instead of silently replacing it.
  const execution = {
    schema: 'saker.role-spec/1',
    roleId,
    scope: global ? 'global' : 'root',
    title,
    objective,
    responsibilities,
    deliverable,
    methodView: optionalText(input.methodView || input.perspective, 2000),
    capabilities,
    tools,
    model: normalizeModel(input.model),
    communication: optionalText(input.communication, 1000),
    delegation: optionalText(input.delegation, 1000),
    source: global ? 'user-saved' : (input.source === 'user' ? 'user' : 'model'),
  }
  const hash = digest(execution)
  const requestedVersion = Number(input.version)
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const current = store.db.prepare('SELECT MAX(version) AS version FROM role_specs WHERE owner_session=? AND role_id=?').get(owner, roleId)
    const latestVersion = Number(current?.version || 0)
    const latest = latestVersion
      ? store.db.prepare('SELECT digest,record FROM role_specs WHERE owner_session=? AND role_id=? AND version=?').get(owner, roleId, latestVersion)
      : null
    const exact = Number.isInteger(requestedVersion) && requestedVersion > 0
      ? store.db.prepare('SELECT digest,record FROM role_specs WHERE owner_session=? AND role_id=? AND version=?').get(owner, roleId, requestedVersion)
      : null
    if (exact) {
      if (exact.digest !== hash) {
        throw new Error('role ' + roleId + ' version ' + requestedVersion
          + ' already exists with different execution content; create a new version instead of overwriting it');
      }
      store.db.exec('COMMIT')
      return { ok: true, duplicate: true, role: { ...parseRecord(exact), digest: exact.digest } }
    }
    if (Number.isInteger(requestedVersion) && requestedVersion > 0 && requestedVersion <= latestVersion) {
      throw new Error('role ' + roleId + ' version ' + requestedVersion + ' must be greater than current version ' + latestVersion);
    }
    // A caller that omits version is usually retrying the same brief; return the
    // latest identical execution instead of manufacturing an equivalent version.
    if (!Number.isInteger(requestedVersion) && latest && latest.digest === hash) {
      store.db.exec('COMMIT')
      return { ok: true, duplicate: true, role: { ...parseRecord(latest), digest: latest.digest } }
    }
    const version = Number.isInteger(requestedVersion) && requestedVersion > 0
      ? requestedVersion : latestVersion + 1;
    const record = {
      ...execution,
      version,
      revision: Number(input.revision) || 0,
      createdAt: now(),
      createdBy: optionalText(input.createdBy, 200),
    }
    store.db.prepare(`INSERT INTO role_specs(owner_session,role_id,version,digest,record,updated_at)
      VALUES(?,?,?,?,?,?)`)
      .run(owner, roleId, version, hash, JSON.stringify(record), now())
    store.db.exec('COMMIT')
    return { ok: true, duplicate: false, role: { ...record, digest: hash } }
  } catch (error) {
    try { store.db.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
}

export function readRoleSpec(store, rootSession, roleId, version) {
  const id = optionalText(roleId, 160)
  if (!id) throw new Error('roleId is required')
  const exact = Number(version)
  const scopes = [rootSession, 'global']
  for (const owner of scopes) {
    const row = Number.isInteger(exact) && exact > 0
      ? store.db.prepare('SELECT record FROM role_specs WHERE owner_session=? AND role_id=? AND version=?').get(owner, id, exact)
      : store.db.prepare('SELECT record FROM role_specs WHERE owner_session=? AND role_id=? ORDER BY version DESC LIMIT 1').get(owner, id)
    if (row) return parseRecord(row)
  }
  return null
}

export function listRoleSpecs(store, rootSession) {
  const rows = store.db.prepare(`SELECT owner_session,record FROM role_specs
    WHERE owner_session IN (?, 'global') ORDER BY owner_session DESC, role_id, version DESC`).all(rootSession)
  const selected = new Map()
  for (const row of rows) {
    const role = parseRecord(row)
    if (!role) continue
    const current = selected.get(role.roleId)
    if (!current || (current.scope !== 'root' && row.owner_session === rootSession)) selected.set(role.roleId, role)
  }
  return [...selected.values()].sort((a, b) => a.title.localeCompare(b.title))
}

export function createWorkItem(store, rootSession, input = {}) {
  ensureRoleSchema(store)
  const root = clampText(rootSession, 'root session', 200)
  const question = clampText(input.question || input.title || input.goal, 'work question', 4000)
  const title = optionalText(input.title, 160) || question.slice(0, 160)
  const parentWorkId = optionalText(input.parentWorkId, 160)
  const target = optionalText(input.target, 1000)
  const identityRef = optionalText(input.identityRef || input.accountRef, 300)
  const materialIds = textList(input.materialIds, 'work materialIds', 100, 200)
  const assetIds = textList(input.assetIds, 'work assetIds', 50, 200)
  const capabilities = textList(input.capabilities, 'work capabilities')
  const logicalParent = optionalText(input.logicalParent, 200)
  const proposedBy = optionalText(input.proposedBy, 200)
  const normalControl = optionalText(input.normalControl, 2000)
  const successCriterion = clampText(input.successCriterion || 'A reproducible observation with source and control.', 'work successCriterion', 3000)
  const falsifier = optionalText(input.falsifier, 3000)
  const stopCriterion = optionalText(input.stopCriterion, 2000)
  const dedupeKey = digest([root, parentWorkId, logicalParent, proposedBy, title, question, target, identityRef, materialIds, assetIds])
  const existing = store.db.prepare(`SELECT record FROM role_work_items
    WHERE session_id=? AND dedupe_key=? AND state NOT IN ('completed','stopped','released')
    ORDER BY rowid DESC LIMIT 1`).get(root, dedupeKey)
  if (existing) return { ok: true, duplicate: true, work: parseRecord(existing) }
  const workId = optionalText(input.workId, 160) || 'work-' + randomUUID()
  if (!/^work-[A-Za-z0-9._-]+$/.test(workId)) throw new Error('workId must start with work- and contain only safe characters')
  if (parentWorkId) {
    const parent = readWorkItem(store, root, parentWorkId)
    if (!parent) throw new Error('parent work item not found in current root')
  }
  const record = {
    schema: 'saker.work-item/1',
    workId, rootId: root, parentWorkId, logicalParent, proposedBy, title, question, target, identityRef,
    materialIds, assetIds, capabilities, normalControl, successCriterion, falsifier, stopCriterion,
    state: 'proposed', revision: 1, dedupeKey,
    createdAt: now(),
  }
  store.db.prepare(`INSERT INTO role_work_items(session_id,work_id,parent_work_id,dedupe_key,state,revision,record,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(root, workId, parentWorkId, dedupeKey, record.state, 1, JSON.stringify(record), now())
  return { ok: true, duplicate: false, work: record }
}

export function readWorkItem(store, rootSession, workId) {
  const row = store.db.prepare('SELECT record FROM role_work_items WHERE session_id=? AND work_id=?').get(rootSession, String(workId || ''))
  return parseRecord(row)
}

export function listWorkItems(store, rootSession, limit = 100) {
  const count = Number(limit)
  const rows = count === 0
    ? store.db.prepare('SELECT record FROM role_work_items WHERE session_id=? ORDER BY rowid DESC').all(rootSession)
    : store.db.prepare('SELECT record FROM role_work_items WHERE session_id=? ORDER BY rowid DESC LIMIT ?')
      .all(rootSession, Math.max(1, Math.min(500, count || 100)))
  return rows
    .map(parseRecord).filter(Boolean)
}

const WORK_TERMINAL = new Set(['completed', 'stopped', 'released'])
const WORK_TRANSITIONS = {
  proposed: new Set(['proposed', 'queued', 'starting', 'active', 'waiting', 'blocked', 'completed', 'stopped']),
  queued: new Set(['queued', 'starting', 'active', 'blocked', 'completed', 'stopped']),
  starting: new Set(['starting', 'active', 'waiting', 'blocked', 'completed', 'stopped', 'cleanup-failed']),
  active: new Set(['active', 'waiting', 'blocked', 'completed', 'stopped', 'cleanup-failed']),
  waiting: new Set(['waiting', 'active', 'blocked', 'completed', 'stopped', 'cleanup-failed']),
  blocked: new Set(['blocked', 'queued', 'starting', 'active', 'completed', 'stopped']),
  'cleanup-failed': new Set(['cleanup-failed', 'stopped']),
  completed: new Set(['completed']),
  stopped: new Set(['stopped']),
  released: new Set(['released']),
}
export function updateWorkItem(store, rootSession, workId, patch = {}, event = 'updated') {
  const work = readWorkItem(store, rootSession, workId)
  if (!work) throw new Error('work item not found in current root')
  const expected = patch.expectedRevision
  if (expected !== undefined) {
    const value = Number(expected)
    if (!Number.isInteger(value) || value < 1) throw new Error('expectedRevision must be a positive integer')
    if (value !== Number(work.revision)) {
      throw new Error('work revision conflict: expected ' + value + ', current ' + work.revision + '; refresh before retrying')
    }
  }
  for (const immutable of ['workId', 'rootId', 'dedupeKey', 'createdAt', 'schema', 'revision']) {
    if (patch[immutable] !== undefined && patch[immutable] !== work[immutable]) {
      throw new Error('work field is immutable: ' + immutable)
    }
  }
  const body = { ...patch }
  delete body.expectedRevision
  const currentState = WORK_TERMINAL.has(work.state) ? checkState(work.state) : checkState(work.state)
  const nextState = body.state === undefined ? currentState : checkState(body.state)
  const allowed = WORK_TRANSITIONS[currentState]
  if (WORK_TERMINAL.has(currentState) && nextState !== currentState) {
    throw new Error('work ' + workId + ' is ' + currentState + ' and cannot be reopened; create a successor work item')
  }
  if (allowed && !allowed.has(nextState)) {
    throw new Error('work transition ' + currentState + ' -> ' + nextState + ' is not allowed')
  }
  const revision = Number(work.revision || 1) + 1
  const next = { ...work, ...body, state: nextState, revision, updatedAt: now(), lastEvent: event }
  const result = store.db.prepare('UPDATE role_work_items SET state=?,revision=?,record=?,updated_at=? WHERE session_id=? AND work_id=? AND revision=?')
    .run(next.state, revision, JSON.stringify(next), now(), rootSession, workId, Number(work.revision || 1))
  if (Number(result.changes) !== 1) throw new Error('work revision conflict; refresh before retrying')
  return next
}

export function listRoleInstances(store, rootSession) {
  return store.db.prepare('SELECT record FROM role_instances WHERE session_id=? ORDER BY rowid').all(rootSession)
    .map(parseRecord).filter(Boolean)
}

export function listRoleQueue(store, rootSession) {
  return store.db.prepare('SELECT record FROM role_queue WHERE session_id=? ORDER BY created_at, queue_id')
    .all(rootSession).map(parseRecord).filter(Boolean)
}

function saveRoleQueue(store, rootSession, record) {
  store.db.prepare(`INSERT INTO role_queue(session_id,queue_id,role_id,role_version,work_id,logical_parent,
    depth,generation,state,record,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id,queue_id) DO UPDATE SET state=excluded.state,record=excluded.record,updated_at=excluded.updated_at`)
    .run(rootSession, record.queueId, record.roleId, record.roleVersion, record.workId,
      record.logicalParent || '', record.depth || 1, record.generation || 1, record.state || 'queued',
      JSON.stringify(record), record.createdAt || now(), now())
  return record
}

function updateRoleQueue(store, rootSession, queueId, patch = {}) {
  const current = listRoleQueue(store, rootSession).find(item => item.queueId === String(queueId || ''))
  if (!current) throw new Error('queued role request not found in current root')
  return saveRoleQueue(store, rootSession, { ...current, ...patch, updatedAt: now() })
}

function generationOf(store, rootId) {
  return Number(store.db.prepare('SELECT COUNT(*) AS n FROM task_rounds WHERE session_id=?').get(rootId)?.n || 0) + 1
}

/**
 * Reconcile durable role/work rows against the current Host process after a
 * restart. A missing (or no-longer-running) child agent cannot be reported as
 * active. The result is unknown, not success; the queued rows stay queued for
 * an explicit user resume.
 */
export function reconcileOrphanedRoles(store, rootSession, isLive = () => false) {
  ensureRoleSchema(store)
  const released = reconcileReleasedRoleSettlements(store, rootSession)
  let changed = released.changed
  for (const instance of listRoleInstances(store, rootSession)) {
    if (!['active', 'starting', 'waiting'].includes(instance.state)) continue
    if (isLive(instance.childId)) continue
    const blocker = 'Desktop restarted while the child Host agent was not running; result unknown; no automatic replay'
    updateRoleInstance(store, rootSession, instance.childId, {
      state: 'stopped', stoppedAt: now(), cleanupState: 'unknown', reportState: 'blocked',
      error: blocker,
    })
    const work = readWorkItem(store, rootSession, instance.workId)
    if (work && !WORK_TERMINAL.has(work.state)) {
      updateWorkItem(store, rootSession, work.workId, {
        expectedRevision: work.revision, state: 'blocked', blocker,
      }, 'restart-reconcile')
    }
    for (const attempt of listAttempts(store, rootSession, 200)) {
      if (attempt.childId !== instance.childId
        || Number(attempt.generation || 1) !== Number(instance.generation || 1)
        || ['completed', 'stopped', 'blocked', 'cleanup-failed'].includes(attempt.state)) continue
      updateAttempt(store, rootSession, attempt.attemptId, { state: 'blocked', blocker })
    }
    changed += 1
  }
  return { changed, skipped: released.skipped }
}

export function readRoleInstance(store, rootSession, instanceId) {
  const row = store.db.prepare('SELECT record FROM role_instances WHERE session_id=? AND child_id=?').get(rootSession, String(instanceId || ''))
  return parseRecord(row)
}

function saveRoleInstance(store, rootSession, record) {
  store.db.prepare(`INSERT INTO role_instances(session_id,child_id,role_id,role_version,work_id,logical_parent,generation,state,record,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,child_id) DO UPDATE SET
    role_id=excluded.role_id,role_version=excluded.role_version,work_id=excluded.work_id,
    logical_parent=excluded.logical_parent,generation=excluded.generation,state=excluded.state,
    record=excluded.record,updated_at=excluded.updated_at`)
    .run(rootSession, record.childId, record.roleId, record.roleVersion, record.workId,
      record.logicalParent || '', record.generation || 1, record.state || 'queued',
      JSON.stringify(record), now())
  return record
}

export function updateRoleInstance(store, rootSession, childId, patch = {}) {
  const current = readRoleInstance(store, rootSession, childId)
  if (!current) throw new Error('role instance not found in current root')
  return saveRoleInstance(store, rootSession, { ...current, ...patch, updatedAt: now() })
}

export function beginAttempt(store, rootSession, input = {}) {
  ensureRoleSchema(store)
  const workId = clampText(input.workId, 'attempt workId', 160)
  const childId = clampText(input.childId, 'attempt childId', 160)
  const idempotencyKey = clampText(input.idempotencyKey || workId + ':' + childId, 'attempt idempotencyKey', 300)
  const existing = store.db.prepare('SELECT record FROM role_attempts WHERE session_id=? AND work_id=? AND idempotency_key=?')
    .get(rootSession, workId, idempotencyKey)
  if (existing) return { ...parseRecord(existing), duplicate: true }
  const attempt = {
    schema: 'saker.role-attempt/1', attemptId: 'attempt-' + randomUUID(), workId, childId,
    generation: Number(input.generation) || 1, idempotencyKey, state: checkState(input.state || 'starting'),
    startedAt: now(), inputRevision: optionalText(input.inputRevision, 200),
    leaseToken: optionalText(input.leaseToken, 200),
  }
  store.db.prepare(`INSERT INTO role_attempts(session_id,attempt_id,work_id,child_id,idempotency_key,state,record,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(rootSession, attempt.attemptId, workId, childId, idempotencyKey, attempt.state, JSON.stringify(attempt), now())
  return { ...attempt, duplicate: false }
}

export function updateAttempt(store, rootSession, attemptId, patch = {}) {
  const row = store.db.prepare('SELECT record FROM role_attempts WHERE session_id=? AND attempt_id=?').get(rootSession, attemptId)
  const current = parseRecord(row)
  if (!current) throw new Error('attempt not found')
  const attempt = { ...current, ...patch, updatedAt: now() }
  if (patch.state !== undefined) attempt.state = checkState(patch.state)
  store.db.prepare('UPDATE role_attempts SET state=?,record=?,updated_at=? WHERE session_id=? AND attempt_id=?')
    .run(attempt.state, JSON.stringify(attempt), now(), rootSession, attemptId)
  return attempt
}

export function listAttempts(store, rootSession, limit = 100) {
  const count = Number(limit)
  const rows = count === 0
    ? store.db.prepare('SELECT record FROM role_attempts WHERE session_id=? ORDER BY rowid DESC').all(rootSession)
    : store.db.prepare('SELECT record FROM role_attempts WHERE session_id=? ORDER BY rowid DESC LIMIT ?')
      .all(rootSession, Math.max(1, Math.min(500, count || 100)))
  return rows
    .map(parseRecord).filter(Boolean)
}

export function recordRoleMessage(store, rootSession, message = {}) {
  ensureRoleSchema(store)
  const messageId = clampText(message.messageId || 'msg-' + randomUUID(), 'messageId', 200)
  const content = {
    schema: 'saker.role-message/1', messageId,
    rootId: rootSession,
    fromInstance: clampText(message.fromInstance, 'fromInstance', 200),
    toInstance: clampText(message.toInstance, 'toInstance', 200),
    kind: ['request', 'evidence', 'steer', 'handoff'].includes(message.kind) ? message.kind : 'request',
    workId: optionalText(message.workId, 160),
    materialRefs: textList(message.materialRefs, 'materialRefs', 50, 500),
    sourceRevision: optionalText(message.sourceRevision, 200),
    generation: Number(message.generation) || 1,
    text: clampText(message.text, 'message text', 4000),
  }
  const hash = digest(content)
  const record = { ...content, state: 'pending', createdAt: now() }
  const existing = store.db.prepare('SELECT digest,record FROM role_messages WHERE session_id=? AND message_id=?').get(rootSession, messageId)
  if (existing) {
    if (existing.digest !== hash) throw new Error('messageId already exists with different content')
    return { message: parseRecord(existing), duplicate: true }
  }
  store.db.prepare(`INSERT INTO role_messages(session_id,message_id,digest,from_instance,to_instance,kind,generation,state,record,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(rootSession, messageId, hash, record.fromInstance, record.toInstance, record.kind,
      record.generation, record.state, JSON.stringify(record), Date.now())
  return { message: record, duplicate: false }
}

export function markRoleMessage(store, rootSession, messageId, patch = {}) {
  const row = store.db.prepare('SELECT record FROM role_messages WHERE session_id=? AND message_id=?').get(rootSession, messageId)
  const current = parseRecord(row)
  if (!current) throw new Error('message not found')
  const message = { ...current, ...patch, updatedAt: now() }
  store.db.prepare('UPDATE role_messages SET state=?,record=? WHERE session_id=? AND message_id=?')
    .run(message.state || current.state, JSON.stringify(message), rootSession, messageId)
  return message
}

export function listRoleMessages(store, rootSession, limit = 100) {
  return store.db.prepare('SELECT record FROM role_messages WHERE session_id=? ORDER BY created_at DESC LIMIT ?').all(rootSession, Math.max(1, Math.min(500, Number(limit) || 100)))
    .map(parseRecord).filter(Boolean)
}

function settleRoleRecord(store, rootSession, childId, workerState, reportState = '') {
  const instance = readRoleInstance(store, rootSession, childId)
  if (!instance) return null
  const activeGeneration = generationOf(store, rootSession)
  if (!['completed', 'stopped', 'released', 'cleanup-failed'].includes(instance.state)
    && Number(instance.generation || 1) !== activeGeneration)
    return instance
  if (['completed', 'stopped', 'released', 'cleanup-failed'].includes(instance.state)) {
    if (workerState === 'released' && instance.releaseState !== 'released')
      return updateRoleInstance(store, rootSession, childId, {
        releaseState: 'released', releaseConfirmedAt: now(), cleanupState: 'clear', releaseError: '',
      })
    if (workerState === 'cleanup-failed' && instance.releaseState !== 'cleanup-failed')
      return updateRoleInstance(store, rootSession, childId, {
        releaseState: 'cleanup-failed', cleanupState: 'unknown',
        releaseError: instance.releaseError || '释放未确认', error: instance.releaseError || '释放未确认',
      })
    return instance
  }
  const next = workerState === 'cleanup-failed' ? 'cleanup-failed'
    : reportState === 'completed' ? 'completed'
    : reportState === 'blocked' ? 'stopped'
    : 'stopped'
  updateRoleInstance(store, rootSession, childId, {
    state: next, stoppedAt: now(),
    releaseState: workerState === 'released' ? 'released'
      : workerState === 'cleanup-failed' ? 'cleanup-failed' : 'stopping',
    ...(workerState === 'released' ? { releaseConfirmedAt: now(), releaseError: '' } : {}),
    ...(workerState === 'cleanup-failed' ? { releaseError: instance.releaseError || '释放未确认', error: instance.releaseError || '释放未确认' } : {}),
    ...(workerState === 'released' ? { cleanupState: 'clear' } : { cleanupState: 'unknown' }),
    ...(reportState ? { reportState } : {}),
  })
  const work = readWorkItem(store, rootSession, instance.workId)
  if (work) {
    const workState = ['completed', 'stopped', 'released'].includes(work.state)
      ? work.state
      : next === 'completed' ? 'completed' : next === 'cleanup-failed' ? 'cleanup-failed' : 'stopped'
    updateWorkItem(store, rootSession, instance.workId, {
      expectedRevision: work.revision,
      state: workState,
      executionState: workerState === 'released' ? 'released'
        : workerState === 'cleanup-failed' ? 'cleanup-failed' : 'stopping',
      releaseState: workerState === 'released' ? 'released'
        : workerState === 'cleanup-failed' ? 'cleanup-failed' : 'stopping',
      ...(workerState === 'released' ? { releaseConfirmedAt: now(), releaseError: '' } : {}),
      ...(workerState === 'cleanup-failed' ? { releaseError: instance.releaseError || '释放未确认' } : {}),
      ...(reportState ? { reportState } : {}),
    }, 'worker-' + next)
  }
  for (const attempt of listAttempts(store, rootSession, 200)) {
    if (attempt.childId === childId
      && Number(attempt.generation || 1) === Number(instance.generation || 1)
      && !['completed', 'stopped', 'blocked', 'cleanup-failed'].includes(attempt.state))
      updateAttempt(store, rootSession, attempt.attemptId, { state: next === 'completed' ? 'completed' : next === 'cleanup-failed' ? 'cleanup-failed' : 'stopped' })
  }
  return readRoleInstance(store, rootSession, childId)
}

function releaseObservation(store, rootSession, instance) {
  if (!instance) return null
  const row = store.db.prepare('SELECT record FROM site_workers WHERE child_id=?').get(instance.childId)
  const worker = parseRecord(row)
  if (!worker) {
    if (instance.releaseState === 'released') return null
    return { status: 'unknown-worker', observedWorkerState: '', generation: Number(instance.generation || 1),
      canReconcile: false, label: '执行实例记录缺失，释放未确认' }
  }
  if (worker.state === 'released' && instance.releaseState === 'released') return null
  const closedBusiness = ['completed', 'stopped', 'released', 'cleanup-failed'].includes(instance.state)
  if (!['released', 'cleanup-failed'].includes(worker.state) && !closedBusiness) return null
  const attempts = listAttempts(store, rootSession, 0).filter(item => item.childId === instance.childId)
  const matching = attempts.filter(item => Number(item.generation || 1) === Number(instance.generation || 1))
  const stale = attempts.length > 0 && matching.length === 0
  return {
    status: stale ? 'stale-release' : 'pending-settlement',
    observedWorkerState: worker.state,
    reportState: worker.report?.state || '',
    generation: Number(instance.generation || 1),
    canReconcile: !stale,
    label: stale ? '旧代释放事件，状态待核对'
      : worker.state === 'cleanup-failed' ? '释放未确认，状态待对账'
      : worker.state === 'released' ? '释放已观察、状态待对账'
      : '业务已完成，执行实例仍活跃',
  }
}

export function reconcileReleasedRoleSettlements(store, rootSession) {
  let changed = 0
  const skipped = []
  const activeGeneration = generationOf(store, rootSession)
  for (const instance of listRoleInstances(store, rootSession)) {
    if (Number(instance.generation || 1) !== activeGeneration) {
      skipped.push({ childId: instance.childId, reason: 'generation-mismatch',
        instanceGeneration: Number(instance.generation || 1), activeGeneration })
      continue
    }
    const row = store.db.prepare('SELECT record FROM site_workers WHERE child_id=?').get(instance.childId)
    if (!row) continue
    const worker = parseRecord(row)
    if (!worker || !['released', 'cleanup-failed'].includes(worker.state)) continue
    if (['completed', 'stopped', 'released', 'cleanup-failed'].includes(instance.state)) {
      if ((worker.state === 'released' && instance.releaseState !== 'released')
        || (worker.state === 'cleanup-failed' && instance.releaseState !== 'cleanup-failed')) {
        settleRoleRecord(store, rootSession, instance.childId, worker.state, worker.report?.state || '')
        changed += 1
      }
      continue
    }
    settleRoleRecord(store, rootSession, instance.childId, worker.state, worker.report?.state || '')
    changed += 1
  }
  return { changed, skipped }
}

export function roleStatus(store, rootSession) {
  const instances = listRoleInstances(store, rootSession).map(instance => {
    const settlement = releaseObservation(store, rootSession, instance)
    return settlement ? { ...instance, settlement } : instance
  })
  const settlementByWork = new Map(instances
    .filter(item => item.settlement)
    .map(item => [item.workId, item.settlement]))
  const workItems = listWorkItems(store, rootSession, 0).map(work => {
    const settlement = settlementByWork.get(work.workId)
    return settlement ? { ...work, settlement } : work
  })
  return {
    roles: listRoleSpecs(store, rootSession),
    workItems,
    instances,
    queue: listRoleQueue(store, rootSession),
    attempts: listAttempts(store, rootSession, 0),
    messages: listRoleMessages(store, rootSession),
    settlementPending: instances.filter(item => item.settlement?.status === 'pending-settlement').length,
  }
}

export function createRoleOrchestrator({ ctx, getStore, siteWorkers, taskStatus, siteParent }) {
  const store = () => getStore()
  const service = key => ctx[key] || ctx.get?.(key)
  const rootFor = agent => {
    const sessionId = agent?.session?.id
    if (!sessionId) throw new Error('agent session required')
    const parent = siteParent(store(), sessionId)
    return { sessionId, rootId: parent || sessionId, isRoot: !parent }
  }
  const assertRoot = agent => {
    const value = rootFor(agent)
    if (!value.isRoot) throw new Error('only the root agent may start or stop role instances')
    return value
  }
  const activeLimit = (rootId) => {
    const state = taskStatus(store(), rootId)
    if (!state.configured)
      throw new Error('角色启动需要先开始一个有界任务。请先在设置里填写目标，或直接发送带目标的指令。')
    if (state.stopped)
      throw new Error('当前有界任务已停止，不能启动新角色。请新建一轮任务后再试。')
    return Math.max(0, Number(state.policy.workerLimit || 0))
  }

  async function start(agent, input = {}, signal) {
    const { rootId } = assertRoot(agent)
    const limit = activeLimit(rootId)
    const generation = generationOf(store(), rootId)
    const inlineRole = input.role && typeof input.role === 'object' ? input.role : null
    const role = inlineRole && !inlineRole.roleId
      ? createRoleSpec(store(), rootId, inlineRole).role
      : readRoleSpec(store(), rootId, input.roleId || inlineRole?.roleId, input.roleVersion || inlineRole?.version)
    if (!role) throw new Error('role definition not found')
    let work = input.workId ? readWorkItem(store(), rootId, input.workId) : null
    if (!work && input.work) work = createWorkItem(store(), rootId, input.work).work
    if (!work) work = createWorkItem(store(), rootId, {
      title: input.title || role.title + ' work',
      question: input.question || role.objective,
      target: input.target, identityRef: input.identityRef,
      materialIds: input.materialIds, assetIds: input.assetIds,
      capabilities: role.capabilities,
    }).work
    if (['completed', 'stopped', 'released'].includes(work.state))
      throw new Error('work ' + work.workId + ' is ' + work.state + ' and cannot be reopened; create a successor work item')
    const priorInstances = listRoleInstances(store(), rootId).filter(item => item.workId === work.workId)
    const blockingRelease = priorInstances.find(item => item.stopIntentId
      && item.releaseState !== 'released' && item.state !== 'released')
    if (blockingRelease)
      throw new Error('work release is ' + (blockingRelease.releaseState || blockingRelease.state)
        + '; resolve the existing stop before starting another role')
    const activeHost = work.activeInstance ? readHostWorker(store(), work.activeInstance) : null
    if (work.activeInstance && activeHost && activeHost.state !== 'released')
      throw new Error('work already has an unreleased Host child; stop it before starting another role')
    const logicalParent = optionalText(input.logicalParent || work.logicalParent, 200)
    let depth = 1
    let handoffContext = ''
    if (logicalParent) {
      const parent = readRoleInstance(store(), rootId, logicalParent)
      if (!parent) throw new Error('logical parent instance not found in current root')
      depth = Number(parent.depth || 1) + 1
      if (depth > 2) throw new Error('role delegation depth exceeds 2; submit the work for root handling')
      const parentWork = readWorkItem(store(), rootId, parent.workId)
      const parentAttempts = listAttempts(store(), rootId, 20).filter(item => item.workId === parent.workId)
      handoffContext = [
        parentWork?.title ? 'parent work: ' + parentWork.title : '',
        parentWork?.question ? 'parent question: ' + parentWork.question : '',
        parentAttempts.length ? 'attempts: ' + parentAttempts.map(item => item.state + ':' + item.childId).join(', ') : '',
        work.materialIds?.length ? 'shared materials: ' + work.materialIds.join(', ') : '',
        work.assetIds?.length ? 'target assets: ' + work.assetIds.join(', ') : '',
      ].filter(Boolean).join('\n')
    }
    const workerView = siteWorkers.status ? await siteWorkers.status(agent, signal) : null
    if (workerView && Number(workerView.active || 0) >= limit) {
      const queueId = optionalText(input.queueId, 200) || 'role-queue-' + randomUUID()
      const existingQueue = listRoleQueue(store(), rootId).find(item => item.queueId === queueId)
      const queue = saveRoleQueue(store(), rootId, {
        ...(existingQueue || {}),
        queueId, roleId: role.roleId, roleVersion: role.version, workId: work.workId,
        logicalParent, depth, generation: existingQueue?.generation || generation,
        state: 'queued', roleTitle: role.title, objective: role.objective,
        queuedAt: existingQueue?.queuedAt || now(), queueReason: 'worker limit reached',
      })
      const queuedWork = updateWorkItem(store(), rootId, work.workId, { state: 'queued', queueReason: 'worker limit reached' }, 'queued')
      return { ok: true, queued: true, queue, queueRef: { id: queue.queueId, generation: queue.generation },
        work: queuedWork, reason: 'root worker limit reached; queued without a Host child identity' }
    }
    let started
    try {
      started = await siteWorkers.assist(agent, {
        goal: work.question,
        purpose: role.model?.reasoningEffort === 'low' ? 'investigate' : 'analyze',
        why: role.objective,
        materialIds: work.materialIds,
        assetIds: work.assetIds,
        target: work.target,
        tools: role.tools,
        modelOptions: role.model,
        role: {
          roleId: role.roleId, roleVersion: role.version, title: role.title,
          objective: role.objective, responsibilities: role.responsibilities,
          deliverable: role.deliverable, capabilities: role.capabilities,
          logicalParent, depth, workId: work.workId,
          delegationRequestId: optionalText(input.delegationRequestId, 200),
          handoffContext,
        },
      }, signal)
    } catch (error) {
      if (/worker limit/i.test(String(error?.message || error))) {
        const queueId = optionalText(input.queueId, 200) || 'role-queue-' + randomUUID()
        const existingQueue = listRoleQueue(store(), rootId).find(item => item.queueId === queueId)
        const queue = saveRoleQueue(store(), rootId, {
          ...(existingQueue || {}),
          queueId, roleId: role.roleId, roleVersion: role.version, workId: work.workId,
          logicalParent, depth, generation: existingQueue?.generation || generation,
          state: 'queued', roleTitle: role.title, objective: role.objective,
          queuedAt: existingQueue?.queuedAt || now(), queueError: String(error.message || error),
        })
        return { ok: true, queued: true, queue, queueRef: { id: queue.queueId, generation: queue.generation },
          work: updateWorkItem(store(), rootId, work.workId, { state: 'queued' }, 'queued') }
      }
      updateWorkItem(store(), rootId, work.workId, { state: 'blocked', blocker: String(error?.message || error) }, 'start-failed')
      throw error
    }
    const childId = started.childId
    const instance = saveRoleInstance(store(), rootId, {
      childId, roleId: role.roleId, roleVersion: role.version, workId: work.workId,
      logicalParent, depth, generation, state: 'active', roleTitle: role.title,
      objective: role.objective, activation: started.activation || 'host', startedAt: now(),
      releaseState: 'unreleased', releaseAttempt: 0, releaseRequestedAt: null, releaseConfirmedAt: null,
    })
    const attempt = beginAttempt(store(), rootId, {
      workId: work.workId, childId, idempotencyKey: optionalText(input.idempotencyKey, 300) || work.workId + ':' + childId,
      state: 'active', generation,
    })
    if (attempt.duplicate) throw new Error('attempt idempotency key already exists')
    updateWorkItem(store(), rootId, work.workId, { state: 'active', activeInstance: childId }, 'started')
    return { ok: true, queued: false, role, work: readWorkItem(store(), rootId, work.workId), instance, attempt, childId, workers: started.workers }
  }

  async function message(agent, input = {}, signal) {
    const { sessionId, rootId } = rootFor(agent)
    const targetId = input.toInstance || input.childId || input.instanceId || input.targetInstanceId || input.target
    let to = readRoleInstance(store(), rootId, targetId)
    if (!to && (input.roleId || input.workId)) {
      const active = listRoleInstances(store(), rootId).filter(item => !['released', 'stopped'].includes(item.state))
      to = active.find(item => input.roleId && item.roleId === input.roleId)
        || active.find(item => input.workId && item.workId === input.workId)
        || null
    }
    const from = sessionId === rootId ? null : readRoleInstance(store(), rootId, sessionId)
    if (!to) {
      const active = listRoleInstances(store(), rootId).filter(item => !['released', 'stopped'].includes(item.state))
      throw new Error('target role instance not found in current root'
        + (active.length ? '; active childIds: ' + active.map(item => item.childId).join(', ') : '; no active role instance'))
    }
    if (sessionId !== rootId && !from) throw new Error('sender is not a recorded role instance')
    if (['released', 'stopped'].includes(to.state)) throw new Error('target role instance is not active')
    const messageId = optionalText(input.messageId || input.idempotencyKey, 200) || 'msg-' + randomUUID()
    const text = clampText(input.message || input.text || input.content, 'message text', 4000)
    const recorded = recordRoleMessage(store(), rootId, {
      messageId, fromInstance: sessionId, toInstance: to.childId,
      kind: input.kind || (from ? 'evidence' : 'steer'), workId: input.workId || to.workId,
      materialRefs: input.materialRefs, sourceRevision: input.sourceRevision,
      generation: to.generation || 1, text,
    })
    if (recorded.duplicate) return { ok: true, duplicate: true, message: recorded.message }
    try {
      let result
      if (sessionId === rootId) result = await siteWorkers.send(agent, { childId: to.childId, message: text }, signal)
      else {
        const subagents = service('subagents')
        if (typeof subagents?.sendMessage !== 'function') throw new Error('host message service unavailable')
        result = { messageId: await subagents.sendMessage(agent, to.childId, [{ type: 'text', text }], { signal }) }
      }
      const delivered = markRoleMessage(store(), rootId, messageId, { state: 'delivered', hostMessageId: result?.messageId || '' })
      return { ok: true, duplicate: false, message: delivered, host: result }
    } catch (error) {
      markRoleMessage(store(), rootId, messageId, { state: 'delivery-failed', error: String(error?.message || error) })
      throw error
    }
  }

  function propose(agent, input = {}) {
    const { sessionId, rootId } = rootFor(agent)
    const inlineRole = input.role && typeof input.role === 'object' ? input.role : null
    const role = inlineRole && !inlineRole.roleId
      ? createRoleSpec(store(), rootId, { ...inlineRole, source: 'model', createdBy: sessionId }).role
      : readRoleSpec(store(), rootId, input.roleId || inlineRole?.roleId, input.roleVersion || inlineRole?.version)
    if (!role) throw new Error('role definition not found')
    const workInput = input.work && typeof input.work === 'object' ? input.work : {}
    const work = createWorkItem(store(), rootId, {
      ...workInput,
      title: workInput.title || input.title || role.title + ' proposal',
      question: workInput.question || input.question || role.objective,
      parentWorkId: workInput.parentWorkId || input.parentWorkId,
      logicalParent: workInput.logicalParent || (sessionId === rootId ? '' : sessionId),
      proposedBy: sessionId,
    }).work
    return { ok: true, status: 'proposed', rootId, role, work }
  }

  async function stop(agent, input = {}, signal) {
    const { rootId } = assertRoot(agent)
    const instances = listRoleInstances(store(), rootId)
    const target = optionalText(input.instanceId || input.childId, 200)
    const logicalParent = optionalText(input.logicalParent, 200)
    const all = input.all === true
    const selected = instances.filter(item => all
      || (target && item.childId === target)
      || (logicalParent && (item.logicalParent === logicalParent || item.childId === logicalParent)))
    const selectedQueue = listRoleQueue(store(), rootId).filter(item => item.state === 'queued' && (all
      || (target && item.queueId === target)
      || (logicalParent && (item.logicalParent === logicalParent || item.queueId === logicalParent))))
    const stopped = []
    const already = []
    const pending = []
    for (const instance of selected) {
      const work = readWorkItem(store(), rootId, instance.workId)
      const host = readHostWorker(store(), instance.childId)
      const hostReleased = host?.state === 'released'
      const businessTerminal = ['completed', 'stopped', 'released'].includes(work?.state)
      const instanceReleased = instance.releaseState === 'released'
        || ((!host || hostReleased) && ['stopped', 'released'].includes(instance.state) && businessTerminal)
      if (hostReleased && instanceReleased) {
        already.push({ childId: instance.childId, state: instance.state, workId: instance.workId,
          workState: work?.state || '', releaseState: instance.releaseState || 'released' })
        continue
      }
      const businessCompleted = work?.state === 'completed'
      const attempt = Number(instance.releaseAttempt || 0) + 1
      const stopIntentId = optionalText(input.stopIntentId, 200) || 'stop-' + randomUUID()
      const stoppingState = businessCompleted ? 'completed'
        : ['stopped', 'released'].includes(instance.state) ? instance.state : 'stopping'
      updateRoleInstance(store(), rootId, instance.childId, {
        state: stoppingState, releaseState: 'stopping', releaseAttempt: attempt,
        releaseRequestedAt: now(), stopIntentId, releaseError: '',
      })
      if (work) updateWorkItem(store(), rootId, instance.workId, {
        state: businessCompleted ? 'completed' : work.state,
        executionState: 'stopping', stopIntentId, releaseAttempt: attempt, releaseRequestedAt: now(),
      }, 'stop-requested')
      let release = null
      if (hostReleased) {
        release = { workers: [{ childId: instance.childId, state: 'released' }] }
      } else if (!host) {
        release = { error: 'host worker record missing; release is unconfirmed' }
      } else if (!instance.childId.startsWith('queued-')) {
        try { release = await siteWorkers.cleanup(agent, instance.childId, input.reason || 'role stopped') }
        catch (error) { release = { error: String(error?.message || error) } }
      } else {
        release = { error: 'queued role has no Host child to release' }
      }
      const worker = release?.workers?.find(item => item.childId === instance.childId)
      const after = readHostWorker(store(), instance.childId)
      const confirmed = !release?.error && (worker?.state === 'released' || after?.state === 'released')
      const cleanupError = release?.error || worker?.error || after?.error
        || (confirmed ? '' : 'host release not confirmed')
      if (confirmed) {
        const next = updateRoleInstance(store(), rootId, instance.childId, {
          state: 'stopped', releaseState: 'released', releaseAttempt: attempt,
          releaseConfirmedAt: now(), stoppedAt: now(), releaseError: '',
        })
        if (work) updateWorkItem(store(), rootId, instance.workId, {
          state: businessCompleted ? 'completed' : 'stopped',
          executionState: 'stopped', releaseState: 'released', releaseAttempt: attempt,
          releaseConfirmedAt: now(), stoppedAt: now(), stopIntentId,
        }, 'stopped')
        stopped.push({ ...next, workState: businessCompleted ? 'completed' : 'stopped' })
      } else {
        const next = updateRoleInstance(store(), rootId, instance.childId, {
          state: 'cleanup-failed', releaseState: 'cleanup-failed', releaseAttempt: attempt,
          releaseError: String(cleanupError), error: String(cleanupError), stoppedAt: null,
        })
        if (work) updateWorkItem(store(), rootId, instance.workId, {
          state: businessCompleted ? 'completed' : 'cleanup-failed',
          executionState: 'cleanup-failed', releaseState: 'cleanup-failed',
          releaseAttempt: attempt, releaseError: String(cleanupError), stopIntentId,
        }, 'cleanup-failed')
        pending.push({ ...next, workState: businessCompleted ? 'completed' : (work?.state || ''),
          releaseError: String(cleanupError) })
      }
    }
    for (const queued of selectedQueue) {
      const work = readWorkItem(store(), rootId, queued.workId)
      const next = updateRoleQueue(store(), rootId, queued.queueId, {
        state: 'stopped', stoppedAt: now(), stopReason: String(input.reason || 'role stopped').slice(0, 500),
      })
      if (work) updateWorkItem(store(), rootId, queued.workId, {
        state: work.state === 'completed' ? 'completed' : 'stopped',
        executionState: 'stopped', releaseState: 'released', stoppedAt: now(),
      }, 'stopped')
      stopped.push({ ...next, workState: work?.state || '' })
    }
    return { ok: pending.length === 0 && stopped.every(item => item.state === 'stopped'), stopped, pending, already,
      alreadyCompleted: stopped.length === 0 && pending.length === 0 && already.length > 0,
      releaseAttempts: [...stopped, ...pending].map(item => ({ childId: item.childId, releaseAttempt: item.releaseAttempt })) }
  }

  async function resumeQueued(agent, input = {}, signal) {
    const { rootId } = assertRoot(agent)
    const queuedRequest = listRoleQueue(store(), rootId).find(item => item.state === 'queued')
    if (queuedRequest) {
      const started = await start(agent, {
        roleId: queuedRequest.roleId, roleVersion: queuedRequest.roleVersion, workId: queuedRequest.workId,
        logicalParent: queuedRequest.logicalParent, idempotencyKey: 'resume:' + queuedRequest.queueId,
        queueId: queuedRequest.queueId,
      }, signal)
      if (!started.queued) {
        updateRoleQueue(store(), rootId, queuedRequest.queueId, {
          state: 'resumed', resumedAt: now(), childId: started.childId,
          activationGeneration: started.instance?.generation || generationOf(store(), rootId),
        })
      }
      return { ok: true, resumed: !started.queued, queued: started.queued,
        queue: started.queue || queuedRequest, ...started }
    }
    const queued = listRoleInstances(store(), rootId).find(item => item.state === 'queued' && item.childId.startsWith('queued-'))
    if (!queued) return { ok: true, resumed: false, reason: 'no queued role request' }
    const role = readRoleSpec(store(), rootId, queued.roleId, queued.roleVersion)
    const work = readWorkItem(store(), rootId, queued.workId)
    if (!role || !work) throw new Error('queued role or work disappeared')
    const started = await start(agent, {
      roleId: role.roleId, roleVersion: role.version, workId: work.workId,
      logicalParent: queued.logicalParent, idempotencyKey: 'resume:' + queued.childId,
    }, signal)
    if (!started.queued) {
      updateRoleInstance(store(), rootId, queued.childId, { state: 'released', supersededBy: started.childId, resumedAt: now() })
    }
    return { ok: true, resumed: !started.queued, queued: started.queued, ...started }
  }

  async function status(agent) {
    const { rootId } = rootFor(agent)
    const base = roleStatus(store(), rootId)
    const workers = siteWorkers.status ? await siteWorkers.status(agent) : null
    const reports = new Map((workers?.workers || []).map(row => [row.childId, row]))
    return {
      ok: true,
      rootId,
      roles: base.roles,
      workItems: base.workItems.map(work => ({ ...work,
        instance: base.instances.find(item => item.workId === work.workId && !['released', 'stopped'].includes(item.state)) || null,
        queue: base.queue.find(item => item.workId === work.workId && item.state === 'queued') || null })),
      instances: base.instances.map(item => ({ ...item, worker: reports.get(item.childId) || null })),
      queue: base.queue,
      attempts: base.attempts,
      messages: base.messages,
      workers,
    }
  }

  function settleWorker(row, workerState) {
    if (!row?.parentId || !row?.childId) return null
    return settleRoleRecord(store(), row.parentId, row.childId, workerState, row.report?.state || '')
  }

  return { propose, start, message, stop, resumeQueued, status, settleWorker }
}
