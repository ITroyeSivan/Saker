// 统一证据引用解析：发现详情、探索图、报告索引共用同一归属与版本判断。
// 纯读；不访问目标、不调用模型、不写库。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readExecutionReceipt } from './execution-receipts.js'
import { readTaskContext, readTaskRecord } from './task-context.js'

const text = value => String(value ?? '')
const reason = (code, label) => ({ reasonCode: code, reason: label })
const digest = value => createHash('sha256').update(value).digest('hex')

function ownerSessions(store, rootId) {
  const ids = new Set([text(rootId)])
  for (const table of ['role_instances', 'role_attempts']) {
    try {
      for (const row of store.db.prepare(`SELECT DISTINCT child_id FROM ${table} WHERE session_id=?`).all(rootId)) {
        if (row.child_id) ids.add(text(row.child_id))
      }
    } catch { /* legacy schema */ }
  }
  ids.delete('')
  return [...ids]
}

function requestAt(store, owner, id, revision) {
  const context = readTaskContext(store, owner)
  return (context?.requests || []).find(row => text(row.id) === id && text(row.revision) === revision)
    || readTaskRecord(store, owner, 'request', id, revision)
    || null
}

// 一次扫描当前根与已登记子会话的回执、全部请求版本；解析时按 map 查找，
// 避免每条边重新扫描回执表。回执原文只在命中后按需读取。
export function buildEvidenceIndex(store, rootId) {
  const owners = ownerSessions(store, rootId)
  const receiptsByRequest = new Map()
  const receiptOwnersById = new Map()
  for (const owner of owners) {
    let rows = []
    try { rows = store.db.prepare('SELECT id,record FROM execution_receipts WHERE session_id=?').all(owner) } catch { rows = [] }
    for (const row of rows) {
      const entry = { id: text(row.id), ownerSessionId: owner }
      if (!receiptOwnersById.has(entry.id)) receiptOwnersById.set(entry.id, [])
      receiptOwnersById.get(entry.id).push(entry)
      let record = null
      try { record = JSON.parse(row.record) } catch { continue }
      if (!record || !text(record.requestId)) continue
      const key = owner + '\0' + text(record.requestId) + '\0' + text(record.requestRevision)
      if (!receiptsByRequest.has(key)) receiptsByRequest.set(key, [])
      receiptsByRequest.get(key).push(entry)
    }
  }
  const requestRevisions = new Map()
  const addRevision = (id, revision) => {
    if (!id || !revision) return
    if (!requestRevisions.has(id)) requestRevisions.set(id, new Set())
    requestRevisions.get(id).add(revision)
  }
  const context = readTaskContext(store, rootId)
  for (const row of context?.requests || []) addRevision(text(row.id), text(row.revision))
  try {
    for (const row of store.db.prepare("SELECT record_id,version FROM task_context_records WHERE session_id=? AND kind='requests'").all(rootId))
      addRevision(text(row.record_id), text(row.version))
  } catch { /* table absent on very old stores */ }
  return { rootId, owners, receiptsByRequest, receiptOwnersById, requestRevisions }
}

function receiptState(store, entry) {
  try {
    const receipt = readExecutionReceipt(store, entry.ownerSessionId, entry.id)
    return {
      id: entry.id, ownerSessionId: entry.ownerSessionId,
      requestId: text(receipt.requestId), requestRevision: text(receipt.requestRevision),
      status: receipt.status ?? null, outcome: receipt.outcome || '',
      completedAt: receipt.completedAt || '',
      current: receipt.current === true, integrityValid: receipt.integrityValid === true,
      integrityReason: receipt.currentReason || '', readable: true,
    }
  } catch (error) {
    return {
      id: entry.id, ownerSessionId: entry.ownerSessionId, status: null, outcome: '',
      requestId: '', requestRevision: '',
      completedAt: '', current: false, integrityValid: false,
      integrityReason: error?.message || 'receipt unreadable', readable: false,
    }
  }
}

function splitRequestId(raw) {
  const value = text(raw)
  const at = value.lastIndexOf(':')
  return at > 0 ? [value.slice(0, at), value.slice(at + 1)] : [value, '']
}

function resolveRequest(store, rootId, rawId, index) {
  const idx = index || buildEvidenceIndex(store, rootId)
  const [id, explicitRevision] = splitRequestId(rawId)
  let revision = explicitRevision
  if (!revision) {
    const versions = [...(idx.requestRevisions.get(id) || [])].filter(Boolean)
    if (versions.length > 1)
      return { kind: 'request', id, location: 'ambiguous', quality: 'unknown', openRef: null,
        receipts: [], receiptCount: 0, ...reason('REVISION_REQUIRED', '同名请求有多个版本，请指定版本') }
    revision = versions[0] || ''
  }
  if (!revision) {
    // 旧回执可能没有 requestRevision。仍按根归属和 requestId 展示回执，
    // 但版本无法核实，不能提升为当前证据。
    const legacyReceipts = (idx.receiptsByRequest.get(rootId + '\0' + id + '\0') || [])
      .map(entry => receiptState(store, entry))
    if (legacyReceipts.length) {
      legacyReceipts.sort((a, b) => Number(b.current && b.integrityValid) - Number(a.current && a.integrityValid)
        || String(b.completedAt).localeCompare(String(a.completedAt))
        || a.ownerSessionId.localeCompare(b.ownerSessionId) || a.id.localeCompare(b.id))
      const anyInvalid = legacyReceipts.some(item => !item.integrityValid)
      const reasonCodes = ['REVISION_REQUIRED']
      if (legacyReceipts.length > 1) reasonCodes.push('MULTIPLE_RECEIPTS')
      if (anyInvalid) reasonCodes.push('INTEGRITY_UNVERIFIED')
      const labels = {
        REVISION_REQUIRED: '回执未记录请求版本，仅能显示已保存回执，不提高当前证据等级',
        MULTIPLE_RECEIPTS: '同一请求有多条未记录版本的回执，需人工核对',
        INTEGRITY_UNVERIFIED: '回执完整性未通过校验，仅作历史参考',
      }
      return {
        kind: 'request', id, revision: '', location: 'unique-legacy', quality: 'unknown', openRef: null,
        receipts: legacyReceipts, receiptCount: legacyReceipts.length,
        reasonCodes, ...reason(reasonCodes[0], labels[reasonCodes[0]]),
      }
    }
  }
  if (!revision)
    return { kind: 'request', id, location: 'missing', quality: 'unknown', openRef: null,
      receipts: [], receiptCount: 0, ...reason('RECORD_NOT_FOUND', '请求版本未找到') }
  const row = requestAt(store, rootId, id, revision)
  if (!row)
    return { kind: 'request', id, revision, location: 'missing', quality: 'unknown', openRef: null,
      receipts: [], receiptCount: 0, ...reason('RECORD_NOT_FOUND', '请求原件不存在') }
  // 请求归 owner 所有：根请求的回执只匹配根会话，子会话同名同版必须用精确 execution 引用。
  const receipts = (idx.receiptsByRequest.get(rootId + '\0' + id + '\0' + revision) || []).map(entry => receiptState(store, entry))
  receipts.sort((a, b) => Number(b.current && b.integrityValid) - Number(a.current && a.integrityValid)
    || String(b.completedAt).localeCompare(String(a.completedAt))
    || a.ownerSessionId.localeCompare(b.ownerSessionId) || a.id.localeCompare(b.id))
  const anyCurrent = receipts.some(item => item.current && item.integrityValid)
  const anyInvalid = receipts.some(item => !item.integrityValid)
  const quality = anyCurrent ? 'current' : anyInvalid ? 'invalid' : receipts.length ? 'historical' : 'unknown'
  const reasonCodes = []
  if (receipts.length > 1) reasonCodes.push('MULTIPLE_RECEIPTS')
  if (anyInvalid) reasonCodes.push('INTEGRITY_UNVERIFIED')
  if (receipts.length && !anyCurrent) reasonCodes.push('RECEIPT_HISTORICAL')
  if (!receipts.length) reasonCodes.push('INTEGRITY_UNVERIFIED')
  const primary = reasonCodes[0] || ''
  const labels = {
    MULTIPLE_RECEIPTS: '该版本有多个回执，需人工选择',
    INTEGRITY_UNVERIFIED: receipts.length ? '回执完整性未通过校验，仅作历史参考' : '原件存在，但没有可核对的回执',
    RECEIPT_HISTORICAL: '回执与当前请求版本不再匹配，仅作历史参考',
  }
  return {
    kind: 'request', id, revision, location: explicitRevision ? 'exact' : 'unique-legacy', quality,
    openRef: { type: 'request', ownerSessionId: rootId, id, revision },
    receipts, receiptCount: receipts.length, requestValid: row.valid === true,
    fingerprint: requestFingerprint(row, id, revision),
    ...(reasonCodes.length ? { reasonCodes, ...reason(primary, labels[primary]) } : {}),
  }
}

function resolveExecution(store, rootId, rawId, index) {
  const idx = index || buildEvidenceIndex(store, rootId)
  const owners = idx.receiptOwnersById.get(rawId) || []
  if (!owners.length)
    return { kind: 'execution', id: rawId, location: 'missing', quality: 'unknown', openRef: null,
      ...reason('RECORD_NOT_FOUND', '执行回执不存在') }
  if (owners.length > 1)
    return { kind: 'execution', id: rawId, location: 'ambiguous', quality: 'unknown', openRef: null,
      ...reason('OWNER_UNRESOLVED', '同名回执无法确认归属') }
  const receipt = receiptState(store, owners[0])
  if (!receipt.readable)
    return { kind: 'execution', id: rawId, location: 'exact', quality: 'invalid', openRef: null,
      receipt, ...reason('INTEGRITY_UNVERIFIED', '回执记录损坏，无法打开') }
  const openRef = { type: 'execution', ownerSessionId: receipt.ownerSessionId, id: rawId }
  if (!receipt.integrityValid)
    return { kind: 'execution', id: rawId, location: 'exact', quality: 'invalid', openRef,
      receipt, fingerprint: receiptFingerprint(receipt), receipts: [receipt],
      ...reason('INTEGRITY_UNVERIFIED', '回执完整性未通过校验，仅作历史参考') }
  if (receipt.current) return { kind: 'execution', id: rawId, location: 'exact', quality: 'current', openRef, receipt,
    fingerprint: receiptFingerprint(receipt), receipts: [receipt] }
  return { kind: 'execution', id: rawId, location: 'exact', quality: 'historical', openRef,
    receipt, fingerprint: receiptFingerprint(receipt), receipts: [receipt],
    ...reason('RECEIPT_HISTORICAL', '历史回执可读，但不作为当前有效佐证') }
}

function requestFingerprint(row, id, revision) {
  return digest(JSON.stringify([id, revision, text(row?.request), text(row?.response)]))
}

function receiptFingerprint(receipt) {
  if (!receipt) return ''
  return digest(JSON.stringify([text(receipt.requestSha256), text(receipt.responseSha256)]))
}

function resolveMaterial(store, rootId, kind, rawId) {
  let raw
  try { raw = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(rootId, rawId) }
  catch { raw = null }
  if (!raw) return null
  let record = null
  try { record = JSON.parse(raw.record) } catch {
    return { kind, id: rawId, location: 'exact', quality: 'invalid', openRef: null,
      ...reason('INTEGRITY_UNVERIFIED', '材料记录损坏，无法读取') }
  }
  const file = text(record.file || record.path || '')
  const base = { kind, id: rawId, ownerSessionId: rootId, registeredDigest: text(record.digest) }
  if (!file || !existsSync(file))
    return { ...base, location: 'missing', quality: 'invalid', openRef: null,
      ...reason('RECORD_NOT_FOUND', '索引存在但原件缺失') }
  let stat = null, bytes = null
  try { stat = statSync(file); bytes = stat.isFile() ? readFileSync(file) : null }
  catch { bytes = null }
  if (!stat?.isFile())
    return { ...base, location: 'exact', quality: 'invalid', openRef: null,
      ...reason('INTEGRITY_UNVERIFIED', '索引指向目录，不是可读文件') }
  if (!bytes)
    return { ...base, location: 'exact', quality: 'invalid', openRef: null,
      ...reason('INTEGRITY_UNVERIFIED', '文件不可读，无法核对依据') }
  const actualDigest = digest(bytes)
  const registered = text(record.digest)
  const integrityValid = registered ? actualDigest === registered : null
  const openRef = { type: 'material', ownerSessionId: rootId, id: rawId }
  if (integrityValid === false)
    return { ...base, location: 'exact', quality: 'invalid', openRef,
      actualDigest, fingerprint: actualDigest, size: bytes.length, integrityValid,
      ...reason('INTEGRITY_UNVERIFIED', '文件摘要与登记不符，不能作为当前依据') }
  if (integrityValid === null)
    return { ...base, location: 'exact', quality: 'unknown', openRef,
      actualDigest, fingerprint: actualDigest, size: bytes.length, integrityValid,
      ...reason('INTEGRITY_UNVERIFIED', '材料没有登记摘要，完整性未核') }
  return {
    ...base, location: 'exact', quality: 'current', openRef,
    actualDigest, fingerprint: actualDigest, size: bytes.length, integrityValid,
  }
}

export function resolveEvidenceRef(store, rootId, ref = {}, index = null) {
  const kind = text(ref.kind || ref.refKind || 'ref').toLowerCase()
  const rawId = text(ref.id || ref.ref || ref.requestId)
  if (!rawId) return { kind, id: '', location: 'missing', quality: 'not-applicable', openRef: null,
    ...reason('RECORD_NOT_FOUND', '引用没有可解析 ID') }
  if (kind === 'request') {
    const explicitRevision = text(ref.revision || ref.requestRevision)
    const value = explicitRevision && !rawId.includes(':') ? rawId + ':' + explicitRevision : rawId
    return resolveRequest(store, rootId, value, index)
  }
  if (kind === 'execution' || kind === 'receipt' || kind === 'http') return resolveExecution(store, rootId, rawId, index)
  if (kind === 'file' || kind === 'material' || kind === 'source') {
    const resolved = resolveMaterial(store, rootId, kind, rawId)
    if (resolved) return resolved
    if (kind === 'source')
      return { kind, id: rawId, location: 'unsupported', quality: 'unknown', openRef: null,
        ...reason('UNSUPPORTED_KIND', '来源条目已登记，但没有可打开的材料原件') }
    return { kind, id: rawId, location: 'missing', quality: 'unknown', openRef: null,
      ...reason('RECORD_NOT_FOUND', '材料不存在或已移除') }
  }
  return { kind, id: rawId, location: 'unsupported', quality: 'not-applicable', openRef: null,
    ...reason('UNSUPPORTED_KIND', '该引用类型没有原件读取合同') }
}
