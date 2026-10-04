// Free/public Nday source adapters.
//
// These adapters are deliberately limited to public information sources. They
// return candidate records only; they never treat a search hit as a confirmed
// vulnerability. WeChat has no official open search API, so the adapter uses
// Sogou's public article search page and reports anti-bot/verification pages
// honestly instead of fabricating results.

import http from 'node:http'
import https from 'node:https'
import { attachApiDocument } from './api-source-document.js'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 20000
const SOURCE_CACHE = new Map()

export const FREE_SOURCE_IDS = Object.freeze([
  'cisa-kev',
  'nvd',
  'osv',
  'github-advisories',
  'nuclei',
  'wechat',
])

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
}

function stripHtml(value) {
  return decodeEntities(String(value ?? '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
}

function idsIn(value) {
  const text = String(value ?? '')
  return [...new Set([
    ...[...text.matchAll(/\bCVE-\d{4}-\d{4,}\b/gi)].map((match) => match[0].toUpperCase()),
    ...[...text.matchAll(/\bGHSA-[a-z0-9-]{4,}\b/gi)].map((match) => match[0].toUpperCase()),
    ...[...text.matchAll(/\bCNVD-(?:C-)?\d{4}-\d{4,7}\b/gi)].map((match) => match[0].toUpperCase()),
  ])]
}

function queryTerms(query) {
  return clean(query, 300).toLowerCase().split(/\s+/).filter(Boolean)
}

function matchesQuery(text, query) {
  const terms = queryTerms(query)
  if (terms.length === 0) return true
  const haystack = String(text ?? '').toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

function limitOf(value, fallback = 20, max = 100) {
  return Math.max(1, Math.min(max, Number(value) || fallback))
}

function candidate(source, row) {
  const ids = [...new Set([...(row.ids ?? []), ...idsIn(`${row.title ?? ''} ${row.summary ?? ''} ${row.url ?? ''}`)])]
  return {
    schema: 'saker.nday.source-candidate/1',
    source,
    sourceKind: row.sourceKind || 'public',
    id: clean(row.id || ids[0] || '', 160),
    title: clean(row.title || row.id || '', 300),
    summary: clean(row.summary || '', 1200),
    published: clean(row.published || '', 80),
    modified: clean(row.modified || row.published || '', 80),
    withdrawnAt: clean(row.withdrawnAt || '', 80),
    status: clean(row.status || 'active', 60),
    url: clean(row.url || '', 500),
    ids,
    products: [...new Set((row.products ?? []).map((item) => clean(item, 120)).filter(Boolean))].slice(0, 20),
    evidenceLevel: 'candidate',
  }
}

function responseLimit(options) {
  if (options.maxBytes === undefined) return Infinity
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error('maxBytes 必须是正整数')
  return options.maxBytes
}

function oversized(options) {
  return new Error(`${options.label || 'source'} 响应超过 ${options.maxBytes} 字节上限`)
}

async function boundedText(response, options, controller) {
  const limit = responseLimit(options)
  const declared = Number(response.headers?.get?.('content-length'))
  if (declared > limit) { controller.abort(); throw oversized(options) }
  if (limit !== Infinity && response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) { controller.abort(); await reader.cancel().catch(() => {}); throw oversized(options) }
        chunks.push(Buffer.from(value))
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally { reader.releaseLock() }
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > limit) throw oversized(options)
  return text
}

async function fetchText(url, options = {}, fetchImpl = globalThis.fetch) {
  responseLimit(options)
  if (typeof fetchImpl !== 'function') throw new Error('当前宿主没有可用的 fetch')
  if (options.preferRaw === true && fetchImpl === globalThis.fetch) {
    return rawRequestText(url, options)
  }
  const attempts = Math.max(1, Math.min(3, Number(options.attempts) || 2))
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, {
        method: options.method || 'GET',
        headers: {
          accept: options.accept || '*/*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
          'user-agent': USER_AGENT,
          ...(options.headers ?? {}),
        },
        body: options.body,
        signal: controller.signal,
        redirect: 'follow',
      })
      const text = await boundedText(response, options, controller)
      if (!response.ok) throw new Error(`${options.label || 'source'} HTTP ${response.status}: ${text.slice(0, 180)}`)
      options.onResponse?.(response.headers)
      return text
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 600))
    } finally {
      clearTimeout(timeout)
    }
  }
  const error = lastError
  if (error?.name === 'AbortError') throw new Error(`${options.label || 'source'} 请求超时`)
  if (error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') throw new Error(`${options.label || 'source'} 连接超时（已重试 ${attempts} 次）`)
  throw error
}

function rawRequestText(url, options = {}, redirects = 0) {
  const limit = responseLimit(options)
  return new Promise((resolve, reject) => {
    let target
    try { target = new URL(url) } catch { reject(new Error(`无效 URL：${url}`)); return }
    const mod = target.protocol === 'https:' ? https : http
    const request = mod.request(target, {
      method: options.method || 'GET',
      headers: {
        accept: options.accept || '*/*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
        'user-agent': USER_AGENT,
        connection: 'close',
        ...(options.headers ?? {}),
      },
      timeout: Number(options.timeoutMs) || 30000,
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location && redirects < 4) {
        response.resume()
        const next = new URL(response.headers.location, target).toString()
        resolve(rawRequestText(next, options, redirects + 1))
        return
      }
      const chunks = []
      let size = 0
      if (Number(response.headers['content-length']) > limit) {
        const error = oversized(options)
        reject(error)
        response.destroy()
        request.destroy(error)
        return
      }
      response.on('error', reject)
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          const error = oversized(options)
          reject(error)
          response.destroy()
          request.destroy(error)
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if ((response.statusCode || 0) >= 400) {
          reject(new Error(`${options.label || 'source'} HTTP ${response.statusCode}: ${text.slice(0, 180)}`))
          return
        }
        options.onResponse?.({ get: name => response.headers[String(name).toLowerCase()] ?? null })
        resolve(text)
      })
    })
    request.on('timeout', () => request.destroy(new Error(`${options.label || 'source'} 原生请求超时`)))
    request.on('error', reject)
    if (options.body !== undefined) request.write(String(options.body))
    request.end()
  })
}

async function fetchJson(url, options = {}, fetchImpl = globalThis.fetch) {
  const text = await fetchText(url, { ...options, accept: 'application/json' }, fetchImpl)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${options.label || 'source'} 返回的不是 JSON：${text.slice(0, 160)}`)
  }
}

export async function fetchCisaKev({ query = '', limit = 20, fetchImpl } = {}) {
  const data = await fetchJson('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', { label: 'CISA KEV' }, fetchImpl)
  const rows = Array.isArray(data?.vulnerabilities) ? data.vulnerabilities : []
  return rows
    .filter((row) => matchesQuery([
      row.cveID, row.vendorProject, row.product, row.vulnerabilityName,
      row.shortDescription, row.requiredAction, row.knownRansomwareCampaignUse,
    ].join(' '), query))
    .slice(0, limitOf(limit))
    .map((row) => kevCandidate(row, data.dateReleased))
}

export function kevCandidate(row, released = '') {
  return { ...candidate('cisa-kev', {
      sourceKind: 'known-exploited',
      id: row.cveID,
      title: row.vulnerabilityName || row.cveID,
      summary: row.shortDescription,
      published: '',
      modified: released || row.dateAdded,
      url: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(row.cveID || '')}`,
      ids: idsIn(row.cveID),
      products: [row.vendorProject, row.product].filter(Boolean),
    }), kev: { dateAdded: clean(row.dateAdded, 80), dueDate: clean(row.dueDate, 80),
      requiredAction: clean(row.requiredAction, 1200), knownRansomwareCampaignUse: clean(row.knownRansomwareCampaignUse, 100) } }
}

export function nvdCandidate(cve, home) {
  const description = (cve.descriptions ?? []).find(item => item.lang === 'en')?.value || cve.descriptions?.[0]?.value || ''
  const metric = cve.metrics?.cvssMetricV31?.[0]?.cvssData ?? cve.metrics?.cvssMetricV30?.[0]?.cvssData ?? cve.metrics?.cvssMetricV2?.[0]?.cvssData ?? {}
  return attachApiDocument(candidate('nvd', { id: cve.id, title: cve.id,
    summary: metric.baseScore ? `CVSS ${metric.baseScore}: ${description}` : description,
    published: cve.published, modified: cve.lastModified, status: cve.vulnStatus,
    withdrawnAt: cve.vulnStatus === 'Rejected' ? cve.lastModified : '',
    url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cve.id || '')}`, ids: idsIn(cve.id),
    products: (cve.configurations ?? []).flatMap(node => node.nodes ?? []).flatMap(node => node.cpeMatch ?? []).map(match => match.criteria),
  }), cve, 'nvd-cve-2.0', home)
}

export function githubAdvisoryCandidate(row, home) {
  return attachApiDocument(candidate('github-advisories', { id: row.ghsa_id, title: row.summary || row.ghsa_id,
    summary: row.description, published: row.published_at, modified: row.updated_at, withdrawnAt: row.withdrawn_at,
    status: row.withdrawn_at ? 'withdrawn' : 'active', url: row.html_url,
    ids: [row.cve_id, row.ghsa_id].filter(Boolean),
    products: (row.vulnerabilities ?? []).map(item => `${item.package?.ecosystem ?? ''}:${item.package?.name ?? ''}`),
  }), row, 'github-global-advisory', home)
}

export function osvCandidate(row, home) {
  return attachApiDocument(candidate('osv', { id: row.id, title: row.summary || row.id, summary: row.details || row.summary,
    published: row.published, modified: row.modified, withdrawnAt: row.withdrawn,
    status: row.withdrawn ? 'withdrawn' : 'active', url: `https://osv.dev/vulnerability/${encodeURIComponent(row.id || '')}`,
    ids: [row.id, ...(row.aliases ?? [])],
    products: (row.affected ?? []).map(item => `${item.package?.ecosystem ?? ''}:${item.package?.name ?? ''}`),
  }), row, 'osv', home)
}

export async function fetchNvd({ query = '', limit = 20, lastDays = 30, fetchImpl, home } = {}) {
  const size = limitOf(limit)
  const params = new URLSearchParams({ resultsPerPage: String(size) })
  if (query) params.set('keywordSearch', String(query).slice(0, 200))
  if (!query) {
    const days = Math.max(1, Math.min(120, Number(lastDays) || 30))
    params.set('pubStartDate', new Date(Date.now() - days * 86400000).toISOString())
  }
  const data = await fetchJson(`https://services.nvd.nist.gov/rest/json/cves/2.0?${params}`, { label: 'NVD', maxBytes: 16 * 1024 * 1024 }, fetchImpl)
  const rows = Array.isArray(data?.vulnerabilities) ? data.vulnerabilities : []
  return rows.slice(0, size).map(row => nvdCandidate(row?.cve ?? {}, home))
}

export async function fetchGithubAdvisories({ query = '', limit = 20, severity = '', ecosystem = '', lastDays = 30, fetchImpl, home } = {}) {
  const size = limitOf(limit, 20, 100)
  // A query is applied locally because the public endpoint's full-text filter
  // is limited. Fetch a wider recent page first, then rank/filter honestly.
  const params = new URLSearchParams({ per_page: String(query ? 100 : Math.min(100, size * 5)) })
  if (severity) params.set('severity', String(severity))
  if (ecosystem) params.set('ecosystem', String(ecosystem))
  if (!query && lastDays) {
    const since = new Date(Date.now() - Math.max(1, Math.min(365, Number(lastDays) || 30)) * 86400000).toISOString().slice(0, 10)
    params.set('published', `${since}..${new Date().toISOString().slice(0, 10)}`)
  }
  const data = await fetchJson(`https://api.github.com/advisories?${params}`, {
    label: 'GitHub Advisories',
    preferRaw: true,
    timeoutMs: 30000,
    maxBytes: 16 * 1024 * 1024,
    headers: { accept: 'application/vnd.github+json' },
  }, fetchImpl)
  const rows = Array.isArray(data) ? data : []
  return rows
    .filter((row) => matchesQuery([
      row.ghsa_id, row.cve_id, row.summary, row.description, row.severity,
      ...(row.vulnerabilities ?? []).map((item) => item?.package?.name),
    ].filter(Boolean).join(' '), query))
    .slice(0, size)
    .map(row => githubAdvisoryCandidate(row, home))
}

export async function fetchOsv({ id = '', packageName = '', ecosystem = '', version = '', query = '', limit = 20, fetchImpl, home } = {}) {
  const vulnId = clean(id || (/^(?:GHSA|CVE|OSV)-/i.test(query) ? query : ''), 160)
  let rows = []
  if (vulnId) {
    const row = await fetchJson(`https://api.osv.dev/v1/vulns/${encodeURIComponent(vulnId)}`, { label: 'OSV', maxBytes: 32 * 1024 * 1024 }, fetchImpl)
    rows = row ? [row] : []
  } else {
    if (!packageName || !ecosystem) throw new Error('OSV 查询需要 id，或 packageName + ecosystem')
    const body = { package: { name: String(packageName), ecosystem: String(ecosystem) } }
    if (version) body.version = String(version)
    const data = await fetchJson('https://api.osv.dev/v1/query', {
      method: 'POST',
      label: 'OSV',
      maxBytes: 32 * 1024 * 1024,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, fetchImpl)
    rows = Array.isArray(data?.vulns) ? data.vulns : []
  }
  return rows
    .filter((row) => matchesQuery(`${row.id} ${row.summary || ''} ${row.details || ''} ${(row.aliases ?? []).join(' ')}`, query))
    .slice(0, limitOf(limit))
    .map(row => osvCandidate(row, home))
}

function parseSogouWechat(html, query, limit) {
  const rows = []
  for (const block of String(html).matchAll(/<li id="sogou_vr_[^"]+_box_[^"]+"[\s\S]*?<\/li>/gi)) {
    const body = block[0]
    const title = stripHtml(body.match(/<a[^>]+id="[^"]+_title_[^"]+"[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '')
    const summary = stripHtml(body.match(/<p[^>]+class="txt-info"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '')
    const account = stripHtml(body.match(/<span[^>]+class="all-time-y2"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '')
    const epoch = Number(body.match(/timeConvert\('(\d+)'\)/i)?.[1] || 0)
    const href = decodeEntities(body.match(/href="([^"]+)"/i)?.[1] || '')
    if (!title) continue
    rows.push(candidate('wechat', {
      sourceKind: 'search-assisted',
      id: `wechat-${epoch || rows.length}-${title}`,
      title,
      summary: `${account ? `公众号：${account}。` : ''}${summary}`,
      published: epoch ? new Date(epoch * 1000).toISOString() : '',
      url: href.startsWith('/') ? `https://weixin.sogou.com${href}` : href,
      ids: idsIn(`${title} ${summary}`),
      products: [account].filter(Boolean),
    }))
    if (rows.length >= limit) break
  }
  return rows
}

export async function searchWechatSogou({ query = '', limit = 20, fetchImpl } = {}) {
  const q = clean(query, 200)
  if (!q) throw new Error('公众号搜索需要 query')
  const url = `https://weixin.sogou.com/weixin?type=2&${new URLSearchParams({ query: q }).toString()}`
  const html = await fetchText(url, { label: '微信公众号/搜狗', headers: { referer: 'https://weixin.sogou.com/' } }, fetchImpl)
  if (/验证码|请输入验证码|antispider|访问过于频繁/i.test(html)) {
    throw new Error('搜狗微信搜索触发验证码或反爬限制；本次未获得结果，不能当作零结果')
  }
  const rows = parseSogouWechat(html, q, limitOf(limit))
  if (rows.length === 0 && !/news-list/i.test(html)) throw new Error('搜狗微信搜索返回了非结果页；本次未获得结果')
  return rows
}

/**
 * nuclei-templates 没有独立的漏洞公告 API；公开的 commit Atom feed 能提供
 * 模板变更时间、提交链接和模板路径。这里把它作为“模板更新线索”接入，
 * 不把模板存在本身当成漏洞确认，也不伪报无更新为零结果。
 */
export async function fetchNucleiUpdates({ query = '', limit = 20, lastDays = 30, fetchImpl } = {}) {
  const xml = await fetchText(
    'https://github.com/projectdiscovery/nuclei-templates/commits/main.atom',
    { label: 'nuclei-templates 更新', accept: 'application/atom+xml,application/xml,text/xml' },
    fetchImpl,
  )
  const cutoff = Date.now() - Math.max(1, Math.min(365, Number(lastDays) || 30)) * 86400000
  const rows = []
  for (const block of String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
    const body = block[0]
    const title = stripHtml(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    const content = stripHtml(body.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] || '')
    const published = stripHtml(body.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i)?.[1] || '')
    const url = decodeEntities(body.match(/<link[^>]+href="([^"]+)"/i)?.[1] || '')
    const text = `${title} ${content}`
    if (!title || !matchesQuery(text, query)) continue
    const time = Date.parse(published)
    if (Number.isFinite(time) && time < cutoff) continue
    const templatePath = text.match(/\b(?:http|https|network|cloud|dns|file|headless|helpers)\/[A-Za-z0-9_./-]+\.ya?ml\b/i)?.[0] || ''
    const product = templatePath
      ? templatePath.split('/').slice(0, -1).filter((part) => part && !/^(http|https|network|cloud|dns|file|headless|helpers|vulnerabilities|misconfiguration)$/i.test(part)).pop() || ''
      : ''
    const sha = url.match(/\/commit\/([0-9a-f]+)/i)?.[1] || ''
    rows.push(candidate('nuclei', {
      sourceKind: 'template-update',
      id: sha ? `nuclei-${sha}` : `nuclei-${title}`,
      title: `nuclei 模板更新：${title}`,
      summary: [content, templatePath && `模板路径：${templatePath}`].filter(Boolean).join(' '),
      published,
      url,
      ids: idsIn(text),
      products: [product].filter(Boolean),
    }))
    if (rows.length >= limitOf(limit)) break
  }
  if (rows.length === 0 && !/<feed\b/i.test(xml)) {
    throw new Error('nuclei-templates 更新源返回了非 Atom 内容；本次未获得结果')
  }
  return rows
}

export async function fetchFreeSource(source, options = {}, fetchImpl = globalThis.fetch) {
  const id = clean(source, 40).toLowerCase()
  const cacheable = fetchImpl === globalThis.fetch && options.noCache !== true
  const key = `${id}:${JSON.stringify({ ...options, fetchImpl: undefined })}`
  const ttl = Math.max(0, Number(options.cacheTtlMs) || 10 * 60 * 1000)
  const cached = cacheable ? SOURCE_CACHE.get(key) : undefined
  if (cached && Date.now() - cached.at <= ttl) return JSON.parse(JSON.stringify(cached.rows))
  let rows
  if (id === 'cisa-kev') rows = await fetchCisaKev({ ...options, fetchImpl })
  else if (id === 'nvd') rows = await fetchNvd({ ...options, fetchImpl })
  else if (id === 'osv') rows = await fetchOsv({ ...options, fetchImpl })
  else if (id === 'github-advisories') rows = await fetchGithubAdvisories({ ...options, fetchImpl })
  else if (id === 'nuclei') rows = await fetchNucleiUpdates({ ...options, fetchImpl })
  else if (id === 'wechat') rows = await searchWechatSogou({ ...options, fetchImpl })
  else throw new Error(`不支持的免费源：${source}`)
  if (cacheable) SOURCE_CACHE.set(key, { at: Date.now(), rows: JSON.parse(JSON.stringify(rows)) })
  return rows
}

export { parseSogouWechat, stripHtml, idsIn, fetchJson as fetchSourceJson, candidate as sourceCandidate, matchesQuery }
