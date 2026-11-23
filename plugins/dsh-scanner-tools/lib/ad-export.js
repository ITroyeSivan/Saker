const OBJECT_LIMIT = 5000
const EDGE_LIMIT = 5000
const OBSERVATION_LIMIT = 300

const DANGEROUS_EDGE_KINDS = new Set([
  'adminto', 'genericall', 'genericwrite', 'writedacl', 'writeowner', 'owns',
  'forcechangepassword', 'addmember', 'allextendedrights', 'dcsync',
  'getchanges', 'getchangesall', 'readlapspassword', 'readgmsapassword',
  'addkeycredentiallink', 'writeaccountrestrictions', 'allowedtoact',
  'canrdp', 'canpsremote', 'executedcom',
])

function lowered(value) {
  return String(value ?? '').trim().toLowerCase()
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function ownValue(source, name) {
  const target = lowered(name)
  for (const [key, value] of Object.entries(objectValue(source) || {})) {
    if (lowered(key) === target) return value
  }
  return undefined
}

function prop(source, ...names) {
  const nested = objectValue(ownValue(source, 'Properties')) || objectValue(ownValue(source, 'properties'))
  for (const name of names) {
    const direct = ownValue(source, name)
    if (direct !== undefined) return direct
    const fromProperties = nested ? ownValue(nested, name) : undefined
    if (fromProperties !== undefined) return fromProperties
  }
  return undefined
}

function textProp(source, ...names) {
  const value = prop(source, ...names)
  return value === undefined || value === null ? '' : String(value).trim()
}

function boolProp(source, ...names) {
  const value = prop(source, ...names)
  return value === true || lowered(value) === 'true' || value === 1 || lowered(value) === '1'
}

function listProp(source, ...names) {
  const value = prop(source, ...names)
  if (Array.isArray(value)) return value.filter(item => item !== undefined && item !== null && String(item).trim() !== '')
  if (typeof value === 'string') return value.split(/[,;]/).map(item => item.trim()).filter(Boolean)
  return []
}

function normalizeType(value) {
  const type = lowered(value).replace(/[\s_-]+/g, '')
  if (!type) return 'unknown'
  if (type === 'users') return 'user'
  if (type === 'computers') return 'computer'
  if (type === 'groups') return 'group'
  if (type === 'domains') return 'domain'
  if (type === 'gpos' || type === 'groupolicyobject') return 'gpo'
  if (type === 'ous' || type === 'organizationalunit') return 'ou'
  if (type === 'containers') return 'container'
  return type
}

function objectType(source, hint = '') {
  return normalizeType(prop(source, 'ObjectType', 'objectType', 'type', 'kind', 'label') || hint)
}

function objectId(source, type) {
  return textProp(source, 'ObjectIdentifier', 'objectidentifier', 'objectId', 'objectid', 'sid', 'id')
    || textProp(source, 'distinguishedname', 'distinguishedName', 'dn')
    || textProp(source, 'samaccountname', 'samAccountName', 'name')
    || type + '-unknown'
}

function objectName(source) {
  return textProp(source, 'name', 'samaccountname', 'samAccountName', 'distinguishedname', 'distinguishedName')
    || textProp(source, 'ObjectIdentifier', 'objectidentifier', 'id')
    || '(unnamed)'
}

function risksFor(source, type) {
  const risks = []
  if (type === 'user' || type === 'computer') {
    if (listProp(source, 'serviceprincipalname', 'servicePrincipalName').length || boolProp(source, 'hasspn')) risks.push('kerberoastable')
    if (boolProp(source, 'dontreqpreauth')) risks.push('asrep-roastable')
    if (boolProp(source, 'unconstraineddelegation')) risks.push('unconstrained-delegation')
    const allowed = listProp(source, 'allowedtodelegate', 'allowedToDelegate')
    if (allowed.length && !allowed.every(value => lowered(value) === 'notdelegated')) risks.push('constrained-delegation')
    if (boolProp(source, 'msds-allowedtoactonbehalfofotheridentity') || textProp(source, 'msds-allowedtoactonbehalfofotheridentity')) risks.push('rbcd')
    if (boolProp(source, 'admincount')) risks.push('admincount')
    if (boolProp(source, 'pwdneverexpires')) risks.push('password-never-expires')
    if (listProp(source, 'sidhistory', 'sidHistory').length) risks.push('sid-history')
  }
  return risks
}

function observation(kind, subject, detail) {
  return { kind, subject: String(subject || '(unknown)'), detail: String(detail || '') }
}

function edgeKind(source) {
  return lowered(prop(source, 'type', 'kind', 'label', 'edgeType', 'edge')).replace(/[^a-z0-9]/g, '')
}

function edgeEnd(source, side) {
  return textProp(source, side, side === 'from' ? 'source' : 'target', side === 'from' ? 'sourceId' : 'targetId')
    || textProp(source, side === 'from' ? 'source' : 'target', side === 'from' ? 'fromId' : 'toId')
}

export function parseAdExport(text, options = {}) {
  let payload
  try {
    payload = JSON.parse(String(text ?? ''))
  } catch (error) {
    throw new Error('AD 导出必须是 JSON：' + error.message)
  }
  const source = lowered(options.source || 'auto') || 'auto'
  const objects = []
  const edges = []
  const observations = []
  const warnings = []
  const byType = {}
  const seenIds = new Set()
  const seenEdges = new Set()
  let truncated = false

  const addObject = (value, hint = '') => {
    const sourceObject = objectValue(value)
    if (!sourceObject) return
    const type = objectType(sourceObject, hint)
    if (type === 'unknown' && !prop(sourceObject, 'ObjectIdentifier', 'objectidentifier', 'id', 'name')) return
    const id = objectId(sourceObject, type)
    const key = type + ':' + id
    if (seenIds.has(key)) return
    seenIds.add(key)
    const risks = risksFor(sourceObject, type)
    byType[type] = (byType[type] || 0) + 1
    if (objects.length < OBJECT_LIMIT) {
      objects.push({ id, type, name: objectName(sourceObject), risks })
    } else {
      truncated = true
    }
    for (const risk of risks) {
      if (observations.length >= OBSERVATION_LIMIT) {
        truncated = true
        break
      }
      observations.push(observation(risk, objectName(sourceObject), '对象 ' + id + ' 的属性命中 ' + risk + '；这是候选，不是可利用证明'))
    }
    const aces = prop(sourceObject, 'Aces', 'aces')
    if (Array.isArray(aces)) {
      for (const ace of aces) {
        if (!objectValue(ace)) continue
        const right = lowered(prop(ace, 'RightName', 'rightName', 'right', 'type'))
        const normalized = right.replace(/[^a-z0-9]/g, '')
        if (!DANGEROUS_EDGE_KINDS.has(normalized)) continue
        if (observations.length >= OBSERVATION_LIMIT) {
          truncated = true
          break
        }
        const principal = textProp(ace, 'PrincipalSID', 'principalSid', 'principal', 'principalId') || '(unknown principal)'
        observations.push(observation('path-candidate', principal, 'ACL ' + String(prop(ace, 'RightName', 'rightName', 'right') || right)
          + ' → ' + objectName(sourceObject) + '；需要身份、可达性和实际权限验证'))
      }
    }
  }

  const addEdge = value => {
    const edge = objectValue(value)
    if (!edge) return
    const kind = edgeKind(edge)
    if (!kind) return
    const from = edgeEnd(edge, 'from')
    const to = edgeEnd(edge, 'to')
    const key = kind + ':' + from + ':' + to
    if (seenEdges.has(key)) return
    seenEdges.add(key)
    if (edges.length < EDGE_LIMIT) edges.push({ type: kind, from, to })
    else truncated = true
    if (DANGEROUS_EDGE_KINDS.has(kind) && observations.length < OBSERVATION_LIMIT) {
      observations.push(observation('path-candidate', from || '(unknown)', kind + ' → ' + (to || '(unknown)') + '；图上的边不等于可利用'))
    } else if (DANGEROUS_EDGE_KINDS.has(kind)) {
      truncated = true
    }
  }

  const walk = (value, hint = '') => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, hint)
      return
    }
    const current = objectValue(value)
    if (!current) return
    if (Array.isArray(prop(current, 'nodes', 'vertices'))) {
      for (const node of prop(current, 'nodes', 'vertices')) addObject(node, 'node')
      for (const edge of (prop(current, 'edges', 'links') || [])) addEdge(edge)
      return
    }
    if (Array.isArray(prop(current, 'data'))) {
      const meta = objectValue(prop(current, 'meta')) || {}
      walk(prop(current, 'data'), textProp(meta, 'type'))
      return
    }
    if (Array.isArray(prop(current, 'objects'))) {
      for (const item of prop(current, 'objects')) addObject(item, hint)
      return
    }
    const collections = ['users', 'computers', 'groups', 'domains', 'gpos', 'ous', 'containers']
    let walkedCollection = false
    for (const name of collections) {
      const collection = prop(current, name)
      if (Array.isArray(collection)) {
        walkedCollection = true
        for (const item of collection) addObject(item, name)
      }
    }
    if (walkedCollection) return
    if (Array.isArray(prop(current, 'edges', 'links'))) {
      for (const edge of prop(current, 'edges', 'links')) addEdge(edge)
      return
    }
    if (prop(current, 'ObjectIdentifier', 'objectidentifier', 'ObjectType', 'objectType', 'Properties', 'properties')) {
      addObject(current, hint)
      return
    }
    const nested = ['graph', 'result', 'items', 'records']
    for (const name of nested) {
      if (prop(current, name) !== undefined) {
        walk(prop(current, name), hint)
        return
      }
    }
  }

  walk(payload)
  let format = source === 'auto' ? 'unknown' : source
  if (source === 'auto') {
    if (objectValue(payload) && (Array.isArray(prop(payload, 'nodes', 'vertices')) || Array.isArray(prop(payload, 'edges', 'links')))) format = 'adalanche'
    else if (Array.isArray(payload) || (objectValue(payload) && (Array.isArray(prop(payload, 'data')) || Array.isArray(prop(payload, 'users'))))) format = 'sharphound'
    else if (objectValue(payload) && prop(payload, 'ObjectIdentifier', 'objectidentifier', 'ObjectType', 'objectType')) format = 'sharphound'
  }
  if (format === 'unknown') format = edges.length ? 'adalanche' : 'generic'
  if (observations.length >= OBSERVATION_LIMIT) truncated = true
  if (truncated) warnings.push('输入超过归一化上限，已截断对象/边/观察；完整原始输入仍保留在证据文件。')
  warnings.push('导入解析不等于已采集；对象属性、ACL 和图边只是候选，不等于可利用，必须结合身份、可达性和实际权限验证。')
  return {
    ok: true,
    format,
    counts: {
      objects: objects.length,
      edges: edges.length,
      byType,
      candidatePaths: observations.filter(item => item.kind === 'path-candidate').length,
      observations: observations.length,
      truncated,
    },
    observations,
    objects,
    edges,
    warnings,
    importedAt: new Date().toISOString(),
  }
}

export function summarizeAdExport(result) {
  const counts = result?.counts || {}
  const types = Object.entries(counts.byType || {}).map(([type, count]) => type + '=' + count).join(', ') || '无对象'
  return 'AD 导出解析：' + String(result?.format || 'generic') + '；对象 ' + String(counts.objects || 0)
    + '（' + types + '），边 ' + String(counts.edges || 0) + '，候选路径 ' + String(counts.candidatePaths || 0)
    + '。' + (counts.truncated ? '结果已截断。' : '') + '候选不等于可利用，需结合身份和实际权限验证。'
}
