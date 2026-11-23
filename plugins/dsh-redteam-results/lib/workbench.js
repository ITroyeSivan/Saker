// Workbench read model and the single command surface used by both the native
// conversation strip and the full management page. Reads never start a model or
// mutate a task; commands are idempotent by commandId and re-check ownership.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sessionWorkingDirectory } from 'dsh-saker/working-directory'
import { allFindings, getFinding, registerFinding, updateFinding } from './store.js'
import { readTaskContext } from './task-context.js'
import { readTaskPolicy, taskPolicyStatus, taskOverview, startTaskPolicy, pauseTaskPolicy, resumeTaskPolicy, archiveTaskRound, updateTaskProgress } from './task-policy.js'
import { writeTaskPolicy } from './task-policy-record.js'
import { readChecks } from './checked.js'
import { taskCostOverview } from './task-cost.js'
import { taskElapsed } from './task-duration.js'
import { listRoleSpecs, listWorkItems, listRoleInstances, listAttempts, listRoleMessages, readRoleSpec, readWorkItem, createRoleSpec, createWorkItem, updateWorkItem, roleStatus, reconcileReleasedRoleSettlements } from './role-orchestration.js'
import { listWorkflowDefinitions, readWorkflowDefinition, saveWorkflowDefinition, selectWorkflow, selectedWorkflow, latestWorkflowRun } from './workflow/store.js'
import { siteWorkerRows, siteWorkerView } from './site-workers.js'
import { componentStatus } from './component-research.js'
import { moduleCapabilityResolver } from './module-capabilities.js'
import { projectSnapshot } from './artifact-files.js'
import { redactValue } from './redaction.js'
import { materialsDetail } from './materials-view.js'
import { buildEvidenceIndex, resolveEvidenceRef } from './evidence-resolve.js'
import { listFindingEvidenceReviews, readFindingEvidenceReviews, reviewBasisDigest } from './finding-evidence-reviews.js'
import { normalizedModelUsage, modelBudgetOwner, modelBudgetOverview } from './model-budget.js'
import {
  listModuleDefinitions, detailModuleDefinition, archiveModuleDefinition,
  readModulePreference, writeModulePreference, defineModuleDraft, reviseModuleDraft,
  saveModulePersonal, beginModuleInvocation, finishModuleInvocation,
  cancelModuleInvocation, listModuleInvocations, detailModuleInvocation,
} from './test-module-registry.js'

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const json = value => { try { return JSON.parse(value) } catch { return null } }
// Two Desktop windows share one Host process and can submit the same commandId
// at the same time. Keep the in-flight promise so the second window waits for
// the first result instead of executing a second side effect.
const commandInFlight = new Map()
const iso = value => { const n = typeof value === 'number' ? value : Date.parse(value || ''); return Number.isFinite(n) ? new Date(n).toISOString() : '' }
const nowIso = () => new Date().toISOString()
const pageLimit = page => [20, 50, 100].includes(Number(page?.limit)) ? Number(page.limit) : 20
const decodeCursor = cursor => {
  if (!cursor) return 0
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    return Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : 0
  } catch { return 0 }
}
const encodeCursor = offset => Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
const bounded = (value, max = 500) => String(value ?? '').slice(0, max)
const sortableTime = value => {
  const n = typeof value === 'number' ? value : Date.parse(value || '')
  return Number.isFinite(n) ? n : 0
}

function pageResult(data, query, sourceRevision, extra = {}) {
  const limit = pageLimit(query.page)
  const offset = decodeCursor(query.page?.cursor)
  const rows = data.slice(offset, offset + limit)
  const hasMore = offset + rows.length < data.length
  return {
    ok: true,
    data: rows,
    sourceRevision,
    revisionVector: { saker: sourceRevision },
    updatedAt: extra.updatedAt || nowIso(),
    stale: false,
    page: { nextCursor: hasMore ? encodeCursor(offset + rows.length) : null, hasMore, total: data.length, totalKnown: true },
    capabilities: extra.capabilities || {},
    notices: extra.notices || [],
  }
}

function tableExists(store, name) {
  return !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

function ensureRoot(store, rootId, policy = readTaskPolicy(store, rootId), scope = {}) {
  if (!rootId || !policy) return null
  const now = Date.now()
  store.db.prepare(`INSERT INTO saker_business_roots(root_id,host_root_session,project_key,task_kind,created_at,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(root_id) DO UPDATE SET updated_at=excluded.updated_at,
    task_kind=excluded.task_kind, host_root_session=excluded.host_root_session`)
    .run(rootId, rootId, String(scope.projectKey || policy.projectKey || ''), String(policy.scenario || policy.mode || ''), Number(policy.startedAt) || now, now)
  const generation = generationOf(store, rootId)
  const state = taskPolicyStatus(store, rootId)
  store.db.prepare(`INSERT INTO saker_run_generations(root_id,generation,control_state,revision,admitted_at,deadline_at,cleanup_state,record,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(root_id,generation) DO UPDATE SET
    control_state=excluded.control_state, revision=excluded.revision,
    deadline_at=excluded.deadline_at, cleanup_state=excluded.cleanup_state, updated_at=excluded.updated_at`)
    .run(rootId, generation, controlStateOf(state), Number(policy.policyRev) || 1, Number(policy.startedAt) || now,
      Number(policy.budget?.deadline) || null, cleanupStateOf(store, rootId), JSON.stringify({ startedAt: policy.startedAt }), now)
  return { rootId, generation }
}

function generationOf(store, rootId) {
  const rounds = Number(store.db.prepare('SELECT COUNT(*) AS n FROM task_rounds WHERE session_id=?').get(rootId)?.n || 0)
  return rounds + 1
}

function controlStateOf(state) {
  if (!state?.configured) return 'ready'
  if (state.policy?.cancelled) return 'stopped'
  if (state.phase === 'completed') return 'completed'
  if (state.phase === 'idle') return 'active'
  if (state.stopped) return 'paused'
  return 'active'
}

function cleanupStateOf(store, rootId) {
  const rows = siteWorkerRows(store, rootId)
  if (rows.some(row => row.state === 'cleanup-failed')) return 'unknown'
  if (rows.some(row => row.state === 'closing')) return 'pending'
  return 'clear'
}

function findingState(row) {
  if (row.status === 'verified') return 'verified'
  if (row.status === 'false-positive') return 'not-reproduced'
  if (row.status === 'suspect') return 'candidate'
  if (row.status === 'fixed') return 'fixed'
  return 'needs-recheck'
}

function runtimeStateOf(state) {
  if (!state?.configured) return 'ready'
  if (state.policy?.cancelled) return 'stopped'
  if (state.phase === 'completed') return 'completed'
  if (state.phase === 'waiting-info') return 'paused'
  if (state.phase === 'failed') return 'stopped'
  if (state.phase === 'paused') return 'paused'
  return 'active'
}

function businessStateOf(state) {
  if (!state?.configured) return 'ready'
  if (state.policy?.cancelled) return 'stopped'
  if (state.phase === 'completed') return 'ended'
  if (state.phase === 'waiting-info') return 'waiting-user'
  if (state.phase === 'failed') return 'failed'
  if (state.phase === 'idle') return 'turn-ended'
  if (state.phase === 'paused') return 'paused'
  return 'running'
}

function attentionOf(policy, state) {
  if (policy?.blocker) return {
    kind: 'root-blocker',
    reason: policy.blocker.reason || policy.blocker.code || '任务受阻',
    evidence: String(policy.blocker.evidence || '').slice(0, 240),
    next: '处理阻碍后明确继续；处理前不会自动绕行',
  }
  if (policy?.awaitingConfirmation) return {
    kind: 'scope-confirmation',
    reason: policy.awaitingConfirmation.note || '阶段完成，等待你确认下一范围',
    next: '确认下一步范围，或停止本轮',
  }
  if (policy?.pendingChange) return {
    kind: 'scope-change',
    reason: policy.pendingChange.summary || '范围或额度修改待确认',
    next: '逐项确认扩大范围或额度的改动',
  }
  return null
}

function findingSummary(row) {
  return {
    findingId: row.id, sessionId: row.session_id, revision: row.updated_at || row.created_at || '',
    severity: row.severity, verificationState: findingState(row), status: row.status,
    evidenceLevel: row.evidence_level, title: row.title, summary: row.summary,
    target: row.target, identity: row.identity, proofKind: row.proof_kind,
    sourceOrigin: row.source_origin, updatedAt: row.updated_at, verifiedAt: row.verified_at,
    secondRating: row.second_rating, retestAt: row.retest_at, retestNote: row.retest_note,
    evidenceRefs: json(row.evidence_refs) || [],
  }
}

function findingRows(store, rootId, mode = null) {
  if (rootId && mode) return store.db.prepare('SELECT * FROM findings WHERE session_id=? AND mode=? ORDER BY updated_at DESC, seq DESC').all(rootId, mode)
  if (rootId) return store.db.prepare('SELECT * FROM findings WHERE session_id=? ORDER BY updated_at DESC, seq DESC').all(rootId)
  return store.db.prepare('SELECT * FROM findings ORDER BY updated_at DESC, seq DESC').all()
}

function rootsData(store, ctx = null) {
  const rows = store.db.prepare("SELECT session_id,record,updated_at FROM task_policy WHERE parent_session='' ORDER BY updated_at DESC").all()
  const findingAgg = new Map(store.db.prepare(`SELECT session_id,COUNT(*) AS n,
    SUM(CASE WHEN status='verified' THEN 1 ELSE 0 END) AS verified,
    SUM(CASE WHEN status IN ('pending','suspect','code-reviewed') THEN 1 ELSE 0 END) AS pending
    FROM findings GROUP BY session_id`).all().map(row => [row.session_id, row]))
  const roleAgg = new Map(store.db.prepare("SELECT session_id,COUNT(*) AS n FROM role_instances WHERE state IN ('starting','active','waiting') GROUP BY session_id").all()
    .map(row => [row.session_id, Number(row.n) || 0]))
  const workerFailures = new Map()
  for (const row of store.db.prepare('SELECT parent_session,record FROM site_workers').all()) {
    const record = json(row.record) || {}
    if (record.state === 'cleanup-failed') workerFailures.set(row.parent_session, (workerFailures.get(row.parent_session) || 0) + 1)
  }
  return rows.map(row => {
    const policy = json(row.record) || {}
    const state = taskPolicyStatus(store, row.session_id)
    const finding = findingAgg.get(row.session_id) || { n: 0, verified: 0, pending: 0 }
    const rawTitle = String(policy.question || policy.requestText || policy.target || '')
    const genericTitle = !rawTitle || /按当前会话|按当前会话中的用户请求执行/i.test(rawTitle)
    let observedTarget = ''
    if (genericTitle && !(policy.primaryTarget || policy.target)) {
      const context = readTaskContext(store, row.session_id)
      const asset = (context?.assets || []).find(item => item && item.url)
      const request = (context?.requests || []).find(item => item && item.endpoint)
      observedTarget = String(asset?.url || request?.endpoint || '')
      if (!observedTarget) {
        const firstFinding = store.db.prepare('SELECT target FROM findings WHERE session_id=? AND target<>\'\' ORDER BY updated_at DESC LIMIT 1').get(row.session_id)
        observedTarget = String(firstFinding?.target || '')
      }
    }
    let hostTitle = ''
    if (genericTitle && !(policy.primaryTarget || policy.target || observedTarget)) {
      try {
        const sessions = ctx?.sessions || ctx?.get?.('sessions') || null
        const hostSession = sessions?.get?.(row.session_id) || null
        hostTitle = String(hostSession?.title || hostSession?.name || '')
      } catch { hostTitle = '' }
      if (!hostTitle) {
        try {
          const agents = ctx?.agents || ctx?.get?.('agents') || null
          const agent = agents?.get?.(row.session_id) || null
          hostTitle = String(agent?.session?.title || agent?.session?.name || agent?.title || '')
        } catch { hostTitle = '' }
      }
    }
    const title = genericTitle && (policy.primaryTarget || policy.target || observedTarget || hostTitle)
      ? String(policy.primaryTarget || policy.target || observedTarget || hostTitle)
      : (genericTitle ? String(policy.scenario || policy.mode || '任务') + ' ' + String(row.session_id).slice(-8) : (rawTitle || row.session_id))
    const attention = attentionOf(policy, state)
    const elapsed = taskElapsed(policy)
    return {
      rootId: row.session_id, generation: generationOf(store, row.session_id),
      title,
      targetSummary: policy.primaryTarget || policy.target || observedTarget || '',
      taskKind: policy.scenario || policy.mode || '',
      controlState: runtimeStateOf(state), businessState: businessStateOf(state),
      phase: state.phase, reason: state.reason || '', attentionReason: attention?.reason || '',
      attention,
      outcomeSummary: { verified: Number(finding.verified) || 0, pending: Number(finding.pending) || 0, total: Number(finding.n) || 0 },
      cleanupState: workerFailures.get(row.session_id) ? 'unknown' : cleanupStateOf(store, row.session_id),
      blocker: attention?.reason || '', activeRoleCount: roleAgg.get(row.session_id) || 0,
      used: { toolCalls: Number(policy.used?.toolCalls) || 0, modelCalls: Number(policy.used?.modelCalls) || 0 },
      startedAt: Number(policy.startedAt) || 0, updatedAt: row.updated_at,
      duration: elapsed,
      canActions: { pause: runtimeStateOf(state) === 'active', resume: runtimeStateOf(state) === 'paused',
        stop: ['active', 'paused'].includes(runtimeStateOf(state)),
        continue: ['stopped', 'completed', 'paused'].includes(runtimeStateOf(state)) },
    }
  })
}

function queryRoots(store, query, ctx = null) {
  const text = String(query.filter?.text || '').trim().toLowerCase()
  const state = String(query.filter?.state || '').trim()
  const business = String(query.filter?.business || '').trim()
  let rows = rootsData(store, ctx)
  if (text) rows = rows.filter(row => [row.title, row.targetSummary, row.rootId].some(value => String(value).toLowerCase().includes(text)))
  if (state) rows = rows.filter(row => row.controlState === state)
  if (business) rows = rows.filter(row => row.businessState === business)
  const revision = digest(rows.map(row => [row.rootId, row.updatedAt, row.outcomeSummary.total]))
  return pageResult(rows, query, revision)
}

function rootDetail(store, ctx, rootId, query = {}) {
  const policy = readTaskPolicy(store, rootId)
  if (!policy) throw new Error('task root not found')
  const state = taskPolicyStatus(store, rootId)
  const overview = taskOverview(store, rootId)
  const context = readTaskContext(store, rootId)
  const roles = roleStatus(store, rootId)
  const workers = siteWorkerView(store, rootId)
  const includeFindings = query.context?.detailMode !== 'summary'
  const findings = includeFindings ? allFindings(store, rootId, 'pentest').map(findingSummary) : []
  // 概览页的 roots.detail(summary) 只渲染页头；费用查询走纯读，不补写会话事件。
  const cost = taskCostOverview(ctx, store, rootId, 0, { backfill: query.context?.detailMode !== 'summary' })
  return {
    ok: true,
    data: {
      root: rootsData(store, ctx).find(row => row.rootId === rootId) || null,
      policy: state.policy || policy, status: { phase: state.phase, reason: state.reason, stopped: state.stopped, idle: state.idle },
      overview: { counts: overview.counts, gaps: overview.gaps, moreGaps: overview.moreGaps, next: overview.next, scope: overview.scope },
      findings, findingsOmitted: !includeFindings, roles, workers, cost,
      context: {
        assets: (context?.assets || []).length, requests: (context?.requests || []).length,
        checks: (context?.checks || []).length, methods: (context?.methods || []).length,
      },
      canActions: { pause: state.phase === 'running', resume: state.phase === 'paused',
        stop: ['running', 'paused', 'waiting-info'].includes(state.phase), continue: ['paused', 'completed'].includes(state.phase) },
    },
    sourceRevision: digest([rootId, state.phase, findings.length, roles.instances.length, workers.active]),
    revisionVector: { saker: digest([rootId, state.phase]) }, updatedAt: nowIso(), stale: false,
    page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [],
  }
}

function queryFindings(store, query) {
  const rootId = query.context?.rootId || ''
  const filter = query.filter || {}
  let rows = findingRows(store, rootId, rootId ? 'pentest' : null).map(findingSummary)
  if (filter.text) {
    const text = String(filter.text).toLowerCase()
    rows = rows.filter(row => [row.title, row.summary, row.target].some(value => String(value || '').toLowerCase().includes(text)))
  }
  if (filter.verification) rows = rows.filter(row => row.verificationState === filter.verification)
  if (filter.severity) rows = rows.filter(row => row.severity === filter.severity)
  const revision = digest(rows.map(row => [row.findingId, row.revision, row.verificationState]))
  return pageResult(rows, query, revision)
}

function findingDetail(store, findingId, rootId) {
  const id = String(findingId || '')
  const root = String(rootId || '')
  if (!id) throw Object.assign(new Error('缺少 findingId'), { code: 'MISSING_PREREQUISITE' })
  if (!root) throw Object.assign(new Error('缺少 rootId'), { code: 'MISSING_PREREQUISITE' })
  // findingSummary expects the persisted row, not the public Finding object.
  // Using getFinding here mixed camelCase fields with the SQLite column names
  // and produced an undefined binding for session_id.
  const row = store.db.prepare('SELECT * FROM findings WHERE session_id=? AND id=?').get(root, id)
  if (!row) throw new Error('finding not found')
  const retests = tableExists(store, 'finding_retests')
    ? store.db.prepare('SELECT record FROM finding_retests WHERE session_id=? AND finding_id=? ORDER BY at DESC').all(row.session_id, id).map(item => json(item.record)).filter(Boolean)
    : []
  const basis = json(row.evidence_refs) || []
  // 回执只来自解析后的同一 owner+requestId+revision，或是保存了精确 execution 引用的回执。
  const evidenceIndex = buildEvidenceIndex(store, row.session_id)
  const resolvedEvidenceReferences = basis.map(ref => resolveEvidenceRef(store, row.session_id, ref, evidenceIndex))
  const receiptMap = new Map()
  for (const ref of resolvedEvidenceReferences) {
    for (const receipt of ref.receipts || []) receiptMap.set(receipt.ownerSessionId + '\0' + receipt.id, receipt)
    if (ref.receipt && ref.openRef?.type === 'execution') receiptMap.set(ref.receipt.ownerSessionId + '\0' + ref.receipt.id, ref.receipt)
  }
  const receipts = [...receiptMap.values()]
  const receiptTotal = receipts.length
  receipts.sort((a, b) => Number(b.current !== false && b.integrityValid !== false) - Number(a.current !== false && a.integrityValid !== false)
    || sortableTime(b.completedAt) - sortableTime(a.completedAt))
  receipts.splice(50)
  const taskContext = readTaskContext(store, row.session_id)
  const requestRows = new Map((taskContext?.requests || []).map(item => [String(item.id), item]))
  const assetRows = new Map((taskContext?.assets || []).map(item => [String(item.id), item]))
  const checkRows = new Map(readChecks(store, row.session_id).map(item => [String(item.id), item]))
  const firstReceiptForRequest = requestId => receipts.find(item => String(item.requestId || '') === String(requestId || ''))
  const evidenceReferences = basis.map((ref, index) => {
    const kind = String(ref?.kind || ref?.refKind || 'ref')
    const id = String(ref?.id || ref?.ref || ref?.requestId || '')
    const label = String(ref?.title || ref?.label || id || '未命名引用')
    if (!id) return { kind, id: '', status: 'missing', label, reason: '引用没有可解析 ID' }
    if (kind === 'receipt' || kind === 'http') {
      const found = store.db.prepare('SELECT id FROM execution_receipts WHERE session_id=? AND id=?').get(row.session_id, id)
      return found
        ? { kind, id, status: 'openable', openKind: 'http', executionId: id, label, reason: '可读取已保存执行回执' }
        : { kind, id, status: 'missing', label, reason: '回执不存在或已失效' }
    }
    if (kind === 'request') {
      const receipt = firstReceiptForRequest(id)
      if (receipt) return { kind, id, status: 'openable', openKind: 'http', executionId: receipt.id, label,
        reason: '可读取该请求关联的执行回执' }
      const request = requestRows.get(id)
      return request
        ? { kind, id, status: 'summary-only', openKind: 'request', label,
          summary: [request.endpoint, request.authContext ? '账号 ' + request.authContext : ''].filter(Boolean).join(' · '),
          reason: '只有请求摘要，没有可直接打开的执行回执' }
        : { kind, id, status: 'missing', label, reason: '请求记录不存在或已移除' }
    }
    if (kind === 'file' || kind === 'material') {
      const found = store.db.prepare('SELECT 1 AS n FROM business_materials WHERE session_id=? AND id=?').get(row.session_id, id)
      return found
        ? { kind, id, status: 'openable', openKind: 'material', materialId: id, label, reason: '可读取已索引本地材料' }
        : { kind, id, status: 'missing', label, reason: '文件引用未在当前任务材料记录中解析到' }
    }
    if (kind === 'asset') {
      const asset = assetRows.get(id)
      return asset
        ? { kind, id, status: 'summary-only', label, summary: asset.url || id, reason: '资产记录可读，但没有独立原件' }
        : { kind, id, status: 'missing', label, reason: '资产记录不存在或已移除' }
    }
    if (kind === 'check') {
      const check = checkRows.get(id)
      return check
        ? { kind, id, status: 'summary-only', label, summary: [check.check || check.title, check.status].filter(Boolean).join(' · '),
          reason: '检查记录只有摘要' }
        : { kind, id, status: 'missing', label, reason: '检查记录不存在或已移除' }
    }
    return { kind, id, status: 'summary-only', label, reason: '该引用类型只能显示标识，未提供原件读取合同' }
  })
  const evidenceReview = readFindingEvidenceReviews(store, row.session_id,
    { id: row.id, updatedAt: row.updated_at }, resolvedEvidenceReferences)
  return { ok: true, data: redactValue({ ...findingSummary(row), sessionId: row.session_id, description: row.description,
    poc: row.poc, impact: row.impact, evidence: row.evidence, requestPacket: row.request_pkt, responsePacket: row.response_pkt,
    verificationBasis: basis, evidenceReferences: resolvedEvidenceReferences, legacyEvidenceReferences: evidenceReferences,
    ...evidenceReview, receipts, receiptTotal, retests }),
  sourceRevision: digest([row.id, row.updated_at]), revisionVector: { saker: row.updated_at || '' }, updatedAt: nowIso(),
  stale: false, page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [] }
}

function descendantSessionIds(store, rootId) {
  const ids = new Set([String(rootId || '')])
  for (const table of ['role_instances', 'role_attempts']) {
    try {
      for (const row of store.db.prepare(`SELECT DISTINCT child_id FROM ${table} WHERE session_id=?`).all(rootId)) {
        if (row.child_id) ids.add(String(row.child_id))
      }
    } catch { /* table absent before role schema migration */ }
  }
  ids.delete('')
  return [...ids]
}

function trafficRows(store, rootId) {
  const sessionIds = rootId ? descendantSessionIds(store, rootId) : []
  const rows = rootId
    ? store.db.prepare(`SELECT session_id,id,record FROM execution_receipts WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY rowid DESC`).all(...sessionIds)
    : store.db.prepare('SELECT session_id,id,record FROM execution_receipts ORDER BY rowid DESC').all()
  return rows.map(row => {
    const record = json(row.record) || {}
    const requestLine = String(record.request || '').split('\r\n')[0] || ''
    const [, method = '', target = ''] = /^([A-Z]+) (\S+) HTTP\//.exec(requestLine) || []
    return {
      id: row.id, rootId: row.session_id, at: record.completedAt || record.startedAt || '', method, url: target || record.endpoint || '',
      status: Number(record.status) || null, identity: record.identity?.name || record.identityRef || '',
      source: record.source || '', outcome: record.outcome || '', current: record.current !== false,
      integrityValid: record.integrityValid !== false, requestId: record.requestId || '', requestRevision: record.requestRevision || '',
      bytes: Number(record.responseBytes) || 0,
    }
  })
}

function queryTraffic(store, query) {
  let rows = trafficRows(store, query.context?.rootId)
  const filter = query.filter || {}
  if (filter.text) {
    const text = String(filter.text).toLowerCase()
    rows = rows.filter(row => [row.id, row.method, row.url, row.identity, row.source, row.status]
      .some(value => String(value || '').toLowerCase().includes(text)))
  }
  if (filter.status) rows = rows.filter(row => String(row.status || '') === String(filter.status))
  if (filter.identity) rows = rows.filter(row => row.identity === filter.identity)
  return pageResult(rows, query, digest(rows.map(row => [row.id, row.status, row.at])))
}

function queryAssets(store, query) {
  const rootId = query.context?.rootId
  const text = String(query.filter?.text || '').trim().toLowerCase()
  if (!rootId) {
    const roots = rootsData(store).map(row => row.rootId)
    const all = []
    for (const id of roots) {
      const context = readTaskContext(store, id)
      for (const asset of context?.assets || []) all.push({ kind: 'asset', id: asset.id, rootId: id, url: asset.url,
        inScope: asset.inScope === true, reachable: asset.reachable === true })
      for (const request of context?.requests || []) all.push({ kind: 'request', id: request.id, rootId: id,
        revision: request.revision, endpoint: request.endpoint, authContext: request.authContext, valid: request.valid === true })
    }
    const rootSet = new Set(roots)
    for (const row of store.db.prepare('SELECT session_id,id,record FROM business_materials ORDER BY rowid DESC LIMIT 500').all()) {
      if (!rootSet.has(row.session_id)) continue
      const record = json(row.record) || {}
      all.push({ kind: 'material', id: row.id, rootId: row.session_id, name: record.name || record.displayName || row.id,
        format: record.summary?.format || record.kind || '', bytes: Number(record.bytes) || 0 })
    }
    const filtered = text ? all.filter(row => [row.kind, row.id, row.url, row.endpoint, row.name, row.format, row.authContext, row.rootId]
      .some(value => String(value || '').toLowerCase().includes(text))) : all
    return pageResult(filtered, query, digest(filtered.map(row => [row.rootId, row.kind, row.id])))
  }
  const context = readTaskContext(store, rootId)
  const checks = readChecks(store, rootId)
  const components = componentStatus(store, rootId)
  const receipts = trafficRows(store, rootId)
  const assets = (context?.assets || []).map(asset => ({
    kind: 'asset', id: asset.id, url: asset.url, inScope: asset.inScope === true, reachable: asset.reachable === true,
    checks: checks.filter(check => check.endpoint && asset.url && check.endpoint.startsWith(asset.url)).length,
    relatedChecks: checks.filter(check => check.endpoint && asset.url && check.endpoint.startsWith(asset.url))
      .slice(0, 20).map(check => ({ id: check.id, title: check.check || check.title || '', status: check.status || '',
        endpoint: check.endpoint || '' })),
  }))
  const requests = (context?.requests || []).map(request => ({
    kind: 'request', id: request.id, revision: request.revision, endpoint: request.endpoint,
    authContext: request.authContext, valid: request.valid === true, kindHint: request.kind || 'request',
  }))
  for (const asset of assets) {
    asset.relatedRequests = requests.filter(request => request.endpoint && asset.url &&
      String(request.endpoint).startsWith(String(asset.url))).slice(0, 20)
    asset.relatedReceipts = receipts.filter(receipt => asset.relatedRequests.some(request => String(request.id) === String(receipt.requestId)))
      .slice(0, 20).map(receipt => ({ id: receipt.id, requestId: receipt.requestId, status: receipt.status, at: receipt.at }))
  }
  for (const request of requests) {
    request.relatedReceipts = receipts.filter(receipt => String(receipt.requestId) === String(request.id))
      .slice(0, 20).map(receipt => ({ id: receipt.id, requestId: receipt.requestId, status: receipt.status, at: receipt.at }))
  }
  const materials = store.db.prepare('SELECT id,record FROM business_materials WHERE session_id=? ORDER BY rowid DESC LIMIT 200').all(rootId).map(row => {
    const record = json(row.record) || {}
    return { kind: 'material', id: row.id, name: record.name || record.displayName || row.id, format: record.summary?.format || record.kind || '', bytes: Number(record.bytes) || 0 }
  })
  const data = [...assets, ...requests, ...materials, { kind: 'check', id: 'checks', tested: checks.filter(check => check.status === 'not-hit').length,
    blocked: checks.filter(check => check.status === 'blocked').length, notTested: checks.filter(check => check.status === 'not-tested').length,
    total: checks.length, components: components.facts.length, advisories: components.advisories.length, evaluations: components.evaluations.length }]
  const filtered = text ? data.filter(row => [row.kind, row.id, row.url, row.endpoint, row.name, row.authContext, row.format]
    .some(value => String(value || '').toLowerCase().includes(text))) : data
  return pageResult(filtered, query, digest([rootId, assets.length, requests.length, materials.length, checks.length]))
}

function queryExploration(store, query) {
  const rootId = query.context?.rootId
  if (!rootId) return pageResult([], query, digest([]))
  const nodes = [], edges = [], nodeById = new Map()
  const addNode = node => {
    const id = String(node?.id || '')
    if (!id || nodeById.has(id)) return nodeById.get(id) || null
    const next = { ...node, id }
    nodes.push(next)
    nodeById.set(id, next)
    return next
  }
  addNode({ id: rootId, kind: 'root', title: '任务根', state: controlStateOf(taskPolicyStatus(store, rootId)) })
  const works = listWorkItems(store, rootId, 0)
  for (const work of works) {
    addNode({ id: work.workId, kind: 'work', title: work.title || work.question, state: work.state, revision: work.revision })
    edges.push({ from: rootId, to: work.workId, kind: 'contains' })
  }
  const attempts = listAttempts(store, rootId, 0)
  for (const attempt of attempts) {
    addNode({ id: attempt.attemptId, kind: 'attempt', title: '尝试 ' + (attempt.workId || ''), state: attempt.state,
      revision: attempt.inputRevision || '', sourceRefs: [{ kind: 'work', id: attempt.workId }, { kind: 'session', id: attempt.childId }] })
    const workId = String(attempt.workId || '')
    if (workId) edges.push({ from: workId, to: attempt.attemptId, kind: 'attempted' })
  }
  const run = latestWorkflowRun(store, rootId)
  if (run && run.data) {
    const runNodeId = 'workflow:' + run.run_id
    addNode({ id: runNodeId, kind: 'workflow', title: run.data.workflow?.title || run.data.workflow?.name || '测试方法',
      state: run.state || '', revision: run.revision ?? 0 })
    edges.push({ from: rootId, to: runNodeId, kind: 'runs' })
    const steps = Array.isArray(run.data.nodes) ? run.data.nodes : []
    for (const step of steps) {
      const stepId = 'step:' + run.run_id + ':' + (step.id || step.stepId || '')
      const index = steps.indexOf(step)
      addNode({ id: stepId, kind: 'step', title: step.title || step.name || step.id || '步骤',
        state: index < (run.current_index ?? 0) ? 'done' : index === (run.current_index ?? 0) ? 'current' : 'pending',
        revision: run.revision ?? 0 })
      edges.push({ from: runNodeId, to: stepId, kind: 'contains' })
    }
  }
  const receipts = trafficRows(store, rootId)
  for (const receipt of receipts) {
    addNode({ id: receipt.id, kind: 'receipt', title: receipt.method + ' ' + receipt.url, state: receipt.outcome || 'captured', at: receipt.at })
    for (const attempt of attempts) {
      if (attempt.childId && String(receipt.rootId || '') === String(attempt.childId)) {
        edges.push({ from: attempt.attemptId, to: receipt.id, kind: 'produced' })
      }
    }
  }
  const findings = allFindings(store, rootId, 'pentest')
  const unresolvedEvidence = []
  const evidenceIndex = buildEvidenceIndex(store, rootId)
  let requestNodeCount = 0
  for (const finding of findings) {
    addNode({ id: finding.id, kind: 'finding', title: finding.title, state: findingState(finding), revision: finding.updated_at })
    const evidenceRefs = Array.isArray(finding.evidenceRefs) ? finding.evidenceRefs : (json(finding.evidence_refs) || [])
    for (const ref of evidenceRefs) {
      const resolved = resolveEvidenceRef(store, rootId, ref, evidenceIndex)
      const sourceRef = { ...ref, quality: resolved.quality, location: resolved.location }
      if (resolved.openRef?.type === 'request' && ['exact', 'unique-legacy'].includes(resolved.location)) {
        const nodeId = 'request:' + resolved.openRef.ownerSessionId + ':' + resolved.id + ':' + resolved.revision
        if (!nodeById.has(nodeId)) requestNodeCount += 1
        addNode({ id: nodeId, kind: 'request', title: '请求 ' + resolved.id + (resolved.revision ? ':' + resolved.revision : ''),
          state: resolved.quality, ownerSessionId: resolved.openRef.ownerSessionId,
          requestId: resolved.id, revision: resolved.revision || '', location: resolved.location,
          quality: resolved.quality })
        edges.push({ from: finding.id, to: nodeId, kind: 'references', sourceRef })
        if (resolved.receiptCount === 1) {
          const receipt = resolved.receipts[0]
          if (receipt.ownerSessionId === resolved.openRef.ownerSessionId && nodeById.has(receipt.id))
            edges.push({ from: nodeId, to: receipt.id, kind: 'has-receipt',
              sourceRef: { ...sourceRef, resolvedTo: receipt.id } })
        }
        continue
      }
      if (resolved.openRef?.type === 'execution' && nodeById.has(resolved.openRef.id)) {
        edges.push({ from: finding.id, to: resolved.openRef.id, kind: 'supported-by',
          sourceRef: { ...sourceRef, resolvedTo: resolved.openRef.id } })
        continue
      }
      unresolvedEvidence.push({ findingId: finding.id, ref, location: resolved.location,
        reasonCode: resolved.reasonCode || (resolved.receiptCount > 1 ? 'MULTIPLE_RECEIPTS' : '') })
    }
  }
  const nodeIds = new Set(nodes.map(node => String(node.id)))
  const seenEdges = new Set()
  const validEdges = edges.filter(edge => {
    const from = String(edge.from), to = String(edge.to), key = from + '\0' + to + '\0' + String(edge.kind)
    if (!nodeIds.has(from) || !nodeIds.has(to) || seenEdges.has(key)) return false
    seenEdges.add(key)
    return true
  })
  return pageResult([{
    nodes,
    edges: validEdges,
    meta: {
      complete: true,
      sourceCounts: { work: works.length, attempt: attempts.length, receipt: receipts.length, finding: findings.length, request: requestNodeCount },
      nodeCount: nodes.length,
      edgeCount: validEdges.length,
      unresolvedEvidence,
    },
  }], query, digest([rootId, nodes.length, validEdges.length, unresolvedEvidence.length]))
}

function queryCoverage(store, query) {
  const rootId = query.context?.rootId
  if (!rootId) return pageResult([], query, digest([]))
  const context = readTaskContext(store, rootId)
  const checks = readChecks(store, rootId)
  const assets = context?.assets || []
  const requests = context?.requests || []
  const nodes = []
  const edges = []
  const requestNodes = new Map()
  const statusLabel = status => ({
    'not-hit': '已测未命中', blocked: '受阻', 'not-tested': '未测', 'not-applicable': '不适用',
  }[status] || status || '未测')
  const requestLabel = request => {
    let parsed = null
    try { parsed = new URL(request.endpoint) } catch { parsed = null }
    const first = /^([A-Z]+)\s+(\S+)\s+HTTP\//.exec(String(request.request || ''))
    const method = String(request.method || first?.[1] || 'HTTP').toUpperCase()
    const path = parsed ? parsed.pathname + parsed.search : String(request.endpoint || request.id || '')
    return {
      title: method + ' ' + (path || '/'),
      subtitle: [parsed?.host || '', request.authContext ? '身份 ' + request.authContext : '']
        .filter(Boolean).join(' · '),
      method, path: path || '/', host: parsed?.host || '', identity: request.authContext || '',
    }
  }
  if (!assets.length && !requests.length) {
    const hosts = new Map()
    for (const receipt of trafficRows(store, rootId).slice(0, 80)) {
      let host = ''
      try { host = new URL(String(receipt.url || '')).host } catch { host = '' }
      if (host && !hosts.has(host)) {
        const hostNode = { id: 'observed-host:' + host, kind: 'asset', title: host, state: 'observed',
          sourceRefs: [{ kind: 'receipt', id: receipt.id }] }
        hosts.set(host, hostNode)
        nodes.push(hostNode)
      }
      const endpointId = 'observed-endpoint:' + receipt.id
      let path = receipt.url || ''
      try { const parsed = new URL(receipt.url); path = parsed.pathname + parsed.search } catch { /* keep raw */ }
      nodes.push({ id: endpointId, kind: 'endpoint',
        title: (receipt.method || 'HTTP') + ' ' + (path || '/'),
        subtitle: [host, receipt.identity ? '身份 ' + receipt.identity : '',
          receipt.status ? 'HTTP ' + receipt.status : '已观察'].filter(Boolean).join(' · '),
        method: receipt.method || 'HTTP', path: path || '/', host: host, identity: receipt.identity || '',
        endpoint: receipt.url || '',
        state: receipt.status ? 'HTTP ' + receipt.status : 'observed',
        sourceRefs: [{ kind: 'receipt', id: receipt.id }] })
      if (host && hosts.has(host)) edges.push({ from: hosts.get(host).id, to: endpointId, kind: 'exposes' })
    }
  }
  for (const asset of assets) {
    let host = ''
    try { host = new URL(asset.url).host } catch { host = String(asset.url || '') }
    nodes.push({ id: asset.id, kind: 'asset', title: host || String(asset.url || asset.id),
      subtitle: [String(asset.url || ''), asset.inScope === true ? '范围内' : '线索'],
      host, url: asset.url,
      state: asset.inScope === true ? 'in-scope' : 'candidate',
      sourceRefs: [{ kind: 'asset', id: asset.id }] })
  }
  for (const request of requests) {
    const label = requestLabel(request)
    const node = { id: request.id, kind: 'endpoint', title: label.title,
      subtitle: [label.subtitle, request.valid === true ? '已绑定' : '待确认'].filter(Boolean).join(' · '),
      state: request.valid === true ? 'bound' : 'invalid',
      method: label.method, path: label.path, host: label.host,
      endpoint: request.endpoint,
      identity: label.identity, revision: request.revision || '', sourceRefs: [{ kind: 'request', id: request.id, revision: request.revision || '' }] }
    nodes.push(node)
    requestNodes.set(request.id, node)
    const owner = assets.find(asset => asset.url && request.endpoint && String(request.endpoint).startsWith(String(asset.url)))
    if (owner) edges.push({ from: owner.id, to: request.id, kind: 'exposes' })
  }
  for (const check of checks) {
    const id = check.id || 'check-' + nodes.length
    const title = check.check || check.entryId || check.title || check.name || check.kind || '检查项'
    nodes.push({ id, kind: 'check', title,
      subtitle: [check.authContext ? '身份 ' + check.authContext : '', statusLabel(check.status), id].filter(Boolean).join(' · '),
      checkId: id, entryId: check.entryId || '', identity: check.authContext || '',
      state: check.status || 'not-tested',
      sourceRefs: [{ kind: 'check', id: check.id || '' }] })
    const endpoint = String(check.endpoint || '')
    if (endpoint) {
      for (const request of requestNodes.values()) {
        if (request.endpoint && (endpoint.startsWith(String(request.endpoint)) || String(request.endpoint).startsWith(endpoint))) {
          edges.push({ from: request.id, to: id, kind: 'tested-by' })
          break
        }
      }
    }
  }
  const notTested = checks.filter(check => check.status === 'not-tested').length
  const blocked = checks.filter(check => check.status === 'blocked').length
  const notHit = checks.filter(check => check.status === 'not-hit').length
  return pageResult([{
    nodes, edges,
    checkDimensions: { total: checks.length, notHit, blocked, notTested },
    knownDenominator: checks.length, unmeasured: notTested, blocked,
  }], query, digest([rootId, nodes.length, edges.length, checks.length]))
}

function queryMethods(store, query) {
  const rootId = query.context?.rootId || ''
  let rows = listWorkflowDefinitions(store, rootId).map(item => ({
    methodId: item.id, version: item.version, title: item.name || item.title || item.id,
    category: item.category || '', scope: item.builtin ? 'builtin' : (item.source === 'session' ? 'session' : 'personal'),
    nodeCount: Number(item.nodes) || 0,
    description: item.description || '', selected: selectedWorkflow(store, rootId)?.id === item.id,
  }))
  if (query.filter?.text) {
    const text = String(query.filter.text).toLowerCase()
    rows = rows.filter(row => [row.methodId, row.title, row.category, row.description, row.scope]
      .some(value => String(value || '').toLowerCase().includes(text)))
  }
  return pageResult(rows, query, digest(rows.map(row => [row.methodId, row.version])))
}

function queryRoles(store, query) {
  const rootId = query.context?.rootId || ''
  const snapshot = rootId ? roleStatus(store, rootId) : null
  const source = snapshot ? snapshot.roles : (() => {
    const latest = new Map()
    for (const row of store.db.prepare('SELECT owner_session,record,digest FROM role_specs ORDER BY version DESC,updated_at DESC').all()) {
      const role = json(row.record)
      if (role && !latest.has(role.roleId)) latest.set(role.roleId, { ...role, digest: row.digest, ownerSession: row.owner_session })
    }
    return [...latest.values()]
  })()
  const versionRows = store.db.prepare('SELECT owner_session,role_id,version,digest,updated_at FROM role_specs ORDER BY role_id,version DESC').all()
  const versionsByRole = new Map()
  for (const row of versionRows) {
    if (rootId && row.owner_session !== rootId && row.owner_session !== 'global') continue
    if (!versionsByRole.has(row.role_id)) versionsByRole.set(row.role_id, [])
    versionsByRole.get(row.role_id).push({ version: row.version, digest: row.digest, updatedAt: row.updated_at,
      scope: row.owner_session === 'global' ? 'global' : 'root' })
  }
  const instancesByRole = new Map()
  if (snapshot) for (const instance of snapshot.instances) {
    const key = instance.roleId + '@' + instance.roleVersion
    if (!instancesByRole.has(key)) instancesByRole.set(key, [])
    instancesByRole.get(key).push({ childId: instance.childId, state: instance.state, workId: instance.workId,
      rootId: instance.rootId || rootId, updatedAt: instance.updatedAt,
      ...(instance.settlement ? { settlement: instance.settlement } : {}) })
  } else if (tableExists(store, 'role_instances')) {
    for (const row of store.db.prepare('SELECT session_id,child_id,role_id,role_version,work_id,state,updated_at FROM role_instances ORDER BY rowid DESC LIMIT 500').all()) {
      const key = row.role_id + '@' + row.role_version
      if (!instancesByRole.has(key)) instancesByRole.set(key, [])
      instancesByRole.get(key).push({ childId: row.child_id, state: row.state, workId: row.work_id,
        rootId: row.session_id, updatedAt: row.updated_at })
    }
  }
  let roles = source.map(role => ({
    roleId: role.roleId, version: role.version, title: role.title, objective: role.objective,
    responsibilities: role.responsibilities, deliverable: role.deliverable, scope: role.scope,
    source: role.source, digest: role.digest, capabilities: role.capabilities || [],
    ownerSession: role.ownerSession || (role.scope === 'root' ? rootId : ''),
    versions: versionsByRole.get(role.roleId) || [],
    instances: instancesByRole.get(role.roleId + '@' + role.version) || [],
  }))
  if (query.filter?.text) {
    const text = String(query.filter.text).toLowerCase()
    roles = roles.filter(role => [role.title, role.objective, role.responsibilities, role.deliverable, role.roleId, role.scope]
      .some(value => String(value || '').toLowerCase().includes(text)))
  }
  return pageResult(roles, query, digest(roles.map(row => [row.roleId, row.version, row.digest])))
}

function readRoleAny(store, roleId, version) {
  const id = String(roleId || '')
  if (!id) return null
  const exact = Number(version)
  const row = Number.isInteger(exact) && exact > 0
    ? store.db.prepare('SELECT record,digest FROM role_specs WHERE role_id=? AND version=? ORDER BY updated_at DESC LIMIT 1').get(id, exact)
    : store.db.prepare('SELECT record,digest FROM role_specs WHERE role_id=? ORDER BY version DESC,updated_at DESC LIMIT 1').get(id)
  if (!row) return null
  const role = json(row.record)
  return role ? { ...role, digest: row.digest } : null
}

function queryExecution(store, query) {
  const rootId = query.context?.rootId
  if (!rootId) return pageResult([], query, digest([]))
  const records = []
  for (const receipt of trafficRows(store, rootId)) records.push({ kind: 'http', id: receipt.id, at: receipt.at,
    tool: 'host-http-execution', summary: receipt.method + ' ' + receipt.url, state: receipt.outcome || 'captured',
    identity: receipt.identity, source: receipt.source })
  for (const row of store.db.prepare('SELECT record FROM task_model_calls WHERE session_id=? ORDER BY rowid DESC LIMIT 200').all(rootId)) {
    const call = json(row.record) || {}
    records.push({ kind: 'model', id: call.id || '', at: iso(call.at), tool: call.provider ? call.provider + '/' + call.model : 'model',
      summary: '模型回合', state: call.state || '', identity: '', source: 'model-admission' })
  }
  for (const attempt of listAttempts(store, rootId, 100)) records.push({ kind: 'attempt', id: attempt.attemptId, at: iso(attempt.startedAt),
    tool: attempt.childId, summary: '工作尝试 ' + attempt.workId, state: attempt.state })
  for (const worker of siteWorkerRows(store, rootId)) records.push({ kind: 'role', id: worker.childId, at: iso(worker.createdAt),
    tool: worker.role?.title || worker.focus || 'worker', summary: worker.question, state: worker.state, identity: worker.role?.title || '' })
  records.sort((a, b) => sortableTime(b.at) - sortableTime(a.at))
  const filter = query.filter || {}
  let rows = records
  if (filter.kind) rows = rows.filter(row => row.kind === filter.kind)
  if (filter.text) {
    const text = String(filter.text).toLowerCase()
    rows = rows.filter(row => [row.id, row.summary, row.state, row.identity, row.tool, row.kind]
      .some(value => String(value || '').toLowerCase().includes(text)))
  }
  return pageResult(rows, query, digest(rows.map(row => [row.kind, row.id, row.state])))
}

function maskSecrets(text) {
  return String(text || '').replace(/^((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*).*$/gim, '$1***')
}

function decodeReceiptBody(value) {
  try {
    const buffer = Buffer.from(String(value || ''), 'base64')
    return buffer.length ? buffer.toString('utf8') : ''
  } catch { return '' }
}

function executionDetail(store, rootId, executionId, executionKind) {
  const id = String(executionId || '')
  if (!id) throw Object.assign(new Error('executionId required'), { code: 'MISSING_PREREQUISITE' })
  const kindName = String(executionKind || 'http')
  if (kindName === 'http') {
    const ids = descendantSessionIds(store, rootId)
    const row = store.db.prepare(`SELECT session_id,id,record FROM execution_receipts WHERE id=? AND session_id IN (${ids.map(() => '?').join(',')})`)
      .get(id, ...ids)
    if (!row) throw Object.assign(new Error('execution receipt not found'), { code: 'MISSING_PREREQUISITE' })
    const record = json(row.record) || {}
    const body = decodeReceiptBody(record.responseBodyBase64).slice(0, 8192)
    return {
      id, kind: 'http', at: record.completedAt || record.startedAt || '', status: record.status ?? null,
      outcome: record.outcome || '', error: record.error || '', source: record.source || '',
      identity: record.identity?.name || record.identityLabel || record.authContext || '',
      request: maskSecrets(record.request || '').slice(0, 8192),
      responseHead: maskSecrets(record.responseHead || '').slice(0, 4096),
      responseBody: maskSecrets(body), responseBodyEncoding: body ? 'utf8-preview' : 'binary-or-empty',
      bytes: Number(record.responseBytes) || 0, capturedBytes: Number(record.capturedBytes) || 0,
      requestSha256: record.requestSha256 || '', responseSha256: record.responseSha256 || '',
      refs: [{ kind: 'receipt', id }],
    }
  }
  if (kindName === 'model') {
    const row = store.db.prepare('SELECT record FROM task_model_calls WHERE session_id=? ORDER BY rowid DESC LIMIT 500').all(rootId)
      .map(item => json(item.record)).find(item => item && String(item.id || '') === id)
    if (!row) throw Object.assign(new Error('model call not found'), { code: 'MISSING_PREREQUISITE' })
    return { id, kind: 'model', at: iso(row.at), state: row.state || '', record: maskSecrets(JSON.stringify(row)).slice(0, 8192) }
  }
  if (kindName === 'attempt') {
    const row = store.db.prepare('SELECT record FROM role_attempts WHERE session_id=? AND attempt_id=?').get(rootId, id)
    if (!row) throw Object.assign(new Error('attempt not found'), { code: 'MISSING_PREREQUISITE' })
    return { id, kind: 'attempt', record: maskSecrets(row.record).slice(0, 8192) }
  }
  if (kindName === 'role') {
    const worker = siteWorkerRows(store, rootId).find(item => String(item.childId) === id)
    if (!worker) throw Object.assign(new Error('role instance not found'), { code: 'MISSING_PREREQUISITE' })
    return { id, kind: 'role', record: maskSecrets(JSON.stringify(worker)).slice(0, 8192) }
  }
  throw Object.assign(new Error('unsupported execution kind'), { code: 'MISSING_PREREQUISITE' })
}

function queryCapabilities(store, ctx, query) {
  const rootId = query.context?.rootId || ''
  const agent = ctx.agents?.get?.(rootId) || ctx.agents?.get?.(query.context?.sessionId) || null
  let tools = (ctx.tools?.schemas?.(agent) || []).map(tool => ({
    id: 'tool:' + tool.name, name: tool.name, purpose: String(tool.description || '').slice(0, 240),
    source: /mcp|burp|yakit/i.test(tool.name) ? 'host-mcp' : 'host-tool', status: 'visible',
    detail: '由当前 Host 会话实际暴露；在线/合同状态需在调用时复核。',
  }))
  if (query.filter?.text) {
    const text = String(query.filter.text).toLowerCase()
    tools = tools.filter(tool => [tool.name, tool.purpose, tool.source, tool.status]
      .some(value => String(value || '').toLowerCase().includes(text)))
  }
  return pageResult(tools, query, digest(tools.map(tool => tool.name)))
}

function queryProjectFiles(ctx, query) {
  const sessionId = String(query.context?.sessionId || query.context?.rootId || '')
  const agent = ctx.agents?.get?.(sessionId) || null
  const session = agent?.session || null
  if (!session) throw Object.assign(new Error('当前 Host 会话不可用，无法读取工作区文件'), { code: 'WORKSPACE_UNAVAILABLE' })
  let workspace = sessionWorkingDirectory(ctx, session, '')
  if (typeof workspace === 'string' && workspace.startsWith('file:')) {
    try { workspace = fileURLToPath(workspace) } catch { workspace = '' }
  }
  if (!workspace || !existsSync(workspace) || !statSync(workspace).isDirectory())
    throw Object.assign(new Error('会话工作区不存在或不是目录'), { code: 'WORKSPACE_UNAVAILABLE' })
  const snapshot = projectSnapshot(workspace)
  return {
    ok: true, data: snapshot,
    sourceRevision: digest([workspace, snapshot.workspace, snapshot.artifacts]),
    revisionVector: { saker: digest(snapshot.artifacts || {}) },
    updatedAt: nowIso(), stale: false,
    page: { nextCursor: null, hasMore: false, total: (snapshot.artifacts?.reportGroups || []).reduce((sum, group) => sum + (group.files || []).length, 0), totalKnown: true },
    capabilities: {}, notices: [],
  }
}

function queryAttention(store, query = {}) {
  const rows = []
  for (const root of rootsData(store)) {
    if (root.attention) rows.push({ id: 'root:' + root.rootId, rootId: root.rootId,
      kind: root.attention.kind, title: root.title, reason: root.attention.reason,
      next: root.attention.next, evidence: root.attention.evidence || '',
      revision: root.updatedAt })
    if (root.cleanupState !== 'clear') rows.push({ id: 'cleanup:' + root.rootId, rootId: root.rootId, kind: 'cleanup',
      title: root.title, reason: '并行任务释放未确认，名额仍保留', next: '核对原会话与 Host 成员后重试清理', revision: root.updatedAt })
  }
  for (const command of store.db.prepare("SELECT command_id,kind,status,error,updated_at FROM saker_command_records WHERE status IN ('result-unknown','blocked','conflict') ORDER BY updated_at DESC LIMIT 50").all())
    rows.push({ id: 'command:' + command.command_id, kind: 'command', title: command.kind, reason: command.error || command.status,
      next: '查询同一 commandId 的进度，不要重新发送', revision: command.updated_at })
  const filter = query.filter || {}
  let filtered = rows
  if (filter.kind) filtered = filtered.filter(row => row.kind === filter.kind)
  if (filter.text) {
    const text = String(filter.text).toLowerCase()
    filtered = filtered.filter(row => [row.kind, row.title, row.reason, row.next, row.rootId]
      .some(value => String(value || '').toLowerCase().includes(text)))
  }
  return pageResult(filtered, query, digest(filtered))
}

function queryLogs(store, query) {
  const rootId = query.context?.rootId || ''
  if (!rootId) return pageResult([], query, digest([]))
  let rows = store.db.prepare('SELECT kind,record,created_at FROM task_policy_events WHERE session_id=? ORDER BY id DESC LIMIT 300').all(rootId)
    .map(row => ({ at: row.created_at, kind: row.kind, record: row.record }))
  if (query.filter?.text) {
    const text = String(query.filter.text).toLowerCase()
    rows = rows.filter(row => [row.kind, row.record, row.at].some(value => String(value || '').toLowerCase().includes(text)))
  }
  return pageResult(rows, query, digest(rows.map(row => [row.at, row.kind])))
}

// 隔天复核摘要：只读当前任务投影，最多三组、每组两个指针。
// 不调用 ensureRoot、不回填 task_cost_events、不写事件、不发起任何 Host 动作。
function reviewSummary(store, rootId) {
  const policy = readTaskPolicy(store, rootId)
  if (!policy) throw new Error('task root not found')
  const state = taskPolicyStatus(store, rootId)
  const generation = generationOf(store, rootId)
  const controlState = runtimeStateOf(state)
  const businessState = businessStateOf(state)
  const groups = { review: [], records: [], unresolved: [] }
  const seen = new Set()
  const add = (group, item) => {
    if (!item || !item.id || groups[group].length >= 2) return
    const key = item.kind + '\0' + item.id
    if (seen.has(key)) return
    seen.add(key)
    groups[group].push({ ...item, group,
      groupLabel: group === 'review' ? '待你复核' : group === 'records' ? '最新可核对记录' : '未确认的操作结果' })
  }
  const evidenceIndex = buildEvidenceIndex(store, rootId)
  const resolveRow = row => {
    const refs = json(row.evidence_refs) || []
    return refs.map(ref => resolveEvidenceRef(store, rootId, ref, evidenceIndex))
  }
  const pendingRows = store.db.prepare(`SELECT * FROM findings WHERE session_id=? AND mode='pentest'
    AND status IN ('pending','suspect','code-reviewed') ORDER BY updated_at DESC, seq DESC LIMIT 20`).all(rootId)
  const reviewedRows = store.db.prepare(`SELECT f.*, r.review_seq AS review_seq, r.decision AS review_decision,
      r.basis_digest AS review_basis_digest, r.created_at AS review_created_at
    FROM findings f JOIN finding_evidence_reviews r
      ON r.session_id=f.session_id AND r.finding_id=f.id
    WHERE f.session_id=? AND f.mode='pentest'
      AND r.review_seq=(SELECT MAX(r2.review_seq) FROM finding_evidence_reviews r2
        WHERE r2.session_id=f.session_id AND r2.finding_id=f.id)
    ORDER BY r.created_at DESC LIMIT 20`).all(rootId)
  const candidates = []
  for (const row of pendingRows) {
    const resolved = resolveRow(row)
    candidates.push({ row, resolved, at: row.updated_at || row.created_at || '',
      reasonCode: 'FINDING_PENDING', reason: '发现仍待复核' })
  }
  for (const row of reviewedRows) {
    const resolved = resolveRow(row)
    const stale = String(row.review_basis_digest || '') !== reviewBasisDigest({ id: row.id, updatedAt: row.updated_at }, resolved).basisDigest
    if (row.review_decision === 'supported' && !stale) continue
    candidates.push({ row, resolved, at: row.review_created_at || row.updated_at || '',
      reasonCode: stale ? 'REVIEW_STALE' : 'REVIEW_INSUFFICIENT',
      reason: stale ? '原判断保留，当前依据不可复核' : '依据复核记录为“依据不足”' })
  }
  candidates.sort((a, b) => sortableTime(b.at) - sortableTime(a.at) || String(a.row.id).localeCompare(String(b.row.id)))
  for (const item of candidates) {
    add('review', { kind: 'finding', id: item.row.id, rootId, title: item.row.title || item.row.id,
      hint: item.reason, reasonCode: item.reasonCode, at: item.at,
      canOpenEvidence: item.resolved.some(ref => !!ref.openRef),
      evidenceHint: item.resolved.some(ref => !!ref.openRef) ? '看依据' : '看发现' })
  }
  for (const receipt of trafficRows(store, rootId).slice(0, 20)) {
    add('records', { kind: 'http', id: receipt.id, rootId: receipt.rootId || rootId,
      title: [receipt.method, receipt.url].filter(Boolean).join(' ') || receipt.id,
      hint: receipt.outcome || (receipt.status ? 'HTTP ' + receipt.status : '已保存回执'),
      at: receipt.at, canOpenEvidence: true })
  }
  for (const item of candidates) {
    const evidence = item.resolved.find(ref => ref.openRef)
    if (!evidence) continue
    add('records', { kind: 'finding', id: item.row.id, rootId, title: item.row.title || item.row.id,
      hint: '已保存且能定位的原件', at: item.at, canOpenEvidence: true,
      evidenceRef: { kind: evidence.kind, id: evidence.id, revision: evidence.revision || '' } })
  }
  const hashes = new Set()
  for (const g of [0, generation]) for (const sid of ['', rootId])
    hashes.add(digest(commandContext({ context: { rootId, generation: g, sessionId: sid } })))
  const commands = store.db.prepare(`SELECT command_id,context_hash,kind,status,error,updated_at
    FROM saker_command_records WHERE status IN ('result-unknown','blocked','conflict')
    ORDER BY updated_at DESC LIMIT 200`).all()
  for (const command of commands) {
    if (!hashes.has(command.context_hash)) continue
    add('unresolved', { kind: 'command', id: command.command_id, commandId: command.command_id, rootId,
      title: command.kind || '工作台操作', hint: command.error || command.status,
      reasonCode: 'COMMAND_RESULT_UNKNOWN', at: new Date(Number(command.updated_at) || 0).toISOString(),
      canOpenEvidence: false })
  }
  const items = [groups.review, groups.records, groups.unresolved].filter(group => group.length)
  const stateLabel = ({ active: '运行中', paused: '处于暂停', stopped: '已停止', completed: '本轮结束',
    'turn-ended': '本轮结束', 'waiting-user': '待你处理', ready: '待开始', ended: '已结束' })[businessState] || businessState || '状态未知'
  const unresolved = groups.unresolved.length
  const reasonCode = state.reason ? 'TASK_REASON' : unresolved ? 'COMMAND_RESULT_UNKNOWN' : ''
  const reasonDetail = String(state.reason || '')
  const reasonLabel = reviewReasonLabel(reasonDetail) || (unresolved ? '存在执行结果未确认的操作' : stateLabel)
  return {
    ok: true,
    data: {
      rootId, generation,
      sourceRevision: digest([rootId, generation, items.map(group => group.map(item => [item.kind, item.id, item.at]))]),
      state: businessState, controlState, phase: state.phase || '', reasonCode, reasonLabel, reasonDetail, items,
      counts: { review: groups.review.length, records: groups.records.length, unresolved: groups.unresolved.length },
      empty: items.length === 0, emptyLabel: '暂无已核对记录',
    },
    sourceRevision: digest([rootId, generation, items.length]), revisionVector: { saker: String(generation) },
    updatedAt: nowIso(), stale: false, page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true },
    capabilities: {}, notices: [],
  }
}

// 把内部 reason（如 paused:needs-user）翻成用户能读的状态，同时保留原码。
function reviewReasonLabel(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw
  const single = { time_budget_exhausted: '时间上限已到，处于暂停', model_calls_exhausted: '模型额度不足',
    plan_complete: '本轮结束',
    'needs-user': '待你处理', user: '用户操作', 'result-unknown': '执行结果未确认',
    'command-result-unknown': '执行结果未确认', completed: '本轮结束', stopped: '已停止', paused: '处于暂停' }
  if (single[raw]) return single[raw]
  const [head, tail] = raw.split(':')
  const heads = { paused: '处于暂停', stopped: '已停止', completed: '本轮结束', 'turn-ended': '本轮结束',
    running: '运行中', failed: '失败', 'waiting-user': '待你处理', 'needs-user': '待你处理', ready: '待开始' }
  const tails = { 'needs-user': '待你处理', user: '用户操作', exhausted: '额度不足',
    'model-calls-exhausted': '模型额度不足', 'result-unknown': '执行结果未确认', unknown: '结果未知' }
  return [heads[head] || '', tails[tail] || ''].filter(Boolean).join(' · ') || raw
}

function emptyUsage(rootId, reason = '暂无可观察用量') {
  return {
    ok: true,
    data: {
      rootId, roundAt: null, source: 'task_model_calls', unavailable: true, reason,
      usage: { knownTokens: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
        observedWireAttempts: 0, settledUsageCount: 0, unknownUsageCount: 0, inFlightCount: 0,
        unobservedDispatchCount: 0, cancelledBeforeDispatch: 0, excludedFromBudgetCount: 0, totalCalls: 0,
        partial: true, cashCost: 'unknown' },
      budget: null, taskAuxiliary: null, staleCursor: false, rows: [], limit: 20,
    },
    sourceRevision: digest([rootId, 'unavailable']), revisionVector: { saker: '' }, updatedAt: nowIso(), stale: true,
    page: { nextCursor: null, hasMore: false, total: 0, totalKnown: true }, capabilities: {}, notices: [reason],
  }
}

function usageRound(store, rootId, query = {}) {
  let owner = null, ownerReason = ''
  try { owner = modelBudgetOwner(store, rootId) } catch (error) { ownerReason = error?.message || '无法确认账本归属' }
  if (!owner) return emptyUsage(rootId, ownerReason || '无法确认这条任务的账本归属；暂无可观察用量')
  const requested = Number(query.context?.roundAt || query.filter?.roundAt || 0)
  const roundAt = Number.isSafeInteger(requested) && requested > 0 ? requested : owner.round
  let related = []
  try {
    related = store.db.prepare('SELECT id,session_id,state,record FROM task_model_calls WHERE root_session=? AND round_at=? ORDER BY rowid')
      .all(owner.root, roundAt).map(row => ({ id: row.id, sessionId: row.session_id, state: row.state, record: json(row.record) || {} }))
  } catch { related = [] }
  const usage = { knownTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let knownSamples = 0, observedWireAttempts = 0, unknownUsageCount = 0, inFlightCount = 0
  let unobservedDispatchCount = 0, cancelledBeforeDispatch = 0, excludedFromBudgetCount = 0
  const detail = []
  for (const row of related) {
    const record = row.record
    if (record.wire) observedWireAttempts += 1
    if (record.readOnly === true) excludedFromBudgetCount += 1
    const normalized = record.state === 'settled' ? normalizedModelUsage(record.usage) : null
    if (record.state === 'settled' && normalized) {
      knownSamples += 1
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) usage[key] += normalized[key]
      usage.knownTokens += normalized.totalTokens
    } else if (record.state === 'settled' || record.state === 'unknown') {
      unknownUsageCount += 1
    } else if (record.state === 'dispatched' || record.state === 'reserved') {
      inFlightCount += 1
      if (!record.wire) unobservedDispatchCount += 1
    } else if (record.state === 'cancelled' && !record.wire) {
      cancelledBeforeDispatch += 1
    }
    detail.push({
      id: row.id, sessionId: row.sessionId, state: record.state || row.state,
      provider: record.provider || '', model: record.model || '', purpose: record.purpose || '',
      at: record.at || 0, settledAt: record.settledAt || 0, wire: !!record.wire,
      readOnly: record.readOnly === true, usage: normalized,
      usageUnknown: !normalized && record.state !== 'cancelled',
      budgetRole: record.readOnly === true ? 'excluded' : 'charged',
    })
  }
  detail.sort((a, b) => Number(b.at) - Number(a.at) || String(a.id).localeCompare(String(b.id)))
  const revision = digest([rootId, owner.root, roundAt,
    related.map(row => [row.id, row.state, row.record.settledAt || 0, Boolean(row.record.wire)])])
  const limit = Math.max(1, Math.min(100, Number(query.page?.limit) || 20))
  let offset = decodeCursor(query.page?.cursor)
  let staleCursor = false
  if (query.page?.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(String(query.page.cursor), 'base64url').toString('utf8'))
      if (decoded.revision && decoded.revision !== revision) staleCursor = true
    } catch { /* invalid cursor starts at the first page */ }
  }
  if (staleCursor) offset = 0
  const pageRows = detail.slice(offset, offset + limit)
  const hasMore = !staleCursor && offset + pageRows.length < detail.length
  const currentRound = roundAt === owner.round
  let budget = null
  if (currentRound) {
    try {
      const overview = modelBudgetOverview(store, rootId)
      if (overview) budget = { limits: overview.limits, chargedCalls: overview.chargedCalls, knownTokens: overview.knownTokens,
        heldTokens: overview.heldTokens, unknownCalls: overview.unknownCalls, unresolvedCalls: overview.unresolvedCalls,
        blocked: overview.blocked, wireAttempts: overview.wireAttempts }
    } catch { budget = { unavailable: true, reason: '该轮预算记录损坏' } }
  }
  let taskAuxiliary = null
  try {
    const curations = store.db.prepare(`SELECT usage,wire_attempts FROM knowledge_curations
      WHERE root_session=? AND wire_attempts>0`).all(owner.root)
    if (curations.length) {
      let tokens = 0, known = 0, unknown = 0, wires = 0
      for (const row of curations) {
        wires += Number(row.wire_attempts) || 0
        let parsed = null
        try { parsed = JSON.parse(row.usage || '{}') } catch { parsed = null }
        const normalized = parsed ? normalizedModelUsage(parsed) : null
        if (normalized) { tokens += normalized.totalTokens; known += 1 } else unknown += 1
      }
      taskAuxiliary = { label: '知识整理｜整个任务', wireAttempts: wires, knownCurations: known,
        unknownCurations: unknown, knownTokens: known ? tokens : null, cashCost: 'unknown' }
    }
  } catch { taskAuxiliary = null }
  const partial = unknownUsageCount > 0 || inFlightCount > 0
  return {
    ok: true,
    data: {
      rootId, ledgerRoot: owner.root, roundAt, currentRound, source: 'task_model_calls', unavailable: false, reason: '',
      usage: {
        knownTokens: knownSamples ? usage.knownTokens : null,
        inputTokens: knownSamples ? usage.inputTokens : null,
        outputTokens: knownSamples ? usage.outputTokens : null,
        cacheReadTokens: knownSamples ? usage.cacheReadTokens : null,
        cacheWriteTokens: knownSamples ? usage.cacheWriteTokens : null,
        observedWireAttempts, settledUsageCount: knownSamples, unknownUsageCount, inFlightCount,
        unobservedDispatchCount, cancelledBeforeDispatch, excludedFromBudgetCount,
        totalCalls: detail.length, partial, cashCost: 'unknown',
      },
      budget, taskAuxiliary, staleCursor, rows: pageRows, limit,
    },
    sourceRevision: revision, revisionVector: { saker: revision }, updatedAt: nowIso(), stale: staleCursor,
    page: { nextCursor: hasMore
      ? Buffer.from(JSON.stringify({ offset: offset + pageRows.length, revision }), 'utf8').toString('base64url') : null,
      hasMore, total: detail.length, totalKnown: true },
    capabilities: {}, notices: staleCursor ? ['账本在翻页期间发生变化，已回到第一页'] : [],
  }
}

function dashboard(store, ctx = null) {
  const roots = rootsData(store, ctx)
  const findings = findingRows(store).map(findingSummary)
  return {
    ok: true,
    data: {
      roots: roots.length, activeRoots: roots.filter(row => row.controlState === 'active').length,
      runningRoots: roots.filter(row => row.businessState === 'running').length,
      continuableRoots: roots.filter(row => ['paused', 'stopped', 'turn-ended', 'waiting-user', 'ended', 'ready'].includes(row.businessState)).length,
      verified: findings.filter(row => row.verificationState === 'verified').length,
      pending: findings.filter(row => ['candidate', 'needs-recheck'].includes(row.verificationState)).length,
      attention: queryAttention(store).data.length,
      recentRoots: roots.slice(0, 5), recentFindings: findings.slice(0, 5),
    },
    sourceRevision: digest([roots.length, findings.length, findings.filter(row => row.verificationState === 'verified').length]),
    revisionVector: { saker: digest([roots.length, findings.length]) }, updatedAt: nowIso(), stale: false,
    page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [],
  }
}

export function workbenchQuery(ctx, store, payload = {}) {
  const kind = String(payload.kind || 'dashboard.summary')
  const query = { context: payload.context || {}, filter: payload.filter || {}, sort: payload.sort || {}, page: payload.page || {} }
  if (kind === 'dashboard.summary') return dashboard(store, ctx)
  if (kind === 'roots.list') return queryRoots(store, query, ctx)
  if (kind === 'roots.detail') return rootDetail(store, ctx, String(query.context.rootId || ''), query)
  if (kind === 'review.summary') return reviewSummary(store, String(query.context.rootId || ''))
  if (kind === 'usage.round') return usageRound(store, String(query.context.rootId || ''), query)
  if (kind === 'findings.list') return queryFindings(store, query)
  if (kind === 'findings.detail') return findingDetail(store, query.context.findingId || payload.findingId, query.context.rootId)
  if (kind === 'findings.review-history') return listFindingEvidenceReviews(store,
    String(query.context.rootId || ''), String(query.context.findingId || payload.findingId || ''),
    { cursor: String(query.page.cursor || ''), limit: Number(query.page.limit) || 20 })
  if (kind === 'evidence.material') {
    const data = materialsDetail(store, String(query.context.rootId || ''), {
      kind: String(query.context.materialKind || 'file'),
      id: String(query.context.materialId || ''),
      offset: Number(query.context.offset) || 0,
      limit: Number(query.context.limit) || 8192,
    })
    return { ok: true, data, sourceRevision: digest([data.kind, data.id, data.offset, data.totalBytes]),
      revisionVector: { saker: String(data.offset || 0) }, updatedAt: nowIso(), stale: false,
      page: { nextCursor: null, hasMore: data.nextOffset !== null && data.nextOffset !== undefined, total: 1, totalKnown: true },
      capabilities: {}, notices: [] }
  }
  if (kind === 'traffic.list') return queryTraffic(store, query)
  if (kind === 'assets.list') return queryAssets(store, query)
  if (kind === 'assets.coverage') return queryCoverage(store, query)
  if (kind === 'exploration.graph') return queryExploration(store, query)
  if (kind === 'methods.list') return queryMethods(store, query)
  if (kind === 'methods.detail') {
    const method = readWorkflowDefinition(store, String(query.context.methodId || payload.methodId || ''), query.context.rootId || '')
    if (!method) throw new Error('method not found')
    return { ok: true, data: method, sourceRevision: digest([method.id, method.version]), revisionVector: { saker: method.version || '' },
      updatedAt: nowIso(), stale: false, page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [] }
  }
  if (kind === 'roles.list') return queryRoles(store, query)
  if (kind === 'roles.detail') {
    const roleId = String(query.context.roleId || payload.roleId || '')
    const role = query.context.rootId
      ? readRoleSpec(store, query.context.rootId, roleId, query.context.version)
      : readRoleAny(store, roleId, query.context.version)
    if (!role) throw new Error('role not found')
    return { ok: true, data: role, sourceRevision: digest([role.roleId, role.version, role.digest]), revisionVector: { saker: String(role.version) },
      updatedAt: nowIso(), stale: false, page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [] }
  }
  if (kind === 'work.list') return pageResult(listWorkItems(store, query.context.rootId || '', 200).map(work => ({ ...work })), query,
    digest(listWorkItems(store, query.context.rootId || '', 200).map(work => [work.workId, work.revision])))
  if (kind === 'modules.list') {
    const agent = ctx.agents?.get?.(query.context.rootId || query.context.sessionId) || null
    const capabilityResolver = moduleCapabilityResolver(ctx, agent)
    const listed = listModuleDefinitions(store, {
      rootId: query.context.rootId || '',
      filter: query.filter || {},
      page: query.page || {},
      capabilityResolver,
    })
    return { ok: true, data: listed, sourceRevision: digest(listed.items.map(item => [item.id, item.version, item.digest, item.archived])),
      revisionVector: { saker: digest([listed.items.length, listed.page.total]) }, updatedAt: nowIso(), stale: false,
      page: listed.page, capabilities: {}, notices: [], taxonomy: listed.taxonomy, facetCounts: listed.facetCounts, aliasIndex: listed.aliasIndex }
  }
  if (kind === 'modules.detail') {
    const agent = ctx.agents?.get?.(query.context.rootId || query.context.sessionId) || null
    const capabilityResolver = moduleCapabilityResolver(ctx, agent)
    const found = detailModuleDefinition(store, {
      rootId: query.context.rootId || '',
      ref: query.context.moduleRef || payload.moduleRef || { id: query.context.moduleId, version: query.context.version, ownerKey: query.context.ownerKey },
      capabilityResolver,
    })
    return { ok: true, data: found, sourceRevision: digest([found.id, found.version, found.digest]),
      revisionVector: { saker: String(found.version) }, updatedAt: nowIso(), stale: false,
      page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [] }
  }
  if (kind === 'modules.invocations.list') {
    const listed = listModuleInvocations(store, { rootId: query.context.rootId || '', filter: query.filter || {}, page: query.page || {} })
    return { ok: true, data: listed, sourceRevision: digest(listed.items.map(item => [item.invocationRef.id, item.invocationRef.revision, item.state])),
      revisionVector: { saker: String(listed.page.total) }, updatedAt: nowIso(), stale: false,
      page: listed.page, capabilities: {}, notices: [] }
  }
  if (kind === 'modules.invocations.detail') {
    const found = detailModuleInvocation(store, query.context.rootId || '', query.context.invocationId || payload.invocationId)
    return { ok: true, data: found, sourceRevision: digest([found.invocation_id, found.revision, found.state]),
      revisionVector: { saker: String(found.revision) }, updatedAt: nowIso(), stale: false,
      page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [] }
  }
  if (kind === 'project.files') return queryProjectFiles(ctx, query)
  if (kind === 'execution.records') return queryExecution(store, query)
  if (kind === 'execution.detail') {
    const data = executionDetail(store, query.context.rootId || '', query.context.executionId || payload.executionId,
      query.context.executionKind || payload.executionKind)
    return { ok: true, data, sourceRevision: digest([data.id, data.kind, data.status, data.at]),
      revisionVector: { saker: String(data.id) }, updatedAt: nowIso(), stale: false,
      page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [] }
  }
  if (kind === 'capabilities.list') return queryCapabilities(store, ctx, query)
  if (kind === 'capabilities.detail') {
    const id = String(query.context.capabilityId || payload.capabilityId || '')
    const listed = queryCapabilities(store, ctx, { ...query, page: { limit: 100 } })
    const found = listed.data.find(item => item.id === id)
    if (!found) throw Object.assign(new Error('capability not found'), { code: 'MISSING_PREREQUISITE' })
    return { ok: true, data: found, sourceRevision: digest([found.id, found.name]), revisionVector: { saker: found.name },
      updatedAt: nowIso(), stale: false, page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [] }
  }
  if (kind === 'attention.list') return queryAttention(store, query)
  if (kind === 'logs.list') return queryLogs(store, query)
  if (kind === 'command.status') {
    const commandId = String(query.context.commandId || payload.commandId || '')
    if (!commandId) throw Object.assign(new Error('commandId required'), { code: 'MISSING_PREREQUISITE' })
    const row = store.db.prepare('SELECT * FROM saker_command_records WHERE command_id=?').get(commandId)
    if (!row) return { ok: true, data: { commandId, status: 'unknown', phase: '', result: null, error: '', canRetry: false },
      sourceRevision: digest([commandId]), revisionVector: { saker: commandId }, updatedAt: nowIso(), stale: true,
      page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [] }
    if (row.context_hash !== digest(commandContext(payload)))
      throw Object.assign(new Error('该命令不属于当前范围'), { code: 'SCOPE_MISMATCH' })
    return { ok: true, data: {
      commandId, kind: row.kind, status: row.status, phase: row.phase,
      result: row.result ? json(row.result) : null, error: row.error || '',
      canRetry: ['rejected', 'result-unknown'].includes(row.status) ? false : row.status !== 'completed',
    }, sourceRevision: digest([commandId, row.status, row.updated_at]), revisionVector: { saker: String(row.updated_at) },
    updatedAt: nowIso(), stale: false, page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [] }
  }
  if (kind === 'work.detail') {
    const work = readWorkItem(store, query.context.rootId || '', String(query.context.workId || payload.workId || ''))
    if (!work) throw new Error('work not found')
    return { ok: true, data: work, sourceRevision: digest([work.workId, work.revision]), revisionVector: { saker: String(work.revision) },
      updatedAt: nowIso(), stale: false, page: { nextCursor: null, hasMore: false, total: 1, totalKnown: true }, capabilities: {}, notices: [] }
  }
  throw Object.assign(new Error('unknown workbench query: ' + kind), { code: 'unknown-query' })
}

function commandContext(payload) {
  const context = payload.context || {}
  return {
    rootId: String(context.rootId || payload.rootId || ''),
    generation: Number(context.generation || payload.generation || 0) || 0,
    sessionId: String(context.sessionId || payload.sessionId || ''),
  }
}

function commandIdOf(payload) {
  return String(payload.commandId || '').trim() || 'cmd-' + randomUUID()
}

function saveCommand(store, record) {
  store.db.prepare(`INSERT INTO saker_command_records(command_id,context_hash,kind,payload_hash,status,phase,result,error,owner_pid,owner_runtime,expires_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET
    status=excluded.status, phase=excluded.phase, result=excluded.result, error=excluded.error,
    owner_pid=excluded.owner_pid, owner_runtime=excluded.owner_runtime, expires_at=excluded.expires_at, updated_at=excluded.updated_at`)
    .run(record.commandId, record.contextHash, record.kind, record.payloadHash, record.status, record.phase,
      record.result || '', record.error || '', record.ownerPid || 0, record.ownerRuntime || '',
      record.expiresAt || 0, record.createdAt, Date.now())
}

function ownerAlive(pid) {
  const value = Number(pid)
  if (!Number.isSafeInteger(value) || value < 1) return false
  try { process.kill(value, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH' && error?.code !== 'EINVAL'; }
}

/**
 * Claim a commandId before any side effect. The transaction only protects the
 * claim; execution happens after commit. A dead submitter is never replayed
 * because its side effect is unknown; the caller gets result-unknown instead.
 */
function claimCommand(store, record) {
  const now = Date.now()
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const existing = store.db.prepare('SELECT * FROM saker_command_records WHERE command_id=?').get(record.commandId)
    if (!existing) {
      store.db.prepare(`INSERT INTO saker_command_records(command_id,context_hash,kind,payload_hash,status,phase,result,error,owner_pid,owner_runtime,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.commandId, record.contextHash, record.kind, record.payloadHash, 'submitting', 'authorized', '',
        '', record.ownerPid || 0, record.ownerRuntime || '', record.expiresAt || now + 10 * 60 * 1000,
        record.createdAt, now,
      )
      store.db.exec('COMMIT')
      return { owner: true, record }
    }
    if (existing.context_hash !== record.contextHash || existing.payload_hash !== record.payloadHash) {
      store.db.exec('ROLLBACK')
      throw Object.assign(new Error('commandId already exists with different content'), { code: 'command-conflict' })
    }
    if (existing.status === 'submitting') {
      if (ownerAlive(existing.owner_pid)) {
        store.db.exec('COMMIT')
        return { owner: false, existing, inFlight: true }
      }
      store.db.prepare("UPDATE saker_command_records SET status='result-unknown',phase='failed',error=?,updated_at=? WHERE command_id=? AND status='submitting'")
        .run('previous command owner exited before a result was recorded; do not replay side effects; issue a new command after checking state', now, record.commandId)
      const unknown = store.db.prepare('SELECT * FROM saker_command_records WHERE command_id=?').get(record.commandId)
      store.db.exec('COMMIT')
      return { owner: false, existing: unknown }
    }
    store.db.exec('COMMIT')
    return { owner: false, existing }
  } catch (error) {
    try { store.db.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
}

function requireRootPolicy(store, rootId) {
  const policy = readTaskPolicy(store, rootId)
  if (!policy) throw Object.assign(new Error('task root not found'), { code: 'root-missing' })
  return policy
}

function parseBudget(value = {}) {
  const out = {}
  for (const key of ['minutes', 'toolCalls', 'modelCalls', 'tokens', 'workers', 'unmeteredToolCalls']) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== '') out[key] = Number(value[key])
  }
  return out
}

export async function workbenchCommand(ctx, store, payload = {}, services = {}) {
  const commandId = commandIdOf(payload)
  const kind = String(payload.kind || '')
  const context = commandContext(payload)
  const payloadHash = digest({ kind, context, expected: payload.expected || {}, subjectRef: payload.subjectRef || null, payload: payload.payload || {} })
  const contextHash = digest(context)
  const running = commandInFlight.get(commandId)
  if (running) {
    if (running.contextHash !== contextHash || running.payloadHash !== payloadHash)
      throw Object.assign(new Error('commandId is already running with different content'), { code: 'command-conflict' })
    return running.promise
  }
  const execute = async () => {
    const record = {
      commandId, contextHash, kind, payloadHash, status: 'submitting', phase: 'authorized',
      result: '', error: '', ownerPid: process.pid, ownerRuntime: 'workbench',
      expiresAt: Date.now() + 10 * 60 * 1000, createdAt: Date.now(),
    }
    const claim = claimCommand(store, record)
    if (!claim.owner) {
      const existing = claim.existing
      if (existing.status === 'completed' || existing.status === 'accepted') {
        const parsed = existing.result ? json(existing.result) : null
        return { ok: true, commandId, duplicate: true, status: existing.status, result: parsed }
      }
      if (existing.status === 'result-unknown')
        return { ok: false, commandId, code: 'HOST_RESULT_UNKNOWN', error: existing.error || '上次操作结果未知，请先查询同一命令' }
      if (existing.status === 'rejected')
        throw Object.assign(new Error(existing.error || 'this commandId was already rejected'), { code: 'command-rejected', commandId })
      if (claim.inFlight)
        throw Object.assign(new Error('commandId is already running in another Desktop process; query the same commandId instead of retrying'), { code: 'command-in-flight', commandId })
      throw Object.assign(new Error('commandId is in an unknown state; query it before retrying'), { code: 'command-state-unknown', commandId })
    }
    try {
      const result = await executeCommand(ctx, store, kind, payload, context, services)
      record.status = 'completed'; record.phase = 'settled'; record.result = JSON.stringify(result)
      saveCommand(store, record)
      return { ok: true, commandId, status: 'completed', result }
    } catch (error) {
      record.status = error?.unknown === true ? 'result-unknown' : 'rejected'
      record.phase = 'failed'; record.error = String(error?.message || error)
      saveCommand(store, record)
      throw Object.assign(new Error(String(error?.message || error)), {
        code: error?.code || 'command-rejected', commandId,
        ...(error?.details ? { details: error.details } : {}),
      })
    }
  }
  const promise = execute()
  commandInFlight.set(commandId, { contextHash, payloadHash, promise })
  try {
    return await promise
  } finally {
    if (commandInFlight.get(commandId)?.promise === promise) commandInFlight.delete(commandId)
  }
}

async function executeCommand(ctx, store, kind, payload, context, services) {
  const body = payload.payload || {}
  if (kind === 'root.start') {
    const rootId = context.rootId || context.sessionId || 'root-' + randomUUID()
    if (readTaskPolicy(store, rootId)) throw Object.assign(new Error('task already started; open the existing task'), { code: 'root-exists' })
    const policy = startTaskPolicy(store, rootId, {
      mode: body.taskKind === 'nday' ? 'nday' : 'regular',
      target: body.target || body.targetInputs?.[0] || '', question: body.goal || body.question || '',
      budget: parseBudget(body.limits), ...(body.methodRef ? { methodId: body.methodRef.id } : {}),
    })
    ensureRoot(store, rootId, policy, {
      projectKey: payload.context?.projectKey,
      workspaceKey: payload.context?.workspaceKey,
    })
    return { rootId, generation: generationOf(store, rootId), policy }
  }
  const rootId = context.rootId || context.sessionId
  if (kind === 'module.prefer') {
    const ref = body.moduleSnapshotRef || {}
    const contextInfo = payload.context || {}
    return writeModulePreference(store, {
      hostSession: String(contextInfo.sessionId || context.sessionId || rootId || ''),
      workspaceKey: String(contextInfo.workspaceKey || ''),
      projectKey: String(contextInfo.projectKey || ''),
      moduleSnapshotRef: ref,
      operation: body.operation || 'auto',
    }, { expectedRevision: payload.expected?.preferenceRevision ?? null })
  }
  if (kind === 'role.define' && !rootId) {
    const role = createRoleSpec(store, 'workspace-draft', { ...body, scope: 'global', source: 'user' }).role
    return { roleId: role.roleId, version: role.version, executionDigest: role.digest, role, ownerRef: { kind: 'personal' } }
  }
  if (kind === 'role.save' && !rootId) {
    const source = readRoleAny(store, String(body.roleRef?.id || body.roleId || ''), body.roleRef?.version || body.version)
    if (!source) throw Object.assign(new Error('role version not found'), { code: 'MISSING_PREREQUISITE' })
    const saved = createRoleSpec(store, 'workspace-draft', { ...source, roleId: 'role-' + randomUUID(), version: undefined,
      title: body.alias || source.title, scope: 'global', source: 'user' }).role
    return { savedRoleRef: { roleId: saved.roleId, version: saved.version }, executionDigest: saved.digest }
  }
  if (kind === 'module.define' && !rootId) {
    const ownerKey = body.destination === 'personal' ? 'personal' : 'workspace'
    const saved = defineModuleDraft(store, ownerKey, body)
    return { moduleSnapshotRef: { id: saved.id, version: saved.version, digest: saved.digest, ownerKey },
      definition: saved, destination: ownerKey === 'personal' ? 'personal' : 'workspace' }
  }
  if (kind === 'module.save' && !rootId) {
    const saved = saveModulePersonal(store, { moduleSnapshotRef: body.moduleSnapshotRef, name: body.name || '',
      previousVersion: body.previousVersion || null, rootId: '' })
    return { moduleSnapshotRef: { id: saved.id, version: saved.version, digest: saved.digest, ownerKey: 'personal' }, definition: saved }
  }
  const policy = requireRootPolicy(store, rootId)
  if (kind === 'roles.reconcile') {
    return reconcileReleasedRoleSettlements(store, rootId)
  }
  if (kind === 'root.pause') {
    pauseTaskPolicy(store, rootId, { code: 'needs-user', reason: body.reason || 'workbench pause', evidence: 'workbench command' }, 'workbench')
    ensureRoot(store, rootId); return { controlState: 'paused', rootId }
  }
  if (kind === 'root.resume') {
    resumeTaskPolicy(store, rootId, body.reason || 'workbench resume', 'desktop-user')
    ensureRoot(store, rootId); return { controlState: 'active', rootId }
  }
  if (kind === 'root.continue') {
    if (policy.parentSession) throw Object.assign(new Error('child task cannot create a successor root'), { code: 'SCOPE_CLOSED' })
    archiveTaskRound(store, rootId, 'desktop-user')
    const minutes = Number(policy.budget?.minutes)
    const next = {
      ...policy, cancelled: false, finishedAt: null, turnEndedAt: null, blocker: null,
      policyRev: (Number(policy.policyRev) || 1) + 1, startedAt: Date.now(),
      budget: { ...policy.budget,
        ...(policy.budget?.deadline !== null && Number.isFinite(minutes) && minutes > 0
          ? { deadline: Date.now() + minutes * 60000 } : {}) },
    }
    writeTaskPolicy(store, rootId, next, 'workbench-continue')
    ensureRoot(store, rootId, next)
    return { rootId, generation: generationOf(store, rootId), predecessorGeneration: context.generation || 1, policy: next }
  }
  const generation = context.generation || generationOf(store, rootId)
  if (kind === 'scope.stop') {
    const scopeKind = String(body.scopeKind || 'work')
    const scopeId = String(body.scopeId || '')
    if (!['work', 'group', 'instance', 'root'].includes(scopeKind)) throw Object.assign(new Error('invalid scope kind'), { code: 'INVALID_DEFINITION' })
    if (scopeKind === 'root') {
      updateTaskProgress(store, rootId, { cancelled: true })
      const agent = services.agentFor?.(rootId) || ctx.agents?.get?.(rootId)
      if (agent && services.roleRuntime) await services.roleRuntime.stop(agent, { all: true, reason: body.reason || 'root stopped' }, AbortSignal.timeout(15000))
      ensureRoot(store, rootId); return { controlState: 'stopped', cleanupState: cleanupStateOf(store, rootId) }
    }
    if (scopeKind === 'instance') {
      const agent = services.agentFor?.(rootId) || ctx.agents?.get?.(rootId)
      if (!agent || !services.roleRuntime) throw Object.assign(new Error('role runtime unavailable'), { code: 'ADAPTER_UNVERIFIED' })
      const stopped = await services.roleRuntime.stop(agent, { instanceId: scopeId, reason: body.reason || 'scope stop' }, AbortSignal.timeout(15000))
      return { controlState: stopped.ok ? 'stopped' : 'cleanup-unknown', cleanupState: stopped.ok ? 'clear' : 'unknown', stopped }
    }
    const work = readWorkItem(store, rootId, scopeId)
    if (!work) throw Object.assign(new Error('work not found'), { code: 'MISSING_PREREQUISITE' })
    const next = updateWorkItem(store, rootId, scopeId, { expectedRevision: work.revision, state: 'stopped' }, 'scope-stop')
    store.db.prepare(`INSERT INTO saker_scope_controls(root_id,generation,scope_kind,scope_id,state,epoch,record,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(root_id,generation,scope_kind,scope_id) DO UPDATE SET
      state=excluded.state, epoch=excluded.epoch, record=excluded.record, updated_at=excluded.updated_at`)
      .run(rootId, generation, scopeKind, scopeId, 'stopped', Date.now(), JSON.stringify({ workRevision: next.revision }), Date.now())
    return { controlState: 'stopped', scopeKind, scopeId, workRevision: next.revision }
  }
  if (kind === 'work.propose') {
    const work = createWorkItem(store, rootId, { ...body, question: body.question, target: body.target || body.targetRefs?.[0] })
    return { workId: work.work.workId, workRevision: work.work.revision, duplicate: work.duplicate === true, work: work.work }
  }
  if (kind === 'work.guidance') {
    const work = readWorkItem(store, rootId, String(body.workRef?.id || body.workId || ''))
    if (!work) throw Object.assign(new Error('work not found'), { code: 'MISSING_PREREQUISITE' })
    const guidanceId = 'guidance-' + randomUUID()
    store.db.prepare('INSERT INTO saker_work_guidance(guidance_id,root_id,generation,work_id,work_revision,instruction,material_refs,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(guidanceId, rootId, generation, work.workId, work.revision, String(body.instruction || '').slice(0, 4000), JSON.stringify(body.materialRefs || []), Date.now())
    return { guidanceId, workRevision: work.revision, effectiveFrom: 'next-action', workId: work.workId }
  }
  if (kind === 'role.define') {
    const role = createRoleSpec(store, rootId, { ...body, scope: 'root', source: 'model' }).role
    return { roleId: role.roleId, version: role.version, executionDigest: role.digest, role }
  }
  if (kind === 'role.resume') {
    const agent = services.agentFor?.(rootId) || ctx.agents?.get?.(rootId)
    if (!agent || !services.roleRuntime?.resumeQueued) throw Object.assign(new Error('role runtime unavailable'), { code: 'ADAPTER_UNVERIFIED' })
    const resumed = await services.roleRuntime.resumeQueued(agent, { reason: body.reason || 'workbench resume queued' }, AbortSignal.timeout(20000))
    return resumed
  }
  if (kind === 'role.save') {
    const source = readRoleSpec(store, rootId, String(body.roleRef?.id || body.roleId || ''), body.roleRef?.version || body.version)
    if (!source) throw Object.assign(new Error('role version not found'), { code: 'MISSING_PREREQUISITE' })
    const saved = createRoleSpec(store, rootId, { ...source, roleId: 'role-' + randomUUID(), version: undefined,
      title: body.alias || source.title, scope: 'global', source: 'user' }).role
    return { savedRoleRef: { roleId: saved.roleId, version: saved.version }, executionDigest: saved.digest }
  }
  if (kind === 'work.assign') {
    const agent = services.agentFor?.(rootId) || ctx.agents?.get?.(rootId)
    if (!agent || !services.roleRuntime) throw Object.assign(new Error('role runtime unavailable'), { code: 'ADAPTER_UNVERIFIED' })
    const started = await services.roleRuntime.start(agent, {
      roleId: body.roleSnapshotRef?.id || body.roleId, roleVersion: body.roleSnapshotRef?.version || body.roleVersion,
      workId: body.workRef?.id || body.workId, logicalParent: body.logicalParent,
      idempotencyKey: commandIdOf(payload), requestedBy: 'workbench',
    }, AbortSignal.timeout(20000))
    return started
  }
  if (kind === 'work.retest') {
    const findingId = String(body.findingRef?.id || body.findingId || '')
    const source = findingId ? getFinding(store, rootId, findingId) : null
    if (!source) throw Object.assign(new Error('finding not found for retest'), { code: 'MISSING_PREREQUISITE' })
    const work = createWorkItem(store, rootId, { title: '复测：' + source.title, question: body.reason || '复测指定发现，保留原证据与账号条件。',
      target: source.target, materialIds: body.materialRefs || [], successCriterion: '重新采集必要证据并给出仍可复现、未复现或无法确认。',
      falsifier: '身份、目标或测试条件变化无法解释结果。', ...(body.parentWorkId ? { parentWorkId: body.parentWorkId } : {}) })
    return { rootId, generation, workId: work.work.workId, attemptId: null, freshBoundary: {
      findingId, revision: source.updated_at, requiresNewCapture: true }, work: work.work }
  }
  if (kind === 'method.save') {
    const saved = saveWorkflowDefinition(store, body.definition || {}, { scope: body.destination === 'personal' ? 'personal' : 'session', sessionId: rootId })
    return { definitionRef: { methodId: saved.id, version: saved.version }, executionDigest: saved.digest || saved.semanticHash, validationWarnings: saved.warnings || [] }
  }
  if (kind === 'method.select') {
    const selected = selectWorkflow(store, rootId, String(body.methodRef?.id || body.methodId || ''))
    return { selectionRevision: selected?.revision || '', effectiveFrom: 'next-work', method: selected }
  }
  if (kind === 'module.define') {
    const ownerKey = body.destination === 'personal' ? 'personal' : rootId ? 'session:' + rootId : 'workspace'
    const saved = defineModuleDraft(store, ownerKey, body)
    return { moduleSnapshotRef: { id: saved.id, version: saved.version, digest: saved.digest, ownerKey },
      definition: saved, destination: ownerKey === 'personal' ? 'personal' : 'session' }
  }
  if (kind === 'module.revise') {
    const ownerKey = body.destination === 'personal' ? 'personal' : rootId ? 'session:' + rootId : 'workspace'
    const saved = reviseModuleDraft(store, ownerKey, body)
    return { moduleSnapshotRef: { id: saved.id, version: saved.version, digest: saved.digest, ownerKey },
      definition: saved, base: saved.base, reason: saved.reason }
  }
  if (kind === 'module.save') {
    const saved = saveModulePersonal(store, { moduleSnapshotRef: body.moduleSnapshotRef, name: body.name || '', previousVersion: body.previousVersion || null, rootId })
    return { moduleSnapshotRef: { id: saved.id, version: saved.version, digest: saved.digest, ownerKey: 'personal' }, definition: saved }
  }
  if (kind === 'module.archive') {
    const ref = body.definitionRef || body.moduleSnapshotRef || {}
    const ownerKey = ref.ownerKey || (rootId ? 'session:' + rootId : 'personal')
    return archiveModuleDefinition(store, { ownerKey, moduleId: ref.id, reason: body.reason })
  }
  if (kind === 'module.begin') {
    const workRef = body.workRef || {}
    const work = readWorkItem(store, rootId, String(workRef.id || body.workId || ''))
    if (!work) throw Object.assign(new Error('work not found'), { code: 'MISSING_PREREQUISITE' })
    const expectedWork = payload.expected?.workRevision
    if (expectedWork !== undefined && Number(expectedWork) !== work.revision)
      throw Object.assign(new Error('work revision 已变化'), { code: 'REVISION_CONFLICT' })
    const agent = services.agentFor?.(rootId) || ctx.agents?.get?.(rootId)
    const executorRef = String(agent?.id || agent?.sessionId || context.sessionId || rootId)
    const contextInfo = payload.context || {}
    const preference = readModulePreference(store, {
      hostSession: String(contextInfo.sessionId || context.sessionId || rootId),
      workspaceKey: String(contextInfo.workspaceKey || ''),
      projectKey: String(contextInfo.projectKey || ''),
    })
    let moduleSnapshotRef = body.moduleSnapshotRef
    let consumedPreference = null
    if ((!moduleSnapshotRef || !moduleSnapshotRef.id) && preference?.state === 'pending' && preference.module_snapshot_ref) {
      try { moduleSnapshotRef = JSON.parse(preference.module_snapshot_ref) } catch { moduleSnapshotRef = null }
      if (moduleSnapshotRef) consumedPreference = preference
    }
    const begun = beginModuleInvocation(store, {
      rootId, generation, workId: work.workId, executorRef,
      roleInstanceRef: String(body.roleInstanceRef || ''),
      moduleSnapshotRef,
      operation: body.operation || 'auto',
      inputRefs: body.inputRefs || [],
      capabilityBindings: body.capabilityBindings || {},
      policyRevision: Number(work.revision) || 1,
      prerequisites: moduleSnapshotRef?.id ? detailModuleDefinition(store, {
        rootId, ref: moduleSnapshotRef,
        capabilityResolver: moduleCapabilityResolver(ctx, agent),
      }) : null,
    })
    if (consumedPreference) {
      store.db.prepare(`UPDATE saker_module_preferences SET state='bound', bound_work_ref=?, revision=revision+1, updated_at=?
        WHERE host_session=? AND workspace_key=? AND project_key=?`)
        .run(work.workId, Date.now(), consumedPreference.host_session, consumedPreference.workspace_key, consumedPreference.project_key)
    }
    return { ...begun, consumedPreference: consumedPreference ? { workId: work.workId, revision: Number(consumedPreference.revision) + 1 } : null }
  }
  if (kind === 'module.finish') {
    return finishModuleInvocation(store, { rootId, invocationRef: body.invocationRef, outcome: body.outcome, outputRefs: body.outputRefs || [] })
  }
  if (kind === 'module.cancel') {
    return cancelModuleInvocation(store, { rootId, invocationRef: body.invocationRef, reason: body.reason })
  }
  if (kind === 'finding.record') {
    const finding = registerFinding(store, rootId, body.mode || 'pentest', { ...body, ...(body.claim ? { title: body.claim.title || body.claim, summary: body.claim.summary || body.claim.description || '' } : {}) })
    return { findingId: finding.id, revision: finding.updated_at, verificationState: findingState(finding), finding }
  }
  if (kind === 'finding.review') {
    const findingId = String(body.findingRef?.id || body.findingId || '')
    const current = getFinding(store, rootId, findingId)
    if (!current) throw Object.assign(new Error('finding not found'), { code: 'MISSING_PREREQUISITE' })
    const next = updateFinding(store, rootId, 'pentest', findingId, { status: body.reviewResult === 'confirmed' ? 'verified' : 'suspect',
      secondRating: body.reviewResult === 'confirmed' ? current.severity : 'info', secondRatingNote: String(body.reason || 'workbench review').slice(0, 2000) })
    return { findingId, revision: next.updated_at, verificationState: findingState(next) }
  }
  if (kind === 'role.message') {
    const agent = services.agentFor?.(rootId) || ctx.agents?.get?.(rootId)
    if (!agent || !services.roleRuntime) throw Object.assign(new Error('role runtime unavailable'), { code: 'ADAPTER_UNVERIFIED' })
    const sent = await services.roleRuntime.message(agent, { toInstance: body.recipientRef?.id || body.toInstance,
      messageId: body.messageId || commandIdOf(payload), message: body.summary || body.message || '', kind: body.kind || 'request',
      materialRefs: body.contentRefs || [] }, AbortSignal.timeout(15000))
    return { messageId: sent.message?.messageId || '', deliveryState: sent.message?.state || 'accepted', businessProcessed: false }
  }
  throw Object.assign(new Error('unknown workbench command: ' + kind), { code: 'unknown-command' })
}

export function workbenchStatus(store) {
  return {
    commands: store.db.prepare('SELECT command_id,kind,status,phase,error,updated_at FROM saker_command_records ORDER BY updated_at DESC LIMIT 50').all(),
    roots: store.db.prepare('SELECT root_id,host_root_session,task_kind,updated_at FROM saker_business_roots ORDER BY updated_at DESC LIMIT 50').all(),
  }
}
