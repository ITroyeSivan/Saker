// Test-module registry: immutable definitions + invocation records + session
// preference. This is not a second agent runtime; begin/finish only describe
// the bounded task pack that the existing Host executor consumes.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBrowserReceipt } from './browser-execution.js'
import { readCompetitionExecution, challengeRoot } from './competition-execution.js'
import { readCompetitionChallenge } from './competition-store.js'
import { readExecutionReceipt } from './execution-receipts.js'
import { ARTIFACT_KINDS, executionIdentity, matchesTarget } from './workflow/completion.js'
import { readWorkItem, updateWorkItem } from './role-orchestration.js'

const CATALOG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'test-modules', 'catalog.json'), 'utf8'))
const MODULES = Array.isArray(CATALOG.modules) ? CATALOG.modules : []
const TAXONOMY = CATALOG.taxonomy || { primaryCategories: [] }
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const now = () => Date.now()
const clamp = (value, max) => String(value ?? '').slice(0, max)

const FAMILY_LABEL = new Map()
for (const category of TAXONOMY.primaryCategories || []) {
  FAMILY_LABEL.set(category.id, category.title)
  for (const sub of category.subcategories || []) FAMILY_LABEL.set(category.id + '/' + sub.id, sub.title)
}

const TEXT_LIMITS = { title: 160, purpose: 4000, instructions: 6000, deliverable: 3000 }
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i
const TERMINAL_OUTCOMES = ['analysis-complete', 'verification-observed']
const PRODUCT_ARTIFACT_KINDS = ARTIFACT_KINDS.filter(kind => kind !== 'material')
const VERIFICATION_ONLY = new Set([
  'AuthorizationComparison', 'VerificationBundle', 'ImpactProofBundle',
  'RetestResult', 'ReproductionResult', 'CtfResultBundle',
])
const FRESH_OUTPUT_KINDS = new Set([
  'AuthorizationComparison', 'AuthSessionAssessment', 'ApiBoundaryAssessment',
  'AiBoundaryAssessment', 'BusinessLogicAssessment', 'ClientSideAssessment',
  'ExposureAssessment', 'FileBoundaryAssessment', 'InjectionAssessment',
  'ProtocolBoundaryAssessment', 'ServerFetchAssessment', 'CryptoAssessment',
  'VerificationBundle', 'ImpactProofBundle', 'RetestResult', 'ReproductionResult',
  'CtfResultBundle',
])

function fail(code, message, extra = {}) {
  throw Object.assign(new Error(message), { code, ...extra })
}

function outputContract(kind, supplied = {}) {
  const outputKind = String(kind || 'ObservationBundle').trim().slice(0, 120)
  const policy = ['fresh', 'reuse', 'none'].includes(supplied.evidencePolicy)
    ? supplied.evidencePolicy
    : FRESH_OUTPUT_KINDS.has(outputKind) ? 'fresh' : 'reuse'
  const terminalOutcomes = Array.isArray(supplied.terminalOutcomes)
    ? supplied.terminalOutcomes.filter(value => TERMINAL_OUTCOMES.includes(value))
    : []
  const artifactKinds = Array.isArray(supplied.artifactKinds)
    ? supplied.artifactKinds.filter(value => PRODUCT_ARTIFACT_KINDS.includes(value))
    : []
  const supportKinds = Array.isArray(supplied.supportKinds)
    ? supplied.supportKinds.filter(value => ['work', 'finding', 'material'].includes(value))
    : outputKind === 'RetestResult' || outputKind === 'ImpactProofBundle' ? ['finding'] : []
  return {
    kind: outputKind,
    evidencePolicy: policy,
    terminalOutcomes: terminalOutcomes.length ? terminalOutcomes
      : VERIFICATION_ONLY.has(outputKind) ? ['verification-observed'] : TERMINAL_OUTCOMES.slice(),
    minObservations: Number.isSafeInteger(Number(supplied.minObservations))
      ? Math.max(0, Number(supplied.minObservations))
      : outputKind === 'AuthorizationComparison' ? 2 : 1,
    distinctIdentities: supplied.distinctIdentities === true || outputKind === 'AuthorizationComparison',
    artifactKinds: artifactKinds.length ? artifactKinds : ['observation', 'analysis', 'coverage', 'gap', 'answer'],
    supportKinds,
  }
}

function normalizeOutputs(input, fallbackKind = 'ObservationBundle') {
  const rows = Array.isArray(input) && input.length ? input : [{ kind: fallbackKind }]
  return rows.map(item => {
    const value = typeof item === 'string' ? { kind: item } : item
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail('INVALID_DEFINITION', 'outputs 必须是对象或字符串数组')
    const contract = outputContract(value.kind || fallbackKind, value)
    if (!contract.kind) fail('INVALID_DEFINITION', 'output.kind 不能为空')
    return contract
  })
}

function builtinDefinition(module) {
  const version = Number(module.version) || 1
  const operations = Array.isArray(module.operations) && module.operations.length ? module.operations.map(String) : ['auto']
  const outputs = normalizeOutputs([{ kind: module.outputKind || 'ObservationBundle' }])
  return {
    id: module.id,
    title: module.title,
    family: module.family || 'custom',
    version,
    categoryId: module.categoryId || '',
    subcategoryId: module.subcategoryId || '',
    searchAliases: Array.isArray(module.searchAliases) ? module.searchAliases.slice(0, 32) : [],
    userSummary: clamp(module.userSummary || module.inputSummary || '', 240),
    outputSummary: clamp(module.outputSummary || '', 240),
    purpose: [
      module.expertActions || '',
      '输入：' + (module.inputSummary || ''),
      '产物：' + (module.outputKind || 'ObservationBundle'),
      '退出与反证：' + (module.exitAndFalsePositiveRules || ''),
    ].filter(Boolean).join('\n'),
    instructions: [
      '这是可独立调用的专家能力，不是强制全流程。',
      '输入：' + (module.inputSummary || ''),
      '专家做法：' + (module.expertActions || ''),
      '产物类型：' + (module.outputKind || 'ObservationBundle'),
      '退出与反证：' + (module.exitAndFalsePositiveRules || ''),
      '候选来源：' + (module.providerCandidates || ''),
      '本机扫描/资产能力在按需工具包里：需要时先调用 tool_pack load asset-discovery 或 active-scan；工具不在当前请求或真实二进制缺失时输出 blocked/unknown，不假装执行。',
      '纪律：观察、推断和未知分开；保留来源、目标、身份、时间和原件引用；没有真实材料时输出 unknown/blocked，不把状态码、工具命中或模型推断当成已验证漏洞；不扩大权限、不自动安装工具、不新增收费。',
    ].join('\n'),
    inputs: [{ kind: 'context' }, { kind: 'materials', optional: true }],
    outputs,
    operations,
    capabilityRequests: [],
    deliverable: module.outputSummary || '本项工作的观察、来源、结论条件与尚未确认的部分。',
    source: 'builtin',
  }
}

const BUILTIN = new Map()
for (const module of MODULES) {
  if (!module?.id || !NAME_RE.test(module.id)) continue
  const definition = builtinDefinition(module)
  BUILTIN.set(module.id, { ...definition, digest: digest(definition), ownerKey: 'builtin' })
}

export function moduleTaxonomy() {
  return TAXONOMY
}

export function builtinModuleCount() {
  return BUILTIN.size
}

function normalizeDefinition(input = {}, { allowVersion = false } = {}) {
  const id = String(input.id || '').trim()
  if (!NAME_RE.test(id)) fail('INVALID_DEFINITION', '模块 id 必须是 1–80 位字母/数字/._-')
  const title = String(input.title || id).trim()
  if (!title) fail('INVALID_DEFINITION', '模块名称不能为空')
  const purpose = String(input.purpose || '').trim()
  const instructions = String(input.instructions || '').trim()
  if (!purpose) fail('INVALID_DEFINITION', '模块 purpose 不能为空')
  if (!instructions) fail('INVALID_DEFINITION', '模块 instructions 不能为空')
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    if (String(input[field] || '').length > max) fail('INVALID_DEFINITION', `${field} 超过 ${max} 字`)
  }
  const operations = Array.isArray(input.operations) && input.operations.length
    ? [...new Set(input.operations.map(item => String(item).slice(0, 80)))]
    : ['auto']
  const inputs = Array.isArray(input.inputs) ? input.inputs : [{ kind: 'context' }, { kind: 'materials', optional: true }]
  const outputs = normalizeOutputs(input.outputs, 'ObservationBundle')
  let contractBytes = 0
  try {
    contractBytes = Buffer.byteLength(JSON.stringify({ inputs, outputs, operations }), 'utf8')
  } catch {
    fail('INVALID_DEFINITION', 'inputs/outputs/operations 不能序列化')
  }
  if (contractBytes > 16 * 1024) fail('INVALID_DEFINITION', 'inputs/outputs/operations 合计超过 16KiB')
  const definition = {
    id,
    title: clamp(title, TEXT_LIMITS.title),
    family: String(input.family || 'custom').slice(0, 80),
    version: allowVersion && Number.isSafeInteger(Number(input.version)) && Number(input.version) > 0 ? Number(input.version) : 1,
    categoryId: String(input.categoryId || '').slice(0, 40),
    subcategoryId: String(input.subcategoryId || '').slice(0, 80),
    searchAliases: [...new Set((Array.isArray(input.searchAliases) ? input.searchAliases : []).map(item => clamp(item, 80)).filter(Boolean))].slice(0, 32),
    userSummary: clamp(input.userSummary || '', 240),
    outputSummary: clamp(input.outputSummary || '', 240),
    purpose,
    instructions,
    inputs,
    outputs,
    operations,
    capabilityRequests: Array.isArray(input.capabilityRequests) ? input.capabilityRequests.slice(0, 40) : [],
    deliverable: clamp(input.deliverable || '', TEXT_LIMITS.deliverable),
    source: String(input.source || 'custom').slice(0, 40),
  }
  if (definition.categoryId && !(TAXONOMY.primaryCategories || []).some(category => category.id === definition.categoryId))
    fail('INVALID_DEFINITION', 'categoryId 不属于已注册的 7 个分类')
  if (definition.subcategoryId && definition.categoryId) {
    const category = (TAXONOMY.primaryCategories || []).find(item => item.id === definition.categoryId)
    if (category && !(category.subcategories || []).some(sub => sub.id === definition.subcategoryId))
      fail('INVALID_DEFINITION', 'subcategoryId 不属于所选主分类')
  }
  return definition
}

function rowDefinition(row) {
  if (!row) return null
  try {
    return { ...JSON.parse(row.definition_json), digest: row.digest, ownerKey: row.owner_key, updatedAt: Number(row.created_at) }
  } catch { return null }
}

export function readModuleDefinition(store, ownerKey, moduleId, version) {
  const id = String(moduleId || '')
  if (!id) return null
  if (ownerKey === 'builtin' || !ownerKey) {
    const found = BUILTIN.get(id)
    if (!found) return null
    if (version && Number(version) !== found.version) return null
    return found
  }
  const row = version
    ? store.db.prepare('SELECT * FROM saker_test_module_versions WHERE owner_key=? AND module_id=? AND version=?').get(ownerKey, id, Number(version))
    : store.db.prepare('SELECT * FROM saker_test_module_versions WHERE owner_key=? AND module_id=? ORDER BY version DESC LIMIT 1').get(ownerKey, id)
  return rowDefinition(row)
}

export function resolveModuleSnapshot(store, ref, rootId = '') {
  if (!ref || !ref.id) fail('MISSING_PREREQUISITE', '需要 moduleSnapshotRef.id')
  if (String(ref.ownerKey || '').startsWith('session:') && ref.ownerKey !== 'session:' + rootId)
    fail('SCOPE_MISMATCH', '该模块草稿不属于当前任务')
  const owners = [String(ref.ownerKey || ''), String(ref.source || ''), rootId ? 'session:' + rootId : '', 'personal', 'builtin'].filter(Boolean)
  for (const owner of [...new Set(owners)]) {
    const found = readModuleDefinition(store, owner, ref.id, ref.version)
    if (found && (!ref.digest || ref.digest === found.digest)) return found
  }
  fail('MISSING_PREREQUISITE', 'module snapshot 不存在或 digest 不匹配')
}

export function saveModuleVersion(store, definitionInput, ownerKey, { expectedVersion = null, createNew = false } = {}) {
  const definition = normalizeDefinition(definitionInput, { allowVersion: true })
  const contentDigest = digest(definition)
  const row = store.db.prepare('SELECT * FROM saker_test_module_versions WHERE owner_key=? AND module_id=? AND version=?')
    .get(ownerKey, definition.id, definition.version)
  if (row) {
    if (row.digest === contentDigest) return rowDefinition(row)
    fail('REVISION_CONFLICT', '同版本已存在不同定义')
  }
  if (expectedVersion !== null && Number(expectedVersion) !== definition.version)
    fail('MISSING_REVISION', 'expected definitionVersion 与提交版本不一致')
  if (!createNew) {
    const latest = store.db.prepare('SELECT MAX(version) AS version FROM saker_test_module_versions WHERE owner_key=? AND module_id=?')
      .get(ownerKey, definition.id)?.version
    if (latest && definition.version !== Number(latest) + 1)
      fail('REVISION_CONFLICT', '新版本必须是当前版本 + 1')
  }
  store.db.prepare('INSERT INTO saker_test_module_versions(owner_key,module_id,version,family,digest,definition_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(ownerKey, definition.id, definition.version, definition.family, contentDigest, JSON.stringify(definition), now())
  return { ...definition, digest: contentDigest, ownerKey }
}

function moduleRowsForOwner(store, ownerKey) {
  return store.db.prepare('SELECT * FROM saker_test_module_versions WHERE owner_key=? ORDER BY module_id,version DESC').all(ownerKey)
    .map(rowDefinition).filter(Boolean)
}

function latestByModule(definitions) {
  const map = new Map()
  for (const definition of definitions) {
    const current = map.get(definition.id)
    if (!current || definition.version > current.version) map.set(definition.id, definition)
  }
  return [...map.values()]
}

function archivedMap(store, ownerKeys) {
  const map = new Map()
  for (const owner of ownerKeys) {
    for (const row of store.db.prepare("SELECT * FROM saker_definition_state WHERE owner_key=? AND definition_kind='module'").all(owner)) {
      map.set(owner + '/' + row.definition_id, row)
    }
  }
  return map
}

function summary(definition, archived, capability = null) {
  return {
    moduleRef: { id: definition.id, version: definition.version, digest: definition.digest, ownerKey: definition.ownerKey },
    id: definition.id,
    title: definition.title,
    version: definition.version,
    digest: definition.digest,
    family: definition.family,
    familyLabel: FAMILY_LABEL.get(definition.family) || definition.family,
    categoryId: definition.categoryId,
    subcategoryId: definition.subcategoryId,
    userSummary: definition.userSummary,
    outputSummary: definition.outputSummary,
    operations: definition.operations,
    source: definition.source,
    archived: Boolean(archived),
    metadataRevision: Number(archived?.metadata_revision || 0),
    ...(capability ? {
      definitionStatus: capability.definitionStatus,
      adapterStatus: capability.adapterStatus,
      runtimeStatus: capability.runtimeStatus,
      statusLabel: capability.statusLabel,
      canExecute: capability.canExecute,
      capabilities: capability.capabilities,
      tools: capability.tools,
      missingPrerequisites: capability.missingPrerequisites,
    } : {}),
  }
}

export function listModuleDefinitions(store, { rootId = '', ownerKeys = null, filter = {}, page = {}, capabilityResolver = null } = {}) {
  const owners = ownerKeys || ['builtin', 'personal', rootId ? 'session:' + rootId : ''].filter(Boolean)
  let definitions = []
  for (const owner of owners) {
    if (owner === 'builtin') definitions.push(...BUILTIN.values())
    else definitions.push(...moduleRowsForOwner(store, owner))
  }
  definitions = latestByModule(definitions)
  const archived = archivedMap(store, owners)
  let rows = definitions.map(definition => ({
    definition,
    capability: capabilityResolver ? capabilityResolver(definition) : null,
  }))
  const text = String(filter.text || '').trim().toLowerCase()
  const category = String(filter.categoryId || '').trim()
  const subcategory = String(filter.subcategoryId || '').trim()
  const family = String(filter.family || '').trim()
  const source = String(filter.source || '').trim()
  const status = String(filter.status || '').trim()
  const toolRef = String(filter.toolRef || '').trim().toLowerCase()
  if (text) {
    rows = rows.filter(({ definition, capability }) => {
      const hay = [
        definition.id, definition.title, definition.userSummary, definition.outputSummary,
        ...(definition.searchAliases || []), ...(definition.operations || []),
        ...(capability?.tools || []),
        ...((capability?.capabilities || []).flatMap(item => [item.label, item.key, item.tool])),
        ...((capability?.missingPrerequisites || []).map(item => item.message)),
      ].join('\n').toLowerCase()
      return text.split(/\s+/).every(part => hay.includes(part))
    })
  }
  if (category) rows = rows.filter(({ definition }) => definition.categoryId === category)
  if (subcategory) rows = rows.filter(({ definition }) => definition.subcategoryId === subcategory)
  if (family) rows = rows.filter(({ definition }) => definition.family === family)
  if (source) rows = rows.filter(({ definition }) => definition.source === source)
  if (status) rows = rows.filter(({ capability }) => capability?.runtimeStatus === status)
  if (toolRef) rows = rows.filter(({ capability }) => (capability?.capabilities || []).some(item =>
    [item.key, item.label, item.tool, item.path].some(value => String(value || '').toLowerCase().includes(toolRef))))
  rows.sort((a, b) => a.definition.title.localeCompare(b.definition.title, 'zh-Hans-CN') || a.definition.id.localeCompare(b.definition.id))
  const facetCounts = { categories: {}, subcategories: {}, families: {} }
  for (const definition of latestByModule([...BUILTIN.values(), ...owners.filter(owner => owner !== 'builtin').flatMap(owner => moduleRowsForOwner(store, owner))])) {
    if (definition.categoryId) facetCounts.categories[definition.categoryId] = (facetCounts.categories[definition.categoryId] || 0) + 1
    if (definition.categoryId && definition.subcategoryId) {
      const key = definition.categoryId + '/' + definition.subcategoryId
      facetCounts.subcategories[key] = (facetCounts.subcategories[key] || 0) + 1
    }
    if (definition.family) facetCounts.families[definition.family] = (facetCounts.families[definition.family] || 0) + 1
  }
  const aliasIndex = {}
  for (const { definition, capability } of rows) {
    for (const alias of [definition.id, definition.title, ...(definition.searchAliases || []), ...(capability?.tools || [])]) {
      const key = String(alias || '').toLowerCase()
      if (!key) continue
      aliasIndex[key] = [...new Set([...(aliasIndex[key] || []), definition.id])].slice(0, 20)
    }
  }
  const limit = [20, 50, 100].includes(Number(page.limit)) ? Number(page.limit) : 20
  let offset = 0
  if (page.cursor) {
    try {
      const value = JSON.parse(Buffer.from(String(page.cursor), 'base64url').toString('utf8'))
      if (Number.isSafeInteger(value.offset) && value.offset >= 0) offset = value.offset
    } catch { offset = 0 }
  }
  const total = rows.length
  const slice = rows.slice(offset, offset + limit)
  const nextOffset = offset + slice.length
  return {
    items: slice.map(({ definition, capability }) => summary(definition, archived.get((definition.ownerKey || '') + '/' + definition.id), capability)),
    taxonomy: TAXONOMY,
    facetCounts,
    aliasIndex,
    page: {
      nextCursor: nextOffset < total ? Buffer.from(JSON.stringify({ offset: nextOffset })).toString('base64url') : null,
      hasMore: nextOffset < total,
      total,
      totalKnown: true,
    },
  }
}

export function detailModuleDefinition(store, { rootId = '', ref = {}, capabilityResolver = null } = {}) {
  if (String(ref.ownerKey || '').startsWith('session:') && ref.ownerKey !== 'session:' + rootId)
    fail('SCOPE_MISMATCH', '该模块草稿不属于当前任务')
  const owners = [String(ref.ownerKey || ''), rootId ? 'session:' + rootId : '', 'personal', 'builtin'].filter(Boolean)
  for (const owner of [...new Set(owners)]) {
    const found = readModuleDefinition(store, owner, ref.id, ref.version)
    if (found && (!ref.digest || found.digest === ref.digest)) {
      const archived = archivedMap(store, [owner]).get(owner + '/' + found.id)
      const capability = capabilityResolver ? capabilityResolver(found) : null
      return { ...summary(found, archived, capability), purpose: found.purpose, instructions: found.instructions,
        inputs: found.inputs, outputs: found.outputs, deliverable: found.deliverable,
        capabilityRequests: found.capabilityRequests, searchAliases: found.searchAliases }
    }
  }
  fail('MISSING_PREREQUISITE', 'module not found')
}

export function archiveModuleDefinition(store, { ownerKey, moduleId, reason = '' }) {
  const definition = readModuleDefinition(store, ownerKey, moduleId)
  if (!definition) fail('MISSING_PREREQUISITE', 'module not found')
  const revision = Number(store.db.prepare("SELECT metadata_revision FROM saker_definition_state WHERE owner_key=? AND definition_kind='module' AND definition_id=?")
    .get(ownerKey, moduleId)?.metadata_revision || 0) + 1
  store.db.prepare(`INSERT INTO saker_definition_state(owner_key,definition_kind,definition_id,archived_at,display_alias,metadata_revision,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_key,definition_kind,definition_id) DO UPDATE SET
    archived_at=excluded.archived_at, metadata_revision=excluded.metadata_revision, updated_at=excluded.updated_at`)
    .run(ownerKey, 'module', moduleId, now(), String(reason).slice(0, 240), revision, now())
  return { moduleRef: { id: moduleId, version: definition.version, digest: definition.digest, ownerKey }, archived: true, metadataRevision: revision }
}

export function readModulePreference(store, { hostSession = '', workspaceKey = '', projectKey = '' } = {}) {
  return store.db.prepare('SELECT * FROM saker_module_preferences WHERE host_session=? AND workspace_key=? AND project_key=?')
    .get(hostSession, workspaceKey, projectKey) || null
}

export function writeModulePreference(store, { hostSession = '', workspaceKey = '', projectKey = '', moduleSnapshotRef, operation = 'auto' }, { expectedRevision = null } = {}) {
  if (!hostSession) fail('MISSING_PREREQUISITE', '模块偏好需要真实 Host 会话')
  const current = readModulePreference(store, { hostSession, workspaceKey, projectKey })
  const revision = Number(current?.revision || 0)
  if (expectedRevision !== null && Number(expectedRevision) !== revision)
    fail('REVISION_CONFLICT', '模块偏好已被更新，请刷新后重试')
  const next = revision + 1
  store.db.prepare(`INSERT INTO saker_module_preferences(host_session,workspace_key,project_key,module_snapshot_ref,operation,apply_to,revision,state,bound_work_ref,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(host_session,workspace_key,project_key) DO UPDATE SET
    module_snapshot_ref=excluded.module_snapshot_ref, operation=excluded.operation, revision=excluded.revision,
    state=excluded.state, bound_work_ref=excluded.bound_work_ref, updated_at=excluded.updated_at`)
    .run(hostSession, workspaceKey, projectKey, JSON.stringify(moduleSnapshotRef || null), String(operation || 'auto').slice(0, 80),
      'next-work', next, 'pending', '', now())
  return { preferenceRevision: next, state: 'pending', moduleSnapshotRef, operation, applyTo: 'next-work' }
}

function invocationRow(store, rootId, invocationId) {
  const row = store.db.prepare('SELECT * FROM saker_module_invocations WHERE root_id=? AND invocation_id=?').get(rootId, invocationId)
  if (!row) return null
  return {
    ...row,
    inputRefs: safeJson(row.input_refs, []),
    capabilityBindings: safeJson(row.capability_bindings, {}),
    outputRefs: safeJson(row.output_refs, []),
    attemptRefs: safeJson(row.attempt_refs, []),
    usageRefs: safeJson(row.usage_refs, []),
    taskPack: safeJson(row.task_pack, {}),
  }
}

function safeJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

export function beginModuleInvocation(store, {
  rootId, generation, workId, executorRef, roleInstanceRef = '', moduleSnapshotRef, operation = 'auto',
  inputRefs = [], capabilityBindings = {}, policyRevision = 1, prerequisites = null,
}) {
  if (!rootId || !workId || !executorRef) fail('MISSING_PREREQUISITE', 'begin 需要 root/work/真实执行者')
  const definition = resolveModuleSnapshot(store, moduleSnapshotRef, rootId)
  const op = String(operation || 'auto')
  if (!definition.operations.includes('auto') && !definition.operations.includes(op))
    fail('INVALID_DEFINITION', 'operation 不在该模块声明的操作内')
  const missingPrerequisites = Array.isArray(prerequisites?.missingPrerequisites) ? prerequisites.missingPrerequisites : []
  const canExecute = prerequisites?.canExecute === undefined ? true : Boolean(prerequisites.canExecute)
  if (!canExecute) {
    return {
      invocationRef: null,
      moduleSnapshotRef: { id: definition.id, version: definition.version, digest: definition.digest, ownerKey: definition.ownerKey },
      operation: op,
      taskPack: {
        moduleRef: { id: definition.id, version: definition.version, digest: definition.digest, ownerKey: definition.ownerKey },
        title: definition.title,
        purpose: definition.purpose,
        instructions: definition.instructions,
        operation: op,
        inputs: definition.inputs,
        inputRefs,
        outputs: definition.outputs,
        deliverable: definition.deliverable,
      successCriterion: '补齐缺项后再开始；完成时必须按固定 outputs 合同提交结构化 artifact；验证结果另需关联真实 receipt/browser/competition 观察，不能用 work/finding 占位。',
        capabilityRequests: definition.capabilityRequests,
        capabilityBindings,
        identityAndTargetFromHost: true,
      },
      missingPrerequisites,
      canExecute: false,
    }
  }
  const active = store.db.prepare(`SELECT invocation_id FROM saker_module_invocations
    WHERE root_id=? AND generation=? AND work_id=? AND executor_ref=? AND state IN ('active','unknown')`)
    .get(rootId, Number(generation) || 1, workId, executorRef)
  if (active) fail('COMMAND_CONFLICT', '同一 work/执行者已有活动模块调用')
  const invocationId = 'module-invocation-' + randomUUID()
  const taskPack = {
    moduleRef: { id: definition.id, version: definition.version, digest: definition.digest, ownerKey: definition.ownerKey },
    title: definition.title,
    purpose: definition.purpose,
    instructions: definition.instructions,
    operation: op,
    inputs: definition.inputs,
    inputRefs,
    outputs: definition.outputs,
    deliverable: definition.deliverable,
    successCriterion: '按固定 outputs 合同产出结构化 artifact（kind/title/detail/sourceRefs）。analysis-complete 可基于本机分析或材料；verification-observed 还必须附带对应类型的真实 receipt/browser/competition 观察并在 sourceRefs 中关联。work/finding 只作上下文，不是完成产物；无材料时明确 blocked/unknown。',
    capabilityRequests: definition.capabilityRequests,
    capabilityBindings,
    identityAndTargetFromHost: true,
  }
  store.db.prepare(`INSERT INTO saker_module_invocations(root_id,invocation_id,generation,work_id,executor_ref,role_instance_ref,
    owner_key,module_id,module_version,module_digest,family,operation,input_refs,capability_bindings,policy_revision,revision,
    scope_epoch,state,outcome,output_refs,attempt_refs,usage_refs,task_pack,started_at,cleanup_state)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(rootId, invocationId, Number(generation) || 1, workId, executorRef, roleInstanceRef,
      definition.ownerKey, definition.id, definition.version, definition.digest, definition.family, op,
      JSON.stringify(inputRefs), JSON.stringify(capabilityBindings), Number(policyRevision) || 1, 1, 1,
      'active', '', '[]', '[]', '[]', JSON.stringify(taskPack), now(), 'clear')
  return {
    invocationRef: { id: invocationId, revision: 1, state: 'active' },
    moduleSnapshotRef: { id: definition.id, version: definition.version, digest: definition.digest, ownerKey: definition.ownerKey },
    operation: op,
    taskPack,
    missingPrerequisites,
    canExecute: true,
  }
}

function tableExists(store, name) {
  return !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

function descendantSessionIds(store, rootId) {
  const ids = new Set([String(rootId || '')])
  for (const table of ['role_instances', 'role_attempts', 'site_workers']) {
    if (!tableExists(store, table)) continue
    try {
      for (const row of store.db.prepare(`SELECT DISTINCT child_id FROM ${table} WHERE ${table === 'site_workers' ? 'parent_session' : 'session_id'}=?`).all(rootId)) {
        if (row.child_id) ids.add(String(row.child_id))
      }
    } catch { /* older schema */ }
  }
  ids.delete('')
  return [...ids]
}

function taskPolicyFor(store, rootId) {
  const row = store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(rootId)
  if (!row) return {}
  try { return JSON.parse(row.record) || {} } catch { return {} }
}

function invocationContext(store, row) {
  const work = readWorkItem(store, row.root_id, row.work_id) || {}
  const policy = taskPolicyFor(store, row.root_id)
  return {
    work,
    target: String(work.target || policy.primaryTarget || policy.target || ''),
    identity: String(work.identityRef || ''),
    startedAt: Number(row.started_at) || 0,
  }
}

function receiptRow(store, table, rootId, id) {
  const ids = descendantSessionIds(store, rootId)
  if (!ids.length) return null
  return store.db.prepare(`SELECT session_id,record FROM ${table} WHERE id=? AND session_id IN (${ids.map(() => '?').join(',')})`)
    .get(id, ...ids) || null
}

function referenceEvidence(kind, record, policy, context, id) {
  const integrity = record.integrityValid === true ? 'verified' : 'unknown'
  if (integrity !== 'verified')
    fail('EVIDENCE_INTEGRITY_UNKNOWN',
      `${kind === 'browser' ? '浏览器' : '执行'}回执 ${id} 完整性未知或校验失败；不能用“库存里存在”替代已验证观察。`
      + (record.currentReason ? `（${record.currentReason}）` : ''),
      { details: { id, kind, integrity, reason: record.currentReason || '' } })
  const completedAt = Date.parse(record.completedAt || '')
  if (!Number.isFinite(completedAt))
    fail('EVIDENCE_CONTRACT_UNSATISFIED', `${kind === 'browser' ? '浏览器' : '执行'}回执 ${id} 缺少可信采集时间`, { details: { id, kind } })
  const endpoint = kind === 'browser' ? record.url : record.endpoint
  if (context.target && !matchesTarget(endpoint, context.target))
    fail('EVIDENCE_TARGET_MISMATCH', `回执 ${id} 不属于当前工作目标 ${context.target}`, { details: { id, kind, endpoint, target: context.target } })
  const identity = kind === 'browser'
    ? String(record.identityRef || '')
    : executionIdentity(record)
  if (context.identity && identity !== context.identity)
    fail('EVIDENCE_IDENTITY_MISMATCH', `回执 ${id} 的身份是 ${identity || '（缺失）'}，不等于工作要求的 ${context.identity}`,
      { details: { id, kind, identity, targetIdentity: context.identity } })
  if (policy === 'fresh') {
    if (record.current !== true)
      fail('EVIDENCE_NOT_FRESH', `回执 ${id} 不是当前有效执行，不能作为本次 fresh 证据`,
        { details: { id, kind, policy, current: record.current === true } })
    if (kind === 'browser' ? record.executed !== true : record.outcome !== 'response')
      fail('EVIDENCE_CONTRACT_UNSATISFIED', `回执 ${id} 没有可验证的完整观察结果`, { details: { id, kind, outcome: record.outcome || '' } })
    if (!context.startedAt || completedAt < context.startedAt)
      fail('EVIDENCE_NOT_FRESH', `回执 ${id} 早于本次模块调用，不能冒充本次执行`,
        { details: { id, kind, completedAt: record.completedAt, startedAt: context.startedAt } })
  }
  return {
    status: 'verified',
    integrity,
    current: record.current === true,
    policy,
    endpoint,
    identity,
    completedAt: record.completedAt || '',
    outcome: kind === 'browser' ? record.executed === true ? 'executed' : 'observed' : record.outcome || '',
  }
}

function materialEvidence(store, rootId, id) {
  const row = tableExists(store, 'business_materials')
    ? store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(rootId, id)
    : null
  if (!row) fail('MISSING_PREREQUISITE', '产物引用不存在或不属于当前任务: material:' + id)
  let record
  try { record = JSON.parse(row.record) } catch { fail('MISSING_PREREQUISITE', '材料记录损坏: ' + id) }
  let bytes = 0
  let digestValue = ''
  if (record.file) {
    try {
      const content = readFileSync(record.file)
      bytes = content.length
      digestValue = createHash('sha256').update(content).digest('hex')
    } catch {
      fail('MISSING_PREREQUISITE', '材料原件不存在或无法读取: ' + id)
    }
  } else if (typeof record.text === 'string') {
    bytes = Buffer.byteLength(record.text, 'utf8')
    digestValue = createHash('sha256').update(record.text, 'utf8').digest('hex')
  }
  if (!bytes) fail('EVIDENCE_CONTRACT_UNSATISFIED', '材料正文为空，不能作为产物或来源: ' + id)
  if (record.digest && digestValue && record.digest !== digestValue)
    fail('EVIDENCE_INTEGRITY_UNKNOWN', '材料摘要与当前原件不一致: ' + id,
      { details: { id, expected: record.digest, actual: digestValue } })
  return { status: 'present', bytes, digest: digestValue || String(record.digest || '') }
}

function competitionEvidence(store, row, ref, policy, context, id) {
  const challengeId = String(ref.challengeId || ref.context?.challengeId || '').trim()
  if (!challengeId) fail('MISSING_PREREQUISITE', 'competition 产物引用需要 challengeId')
  const record = readCompetitionExecution(store, row.root_id, challengeId, id)
  if (!record) fail('MISSING_PREREQUISITE', 'competition 执行记录不存在或不属于当前任务: ' + id)
  if (String(record.sessionId || '') !== String(row.root_id))
    fail('SCOPE_MISMATCH', 'competition 执行记录不属于当前任务: ' + id)
  const challenge = readCompetitionChallenge(store, row.root_id, challengeId)
  if (!challenge) fail('MISSING_PREREQUISITE', 'competition 题面不存在: ' + challengeId)
  if (record.timedOut === true) fail('EVIDENCE_CONTRACT_UNSATISFIED', 'competition 执行超时，不能作为完成观察: ' + id)
  if (record.signal !== null && record.signal !== undefined)
    fail('EVIDENCE_CONTRACT_UNSATISFIED', 'competition 执行收到信号，不能作为成功完成: ' + id,
      { details: { executionId: id, signal: record.signal } })
  if (record.state !== 'completed'
    || typeof record.exitCode !== 'number'
    || !Number.isSafeInteger(record.exitCode)
    || record.exitCode !== 0)
    fail('EVIDENCE_CONTRACT_UNSATISFIED',
      `competition 执行 ${id} 状态=${record.state}, exitCode=${record.exitCode ?? 'unknown'}；验证完成需要 completed/0`,
      { details: { executionId: id, state: record.state, exitCode: record.exitCode ?? null } })
  if (!['host', 'docker'].includes(String(record.environment || '')))
    fail('EVIDENCE_CONTRACT_UNSATISFIED', 'competition 执行环境未知，不能作为完成观察: ' + id,
      { details: { executionId: id, environment: record.environment || null } })
  const anchors = record.outputAnchors
  const revision = Number(record.outputRevision)
  if (!anchors || !Number.isSafeInteger(revision) || revision < 1 || Number(anchors.revision) !== revision)
    fail('EVIDENCE_INTEGRITY_UNKNOWN', 'competition 执行缺少匹配的输出锚点 revision: ' + id,
      { details: { executionId: id, outputRevision: record.outputRevision ?? null, anchorRevision: anchors?.revision ?? null } })
  for (const stream of ['stdout', 'stderr']) {
    const anchor = anchors[stream]
    if (!anchor || !Number.isSafeInteger(Number(anchor.bytes)) || Number(anchor.bytes) < 0
      || !/^[0-9a-f]{64}$/i.test(String(anchor.sha256 || '')))
      fail('EVIDENCE_INTEGRITY_UNKNOWN', `competition ${stream} 缺少字节数/SHA256 锚点: ` + id,
        { details: { executionId: id, stream } })
  }
  if (anchors.environment !== undefined && String(anchors.environment) !== String(record.environment))
    fail('EVIDENCE_INTEGRITY_UNKNOWN', 'competition 输出锚点环境与执行记录不一致: ' + id)
  if (anchors.executorPid !== undefined && anchors.executorPid !== null && record.pid !== undefined
    && record.pid !== null && Number(anchors.executorPid) !== Number(record.pid))
    fail('EVIDENCE_INTEGRITY_UNKNOWN', 'competition 输出锚点执行器与执行记录不一致: ' + id)
  const endedAt = Date.parse(record.endedAt || '')
  if (!Number.isFinite(endedAt))
    fail('EVIDENCE_CONTRACT_UNSATISFIED', 'competition 执行缺少结束时间: ' + id)
  if (policy === 'fresh' && (!context.startedAt || endedAt < context.startedAt))
    fail('EVIDENCE_NOT_FRESH', 'competition 执行早于本次模块调用，不能冒充本次 fresh 观察',
      { details: { executionId: id, endedAt: record.endedAt, startedAt: context.startedAt } })
  const expectedRoot = challengeRoot(row.root_id, challengeId)
  const expectedWork = join(expectedRoot, 'work')
  const expectedOutput = join(expectedRoot, 'output')
  if (String(record.workDir || '') !== expectedWork)
    fail('EVIDENCE_TARGET_MISMATCH', 'competition 执行工作目录不属于该题目的受管工作区',
      { details: { executionId: id, workDir: record.workDir || '', expectedWork } })
  if (resolve(String(record.outputDir || '')) !== resolve(expectedOutput))
    fail('EVIDENCE_TARGET_MISMATCH', 'competition 输出目录不属于该题目的受管输出区',
      { details: { executionId: id, outputDir: record.outputDir || '', expectedOutput } })
  if (record.environment === 'docker' && !/^saker-competition-execution-/.test(String(record.containerName || '')))
    fail('EVIDENCE_CONTRACT_UNSATISFIED', 'competition Docker 执行缺少受管容器身份: ' + id)
  let stdoutBytes, stderrBytes, stdoutDigest, stderrDigest
  try {
    const realOutput = realpathSync(expectedOutput)
    const managedFile = file => {
      const target = realpathSync(String(file || ''))
      const rel = relative(realOutput, target)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('output escapes managed directory')
      if (!statSync(target).isFile()) throw new Error('output is not a regular file')
      return target
    }
    stdoutBytes = readFileSync(managedFile(record.stdoutFile))
    stderrBytes = readFileSync(managedFile(record.stderrFile))
    stdoutDigest = createHash('sha256').update(stdoutBytes).digest('hex')
    stderrDigest = createHash('sha256').update(stderrBytes).digest('hex')
  } catch {
    fail('MISSING_PREREQUISITE', 'competition 原始输出文件不可读: ' + id)
  }
  if (stdoutBytes.length !== Number(anchors.stdout.bytes)
    || stderrBytes.length !== Number(anchors.stderr.bytes)
    || stdoutDigest !== String(anchors.stdout.sha256).toLowerCase()
    || stderrDigest !== String(anchors.stderr.sha256).toLowerCase())
    fail('EVIDENCE_INTEGRITY_FAILED', 'competition 原始输出与执行完成时的锚点不一致: ' + id,
      { details: {
        executionId: id,
        expected: { stdout: anchors.stdout, stderr: anchors.stderr },
        actual: {
          stdout: { bytes: stdoutBytes.length, sha256: stdoutDigest },
          stderr: { bytes: stderrBytes.length, sha256: stderrDigest },
        },
      } })
  const instanceUrl = String(challenge.instance?.url || '')
  if (context.target && instanceUrl && /^https?:/i.test(context.target)
    && !matchesTarget(instanceUrl, context.target))
    fail('EVIDENCE_TARGET_MISMATCH', 'competition 题面实例不属于当前工作目标: ' + instanceUrl,
      { details: { executionId: id, instanceUrl, target: context.target } })
  return {
    status: 'verified',
    integrity: 'verified',
    current: true,
    policy,
    source: 'competition-execution',
    challengeId,
    environment: record.environment || 'host',
    command: String(record.command || ''),
    workDir: record.workDir,
    containerName: record.containerName || '',
    pid: record.pid || null,
    exitCode: record.exitCode,
    completedAt: record.endedAt,
    outputRevision: revision,
    stdout: { bytes: stdoutBytes.length, sha256: stdoutDigest },
    stderr: { bytes: stderrBytes.length, sha256: stderrDigest },
  }
}

function normalizeArtifactSourceRefs(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 50) fail('INVALID_DEFINITION', 'artifact.sourceRefs 必须是数组（最多 50 条）')
  const seen = new Set()
  return value.map((ref, index) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref))
      fail('INVALID_DEFINITION', `artifact.sourceRefs[${index}] 必须是对象`)
    const kind = String(ref.kind || '').trim().slice(0, 40)
    const id = String(ref.id || '').trim().slice(0, 200)
    if (!kind || !id) fail('INVALID_DEFINITION', `artifact.sourceRefs[${index}] 需要 kind/id`)
    const key = kind + ':' + id
    if (seen.has(key)) fail('INVALID_DEFINITION', 'artifact.sourceRefs 重复: ' + key)
    seen.add(key)
    return { kind, id }
  })
}

function artifactRef(store, row, raw, knownSourceKeys) {
  const source = raw?.artifact && typeof raw.artifact === 'object' ? raw.artifact : raw
  if (!source || typeof source !== 'object' || Array.isArray(source))
    fail('INVALID_DEFINITION', 'artifact 产物必须包含 artifact 对象')
  const kind = String(source.kind || '').trim()
  const title = String(source.title || '').trim()
  const detail = String(source.detail || '').trim()
  if (!ARTIFACT_KINDS.includes(kind)) fail('INVALID_DEFINITION', `artifact.kind 必须是 ${ARTIFACT_KINDS.join('/')}`)
  if (!title || title.length > 160) fail('INVALID_DEFINITION', 'artifact.title 必须是 1–160 字')
  if (!detail || detail.length > 4000) fail('INVALID_DEFINITION', 'artifact.detail 必须是 1–4000 字')
  const sourceRefs = normalizeArtifactSourceRefs(source.sourceRefs)
  for (const ref of sourceRefs) {
    const key = ref.kind + ':' + ref.id
    if (!knownSourceKeys.has(key))
      fail('EVIDENCE_CONTRACT_UNSATISFIED', `artifact 引用了未校验的来源: ${key}`,
        { details: { sourceRef: ref, allowed: [...knownSourceKeys] } })
  }
  const normalized = { kind, title, detail, sourceRefs }
  const artifactDigest = digest(normalized)
  return {
    kind: 'artifact',
    id: 'artifact-' + artifactDigest.slice(0, 24),
    reference: { status: 'valid', rootId: row.root_id },
    artifact: { ...normalized, digest: artifactDigest },
  }
}

function validateOutputRefs(store, row, outputRefs, contract) {
  if (!Array.isArray(outputRefs) || outputRefs.length > 50)
    fail('INVALID_DEFINITION', '产物引用必须是 0–50 条数组')
  const seen = new Set()
  const context = invocationContext(store, row)
  const inputRefs = Array.isArray(row.inputRefs) ? row.inputRefs : safeJson(row.input_refs, [])
  const knownSourceKeys = new Set(inputRefs
    .filter(ref => ref && typeof ref === 'object')
    .map(ref => String(ref.kind || '') + ':' + String(ref.id || ''))
    .filter(key => !key.endsWith(':')))
  const validated = []
  for (const ref of outputRefs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref))
      fail('MISSING_PREREQUISITE', '产物引用必须是对象')
    const kind = String(ref.kind || '').trim()
    if (kind === 'artifact') continue
    const id = String(ref.id || '').trim()
    if (!kind || !id) fail('MISSING_PREREQUISITE', '产物引用必须包含 kind 和 id')
    const key = kind + ':' + id
    if (seen.has(key)) fail('INVALID_DEFINITION', '产物引用重复: ' + key)
    seen.add(key)
    let found
    if (kind === 'receipt') {
      const rowReceipt = receiptRow(store, 'execution_receipts', row.root_id, id)
      if (!rowReceipt) fail('MISSING_PREREQUISITE', '产物引用不存在或不属于当前任务: ' + key)
      let record
      try { record = readExecutionReceipt(store, rowReceipt.session_id, id) }
      catch (error) { fail('MISSING_PREREQUISITE', '回执不可读: ' + id + '；' + error.message) }
      found = {
        reference: { status: 'valid', rootId: rowReceipt.session_id, revision: record.requestRevision || record.completedAt || '' },
        observation: referenceEvidence(kind, record, contract.evidencePolicy, context, id),
      }
    } else if (kind === 'browser') {
      const rowReceipt = receiptRow(store, 'browser_receipts', row.root_id, id)
      if (!rowReceipt) fail('MISSING_PREREQUISITE', '产物引用不存在或不属于当前任务: ' + key)
      let record
      try { record = readBrowserReceipt(store, rowReceipt.session_id, id) }
      catch (error) { fail('MISSING_PREREQUISITE', '浏览器回执不可读: ' + id + '；' + error.message) }
      found = {
        reference: { status: 'valid', rootId: rowReceipt.session_id, revision: record.completedAt || '' },
        observation: referenceEvidence(kind, record, contract.evidencePolicy, context, id),
      }
    } else if (kind === 'competition') {
      const evidence = competitionEvidence(store, row, ref, contract.evidencePolicy, context, id)
      found = {
        reference: { status: 'valid', rootId: row.root_id, revision: evidence.completedAt },
        observation: evidence,
      }
    } else if (kind === 'material' && tableExists(store, 'business_materials')) {
      const evidence = materialEvidence(store, row.root_id, id)
      found = { reference: { status: 'valid', rootId: row.root_id, revision: evidence.digest }, material: evidence }
    } else if (kind === 'finding') {
      const finding = store.db.prepare('SELECT id,status,updated_at FROM findings WHERE session_id=? AND id=?').get(row.root_id, id)
      if (finding) found = { reference: { status: 'valid', rootId: row.root_id, revision: finding.updated_at || '' },
        dependency: { kind: 'finding', id, state: finding.status || '', revision: finding.updated_at || '' } }
    } else if (kind === 'work' && tableExists(store, 'role_work_items')) {
      const work = readWorkItem(store, row.root_id, id)
      if (work) found = { reference: { status: 'valid', rootId: row.root_id, revision: work.updatedAt || '' },
        dependency: { kind: 'work', id, state: work.state || '', revision: work.revision || 0 } }
    } else {
      fail('MISSING_PREREQUISITE', '不支持的产物类型: ' + kind + '；请使用 artifact/receipt/browser/competition/material/finding/work')
    }
    if (!found) fail('MISSING_PREREQUISITE', '产物引用不存在或不属于当前任务: ' + key)
    knownSourceKeys.add(key)
    validated.push({ kind, id, ...found })
  }
  // Artifacts are normalized after their external sources so sourceRefs can be checked.
  const external = validated.filter(item => item.kind !== 'artifact')
  const artifactInputs = outputRefs.filter(ref => String(ref?.kind || '') === 'artifact')
  const artifacts = artifactInputs.map(ref => {
    const item = artifactRef(store, row, ref, knownSourceKeys)
    const key = 'artifact:' + item.id
    if (seen.has(key)) fail('INVALID_DEFINITION', '产物引用重复: ' + key)
    seen.add(key)
    return item
  })
  return [...external, ...artifacts]
}

function contractFailure(contract, missing) {
  const allowed = {
    outcome: contract.terminalOutcomes,
    evidencePolicy: contract.evidencePolicy,
    observationRefs: contract.evidencePolicy === 'none' ? [] : ['receipt', 'browser', 'competition'],
    minObservations: contract.minObservations,
    artifactRefs: [{ kind: 'artifact', artifactKinds: contract.artifactKinds,
      sourceRefs: ['receipt', 'browser', 'material', 'finding', 'work'] }],
    supportingRefs: contract.supportKinds,
  }
  fail('OUTPUT_CONTRACT_UNSATISFIED',
    '模块产物合同未满足：' + missing.join('；')
    + '。允许的引用方式：' + JSON.stringify(allowed),
    { details: { missing, allowed, outputKind: contract.kind } })
}

function validateTerminalContract(store, row, outcome, outputRefs, contract) {
  if (!contract.terminalOutcomes.includes(outcome))
    fail('OUTCOME_NOT_ALLOWED',
      `模块 ${row.module_id} 的固定版本不接受 outcome=${outcome}；允许 ${contract.terminalOutcomes.join('/')}`,
      { details: { outputKind: contract.kind, allowedOutcomes: contract.terminalOutcomes } })
  const refs = validateOutputRefs(store, row, outputRefs, contract)
  const artifacts = refs.filter(item => item.kind === 'artifact'
    && contract.artifactKinds.includes(item.artifact.kind))
  const observations = refs.filter(item => ['receipt', 'browser', 'competition'].includes(item.kind))
  const supports = refs.filter(item => ['work', 'finding', 'material'].includes(item.kind))
  const missing = []
  if (!artifacts.length) missing.push(`至少一条结构化 artifact（kind=${contract.artifactKinds.join('/')}）`)
  if (contract.supportKinds.length && !contract.supportKinds.every(kind => supports.some(item => item.kind === kind)))
    missing.push(`至少一条支持引用（${contract.supportKinds.join('/')}）`)
  if (outcome === 'verification-observed') {
    if (observations.length < contract.minObservations)
      missing.push(`至少 ${contract.minObservations} 条 receipt/browser 真实观察`)
    if (contract.distinctIdentities) {
      const identities = new Set(observations.map(item => String(item.observation?.identity || '').trim()).filter(Boolean))
      if (identities.size < contract.minObservations)
        missing.push(`至少 ${contract.minObservations} 个不同身份的实际观察`)
    }
    const linked = artifacts.some(artifact => {
      const sourceKeys = new Set((artifact.artifact.sourceRefs || []).map(ref => ref.kind + ':' + ref.id))
      return observations.filter(item => sourceKeys.has(item.kind + ':' + item.id)).length >= contract.minObservations
    })
    if (!linked) missing.push('结构化 artifact 的 sourceRefs 必须关联这些真实观察')
  }
  if (missing.length) contractFailure(contract, missing)
  return {
    outputRefs: refs,
    validation: {
      contract: {
        moduleId: row.module_id,
        outputKind: contract.kind,
        outcome,
        evidencePolicy: contract.evidencePolicy,
        minObservations: contract.minObservations,
        distinctIdentities: contract.distinctIdentities,
        artifactKinds: contract.artifactKinds,
      },
      referenceStatus: 'valid',
      productStatus: 'satisfied',
      observationStatus: outcome === 'verification-observed' ? 'verified' : 'not-required',
      findingStatus: 'not-assessed',
    },
  }
}

export function finishModuleInvocation(store, { rootId, invocationRef, outcome, outputRefs = [] }) {
  const row = invocationRow(store, rootId, String(invocationRef?.id || ''))
  if (!row) fail('MISSING_PREREQUISITE', 'module invocation not found')
  if (Number(invocationRef?.revision) !== row.revision) fail('REVISION_CONFLICT', 'invocation revision 已变化')
  if (['completed', 'cancelled'].includes(row.state)) fail('RUN_STOPPED', '该调用已结束')
  const terminal = TERMINAL_OUTCOMES.includes(outcome)
  const state = terminal ? 'completed' : outcome === 'blocked' ? 'blocked' : 'unknown'
  const fixedOutput = (row.taskPack.outputs || [])[0] || {}
  const contract = outputContract(fixedOutput.kind || row.module_id, fixedOutput)
  let validated
  if (terminal) {
    validated = validateTerminalContract(store, row, outcome, outputRefs, contract)
  } else {
    const refs = Array.isArray(outputRefs) && outputRefs.length
      ? validateOutputRefs(store, row, outputRefs, { ...contract, evidencePolicy: 'reuse' })
      : []
    validated = {
      outputRefs: refs,
      validation: {
        contract: { moduleId: row.module_id, outputKind: contract.kind, outcome: String(outcome || '') },
        referenceStatus: 'valid',
        productStatus: 'not-claimed',
        observationStatus: 'not-claimed',
        findingStatus: 'not-assessed',
      },
    }
  }
  const revision = row.revision + 1
  store.db.prepare(`UPDATE saker_module_invocations SET state=?, outcome=?, output_refs=?, revision=?, ended_at=?, cleanup_state=? WHERE root_id=? AND invocation_id=?`)
    .run(state, String(outcome || ''), JSON.stringify(validated.outputRefs), revision, now(), terminal ? 'clear' : 'pending', rootId, row.invocation_id)
  if (terminal && row.work_id) {
    const work = readWorkItem(store, rootId, row.work_id)
    const otherActive = store.db.prepare(`SELECT COUNT(*) AS n FROM saker_module_invocations
      WHERE root_id=? AND work_id=? AND invocation_id<>? AND state IN ('active','unknown')`)
      .get(rootId, row.work_id, row.invocation_id)?.n || 0
    if (work && !['completed', 'stopped', 'released', 'cleanup-failed'].includes(work.state)
      && Number(otherActive) === 0) {
      updateWorkItem(store, rootId, row.work_id, {
        expectedRevision: work.revision,
        state: 'completed',
        executionState: 'completed',
        reportState: 'completed',
      }, 'module-completed')
    }
  }
  return {
    invocationRef: { id: row.invocation_id, revision, state },
    outcome,
    outputRefs: validated.outputRefs,
    validation: validated.validation,
  }
}

export function cancelModuleInvocation(store, { rootId, invocationRef, reason = '' }) {
  const row = invocationRow(store, rootId, String(invocationRef?.id || ''))
  if (!row) fail('MISSING_PREREQUISITE', 'module invocation not found')
  if (Number(invocationRef?.revision) !== row.revision) fail('REVISION_CONFLICT', 'invocation revision 已变化')
  if (['completed', 'cancelled'].includes(row.state)) fail('RUN_STOPPED', '该调用已结束')
  const revision = row.revision + 1
  store.db.prepare(`UPDATE saker_module_invocations SET state='cancelled', outcome=?, revision=?, scope_epoch=scope_epoch+1, ended_at=?, cleanup_state='clear' WHERE root_id=? AND invocation_id=?`)
    .run(String(reason || 'cancelled').slice(0, 500), revision, now(), rootId, row.invocation_id)
  return { invocationRef: { id: row.invocation_id, revision, state: 'cancelled' }, reason }
}

export function listModuleInvocations(store, { rootId = '', filter = {}, page = {} } = {}) {
  let rows = store.db.prepare('SELECT * FROM saker_module_invocations WHERE root_id=? ORDER BY COALESCE(started_at,0) DESC, invocation_id DESC').all(rootId)
  const state = String(filter.state || '')
  if (state) rows = rows.filter(row => row.state === state)
  const moduleId = String(filter.moduleId || '')
  if (moduleId) rows = rows.filter(row => row.module_id === moduleId)
  const workId = String(filter.workId || '')
  if (workId) rows = rows.filter(row => row.work_id === workId)
  const limit = [20, 50, 100].includes(Number(page.limit)) ? Number(page.limit) : 20
  let offset = 0
  if (page.cursor) {
    try {
      const value = JSON.parse(Buffer.from(String(page.cursor), 'base64url').toString('utf8'))
      if (Number.isSafeInteger(value.offset) && value.offset >= 0) offset = value.offset
    } catch { offset = 0 }
  }
  const total = rows.length
  const slice = rows.slice(offset, offset + limit)
  const nextOffset = offset + slice.length
  return {
    items: slice.map(row => ({
      invocationRef: { id: row.invocation_id, revision: row.revision, state: row.state },
      moduleRef: { id: row.module_id, version: row.module_version, digest: row.module_digest, ownerKey: row.owner_key },
      workId: row.work_id,
      executorRef: row.executor_ref,
      roleInstanceRef: row.role_instance_ref,
      operation: row.operation,
      state: row.state,
      outcome: row.outcome,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      outputRefs: safeJson(row.output_refs, []),
    })),
    page: {
      nextCursor: nextOffset < total ? Buffer.from(JSON.stringify({ offset: nextOffset })).toString('base64url') : null,
      hasMore: nextOffset < total,
      total,
      totalKnown: true,
    },
  }
}

export function detailModuleInvocation(store, rootId, invocationId) {
  const row = invocationRow(store, rootId, String(invocationId || ''))
  if (!row) fail('MISSING_PREREQUISITE', 'module invocation not found')
  return row
}

export function defineModuleDraft(store, ownerKey, body = {}) {
  const definition = normalizeDefinition({ ...body, version: 1 }, { allowVersion: true })
  return saveModuleVersion(store, definition, ownerKey, { createNew: true })
}

export function reviseModuleDraft(store, ownerKey, { baseSnapshotRef, changes = {}, reason = '' } = {}) {
  const rootId = String(ownerKey).startsWith('session:') ? String(ownerKey).slice(8) : ''
  const base = resolveModuleSnapshot(store, baseSnapshotRef, rootId)
  const next = normalizeDefinition({ ...base, ...changes, id: base.id, version: base.version + 1 }, { allowVersion: true })
  const saved = saveModuleVersion(store, next, ownerKey, { createNew: true })
  return { ...saved, base: { id: base.id, version: base.version, digest: base.digest }, reason: String(reason).slice(0, 500) }
}

export function saveModulePersonal(store, { moduleSnapshotRef, name = '', previousVersion = null, ownerKey = 'personal', rootId = '' } = {}) {
  const source = resolveModuleSnapshot(store, moduleSnapshotRef, rootId)
  const id = name ? String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) : source.id
  const definition = { ...source, id: id || source.id, source: 'personal', version: previousVersion ? Number(previousVersion) : 1 }
  return saveModuleVersion(store, definition, ownerKey, { createNew: Boolean(previousVersion) })
}
