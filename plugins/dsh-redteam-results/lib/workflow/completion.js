import { readBrowserReceipt } from '../browser-execution.js'
import { readExecutionReceipt } from '../execution-receipts.js'

export const ARTIFACT_KINDS = Object.freeze([
  'observation',
  'analysis',
  'coverage',
  'gap',
  'answer',
  'material',
])

const bounded = (value, maximum) => String(value || '').trim().slice(0, maximum)

export function normalizeArtifacts(input) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('artifacts must be an array')
  if (input.length > 20) throw new Error('at most 20 artifacts are allowed')
  return input.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
      throw new Error(`artifact ${index + 1} must be an object`)
    const kind = bounded(artifact.kind, 32)
    const title = bounded(artifact.title, 160)
    const detail = bounded(artifact.detail, 4000)
    if (!ARTIFACT_KINDS.includes(kind))
      throw new Error(`artifact ${index + 1} kind must be ${ARTIFACT_KINDS.join('/')}`)
    if (!title) throw new Error(`artifact ${index + 1} title is required`)
    if (!detail) throw new Error(`artifact ${index + 1} detail is required`)
    return { kind, title, detail }
  })
}

export function normalizeEvidenceRefs(input) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('evidenceRefs must be an array of {kind,id}')
  if (input.length > 20) throw new Error('at most 20 evidence references are allowed')
  const seen = new Set()
  return input.map((reference, index) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference))
      throw new Error(`evidenceRefs[${index}] must be {kind,id}; arbitrary strings are not receipts`)
    const kind = bounded(reference.kind, 32)
    const id = bounded(reference.id, 200)
    if (!['execution', 'browser'].includes(kind))
      throw new Error(`evidenceRefs[${index}].kind must be execution or browser`)
    if (!id) throw new Error(`evidenceRefs[${index}].id is required`)
    const key = kind + ':' + id
    if (seen.has(key)) throw new Error(`duplicate evidence reference: ${key}`)
    seen.add(key)
    return { kind, id }
  })
}

function targetUrl(value) {
  const raw = bounded(value, 2000)
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed : null
  } catch {
    if (/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+\.[a-z]{2,})(?::\d+)?$/i.test(raw))
      return { host: raw.toLowerCase(), origin: null, pathname: '/' }
    return null
  }
}

export function matchesTarget(receiptUrl, runTarget) {
  const expected = targetUrl(runTarget)
  if (!expected) return false
  let observed
  try { observed = new URL(receiptUrl) } catch { return false }
  if (!['http:', 'https:'].includes(observed.protocol)) return false
  if (expected.origin) {
    const pathMatches = expected.pathname === '/' || observed.pathname === expected.pathname
      || observed.pathname.startsWith(expected.pathname.replace(/\/$/, '') + '/')
    return observed.origin === expected.origin && pathMatches
  }
  return observed.host.toLowerCase() === expected.host
}

function finiteTime(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function executionIdentity(receipt) {
  if (receipt.identitySource === 'request-material' && receipt.identityBound !== true)
    return 'request-material'
  return bounded(receipt.authContext || receipt.identity?.name || receipt.selectedIdentityRef, 200)
}

function validateReference(store, sessionId, run, node, reference) {
  const policy = node.evidencePolicy === 'reuse' ? 'reuse' : 'fresh'
  const runCreatedAt = Number(run.created_at ?? run.createdAt ?? 0)
  const expectedIdentity = bounded(node.identityRef, 200)
  if (reference.kind === 'execution') {
    let receipt
    try { receipt = readExecutionReceipt(store, sessionId, reference.id) }
    catch (error) { return { ok: false, error: `执行回执不存在或不可读：${error.message}` } }
    if (receipt.integrityValid !== true)
      return { ok: false, error: `执行回执 ${reference.id} 完整性校验失败` }
    if (policy === 'fresh' && receipt.current !== true)
      return { ok: false, error: `执行回执 ${reference.id} 已过期或与当前请求修订不符` }
    if (policy === 'fresh' && receipt.outcome !== 'response')
      return { ok: false, error: `执行回执 ${reference.id} 的 outcome=${receipt.outcome}，不能作为完成证据` }
    if (!matchesTarget(receipt.endpoint, run.target))
      return { ok: false, error: `执行回执 ${reference.id} 不属于当前目标 ${run.target || '（未填写）'}` }
    const completedAt = finiteTime(receipt.completedAt)
    if (completedAt === null)
      return { ok: false, error: `执行回执 ${reference.id} 缺少可信采集时间` }
    if (policy === 'fresh' && (!runCreatedAt || completedAt < runCreatedAt))
      return { ok: false, error: `执行回执 ${reference.id} 早于本次运行创建时间，不能冒充本次新执行` }
    if (policy === 'fresh' && completedAt > Date.now() + 60000)
      return { ok: false, error: `执行回执 ${reference.id} 的采集时间在未来，不能作为本次证据` }
    const identity = executionIdentity(receipt)
    if (expectedIdentity && identity !== expectedIdentity)
      return { ok: false, error: `执行回执 ${reference.id} 的身份是 ${identity || '（缺失）'}，不等于要求的 ${expectedIdentity}` }
    return { ok: true, binding: { kind: 'execution', id: reference.id,
      generation: policy, fresh: policy === 'fresh', endpoint: receipt.endpoint,
      identity, completedAt: receipt.completedAt || '', outcome: receipt.outcome || '' } }
  }
  let receipt
  try { receipt = readBrowserReceipt(store, sessionId, reference.id) }
  catch (error) { return { ok: false, error: `浏览器回执不存在或不可读：${error.message}` } }
  if (receipt.integrityValid !== true)
    return { ok: false, error: `浏览器回执 ${reference.id} 完整性校验失败` }
  if (receipt.source !== 'host-browser-execution')
    return { ok: false, error: `浏览器回执 ${reference.id} 不是宿主浏览器执行记录` }
  if (policy === 'fresh' && receipt.executed !== true)
    return { ok: false, error: `浏览器回执 ${reference.id} 没有可验证的执行现象` }
  if (!matchesTarget(receipt.url, run.target))
    return { ok: false, error: `浏览器回执 ${reference.id} 不属于当前目标 ${run.target || '（未填写）'}` }
  const completedAt = finiteTime(receipt.completedAt)
  if (completedAt === null)
    return { ok: false, error: `浏览器回执 ${reference.id} 缺少可信采集时间` }
  if (policy === 'fresh' && (!runCreatedAt || completedAt < runCreatedAt))
    return { ok: false, error: `浏览器回执 ${reference.id} 早于本次运行创建时间，不能冒充本次新执行` }
  if (policy === 'fresh' && completedAt > Date.now() + 60000)
    return { ok: false, error: `浏览器回执 ${reference.id} 的采集时间在未来，不能作为本次证据` }
  const identity = bounded(receipt.identityRef, 200)
  if (expectedIdentity && identity !== expectedIdentity)
    return { ok: false, error: `浏览器回执 ${reference.id} 的身份是 ${identity || '（缺失）'}，不等于要求的 ${expectedIdentity}` }
  return { ok: true, binding: { kind: 'browser', id: reference.id,
    generation: policy, fresh: policy === 'fresh', endpoint: receipt.url,
    identity, completedAt: receipt.completedAt || '', outcome: receipt.executed === true ? 'executed' : 'observed' } }
}

export function validateStepCompletion(store, sessionId, run, node, {
  status = 'done',
  note = '',
  artifacts = [],
  evidenceRefs = [],
} = {}) {
  const normalizedArtifacts = normalizeArtifacts(artifacts)
  const normalizedRefs = normalizeEvidenceRefs(evidenceRefs)
  const policy = node.evidencePolicy === 'reuse' ? 'reuse'
    : node.evidencePolicy === 'fresh' ? 'fresh' : 'none'
  if (status !== 'done') {
    if (!bounded(note, 2000)) throw new Error(`${status} step requires a note explaining the blocker or unknown result`)
    return { artifacts: normalizedArtifacts, evidenceRefs: normalizedRefs, bindings: [] }
  }
  if (policy === 'none' && normalizedRefs.length)
    throw new Error(`步骤“${node.title}”未允许引用回执；如要复用历史证据，请把证据条件设为“可复用历史材料”`)
  const bindings = []
  for (const reference of normalizedRefs) {
    const checked = validateReference(store, sessionId, run, node, reference)
    if (!checked.ok) throw new Error(checked.error)
    bindings.push(checked.binding)
  }
  if (policy === 'fresh' && bindings.length === 0)
    throw new Error(`步骤“${node.title}”要求本次新执行回执；请提交 evidenceRefs=[{kind:"execution"|"browser",id:"..."}]`)
  if (policy === 'reuse' && bindings.length === 0)
    throw new Error(`步骤“${node.title}”要求引用可追溯的历史回执`)
  if (policy === 'none' && normalizedArtifacts.length === 0)
    throw new Error(`步骤“${node.title}”需要至少一条结构化材料（kind/title/detail）`)
  return { artifacts: normalizedArtifacts, evidenceRefs: normalizedRefs, bindings }
}

export function completionPrompt(node) {
  const identity = node?.identityRef ? `；身份必须是 ${node.identityRef}` : ''
  if (node?.evidencePolicy === 'fresh')
    return `必须引用本次运行创建后采集、仍为 current、目标匹配的执行或浏览器回执${identity}`
  if (node?.evidencePolicy === 'reuse')
    return `可以引用历史回执，但必须完整性有效、目标匹配并保留采集时间和身份${identity}`
  return '必须提交一条结构化材料（observation/analysis/coverage/gap/answer/material）'
}
