// Structured component facts and advisory applicability. This is deliberately
// small: it records what was observed, what source was used, which version
// range matched, and which required conditions are still unknown. It never
// treats a product/version hit as a vulnerability.
import { createHash, randomUUID } from 'node:crypto'
import { readTaskContext } from './task-context.js'

export const COMPONENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS component_facts (
  session_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY(session_id,id)
);
CREATE TABLE IF NOT EXISTS component_advisories (
  session_id TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY(session_id,id)
);
CREATE TABLE IF NOT EXISTS component_evaluations (
  session_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY(session_id,id)
);
CREATE TABLE IF NOT EXISTS component_upstreams (
  session_id TEXT NOT NULL, id TEXT NOT NULL, fact_id TEXT NOT NULL, status TEXT NOT NULL,
  record TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(session_id,id)
);`

const digest = value => createHash('sha256').update(value).digest('hex')
const text = (value, label, max = 500) => {
  const result = String(value ?? '').trim()
  if (!result || result.length > max) throw new Error(`${label} must be 1-${max} characters`)
  return result
}
// 模型的工具参数常用同义字段；只接受含义明确的别名，避免为了猜字段名
// 重复写入后留下空公告/空条件。未知字段仍然不猜。
const pick = (...values) => values.find(value => value !== undefined && value !== null && String(value).trim() !== '')
// Keep the full product identity. In particular, removing non-ASCII text made
// unrelated Chinese products collapse to one key (泛微 and 致远 both became "").
// Normalisation only folds width/case and punctuation; aliases remain explicit.
const productKey = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US')
  .replace(/[\s_]+/gu, ' ')
  .replace(/[^\p{L}\p{N}.+]+/gu, ' ')
  .replace(/\s+/g, '-')
  .replace(/^[.-]+|[.-]+$/g, '')
const STANDARD_PRERELEASE = new Set([
  'alpha', 'a', 'beta', 'b', 'rc', 'pre', 'preview', 'dev', 'snapshot', 'next',
])
const parseVersion = value => {
  const raw = String(value ?? '').trim().replace(/^v(?=\d)/i, '')
  if (!raw) return null
  const match = /^(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(raw)
  if (!match) return null
  const core = match[1].split('.').map(Number)
  if (!match[2]) return { raw, kind: 'numeric', core, prerelease: [] }
  const prerelease = match[2].split('.')
  if (!prerelease.length || prerelease.some(item => !/^[0-9A-Za-z-]+$/.test(item))) return null
  // Vendor suffixes such as -p1, -sp2, or -hotfix are not assumed to follow
  // SemVer. They stay unknown until the caller supplies a supported scheme.
  if (!prerelease.some(item => STANDARD_PRERELEASE.has(item.toLowerCase()))) {
    return { raw, kind: 'unsupported', core, prerelease, reason: 'unrecognised vendor/prerelease suffix' }
  }
  return { raw, kind: 'semver-prerelease', core, prerelease }
}
const comparePrerelease = (left, right) => {
  if (!left.length && !right.length) return 0
  if (!left.length) return 1
  if (!right.length) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index], b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a), bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b)
      if (difference) return difference < 0 ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a.toLowerCase() !== b.toLowerCase()) return a.toLowerCase() < b.toLowerCase() ? -1 : 1
  }
  return 0
}
const compareVersion = (a, b) => {
  const left = parseVersion(a), right = parseVersion(b)
  if (!left || !right || left.kind === 'unsupported' || right.kind === 'unsupported') return null
  const length = Math.max(left.core.length, right.core.length)
  for (let index = 0; index < length; index += 1) {
    const x = left.core[index] || 0, y = right.core[index] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}
const sourceExists = (store, sessionId, sourceRef) => {
  const ref = String(sourceRef || '').trim()
  if (!ref) return false
  if (store.db.prepare('SELECT 1 FROM business_materials WHERE session_id=? AND id=?').get(sessionId, ref)) return true
  if (store.db.prepare('SELECT 1 FROM project_sources WHERE session_id=? AND source_id=? LIMIT 1').get(sessionId, ref)) return true
  if (store.db.prepare('SELECT 1 FROM execution_receipts WHERE session_id=? AND id=?').get(sessionId, ref)) return true
  return false
}
const readJson = (value, label) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { throw new Error(`${label} must be valid JSON`) }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

export function ensureComponentSchema(store) {
  store.db.exec(COMPONENT_SCHEMA)
}

export const normalizeComponentProduct = productKey
export const parseComponentVersion = parseVersion
export const compareComponentVersions = compareVersion
export function readComponentFact(store, sessionId, id) {
  ensureComponentSchema(store)
  return readFact(store, sessionId, id)
}

function saveFact(store, sessionId, fact) {
  store.db.prepare('INSERT INTO component_facts(session_id,id,record) VALUES(?,?,?)').run(sessionId, fact.id, JSON.stringify(fact))
  return fact
}

export function observeComponent(store, sessionId, input = {}) {
  ensureComponentSchema(store)
  const product = text(pick(input.product, input.component), 'product', 200)
  const versionValue = pick(input.version, input.productVersion, input.componentVersion)
  const version = versionValue === undefined ? '' : String(versionValue).trim().slice(0, 120)
  const sourceValue = pick(input.sourceRef, input.source, input.receiptId, input.evidenceRef)
  const declared = pick(input.sourceKind, input.sourceType) === 'user-declared'
    || input.declared === true
    || /^user-declared(?::|$)/i.test(String(sourceValue || ''))
  const sourceRef = declared ? '' : text(sourceValue, 'sourceRef', 200)
  if (!declared && !sourceExists(store, sessionId, sourceRef)) throw new Error('component sourceRef is not a current task material or receipt; 用户声明可传 sourceRef="user-declared"')
  const context = readTaskContext(store, sessionId)
  const assetId = pick(input.assetId, input.targetAssetId, input.target)
  const asset = assetId
    ? (context?.assets || []).find(item => item.id === assetId)
    : null
  if (assetId && !asset) throw new Error('component assetId is not in the current task context')
  const fact = {
    id: 'component-' + randomUUID(),
    product,
    productKey: productKey(product),
    version,
    versionKind: parseVersion(version)?.kind || 'unknown',
    assetId: asset?.id || '',
    assetUrl: asset?.url || '',
    targetMapped: Boolean(asset),
    sourceRef,
    sourceKind: declared ? 'user-declared' : 'material',
    sourceLabel: String(input.sourceLabel || (declared ? '用户声明' : '')).slice(0, 300),
    note: String(input.note || '').slice(0, 2000),
    observedAt: new Date().toISOString(),
  }
  saveFact(store, sessionId, fact)
  return { ok: true, fact }
}

function normalizeAdvisory(input, sessionId, store) {
  const raw = readJson(input.document ?? input.advisory ?? input, 'advisory document')
  const document = raw.document && typeof raw.document === 'object' && !Array.isArray(raw.document) ? raw.document : raw
  const id = text(pick(document.id, document.advisoryId, document.advId, input.id, input.advisoryId), 'advisory.id', 200)
  const sourceValue = pick(document.sourceRef, document.source, input.sourceRef, input.source, input.receiptId, input.evidenceRef)
  const declared = pick(document.sourceKind, document.sourceType, input.sourceKind, input.sourceType) === 'user-declared'
    || document.declared === true || input.declared === true
    || /^user-declared(?::|$)/i.test(String(sourceValue || ''))
  const sourceRef = declared ? '' : text(sourceValue, 'advisory sourceRef', 200)
  if (!declared && !sourceExists(store, sessionId, sourceRef)) throw new Error('advisory sourceRef is not a current task material or receipt; 用户声明可传 sourceRef="user-declared"')
  let product = pick(document.product, document.component) || ''
  let aliases = Array.isArray(document.aliases) ? document.aliases : []
  const affectedInput = document.affected ?? document.ranges ?? document.versions ?? []
  let affected = Array.isArray(affectedInput) ? affectedInput : [affectedInput]
  if (document.schema === 'osv/1'
    || (Array.isArray(document.affected) && document.affected.some(item => item && item.package))) {
    affected = []
    for (const item of document.affected || []) {
      if (item.package?.name && !product) product = item.package.name
      aliases.push(...(item.package?.aliases || []))
      for (const range of item.ranges || []) {
        const events = Array.isArray(range.events) ? range.events : []
        let introduced = ''
        for (const event of events) {
          if (event.introduced !== undefined) introduced = String(event.introduced)
          if (event.fixed !== undefined) affected.push({ introduced, fixed: String(event.fixed) })
        }
        if (events.some(event => event.last_affected !== undefined)) {
          affected.push({ introduced, note: 'OSV last_affected requires manual bound interpretation' })
        }
      }
    }
  }
  product = text(product, 'advisory product', 200)
  const parseRangeText = value => {
    const raw = String(value || '').trim()
    if (!raw) return null
    const interval = /^([[(])\s*([0-9A-Za-z.+-]+)\s*,\s*([0-9A-Za-z.+-]+)\s*([\])])$/.exec(raw)
    if (interval) {
      return {
        introduced: interval[2],
        introducedInclusive: interval[1] === '[',
        fixed: interval[3],
        fixedInclusive: interval[4] === ']',
      }
    }
    const bare = /^\s*([0-9][0-9A-Za-z.+-]*)\s*,\s*([0-9][0-9A-Za-z.+-]*)\s*$/.exec(raw)
    if (bare) return { introduced: bare[1], introducedInclusive: true, fixed: bare[2], fixedInclusive: false }
    const lowerStrict = /(?:^|\s)>\s*([0-9][0-9A-Za-z.+-]*)/.exec(raw)
    const lowerInclusive = /(?:^|\s)>=\s*([0-9][0-9A-Za-z.+-]*)/.exec(raw)
    const lowerFrom = /(?:^|\s)from\s+([0-9][0-9A-Za-z.+-]*)/i.exec(raw)
    const upperStrict = /(?:^|\s)<\s*([0-9][0-9A-Za-z.+-]*)/.exec(raw)
    const upperInclusive = /(?:^|\s)<=\s*([0-9][0-9A-Za-z.+-]*)/.exec(raw)
    const upperBefore = /(?:^|\s)before\s+([0-9][0-9A-Za-z.+-]*)/i.exec(raw)
    const lower = lowerInclusive || lowerStrict || lowerFrom
    const upper = upperInclusive || upperStrict || upperBefore
    if (!lower && !upper) return null
    const introduced = lower ? lower[1] : ''
    const fixed = upper ? upper[1] : ''
    if (introduced && fixed && compareVersion(introduced, fixed) === 1) {
      throw new Error('advisory affected range has a lower bound above its upper bound')
    }
    return {
      introduced,
      introducedInclusive: Boolean(lowerInclusive || lowerFrom),
      fixed,
      fixedInclusive: Boolean(upperInclusive),
    }
  }
  const normalizeRange = range => {
    if (typeof range === 'string') {
      const parsed = parseRangeText(range)
      if (parsed) return parsed
      throw new Error('advisory affected range is not understood; use {introduced,fixed} or a version interval')
    }
    const explicitRange = pick(range.range, range.interval, range.versionRange)
    if (explicitRange !== undefined) {
      const parsed = parseRangeText(explicitRange)
      if (parsed) return parsed
      throw new Error('advisory affected.range is not understood; use "[1.0.0,1.5.0)" or {introduced,fixed}')
    }
    const introduced = pick(range.introduced, range.introducedVersion, range.lower, range.from, range.min, range.since)
    const fixed = pick(range.fixed, range.fixedVersion, range.upper, range.to, range.max, range.before)
    if (introduced === undefined && fixed === undefined && !range.note) {
      throw new Error('advisory affected range needs introduced/fixed (or note); do not save an empty range')
    }
    const booleanAlias = (values, fallback) => {
      const found = pick(...values)
      if (found === undefined) return fallback
      if (found === true || /^(?:true|1|yes|inclusive)$/i.test(String(found))) return true
      if (found === false || /^(?:false|0|no|exclusive)$/i.test(String(found))) return false
      throw new Error('advisory range inclusivity must be boolean')
    }
    return {
      ...range,
      introduced,
      introducedInclusive: booleanAlias([range.introducedInclusive, range.lowerInclusive, range.fromInclusive], true),
      fixed,
      fixedInclusive: booleanAlias([range.fixedInclusive, range.upperInclusive, range.toInclusive], false),
    }
  }
  return {
    id,
    kind: String(document.kind || 'advisory').slice(0, 40),
    product,
    productKey: productKey(product),
    aliases: [...new Set(aliases.map(value => String(value).trim()).filter(Boolean))].slice(0, 30),
    affected: affected.map(normalizeRange).map(range => ({
      introduced: range.introduced === undefined ? '' : String(range.introduced).trim(),
      introducedInclusive: range.introducedInclusive !== false,
      fixed: range.fixed === undefined ? '' : String(range.fixed).trim(),
      fixedInclusive: range.fixedInclusive === true,
      note: range.note ? String(range.note).slice(0, 300) : '',
    })),
    conditions: (Array.isArray(document.conditions || document.preconditions)
      ? (document.conditions || document.preconditions)
      : (document.conditions || document.preconditions ? [document.conditions || document.preconditions] : [])).map(item => ({
      name: text(typeof item === 'string' ? item : item.name, 'advisory condition', 200),
      required: typeof item === 'string' ? true : item.required !== false,
    })).slice(0, 30),
    sourceRef,
    sourceKind: declared ? 'user-declared' : String(document.sourceKind || 'material').slice(0, 40),
    sourceLabel: String(document.sourceLabel || '').slice(0, 300),
    upstreamUrl: String(document.upstreamUrl || '').slice(0, 500),
    commit: String(document.commit || '').slice(0, 120),
    fixedVersion: String(document.fixedVersion || '').slice(0, 120),
    changedFiles: Array.isArray(document.changedFiles)
      ? document.changedFiles.map(value => String(value).slice(0, 300)).slice(0, 100) : [],
    changeSummary: String(document.changeSummary || '').slice(0, 2000),
    digest: digest(JSON.stringify(document)),
    importedAt: new Date().toISOString(),
  }
}

export function importComponentAdvisory(store, sessionId, input = {}) {
  ensureComponentSchema(store)
  const advisory = normalizeAdvisory(input, sessionId, store)
  store.db.prepare('INSERT INTO component_advisories(session_id,id,digest,record) VALUES(?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET digest=excluded.digest,record=excluded.record')
    .run(sessionId, advisory.id, advisory.digest, JSON.stringify(advisory))
  return { ok: true, advisory }
}

function readFact(store, sessionId, id) {
  const row = store.db.prepare('SELECT record FROM component_facts WHERE session_id=? AND id=?').get(sessionId, id)
  return row ? JSON.parse(row.record) : null
}
function readAdvisory(store, sessionId, id) {
  const row = store.db.prepare('SELECT record FROM component_advisories WHERE session_id=? AND id=?').get(sessionId, id)
  return row ? JSON.parse(row.record) : null
}
function rangeState(version, range) {
  const observed = parseVersion(version)
  if (!observed || observed.kind === 'unsupported') {
    return { state: 'unknown', reason: observed?.reason || 'observed version is not a supported version scheme' }
  }
  const hasLower = Boolean(range.introduced && range.introduced !== '0')
  const lower = hasLower ? compareVersion(version, range.introduced) : 0
  const upper = range.fixed ? compareVersion(version, range.fixed) : null
  if (lower === null || (range.fixed && upper === null)) {
    return { state: 'unknown', reason: 'advisory range contains an unsupported version' }
  }
  if (lower < 0 || (lower === 0 && hasLower && range.introducedInclusive === false)) {
    return { state: 'not-applicable', reason: `version ${version} is below the inclusive lower bound ${range.introduced}` }
  }
  if (range.fixed) {
    const outsideUpper = upper > 0 || (upper === 0 && range.fixedInclusive !== true)
    if (outsideUpper) {
      return {
        state: 'not-applicable',
        reason: `version ${version} is ${upper === 0 ? 'outside' : 'above'} the ${range.fixedInclusive ? 'inclusive' : 'exclusive'} upper bound ${range.fixed}`,
      }
    }
  }
  const leftBracket = range.introducedInclusive === false ? '(' : '['
  const rightBracket = range.fixedInclusive === true ? ']' : ')'
  return {
    state: 'applicable',
    reason: `version ${version} falls in ${leftBracket}${range.introduced || '0'}, ${range.fixed || '∞'}${rightBracket}`,
  }
}

export function evaluateComponent(store, sessionId, input = {}) {
  ensureComponentSchema(store)
  const raw = input.document && typeof input.document === 'object' && !Array.isArray(input.document) ? input.document : input
  const payload = raw.document && typeof raw.document === 'object' && !Array.isArray(raw.document) ? raw.document : raw
  let factId = pick(payload.factId, payload.componentId, payload.componentFactId, payload.observedId, payload.fact,
    input.factId, input.componentId, input.componentFactId)
  let advisoryId = pick(payload.advisoryId, payload.bulletinId, payload.advisory, input.advisoryId, input.bulletinId)
  if (payload.id !== undefined) {
    const value = String(payload.id)
    if (!factId && /^component-/i.test(value)) factId = payload.id
    if (!advisoryId && /^(?:ADV|CHANGE)[-_]/i.test(value)) advisoryId = payload.id
  }
  const fact = readFact(store, sessionId, String(factId || ''))
  const advisory = readAdvisory(store, sessionId, String(advisoryId || ''))
  if (!fact) throw new Error('component fact not found in current session')
  if (!advisory) throw new Error('component advisory not found in current session')
  const observedProductKey = productKey(fact.product || fact.productKey)
  const names = [advisory.product, ...(advisory.aliases || [])].map(productKey).filter(Boolean)
  const productIdentityKnown = Boolean(observedProductKey) && names.length > 0
  const productMatch = productIdentityKnown && names.includes(observedProductKey)
  const normalizeConditions = value => {
    if (!value) return {}
    if (Array.isArray(value)) {
      return Object.fromEntries(value.filter(item => item && item.name).map(item => [
        String(item.name),
        { state: pick(item.state, item.status, item.result), evidenceRef: pick(item.evidenceRef, item.evidenceId, item.receiptId, item.evidence, item.ref, '') },
      ]))
    }
    if (!value || typeof value !== 'object') return {}
    return Object.fromEntries(Object.entries(value).map(([name, item]) => {
      const row = typeof item === 'string' ? { state: item } : (item && typeof item === 'object' ? item : {})
      return [name, {
        ...row,
        state: pick(row.state, row.status, row.result),
        evidenceRef: pick(row.evidenceRef, row.evidenceId, row.receiptId, row.evidence, row.ref, ''),
      }]
    }))
  }
  const observed = normalizeConditions(payload.conditions || payload.conditionStates
    || payload.preconditions || input.conditions || input.conditionStates)
  const conditionRows = (advisory.conditions || []).map(condition => {
    const value = observed[condition.name] && typeof observed[condition.name] === 'object' ? observed[condition.name] : {}
    const state = ['satisfied', 'not-applicable', 'unknown'].includes(value.state) ? value.state : 'unknown'
    return { ...condition, state, evidenceRef: String(value.evidenceRef || '').slice(0, 200) }
  })
  const ranges = (advisory.affected || []).map(range => ({ ...range, ...rangeState(fact.version, range) }))
  let status = 'unknown'
  let reason = ''
  if (!productIdentityKnown) {
    status = 'unknown'
    reason = 'product identity is empty after normalisation; aliases must be explicit and traceable'
  } else if (!productMatch) {
    status = 'not-applicable'
    reason = `observed product ${fact.product} does not match advisory product ${advisory.product} or aliases`
  } else if (!fact.version) {
    status = 'unknown'
    reason = 'observed component has no trustworthy version'
  } else if (!ranges.length) {
    status = 'unknown'
    reason = 'advisory has no machine-checkable affected range'
  } else {
    const applicable = ranges.some(range => range.state === 'applicable')
    const notApplicable = ranges.every(range => range.state === 'not-applicable')
    if (notApplicable) { status = 'not-applicable'; reason = 'observed version is outside all affected ranges' }
    else if (!applicable) {
      status = 'unknown';
      const unknownRange = ranges.find(range => range.state === 'unknown');
      reason = ranges.every(range => range.state === 'unknown') && fact.version
        ? `observed version ${fact.version} cannot be compared with the advisory ranges: ${unknownRange?.reason || 'unsupported version scheme'}`
        : 'no affected range has sufficient data';
    }
    else if (conditionRows.some(condition => condition.required && condition.state === 'not-applicable')) {
      status = 'not-applicable'; reason = 'a required precondition is explicitly not applicable'
    } else if (conditionRows.some(condition => condition.required && condition.state !== 'satisfied')) {
      status = 'unknown'; reason = 'one or more required preconditions are not yet established'
    } else { status = 'applicable'; reason = 'version range and recorded preconditions match; target behavior still requires execution evidence' }
  }
  const evaluation = {
    id: 'component-eval-' + randomUUID(),
    factId: fact.id,
    advisoryId: advisory.id,
    advisoryKind: advisory.kind || 'advisory',
    status,
    reason,
    productMatch,
    versionMatch: ranges.some(range => range.state === 'applicable'),
    targetMapped: fact.targetMapped === true,
    ranges,
    conditions: conditionRows,
    sourceRefs: [fact.sourceRef, advisory.sourceRef],
    createdAt: new Date().toISOString(),
  }
  store.db.prepare('INSERT INTO component_evaluations(session_id,id,record) VALUES(?,?,?)').run(sessionId, evaluation.id, JSON.stringify(evaluation))
  return {
    ok: true,
    evaluation,
    next: status === 'applicable'
      ? 'Use the current authorized request/browser execution to verify the actual entry and behavior; a version match is only applicability.'
      : status === 'not-applicable'
        ? 'Record this as a negative applicability result and do not send an exploitation request for this advisory.'
        : 'Obtain the missing version or required precondition; do not infer vulnerability from the product name.',
  }
}

export function componentStatus(store, sessionId) {
  ensureComponentSchema(store)
  const facts = store.db.prepare('SELECT record FROM component_facts WHERE session_id=? ORDER BY rowid DESC').all(sessionId)
    .map(row => JSON.parse(row.record))
  const advisories = store.db.prepare('SELECT record FROM component_advisories WHERE session_id=? ORDER BY rowid DESC').all(sessionId)
    .map(row => JSON.parse(row.record))
  const evaluations = store.db.prepare('SELECT record FROM component_evaluations WHERE session_id=? ORDER BY rowid DESC LIMIT 50').all(sessionId)
    .map(row => JSON.parse(row.record))
  const upstreams = store.db.prepare('SELECT record FROM component_upstreams WHERE session_id=? ORDER BY rowid DESC LIMIT 50').all(sessionId)
    .map(row => { try { return JSON.parse(row.record) } catch { return null } }).filter(Boolean)
  return { ok: true, facts, advisories, evaluations, upstreams }
}
