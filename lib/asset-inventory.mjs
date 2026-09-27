// Shared machine-readable asset inventory for recon and exploit planning.
//
// One fact source for every collector: FOFA/Hunter/Quake, httpx, nmap, fscan
// and imported TScanPlus exports all normalize into the same asset shape.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

export const INVENTORY_SCHEMA = 'saker.asset-inventory/1'
export const INVENTORY_FILE = 'asset-inventory.json'
export const ASSETS_MD = 'assets.md'
export const RECON_DIR = 'artifacts/recon'

const BLOCK_START = '<!-- asset-inventory:start -->'
const BLOCK_END = '<!-- asset-inventory:end -->'

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max)
}

function list(value) {
  if (!Array.isArray(value)) return value === undefined || value === null || value === '' ? [] : [clean(value, 200)]
  return [...new Set(value.map((item) => clean(item, 200)).filter(Boolean))]
}

function iso(value, fallback = '') {
  const text = clean(value, 80)
  if (!text) return fallback
  const time = Date.parse(text)
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback
}

function hostPortFromTarget(target) {
  try {
    const url = new URL(target)
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0)
    return { host: url.hostname, port }
  } catch {
    return { host: '', port: 0 }
  }
}

export function normalizeTarget(value) {
  const raw = clean(value, 1000)
  if (!raw) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(withScheme)
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return raw.replace(/\/+$/, '')
  }
}

function hashId(value) {
  return `asset-${createHash('sha1').update(value).digest('hex').slice(0, 12)}`
}

export function assetIdentityKeys(asset) {
  const out = []
  const target = normalizeTarget(asset?.target || asset?.url || asset?.host)
  if (target) out.push(`target:${target.toLowerCase()}`)
  const parsed = hostPortFromTarget(target)
  const host = clean(asset?.host || parsed.host, 300).toLowerCase()
  const port = Number(asset?.port || parsed.port) || 0
  if (host && port) out.push(`host:${host}:${port}`)
  const ip = clean(asset?.ip, 100).toLowerCase()
  if (ip && port) out.push(`ip:${ip}:${port}`)
  return out
}

function ipv4ToInt(value) {
  const parts = String(value || '').split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}

function inCidr(ip, cidr) {
  if (isIP(ip) !== 4) return false
  const [network, bitsText] = String(cidr || '').split('/')
  const bits = Number(bitsText)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const left = ipv4ToInt(ip)
  const right = ipv4ToInt(network)
  if (left === null || right === null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (left & mask) === (right & mask)
}

function scopeTerm(value) {
  const raw = clean(value, 500).replace(/^\*\./, '')
  if (!raw) return ''
  if (raw.includes('/') && isIP(raw.split('/')[0]) === 4) return raw
  if (isIP(raw)) return raw
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
    return url.hostname.toLowerCase()
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '')
  }
}

export function parseScope(scope) {
  const values = Array.isArray(scope) ? scope : String(scope || '').split(/[\s,;]+/)
  const terms = values.map((value) => {
    const raw = clean(value, 500)
    const wildcard = /^\*\./.test(raw) || /^[a-z][a-z0-9+.-]*:\/\/\*\./i.test(raw)
    const term = scopeTerm(raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)?\*\./i, '$1'))
    return term ? `${wildcard ? '*.' : ''}${term}` : ''
  }).filter(Boolean)
  return [...new Set(terms)]
}

function canonicalHost(value) {
  const raw = clean(value, 500)
  if (!raw || raw.includes('*')) return ''
  const unbracketed = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  if (isIP(unbracketed)) return unbracketed.toLowerCase()
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
    return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return ''
  }
}

function hostInScope(host, terms) {
  if (!host) return false
  if (isIP(host)) return terms.some((term) => !term.startsWith('*.') && isIP(term) && term === host)
  return terms.some((raw) => {
    const wildcard = raw.startsWith('*.')
    const term = wildcard ? raw.slice(2) : raw
    if (term.includes('/') || isIP(term)) return false
    return (!wildcard && host === term) || (wildcard && host !== term && host.endsWith(`.${term}`))
  })
}

function ipInScope(ip, terms) {
  if (!ip || !isIP(ip)) return false
  return terms.some((term) => {
    if (term.startsWith('*.')) return false
    if (isIP(term)) return ip === term
    if (term.includes('/') && isIP(term.split('/')[0]) === 4) return inCidr(ip, term)
    return false
  })
}

function safeOrigin(host, asset, parsedTarget) {
  const explicitProtocol = String(asset?.protocol || '').trim().toLowerCase().replace(/:$/, '')
  const protocol = parsedTarget && ['http:', 'https:'].includes(parsedTarget.protocol)
    ? parsedTarget.protocol
    : explicitProtocol === 'https' ? 'https:' : 'http:'
  const port = Number(asset?.port || parsedTarget?.port) || 0
  const urlHost = isIP(host) === 6 ? `[${host}]` : host
  const url = new URL(`${protocol}//${urlHost}`)
  if (port && !((protocol === 'http:' && port === 80) || (protocol === 'https:' && port === 443))) {
    url.port = String(port)
  }
  return url.origin
}

/**
 * Return a safe, scope-bound representation of an asset, or null when neither
 * its hostname nor its IP is authorized. If only the IP/CIDR is in scope,
 * replace any out-of-scope virtual host with that IP before an active probe.
 * Bare domains match exactly; `*.example.com` authorizes subdomains, not the apex.
 */
export function scopeSafeAsset(asset, scope) {
  const terms = parseScope(scope)
  if (terms.length === 0) return null
  const target = normalizeTarget(asset?.target || asset?.url)
  let parsedTarget = null
  try { parsedTarget = target ? new URL(target) : null } catch { /* handled as an absent target */ }
  const targetHost = String(parsedTarget?.hostname || '').toLowerCase()
  const candidates = [asset?.host, targetHost, asset?.domain]
    .map(canonicalHost)
    .filter((host, index, values) => host && values.indexOf(host) === index)
  const authorizedHost = candidates.find((host) => hostInScope(host, terms))
  if (authorizedHost) {
    const reportedIp = canonicalHost(asset?.ip)
    // FOFA often reports target=IP and host=authorized vhost. Keep the IP
    // connection but retain the in-scope Host name; never carry an unrelated
    // host from a shared-IP search result.
    const connectHost = isIP(targetHost) && (!reportedIp || targetHost === reportedIp)
      ? targetHost
      : authorizedHost
    return {
      ...asset,
      target: safeOrigin(connectHost, asset, parsedTarget),
      host: authorizedHost,
    }
  }

  const ipCandidates = [asset?.ip, targetHost, asset?.host]
    .map(canonicalHost)
    .filter((ip, index, values) => ip && isIP(ip) && values.indexOf(ip) === index)
  const authorizedIp = ipCandidates.find((ip) => ipInScope(ip, terms))
  if (!authorizedIp) return null
  return {
    ...asset,
    target: safeOrigin(authorizedIp, asset, parsedTarget),
    host: authorizedIp,
  }
}

export function matchesScope(asset, scope) {
  return scopeSafeAsset(asset, scope) !== null
}

export function normalizeAsset(input = {}, options = {}) {
  const now = iso(options.now, new Date().toISOString())
  const rawTarget = clean(input.target || input.url || input.host, 1000)
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawTarget)
  const explicitPort = /:(\d{1,5})(?:\/|$)/.exec(rawTarget)?.[1]
  const target = normalizeTarget(rawTarget)
  const parsed = hostPortFromTarget(target)
  const rawHost = clean(input.host, 300)
  const normalizedHost = rawHost && /^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost)
    ? hostPortFromTarget(normalizeTarget(rawHost)).host
    : rawHost
  const host = clean(normalizedHost || parsed.host, 300).toLowerCase()
  const port = Number(input.port || explicitPort || (hadScheme ? parsed.port : 0)) || 0
  const protocol = clean(input.protocol, 30).toLowerCase().replace(/:$/, '')
    || (target.startsWith('https:') ? 'https' : target.startsWith('http:') ? 'http' : '')
  const source = clean(options.source || input.source, 80)
  const sources = list([...(input.sources || []), source])
  const rawFiles = list([...(input.rawFiles || []), ...(options.rawFiles || [])])
  const tech = list(input.tech || input.technologies || input.fingerprint)
  const asset = {
    id: clean(input.id, 80),
    target: target || (host ? `${protocol || 'http'}://${host}${port && ![80, 443].includes(port) ? `:${port}` : ''}` : ''),
    host,
    ip: clean(input.ip, 100),
    port,
    protocol,
    title: clean(input.title, 300),
    server: clean(input.server, 200),
    tech,
    tags: list(input.tags),
    sources,
    authorized: input.authorized === true,
    firstSeen: iso(input.firstSeen, now),
    lastSeen: iso(input.lastSeen, now),
    rawFiles,
  }
  const keys = assetIdentityKeys(asset)
  if (!asset.id) asset.id = hashId(keys[0] || JSON.stringify(asset))
  return asset
}

function mergeAsset(base, incoming) {
  const out = { ...base }
  for (const field of ['target', 'host', 'ip', 'protocol', 'title', 'server']) {
    if (!out[field] && incoming[field]) out[field] = incoming[field]
  }
  if (!out.port && incoming.port) out.port = incoming.port
  out.tech = [...new Set([...(out.tech || []), ...(incoming.tech || [])])]
  out.tags = [...new Set([...(out.tags || []), ...(incoming.tags || [])])]
  out.sources = [...new Set([...(out.sources || []), ...(incoming.sources || [])])]
  out.rawFiles = [...new Set([...(out.rawFiles || []), ...(incoming.rawFiles || [])])]
  out.authorized = out.authorized === true || incoming.authorized === true
  out.firstSeen = out.firstSeen && incoming.firstSeen
    ? (Date.parse(out.firstSeen) <= Date.parse(incoming.firstSeen) ? out.firstSeen : incoming.firstSeen)
    : (out.firstSeen || incoming.firstSeen)
  out.lastSeen = out.lastSeen && incoming.lastSeen
    ? (Date.parse(out.lastSeen) >= Date.parse(incoming.lastSeen) ? out.lastSeen : incoming.lastSeen)
    : (out.lastSeen || incoming.lastSeen)
  return out
}

export function emptyInventory(now = new Date().toISOString()) {
  return { schema: INVENTORY_SCHEMA, updatedAt: now, assets: [] }
}

export function mergeAssets(inventory, incoming, options = {}) {
  const base = inventory?.schema === INVENTORY_SCHEMA && Array.isArray(inventory.assets)
    ? { ...inventory, assets: inventory.assets.map((asset) => normalizeAsset(asset)) }
    : emptyInventory(options.now)
  const assets = base.assets.slice()
  let added = 0
  let merged = 0
  for (const value of Array.isArray(incoming) ? incoming : [incoming]) {
    const asset = normalizeAsset(value, options)
    const keys = new Set(assetIdentityKeys(asset))
    const index = assets.findIndex((existing) => assetIdentityKeys(existing).some((key) => keys.has(key)))
    if (index >= 0) {
      assets[index] = mergeAsset(assets[index], asset)
      merged += 1
    } else {
      assets.push(asset)
      added += 1
    }
  }
  return {
    inventory: { ...base, updatedAt: iso(options.now, new Date().toISOString()), assets },
    added,
    merged,
  }
}

export function readInventory(workspace) {
  const file = path.join(String(workspace || ''), INVENTORY_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed?.schema === INVENTORY_SCHEMA && Array.isArray(parsed.assets)) {
      return { ...parsed, assets: parsed.assets.map((asset) => normalizeAsset(asset)) }
    }
  } catch { /* absent or invalid inventory is treated as empty */ }
  return emptyInventory()
}

function markdownFor(inventory) {
  const rows = inventory.assets
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((asset) => [
      asset.id,
      asset.target,
      asset.ip,
      asset.port || '',
      (asset.tech || []).join(', '),
      (asset.sources || []).join(', '),
      asset.authorized ? 'yes' : 'no',
    ].map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | '))
  return [
    BLOCK_START,
    `> Updated: ${inventory.updatedAt} · Assets: ${inventory.assets.length}`,
    '',
    '| ID | Target | IP | Port | Tech | Sources | Authorized |',
    '|---|---|---|---:|---|---|---|',
    ...rows.map((row) => `| ${row} |`),
    '',
    '## WAF',
    '',
    '未判定（侦察完成后由模型回填）。',
    '',
    '## 速率',
    '',
    '未设定（防护画像完成后由模型回填；缺省保守速率）。',
    BLOCK_END,
  ].join('\n')
}

function mergedMarkdown(existing, block) {
  const text = String(existing || '')
  const start = text.indexOf(BLOCK_START)
  const end = text.indexOf(BLOCK_END)
  if (start >= 0 && end > start) {
    return text.slice(0, start) + block + text.slice(end + BLOCK_END.length)
  }
  return text.trim()
    ? `${text.trimEnd()}\n\n${block}\n`
    : `# Asset Inventory\n\n${block}\n`
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

export function writeInventory(workspace, inventory) {
  const root = path.resolve(String(workspace || ''))
  if (!root) throw new Error('workspace is required')
  const normalized = {
    schema: INVENTORY_SCHEMA,
    updatedAt: iso(inventory?.updatedAt, new Date().toISOString()),
    assets: Array.isArray(inventory?.assets) ? inventory.assets.map((asset) => normalizeAsset(asset)) : [],
  }
  const file = path.join(root, INVENTORY_FILE)
  writeAtomic(file, JSON.stringify(normalized, null, 2) + '\n')
  const mdFile = path.join(root, ASSETS_MD)
  let existing = ''
  try { existing = fs.readFileSync(mdFile, 'utf8') } catch { /* first write */ }
  writeAtomic(mdFile, mergedMarkdown(existing, markdownFor(normalized)))
  return { inventory: normalized, file, mdFile }
}

export function upsertAssets(workspace, incoming, options = {}) {
  const current = readInventory(workspace)
  const merged = mergeAssets(current, incoming, options)
  const written = writeInventory(workspace, merged.inventory)
  return { ...written, added: merged.added, merged: merged.merged }
}

export function inventorySummary(inventory) {
  const assets = Array.isArray(inventory?.assets) ? inventory.assets : []
  return {
    total: assets.length,
    authorized: assets.filter((asset) => asset.authorized === true).length,
    withTech: assets.filter((asset) => (asset.tech || []).length > 0).length,
    sources: [...new Set(assets.flatMap((asset) => asset.sources || []))].sort(),
  }
}
