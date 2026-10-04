// Planning only: observations are task evidence, never permission to execute.
import { verificationBasis } from 'dsh-saker/verification-basis'
const STATES = new Set(['satisfied', 'not-applicable', 'unknown'])
const TERMINAL = new Set(['not-hit', 'not-applicable', 'mechanism-confirmed', 'impact-confirmed'])

export function parseVerificationContext(value) {
  const context = typeof value === 'string' ? JSON.parse(value) : value
  if (context === undefined) return { assets: [], checks: [], history: [], maxSupplementAttempts: 2 }
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('verificationContext must be an object')
  for (const field of ['assets', 'checks', 'history']) {
    if (context[field] !== undefined && !Array.isArray(context[field])) throw new Error(`${field} must be an array`)
  }
  const maxSupplementAttempts = context.maxSupplementAttempts ?? 2
  if (!Number.isInteger(maxSupplementAttempts) || maxSupplementAttempts < 0 || maxSupplementAttempts > 10) throw new Error('invalid supplement budget')
  return { ...context, assets: context.assets ?? [], checks: context.checks ?? [], history: context.history ?? [], maxSupplementAttempts }
}

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

export function verificationKey(check) {
  // Identity and baseline changes must invalidate old conclusions.
  return JSON.stringify(['assetId', 'entryId', 'endpoint', 'methodVersion', 'authContext', 'requestRevision']
    .map(field => {
      const value = required(check[field], field)
      if (field !== 'endpoint') return value
      const url = new URL(value); url.hash = ''; return url.href
    }))
}

export function mergeSavedVerification(value, saved) {
  const explicit = value === undefined ? {} : parseVerificationContext(value)
  const raw = typeof value === 'string' ? JSON.parse(value) : (value ?? {})
  const context = { ...(saved.context ?? {}), ...explicit }
  for (const field of ['assets', 'checks', 'maxSupplementAttempts']) {
    if (raw[field] === undefined && saved.context?.[field] !== undefined) context[field] = saved.context[field]
  }
  const history = new Map()
  for (const row of explicit.history ?? []) {
    const key = verificationKey(row)
    if (history.has(key)) throw new Error('duplicate history context; consolidate before planning')
    history.set(key, row)
  }
  // Persisted conclusions are authoritative for the same immutable request context.
  for (const row of saved.history ?? []) history.set(verificationKey(row), row)
  context.history = [...history.values()]
  return parseVerificationContext(context)
}

export function buildVerificationQueue(ranked, input) {
  const context = parseVerificationContext(input)
  const assets = new Map()
  for (const asset of context.assets) {
    const id = required(asset?.id, 'asset.id')
    if (assets.has(id)) throw new Error(`duplicate asset: ${id}`)
    assets.set(id, asset)
  }
  const entries = new Map(ranked.map(item => [item.entry.id, item]))
  const history = new Map()
  for (const record of context.history) {
    const key = verificationKey(record)
    if (!Number.isInteger(record.supplementAttempts ?? 0) || (record.supplementAttempts ?? 0) < 0) throw new Error('invalid supplementAttempts')
    if (history.has(key)) throw new Error('duplicate history context; consolidate before planning')
    history.set(key, record)
  }
  const seen = new Set(), items = []
  for (const check of context.checks) {
    const key = verificationKey(check)
    if (seen.has(key)) continue
    seen.add(key)
    const asset = assets.get(check.assetId), candidate = entries.get(check.entryId)
    if (!asset || !candidate) throw new Error('check references unknown asset or catalog entry')
    if (!Array.isArray(check.conditions)) throw new Error('check.conditions must list applicability conditions')
    const conditions = check.conditions.map(condition => {
      if (!STATES.has(condition.state)) throw new Error('invalid applicability state')
      required(condition.name, 'condition.name')
      if (condition.state !== 'unknown' && !condition.evidenceIds?.length) throw new Error('known condition requires evidence')
      return condition
    })
    let endpoint
    try { endpoint = new URL(check.endpoint) } catch { throw new Error('endpoint must be an absolute HTTP(S) URL') }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('invalid endpoint')
    let assetUrl
    try { assetUrl = new URL(required(asset.url, 'asset.url')) } catch { throw new Error('asset.url must be an absolute URL') }
    if (endpoint.origin !== assetUrl.origin) throw new Error('endpoint does not belong to the asset origin')
    const previous = history.get(key)
    const currentBasis = verificationBasis(check, context)
    const sameEvidence = !!currentBasis && previous?.verificationBasis === currentBasis
    const attempts = previous?.supplementAttempts ?? 0
    const unknown = conditions.filter(condition => condition.state === 'unknown').map(condition => condition.name)
    let state = 'candidate', action = 'confirm-product', reason = 'product-evidence-missing'
    if (asset.inScope !== true) { state = 'blocked'; action = 'resolve-scope'; reason = 'scope-unconfirmed' }
    else if (asset.reachable !== true) { state = 'blocked'; action = 'confirm-service'; reason = 'service-unconfirmed' }
    else if (conditions.some(condition => condition.state === 'not-applicable')) {
      state = 'not-applicable'; action = 'exclude'; reason = 'contradicted-condition'
    } else if (previous && sameEvidence && TERMINAL.has(previous.status) && previous.evidenceIds?.length
      && check.requestValid === true && check.methodReviewed === true && conditions.length > 0 && unknown.length === 0
      && check.productConfirmed === true && check.productEvidenceIds?.length
      && (previous.status !== 'not-hit' || (previous.requestValid === true && previous.executed === true && previous.observationValid === true))) {
      state = previous.status; action = 'reuse-record'; reason = 'same-entry-identity-method-baseline-and-evidence'
    } else if (check.productConfirmed === true && check.productEvidenceIds?.length) {
      if (unknown.length || !conditions.length) {
        if (attempts >= context.maxSupplementAttempts) { state = 'blocked'; action = 'record-gap'; reason = 'supplement-budget-exhausted' }
        else { state = 'pending-confirmation'; action = 'supplement-evidence'; reason = 'unknown-conditions' }
      } else if (check.requestValid !== true || !check.baselineEvidenceIds?.length) {
        state = 'pending-confirmation'; action = 'capture-valid-baseline'; reason = 'request-unconfirmed'
      } else if (check.methodReviewed !== true) {
        state = 'pending-confirmation'; action = 'review-method'; reason = 'method-unreviewed'
      } else { state = 'pending-verification'; action = 'minimal-check-with-control'; reason = 'conditions-and-baseline-confirmed' }
    }
    items.push({ key, assetId: check.assetId, entryId: check.entryId, endpoint: check.endpoint,
      methodVersion: check.methodVersion, authContext: check.authContext, requestRevision: check.requestRevision,
      product: candidate.entry.product, score: candidate.rank.score, state, action, reason, conditions, unknown,
      evidenceIds: [...new Set([...(check.productEvidenceIds ?? []), ...(check.baselineEvidenceIds ?? []),
        ...conditions.flatMap(condition => condition.evidenceIds ?? []), ...(previous?.evidenceIds ?? [])])],
      supplement: { used: attempts, remaining: Math.max(0, context.maxSupplementAttempts - attempts) },
      historyBasis: previous ? (sameEvidence ? 'current' : 'missing-or-changed') : 'no-history',
      reuse: action === 'reuse-record', findingConfirmed: false })
  }
  // Ready evidence comes before discovery popularity; interleave product groups.
  const actionOrder = ['minimal-check-with-control', 'capture-valid-baseline', 'review-method', 'supplement-evidence', 'confirm-product']
  items.sort((a, b) => {
    const priority = item => { const i = actionOrder.indexOf(item.action); return i < 0 ? actionOrder.length : i }
    return priority(a) - priority(b) || b.score - a.score || a.key.localeCompare(b.key)
  })
  const ordered = []
  for (const action of [...actionOrder, ...new Set(items.map(item => item.action).filter(action => !actionOrder.includes(action)))]) {
    const groups = new Map()
    for (const item of items.filter(item => item.action === action)) {
      const product = item.product || item.entryId
      if (!groups.has(product)) groups.set(product, [])
      groups.get(product).push(item)
    }
    while ([...groups.values()].some(group => group.length)) for (const group of groups.values()) if (group.length) ordered.push(group.shift())
  }
  return { schema: 'saker.nday.verification-queue/1', items: ordered, maxSupplementAttempts: context.maxSupplementAttempts,
    note: 'Task observations drive planning only. Reused mechanism/impact records still require finding and reproduction review.' }
}
