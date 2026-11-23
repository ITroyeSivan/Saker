// Import a raw .http request without sending it. Authentication headers are
// split into a session-local secret record; the model only receives opaque
// requestRef/credentialRef values and never needs to copy a token or cookie.
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { readTaskContext, saveTaskContext } from './task-context.js'
import { effectivePolicy, readTaskPolicy } from './task-policy.js'
import { taskScopeIncludesUrl } from './task-scope.js'

export const REQUEST_CREDENTIAL_SCHEMA = `CREATE TABLE IF NOT EXISTS request_credentials (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  secret TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id,id)
)`

const SECRET_HEADERS = /^(?:authorization|proxy-authorization|cookie|x-api-key|x-auth-token)$/i
const METHOD_LINE = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)[ \t]+(\S+)[ \t]+HTTP\/1(?:\.[01])?$/
const digest = value => createHash('sha256').update(value).digest('hex')

export function ensureRequestCredentialSchema(store) {
  store.db.exec(REQUEST_CREDENTIAL_SCHEMA)
}

function materialText(store, sessionId, materialId) {
  const row = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?')
    .get(String(sessionId), String(materialId))
  if (!row) throw new Error('材料不存在或不属于当前会话')
  let record
  try { record = JSON.parse(row.record) } catch { throw new Error('材料记录损坏，不能导入请求') }
  if (typeof record.file !== 'string' || !record.file) throw new Error('材料没有可读取的原文文件')
  let bytes
  try { bytes = fs.readFileSync(record.file) } catch (error) { throw new Error('材料原文不可读：' + error.message) }
  if (bytes.length > 64 * 1024) throw new Error('单个 .http 请求最多 64KB')
  return { text: bytes.toString('utf8'), digest: record.digest || digest(bytes), name: record.name || materialId }
}

function splitDocuments(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const parts = normalized.split(/^[ \t]*###(?:[^\n]*)$/m)
  return parts.map(part => part.trim()).filter(Boolean)
}

function parseDocument(text, policy) {
  const lines = text.split('\n')
  let start = -1
  for (let index = 0; index < lines.length; index++) {
    if (METHOD_LINE.test(lines[index].trim())) { start = index; break }
  }
  if (start < 0) throw new Error('材料中没有找到 HTTP/1.1 请求行')
  const first = METHOD_LINE.exec(lines[start].trim())
  const method = first[1]
  const requestTarget = first[2]
  const headers = []
  let cursor = start + 1
  for (; cursor < lines.length && lines[cursor] !== ''; cursor++) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(lines[cursor])
    if (!match) throw new Error(`请求头第 ${cursor - start} 行格式不正确`)
    if (/[\r\n]/.test(match[2])) throw new Error('请求头不能包含换行')
    headers.push({ name: match[1], value: match[2] })
  }
  if (cursor < lines.length && lines[cursor] === '') cursor++
  const body = lines.slice(cursor).join('\n')
  let endpoint
  if (/^https?:\/\//i.test(requestTarget)) {
    endpoint = new URL(requestTarget)
  } else {
    const host = headers.find(header => header.name.toLowerCase() === 'host')?.value || ''
    if (!host) throw new Error('相对请求目标没有 Host 头，无法确定完整 URL')
    let scheme = host.endsWith(':443') ? 'https' : 'http'
    try {
      const expected = new URL(String(policy?.primaryTarget || ''))
      if (expected.host.toLowerCase() === host.toLowerCase()) scheme = expected.protocol.replace(':', '')
    } catch { /* use the explicit Host/port default */ }
    endpoint = new URL(requestTarget, `${scheme}://${host}`)
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new Error('只支持普通 HTTP(S) 请求，且 URL 不能内嵌账号密码')
  endpoint.hash = ''
  const secrets = headers.filter(header => SECRET_HEADERS.test(header.name))
  const publicHeaders = headers.filter(header => !SECRET_HEADERS.test(header.name))
  const lower = new Set(publicHeaders.map(header => header.name.toLowerCase()))
  if (!lower.has('host')) publicHeaders.unshift({ name: 'Host', value: endpoint.host })
  if (body && !lower.has('content-length'))
    publicHeaders.push({ name: 'Content-Length', value: String(Buffer.byteLength(body)) })
  const wire = method + ' ' + endpoint.pathname + endpoint.search + ' HTTP/1.1\r\n'
    + publicHeaders.map(header => header.name + ': ' + header.value).join('\r\n')
    + '\r\n\r\n' + body
  return {
    method,
    endpoint: endpoint.href,
    origin: endpoint.origin,
    body,
    headers: Object.fromEntries(publicHeaders.map(header => [header.name, header.value])),
    request: wire,
    secrets,
  }
}

function writeCredential(store, sessionId, secrets, material) {
  if (!secrets.length) return ''
  const serialized = secrets.map(header => header.name + ': ' + header.value).join('\r\n')
  const id = 'credential-' + digest(serialized + '\0' + material.digest).slice(0, 24)
  const kinds = [...new Set(secrets.map(header => header.name.toLowerCase() === 'cookie' ? 'cookie' : 'authorization'))]
  store.db.prepare(`INSERT INTO request_credentials(session_id,id,kind,secret,source,created_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET
      kind=excluded.kind,secret=excluded.secret,source=excluded.source`)
    .run(String(sessionId), id, kinds.join('+'), serialized, 'material:' + material.name, Date.now())
  return id
}

export function importRequestMaterial(store, sessionId, { materialId, identityRef = '' } = {}) {
  if (!materialId) throw new Error('importRequest 需要材料 ID')
  ensureRequestCredentialSchema(store)
  const policy = readTaskPolicy(store, sessionId)
  if (!policy) throw new Error('先启动当前测试任务，再导入原始请求；资料保留不会丢失')
  const limits = effectivePolicy(store, policy)
  const material = materialText(store, sessionId, materialId)
  const documents = splitDocuments(material.text)
  if (!documents.length) throw new Error('材料中没有 HTTP 请求')
  const parsed = documents.map(document => parseDocument(document, limits))
  for (const request of parsed) {
    if (!taskScopeIncludesUrl(limits, new URL(request.endpoint)))
      throw new Error(`请求 ${request.method} ${request.endpoint} 不在当前授权范围，未建立可执行引用`)
  }
  const context = readTaskContext(store, sessionId) || { assets: [], checks: [], requests: [], methods: [], maxSupplementAttempts: 2 }
  const imported = []
  for (const request of parsed) {
    const credentialRef = writeCredential(store, sessionId, request.secrets, material)
    // Two accounts commonly send byte-identical public requests. The public
    // packet alone is not an identity-safe dedupe key: importing Beta after
    // Alpha must not overwrite Alpha's credentialRef.
    const requestDigest = digest(request.request + '\0' + (credentialRef || 'no-credential'))
    const id = 'request-import-' + requestDigest.slice(0, 20)
    const revision = 'r-' + requestDigest.slice(0, 16)
    const existing = context.requests.find(row => row.id === id && row.revision === revision)
    const row = {
      id,
      revision,
      endpoint: request.endpoint,
      method: request.method,
      headers: request.headers,
      body: request.body,
      request: request.request,
      authContext: String(existing?.authContext || identityRef || 'request-material').trim(),
      identityHint: String(existing?.identityHint || identityRef || '').trim(),
      identityBound: false,
      credentialRef,
      credentialOrigin: request.secrets.length ? 'request-material' : '',
      credentialHeaderKinds: [...new Set(request.secrets.map(header => header.name.toLowerCase()))],
      importedFromMaterialId: materialId,
      importDigest: material.digest,
      source: 'attachment .http import',
    }
    if (!existing) context.requests.push(row)
    else Object.assign(existing, row)
    if (!context.assets.some(asset => new URL(asset.url).origin === request.origin)) {
      context.assets.push({
        id: 'asset-import-' + digest(request.origin).slice(0, 16),
        url: request.origin,
        reachable: false,
        inScope: true,
        source: 'attachment .http import',
        firstSeen: new Date().toISOString(),
      })
    }
    imported.push({
      requestId: id,
      requestRevision: revision,
      requestRef: id + ':' + revision,
      method: request.method,
      endpoint: request.endpoint,
      authContext: row.authContext,
      identityHint: row.identityHint,
      credentialRef,
      credentialHeaderKinds: row.credentialHeaderKinds,
      identityStatus: credentialRef ? 'request-material-unbound' : (identityRef ? 'label-unverified' : 'no-auth-header'),
      reused: Boolean(existing),
    })
  }
  try {
    saveTaskContext(store, sessionId, context)
  } catch (error) {
    const ids = imported.map(item => item.credentialRef).filter(Boolean)
    for (const id of ids) store.db.prepare('DELETE FROM request_credentials WHERE session_id=? AND id=?').run(sessionId, id)
    throw error
  }
  return {
    ok: true,
    materialId,
    materialName: material.name,
    requests: imported,
    requestRefs: imported.map(item => item.requestRef),
    note: '认证头已从模型可见请求中移除并保存在本会话；执行时由宿主回填。credentialRef 不绑定真实账号，除非你另行选择并核对账号。',
  }
}

export function readRequestCredential(store, sessionId, reference) {
  ensureRequestCredentialSchema(store)
  const row = store.db.prepare('SELECT * FROM request_credentials WHERE session_id=? AND id=?').get(String(sessionId), String(reference))
  if (!row) return null
  return { id: row.id, kind: row.kind, secret: row.secret, source: row.source }
}

export function requestCredentialHeaders(store, sessionId, row, parsed, { authSource = '' } = {}) {
  if (!row?.credentialRef || authSource === 'account') return null
  const credential = readRequestCredential(store, sessionId, row.credentialRef)
  if (!credential) throw new Error('请求凭据引用不存在；请重新导入原始请求')
  const existing = Object.keys(parsed.headers || {}).filter(name => SECRET_HEADERS.test(name))
  if (existing.length) return null
  const headers = { ...parsed.headers }
  for (const line of credential.secret.split(/\r?\n/)) {
    if (!line) continue
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line)
    if (!match || !SECRET_HEADERS.test(match[1]) || /[\r\n]/.test(match[2]))
      throw new Error('保存的请求凭据格式损坏；请重新导入原始请求')
    headers[match[1]] = match[2]
  }
  return { headers, source: 'request-material', credentialRef: credential.id, kind: credential.kind }
}

function composePublicRequest(method, endpoint, headers, body) {
  const url = new URL(endpoint)
  const clean = {}
  for (const [name, value] of Object.entries(headers || {})) {
    if (SECRET_HEADERS.test(name) || /^(?:host|content-length)$/i.test(name)) continue
    clean[name] = String(value).replace(/[\r\n]+/g, ' ')
  }
  clean.Host = url.host
  if (body && !Object.keys(clean).some(name => /^content-length$/i.test(name)))
    clean['Content-Length'] = String(Buffer.byteLength(body))
  return {
    method,
    endpoint: url.href,
    headers: clean,
    body,
    request: method + ' ' + url.pathname + url.search + ' HTTP/1.1\r\n'
      + Object.entries(clean).map(([name, value]) => name + ': ' + value).join('\r\n')
      + '\r\n\r\n' + body,
  }
}

/**
 * Derive a new request from an imported request without exposing its secret.
 * The new row keeps the same credentialRef and identity label; only endpoint,
 * method, safe headers and body can change.
 */
export function deriveRequest(store, sessionId, input = {}) {
  const context = readTaskContext(store, sessionId)
  if (!context) throw new Error('当前任务还没有共享上下文')
  const rawRef = String(input.sourceRequestRef || '')
  const [refId, refRevision] = rawRef.includes(':') ? rawRef.split(':') : ['', '']
  const sourceId = String(input.sourceRequestId || refId || '')
  const sourceRevision = String(input.sourceRequestRevision || refRevision || '')
  const source = (context.requests || []).find(row => row.id === sourceId
    && (!sourceRevision || row.revision === sourceRevision))
  if (!source) throw new Error('派生请求的来源请求不存在')
  if (!source.credentialRef)
    throw new Error('来源请求没有宿主凭据引用；请先用 importRequest 导入原始请求')
  const base = new URL(source.endpoint)
  let endpoint
  if (input.endpoint !== undefined) endpoint = new URL(String(input.endpoint), base)
  else endpoint = new URL(base.href)
  if (input.query && typeof input.query === 'object' && !Array.isArray(input.query)) {
    for (const [name, value] of Object.entries(input.query)) {
      if (value === undefined || value === null) endpoint.searchParams.delete(name)
      else endpoint.searchParams.set(name, String(value))
    }
  }
  if (endpoint.origin !== base.origin) throw new Error('派生请求不能跨 origin')
  endpoint.hash = ''
  const method = String(input.method || source.method || 'GET').toUpperCase()
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new Error('派生请求方法无效')
  const body = input.body === undefined ? (['GET', 'HEAD'].includes(method) ? '' : String(source.body || '')) : String(input.body)
  const mergedHeaders = { ...(source.headers || {}), ...(input.headers && typeof input.headers === 'object' ? input.headers : {}) }
  const composed = composePublicRequest(method, endpoint.href, mergedHeaders, body)
  const requestDigest = digest(composed.request + '\0' + (source.credentialRef || 'no-credential'))
  const row = {
    ...source,
    id: 'request-derived-' + requestDigest.slice(0, 20),
    revision: 'r-' + requestDigest.slice(0, 16),
    ...composed,
    source: 'derived from ' + source.id + ':' + source.revision,
    derivedFromRequestId: source.id,
    derivedFromRequestRevision: source.revision,
  }
  const existing = context.requests.find(item => item.id === row.id && item.revision === row.revision)
  if (!existing) context.requests.push(row)
  else Object.assign(existing, row)
  saveTaskContext(store, sessionId, context)
  return {
    requestId: row.id,
    requestRevision: row.revision,
    requestRef: row.id + ':' + row.revision,
    endpoint: row.endpoint,
    method: row.method,
    credentialRef: row.credentialRef || '',
    identityHint: row.identityHint || '',
    reused: Boolean(existing),
  }
}
