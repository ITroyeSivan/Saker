// 人工“依据复核”：用户判断当前原件是否足以支持发现。
// 只由 Desktop 显式操作写入；不改 findings.status、proof_kind 或既有证明等级。
import { createHash } from 'node:crypto'
import { redactText } from './redaction.js'
import { buildEvidenceIndex, resolveEvidenceRef } from './evidence-resolve.js'

export const FINDING_EVIDENCE_REVIEW_SCHEMA = `CREATE TABLE IF NOT EXISTS finding_evidence_reviews (
 session_id TEXT NOT NULL, finding_id TEXT NOT NULL, review_seq INTEGER NOT NULL,
 request_id TEXT NOT NULL, input_digest TEXT NOT NULL, finding_revision TEXT NOT NULL,
 basis_digest TEXT NOT NULL, decision TEXT NOT NULL, note TEXT NOT NULL,
 refs_json TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(session_id, finding_id, review_seq));
 CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_evidence_reviews_request
 ON finding_evidence_reviews(session_id, finding_id, request_id);`

const DECISIONS = ['supported', 'insufficient', 'superseded']
const DECISION_LABELS = { supported: '依据足以支持', insufficient: '依据不足', superseded: '已更正先前判断' }
const sha = value => createHash('sha256').update(value).digest('hex')
const json = value => { try { return JSON.parse(value) } catch { return null } }

export function normalizeReviewRefs(refs) {
  if (refs === undefined || refs === null) return []
  if (!Array.isArray(refs)) throw new Error('refs 需要数组')
  if (refs.length > 20) throw new Error('依据复核最多引用 20 条原件')
  return refs.map(item => {
    if (!item || typeof item !== 'object') throw new Error('引用需要 {kind,id}')
    const kind = String(item.kind || '').toLowerCase()
    const id = String(item.id || '')
    const revision = String(item.revision || '')
    if (!kind || !id) throw new Error('引用需要 kind 和 id')
    return { kind, id, revision }
  })
}

// basis 只包含业务版本、当前证据指针与有效性/完整性，不含请求正文或瞬时时间。
export function reviewBasisDigest(finding, resolvedRefs = []) {
  const pointers = resolvedRefs.map(ref => ({
    kind: String(ref.kind || ''), id: String(ref.id || ''), revision: String(ref.revision || ''),
    location: String(ref.location || ''), quality: String(ref.quality || ''),
    reasonCode: String(ref.reasonCode || ''),
    openType: String(ref.openRef?.type || ''), openId: String(ref.openRef?.id || ''),
    ownerSessionId: String(ref.openRef?.ownerSessionId || ref.ownerSessionId || ''),
    fingerprint: String(ref.fingerprint || ''),
    registeredDigest: String(ref.registeredDigest || ''),
    integrityValid: ref.integrityValid === undefined ? null : ref.integrityValid,
  })).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id) || a.revision.localeCompare(b.revision))
  return {
    findingRevision: String(finding.updatedAt || finding.updated_at || ''),
    basisDigest: sha(JSON.stringify([String(finding.id || ''), String(finding.updatedAt || finding.updated_at || ''), pointers])),
    pointers,
  }
}

function resolvedFor(store, rootId, findingRow, resolvedRefs) {
  if (Array.isArray(resolvedRefs)) return resolvedRefs
  const basis = json(findingRow.evidence_refs) || findingRow.evidenceRefs || []
  const index = buildEvidenceIndex(store, rootId)
  return basis.map(ref => resolveEvidenceRef(store, rootId, ref, index))
}

function reviewRowView(row, headSeq, basisDigest) {
  let refs = []
  try { refs = JSON.parse(row.refs_json) } catch { refs = [] }
  const superseded = headSeq !== null && row.review_seq < headSeq
  return {
    reviewSeq: row.review_seq,
    requestId: row.request_id,
    findingRevision: row.finding_revision,
    basisDigest: row.basis_digest,
    decision: row.decision,
    decisionLabel: DECISION_LABELS[row.decision] || row.decision,
    note: row.note,
    refs,
    author: row.author,
    createdAt: row.created_at,
    current: row.basis_digest === basisDigest && !superseded,
    superseded,
    supersededLabel: superseded ? '已更正' : '',
  }
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}
function decodeCursor(cursor) {
  if (!cursor) return 0
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    return Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : 0
  } catch { return 0 }
}

export function readFindingEvidenceReviews(store, rootId, finding, resolvedRefs = null, { historyLimit = 10 } = {}) {
  const basis = reviewBasisDigest(finding, resolvedFor(store, rootId, finding, resolvedRefs))
  const rows = store.db.prepare(`SELECT * FROM finding_evidence_reviews WHERE session_id=? AND finding_id=?
    ORDER BY review_seq DESC`).all(rootId, String(finding.id || ''))
  const headSeq = rows.length ? rows[0].review_seq : null
  const views = rows.map(row => reviewRowView(row, headSeq, basis.basisDigest))
  const head = views[0] || null
  const take = Math.max(1, Math.min(50, Number(historyLimit) || 10))
  const counts = { supported: 0, insufficient: 0, superseded: 0 }
  for (const row of rows) counts[row.decision] = (counts[row.decision] || 0) + 1
  return {
    findingRevision: basis.findingRevision,
    basisDigest: basis.basisDigest,
    reviewHead: head,
    reviewHistory: views.slice(0, take),
    reviewHistoryCursor: rows.length > take ? encodeCursor(take) : null,
    reviewTotal: rows.length,
    reviewCounts: counts,
    headState: !head ? 'none' : head.current ? 'current' : 'stale',
    headNote: !head ? '尚未记录人工依据复核'
      : head.current ? '' : '原判断保留，当前依据不可复核',
  }
}

export function listFindingEvidenceReviews(store, rootId, findingId, { cursor = '', limit = 20 } = {}) {
  const id = String(findingId || '')
  const root = String(rootId || '')
  if (!id || !root) throw Object.assign(new Error('缺少 rootId 或 findingId'), { code: 'MISSING_PREREQUISITE' })
  const finding = store.db.prepare('SELECT id,updated_at,evidence_refs FROM findings WHERE session_id=? AND id=?').get(root, id)
  if (!finding) throw new Error('finding not found')
  const basis = reviewBasisDigest({ id: finding.id, updatedAt: finding.updated_at }, resolvedFor(store, root, finding))
  const rows = store.db.prepare(`SELECT * FROM finding_evidence_reviews WHERE session_id=? AND finding_id=?
    ORDER BY review_seq DESC`).all(root, id)
  const headSeq = rows.length ? rows[0].review_seq : null
  const take = Math.max(1, Math.min(50, Number(limit) || 20))
  const offset = decodeCursor(cursor)
  const page = rows.slice(offset, offset + take).map(row => reviewRowView(row, headSeq, basis.basisDigest))
  return {
    ok: true,
    data: page,
    basisDigest: basis.basisDigest,
    findingRevision: basis.findingRevision,
    page: { nextCursor: offset + page.length < rows.length ? encodeCursor(offset + page.length) : null,
      hasMore: offset + page.length < rows.length, total: rows.length, totalKnown: true },
  }
}

function sameRef(left, right) {
  return left.kind === right.kind && left.id === right.id
    && (left.revision || '') === (right.revision || '')
}

function inputDigest(payload) {
  return sha(JSON.stringify([payload.rootId, payload.findingId, payload.requestId, payload.decision, payload.note,
    payload.refs.map(ref => [ref.kind, ref.id, ref.revision]).sort((a, b) => a.join(':').localeCompare(b.join(':')))]))
}

export function saveFindingEvidenceReview(store, rootId, payload = {}, author = 'desktop-action') {
  const root = String(rootId || '')
  const findingId = String(payload.findingId || '')
  const requestId = String(payload.requestId || '').trim()
  const decision = String(payload.decision || '').trim()
  if (!root || !findingId) throw Object.assign(new Error('缺少 rootId 或 findingId'), { code: 'MISSING_PREREQUISITE' })
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(requestId))
    throw new Error('requestId 需要 8–200 位稳定标识（用于幂等与超时取回）')
  if (!DECISIONS.includes(decision)) throw new Error('decision 只能是 supported / insufficient / superseded')
  const note = redactText(String(payload.note || '')).trim()
  if (!note || [...note].length > 2000) throw new Error('复核说明需要 1–2000 字符')
  if (decision === 'superseded' && [...note].length < 4) throw new Error('更正先前判断需要写明原因')
  const refs = normalizeReviewRefs(payload.refs)
  const shouldConflict = (message) => Object.assign(new Error(message), { code: 'REVIEW_CONFLICT' })
  const expected = {
    findingRevision: String(payload.expectedFindingRevision || ''),
    basisDigest: String(payload.expectedBasisDigest || ''),
    headSeq: Number(payload.expectedHeadSeq || 0),
  }
  if (!Number.isSafeInteger(expected.headSeq) || expected.headSeq < 0) throw new Error('expectedHeadSeq 需要非负整数')
  const record = {
    rootId: root, findingId, requestId, decision, note, refs,
  }
  const input = inputDigest(record)

  store.db.exec('BEGIN IMMEDIATE')
  try {
    const row = store.db.prepare('SELECT * FROM findings WHERE session_id=? AND id=?').get(root, findingId)
    if (!row) throw new Error('finding not found in current task')
    if (row.mode !== 'pentest') throw new Error('依据复核只适用于当前渗透测试发现')
    const resolved = resolvedFor(store, root, row)
    const basis = reviewBasisDigest({ id: row.id, updatedAt: row.updated_at }, resolved)
    const head = store.db.prepare(`SELECT review_seq FROM finding_evidence_reviews
      WHERE session_id=? AND finding_id=? ORDER BY review_seq DESC LIMIT 1`).get(root, findingId)
    const headSeq = Number(head?.review_seq || 0)
    const existing = store.db.prepare(`SELECT * FROM finding_evidence_reviews
      WHERE session_id=? AND finding_id=? AND request_id=?`).get(root, findingId, requestId)
    if (existing) {
      if (existing.input_digest !== input)
        throw shouldConflict('同一请求 ID 已用于不同的复核内容；请用新的请求 ID')
      const all = store.db.prepare(`SELECT * FROM finding_evidence_reviews WHERE session_id=? AND finding_id=?
        ORDER BY review_seq DESC`).all(root, findingId)
      store.db.exec('COMMIT')
      return { ok: true, idempotent: true, review: reviewRowView(existing, all[0]?.review_seq ?? null, basis.basisDigest),
        ...readFindingEvidenceReviews(store, root, row, resolved) }
    }
    if (expected.findingRevision !== String(row.updated_at || '') || expected.basisDigest !== basis.basisDigest
      || expected.headSeq !== headSeq)
      throw shouldConflict('这条发现或它的证据已在另一窗口更新；请刷新后重新确认')
    // 只接受当前详情里存在且可定位的精确引用。
    for (const ref of refs) {
      const match = resolved.find(item => sameRef(item, ref))
      if (!match) throw new Error('引用不在当前发现详情中：' + ref.kind + ':' + ref.id)
      if (['ambiguous', 'missing', 'unsupported'].includes(match.location))
        throw new Error('引用的版本或归属未确定，不能作为依据：' + ref.kind + ':' + ref.id)
    }
    if (decision === 'supported') {
      const unverifiable = refs.filter(ref => {
        const match = resolved.find(item => sameRef(item, ref))
        return !match?.openRef || !['current', 'historical'].includes(match.quality)
      })
      if (unverifiable.length)
        throw new Error('“依据足以支持”只能引用当前可核的原件；不可核引用：'
          + unverifiable.map(ref => ref.kind + ':' + ref.id).join('、'))
      if (!refs.length) throw new Error('标记“依据足以支持”至少需要一个质量明确且可打开的原件')
    }
    if (decision === 'superseded' && !headSeq) throw new Error('没有先前判断可更正')
    const seq = headSeq + 1
    const createdAt = new Date().toISOString()
    const storedRefs = refs.map(ref => {
      const match = resolved.find(item => sameRef(item, ref))
      return { kind: match.kind, id: match.id, revision: match.revision || '', location: match.location,
        quality: match.quality, reasonCode: match.reasonCode || '', openRef: match.openRef || null,
        fingerprint: match.fingerprint || '', registeredDigest: match.registeredDigest || '',
        integrityValid: match.integrityValid === undefined ? null : match.integrityValid }
    })
    store.db.prepare(`INSERT INTO finding_evidence_reviews(session_id,finding_id,review_seq,request_id,input_digest,
      finding_revision,basis_digest,decision,note,refs_json,author,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(root, findingId, seq, requestId, input, basis.findingRevision, basis.basisDigest, decision, note,
        JSON.stringify(storedRefs), author, createdAt)
    store.db.exec('COMMIT')
    const state = readFindingEvidenceReviews(store, root, row, resolved)
    return { ok: true, idempotent: false, review: state.reviewHead, ...state }
  } catch (error) {
    try { store.db.exec('ROLLBACK') } catch { /* already committed */ }
    throw error
  }
}
