// dsh-nday-hunter / catalog.js —— Nday 语料的读取、筛选与探针判定。
//
// 这一层刻意做成**纯函数**（除了读 catalog.json 本身不碰 IO）：
// 判定逻辑是整套能力里最容易被写错、也最容易被"看起来没问题"蒙过去的部分，
// 必须能在没有网络、没有宿主的情况下逐条断言。
//
// 一条硬规则贯穿全文件：**探针命中是筛选信号，不是漏洞结论**。
// 所以这里导出的词是 screen / signal / weight，而不是 vuln / confirmed。

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DSH_HOME } from './home.js'
import { expansionQueries } from './measurement-query.js'

export { expansionQueries }

/** 证据强度（探针自身能证明多少），不是漏洞确信度。 */
export const WEIGHT_ORDER = Object.freeze({ weak: 1, medium: 2, strong: 3 })

/** 屏幕结论：只描述"指纹层面看到了什么"。 */
export const VERDICT = Object.freeze({
  NO_SIGNAL: 'no-signal',
  WEAK: 'fingerprint-weak',
  MEDIUM: 'fingerprint-medium',
  STRONG: 'fingerprint-strong',
})

const PROBE_METHODS = new Set(['GET', 'POST', 'HEAD'])

/**
 * Resolve the installed Saker root (which carries `preset/pentest/refs/nday/`).
 * Order: explicit env → active profile's shared package → installed peer → source checkout.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [fromUrl] module URL used as the resolution anchor
 * @returns {string} absolute root, or '' when nothing resolves
 */
export function resolveSakerRoot(env = process.env, fromUrl = import.meta.url) {
  const explicit = String(env?.SAKER_ROOT || '').trim()
  if (explicit && fs.existsSync(path.join(explicit, 'package.json'))) return path.resolve(explicit)
  // pnpm can pin a peer dependency beneath the plugin's virtual-store path.
  // When the active profile also has a direct dsh-saker dependency, prefer that
  // shared package so an upgraded catalog is not shadowed by an older peer copy.
  const profileRoot = resolveProfileSakerRoot(fromUrl)
  if (profileRoot) return profileRoot
  try {
    const require = createRequire(fromUrl)
    const pkg = require.resolve('dsh-saker/package.json')
    return path.dirname(pkg)
  } catch {
    // Not installed (source checkout / tests): fall back below.
  }
  // plugins/dsh-nday-hunter/lib -> plugin -> plugins -> repository root
  const fallback = path.resolve(path.dirname(fileURLToPath(fromUrl)), '..', '..', '..')
  return fs.existsSync(path.join(fallback, 'package.json')) ? fallback : ''
}

function resolveProfileSakerRoot(fromUrl) {
  let current = path.dirname(fileURLToPath(fromUrl))
  while (current && path.dirname(current) !== current) {
    if (path.basename(current) === 'node_modules') {
      const profilePackage = path.join(path.dirname(current), 'package.json')
      try {
        const manifest = JSON.parse(fs.readFileSync(profilePackage, 'utf8'))
        const bundles = manifest?.dsh?.profile?.bundles
        if (manifest?.dependencies?.['dsh-saker'] && Array.isArray(bundles) && bundles.includes('dsh-saker')) {
          const candidate = path.join(current, 'dsh-saker')
          if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
        }
      } catch {
        // This ancestor is not a DSH profile package; keep walking upward.
      }
    }
    current = path.dirname(current)
  }
  return ''
}

/** Path of the Nday catalog inside a Saker root. */
export function catalogPath(sakerRoot, mode = 'pentest') {
  return path.join(sakerRoot, 'preset', mode, 'refs', 'nday', 'catalog.json')
}

/**
 * 用户层 Nday 语料路径。
 *
 * 为什么必须有这一层：随包语料是**只读**的（改了下次升级就被覆盖），
 * 但 Nday 是天天有新东西的——现场从 GitHub / 公众号找到一条，落不了库就等于白找。
 * 这里用的是 knowledge-hub 既有的分层约定：包层 `<sakerRoot>/preset/<mode>/refs`，
 * 用户层 `<DSH_HOME>/refs/<mode>/`（同名覆盖、可写、不随升级丢失）。
 * @param {string} home - DSH_HOME
 * @param {string} mode - preset id
 */
export function userCatalogPath(home, mode = 'pentest') {
  return path.join(home, 'refs', mode, 'nday', 'catalog.json')
}

/** 用户层条目文档目录（与 catalog 同级）。 */
export function userEntriesDir(home, mode = 'pentest') {
  return path.join(home, 'refs', mode, 'nday', 'entries')
}

/** Read + validate the catalog shape. Throws on malformed content. */
export function readCatalog(sakerRoot, { mode = 'pentest', readFileSync = fs.readFileSync } = {}) {
  const file = catalogPath(sakerRoot, mode)
  const raw = readFileSync(file, 'utf8')
  const parsed = JSON.parse(raw)
  if (parsed?.schema !== 'saker.nday.catalog/1') {
    throw new Error(`unsupported nday catalog schema: ${String(parsed?.schema)}`)
  }
  if (!Array.isArray(parsed.entries)) throw new Error('nday catalog has no entries array')
  return { ...parsed, file }
}

/**
 * 合并读取：包层 + 用户层。同 id **以用户层为准**（用户层可以覆盖包内条目）。
 * 每条的 `__source` 标出它来自哪层——输出里要如实说明"这条是我自己加的"。
 * 用户层坏掉不能拖垮包层：解析失败就静默回落，只在返回值里记数。
 */
export function loadMergedCatalog(sakerRoot, options = {}) {
  const {
    home = DSH_HOME,
    mode = 'pentest',
    readFileSync = fs.readFileSync,
    existsSync = fs.existsSync,
  } = options
  const bundled = readCatalog(sakerRoot, { mode, readFileSync })
  const byId = new Map(bundled.entries.map((entry) => [entry.id, { ...entry, __source: 'bundle' }]))
  const userFile = home ? userCatalogPath(home, mode) : ''
  let userEntries = 0
  let userError = ''
  if (userFile && existsSync(userFile)) {
    try {
      const parsed = JSON.parse(readFileSync(userFile, 'utf8'))
      if (parsed?.schema !== 'saker.nday.catalog/1' || !Array.isArray(parsed.entries)) {
        userError = '用户层 catalog 的 schema 或 entries 不合法，已忽略'
      } else {
        for (const entry of parsed.entries) {
          if (!entry || typeof entry.id !== 'string' || entry.id === '') continue
          byId.set(entry.id, { ...entry, __source: 'user' })
          userEntries += 1
        }
      }
    } catch (error) {
      userError = `用户层 catalog 读取失败（已忽略）：${String(error?.message || error)}`
    }
  }
  return {
    ...bundled,
    entries: [...byId.values()],
    userCatalogFile: userFile,
    userEntries,
    userError,
  }
}

/** Compact, model-facing view of one entry (keeps the payload small). */
export function summarizeEntry(entry) {
  return {
    id: entry.id,
    product: entry.product,
    vendor: entry.vendor,
    category: entry.category,
    vulnClass: entry.vulnClass,
    ids: entry.ids,
    severity: entry.severity,
    affectedVersions: entry.affectedVersions,
    auth: entry.auth,
    status: entry.status,
    reproduced: entry.verification?.reproduced === true,
    verify: entry.verify,
    probeCount: Array.isArray(entry.fingerprint?.probes) ? entry.fingerprint.probes.length : 0,
    exploitTools: entry.exploit?.tools ?? [],
    expansion: expansionQueries(entry),
    importedFrom: entry.importedFrom ?? null,
    source: entry.__source ?? 'bundle',
  }
}

/**
 * Filter entries for listing.
 * @param {object} catalog parsed catalog
 * @param {{ keyword?: string, status?: string, product?: string, category?: string, limit?: number }} [filter]
 */
export function listEntries(catalog, filter = {}) {
  const keyword = String(filter.keyword || '').trim().toLowerCase()
  const status = String(filter.status || '').trim().toLowerCase()
  const product = String(filter.product || '').trim().toLowerCase()
  const category = String(filter.category || '').trim().toLowerCase()
  const limit = Number.isFinite(filter.limit) && filter.limit > 0 ? Math.floor(filter.limit) : 50

  const rows = catalog.entries.filter((entry) => {
    if (status && String(entry.status || '').toLowerCase() !== status) return false
    if (product && !String(entry.product || '').toLowerCase().includes(product)) return false
    if (category && !String(entry.category || '').toLowerCase().includes(category)) return false
    if (keyword) {
      const haystack = [
        entry.id, entry.product, entry.vendor, entry.category, entry.vulnClass,
        ...(Array.isArray(entry.aliases) ? entry.aliases : []),
        entry.ids?.qvd, entry.ids?.cve, entry.ids?.cnvd,
        ...(Array.isArray(entry.affectedVersions) ? entry.affectedVersions : []),
      ].filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    return true
  })
  return rows.slice(0, limit)
}

/** Find one entry by exact id. */
export function getEntry(catalog, id) {
  const wanted = String(id || '').trim()
  return catalog.entries.find((entry) => entry.id === wanted) ?? null
}

/**
 * Candidate entries for a target, optionally narrowed by an explicit id list.
 * Kept separate from probing so callers can inspect the plan before touching a network.
 */
export function candidateEntries(catalog, entryIds) {
  if (!Array.isArray(entryIds) || entryIds.length === 0) return catalog.entries
  const wanted = new Set(entryIds.map((v) => String(v)))
  return catalog.entries.filter((entry) => wanted.has(entry.id))
}

/** Join a base URL with a probe path without losing the base's own path. */
export function probeUrl(base, probePath) {
  const trimmed = String(base || '').trim().replace(/\/+$/, '')
  const suffix = String(probePath || '/')
  if (!suffix.startsWith('/')) return `${trimmed}/${suffix}`
  return trimmed + suffix
}

/**
 * Normalize a pasted target list. Accepts commas, newlines and spaces.
 * A target without a scheme defaults to `http://` (pass a full URL to force https).
 * @returns {{ input: string, base: string }[]} de-duplicated, order preserved
 */
export function parseTargets(text) {
  const seen = new Set()
  const out = []
  for (const piece of String(text || '').split(/[\s,]+/)) {
    const input = piece.trim()
    if (!input) continue
    const base = /^https?:\/\//i.test(input) ? input : `http://${input}`
    const key = base.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ input, base })
  }
  return out
}

/**
 * Evaluate ONE machine-checkable probe against ONE observed response.
 *
 * Pure by design: the network layer only collects `{ status, body, headers }`,
 * all judgement happens here so it can be asserted in tests.
 * @param {object} probe catalog probe
 * @param {{ status?: number, body?: string, headers?: Record<string,string> }} response
 * @returns {{ hit: boolean, reason: string, weight: string }}
 */
/**
 * 单条 expectation 的判定（不含权重与重定向说明）。
 *
 * 抽出来是为了让**对照判定**复用同一套逻辑：随机对照路径必须用完全相同的判据去比，
 * 否则「这条判据不具区分度」的结论本身就是两套标准。
 * @returns {{ hit: boolean, reason: string }}
 */
function matchExpectation(probe, response = {}) {
  const expect = probe?.expect ?? {}
  const status = Number(response.status)
  const body = typeof response.body === 'string' ? response.body : ''
  // HTTP 头字段名大小写不敏感（RFC 9110 3.2），值大小写敏感。
  // 所以这里降成小写再比，且要求条目把特征串写成小写——否则运营者写 "Server: TongWeb"
  // 会永远匹配不上真实站点的 "server: TongWeb"。
  const headerBlob = Object.entries(response.headers ?? {})
    .map(([k, v]) => `${String(k).toLowerCase()}: ${v}`).join('\n').toLowerCase()
  const reasons = []
  const fail = (reason) => ({ hit: false, reason })

  const statusIn = Array.isArray(expect.statusIn) ? expect.statusIn : []
  if (statusIn.length > 0) {
    if (!Number.isFinite(status) || !statusIn.includes(status)) {
      return fail(`状态码 ${Number.isFinite(status) ? status : 'N/A'} 不在允许集合 ${statusIn.join('/')}`)
    }
    reasons.push(`状态码 ${status}`)
  }

  const statusNotIn = Array.isArray(expect.statusNotIn) ? expect.statusNotIn : []
  if (statusNotIn.length > 0) {
    if (!Number.isFinite(status) || statusNotIn.includes(status)) {
      return fail(`状态码 ${Number.isFinite(status) ? status : 'N/A'} 命中排除集合 ${statusNotIn.join('/')}`)
    }
    reasons.push(`状态码 ${status} 未被排除`)
  }

  const bodyNeedles = Array.isArray(expect.bodyContainsAny) ? expect.bodyContainsAny : []
  if (bodyNeedles.length > 0) {
    const needle = bodyNeedles.find((n) => typeof n === 'string' && body.includes(n))
    if (!needle) return fail('响应体未出现任何特征串')
    reasons.push(`响应体含 "${needle}"`)
  }

  const headerNeedles = Array.isArray(expect.headerContainsAny) ? expect.headerContainsAny : []
  if (headerNeedles.length > 0) {
    const needle = headerNeedles.find((n) => typeof n === 'string' && headerBlob.includes(n.toLowerCase()))
    if (!needle) return fail('响应头未出现任何特征串')
    reasons.push(`响应头含 "${needle}"`)
  }

  if (reasons.length === 0) return fail('探针没有可判定的 expectation')
  return { hit: true, reason: reasons.join('；') }
}

/**
 * Evaluate ONE machine-checkable probe against ONE observed response.
 *
 * @param {object} probe catalog probe
 * @param {{ status?: number, body?: string, headers?: Record<string,string>, redirect?: object }} response
 * @param {{ control?: object }} [options] `control` = 同一资产上**随机不存在路径**的响应。
 *   软 404 / SPA / WAF 统一响应下，「路径存在性」这类判据对任何路径都成立——
 *   语料里 53/63 条探针只看状态码，不设对照的话一台软 404 目标能让整库假命中。
 *   对照路径也满足同一判据时，该判据在这台目标上**没有区分度**，不算命中。
 * @returns {{ hit: boolean, reason: string, weight: string, suppressedByControl?: boolean }}
 */
export function evaluateProbe(probe, response = {}, { control } = {}) {
  const weight = WEIGHT_ORDER[probe?.weight] ? probe.weight : 'weak'
  // 重定向会改变判据看到的状态码与响应体，必须在理由里如实写出来：
  // 否则「跟随后仍不匹配」与「压根没跟随」在证据里长得一模一样。
  const redirectNote = response.redirect
    ? (response.redirect.followed
      ? `；跟随 ${response.redirect.chain.length} 次同主机重定向（最终 ${response.redirect.finalUrl}）`
      : `；被重定向到 ${response.redirect.to}（${response.redirect.reason}，未跟随）`)
    : ''
  const result = matchExpectation(probe, response)
  if (control) {
    const controlResult = matchExpectation(probe, control)
    if (controlResult.hit) {
      const contentBased = (Array.isArray(probe?.expect?.bodyContainsAny) && probe.expect.bodyContainsAny.length > 0)
        || (Array.isArray(probe?.expect?.headerContainsAny) && probe.expect.headerContainsAny.length > 0)
      if (!contentBased) {
        // 纯状态判据：统一响应下「路径存在」这件事本身没有信息量，直接压制。
        return {
          hit: false,
          reason: `对照路径（随机不存在路径）同样满足该判据：${controlResult.reason}`
            + `——软 404 / 统一响应下，路径存在性不具区分度${redirectNote}`,
          weight,
          suppressedByControl: true,
        }
      }
      // 内容判据（产品品牌 / 错误签名）：即使随机路径也命中，它仍然说明「这台就是该产品」——
      // SPA 用 try_files 把任意路径兜到同一页，压制会把**真实部署**判成没命中。
      // 所以保留命中，只把「路径不具区分度」如实标注出来。
      return {
        hit: result.hit,
        reason: result.hit
          ? `${result.reason}${redirectNote}；注意：随机对照路径也满足该判据（统一响应），这条只作**产品特征**，不能当路径存在的证据`
          : `${result.reason}${redirectNote}`,
        weight,
        ...(result.hit ? { uniformContent: true } : {}),
      }
    }
  }
  return { hit: result.hit, reason: result.reason + redirectNote, weight }
}

/**
 * Turn one asset's probe results into a screening verdict.
 * Deliberately never returns anything stronger than a fingerprint verdict.
 * @param {{ probe: object, result: { hit: boolean, reason: string, weight: string } }[]} outcomes
 * @returns {{ verdict: string, strongest: string|null, hits: object[] }}
 */
export function screenOutcome(outcomes = []) {
  const hits = outcomes.filter((o) => o?.result?.hit)
  if (hits.length === 0) return { verdict: VERDICT.NO_SIGNAL, strongest: null, hits: [] }
  let strongest = 'weak'
  for (const hit of hits) {
    const weight = WEIGHT_ORDER[hit.result.weight] ? hit.result.weight : 'weak'
    if (WEIGHT_ORDER[weight] > WEIGHT_ORDER[strongest]) strongest = weight
  }
  const verdict = strongest === 'strong' ? VERDICT.STRONG
    : strongest === 'medium' ? VERDICT.MEDIUM
      : VERDICT.WEAK
  return {
    verdict,
    strongest,
    hits: hits.map((hit) => ({
      probeId: hit.probe?.id,
      path: hit.probe?.path,
      weight: hit.result.weight,
      reason: hit.result.reason,
    })),
  }
}

/** Build the per-asset probe plan for one entry (URL + method + timeout). */
export function probePlan(entry, base, { timeoutMs = 6000 } = {}) {
  const probes = Array.isArray(entry?.fingerprint?.probes) ? entry.fingerprint.probes : []
  return probes
    .filter((probe) => probe && typeof probe.path === 'string')
    .map((probe) => ({
      probe,
      url: probeUrl(base, probe.path),
      method: PROBE_METHODS.has(probe.method) ? probe.method : 'GET',
      timeoutMs,
    }))
}

/** Flatten a catalog into the (entry, probe) pairs a batch run would execute. */
export function plannedProbeCount(entries) {
  return entries.reduce((total, entry) => total + probePlan(entry, 'http://x').length, 0)
}
