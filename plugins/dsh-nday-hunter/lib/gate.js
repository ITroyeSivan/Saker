export const ATTACK_PROGRESS_FILE = 'attack-progress.json'
export const ATTACK_PROGRESS_SCHEMA = 'saker.attack-progress/1'

const OUTCOMES = new Set(['confirmed', 'refuted'])

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max)
}

export function emptyProgress() {
  return { schema: ATTACK_PROGRESS_SCHEMA, updatedAt: '', buckets: {} }
}

export function normalizeProgress(value) {
  const input = value && typeof value === 'object' ? value : {}
  const buckets = input.buckets && typeof input.buckets === 'object' ? input.buckets : {}
  const out = {}
  for (const [bucketId, record] of Object.entries(buckets)) {
    if (!record || typeof record !== 'object') continue
    const outcome = OUTCOMES.has(record.outcome) ? record.outcome : ''
    if (!outcome) continue
    out[String(bucketId)] = {
      representativeAssetId: clean(record.representativeAssetId, 200),
      serviceSignature: clean(record.serviceSignature, 100),
      outcome,
      evidence: clean(record.evidence, 2000),
      note: clean(record.note, 1000),
      recordedAt: clean(record.recordedAt, 80),
    }
  }
  return {
    schema: ATTACK_PROGRESS_SCHEMA,
    updatedAt: clean(input.updatedAt, 80),
    buckets: out,
  }
}

export function bucketGates(plan, progress) {
  const normalized = normalizeProgress(progress)
  const buckets = Array.isArray(plan?.buckets) ? plan.buckets : []
  return buckets.map((bucket) => {
    const bucketId = clean(bucket?.bucketId, 200)
    const representativeAssetId = clean(bucket?.representativeAssetId, 200)
      || clean(Array.isArray(bucket?.assetIds) ? bucket.assetIds[0] : '', 200)
    const saved = normalized.buckets[bucketId] || null
    const record = saved && (bucket.serviceSignature ? saved.serviceSignature === bucket.serviceSignature : (bucket.assetIds?.length || 0) <= 1)
      && saved.representativeAssetId === representativeAssetId ? saved : null
    const status = record?.outcome === 'confirmed'
      ? 'verified'
      : record?.outcome === 'refuted'
        ? 'refuted'
        : 'pending'
    return {
      bucketId,
      entryId: clean(bucket?.entryId, 200),
      product: clean(bucket?.product, 200),
      representativeAssetId,
      assetCount: Array.isArray(bucket?.assetIds) ? bucket.assetIds.length : 0,
      status,
      spreadAllowed: status === 'verified' && (bucket.serviceSignature || (bucket.assetIds?.length || 0) <= 1) ? true : false,
      nextAction: status === 'verified' ? 'spread' : status === 'refuted' ? 'next-bucket' : 'verify-representative',
      evidence: record?.evidence || '',
      note: record?.note || '',
      recordedAt: record?.recordedAt || '',
    }
  })
}

export function recordGate(plan, progress, input) {
  const bucketId = clean(input?.bucketId, 200)
  const assetId = clean(input?.assetId, 200)
  const outcome = clean(input?.outcome, 40)
  const evidence = clean(input?.evidence, 2000)
  const note = clean(input?.note, 1000)
  if (!bucketId) return { ok: false, error: 'bucketId 不能为空' }
  if (!OUTCOMES.has(outcome)) return { ok: false, error: 'outcome 必须是 confirmed 或 refuted' }
  if (!assetId) return { ok: false, error: 'assetId 不能为空' }
  if (!evidence) return { ok: false, error: 'evidence 不能为空：确认或证伪都必须留下可追溯证据' }
  const bucket = (Array.isArray(plan?.buckets) ? plan.buckets : []).find((item) => item?.bucketId === bucketId)
  if (!bucket) return { ok: false, error: `资产组不存在：${bucketId}` }
  const representative = clean(bucket.representativeAssetId, 200)
    || clean(Array.isArray(bucket.assetIds) ? bucket.assetIds[0] : '', 200)
  if (!representative) return { ok: false, error: `资产组 ${bucketId} 没有代表资产` }
  if (assetId !== representative) {
    return { ok: false, error: `先验证代表资产 ${representative}；${assetId} 不能替代它解锁整组` }
  }
  const next = normalizeProgress(progress)
  next.updatedAt = new Date().toISOString()
  next.buckets[bucketId] = {
    representativeAssetId: representative,
    serviceSignature: bucket.serviceSignature || '',
    outcome,
    evidence,
    note,
    recordedAt: next.updatedAt,
  }
  return { ok: true, progress: next, record: next.buckets[bucketId] }
}

export function renderGateStatus(gates) {
  const rows = Array.isArray(gates) ? gates : []
  if (rows.length === 0) return '（还没有资产组；先跑 attack_plan）'
  return [
    `代表资产门：${rows.filter((item) => item.spreadAllowed).length}/${rows.length} 组已解锁铺开`,
    ...rows.map((item) => {
      const state = item.status === 'verified' ? '已验证' : item.status === 'refuted' ? '已证伪' : '待验证'
      const action = item.nextAction === 'spread' ? '可铺开同组' : item.nextAction === 'next-bucket' ? '转下一组' : `先验证 ${item.representativeAssetId || '（缺代表资产）'}`
      return `- ${item.bucketId} | ${item.product || item.entryId || '-'} | ${state} | ${action}`
    }),
  ].join('\n')
}
