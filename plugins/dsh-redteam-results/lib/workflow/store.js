import { randomUUID } from 'node:crypto'
import { DEFAULT_WORKFLOWS, defaultWorkflowId, workflowById } from './defaults.js'
import { validateStepCompletion } from './completion.js'
import { normalizeDefinition, publicDefinition, validateDefinition } from './schema.js'

const TABLE = `CREATE TABLE IF NOT EXISTS saker_workflow_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  current_index INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`
const DEFINITIONS_TABLE = `CREATE TABLE IF NOT EXISTS saker_workflow_definitions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  mode TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`
const SESSION_DEFINITIONS_TABLE = `CREATE TABLE IF NOT EXISTS saker_workflow_session_definitions (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  definition TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id,id)
)`
const SELECTION_TABLE = `CREATE TABLE IF NOT EXISTS saker_workflow_selection (
  session_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`
const EVIDENCE_BINDINGS_TABLE = `CREATE TABLE IF NOT EXISTS saker_workflow_evidence (
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id,kind,evidence_id)
)`

export function ensureWorkflowSchema(store) {
  store.db.exec(TABLE)
  store.db.exec('CREATE INDEX IF NOT EXISTS idx_saker_workflow_session ON saker_workflow_runs(session_id, updated_at DESC)')
  store.db.exec(DEFINITIONS_TABLE)
  store.db.exec(SESSION_DEFINITIONS_TABLE)
  store.db.exec(SELECTION_TABLE)
  store.db.exec(EVIDENCE_BINDINGS_TABLE)
  const columns = store.db.prepare('PRAGMA table_info(saker_workflow_runs)').all()
  if (!columns.some(column => column.name === 'revision'))
    store.db.exec('ALTER TABLE saker_workflow_runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
}

const parse = row => row ? { ...row, data: JSON.parse(row.data) } : null
const parseDefinition = row => {
  if (!row) return null
  try {
    const value = JSON.parse(row.definition)
    const checked = validateDefinition(value)
    if (!checked.ok) return null
    return { ...publicDefinition(checked.definition), source: row.source || 'personal', builtin: false }
  } catch {
    return null
  }
}
const builtinDefinition = value => ({ ...publicDefinition(value), source: 'builtin', builtin: true })
const definitionSummary = value => ({
  id: value.id,
  title: value.title,
  description: value.description,
  mode: value.mode,
  version: value.version,
  contentHash: value.contentHash,
  nodes: Array.isArray(value.nodes) ? value.nodes.length : 0,
  source: value.source || 'personal',
  builtin: value.builtin === true,
})
const slug = value => String(value || 'method').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'method'

export function listWorkflowDefinitions(store, sessionId = '') {
  ensureWorkflowSchema(store)
  const rows = new Map()
  for (const value of DEFAULT_WORKFLOWS) {
    const view = builtinDefinition(value)
    rows.set(view.id, view)
  }
  for (const row of store.db.prepare('SELECT * FROM saker_workflow_definitions ORDER BY updated_at DESC').all()) {
    const value = parseDefinition(row)
    if (value) rows.set(value.id, value)
  }
  if (sessionId) {
    for (const row of store.db.prepare('SELECT * FROM saker_workflow_session_definitions WHERE session_id=? ORDER BY updated_at DESC').all(String(sessionId))) {
      const value = parseDefinition(row)
      if (!value) continue
      rows.set(value.id, { ...value, source: 'session', sessionId: String(sessionId) })
    }
  }
  return [...rows.values()].map(definitionSummary)
}

export function readWorkflowDefinition(store, workflowId, sessionId = '') {
  ensureWorkflowSchema(store)
  const id = String(workflowId || '').trim()
  const builtin = workflowById(id)
  if (builtin) return builtinDefinition(builtin)
  if (!id) return null
  if (sessionId) {
    const sessionRow = store.db.prepare('SELECT definition FROM saker_workflow_session_definitions WHERE session_id=? AND id=?')
      .get(String(sessionId), id)
    const sessionValue = parseDefinition(sessionRow)
    if (sessionValue) return { ...sessionValue, source: 'session', sessionId: String(sessionId) }
  }
  return parseDefinition(store.db.prepare('SELECT definition FROM saker_workflow_definitions WHERE id=?').get(id))
}

export function saveWorkflowDefinition(store, input = {}, { scope = 'personal', sessionId = '', requestedId = '' } = {}) {
  ensureWorkflowSchema(store)
  const normalized = normalizeDefinition(input)
  const existingBuiltin = workflowById(normalized.id)
  let id = String(requestedId || normalized.id || '').trim()
  if (!id || existingBuiltin || /^[a-z][a-z0-9_-]{1,48}$/.test(id) === false) {
    id = ('custom-' + slug(normalized.title) + '-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 6))
      .slice(0, 48).replace(/-+$/g, '')
  }
  const checked = validateDefinition({ ...input, id })
  if (!checked.ok) throw Object.assign(new Error('工作流不完整：' + checked.errors.join('；')), { code: 'workflow_invalid', details: checked.errors })
  const at = Date.now()
  let version = checked.definition.version || '1'
  if (scope === 'session') {
    if (!sessionId) throw new Error('sessionId required for session workflow')
    const previous = readWorkflowDefinition(store, id, sessionId)
    version = String((Number(previous?.version) || 0) + 1)
    const value = { ...publicDefinition(checked.definition), id, version, contentHash: checked.definition.contentHash, source: 'session' }
    store.db.prepare(`INSERT INTO saker_workflow_session_definitions(session_id,id,definition,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET definition=excluded.definition,updated_at=excluded.updated_at`)
      .run(String(sessionId), id, JSON.stringify(value), at)
    return { ...value, source: 'session', builtin: false }
  }
  const previous = readWorkflowDefinition(store, id, sessionId)
  if (previous?.source === 'personal') version = String((Number(previous.version) || 0) + 1)
  const value = { ...publicDefinition(checked.definition), id, version, contentHash: checked.definition.contentHash, source: 'personal' }
  store.db.prepare(`INSERT INTO saker_workflow_definitions(id,title,description,mode,version,content_hash,definition,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,mode=excluded.mode,
      version=excluded.version,content_hash=excluded.content_hash,definition=excluded.definition,updated_at=excluded.updated_at`)
    .run(id, value.title, value.description, value.mode, value.version, value.contentHash,
      JSON.stringify(value), previous?.source === 'personal' ? at : at, at)
  return { ...value, builtin: false }
}

export function deleteWorkflowDefinition(store, workflowId, { scope = 'personal', sessionId = '', mode = 'pentest' } = {}) {
  ensureWorkflowSchema(store)
  const id = String(workflowId || '')
  if (workflowById(id)) throw new Error('内置方法不能删除；可以复制后修改')
  if (scope === 'session') {
    if (!sessionId) throw new Error('sessionId required')
    store.db.prepare('DELETE FROM saker_workflow_session_definitions WHERE session_id=? AND id=?').run(String(sessionId), id)
  } else {
    store.db.prepare('DELETE FROM saker_workflow_definitions WHERE id=?').run(id)
  }
  if (sessionId) {
    const selected = selectedWorkflow(store, sessionId, mode)
    if (selected.id === id) selectWorkflow(store, sessionId, defaultWorkflowId(mode))
  }
  return { id, deleted: true }
}

export function selectedWorkflow(store, sessionId, mode = 'pentest') {
  ensureWorkflowSchema(store)
  const row = store.db.prepare('SELECT workflow_id FROM saker_workflow_selection WHERE session_id=?').get(String(sessionId || ''))
  const value = row ? readWorkflowDefinition(store, row.workflow_id, sessionId) : null
  if (value) return value
  return builtinDefinition(workflowById(defaultWorkflowId(mode)) || workflowById('web-default'))
}

export function selectWorkflow(store, sessionId, workflowId) {
  ensureWorkflowSchema(store)
  const id = String(sessionId || '')
  if (!id) throw new Error('sessionId required')
  const requested = String(workflowId || '').trim() || 'web-default'
  const value = readWorkflowDefinition(store, requested, id)
  if (!value) throw new Error('工作流不存在或已删除')
  store.db.prepare(`INSERT INTO saker_workflow_selection(session_id,workflow_id,updated_at)
    VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET workflow_id=excluded.workflow_id,updated_at=excluded.updated_at`)
    .run(id, value.id, Date.now())
  return value
}

export function selectedWorkflowPrompt(store, sessionId, mode = 'pentest') {
  const value = selectedWorkflow(store, sessionId, mode)
    return `当前测试流程=${value.title}（id=${value.id}，${value.nodes.length}步，${value.builtin ? '内置' : '自定义'}）。新目标先调用 saker_workflow action=start workflowId=${value.id} 取得当前步骤；普通问答或查看结果不要为了填流程而重建运行。流程定义和执行计划由 saker_workflow 直接返回；不要搜索插件源码、工作区文件或会话目录来“查找工作流定义”。`
}

export function createWorkflowRun(store, sessionId, { workflow, compiled, target = '', goal = '' }) {
  ensureWorkflowSchema(store)
  const now = Date.now()
  const runId = 'workflow-' + randomUUID()
  const nodes = compiled.nodes.map(node => ({ ...node,
    status: node.order === 0 ? 'ready' : 'pending', evidenceRefs: [], artifacts: [], note: '' }))
  const data = { nodes, plan: compiled.prompt, semanticHash: compiled.semanticHash,
    definition: compiled.definition, outcome: 'in_progress' }
  store.db.prepare(`INSERT INTO saker_workflow_runs
    (run_id,session_id,workflow_id,workflow_version,semantic_hash,target,goal,state,current_index,data,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(runId, sessionId, workflow.id, workflow.version, compiled.semanticHash, String(target || ''), String(goal || ''), 'running', 0, JSON.stringify(data), now, now)
  return readWorkflowRun(store, sessionId, runId)
}

export function readWorkflowRun(store, sessionId, runId) {
  ensureWorkflowSchema(store)
  return parse(store.db.prepare('SELECT * FROM saker_workflow_runs WHERE session_id=? AND run_id=?').get(String(sessionId), String(runId)))
}

export function latestWorkflowRun(store, sessionId) {
  ensureWorkflowSchema(store)
  return parse(store.db.prepare('SELECT * FROM saker_workflow_runs WHERE session_id=? ORDER BY updated_at DESC LIMIT 1').get(String(sessionId)))
}

export function updateWorkflowRun(store, run, patch) {
  const current = store.db.prepare(`SELECT state,current_index,revision FROM saker_workflow_runs
    WHERE run_id=? AND session_id=?`).get(run.run_id, run.session_id)
  if (!current) throw new Error('workflow run not found')
  if (!['running', 'blocked'].includes(current.state))
    throw new Error(`workflow run is ${current.state}; stopped or completed runs cannot advance`)
  if (run.revision !== undefined && Number(run.revision) !== Number(current.revision))
    throw new Error('workflow run changed; reload the latest status before advancing')
  const data = { ...run.data, ...(patch.data || {}) }
  const currentIndex = patch.currentIndex ?? current.current_index
  const state = patch.state ?? run.state
  const result = store.db.prepare(`UPDATE saker_workflow_runs
    SET state=?,current_index=?,data=?,revision=revision+1,updated_at=?
    WHERE run_id=? AND session_id=? AND revision=? AND state IN ('running','blocked')`)
    .run(state, currentIndex, JSON.stringify(data), Date.now(),
      run.run_id, run.session_id, current.revision)
  if (Number(result.changes) !== 1)
    throw new Error('workflow state conflict; the run was stopped or changed by another advancement')
  return readWorkflowRun(store, run.session_id, run.run_id)
}

export function advanceWorkflowRun(store, run, {
  stepId,
  status = 'done',
  note = '',
  evidenceRefs = [],
  artifacts = [],
}) {
  const current = readWorkflowRun(store, run.session_id, run.run_id)
  if (!current) throw new Error('workflow run not found')
  if (!['running', 'blocked'].includes(current.state))
    throw new Error(`workflow run is ${current.state}; stopped or completed runs cannot advance`)
  if (run.revision !== undefined && Number(run.revision) !== Number(current.revision))
    throw Object.assign(new Error('workflow run changed; reload the latest status before advancing'), {
      code: 'workflow_revision_conflict', runId: current.run_id, revision: current.revision,
      currentStepId: current.data.nodes[current.current_index]?.id || '',
    })
  const nodes = current.data.nodes.map(node => ({ ...node }))
  const index = nodes.findIndex(node => node.id === stepId)
  const currentStep = nodes[current.current_index]
  if (index < 0) throw Object.assign(new Error('workflow step not found'), {
    code: 'workflow_step_not_found', runId: current.run_id, revision: current.revision,
    currentStepId: currentStep?.id || '', allowedStepIds: currentStep ? [currentStep.id] : [],
  })
  if (index !== current.current_index) throw Object.assign(new Error('only the current workflow step can advance'), {
    code: 'workflow_step_not_current', runId: current.run_id, revision: current.revision,
    currentStepId: currentStep?.id || '', allowedStepIds: currentStep ? [currentStep.id] : [],
  })
  if (!['done', 'blocked', 'unknown'].includes(status)) throw new Error('invalid step status')
  const completion = validateStepCompletion(store, current.session_id, current, nodes[index], {
    status,
    note,
    artifacts,
    evidenceRefs,
  })
  nodes[index] = {
    ...nodes[index],
    status,
    note: String(note || '').trim().slice(0, 2000),
    evidenceRefs: completion.evidenceRefs,
    artifacts: completion.artifacts,
    completionBindings: completion.bindings,
    completedAt: new Date().toISOString(),
  }
  let nextIndex = index + 1
  if (status !== 'blocked' && nextIndex < nodes.length)
    nodes[nextIndex] = { ...nodes[nextIndex], status: 'ready' }
  const state = status === 'blocked' ? 'blocked'
    : nextIndex >= nodes.length ? 'done' : 'running'
  const outcome = state === 'blocked' ? 'blocked'
    : state === 'done' ? (nodes.every(node => node.status === 'done') ? 'completed' : 'inconclusive')
      : 'in_progress'
  const currentIndex = status === 'blocked' ? index : Math.min(nextIndex, nodes.length)
  store.db.exec('BEGIN IMMEDIATE')
  try {
    for (const binding of completion.bindings) {
      if (binding.generation !== 'fresh') continue
      try {
        store.db.prepare(`INSERT INTO saker_workflow_evidence
          (session_id,kind,evidence_id,run_id,node_id,created_at) VALUES (?,?,?,?,?,?)`)
          .run(current.session_id, binding.kind, binding.id, current.run_id, nodes[index].id, Date.now())
      } catch (error) {
        throw new Error(`证据 ${binding.id} 已被其他工作流步骤占用或不能重复绑定：${error.message}`)
      }
    }
    const updated = updateWorkflowRun(store, current, {
      state,
      currentIndex,
      data: { nodes, outcome },
    })
    store.db.exec('COMMIT')
    return updated
  } catch (error) {
    store.db.exec('ROLLBACK')
    throw error
  }
}

export function stopWorkflowRun(store, run, reason = '') {
  const current = readWorkflowRun(store, run.session_id, run.run_id)
  if (!current) throw new Error('workflow run not found')
  if (current.state === 'stopped') return current
  if (!['running', 'blocked'].includes(current.state))
    throw new Error(`workflow run is ${current.state}; only an active run can be stopped`)
  return updateWorkflowRun(store, current, {
    state: 'stopped',
    data: {
      stopReason: String(reason || '').trim().slice(0, 500),
      stoppedAt: new Date().toISOString(),
      outcome: 'stopped',
    },
  })
}
