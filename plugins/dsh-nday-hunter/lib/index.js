// dsh-nday-hunter — 把 Nday 语料变成动作。
//
// 解决什么：护网复盘里输掉的那一场，冠军队伍靠"一个信创 Nday × 一堆同指纹资产"拿下
// 8 个 shell；我们的知识库里当时对东方通/宝兰德/金蝶这些组件零覆盖，也**没有任何
// 把语料变成批量动作的能力**。本插件补的就是后半截。
//
// 工具：
//   nday_catalog —— 库里有什么（列表 / 单条详情，含交接给公开工具的验证路径）
//   nday_match   —— 一批资产 × 条目 → 批量跑机器可判定探针 → 命中短名单 + 台账
//   nday_draft   —— 从 POC 文档抽候选路径/签名，生成待人工确认的条目草案（不落库）
//
// 三条不可让步的纪律：
//   1) **探针命中是筛选信号，不是漏洞结论**。输出里绝不出现 "vulnerable/confirmed"。
//   2) **不投放利用载荷**。语料里没有 payload，本插件也不生成 payload；
//      stage-2 的确认交给条目 exploit.tools 里点名的公开工具（由模型/用户执行）。
//   3) **报表如实**：条目 status 不是 verified 时，输出必须写明"该条目尚未由我们复现"。
//
// 挂载：preset 平面（pentest 的 agent.cordis.yml 一行）。

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { randomBytes } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readSettingsSection } from 'dsh-saker/settings-compat'
import { readInventory, scopeSafeAsset } from 'dsh-saker/asset-inventory'
import { parseQueryExpression, queryTerms, compileQueryExpression } from 'dsh-saker/query-expression'
import {
  VERDICT,
  candidateEntries,
  evaluateProbe,
  expansionQueries,
  getEntry,
  loadMergedCatalog,
  listEntries,
  parseTargets,
  probePlan,
  probeUrl,
  readCatalog,
  resolveSakerRoot,
  screenOutcome,
  summarizeEntry,
  userCatalogPath,
  userEntriesDir,
  WEIGHT_ORDER,
} from './catalog.js'
import { draftProbes, extractNdayCandidates } from './extract.js'
import { buildAttackPlan, renderAttackPlan } from './plan.js'
import { groupProbeRequests, executeProbeBatch } from './probe-batch.js'
import { selectReconCandidates, reconObservation } from './recon-candidates.js'
import { ATTACK_PROGRESS_FILE, bucketGates, emptyProgress, recordGate, renderGateStatus } from './gate.js'
import { buildMemshellCliPlan, buildMemshellMcpPlan, executeMemshellCliPlan, redactObject } from './memshell-cli.js'
import { loadZdayCatalog, matchZdayPatterns, renderZdayHypotheses, observedResearchInputs } from './zday.js'
import { buildAccessPlan, classifyMemoryBackend, renderAccessPlan } from './post.js'
import { renderWorklist, triageDocs } from './triage.js'
import { deriveProductKeywords, renderCoverageGap } from './coverage-gap.js'
import { resolveDshHome } from './home.js'
import { buildCampaignNdayQueries, buildNdaySearchPlan, campaignIdentityVariants } from './measurement-query.js'
import { DEFAULT_POLICY, buildPriorityPlan, normalizePriorityPolicy, renderPriorityPlan } from './priority.js'
import { mergeSavedVerification } from './verification-queue.js'
let readSavedVerification
try { ({ readSavedVerification } = await import('@dsh-external/dsh-redteam-results/task-context')) } catch { /* optional result plugin */ }
import { FREE_SOURCE_IDS, fetchFreeSource } from './free-sources.js'
import { collectorStatus, collectorResponse, querySourceCandidates, readSourceContent, readSourceApplicability, enrichCandidate, mergeCandidates, readCollectorConfig, runCollectorIfDue, runCollector, writeCollectorConfig } from './source-pipeline.js'
import { readMetrics, recordFeedbackMetric, recordMatchMetric, recordSearchMetric, summarizeMetrics } from './metrics.js'

/**
 * 把工具的 workspace 参数解析成绝对路径：**相对路径以会话工作区为基准**。
 *
 * 为什么（2026-09-25 真机会话实测）：原先写作
 * `path.resolve(String(args.workspace || '.'))`——相对路径是相对**宿主进程 cwd**
 * （dsh 源码检出目录/安装目录），不是模型眼里的工作目录（会话工作区）。
 * 默认值 '.' 更危险：模型不传 workspace 时，产物会静默落到 dsh 源码目录，
 * 既越出会话工作区，又让工作台、报告门与写边界都看不到它。绝对路径行为不变。
 */
function resolveWorkspaceArg(workspace, exec) {
  const raw = String(workspace ?? '').trim()
  const base = exec?.agent?.session?.header?.cwd
  if (raw === '') return path.resolve(base ?? '.')
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base ?? '.', raw)
}

function scopeBoundAsset(asset, scope) {
  const scoped = scopeSafeAsset(asset, scope)
  if (!scoped) return null
  const rawTarget = String(asset?.target || asset?.url || asset?.host || '').trim()
  try {
    const original = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawTarget) ? rawTarget : `http://${rawTarget}`)
    const safe = new URL(scoped.target)
    const safePath = original.pathname === '/' ? '' : original.pathname.replace(/\/+$/, '')
    return { ...scoped, target: `${safe.origin}${safePath}` }
  } catch {
    return scoped
  }
}

// 保持原有导出面：数据根解析的实现搬到 home.js，调用方仍可从本模块取到。
export { resolveDshHome }

const name = 'nday-hunter'
const inject = ['tools', 'settings']

// ── 速率与规模纪律（保守默认为准；显式放开要在结果里留痕） ────────────────────
const DEFAULT_CONCURRENCY = 4
const DEFAULT_TIMEOUT_MS = 6000
// 速率上限（请求/秒）。**并发数不是速率**：并发 4 遇上 20ms 的响应就是 ~200 req/s，
// 远超本仓库其它工具的保守默认（nuclei 交接命令 -rl 15、httpx -rl 25）。
// nday_match 是最容易把目标打爆的工具（条目 × 资产 × 探针三重放大），所以默认取 15。
const DEFAULT_RATE = 15
const HARD_MAX_RATE = 100
const BODY_CAP = 64 * 1024
const HARD_MAX_REQUESTS = 2000
const DEFAULT_MAX_REQUESTS = 800
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const MEASUREMENT_BASIS_RANK = Object.freeze({
  'catalog-fingerprint': 0,
  'probe-signature': 1,
  'port-refinement': 2,
  'product-alias': 3,
})
const MEASUREMENT_BASIS_LABELS = Object.freeze({
  'catalog-fingerprint': '目录明确指纹',
  'probe-signature': '探针响应签名',
  'port-refinement': '产品与目录端口收窄',
  'product-alias': '产品别名兜底',
})

function measurementBasisLabel(bases = []) {
  const best = [...bases].filter(Boolean)
    .sort((a, b) => (MEASUREMENT_BASIS_RANK[a] ?? 99) - (MEASUREMENT_BASIS_RANK[b] ?? 99))[0]
  return MEASUREMENT_BASIS_LABELS[best] || '未分类'
}

function stamp() {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 17) + '-' + randomBytes(4).toString('hex')
}

function ensureDirs(workspace) {
  const dir = path.join(workspace, 'artifacts', 'nday')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function ensureMemshellDir(workspace) {
  const dir = path.join(workspace, 'artifacts', 'memshell')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function appendEvidence(workspace, evidenceId, how, file) {
  const p = path.join(workspace, 'evidence-index.md')
  let head = ''
  try {
    head = fs.readFileSync(p, 'utf8')
  } catch {
    head = '# 证据索引\n\n| 编号 | 时间 | 证据 | 产生方式 | 交接/消费 |\n|---|---|---|---|---|\n'
  }
  fs.writeFileSync(p, head + `| ${evidenceId} | ${new Date().toISOString()} | ${file} | ${how} | nday 筛选短名单 |\n`)
}

function safeWorkspaceFile(workspace, rel) {
  const base = path.resolve(workspace)
  const target = path.resolve(base, String(rel || ''))
  if (target !== base && !target.startsWith(base + path.sep)) return null
  return target
}

function draftId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** Bounded-concurrency map; the only place request parallelism is decided. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length || 1))
  await Promise.all(Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  }))
  return out
}

/**
 * 速率闸门：保证**起请求的间隔**不小于 1000/rate 毫秒。
 *
 * 为什么并发数不够：`mapLimit` 只限制「同时在飞几个」，不限制「每秒发几个」。
 * 并发 4 遇到 20ms 的响应就是 ~200 req/s——对着带 WAF 的目标就是自曝。
 * 这里把「取号」这一步串行化：并发 worker 也按固定间隔起步。
 * @param {number} rate - 每秒最多起多少个请求。
 * @returns {() => Promise<void>} 每个请求前 await 一次。
 */
function makeRateGate(rate) {
  const interval = 1000 / Math.max(1, rate)
  let nextAt = 0
  let chain = Promise.resolve()
  return async () => {
    chain = chain.then(async () => {
      const now = Date.now()
      const wait = Math.max(0, nextAt - now)
      nextAt = Math.max(now, nextAt) + interval
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    })
    await chain
  }
}

/**
 * 把传输失败翻译成**可行动**的一句话。
 *
 * 为什么必须翻译：`fetch` 失败时 `error.message` 只有 `fetch failed`，真因藏在 `error.cause.code`。
 * 只看到 "fetch failed" 时，模型无法区分「目标不在」与「端口说的是明文 HTTP」，
 * 很容易把后者误读成「没有这个漏洞」。
 */
export function describeTransportError(error, timeoutMs) {
  const code = String(error?.cause?.code || error?.code || '')
  const label = {
    ETIMEDOUT: `超时（${timeoutMs}ms）`,
    ECONNREFUSED: '连接被拒绝（端口未开放）',
    ENOTFOUND: '域名解析失败',
    ECONNRESET: '连接被重置',
    EHOSTUNREACH: '主机不可达',
    ENETUNREACH: '网络不可达',
    ERR_SSL_WRONG_VERSION_NUMBER: '目标端口不是 TLS（更像明文 HTTP 端口）',
    ERR_SSL_PACKET_LENGTH_TOO_LONG: '目标端口不是 TLS（更像明文 HTTP 端口）',
    ERR_SSL_UNSUPPORTED_PROTOCOL: 'TLS 协议版本不被目标支持（老旧中间件常见）',
    EPROTO: 'TLS 握手失败（协议不匹配）',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书自签名（未受信任）',
    CERT_HAS_EXPIRED: 'TLS 证书已过期',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书域名不匹配',
  }[code]
  if (label) return label
  const message = String(error?.message || error || '未知传输错误')
  return code ? `${message}（${code}）` : message
}

/**
 * One HTTP probe. Never throws: transport failures come back as evidence, not exceptions.
 *
 * 用 `node:http/https` 直连而**不是**全局 `fetch`，与 `dsh-webshell-mgr` 同一口径：
 *   ① 目标侧自签/过期证书极其常见（内网信创系统、安全设备控制台），`fetch` 会直接失败，
 *      批量筛查在这些目标上等于**整条不可用**（实测：自签名站点上探针 100% 传输失败、
 *      rows 为空，还被概括成"超时/拒连"）——这里对 HTTPS 关闭证书校验；
 *   ② 一次性连接（`agent:false`）避开 keep-alive 复用导致部分目标偶发 404/500 的假拒绝；
 *   ③ 失败原因能拿到 `error.code`，而 `fetch` 只给 "fetch failed"。
 * 这条通道只用于**探测授权目标**；模型/知识库等出站仍走宿主策略。
 */
/**
 * 探针的请求选项。**抽成导出函数是为了可测**：TLS 策略（HTTPS 关证书校验）与
 * 一次性连接（`agent:false`）这两条一旦被改回去，单测必须变红 ——
 * 缺 TLS 策略时自签名目标上批量筛查 100% 传输失败、rows 为空（实测过）。
 * @returns {{ target: URL, mod: typeof http, options: object }}
 */
export function probeRequestOptions(url, method, timeoutMs, { hostHeader = '' } = {}) {
  const target = new URL(url)
  const mod = target.protocol === 'https:' ? https : http
  const options = {
    method,
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    timeout: timeoutMs,
    // 一次性连接：keep-alive 复用会让部分目标（单线程容器、老旧中间件）
    // 出现响应边界错乱，表现为偶发 404/500 假拒绝。
    agent: false,
  }
  // 目标侧自签/过期证书极其常见（内网信创系统、安全设备控制台）。
  // 与 dsh-webshell-mgr 同一口径：探测授权目标时不做证书校验。
  if (mod === https) options.rejectUnauthorized = false
  // vhost 探测：账本里 `target` 是 IP、`host` 是域名时必须显式发 Host，
  // 否则打到默认站点。端口按目标 URL 的端口补全（vhost 常跑在非 80 端口）。
  const vhost = String(hostHeader || '').trim()
  if (vhost) {
    const bare = vhost.replace(/:\d+$/, '')
    options.headers.host = target.port ? `${bare}:${target.port}` : bare
  }
  return { target, mod, options }
}

/**
 * 响应体解码的字符集别名。信创/国产系统大量返回 GBK，而 `TextDecoder` 的规范名是 `gbk`
 * （`gb2312` 要映射过去），`utf8` 也要映射到 `utf-8`。
 */
const CHARSET_ALIASES = {
  'gb2312': 'gbk',
  'gbk': 'gbk',
  'gb18030': 'gb18030',
  'utf-8': 'utf-8',
  'utf8': 'utf-8',
  'big5': 'big5',
  'shift_jis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'latin1': 'windows-1252',
  'iso-8859-1': 'windows-1252',
}

/**
 * 按 `Content-Type` 的 charset 解码响应体。
 *
 * 为什么必须做：探针判据里**有中文特征串**（如金蝶 Apusic 欢迎页标题
 * 「欢迎使用Apusic应用服务器」），而信创/国产系统大量返回 GBK。
 * 只按 UTF-8 解码时那类探针在真实目标上**永远打不中**
 * （实测：GBK 靶子上响应体就是目标串，命中数仍为 0）。与 `dsh-webshell-mgr` 同一口径。
 */
export function decodeProbeBody(buffer, contentType) {
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || ''))?.[1]?.toLowerCase()
  // 别名表里没有的编码**透传**给 TextDecoder（如 utf-16le）：解不了会抛，再退 UTF-8。
  const encoding = CHARSET_ALIASES[charset] || charset || 'utf-8'
  try {
    return new TextDecoder(encoding).decode(buffer)
  } catch {
    // 没有全 ICU 的运行时解不了 gbk 等编码：退 UTF-8，不让探针因为解码崩掉。
    return buffer.toString('utf8')
  }
}

/** 跟随上限：内网系统常见的 http→https、`/`→`/login` 只需一跳；给 2 跳留余量。 */
const MAX_REDIRECTS = 2
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** 只按**主机名**比较：http→https 会换端口，但仍是同一台授权资产。 */
function sameHostName(a, b) {
  return String(a?.hostname || '').toLowerCase() === String(b?.hostname || '').toLowerCase()
}

/** 单次请求（不含重定向）。永不抛：传输失败以 `{ ok:false, error }` 返回。 */
function requestOnce(target, mod, options) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    const req = mod.request(target, options, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        if (size >= BODY_CAP) return
        size += chunk.length
        chunks.push(chunk)
      })
      res.on('end', () => {
        const headers = {}
        for (const [key, value] of Object.entries(res.headers)) {
          headers[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
        }
        done({ ok: true, status: res.statusCode ?? 0, buffer: Buffer.concat(chunks), headers })
      })
      res.on('error', (error) => done({ ok: false, error }))
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', (error) => done({ ok: false, error }))
    req.end()
  })
}

/**
 * 一次探针（含**同主机重定向跟随**）。
 *
 * 为什么必须跟随：内网/信创系统大量把 `http://` 301 到 `https://`，或把 `/` 跳到 `/login`。
 * 不跟随的话，body 类判据拿到的是**空响应体**——实测同主机 301 的靶子上
 * `hits=0`，而输出里完全看不出发生过重定向（与「路径不存在」长得一样）。
 *
 * 为什么只跟同主机：跟随到别的域名等于把请求发到**授权范围之外**。跨主机一律不跟随，
 * 并把「被重定向到 <url>（跨主机，未跟随）」写进证据，由人决定要不要纳入范围。
 */
async function fetchProbe({ url, method, timeoutMs, hostHeader }) {
  let current
  try {
    current = probeRequestOptions(url, method, timeoutMs, { hostHeader })
  } catch {
    return { ok: false, error: `URL 无效：${url}` }
  }
  const chain = []
  let reqMethod = method
  for (let hop = 0; ; hop += 1) {
    const res = await requestOnce(current.target, current.mod, current.options)
    if (!res.ok) return { ok: false, error: describeTransportError(res.error, timeoutMs) }
    const location = res.headers.location
    const isRedirect = REDIRECT_STATUS.has(res.status) && Boolean(location)
    if (isRedirect && hop < MAX_REDIRECTS) {
      let next = null
      try { next = new URL(location, current.target) } catch { next = null }
      if (next && sameHostName(current.target, next)) {
        chain.push(next.href)
        // 301/302/303 按浏览器语义降级为 GET；307/308 保持原方法。
        reqMethod = (res.status === 307 || res.status === 308) ? reqMethod : 'GET'
        try {
          current = probeRequestOptions(next.href, reqMethod, timeoutMs, { hostHeader })
        } catch {
          return { ok: false, error: `重定向目标 URL 无效：${next.href}` }
        }
        continue
      }
      return {
        ok: true,
        status: res.status,
        body: decodeProbeBody(res.buffer, res.headers['content-type']).slice(0, BODY_CAP),
        headers: res.headers,
        redirect: { to: next ? next.href : String(location), followed: false, reason: next ? '跨主机' : '无法解析' },
      }
    }
    const body = reqMethod === 'HEAD' ? '' : decodeProbeBody(res.buffer, res.headers['content-type']).slice(0, BODY_CAP)
    const redirect = chain.length > 0
      ? { chain: [...chain], followed: true, finalUrl: current.target.href }
      : (isRedirect ? { to: String(location), followed: false, reason: '超过跟随上限' } : undefined)
    return { ok: true, status: res.status, body, headers: res.headers, ...(redirect ? { redirect } : {}) }
  }
}

/**
 * 把传输失败按原因归类，给模型一句**能据以决策**的话。
 *
 * 为什么不能只写「超时/拒连」：全部探针失败时 `rows` 为空，逐条原因只存在于台账里，
 * 模型只看到那句概括——实测自签名证书目标被概括成「超时/拒连」，方向被完全带偏。
 */
/**
 * 探测走的是 `node:http/https` **直连**，而 Node 核心模块**不读** `HTTP_PROXY` 系列变量
 * （宿主自己的 `fetch` 走全局 dispatcher，两边的代理语义不同）。
 *
 * 为什么不直接改成走代理：多数人设代理只为上外网，把探针也塞进代理反而会让**内网目标探不通**；
 * 反过来，靠代理/隧道到达目标的人，直连会失败并表现成「连接被拒绝/超时」。
 * 两种诉求都合理，所以这里**只如实报出检测到的代理变量**，由操作者决定（设 NO_PROXY 或取消代理）。
 * @returns {string[]} 去重后的变量名（大写）
 */
export function detectProxyEnv(env = process.env) {
  const names = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
  const found = names.filter((name) => String(env?.[name] || '').trim())
  return [...new Set(found.map((name) => name.toUpperCase()))]
}

export function summarizeTransportErrors(errors) {
  const counts = new Map()
  for (const item of errors) {
    const reason = String(item?.error || '未知错误')
    counts.set(reason, (counts.get(reason) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => (count > 1 ? `${reason}×${count}` : reason))
    .join('；')
}

/**
 * 账本里 `target` **常常不带端口**：`port` 是独立字段（扫描器给的是 `{host, port}`），
 * 直接拿 target 去探针会打到默认端口——实测真实 8589 的目标被探成 `http://127.0.0.1/`（80）
 * 并全部拒连、命中数 0。这里按 `port` / `protocol` 把探测用的 base 补全。
 *
 * **只用于探测，不改账本本身**：账本的 `target` 参与身份键与合并（`host:port` 是另一个键），
 * 在数据模型层折端口会打散既有合并语义（资产单测会红）。
 * @returns {string} 可直接探测的 base URL
 */
export function probeBaseForAsset(asset = {}) {
  const raw = String(asset.target || asset.host || '').trim()
  if (!raw) return ''
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  let url
  try {
    url = new URL(hadScheme ? raw : `http://${raw}`)
  } catch {
    return raw
  }
  const protocol = String(asset.protocol || '').trim().toLowerCase().replace(/:$/, '')
  // 只有「原本没写 scheme」的输入才按 protocol 纠正 scheme，避免动到显式写法。
  if (protocol && !hadScheme && url.protocol !== `${protocol}:`) url.protocol = `${protocol}:`
  const port = Number(asset.port) || 0
  const isDefaultPort = (url.protocol === 'http:' && port === 80) || (url.protocol === 'https:' && port === 443)
  if (port && !url.port && !isDefaultPort) url.port = String(port)
  return url.toString().replace(/\/$/, '')
}

function catalogOrThrow() {
  const root = resolveSakerRoot()
  if (!root) {
    throw new Error('找不到 Saker 根目录（内含 preset/pentest/refs/nday/catalog.json）。'
      + '请确认 dsh-saker 已安装，或设置 SAKER_ROOT 指向仓库根。')
  }
  // 包层 + 用户层合并：现场学到的条目落在用户层，读的时候和包内条目一视同仁。
  return {
    root,
    catalog: loadMergedCatalog(root, { home: resolveDshHome() }),
  }
}

function priorityPolicyFile() {
  return path.join(resolveDshHome(), 'nday-hunter', 'policy.json')
}

function readPriorityPolicy() {
  const file = priorityPolicyFile()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return normalizePriorityPolicy({ ...DEFAULT_POLICY, ...parsed })
  } catch {
    return normalizePriorityPolicy(DEFAULT_POLICY)
  }
}

function writePriorityPolicy(policy) {
  const file = priorityPolicyFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const next = normalizePriorityPolicy(policy)
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// ── 带外（OOB）确认原语 ──────────────────────────────────────────────────────
//
// 为什么放在这个插件：T1（Nday 轨）的第二阶段是「确认可达」。反序列化 / 盲 RCE /
// SSRF / XXE 这些面**只能靠带外回连确认**——没有带外通道，筛选命中也只能停在「疑似」，
// 而「疑似」换不来权限。这条通道是通用原语（不止 Nday 用），但它是 Nday 流程里缺的那一环。
//
// 契约：DNSLog 平台的 CEYE 兼容接口
//   GET {url}/v1/records?token=<token>&type=dns&filter=<name>
// 返回 JSON 里取 data[] 或 records[]。url 若本身已含 "records" 则原样使用。
// **认不出的响应一律当失败**——把平台错误页当成「有回连」会直接制造假阳性。

const OOB_LABEL_RE = /^[a-z0-9][a-z0-9-]{2,39}$/

/**
 * 把「批量带外的归因表」落盘。`oob_probe action=batch` 与 `nday_match` 的命中预分配
 * 共用同一份格式——这样 `check` 只认一种文件，两处产出可以互换。
 * @returns {string} 落盘路径
 */
function writeOobBatchTable(workspace, label, root, rows) {
  const dir = path.join(workspace, '.saker')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `oob-batch-${label}.json`)
  fs.writeFileSync(file, JSON.stringify({
    schema: 'saker.oob-batch/1',
    label,
    root,
    createdAt: new Date().toISOString(),
    rows,
  }, null, 2))
  return file
}

function oobConfig(ctx) {
  let section = {}
  try {
    section = readSettingsSection(ctx.settings, 'sec-config') ?? {}
  } catch {
    section = {}
  }
  const dnslog = section.dnslog ?? {}
  return {
    base: String(dnslog.url || '').trim().replace(/\/+$/, ''),
    token: String(dnslog.token || '').trim(),
    root: String(dnslog.domain || '').trim().replace(/^\.+/, '').replace(/\.+$/, ''),
  }
}

function memshellConfig(ctx) {
  try {
    const section = readSettingsSection(ctx.settings, 'sec-config') ?? {}
    const memshell = section.memshell ?? {}
    return {
      enabled: memshell.enabled === true,
      backendUrl: String(memshell.backendUrl || '').trim(),
      token: String(memshell.token || '').trim(),
      cliPath: String(memshell.cliPath || '').trim(),
      mcpServer: String(memshell.mcpServer || 'memshell-party').trim(),
    }
  } catch {
    return {}
  }
}

function oobEndpoint(base) {
  return /records/i.test(base) ? base : `${base}/v1/records`
}

async function oobFetchRecords({ base, token, filter, timeoutMs = 8000 }) {
  const url = new URL(oobEndpoint(base))
  url.searchParams.set('token', token)
  url.searchParams.set('type', 'dns')
  url.searchParams.set('filter', filter)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    const text = (await res.text()).slice(0, 4000)
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* 下面按「不认识」处理 */ }
    const rows = Array.isArray(parsed?.data) ? parsed.data
      : Array.isArray(parsed?.records) ? parsed.records
        : null
    if (!rows) {
      return { ok: false, error: `DNSLog 平台返回了无法识别的响应（HTTP ${res.status}）：${text.slice(0, 200)}` }
    }
    return { ok: true, rows }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return { ok: false, error: aborted ? `查询超时（${timeoutMs}ms）` : String(error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 交接到「你自己已有的工具」──────────────────────────────────────────────
//
// 关键判断：**Saker 不该重造武器**。用户的机器上已经有 nuclei（实测 14072 个模板），
// 其中 泛微 30 / 致远 10 / 用友 22 / 金蝶 2 个模板——真正的缺口只是"没人告诉他该用哪几个"。
// 所以交接层的职责是：**在用户自己的模板库里把对得上的那几个挑出来，给出可直接执行的命令**。

/** nuclei 模板目录：候选顺序固定；**必须返回 realpath**（符号链接 Windows 版 nuclei 不跟）。 */
export function resolveNucleiTemplatesDir(fsImpl = fs, home = process.env.USERPROFILE || process.env.HOME || '') {
  const candidates = [
    path.join(home, 'nuclei-templates'),
    path.join(home, '.config', 'nuclei', 'templates'),
    path.join(home, 'AppData', 'Local', 'nuclei', 'templates'),
  ]
  for (const candidate of candidates) {
    try {
      if (!fsImpl.existsSync(candidate)) continue
      const real = fsImpl.realpathSync(candidate)
      // 「目录存在」不等于「有模板」——空目录会让 nuclei 联网初始化并卡死（实测 8 分 52 秒）。
      const entries = fsImpl.readdirSync(real, { recursive: true, withFileTypes: true })
      if (entries.some((e) => e.isFile() && e.name.endsWith('.yaml'))) return real
    } catch { /* 试下一个候选 */ }
  }
  return ''
}

/**
 * 按关键词在模板库里挑模板（大小写不敏感），**按区分度排序**。
 *
 * **按 token 边界匹配，不做裸子串**：实测踩到过——关键词 `weaver` 用裸子串会把
 * `sap-netweaver-*.yaml` 一并选进来（8 个无关的 SAP 模板），交接单就会让用户
 * 拿一堆不相关的模板去打泛微。所以要求关键词前后不是英文字母。
 * 匹配对象用**相对路径**而不是文件名：厂商目录（`.../weaver/ecology/`）比文件名更可信。
 *
 * **为什么必须排序（2026-09-25 真机实测）**：语料条目的关键词里混着「产品词」与
 * 「漏洞类词」（`sqli` / `rce` / `panel` / `cve` …）。旧实现把命中结果按字母序取前 40，
 * 而通用词能命中几百个模板、产品目录名（`yonyou` / `weaver` / `ruijie`）大多排在字母表
 * 后半段——**产品专属模板被整个挤出名额**。实测：322 条有专属模板的条目里
 * **61 条（19%）的交接命令一条专属模板都没带上**（例：`yonyou-nc-bshservlet-rce`
 * 有 31 条用友模板，全被 `rce` 的 165 条通用模板挤掉）。
 * 修法：先数出每个关键词在库里的命中数，超过 `genericThreshold` 的算「不具区分度」；
 * 打分时**有区分度的词权重 2、通用词权重 1**，分高者先、同分按相对路径
 * （保证「同输入同输出」，便于对账与复跑）。
 *
 * @returns {{templates: string[], perKeyword: Record<string, number>, specific: string[], genericOnly: boolean, genericThreshold: number}}
 *   `specific` 是**入选结果里**由有区分度关键词命中的那些；`genericOnly` 为真表示
 *   入选的全是靠通用词凑的——调用方应如实说明，不要把通用模板当产品模板交接。
 */
export function scoreNucleiTemplates(dir, keywords, { limit = 40, fsImpl = fs, genericThreshold = 40 } = {}) {
  const words = (Array.isArray(keywords) ? keywords : []).map((k) => String(k).toLowerCase()).filter(Boolean)
  if (!dir || words.length === 0) {
    return { templates: [], perKeyword: {}, specific: [], genericOnly: false, genericThreshold }
  }
  const matchers = words.map((w) => [
    w,
    new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`),
  ])
  const hits = []
  try {
    const walk = (current) => {
      for (const entry of fsImpl.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue
        const rel = path.relative(dir, full).replace(/\\/g, '/').toLowerCase()
        const matched = matchers.filter(([, re]) => re.test(rel)).map(([w]) => w)
        if (matched.length) hits.push({ full, rel, matched })
      }
    }
    walk(dir)
  } catch { /* 读不了就当没匹配 */ }
  const perKeyword = Object.fromEntries(words.map((w) => [w, 0]))
  for (const h of hits) for (const w of h.matched) perKeyword[w] += 1
  const isGeneric = (w) => perKeyword[w] > genericThreshold
  const weight = (h) => h.matched.reduce((sum, w) => sum + (isGeneric(w) ? 1 : 2), 0)
  hits.sort((a, b) => weight(b) - weight(a) || a.rel.localeCompare(b.rel))
  const picked = hits.slice(0, limit)
  const specific = picked.filter((h) => h.matched.some((w) => !isGeneric(w)))
  return {
    templates: picked.map((h) => h.full),
    // 命中**总数**（未受 limit 截断）——调用方要报数就用它，别拿 templates.length 当总数：
    // 那会把「500 个」静默报成「40 个」，看数的人会以为本地没存货。
    total: hits.length,
    perKeyword,
    specific: specific.map((h) => h.full),
    genericOnly: hits.length > 0 && specific.length === 0,
    genericThreshold,
  }
}

/** 只要路径列表的调用方（如 `nday_coverage` 的模板层计数）继续用这个。 */
export function matchNucleiTemplates(dir, keywords, opts = {}) {
  return scoreNucleiTemplates(dir, keywords, opts).templates
}

/** sec-config 里配的 nuclei 可执行文件路径（没配就回落 PATH 上的 nuclei）。 */
function configuredNucleiBin(ctx) {
  try {
    const section = readSettingsSection(ctx.settings, 'sec-config') ?? {}
    return String(section?.tools?.nuclei || section?.entries?.find?.((e) => e?.key === 'nuclei')?.path || 'nuclei')
  } catch {
    return 'nuclei'
  }
}

/**
 * 知识覆盖体检：一次把三层来源对这个关键词的覆盖数出来。
 *
 * 为什么需要它（2026-09-24 用户质疑「除了有非常全的项目或网站，不然没法做到吧」）：
 * **他说得对——没有单一来源是全的**。实测同一批信创产品：
 *   nuclei 模板库：泛微 46 / 致远 10 / 用友 22 / 金蝶 2 / **东方通 0 / 宝兰德 0**
 *   本地知识包：  泛微 49 / 致远 44 / 用友 42 / 金蝶 12 / **东方通 0 / 宝兰德 0**
 * 两组来源互补，但**都盖不住东方通**——而那恰好是撑起对手 8 个 shell 的产品。
 * 所以真正要回答的不是「哪个库全」，而是「**这个产品在哪一层有货、哪一层是空的**」。
 */
export function coverageScan({ keyword, catalogEntries = [], importsDir = '', nucleiDir = '', fsImpl = fs, fileCap = 20000 }) {
  const primary = String(keyword || '').toLowerCase()
  const entryText = (entry) => [entry.id, entry.product, entry.vendor, entry.vulnClass,
    ...(Array.isArray(entry.aliases) ? entry.aliases : [])].filter(Boolean).join(' ').toLowerCase()
  const l1 = catalogEntries.filter((entry) => entryText(entry).includes(primary))
  const l1Siftable = l1.filter((entry) => (entry.fingerprint?.probes ?? []).length > 0)

  // 关键词扩展：中文产品名对不上英文模板名（实测「泛微」查不到 weaver-*.yaml）。
  // 用命中的语料条目的 aliases 补进来——这就是"知识库全面性"在检索层的具体做法。
  const terms = new Set([primary])
  for (const entry of l1) {
    for (const alias of (Array.isArray(entry.aliases) ? entry.aliases : [])) {
      const value = String(alias || '').trim().toLowerCase()
      if (value.length >= 3) terms.add(value)
    }
  }
  const termList = [...terms]
  const hitName = (name) => termList.some((term) => name.includes(term))

  // L2：本地知识包——按**文件名**匹配。内容级扫描太慢，不放这里，输出里如实说明。
  const packs = {}
  let scanned = 0
  let truncated = false
  if (importsDir && fsImpl.existsSync(importsDir)) {
    let names = []
    try { names = fsImpl.readdirSync(importsDir) } catch { names = [] }
    for (const pack of names) {
      let hit = 0
      const walk = (current) => {
        if (truncated) return
        let entries = []
        try { entries = fsImpl.readdirSync(current, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          if (truncated) return
          const full = path.join(current, entry.name)
          if (entry.isDirectory()) { walk(full); continue }
          scanned += 1
          if (scanned > fileCap) { truncated = true; return }
          if (hitName(entry.name.toLowerCase())) hit += 1
        }
      }
      walk(path.join(importsDir, pack))
      if (hit > 0) packs[pack] = hit
    }
  }
  const l2 = Object.values(packs).reduce((sum, n) => sum + n, 0)

  // L3：用户自己的 nuclei 模板库
  // 计数用 `total`（未截断的命中总数）；`templates` 只取前几个当样例——
  // 早先直接拿 `matchNucleiTemplates()` 的长度当总数，而它默认 limit=40，
  // 于是「命中 500 个」被静默报成「40 个」，看数的人会以为本地没存货。
  const tplMatch = nucleiDir
    ? scoreNucleiTemplates(nucleiDir, termList, { limit: 5 })
    : { total: 0, templates: [] }
  return {
    keyword,
    searchTerms: termList,
    l1: { total: l1.length, siftable: l1Siftable.length, ids: l1.map((entry) => `${entry.id}(${entry.status})`) },
    l2: { total: l2, packs },
    l3: { total: tplMatch.total, sample: tplMatch.templates.map((t) => path.basename(t)) },
    scannedFiles: scanned,
    truncated,
  }
}

function apply(ctx, config = {}) {
  const enablePostRceTools = config?.enablePostRceTools === true
  const allToolNames = new Set([
    'nday_catalog', 'nday_priority_plan', 'nday_policy_get', 'nday_policy_set', 'nday_source_fetch',
    'nday_source_radar', 'nday_source_collect', 'nday_metrics',
    'attack_plan', 'attack_gate', 'memshell_cli', 'zday_pattern',
    'nday_scope_hunt', 'nday_match', 'nday_coverage', 'nday_triage', 'nday_learn', 'nday_draft',
    'nday_handoff', 'access_confirm', 'oob_probe',
  ])
  if (config?.exposedTools !== undefined && !Array.isArray(config.exposedTools)) {
    throw new TypeError('exposedTools must be an array of Nday tool names')
  }
  const exposedTools = config?.exposedTools === undefined ? null : new Set(config.exposedTools)
  const unknownTools = [...(exposedTools ?? [])].filter((toolName) => !allToolNames.has(toolName))
  if (unknownTools.length > 0) {
    throw new Error(`Unknown exposedTools: ${unknownTools.join(', ')}`)
  }
  const registerNdayTool = (tool) => {
    if (exposedTools && !exposedTools.has(tool.name)) return
    ctx.tools.register(tool)
  }

  // The preset-plane plugin may be mounted per session; the collector state
  // and lock make concurrent mounts harmless. It checks every 15 minutes and
  // only performs network work when the configured interval is due.
  const collectorTimer = setInterval(() => {
    void runCollectorIfDue().catch((error) => {
      try { ctx.logger?.warn?.(`nday source collector: ${String(error?.message || error)}`) } catch { /* ignore logger failures */ }
    })
  }, 15 * 60 * 1000)
  collectorTimer.unref?.()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => clearInterval(collectorTimer), 'nday-hunter: source collector')
  }
  void runCollectorIfDue().catch(() => undefined)

  registerNdayTool(defineTool({
    name: 'nday_priority_plan',
    description: 'Rank relevant Ndays; draft FOFA and verification plans without requests.',
    parameters: {
      target: { type: 'string', description: 'Target product, vendor, URL, or free-text context' },
      targetTerms: { type: 'string', description: 'Comma/newline separated target keywords for relevance scoring' },
      workspace: { type: 'string', description: 'Read existing asset inventory for product routing' },
      scope: { type: 'string', description: 'Optional exact inventory scope; planning sends no requests' },
      entryIds: { type: 'string', description: 'Optional comma-separated catalog ids to restrict candidates' },
      excludeIds: { type: 'string', description: 'Optional comma-separated catalog ids to exclude' },
      recentDays: { type: 'integer', description: 'Recency window, days' },
      domesticBoost: { type: 'integer', description: 'Domestic/信创 score boost' },
      trendKeywords: { type: 'string', description: 'Trend keywords, comma separated' },
      excludeVendors: { type: 'string', description: 'Excluded vendors/products' },
      maxCandidates: { type: 'integer', description: 'Ranked candidate limit' },
      queriesPerNday: { type: 'integer', description: 'FOFA queries per Nday' },
      concurrency: { type: 'integer', description: 'Policy override: batch tool concurrency ceiling' },
      mode: { type: 'string', enum: ['nday', 'regular', '0day'], description: 'Outer task mode; regular/research reuse Nday without changing stopping policy' },
      stop: { type: 'string', enum: ['first-high', 'first-rce', 'queue', 'budget'], description: 'Explicit task stopping override' },
      technologies: { type: 'string', description: 'Observed technology families, comma separated; hypotheses only' },
      verificationContext: { type: 'string', description: 'Evidence JSON assets/checks/history/maxSupplementAttempts. Omit to load session context; stored check history merges automatically. See README.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `nday_priority_plan 失败：${v.error}` }],
    },
    async execute(args, exec) {
      try {
        const { catalog } = catalogOrThrow()
        const sessionId = exec?.agent?.session?.id
        const saved = readSavedVerification ? readSavedVerification(resolveDshHome(), sessionId)
          : { available: false, reason: 'task-plugin-unavailable', context: null, history: [] }
        const verificationContext = mergeSavedVerification(args.verificationContext, saved)
        const overrides = {
          recentDays: args.recentDays,
          domesticBoost: args.domesticBoost,
          trendKeywords: args.trendKeywords,
          excludeVendors: args.excludeVendors,
          maxCandidates: args.maxCandidates,
          queriesPerNday: args.queriesPerNday,
          concurrency: args.concurrency,
        }
        const policy = normalizePriorityPolicy({
          ...readPriorityPolicy(),
          ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
        })
        const inventoryAssets = args.workspace ? readInventory(resolveWorkspaceArg(args.workspace, exec)).assets
          .map(asset => args.scope ? scopeBoundAsset(asset, args.scope) : asset).filter(Boolean)
          .map(asset => ({ ...asset, url: asset.target })) : []
        const contextAssets = new Map(inventoryAssets.map(asset => [asset.id, asset]))
        for (const asset of verificationContext.assets || []) contextAssets.set(asset.id, { ...contextAssets.get(asset.id), ...asset })
        verificationContext.assets = [...contextAssets.values()]
        const plan = buildPriorityPlan(catalog, {
          target: args.target,
          targetTerms: args.targetTerms,
          entryIds: args.entryIds,
          excludeIds: args.excludeIds,
          mode: args.mode,
          stop: args.stop,
          technologies: args.technologies,
          verificationContext,
          policy,
        })
        plan.sharedHistory = { available: saved.available, reason: saved.reason, storedChecks: saved.available ? saved.history.length : null, contextLoaded: Boolean(saved.context) }
        return { ok: true, plan, text: renderPriorityPlan(plan) + '\n共享任务记录：' + (saved.available ? `检查 ${saved.history.length} 条；上下文${saved.context ? '已加载' : '尚未保存'}` : `不可用（${saved.reason}）；未声称已经去重`) }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_policy_get',
    description: 'Read Nday ranking, filters and request limits.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v.policy ?? v, null, 2) }],
    },
    async execute() {
      return { ok: true, policy: readPriorityPolicy() }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_policy_set',
    description: 'Update the structured Nday prioritization policy.',
    parameters: {
      recentDays: { type: 'integer', description: 'Recency window in days' },
      domesticBoost: { type: 'integer', description: 'Domestic/信创 score boost' },
      trendKeywords: { type: 'string', description: 'Trend keywords, comma separated' },
      excludeVendors: { type: 'string', description: 'Vendors/products to exclude, comma separated' },
      maxCandidates: { type: 'integer', description: 'Maximum ranked candidates' },
      queriesPerNday: { type: 'integer', description: 'FOFA queries per Nday' },
      concurrency: { type: 'integer', description: 'Batch tool concurrency ceiling' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? JSON.stringify(v.policy, null, 2) : `nday_policy_set 失败：${v.error}` }],
    },
    async execute(args) {
      try {
        const next = {
          ...readPriorityPolicy(),
          ...Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)),
        }
        return { ok: true, policy: writePriorityPolicy(next) }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_source_fetch',
    description: 'Fetch free/public Nday sources (CISA KEV, NVD, OSV, GitHub, nuclei, WeChat). Candidates only.',
    parameters: {
      source: { type: 'string', enum: FREE_SOURCE_IDS, required: true, description: 'Free source id' },
      query: { type: 'string', description: 'Keyword or CVE/CNVD/GHSA id' },
      id: { type: 'string', description: 'OSV vulnerability id' },
      packageName: { type: 'string', description: 'OSV package name' },
      ecosystem: { type: 'string', description: 'OSV ecosystem, e.g. Maven/npm/PyPI' },
      version: { type: 'string', description: 'OSV package version, optional' },
      limit: { type: 'integer', description: 'Maximum candidates (default 20, cap 100)' },
      lastDays: { type: 'integer', description: 'NVD/GitHub/nuclei recency window in days' },
      severity: { type: 'string', description: 'GitHub advisory severity filter' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, value) => [{ type: 'text', text: value.ok ? value.text : `nday_source_fetch 失败：${value.error}` }],
    },
    async execute(args) {
      try {
        const rows = await fetchFreeSource(args.source, args)
        const candidates = mergeCandidates(rows)
        const lines = [
          `免费源 ${args.source}：${candidates.length} 条候选。`,
          '这些是公开情报候选，不代表目标存在漏洞，也不包含利用载荷。',
          ...candidates.slice(0, 12).map((item) => `- [${item.source}/${item.trust}/${item.freshness}] ${item.id || '-'} | ${item.title} | ${item.publishedAt || '日期未标注'} | ${item.url}`),
        ]
        return {
          ok: true,
          source: args.source,
          count: candidates.length,
          candidates,
          text: lines.join('\n'),
        }
      } catch (error) {
        return { ok: false, source: args.source, error: String(error?.message || error) }
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_source_radar',
    description: 'Read source status; search local metadata or page pinned originals.',
    parameters: {
      includeCandidates: { type: 'boolean', description: 'Show 20 previews' },
      query: { type: 'string', description: 'Metadata terms' },
      cursor: { type: 'string', description: 'Search nextCursor' },
      record: { type: 'string', description: 'Original source:id' },
      revision: { type: 'string', description: 'Pinned revision hash' },
      offset: { type: 'integer', description: 'Original nextOffset' },
      environment: { type: 'json', description: 'packages:[{name,ecosystem,version,evidenceIds}];cpes;products' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, value) => [{ type: 'text', text: value.ok ? value.text : `nday_source_radar 失败：${value.error}` }],
    },
    async execute(args) {
      try {
        if (args.environment !== undefined && args.record === undefined) throw new Error('environment requires record=source:id')
        if (args.record !== undefined) {
          const match = /^([^:]+):(.+)$/.exec(args.record)
          if (!match) throw new Error('Original record must be source:id')
          if (args.environment !== undefined) {
            if (args.offset !== undefined) throw new Error('Applicability does not accept a text offset')
            const assessment = readSourceApplicability(match[1], match[2], args.environment, { revision: args.revision })
            return { ok: true, assessment, text: `条件判断（以所提供资产清单为前提，非漏洞证据）：${JSON.stringify(assessment)}` }
          }
          const content = readSourceContent(match[1], match[2], { revision: args.revision, offset: args.offset })
          return { ok: true, content, text: `来源 ${args.record}；修订 ${content.revision}；SHA256 ${content.sha256}；材料格式 ${content.representation}；原文字符 ${content.offset}..${content.offset + content.text.length}；nextOffset=${content.nextOffset}\n${content.text}` }
        }
        const status = collectorStatus()
        const metrics = summarizeMetrics()
        const page = args.includeCandidates === true || args.query !== undefined || args.cursor !== undefined
          ? querySourceCandidates({ query: args.query ?? '', cursor: args.cursor ?? null }) : null
        const candidates = page?.rows ?? []
        const sourceLines = status.sources.map((row) =>
          `- ${row.source}: ${row.status || (row.ok ? 'legacy-unknown' : 'failed')} ${row.count ?? 0}; ${row.coverage || 'coverage unknown'}${row.error ? `; ${row.error}` : ''}`)
        const text = [
          `采集器：${status.config.enabled ? '启用' : '停用'}；间隔 ${status.config.intervalHours}h；上次 ${status.lastRunAt || '未运行'}；下次 ${status.nextDueAt || '待计算'}；due=${status.due}`,
          `候选：${status.summary?.mergedCandidates ?? status.candidateCount} 条合并；${status.summary?.freshCandidates ?? '未知'} 条 7 天内。`,
          `指标：首轮命中率 ${metrics.firstRoundHitRate === null ? '暂无' : (metrics.firstRoundHitRate * 100).toFixed(1) + '%'}；指纹误报率 ${metrics.fingerprintFalsePositiveRate === null ? '暂无' : (metrics.fingerprintFalsePositiveRate * 100).toFixed(1) + '%'}；查询到 RCE 平均 ${metrics.averageQueryToRceMs === null ? '暂无' : Math.round(metrics.averageQueryToRceMs / 1000) + 's'}。`,
          ...(sourceLines.length ? ['来源状态：', ...sourceLines] : []),
          ...(page ? [`本地检索：${page.total} 条匹配；nextCursor=${page.nextCursor ?? 'null'}；来源原文用 record=来源ID:记录ID 读取。`] : []),
          ...(candidates.length ? ['', '候选（已按编号/URL/标题去重，保留来源时间与可信等级）：', ...candidates.slice(0, 20).map((row) => `- [${row.trust}/${row.freshness}] ${row.source}:${row.id || '-'} | ${row.title} | ${row.publishedAt || row.published || '日期未标注'} | ${row.url} | revision=${row.revision}${row.requiresSourceReview ? ' | 需要回源复核' : ''}`)] : []),
        ].join('\n')
        return { ok: true, status, metrics, candidates, matchedCandidates: page?.total ?? null, nextCursor: page?.nextCursor ?? null, text }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_source_collect',
    description: 'Run the free-source collector now or persist its settings; failures stay explicit.',
    parameters: {
      sources: { type: 'string', description: 'Comma-separated source ids' },
      query: { type: 'string', description: 'Shared source keyword' },
      wechatQuery: { type: 'string', description: 'WeChat keyword; empty skips' },
      lastDays: { type: 'integer', description: 'Recency window for NVD/GitHub/nuclei' },
      limit: { type: 'integer', description: 'Page size (1-100)' },
      intervalHours: { type: 'integer', description: 'Persist schedule interval (1-168 hours)' },
      enabled: { type: 'boolean', description: 'Persist whether the background collector is enabled' },
      force: { type: 'boolean', description: 'Run even when not due' },
      saveConfig: { type: 'boolean', description: 'Persist supplied settings before running' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, value) => [{ type: 'text', text: value.text || `nday_source_collect 失败：${value.error}` }],
    },
    async execute(args) {
      try {
        const patch = {}
        if (args.sources !== undefined) patch.sources = String(args.sources).split(',').map((value) => value.trim()).filter(Boolean)
        for (const key of ['query', 'wechatQuery', 'lastDays', 'limit', 'intervalHours', 'enabled']) {
          if (args[key] !== undefined) patch[key] = args[key]
        }
        if (args.saveConfig === true || Object.keys(patch).length > 0) writeCollectorConfig({ ...readCollectorConfig(), ...patch })
        const result = await runCollector({ ...patch, force: args.force === true }, { home: resolveDshHome() })
        if (result.skipped) return { ok: true, skipped: true, reason: result.reason, text: `采集器跳过：${result.reason}` }
        const failed = result.sources.filter((row) => !row.ok && !row.skipped)
        const text = [
          `本轮采集结束：累计 ${result.summary.mergedCandidates} 条合并候选；本轮读取 ${result.summary.rawCandidates} 条；完整窗口 ${result.summary.completeSources}/${result.summary.sourceCount}，部分 ${result.summary.partialSources}。`,
          ...result.sources.map(row => `- ${row.source}: ${row.status || 'unknown'}; ${row.coverage || 'unknown coverage'}; 水位 ${row.watermark || '未推进'}${row.limitation ? `; ${row.limitation}` : ''}`),
          ...(failed.length ? ['失败源：', ...failed.map((row) => `- ${row.source}: ${row.error}`)] : []),
          ...(result.summary.skippedSources ? [`跳过 ${result.summary.skippedSources} 个源（未配置公众号检索词等）。`] : []),
        ].join('\n')
        return { ok: true, ...collectorResponse(result), text }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_metrics',
    description: 'Read costs and reviewed result counts; feedback alone never confirms a finding.',
    parameters: {
      action: { type: 'string', enum: ['get', 'record'], required: true },
      kind: { type: 'string', enum: ['false-positive', 'confirmed-rce'], description: 'Required for action=record' },
      runId: { type: 'string', description: 'Optional scope-hunt runId used to compute query-to-RCE duration' },
      count: { type: 'integer', description: 'Legacy feedback quantity only' },
      findingId: { type: 'string', description: 'Current-session reviewed result id' },
      note: { type: 'string', description: 'Short evidence note' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, value) => [{ type: 'text', text: value.ok ? value.text : `nday_metrics 失败：${value.error}` }],
    },
    async execute(args, exec) {
      try {
        if (args.action === 'record') {
          const event = recordFeedbackMetric({
            kind: args.kind,
            runId: args.runId,
            count: args.count,
            note: args.note,
            findingId: args.findingId,
            sessionId: exec?.agent?.session?.id || '',
          })
          return { ok: true, event, text: `已记录 ${event.kind} 反馈；成果数以当前证据与复核记录为准。` }
        }
        const metrics = summarizeMetrics(undefined, { sessionId: exec?.agent?.session?.id || '' })
        const text = [
          `搜索 ${metrics.searches} 次 / 匹配 ${metrics.matches} 次；候选 ${metrics.candidates}；API 请求 ${metrics.apiRequests}。`,
          `首轮命中率 ${metrics.firstRoundHitRate === null ? '暂无' : (metrics.firstRoundHitRate * 100).toFixed(1) + '%'}；指纹误报率 ${metrics.fingerprintFalsePositiveRate === null ? '暂无' : (metrics.fingerprintFalsePositiveRate * 100).toFixed(1) + '%'}。`,
          `已确认 RCE ${metrics.confirmedRce === null ? '暂无有效成果库' : metrics.confirmedRce}；完整复现 ${metrics.reproducedFindings ?? '暂无'}；查询到 RCE 平均 ${metrics.averageQueryToRceMs === null ? '暂无' : Math.round(metrics.averageQueryToRceMs / 1000) + 's'}。`,
        ].join('\n')
        return { ok: true, metrics, text }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_catalog',
    description: 'Filter the Nday corpus or read one entry’s probes and next tools.',
    parameters: {
      keyword: { type: 'string', description: 'Free-text match over id/product/alias/CVE/QVD/versions' },
      status: { type: 'string', description: 'normalized | verified | legacy-unreviewed | deprecated' },
      product: { type: 'string', description: 'Substring match on product name' },
      category: { type: 'string', description: 'Substring match on category, e.g. 信创 / OA / 报表' },
      entryId: { type: 'string', description: 'Return full detail for one entry' },
      limit: { type: 'integer', description: 'Max rows in list mode (default 50)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `nday_catalog 失败：${v.error}` }],
    },
    async execute(args, exec) {
      try {
        const { catalog } = catalogOrThrow()
        if (args.entryId) {
          const entry = getEntry(catalog, args.entryId)
          if (!entry) return { ok: false, error: `catalog 里没有条目 ${args.entryId}` }
          const lines = [
            `# ${entry.product} — ${entry.vulnClass}`,
            `id: ${entry.id}  vendor: ${entry.vendor}  category: ${entry.category}`,
            `编号: ${JSON.stringify(entry.ids)}  严重性: CVSS ${entry.severity?.cvss31} (${entry.severity?.level})  认证前置: ${entry.auth}`,
            `影响版本: ${(entry.affectedVersions ?? []).join(' | ')}`,
            `状态: ${entry.status}${entry.verification?.reproduced ? '（我方已复现）' : '（**尚未由我们复现**，结论措辞必须对应）'}`,
            // 语料里有一批是**从 nuclei 模板批量导入**的（未经人工复核）。
            // 不标出来的话，模型会把它们和逐条复核过的条目同等对待——那是误导。
            ...(entry.importedFrom
              ? [`来源形态: 由 nuclei 模板 \`${entry.importedFrom.id}\` **批量导入，未经人工复核**（端点与判据来自模板，可能过时）`]
              : []),
            `验证方式: ${entry.verify?.method} / OOB=${(entry.verify?.oob ?? []).join(',')} / 噪声=${entry.verify?.noise}`,
            `验证要点: ${entry.verify?.note ?? ''}`,
            `可利用原语: ${(entry.exploit?.primitives ?? []).join(' | ')}`,
            `交接工具: ${(entry.exploit?.tools ?? []).join(' | ')}`,
            // 复用率的交接点：命中一个资产只是起点，真正值钱的是拿同指纹语法反查同类资产全集。
            // 语料里早就逐条记了测绘语法，此前从没暴露给模型——这里把它原样透传出去。
            ...(() => {
              const queries = expansionQueries(entry)
              return queries.length === 0
                ? ['同类资产扩面: （本条没记测绘语法，反查不了；只能按产品名人工确认）']
                : ['同类资产扩面（目录显式语法或 GET/HEAD 探针响应签名；命中只作候选）:',
                   `  - call=nday_scope_hunt entryIds="${entry.id}" scope=<精确范围> workspace=<任务目录>`,
                   ...queries.map((q) => `  - query=${q}`)]
            })(),
            `误报点: ${(entry.fingerprint?.falsePositiveNotes ?? []).join(' / ')}`,
            `修复: ${entry.remediation?.vendorUrl ?? ''}`,
            `来源: ${(entry.sources ?? []).map((s) => s.url).join(' ')}`,
          ]
          return { ok: true, entry: summarizeEntry(entry), text: lines.join('\n') }
        }
        const rows = listEntries(catalog, args)
        if (rows.length === 0) return { ok: true, entries: [], text: '（没有匹配的条目）' }
        const text = [
          `共 ${rows.length} 条（catalog 全量 ${catalog.entries.length} 条，更新 ${catalog.updated}）`,
          ...rows.map((e) => `- ${e.id} | ${e.product} | ${e.vulnClass} | 状态 ${e.status} | 探针 ${e.fingerprint?.probes?.length ?? 0} 条`),
        ].join('\n')
        return { ok: true, entries: rows.map(summarizeEntry), text }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_scope_hunt',
    description: 'FOFA-first Nday search; auto-falls back to Hunter/Quake. Candidates only.',
    parameters: {
      scope: { type: 'string', description: 'Exact domains, IPs, or CIDRs. *.domain excludes the apex.' },
      identity: { type: 'object', description: 'FOFA organization identity: ICP, domains, name, aliases.', properties: {
        icp: { type: 'string' }, domains: { type: 'array', items: { type: 'string' } },
        organizationName: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } },
      }, additionalProperties: false },
      workspace: { type: 'string', required: true, description: 'Workspace for candidates and evidence' },
      focus: { type: 'string', enum: ['rce', 'all'], description: 'RCE by default, or all classes' },
      keyword: { type: 'string', description: 'Optional product, vendor, or CVE filter' },
      entryIds: { type: 'string', description: 'Optional comma-separated catalog IDs' },
      limit: { type: 'integer', description: 'Fingerprint groups per batch; default 5, max 20.' },
      offset: { type: 'integer', description: 'Next batch offset from prior result' },
      platform: { type: 'string', enum: ['auto', 'fofa', 'hunter', 'quake'], description: 'Provider; auto tries FOFA → Hunter → Quake.' },
      size: { type: 'integer', description: 'Rows per query; default 50, max 500' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, value) => [{
        type: 'text',
        text: value.text || (value.ok ? '' : `nday_scope_hunt 失败：${value.error}`),
      }],
    },
    async execute(args, exec) {
      const startedAt = new Date().toISOString()
      const scope = String(args.scope || '').trim()
      const rawIdentity = args.identity && typeof args.identity === 'object' ? args.identity : {}
      const identity = {
        icp: String(rawIdentity.icp ?? '').trim().slice(0, 120),
        domains: (Array.isArray(rawIdentity.domains) ? rawIdentity.domains : []).map((value) => String(value ?? '').trim()).filter(Boolean).slice(0, 2),
        organizationName: String(rawIdentity.organizationName ?? '').trim().slice(0, 120),
        aliases: (Array.isArray(rawIdentity.aliases) ? rawIdentity.aliases : []).map((value) => String(value ?? '').trim()).filter(Boolean).slice(0, 1),
      }
      const identityVariants = campaignIdentityVariants(identity)
      const campaignMode = identityVariants.length > 0
      const candidateOnly = campaignMode && !scope
      if (!scope && !campaignMode) {
        return { ok: false, state: 'scope_missing', error: 'scope_missing：会话中没有精确范围或机构身份；未执行 FOFA 请求。', text: 'scope_missing：没有精确范围或机构身份；未执行 FOFA 请求。' }
      }
      if (!String(args.workspace || '').trim()) return { ok: false, error: 'workspace 不能为空' }
      const workspace = resolveWorkspaceArg(args.workspace, exec)
      const requestedLimit = Number.isFinite(args.limit) && args.limit > 0 ? Math.min(20, Math.floor(args.limit)) : 5
      const limit = requestedLimit
      const focus = args.focus === 'all' ? 'all' : 'rce'
      let catalog
      try { ({ catalog } = catalogOrThrow()) } catch (error) { return { ok: false, error: String(error?.message || error) } }
      const plan = buildNdaySearchPlan(catalog, {
        focus,
        keyword: args.keyword,
        entryIds: args.entryIds,
        limit,
        offset: args.offset,
      })
      if (plan.selected.length === 0) {
        const atEnd = plan.queryGroups > 0 && plan.offset >= plan.queryGroups
        const text = atEnd
          ? `Nday FOFA 分页已到末尾：offset=${plan.offset}，总查询组=${plan.queryGroups}，nextOffset=null。请停止，不要继续调用更大的 offset。`
          : `Nday FOFA 搜索计划为空：筛到 ${plan.matchedEntries} 条条目、${plan.queryGroups} 组测绘查询；检查 focus/keyword/entryIds。`
        return {
          ok: true, searchId: null, focus, queryCount: 0, candidateCount: 0,
          nextOffset: null, plan,
          text: text + (plan.rejectedHints.length ? `\n无效指纹 ${plan.rejectedHints.length} 条，未自动扩宽；需修订指纹。` : ''),
        }
      }
      const pagination = (plan.rejectedHints.length ? `无效指纹 ${plan.rejectedHints.length} 条，未自动扩宽；详情见计划。\n` : '') + (plan.nextOffset === null
        ? `分页状态：offset=${plan.offset}，总查询组=${plan.queryGroups}，nextOffset=null（末页）。本页无论成功或失败都应停止，不要请求更大的 offset。`
        : `分页状态：offset=${plan.offset}，总查询组=${plan.queryGroups}，nextOffset=${plan.nextOffset}。`)
      if (typeof ctx.tools?.execute !== 'function') {
        const error = '宿主未提供 tools.execute，无法调用 dsh-hunter 的 asset_search_batch'
        return { ok: false, error, text: `nday_scope_hunt 失败：${error}\n${pagination}` }
      }
      const queries = campaignMode
        ? buildCampaignNdayQueries(plan, identity, 20)
        : plan.selected.map((group, index) => ({
            id: 'q' + String(plan.offset + index + 1).padStart(3, '0'),
            query: group.query,
            basis: group.basis,
            entryIds: group.entryIds,
          }))
      const supportedMeasurementFields = {
        hunter: new Set(['app', 'body', 'cert', 'domain', 'header', 'ip', 'port', 'protocol', 'server', 'title']),
        quake: new Set(['app', 'body', 'cert', 'domain', 'header', 'icon_hash', 'ip', 'port', 'protocol', 'server', 'title']),
      }
      const fieldWarningsFor = (platform) => {
        const supported = supportedMeasurementFields[platform]
        if (!supported) return []
        const seen = new Set()
        for (const query of queries) {
          const tree = parseQueryExpression(query.query)
          for (const term of queryTerms(tree)) {
            const field = term.field
            if (!supported.has(field)) seen.add(field)
          }
          if (!compileQueryExpression(tree, platform)) seen.add('表达式/等号语义')
        }
        return [...seen].map((field) => `${platform} 不支持字段或语义 ${field}；该查询组必须拒绝，不做宽查询降级。`)
      }
      const requestedPlatform = ['auto', 'fofa', 'hunter', 'quake'].includes(String(args.platform))
        ? String(args.platform) : 'auto'
      if (candidateOnly && requestedPlatform !== 'auto' && requestedPlatform !== 'fofa') {
        return {
          ok: false,
          error: '机构身份候选查询仅支持 FOFA：Hunter/Quake 不支持 ICP、证书组织、icon_hash 等身份字段；未执行请求。',
          text: '机构身份候选查询仅支持 FOFA：Hunter/Quake 不支持 ICP、证书组织、icon_hash 等身份字段；未执行请求。',
        }
      }
      const platformOrder = candidateOnly ? ['fofa']
        : requestedPlatform === 'auto' ? ['fofa', 'hunter', 'quake'] : [requestedPlatform]
      const platformAttempts = []
      let batch = null
      let activePlatform = platformOrder[0]
      for (const platform of platformOrder) {
        const attemptFieldWarnings = fieldWarningsFor(platform)
        const batchArguments = candidateOnly
          ? { queries, workspace }
          : { queries, workspace, platform, scope }
        if (Number.isFinite(args.size)) batchArguments.size = args.size
        const batchExecution = {
          callId: `nday-asset-batch-${stamp()}`,
          name: candidateOnly ? 'asset_candidate_search_batch' : 'asset_search_batch',
          arguments: batchArguments,
          signal: exec?.signal ?? new AbortController().signal,
        }
        if (exec?.rootCallId !== undefined) batchExecution.rootCallId = exec.rootCallId
        if (exec?.token !== undefined) batchExecution.parent = exec.token
        if (exec?.agent !== undefined) batchExecution.agent = exec.agent
        let raw
        try {
          raw = await ctx.tools.execute(batchExecution)
        } catch (error) {
          const detail = String(error?.message || error)
          const message = /unknown tool|not found|no tool|asset_search_batch/i.test(detail)
            ? '当前宿主没有可执行的 asset_search_batch（请检查 dsh-hunter 插件是否加载并向本会话暴露）'
            : `${platform} 查询失败：${detail}`
          platformAttempts.push({ platform, ok: false, error: message, fieldWarnings: attemptFieldWarnings })
          if (requestedPlatform === 'auto' && platform !== platformOrder[platformOrder.length - 1]) continue
          return { ok: false, error: message, text: `nday_scope_hunt 失败：${message}\n${pagination}`, platformAttempts, fieldWarnings: attemptFieldWarnings }
        }
        if (raw?.isError === true) {
          const failure = raw.error
          const detail = typeof failure === 'string'
            ? failure
            : String(failure?.message ?? failure?.code ?? '宿主工具执行失败')
          const message = /unknown tool|not found|no tool|asset_search_batch/i.test(detail)
            ? '当前宿主没有可执行的 asset_search_batch（请检查 dsh-hunter 插件是否加载并向本会话暴露）'
            : `${platform} 执行失败：${detail}`
          platformAttempts.push({ platform, ok: false, error: message, fieldWarnings: attemptFieldWarnings })
          if (requestedPlatform === 'auto' && platform !== platformOrder[platformOrder.length - 1]) continue
          return {
            ok: false,
            error: message,
            text: `nday_scope_hunt 失败：${message}${attemptFieldWarnings.length ? `\n字段差异：\n${attemptFieldWarnings.map((line) => `- ${line}`).join('\n')}` : ''}\n${pagination}`,
            platformAttempts,
            fieldWarnings: attemptFieldWarnings,
            detail: { code: String(failure?.code ?? ''), message: detail },
          }
        }
        const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw
        if (!value || value.ok !== true) {
          const error = String(value?.error || raw?.error || `${platform} 未返回成功结果`)
          platformAttempts.push({ platform, ok: false, error, fieldWarnings: attemptFieldWarnings })
          if (requestedPlatform === 'auto' && platform !== platformOrder[platformOrder.length - 1]) continue
          return { ok: false, error, text: `nday_scope_hunt 失败：${error}${attemptFieldWarnings.length ? `\n字段差异：\n${attemptFieldWarnings.map((line) => `- ${line}`).join('\n')}` : ''}\n${pagination}`, platformAttempts, fieldWarnings: attemptFieldWarnings, detail: value }
        }
        batch = value
        activePlatform = platform
        platformAttempts.push({ platform, ok: true, configuredPlatforms: value.configuredPlatforms ?? [], fieldWarnings: attemptFieldWarnings })
        break
      }
      if (!batch) {
        const error = platformAttempts.map((row) => `${row.platform}: ${row.error}`).join('；') || '没有可用平台'
        return { ok: false, error, text: `nday_scope_hunt 失败：${error}\n${pagination}`, platformAttempts }
      }
      const degradedFrom = platformAttempts.slice(0, -1).map((row) => row.platform)
      const fieldWarnings = fieldWarningsFor(activePlatform)
      const queryById = new Map((batch.queryResults ?? []).map((result) => [String(result.id), result]))
      const candidates = new Map()
      const queryEvidence = []
      for (let i = 0; i < queries.length; i += 1) {
        const query = queries[i]
        const group = { entryIds: query.entryIds || [] }
        const result = queryById.get(query.id)
        queryEvidence.push({
          id: query.id,
          query: query.query,
          basis: query.basis,
          entryIds: group.entryIds,
          identityType: query.identityType || '',
          ok: result?.ok === true,
          error: result?.ok === true ? '' : String(result?.error || '查询组结果缺失'),
          platformErrors: result?.platformErrors ?? [],
          resultCount: Array.isArray(result?.assets) ? result.assets.length : 0,
        })
        if (result?.ok !== true) continue
        for (const asset of result.assets ?? []) {
          const safe = scope ? scopeBoundAsset(asset, scope) : asset
          if (!safe) continue
          const key = [safe.target, safe.host, safe.ip, safe.port].map((v) => String(v ?? '').toLowerCase()).join('|')
          let candidate = candidates.get(key)
          if (!candidate) {
            candidate = { asset: safe, entryIds: [], queryIds: [], identityTypes: [] }
            candidates.set(key, candidate)
          }
          for (const id of group.entryIds) if (!candidate.entryIds.includes(id)) candidate.entryIds.push(id)
          if (!candidate.queryIds.includes(query.id)) candidate.queryIds.push(query.id)
          if (query.identityType && !candidate.identityTypes.includes(query.identityType)) candidate.identityTypes.push(query.identityType)
        }
      }
      const searchId = `nday-${stamp()}`
      const dir = ensureDirs(workspace)
      const file = path.join(dir, `nday-scope-hunt-${searchId}.json`)
      const failedGroups = queryEvidence.filter((row) => !row.ok).length
      const quality = {
        catalogFingerprintEntries: plan.catalogFingerprintEntries.length,
        probeSignatureEntries: plan.probeSignatureEntries.length,
        productAliasFallbackEntries: plan.fallbackEntries.length,
        portRefinedEntries: plan.portRefinedEntries.length,
        entriesWithoutUsableQuery: plan.withoutQuery.length,
        queryGroupBasis: plan.queryGroupBasis,
      }
      const artifact = {
        schema: 'saker.nday-scope-hunt/1',
        searchId,
        generatedAt: new Date().toISOString(),
        catalogUpdated: plan.catalogUpdated,
        focus,
        platform: activePlatform,
        platformAttempts,
        degradedFrom,
        fieldWarnings,
        scope: scope || null,
        identity: campaignMode ? identity : null,
        candidateOnly,
        plan: {
          offset: plan.offset,
          limit: plan.limit,
          matchedEntries: plan.matchedEntries,
          queryGroups: plan.queryGroups,
          nextOffset: plan.nextOffset,
          quality,
        },
        queries: queryEvidence,
        candidates: [...candidates.values()],
        summary: {
          attemptedGroups: queries.length,
          successfulGroups: queries.length - failedGroups,
          failedGroups,
          candidateCount: candidates.size,
          estimatedApiRequests: Number(batch.estimatedRequests) || 0,
          platform: activePlatform,
          degradedFrom,
        },
      }
      fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + '\n', 'utf8')
      appendEvidence(workspace, searchId, `FOFA Nday 指纹搜索 ${artifact.summary.successfulGroups}/${queries.length} 组；${candidateOnly ? '仅写被动候选文件' : '结果已按精确范围筛选'}`, path.relative(workspace, file).replace(/\\/g, '/'))
      const basisByQuery = new Map(queryEvidence.map((query) => [query.id, query.basis]))
      const sample = artifact.candidates.slice(0, 6).map((candidate) => {
        const bases = candidate.queryIds.map((id) => basisByQuery.get(id)).filter(Boolean)
        const target = candidate.asset.target || candidate.asset.host || [candidate.asset.ip, candidate.asset.port].filter(Boolean).join(':')
        const clues = [
          candidate.asset.icp && `ICP=${candidate.asset.icp}`,
          candidate.asset.certSubjectOrg && `证书组织=${candidate.asset.certSubjectOrg}`,
          candidate.asset.certSubjectCn && `证书名称=${candidate.asset.certSubjectCn}`,
          (candidate.asset.asn || candidate.asset.org) && `ASN=${candidate.asset.asn || '-'} ${candidate.asset.org || ''}`.trim(),
          (candidate.asset.city || candidate.asset.region) && `地区=${[candidate.asset.region, candidate.asset.city].filter(Boolean).join('/')}`,
        ].filter(Boolean)
        return `- ${target || '未知地址'}；候选条目 ${candidate.entryIds.join(', ')}；身份查询 ${candidate.identityTypes.join(', ') || 'Nday 指纹'}${clues.length ? `；FOFA 归属线索 ${clues.join('、')}` : ''}；查询依据 ${measurementBasisLabel(bases)}`
      })
      const text = [
        (candidateOnly ? 'Nday 机构候选搜索：' : 'Nday 范围搜索：') + artifact.summary.successfulGroups + '/' + queries.length + ' 个查询组成功，' + artifact.summary.candidateCount + ' 个去重候选资产；平台 ' + activePlatform + (degradedFrom.length ? `（已从 ${degradedFrom.join(' → ')} 降级）` : '') + '；预计 ' + artifact.summary.estimatedApiRequests + ' 次 API 请求。',
        `目录更新时间：${plan.catalogUpdated || '未标注'}；范围：${scope || '未提供（仅被动候选）'}。`,
        `查询覆盖：${quality.catalogFingerprintEntries} 条目录明确指纹、${quality.probeSignatureEntries} 条探针响应签名；${quality.productAliasFallbackEntries} 条仍依赖产品别名兜底，${quality.entriesWithoutUsableQuery} 条没有可用查询。`,
        ...(fieldWarnings.length ? ['字段差异：', ...fieldWarnings.map((line) => `- ${line}`)] : []),
        ...(failedGroups ? [`${failedGroups} 个查询组失败；失败与“没有命中”分开记录，详见证据文件。`] : []),
        ...(sample.length ? ['', '候选样例（测绘指纹不代表受影响版本）：', ...sample] : ['未发现候选资产；先检查查询组失败原因和 FOFA 账号可用字段等级。']),
        `证据：${path.relative(workspace, file).replace(/\\/g, '/')}`,
        ...(candidateOnly ? ['当前仅有机构身份线索；结果保存在候选文件中，不进入活动资产账本，也不执行主机探测。'] : []),
        ...(scope && artifact.candidates.length ? [`下一步：nday_match assetSource=nday-search searchId=${searchId} scope="${scope}" workspace="${workspace}"（按候选条目映射做轻量筛查）`] : []),
        ...(plan.nextOffset !== null ? [`更多查询：再次调用 nday_scope_hunt，offset=${plan.nextOffset}；单批最多 20 组。`] : []),
      ].join('\n')
      try {
        recordSearchMetric({
          runId: searchId,
          source: activePlatform,
          candidateCount: candidates.size,
          apiRequests: artifact.summary.estimatedApiRequests,
          queryCount: queries.length,
          successfulGroups: artifact.summary.successfulGroups,
          startedAt,
          finishedAt: new Date().toISOString(),
        })
      } catch { /* metrics must not break a completed search */ }
      return {
        ok: true,
        searchId,
        focus,
        candidateOnly,
        platform: activePlatform,
        platformAttempts,
        degradedFrom,
        fieldWarnings,
        queryCount: queries.length,
        successfulGroups: artifact.summary.successfulGroups,
        failedGroups,
        candidateCount: candidates.size,
        quality,
        estimatedApiRequests: artifact.summary.estimatedApiRequests,
        estimatedSecondsAtFofaLimit: Math.ceil(artifact.summary.estimatedApiRequests * 1.1),
        nextOffset: plan.nextOffset,
        candidates: artifact.candidates,
        file: path.relative(workspace, file).replace(/\\/g, '/'),
        text,
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'attack_plan',
    description: 'Group in-scope inventory by fingerprint and write a ranked attack plan.',
    parameters: {
      workspace: { type: 'string', required: true, description: 'Workspace containing asset-inventory.json' },
      scope: { type: 'string', required: true, description: 'Exact domains/IPs/CIDRs; other assets are excluded.' },
      entryIds: { type: 'string', description: 'Optional catalog IDs' },
      minAssets: { type: 'integer', description: 'Minimum assets per bucket (default 1)' },
      maxBuckets: { type: 'integer', description: 'Maximum buckets (default 50, cap 200)' },
      registerIntents: { type: 'boolean', description: 'Register tasks (default false)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `attack_plan 失败：${v.error}` }],
    },
    async execute(args, exec) {
      const workspace = resolveWorkspaceArg(args.workspace, exec)
      const scope = String(args.scope || '').trim()
      if (!scope) return { ok: false, error: 'scope 不能为空——资产分桶必须限定本轮精确范围' }
      const inventory = readInventory(workspace)
      const assets = inventory.assets.map((asset) => scopeBoundAsset(asset, scope)).filter(Boolean)
      const assetsExcludedByScope = inventory.assets.length - assets.length
      if (assets.length === 0) {
        return { ok: false, error: `${path.join(workspace, 'asset-inventory.json')} 没有可用资产；先 asset_search / asset_ingest` }
      }
      let catalog
      try {
        ({ catalog } = catalogOrThrow())
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
      const ids = String(args.entryIds || '').split(',').map((value) => value.trim()).filter(Boolean)
      const entries = candidateEntries(catalog, ids)
      const plan = buildAttackPlan(entries, assets, {
        minAssets: args.minAssets,
        maxBuckets: args.maxBuckets,
      })
      const jsonFile = path.join(workspace, 'fingerprint-buckets.json')
      const mdFile = path.join(workspace, 'attack-plan.md')
      fs.writeFileSync(jsonFile, JSON.stringify(plan, null, 2) + '\n', 'utf8')
      fs.writeFileSync(mdFile, renderAttackPlan(plan), 'utf8')
      const graph = { registered: 0, skipped: 0, reason: args.registerIntents === true ? '' : '本次未启用内部任务登记' }
      if (args.registerIntents === true) {
        try {
          const gate = await import('@dsh-external/dsh-stage-gate')
          const state = gate.readOperationState(fs, workspace)
          if (!state) graph.reason = 'operation-state.json 不存在，未登记任务'
          else {
            const existing = new Set((state.intents || []).map((item) => item?.bucketId).filter(Boolean))
            for (const bucket of plan.buckets) {
              if (existing.has(bucket.bucketId)) {
                graph.skipped += 1
                continue
              }
              gate.registerIntent(workspace, {
                summary: `Nday 资产组 ${bucket.entryId}：${bucket.assetIds.length} 个资产`,
                anchorKind: 'boot',
                owner: bucket.owner,
                maxAttempts: 2,
                stage: 'S4/S5',
                bucketId: bucket.bucketId,
                targetIds: bucket.assetIds,
                reuseScore: bucket.reuseScore,
              })
              graph.registered += 1
            }
          }
        } catch (error) {
          graph.reason = String(error?.message || error)
        }
      }
      appendEvidence(workspace, `attack-plan-${stamp()}`, `attack_plan ${plan.totalAssets} assets → ${plan.buckets.length} buckets`, 'attack-plan.md')
      const text = [
        `范围内优先清单：${plan.totalAssets} 个资产 → ${plan.buckets.length} 个资产组（范围外跳过 ${assetsExcludedByScope} 项；线索 ${plan.clues.length} 条）`,
        ...plan.buckets.slice(0, 10).map((bucket, index) => `${index + 1}. ${bucket.entryId} · 资产 ${bucket.assetIds.length} · 代表资产 ${bucket.representativeAssetId} · 优先分 ${bucket.reuseScore} · ${bucket.status}`),
        `内部任务登记：${graph.registered} 个新组${graph.skipped ? `，跳过 ${graph.skipped} 个已有任务` : ''}${graph.reason ? `（${graph.reason}）` : ''}`,
        '',
        '计划：`fingerprint-buckets.json`',
        '人读：`attack-plan.md`',
        // 下一跳的**收窄引导**：不带 entryIds 全量跑会撞上单次 800 次探测的上限，
        // 与其让模型撞墙再回读报错，不如在这里就把「按桶跑」写清楚。
        `下一步：逐组验证——nday_match assetSource=inventory scope="${scope}" entryIds=<该组 entryId>（一次只跑这一组的条目）。`,
        '⚠ 不要不带 entryIds 全量跑：全部可筛条目 × 全部资产会撞上单次 800 次探测的上限，工具会直接拒绝并让你收窄。',
        '纪律：独立应用分别校准；同组仍独立确认身份、正常请求、适用条件和实际影响。探针命中只是线索，按redteam_task的当前停止规则工作。',
      ]
      return { ok: true, plan, graph, assetsExcludedByScope, files: { json: 'fingerprint-buckets.json', markdown: 'attack-plan.md' }, text: text.join('\n') }
    },
  }))

  registerNdayTool(defineTool({
    name: 'attack_gate',
    description: 'Record a representative asset result; confirmation unlocks batch spread.',
    parameters: {
      action: { type: 'string', enum: ['status', 'record'], required: true, description: 'Show gates or record the representative result' },
      workspace: { type: 'string', required: true, description: 'Workspace containing fingerprint-buckets.json' },
      bucketId: { type: 'string', description: 'Bucket ID for record' },
      assetId: { type: 'string', description: 'Chosen representative asset ID' },
      outcome: { type: 'string', enum: ['confirmed', 'refuted'], description: 'Representative check result' },
      evidence: { type: 'string', description: 'Evidence location or concise summary' },
      note: { type: 'string', description: 'Optional stop, cleanup, or next step' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `attack_gate 失败：${v.error}` }],
    },
    execute(args, exec) {
      const workspace = resolveWorkspaceArg(args.workspace, exec)
      const planFile = path.join(workspace, 'fingerprint-buckets.json')
      let plan
      try { plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) } catch {
        return { ok: false, error: `读不到资产组计划：${planFile}；先跑 attack_plan` }
      }
      const progressFile = path.join(workspace, ATTACK_PROGRESS_FILE)
      let progress = emptyProgress()
      try { progress = JSON.parse(fs.readFileSync(progressFile, 'utf8')) } catch { /* 首次记录前还没有文件 */ }
      if (args.action === 'record') {
        const result = recordGate(plan, progress, args)
        if (!result.ok) return { ok: false, error: result.error }
        fs.writeFileSync(progressFile, JSON.stringify(result.progress, null, 2) + '\n', 'utf8')
        appendEvidence(workspace, `attack-gate-${stamp()}`, `attack_gate ${args.bucketId} ${args.outcome}`, ATTACK_PROGRESS_FILE)
        progress = result.progress
      }
      const gates = bucketGates(plan, progress)
      return {
        ok: true,
        gates,
        progressFile: ATTACK_PROGRESS_FILE,
        text: [
          renderGateStatus(gates),
          '',
          `状态文件：\`${ATTACK_PROGRESS_FILE}\``,
          '纪律：代表资产确认后只铺开同一资产组；证伪后写证据转下一组。',
        ].join('\n'),
      }
    },
  }))

  if (enablePostRceTools) registerNdayTool(defineTool({
    name: 'memshell_cli',
    description: 'Plan or run a self-hosted memparty action with host approval.',
    parameters: {
      action: { type: 'string', enum: ['status', 'plan', 'run'], required: true },
      workspace: { type: 'string' },
      transport: { type: 'string', enum: ['cli', 'mcp'] },
      command: { type: 'string', enum: ['version', 'config', 'probe', 'gen', 'connect', 'exec', 'upload', 'download', 'save', 'list', 'note', 'remove', 'log', 'profile', 'custom'] },
      args: { type: 'array', items: { type: 'string' } },
      mcpTool: { type: 'string' },
      mcpArgs: { type: 'json' },
      planId: { type: 'string' },
      note: { type: 'string' },
      approval: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `memshell_cli 失败：${v.error}` }],
    },
    async execute(args, exec) {
      const action = String(args.action || '')
      const config = memshellConfig(ctx)
      if (action === 'status') {
        const backend = classifyMemoryBackend(config)
        let mcpVisible = false
        try {
          const names = ctx.get('tools')?.view?.(void 0)
          mcpVisible = Array.isArray(names) && names.some((name) => String(name).startsWith(`mcp__${config.mcpServer}__`))
        } catch { /* 工具表不可见时只报告配置状态 */ }
        return {
          ok: true,
          ready: backend.ready,
          backend,
          text: [
            backend.ready ? `memparty 适配器就绪：自建 backend ${backend.host}` : `memparty 适配器未就绪：${backend.reason}`,
            `CLI：${config.cliPath || 'memparty'}`,
            `MCP：${config.mcpServer || 'memshell-party'}${mcpVisible ? '（工具面可见）' : '（尚未发现工具面）'}`,
            '纪律：公共 party.mem.mk 固定拒绝；执行计划必须经宿主审批。',
          ].join('\n'),
        }
      }
      const workspace = resolveWorkspaceArg(args.workspace, exec)
      if (action === 'plan') {
        const transport = String(args.transport || 'cli').toLowerCase()
        const built = transport === 'mcp' ? buildMemshellMcpPlan(config, args) : buildMemshellCliPlan(config, args)
        if (!built.ok) return { ok: false, error: built.error }
        const dir = ensureMemshellDir(workspace)
        const prefix = transport === 'mcp' ? 'mcp-plan' : 'cli-plan'
        const file = path.join(dir, `${prefix}-${built.plan.planId}.json`)
        fs.writeFileSync(file, JSON.stringify(built.plan, null, 2) + '\n', 'utf8')
        appendEvidence(workspace, `memshell-plan-${built.plan.planId}`, 'memshell_cli plan', path.relative(workspace, file).replace(/\\/g, '/'))
        const publicPlan = { ...built.plan }
        delete publicPlan.argv
        delete publicPlan.args
        delete publicPlan.approvalToken
        return {
          ok: true,
          plan: publicPlan,
          file: path.relative(workspace, file).replace(/\\/g, '/'),
          text: [
            `memparty 计划：${built.plan.commandLine || built.plan.name}`,
            `planId：${built.plan.planId}`,
            `通道：${built.plan.transport || 'cli'}`,
            `风险：${built.plan.risk}`,
            built.plan.approvalRequired ? `需要宿主人工审批；批准短语：${built.plan.approvalPhrase}` : '该命令为只读/诊断命令。',
            `计划文件：${path.relative(workspace, file).replace(/\\/g, '/')}`,
          ].join('\n'),
        }
      }
      if (action === 'run') {
        const planId = String(args.planId || '').trim()
        if (!planId) return { ok: false, error: 'run 需要 planId（先 action=plan）' }
        const note = String(args.note || '').trim()
        if (!note) return { ok: false, error: 'run 需要 note：写明用户已明确批准本次执行' }
        const prefix = planId.startsWith('mp-') ? 'mcp-plan' : 'cli-plan'
        const file = path.join(ensureMemshellDir(workspace), `${prefix}-${planId}.json`)
        let plan
        try { plan = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { ok: false, error: `计划不存在或不可读：${planId}` } }
        if (plan.approvalRequired && String(args.approval || '') !== plan.approvalPhrase) {
          return { ok: false, error: `批准短语不匹配；先 plan 后复制该计划的 approvalPhrase（本次已登记计划 ${planId}）` }
        }
        const backend = classifyMemoryBackend(config)
        if (!backend.ready) return { ok: false, error: `执行前自建 backend 不可用：${backend.reason}` }
        if (backend.host !== plan.backendHost) return { ok: false, error: `backend 已变化：计划=${plan.backendHost}，当前=${backend.host}` }
        let result
        let audit
        let prefixRun
        if (plan.schema === 'saker.memshell-mcp-plan/1') {
          const startedAt = new Date().toISOString()
          try {
            const raw = await ctx.tools.execute({
              name: plan.name,
              arguments: {
                ...plan.args,
                __sakerMemshellPlanId: plan.planId,
                __sakerMemshellApprovalToken: plan.approvalToken,
              },
            })
            const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw
            result = {
              ok: !(value && value.isError === true) && !(raw && raw.isError === true),
              text: typeof value === 'string' ? value : JSON.stringify(value ?? raw ?? null),
            }
          } catch (error) {
            result = { ok: false, text: '', error: String(error?.message || error) }
          }
          audit = {
            schema: 'saker.memshell-mcp-run/1',
            planId,
            mcpName: plan.name,
            risk: plan.risk,
            argsPreview: plan.argsPreview || redactObject(plan.args || {}),
            note,
            backendHost: backend.host,
            startedAt,
            finishedAt: new Date().toISOString(),
            ...result,
          }
          prefixRun = 'mcp-run'
        } else {
          result = executeMemshellCliPlan(plan)
          audit = {
            schema: 'saker.memshell-cli-run/1',
            ...result,
            note,
            backendHost: backend.host,
            argvPreview: plan.argvPreview,
          }
          prefixRun = 'cli-run'
        }
        const auditFile = path.join(ensureMemshellDir(workspace), `${prefixRun}-${planId}-${stamp()}.json`)
        fs.writeFileSync(auditFile, JSON.stringify(audit, null, 2) + '\n', 'utf8')
        appendEvidence(workspace, `memshell-run-${planId}`, `memshell_cli run ${plan.command || plan.name}`, path.relative(workspace, auditFile).replace(/\\/g, '/'))
        return {
          ok: result.ok,
          result: audit,
          file: path.relative(workspace, auditFile).replace(/\\/g, '/'),
          text: [
            `${result.ok ? '执行成功' : '执行失败'}：${plan.commandLine || plan.name}`,
            result.exitCode !== undefined ? `exit=${result.exitCode ?? '-'}${result.timedOut ? ' timeout' : ''}` : '',
            result.stdout ? `stdout：${result.stdout.slice(-1200)}` : '',
            result.stderr ? `stderr：${result.stderr.slice(-800)}` : '',
            result.text ? `输出：${String(result.text).slice(-1200)}` : '',
            `审计：${path.relative(workspace, auditFile).replace(/\\/g, '/')}`,
          ].filter(Boolean).join('\n'),
        }
      }
      return { ok: false, error: `未知 action：${action}` }
    },
  }))

  registerNdayTool(defineTool({
    name: 'zday_pattern',
    description: 'Match a surface to zero-day patterns with a falsifiable, minimal-impact check.',
    parameters: {
      surface: { type: 'string', required: true, description: 'Product feature or attack surface' },
      tech: { type: 'string', description: 'Optional language/framework' },
      limit: { type: 'integer', description: 'Patterns to return (default 5, max 12)' },
      requestId: { type: 'string', description: 'Baseline ID' },
      requestRevision: { type: 'string', description: 'Revision' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `zday_pattern 失败：${v.error}` }],
    },
    execute(args, exec) {
      const surface = String(args.surface || '').trim()
      if (!surface) return { ok: false, error: 'surface 不能为空' }
      const sessionId = exec?.agent?.session?.id;
      const shared = readSavedVerification?.(resolveDshHome(), sessionId);
      const inputs = observedResearchInputs(shared?.context, args.requestId, args.requestRevision);
      if (!inputs.length) return { ok: true, blocked: true, reason: 'backend_api_missing', patterns: [],
        text: 'backend_api_missing：当前会话没有范围内可达后台/API的有效业务请求和可控输入证据。先在独立定位预算内捕获正常请求，写入redteam_context；无入口就结束定位，不在静态门户深入研究。' };
      if (inputs.length !== 1) return { ok: true, blocked: true, reason: 'research_input_ambiguous', patterns: [],
        text: 'research_input_ambiguous：存在多个研究入口或请求版本，请用requestId和requestRevision选择当前功能的唯一正常基线。',
        inputs: inputs.map(request => ({ id: request.id, endpoint: request.endpoint, revision: request.revision })) };
      let catalog
      try {
        catalog = loadZdayCatalog(path.join(resolveSakerRoot(), 'preset', 'pentest', 'refs', 'zeroday-patterns', 'catalog.json'))
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
      const query = [surface, args.tech].filter(Boolean).join(' ')
      const result = matchZdayPatterns(catalog, query, { limit: args.limit })
      const patterns = result.matches.map((item) => ({
        ...item.pattern,
        score: item.score,
        sources: (item.pattern.sourceIds || []).map((id) => catalog.sources[id]).filter(Boolean),
      }))
      return {
        ok: true,
        exact: result.exact,
        inputs: inputs.map(request => ({ id: request.id, endpoint: request.endpoint, authContext: request.authContext, revision: request.revision, inputs: request.inputs })),
        patterns,
        text: ['已确认研究输入：', ...inputs.map(request => `${request.id} | ${request.endpoint} | 身份 ${request.authContext} | 请求 ${request.revision}`), renderZdayHypotheses(query, result)].join('\n'),
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_match',
    description: 'Screen assets with catalog probes and write a ledger; leads need verification.',
    parameters: {
      targets: { type: 'string', description: 'URLs/hosts; omit for inventory or nday-search' },
      scope: { type: 'string', required: true, description: 'Exact domains/IPs/CIDRs; targets stay inside scope.' },
      workspace: { type: 'string', required: true, description: 'Workspace for ledger and evidence' },
      assetSource: { type: 'string', enum: ['targets', 'inventory', 'nday-search'], description: 'Read targets, inventory, or nday_scope_hunt candidates' },
      searchId: { type: 'string', description: 'Required for nday-search source' },
      entryIds: { type: 'string', description: 'Optional catalog IDs to narrow screening' },
      resultLimit: { type: 'integer', description: 'Displayed leads (default 12, max 50); full ledger retained' },
      timeoutMs: { type: 'integer', description: `Timeout (default ${DEFAULT_TIMEOUT_MS})` },
      concurrency: { type: 'integer', description: `Concurrent requests (default ${DEFAULT_CONCURRENCY})` },
      rate: { type: 'integer', description: `Requests/sec (default ${DEFAULT_RATE}, max ${HARD_MAX_RATE})` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `nday_match 拒绝/失败：${v.error}` }],
    },
    async execute(args, exec) {
      const startedAt = new Date().toISOString()
      const workspace = resolveWorkspaceArg(args.workspace, exec)
      const scope = String(args.scope || '').trim()
      if (!scope) return { ok: false, error: 'scope 不能为空——Nday 主动探针必须限定本轮精确范围' }
      const assetSource = ['inventory', 'nday-search'].includes(args.assetSource) ? args.assetSource : 'targets'
      let assets
      let entryIdsByAsset = null
      let ndayEvidenceByAsset = null
      let excludedAssets = 0
      if (assetSource === 'inventory') {
        const inventory = readInventory(workspace)
        const rows = inventory.assets
          .map((asset) => scopeBoundAsset(asset, scope))
          .filter(Boolean)
          .map((asset) => ({
            // 端口/协议补全只作用于**探测**（见 probeBaseForAsset 的注释）。
            ...asset,
            target: probeBaseForAsset(asset),
            host: String(asset.host || '').trim(),
          }))
          .filter((row) => row.target)
        excludedAssets = inventory.assets.length - rows.length
        assets = []
        // 把账本里的 **vhost** 带下来：`target` 是 IP、`host` 是域名时，探针必须显式发
        // `Host: <域名>`，否则打到默认站点（护网里 FOFA/Hunter 给的正是「IP + 域名」组合）。
        // 只有 host 与目标主机名不同才设，避免对已经是域名的目标做无谓改动。
        const seenServices = new Set()
        for (const row of rows) {
          const parsed = parseTargets(row.target)[0]
          if (!parsed) continue
          let targetHost = ''
          try { targetHost = new URL(parsed.base).hostname.toLowerCase() } catch { targetHost = '' }
          const bare = row.host.replace(/:\d+$/, '').toLowerCase()
          const hostHeader = bare && bare !== targetHost ? bare : ''
          const key = JSON.stringify([parsed.base, hostHeader])
          if (seenServices.has(key)) continue
          seenServices.add(key)
          assets.push({ ...row, ...parsed, hostHeader })
        }
        if (assets.length === 0) {
          return {
            ok: false,
            error: `assetSource=inventory 在本轮精确范围内没有可探测资产（排除 ${excludedAssets} 条范围外/不完整记录）；先用 asset_search / asset_ingest 建账本`,
          }
        }
      } else if (assetSource === 'nday-search') {
        const searchId = String(args.searchId || '').trim()
        if (!/^nday-[a-zA-Z0-9-]{8,80}$/.test(searchId)) {
          return { ok: false, error: 'assetSource=nday-search 必须传入 nday_scope_hunt 返回的有效 searchId' }
        }
        const searchFile = safeWorkspaceFile(workspace, path.join('artifacts', 'nday', `nday-scope-hunt-${searchId}.json`))
        if (!searchFile) return { ok: false, error: 'searchId 路径无效' }
        let search
        try { search = JSON.parse(fs.readFileSync(searchFile, 'utf8')) } catch {
          return { ok: false, error: `找不到或无法读取 Nday FOFA 搜索证据：${path.relative(workspace, searchFile).replace(/\\/g, '/')}` }
        }
        if (search?.schema !== 'saker.nday-scope-hunt/1' || search.searchId !== searchId || !Array.isArray(search.candidates)) {
          return { ok: false, error: 'Nday FOFA 搜索证据格式无效或 searchId 不匹配' }
        }
        const requestedIds = new Set(String(args.entryIds || '').split(',').map((value) => value.trim()).filter(Boolean))
        const byProbe = new Map()
        const basisByQueryId = new Map((search.queries ?? []).map((query) => [String(query.id), String(query.basis || 'unknown')]))
        let rejectedCandidates = 0
        for (const candidate of search.candidates) {
          const safe = scopeBoundAsset(candidate?.asset, scope)
          const entryIds = [...new Set((Array.isArray(candidate?.entryIds) ? candidate.entryIds : [])
            .map((value) => String(value).trim()).filter((value) => value && (!requestedIds.size || requestedIds.has(value))))]
          if (!safe || entryIds.length === 0) { rejectedCandidates += 1; continue }
          const target = probeBaseForAsset(safe)
          const parsed = parseTargets(target)[0]
          if (!parsed) { rejectedCandidates += 1; continue }
          let hostHeader = ''
          try {
            const targetHost = new URL(parsed.base).hostname.toLowerCase()
            const authorizedHost = String(safe.host || '').replace(/^\[|\]$/g, '').toLowerCase()
            if (authorizedHost && authorizedHost !== targetHost) hostHeader = authorizedHost
          } catch { rejectedCandidates += 1; continue }
          const key = `${parsed.base.toLowerCase()}|${hostHeader}`
          const prior = byProbe.get(key)
          const queryIds = [...new Set((Array.isArray(candidate?.queryIds) ? candidate.queryIds : []).map((value) => String(value)))]
          const basis = [...new Set(queryIds.map((id) => basisByQueryId.get(id)).filter(Boolean))]
          if (prior) {
            prior.entryIds = [...new Set([...prior.entryIds, ...entryIds])]
            prior.queryIds = [...new Set([...prior.queryIds, ...queryIds])]
            prior.measurementBasis = [...new Set([...prior.measurementBasis, ...basis])]
          } else {
            byProbe.set(key, { ...parsed, hostHeader, entryIds, queryIds, measurementBasis: basis, sourceAsset: safe })
          }
        }
        const mapped = [...byProbe.values()]
        assets = mapped.map(({ input, base, hostHeader, entryIds, queryIds, measurementBasis }) => ({
          input, base, hostHeader, ndayEntryIds: entryIds,
          ndaySearchEvidence: { searchId, queryIds, measurementBasis },
        }))
        entryIdsByAsset = assets.map((asset) => asset.ndayEntryIds)
        ndayEvidenceByAsset = assets.map((asset) => asset.ndaySearchEvidence)
        excludedAssets = rejectedCandidates
        if (assets.length === 0) {
          return {
            ok: false,
            error: requestedIds.size
              ? `搜索 ${searchId} 中没有同时处于当前精确范围且匹配所选 entryIds 的候选资产（排除 ${rejectedCandidates} 项）`
              : `搜索 ${searchId} 中没有当前精确范围内的候选资产（排除 ${rejectedCandidates} 项）`,
          }
        }
      } else {
        const requested = parseTargets(args.targets)
        const scoped = requested.map((asset) => {
          const safe = scopeBoundAsset({ target: asset.base }, scope)
          if (!safe) return null
          const parsedSafe = parseTargets(safe.target)[0]
          return parsedSafe ? { ...asset, ...parsedSafe } : null
        }).filter(Boolean)
        excludedAssets = requested.length - scoped.length
        assets = scoped
        if (assets.length === 0) {
          return { ok: false, error: `没有精确范围内的可探测目标（排除 ${excludedAssets} 个范围外目标）；检查 scope 和目标` }
        }
      }
      const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? Math.floor(args.timeoutMs) : DEFAULT_TIMEOUT_MS
      // 探针直连（见 detectProxyEnv 的注释）：检测到的代理变量要如实报出来，别让操作者
      // 把「代理没生效」误读成「目标不可达」。
      const proxyEnv = detectProxyEnv()
      const concurrency = Number.isFinite(args.concurrency) && args.concurrency > 0
        ? Math.floor(args.concurrency) : DEFAULT_CONCURRENCY
      const entryIds = String(args.entryIds || '').split(',').map((s) => s.trim()).filter(Boolean)
      const rate = Number.isFinite(args.rate) && args.rate > 0
        ? Math.min(Math.floor(args.rate), HARD_MAX_RATE) : DEFAULT_RATE
      const rateGate = makeRateGate(rate)
      const discoveryRecords = []
      const reconGaps = []
      const automaticSelection = assetSource !== 'nday-search' && entryIds.length === 0

      let catalog
      try {
        ({ catalog } = catalogOrThrow())
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
      if (automaticSelection) {
        // At most one initial observation per service; never silently spray the
        // catalog when the product is unknown. Existing recon avoids that GET.
        const available = candidateEntries(catalog, [])
        const initial = assets.map(asset => selectReconCandidates(available, asset))
        const missing = assets.map((asset, assetIndex) => ({ asset, assetIndex }))
          .filter(({ assetIndex }) => initial[assetIndex].length === 0)
        const cap = Math.min(32, HARD_MAX_REQUESTS, DEFAULT_MAX_REQUESTS)
        if (missing.length > cap) return { ok: false, error: `产品基线 ${missing.length} 次超过请求上限 ${cap}；按资产分批，禁止回退全库。` }
        const observed = await mapLimit(missing, concurrency, async ({ asset, assetIndex }) => {
          await rateGate()
          const response = await fetchProbe({ url: asset.base, method: 'GET', timeoutMs, hostHeader: asset.hostHeader })
          const observation = reconObservation(asset, response)
          const selected = observation.blocked ? [] : selectReconCandidates(available, observation)
          return { assetIndex, asset: asset.base, hostHeader: asset.hostHeader || '', response,
            selected, surfaces: observation.surfaces, inputObserved: observation.inputObserved,
            blocked: observation.blocked, nextAction: observation.nextAction }
        })
        discoveryRecords.push(...observed)
        for (const row of observed) initial[row.assetIndex] = row.selected
        entryIdsByAsset = initial.map(rows => rows.map(row => row.entryId))
        for (const [assetIndex, selected] of initial.entries()) {
          const observed = discoveryRecords.find(row => row.assetIndex === assetIndex)
          reconGaps.push({ asset: assets[assetIndex].base, hostHeader: assets[assetIndex].hostHeader || '',
            productState: selected.length ? 'candidate' : 'unknown', componentState: 'unassessed',
            entryIds: selected.map(row => row.entryId),
            matchedTerms: selected,
            observedFacts: { title: assets[assetIndex].title || '', server: assets[assetIndex].server || '', tech: assets[assetIndex].tech || [] },
            sourceReferences: assets[assetIndex].rawFiles || [],
            nextAction: selected.length ? 'check-product-version-and-prerequisites' : observed?.nextAction || 'record-product-and-component-gap',
            surfaces: observed?.surfaces || [], inputObserved: observed?.inputObserved || false,
            blocked: observed?.blocked || '' })
        }
      }
      const knownEntryIds = new Set(catalog.entries.map((entry) => entry.id))
      if (entryIdsByAsset) entryIdsByAsset = entryIdsByAsset.map((ids) => ids.filter((id) => knownEntryIds.has(id)))
      const mappedEntryIds = entryIdsByAsset ? [...new Set(entryIdsByAsset.flat())] : []
      if (assetSource === 'nday-search' && mappedEntryIds.length === 0) {
        return { ok: false, error: '搜索证据没有映射到当前版本目录中的有效 entryId；拒绝退化为全目录探测' }
      }
      const entries = entryIdsByAsset && mappedEntryIds.length === 0 ? []
        : candidateEntries(catalog, entryIdsByAsset ? mappedEntryIds : entryIds)
      if (entries.length === 0 && !automaticSelection) return { ok: false, error: 'entryIds 没有匹配到任何条目' }

      // 计划先算清楚再动手：规模超限就明确拒绝，不做静默截断。
      // 没有探针的条目（legacy-unreviewed：只有来源、还没落实指纹）**不参与筛选**，
      // 但必须显式报出来——静默跳过会让调用方以为"都筛过了"。
      const siftable = entries.filter((entry) => probePlan(entry, 'http://x').length > 0)
      const notSiftable = entries.filter((entry) => probePlan(entry, 'http://x').length === 0)
      if (siftable.length === 0 && entries.length > 0 && !automaticSelection) {
        return {
          ok: false,
          error: `候选 ${entries.length} 条都没有机器可判定探针，无法批量筛选：`
            + `${notSiftable.map((e) => `${e.id}(${e.status})`).join(', ')}。`
            + '这些条目只能作为人工线索阅读（nday_catalog entryId=...）。',
        }
      }

      const requests = []
      for (const [assetIndex, asset] of assets.entries()) {
        for (const [entryIndex, entry] of siftable.entries()) {
          if (entryIdsByAsset && !entryIdsByAsset[assetIndex]?.includes(entry.id)) continue
          for (const plan of probePlan(entry, asset.base, { timeoutMs })) {
            requests.push({ assetIndex, entryIndex, plan, hostHeader: asset.hostHeader })
          }
        }
      }
      const requestGroups = groupProbeRequests(requests)
      const controlAssets = assets.map((asset, assetIndex) => ({ asset, assetIndex }))
        .filter(({ assetIndex }) => requests.some(request => request.assetIndex === assetIndex))
      const plannedRequests = requestGroups.length + controlAssets.length + discoveryRecords.length
      const cap = Math.min(HARD_MAX_REQUESTS, DEFAULT_MAX_REQUESTS)
      if (plannedRequests > cap) {
        return {
          ok: false,
          error: `本次计划 ${assets.length} 个资产 × ${siftable.length} 个可筛条目：${requestGroups.length} 次去重探针 + ${controlAssets.length} 次对照 + ${discoveryRecords.length} 次已执行基线 = ${plannedRequests} 次请求，超过单次上限 ${cap}；未发送条目探针。`
            + '请用 entryIds 收窄条目，或把目标分批跑。',
        }
      }

      // 对照：每个资产先发一次**随机不存在路径**的请求。
      // 软 404 / SPA / WAF 统一响应下，「路径存在性」这类判据对任何路径都成立——
      // 语料里 53/63 条探针只看状态码，没有对照的话一台软 404 目标能让整库假命中
      // （实测：软 404 靶子上 3/3 条目全部"命中"）。对照本身不参与命中统计。
      const controlPath = `/.saker-control-${randomBytes(6).toString('hex')}`
      const controls = new Map()
      await mapLimit(controlAssets, concurrency, async (item) => {
        await rateGate()
        const response = await fetchProbe({
          url: probeUrl(item.asset.base, controlPath),
          method: 'GET',
          timeoutMs,
          // 对照必须与探针用**同一个 Host**，否则一个打 vhost、一个打默认站点，比较毫无意义。
          hostHeader: item.asset.hostHeader,
        })
        // 对照本身失败（拒连/超时）时不启用对照判定：宁可按原判据跑，也不误杀真命中。
        if (response.ok) controls.set(item.assetIndex, response)
        return null
      })

      const results = await executeProbeBatch(requestGroups, { mapLimit, concurrency, rateGate, fetchProbe })

      const outcomes = new Map() // `${ai}:${ei}` -> outcomes[]
      const transportErrors = []
      let controlSuppressed = 0
      let controlUniform = 0
      for (const item of results) {
        const key = `${item.assetIndex}:${item.entryIndex}`
        if (!outcomes.has(key)) outcomes.set(key, [])
        if (!item.response.ok) {
          transportErrors.push({ asset: assets[item.assetIndex].base, url: item.plan.url, error: item.response.error })
          outcomes.get(key).push({ probe: item.plan.probe, result: { hit: false, reason: `探测失败：${item.response.error}`, weight: item.plan.probe.weight } })
          continue
        }
        const control = controls.get(item.assetIndex)
        const evaluated = evaluateProbe(item.plan.probe, item.response, control ? { control } : undefined)
        if (evaluated.suppressedByControl) controlSuppressed += 1
        if (evaluated.uniformContent) controlUniform += 1
        outcomes.get(key).push({ probe: item.plan.probe, result: evaluated })
      }

      const rows = []
      for (const [assetIndex, asset] of assets.entries()) {
        for (const [entryIndex, entry] of siftable.entries()) {
          if (entryIdsByAsset && !entryIdsByAsset[assetIndex]?.includes(entry.id)) continue
          const screened = screenOutcome(outcomes.get(`${assetIndex}:${entryIndex}`) ?? [])
          if (screened.verdict === VERDICT.NO_SIGNAL) continue
          rows.push({
            asset: asset.base,
            entryId: entry.id,
            product: entry.product,
            entryStatus: entry.status,
            reproducedByUs: entry.verification?.reproduced === true,
            autoImported: Boolean(entry.importedFrom),
            ...(ndayEvidenceByAsset ? { searchEvidence: { ...ndayEvidenceByAsset[assetIndex], basisLabel: measurementBasisLabel(ndayEvidenceByAsset[assetIndex]?.measurementBasis) } } : {}),
            verdict: screened.verdict,
            strongest: screened.strongest,
            evidence: screened.hits,
            nextStep: (entry.exploit?.tools ?? []).length > 0
              ? `用公开工具确认：${(entry.exploit.tools).join(' / ')}`
              : '看条目 exploit.notes 决定验证路径',
            // 命中之后第一件该做的事不是「挖这个资产」，而是「拿同指纹语法扩到同类资产全集」——
            // 所以每条命中都直接带上扩面查询，模型不用再去翻语料。
            expand: (() => {
              const queries = expansionQueries(entry)
              return queries.length === 0
                ? { queries: [], note: '条目没记测绘语法，反查不了同类资产；按产品名人工确认' }
                : {
                    queries,
                    nextCall: `nday_scope_hunt entryIds="${entry.id}" scope="<精确范围>" workspace="${workspace}"`,
                  }
            })(),
            })
        }
      }

      // 短名单必须**按证据强度排**：强命中埋在一堆弱命中下面，等于没有短名单——
      // 操作者要从上百行里翻，而真正该先看的那几行在最后。同级内按资产/条目排序，
      // 保证「同输入同输出」（可复现、可对账）。
      rows.sort((a, b) => (WEIGHT_ORDER[b.strongest] ?? 0) - (WEIGHT_ORDER[a.strongest] ?? 0)
        || a.asset.localeCompare(b.asset) || a.entryId.localeCompare(b.entryId))

      // 命中即**预分配**带外标签：把「筛完还要手动分配一次」这一步去掉，
      // 模型拿到命中就能直接注入 + 回查。只在条目声明了 dnslog 且通道确实配好时才发；
      // 没配就如实标注「需要带外但通道未配置」，不假装能确认。
      const oob = oobConfig(ctx)
      const oobReady = Boolean(oob.base && oob.token && oob.root)
      // 批量归因：**一次筛出的所有带外命中共用同一个 label**，每个资产拿一个带序号后缀的子域。
      // 早先每行各发一个独立 label，N 个命中就得 check N 次、还得手工记账，
      // 与验收里那句「一次会话批量 OOB 验证并输出命中清单」不符。
      const oobHits = []
      for (const row of rows) {
        const entry = siftable.find((candidate) => candidate.id === row.entryId)
        const wantsOob = (entry?.verify?.oob ?? []).includes('dnslog')
        if (!wantsOob) {
          row.confirm = { needed: false, note: '该条目的验证方式不含 DNS 带外' }
          continue
        }
        if (!oobReady) {
          row.confirm = {
            needed: true,
            ready: false,
            note: '条目要求 DNS 带外确认，但 DNSLog 未配置（设置 → 安全配置 → DNSLog 平台：平台地址 + token + 接收域名）',
          }
          continue
        }
        oobHits.push(row)
      }
      if (oobHits.length > 0) {
        const label = `saker-${randomBytes(4).toString('hex')}`
        const table = oobHits.map((row, index) => ({
          asset: row.asset,
          domain: `${label}-${index + 1}.${oob.root}`,
        }))
        writeOobBatchTable(workspace, label, oob.root, table)
        oobHits.forEach((row, index) => {
          row.confirm = {
            needed: true,
            ready: true,
            method: 'dnslog',
            label,
            domain: table[index].domain,
            nextCall: `oob_probe action=check label=${label} workspace=${workspace}`,
            sharedWith: oobHits.length,
          }
        })
      }

      const dir = ensureDirs(workspace)
      const ts = stamp()
      const jsonFile = path.join(dir, `nday-match-${ts}.json`)
      const csvFile = path.join(dir, `nday-match-${ts}.csv`)
      const summary = {
        assets: assets.length,
        assetsExcludedByScope: excludedAssets,
        entries: siftable.length,
        entriesNotSiftable: notSiftable.length,
        requests: requestGroups.length,
        probeEvaluations: requests.length,
        requestsReused: requests.length - requestGroups.length,
        totalRequests: plannedRequests,
        controlRequests: controlAssets.length,
        discoveryRequests: discoveryRecords.length,
        assetsWithoutProductCandidates: reconGaps.filter(row => row.productState === 'unknown').length,
        controlSuppressed,
        controlUniform,
        transportErrors: transportErrors.length,
        screenedHits: rows.length,
        proxyEnv,
      }
      fs.writeFileSync(jsonFile, JSON.stringify({
        generatedAt: new Date().toISOString(),
        parameters: {
          assetSource,
          ...(assetSource === 'nday-search' ? { searchId: String(args.searchId || '') } : {}),
          targets: assets.map((a) => a.base),
          entryIds: siftable.map((e) => e.id),
          skippedEntryIds: notSiftable.map((e) => e.id),
          concurrency,
          rate,
          rateNote: rate > DEFAULT_RATE ? `显式放开：默认 ${DEFAULT_RATE} → ${rate} req/s（留痕）` : `保守默认 ${DEFAULT_RATE} req/s`,
          timeoutMs,
        },
        summary,
        rows,
        transportErrors,
        discoveryRecords,
        reconGaps,
      }, null, 2) + '\n', 'utf8')
      const csvEscape = (v) => `"${String(v).replace(/"/g, '""')}"`
      fs.writeFileSync(csvFile, [
        'asset,entryId,product,entryStatus,verdict,strongest,evidence,nextStep',
        ...rows.map((r) => [r.asset, r.entryId, r.product, r.entryStatus, r.verdict, r.strongest,
          r.evidence.map((e) => `${e.probeId}:${e.weight}:${e.reason}`).join(' | '), r.nextStep].map(csvEscape).join(',')),
      ].join('\n') + '\n', 'utf8')
      appendEvidence(workspace, `nday-${ts}`, `nday_match ${assets.length} targets(${assetSource}) × ${entries.length} entries`, path.relative(workspace, jsonFile))

      // 一条都没命中时，输出必须回答「为什么」：miss 原因原先只活在内存里，
      // 模型看到「命中 0 项」却分不清是路径不存在、被重定向到别处、还是响应体不含特征串。
      const missReasons = new Map()
      if (rows.length === 0) {
        for (const list of outcomes.values()) {
          for (const item of list) {
            if (item.result.hit) continue
            const reason = String(item.result.reason || '未知原因')
            if (reason.startsWith('探测失败：')) continue // 传输失败另有汇总行，不重复
            missReasons.set(reason, (missReasons.get(reason) || 0) + 1)
          }
        }
      }
      const missSummary = [...missReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason, count]) => {
          const short = reason.length > 140 ? `${reason.slice(0, 140)}…` : reason
          return count > 1 ? `${short}×${count}` : short
        })
        .join('；')

      const notes = [
        '【口径】以下是**指纹筛选命中**，不是漏洞结论；确认要走条目里的公开工具。',
        ...(automaticSelection ? [`【画像】复用产品线索；无产品候选 ${reconGaps.filter(row => row.productState === 'unknown').length} 项，不回退全库；组件与版本仍需逐入口补证。`,
          ...reconGaps.filter(row => row.productState === 'unknown').slice(0, 6).map(row => `【缺口】${row.asset}${row.hostHeader ? ' Host='+row.hostHeader : ''}：${row.blocked || '产品未知'}；下一步 ${row.nextAction}；已观察入口 ${row.surfaces.slice(0, 3).join(', ') || '无'}`)] : []),
        ...(excludedAssets ? [`【范围】本轮精确范围外的 ${excludedAssets} 项未发送请求。`] : []),
        ...(rows.some((r) => !r.reproducedByUs)
          ? ['【状态】命中项里含 `normalized` 条目——我方尚未复现，措辞不得写成"已确认可利用"。']
          : []),
        ...(transportErrors.length ? [`【传输】${transportErrors.length} 次探测失败（${summarizeTransportErrors(transportErrors)}），这些资产未计入命中，不等于不存在。`] : []),
        ...(proxyEnv.length ? [`【传输】检测到代理环境变量 ${proxyEnv.join('/')}，但探针走**直连**（node:http/https 不读这些变量）。若目标只能经代理/隧道可达，探针会失败——按需设 NO_PROXY 或取消代理。`] : []),
        ...(missSummary ? [`【未命中原因】${missSummary}`] : []),
        ...(controlSuppressed ? [`【对照】${controlSuppressed} 条判据被随机对照路径「同样满足」，已判为不具区分度（软 404 / 统一响应）——这台目标的路径存在性不能当证据。`] : []),
        ...(controlUniform ? [`【统一响应】${controlUniform} 条**内容判据**在随机对照路径上也命中（SPA / try_files 兜底），已保留命中但只作产品特征、不能当路径存在的证据。`] : []),
        `【速率】${rate} req/s（${rate > DEFAULT_RATE ? '显式放开，已留痕' : '保守默认'}）；并发 ${concurrency}。对着带 WAF 的目标不要放开速率。`,
        ...(notSiftable.length ? [`【跳过】${notSiftable.length} 个条目没有机器可判定探针，未参与筛选（仅可人工阅读）：${notSiftable.map((e) => e.id).join(', ')}`] : []),
        `【台账】${path.relative(workspace, jsonFile)}`,
      ]
      const resultLimit = Math.max(1, Math.min(50, Math.floor(Number(args.resultLimit) || 12)))
      const text = [
        `nday_match：精确范围内 ${assets.length} 资产（来源 ${assetSource}）× ${siftable.length} 条目：${requests.length} 次判据评估，实际 ${requestGroups.length} 次探测 + ${controlAssets.length} 次随机对照 + ${discoveryRecords.length} 次基线识别，复用 ${requests.length - requestGroups.length} 次请求；范围外跳过 ${excludedAssets} 项；命中 ${rows.length} 项`,
        ...notes,
        ...(rows.length > resultLimit ? [`【显示】仅列前 ${resultLimit} 项；其余 ${rows.length - resultLimit} 项见完整台账 ${path.relative(workspace, jsonFile)}，未删除证据。`] : []),
        ...(rows.length
          ? ['', ...rows.slice(0, resultLimit).map((r) => {
            const confirm = r.confirm?.ready
              ? `\n    确认：把 ${r.confirm.domain} 注入后调 ${r.confirm.nextCall}`
              : r.confirm?.needed
                ? `\n    确认：需带外，但通道未配置（${r.confirm.note}）`
                : ''
            // ⚠ 这行文本才是模型实际看到的东西：nday_match 的 render 只输出 `v.text`，
            // 结构化字段（rows[].expand 之类）模型**看不到**。所以扩面入口必须写进文本里，
            // 否则「命中→扩面」这条链在模型侧仍然是断的。
            const expandLine = (r.expand?.queries?.length ?? 0) > 0
              ? `\n    扩面：用 FOFA 在精确范围内查同指纹候选 → ${r.expand.nextCall}`
              : `\n    扩面：${r.expand?.note ?? '条目没记测绘语法，反查不了同类资产'}`
            // `nextStep`（用公开工具确认）同样只写在返回对象里的话，模型是看不到的——
            // 而 README 的表格明说「命中行直接给出条目 exploit.tools 里点名的公开工具」。
            const nextStepLine = r.nextStep ? `\n    交接：${r.nextStep}` : ''
            const searchEvidence = r.searchEvidence
              ? `（FOFA ${r.searchEvidence.basisLabel}：${r.searchEvidence.queryIds.join(', ')}）`
              : ''
            return `- ${r.asset} → ${r.entryId}${r.autoImported ? '（自动导入·未复核）' : ''}${searchEvidence} [${r.verdict}] ${r.evidence.map((e) => `${e.probeId}(${e.weight}): ${e.reason}`).join('；')}${confirm}${expandLine}${nextStepLine}`
          })]
          : ['', '（无命中）']),
      ].join('\n')

      try {
        recordMatchMetric({
          runId: assetSource === 'nday-search' ? String(args.searchId || '') : `match-${stamp()}`,
          assetCount: assets.length,
          hitCount: rows.length,
          startedAt,
          finishedAt: new Date().toISOString(),
        })
      } catch { /* metrics must not break a completed screen */ }

      return {
        ok: true,
        summary,
        rows,
        reconGaps,
        // 生效参数回给调用方：速率是**纪律**的一部分，不能只写在台账里。
        parameters: {
          assetSource,
          ...(assetSource === 'nday-search' ? { searchId: String(args.searchId || '') } : {}),
          rate,
          concurrency,
          timeoutMs,
          rateNote: rate > DEFAULT_RATE ? `显式放开：默认 ${DEFAULT_RATE} → ${rate} req/s（留痕）` : `保守默认 ${DEFAULT_RATE} req/s`,
        },
        ledger: path.relative(workspace, jsonFile),
        text,
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_coverage',
    description: 'Check Nday, knowledge-pack, and local nuclei-template coverage for a product.',
    parameters: {
      keyword: { type: 'string', description: 'Product, vendor, or keyword' },
      workspace: { type: 'string', description: 'Optional workspace; derive gaps from its inventory' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `nday_coverage 失败：${v.error}` }],
    },
    async execute(args, exec) {
      const keyword = String(args.keyword || '').trim()
      const workspaceArg = String(args.workspace || '').trim()
      if (!keyword && !workspaceArg) return { ok: false, error: '给 keyword 或 workspace 之一' }
      let catalog
      try {
        ({ catalog } = catalogOrThrow())
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
      const home = resolveDshHome()
      const importsDir = home ? path.join(home, 'refs', 'imports') : ''
      const nucleiDir = resolveNucleiTemplatesDir()

      // 账本模式（S2 的「覆盖缺口」产物）：从 asset-inventory.json 派生产品关键词，
      // 逐产品跑三层体检，按「盲得最狠」排序——回答"我这批目标里哪些是我全瞎的"。
      if (!keyword && workspaceArg) {
        const workspace = resolveWorkspaceArg(workspaceArg, exec)
        const inventoryFile = path.join(workspace, 'asset-inventory.json')
        let assets = []
        try {
          const raw = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'))
          assets = Array.isArray(raw?.assets) ? raw.assets : []
        } catch {
          return { ok: false, error: `读不到资产账本：${inventoryFile}（先跑 asset_search / asset_ingest）` }
        }
        const keywords = deriveProductKeywords(assets)
        const rows = keywords.map((item) => ({
          ...item,
          scan: coverageScan({ keyword: item.keyword, catalogEntries: catalog.entries, importsDir, nucleiDir }),
        }))
        return {
          ok: true,
          mode: 'inventory',
          assets: assets.length,
          keywords: rows,
          text: renderCoverageGap(rows, {
            totalAssets: assets.length,
            inventoryFile: path.relative(workspace, inventoryFile).replace(/\\/g, '/'),
          }),
        }
      }
      const scan = coverageScan({
        keyword,
        catalogEntries: catalog.entries,
        importsDir,
        nucleiDir,
      })
      const empty = scan.l1.total === 0 && scan.l2.total === 0 && scan.l3.total === 0
      const packLine = Object.entries(scan.l2.packs).map(([k, n]) => `${k}=${n}`).join(' ') || '（无）'
      const text = [
        `覆盖体检：${keyword}`,
        '',
        `① 精选语料：${scan.l1.total} 条，其中**可筛 ${scan.l1.siftable} 条**`,
        scan.l1.total ? `   ${scan.l1.ids.join(' / ')}` : '   （空）',
        `② 本地知识包（按文件名匹配）：${scan.l2.total} 篇  ${packLine}`,
        `③ 本地 nuclei 模板：${scan.l3.total} 个${scan.l3.sample.length ? `  ${scan.l3.sample.join(' / ')}` : ''}`,
        '',
        empty
          ? '**三层全空**：本地没有这个产品的任何库存 → 直接走实时检索（`产品+版本+漏洞类型+(POC|EXP|github)`），找到后用 `nday_learn` 落库。'
          : scan.l1.siftable > 0
            ? '有可筛条目 → 先 `nday_match` 批量筛，再 `nday_handoff` 出计划。'
            : '本地只有**文档级**库存、没有可筛条目 → 用 `knowledge_search` 读文档拿路径与判据，人工/模型整理成 `nday_learn` 条目后即可批量筛。',
        '',
        '口径提醒：没有任何单一来源覆盖全部（实测东方通/宝兰德在 nuclei 与知识包里都是 0）——'
          + '这个工具就是让你**先知道缺口在哪一层**，再决定花时间的方向。',
      ].join('\n')
      return { ok: true, ...scan, empty, text }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_triage',
    description: 'Rank local POC documents by identifiers, paths, signatures, and coverage.',
    parameters: {
      root: { type: 'string', required: true, description: 'Directory to scan' },
      workspace: { type: 'string', description: 'Base path for a relative root' },
      limit: { type: 'number', description: 'Maximum documents (default 20)' },
      minScore: { type: 'number', description: 'Minimum score (default 30)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `nday_triage 失败：${v.error}` }],
    },
    async execute(args, exec) {
      const rootArg = String(args.root || '').trim()
      if (!rootArg) return { ok: false, error: 'root 不能为空' }
      const workspace = resolveWorkspaceArg(args.workspace, exec)
      const root = path.isAbsolute(rootArg) ? rootArg : path.resolve(workspace, rootArg)
      if (!fs.existsSync(root)) return { ok: false, error: `root 不存在：${root}` }

      // 扫描要**有界**：知识包上万篇，不能因为一次调用把内存打满。
      const MAX_FILES = 20_000
      const MAX_BYTES = 256 * 1024
      const files = []
      const walk = (dir) => {
        if (files.length >= MAX_FILES) return
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          if (files.length >= MAX_FILES) return
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue
            walk(full)
            continue
          }
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
          try {
            const stat = fs.statSync(full)
            if (stat.size === 0 || stat.size > MAX_BYTES) continue
          } catch { continue }
          files.push(full)
        }
      }
      walk(root)

      const docs = []
      for (const file of files) {
        try {
          docs.push({ file: path.relative(root, file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8') })
        } catch { /* 读不了的跳过，不让一篇坏文档拖垮整轮 */ }
      }

      let catalog
      try {
        ({ catalog } = catalogOrThrow())
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 20
      const minScore = Number.isFinite(Number(args.minScore)) ? Number(args.minScore) : 30
      const result = triageDocs(docs, { entries: catalog.entries, limit, minScore })
      return {
        ok: true,
        root,
        ...result,
        text: renderWorklist(result, { root }),
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_learn',
    description: 'Save a new Nday to the user corpus with evidence gates.',
    parameters: {
      entry: { type: 'string', required: true, description: 'Catalog entry object' },
      note: { type: 'string', description: 'Optional source note' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `nday_learn 拒绝：${v.error}` }],
    },
    async execute(args, exec) {
      const home = resolveDshHome()
      let entry
      try {
        entry = typeof args.entry === 'string' ? JSON.parse(args.entry) : args.entry
      } catch (error) {
        return { ok: false, error: `entry 不是合法 JSON：${String(error?.message || error)}` }
      }
      if (!entry || typeof entry !== 'object') return { ok: false, error: 'entry 必须是对象' }

      // 与包内语料同一套诚实性门禁——放不进去比放进去更安全。
      const problems = []
      for (const field of ['id', 'product', 'vendor', 'vulnClass', 'status', 'sources', 'lastReviewed']) {
        if (entry[field] === undefined || entry[field] === null || entry[field] === '') problems.push(`缺字段 ${field}`)
      }
      if (typeof entry.id === 'string' && !/^[a-z0-9-]+$/.test(entry.id)) problems.push('id 只能用小写字母 / 数字 / 短横线')
      if (!['legacy-unreviewed', 'normalized', 'verified', 'deprecated'].includes(entry.status)) problems.push(`status 不合法：${entry.status}`)
      if (!Array.isArray(entry.sources) || entry.sources.length === 0) problems.push('sources 至少一条')
      else if (entry.sources.some((s) => !s || typeof s.url !== 'string' || !s.url.startsWith('http'))) problems.push('每条 source 必须有 http(s) url')
      const probes = entry.fingerprint?.probes
      if ((entry.status === 'normalized' || entry.status === 'verified') && (!Array.isArray(probes) || probes.length === 0)) {
        problems.push(`status=${entry.status} 必须给出机器可判定探针（fingerprint.probes）；给不出来就标 legacy-unreviewed`)
      }
      if (entry.status === 'verified' && entry.verification?.reproduced !== true) {
        problems.push('status=verified 必须有 verification.reproduced=true（我们没复现过的不能标 verified）')
      }
      if (problems.length > 0) {
        return { ok: false, error: `条目未通过诚实性门禁，未落库：\n- ${problems.join('\n- ')}` }
      }

      const catalogFile = userCatalogPath(home)
      const entriesDir = userEntriesDir(home)
      const today = new Date().toISOString().slice(0, 10)
      let catalog = { schema: 'saker.nday.catalog/1', updated: today, statusLegend: {}, entries: [] }
      if (fs.existsSync(catalogFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(catalogFile, 'utf8'))
          if (parsed?.schema === 'saker.nday.catalog/1' && Array.isArray(parsed.entries)) catalog = parsed
        } catch { /* 坏了就重建 */ }
      }
      const stored = { ...entry, __source: 'user', lastReviewed: entry.lastReviewed || today }
      const existing = catalog.entries.findIndex((candidate) => candidate?.id === stored.id)
      const action = existing >= 0 ? 'updated' : 'added'
      if (existing >= 0) catalog.entries[existing] = stored
      else catalog.entries.push(stored)
      catalog.updated = today

      fs.mkdirSync(path.dirname(catalogFile), { recursive: true })
      const tmp = `${catalogFile}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2) + '\n', 'utf8')
      fs.renameSync(tmp, catalogFile)

      fs.mkdirSync(entriesDir, { recursive: true })
      const md = [
        `# ${stored.product}${stored.vulnClass ? ` — ${stored.vulnClass}` : ''}`,
        '',
        `- 条目 ID：\`${stored.id}\`（用户层）`,
        `- 状态：\`${stored.status}\`${stored.verification?.reproduced ? '（我方已复现）' : '（**尚未由我们复现**）'}`,
        `- 编号：${JSON.stringify(stored.ids ?? {})}`,
        `- 认证前置：${stored.auth ?? '未填'}`,
        Array.isArray(stored.affectedVersions) && stored.affectedVersions.length ? `- 影响版本：${stored.affectedVersions.join(' / ')}` : '',
        args.note ? `\n## 来源备注\n\n${String(args.note)}` : '',
        '\n## 来源',
        ...(stored.sources ?? []).map((s) => `- ${s.title ?? s.url}：<${s.url}>${s.kind ? `（${s.kind}）` : ''}`),
        `\n## 录入记录\n\n| 日期 | 动作 | 说明 |\n|---|---|---|\n| ${today} | ${action}（用户层） | 由 nday_learn 写入 |`,
      ].filter(Boolean).join('\n')
      fs.writeFileSync(path.join(entriesDir, `${stored.id}.md`), md + '\n', 'utf8')

      return {
        ok: true,
        action,
        id: stored.id,
        catalogFile,
        entriesDir,
        text: [
          `已${action === 'added' ? '新增' : '更新'}用户层条目：\`${stored.id}\``,
          `- 语料文件：${catalogFile}`,
          `- 条目文档：${path.join(entriesDir, `${stored.id}.md`)}`,
          `- 状态：${stored.status}（${stored.verification?.reproduced ? '我方已复现' : '尚未复现'}）`,
          '',
          '下一次 `nday_catalog` / `nday_match` 就会带上它——**实时找到的东西从此变成本地能力**。',
        ].join('\n'),
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_draft',
    description: 'Draft an Nday from a POC for review; never marks it verified.',
    parameters: {
      workspace: { type: 'string', description: 'Workspace for the draft' },
      documentPath: { type: 'string', description: 'Workspace-relative POC path' },
      text: { type: 'string', description: 'POC text instead of documentPath' },
      entryId: { type: 'string', description: 'Suggested catalog ID' },
      product: { type: 'string', description: 'Product name' },
      vendor: { type: 'string', description: 'Vendor name' },
      vulnClass: { type: 'string', description: 'Vulnerability class' },
      sourceUrl: { type: 'string', description: 'Source URL if absent from document' },
      published: { type: 'string', description: 'Source publication time when known' },
      maxPaths: { type: 'integer', description: 'Path candidates (default 3)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `nday_draft 失败：${v.error}` }],
    },
    async execute(args, exec) {
      const hasPath = typeof args.documentPath === 'string' && args.documentPath.trim() !== ''
      const hasText = typeof args.text === 'string' && args.text.trim() !== ''
      if (hasPath === hasText) return { ok: false, error: 'documentPath 与 text 必须且只能提供一个' }

      let sourceText = ''
      let origin = 'text'
      if (hasPath) {
        const workspace = resolveWorkspaceArg(args.workspace, exec)
        const file = safeWorkspaceFile(workspace, args.documentPath)
        if (!file) return { ok: false, error: 'documentPath 越出 workspace' }
        let stat
        try {
          stat = fs.statSync(file)
        } catch (error) {
          return { ok: false, error: `无法读取文档：${String(error?.message || error)}` }
        }
        if (!stat.isFile()) return { ok: false, error: 'documentPath 不是文件' }
        if (stat.size > 2 * 1024 * 1024) return { ok: false, error: 'POC 文档超过 2MB，先截取与漏洞相关的正文' }
        sourceText = fs.readFileSync(file, 'utf8')
        origin = path.relative(workspace, file).replace(/\\/g, '/')
      } else {
        sourceText = String(args.text)
      }

      const candidates = extractNdayCandidates(sourceText)
      const draft = draftProbes(candidates, { maxPaths: Math.max(1, Math.min(Number(args.maxPaths) || 3, 8)) })
      const needsHuman = [...draft.needsHuman]
      if (!String(args.entryId || '').trim()) needsHuman.push('缺少 entryId——请按“厂商-产品-漏洞类型”命名后再落库')
      const sourceUrl = String(args.sourceUrl || '').trim() || candidates.links[0] || ''
      if (!sourceUrl) needsHuman.push('缺少 http(s) 来源——nday_learn 会拒绝没有来源的条目')
      const sourceKind = /github\.com/i.test(sourceUrl) || /github/i.test(origin)
        ? 'github'
        : /nuclei/i.test(origin)
          ? 'nuclei'
          : /weixin|sogou/i.test(sourceUrl)
            ? 'wechat'
            : 'public'
      const sourceMeta = enrichCandidate({
        source: sourceKind,
        sourceKind,
        title: String(args.product || args.entryId || ''),
        url: sourceUrl,
        ids: candidates.ids,
        published: args.published,
        products: [args.product, args.vendor].filter(Boolean),
      })
      const id = draftId(args.entryId) || (origin !== 'text' ? draftId(path.basename(origin, path.extname(origin))) : '')
      const entry = {
        id,
        product: String(args.product || '').trim(),
        vendor: String(args.vendor || '').trim(),
        vulnClass: String(args.vulnClass || '').trim(),
        status: 'legacy-unreviewed',
        auth: '',
        affectedVersions: candidates.versions.slice(0, 12),
        ids: candidates.ids,
        fingerprint: {
          paths: candidates.paths,
          probes: draft.probes,
        },
        provenance: {
          sourceKind: sourceMeta.sourceKind,
          trust: sourceMeta.trust,
          publishedAt: sourceMeta.publishedAt,
          freshness: sourceMeta.freshness,
          dedupKey: sourceMeta.dedupKey,
        },
        sources: sourceUrl ? [{ url: sourceUrl, kind: 'poc', title: origin }] : [],
        lastReviewed: new Date().toISOString().slice(0, 10),
      }
      const text = [
        `条目草案：\`${id || '<缺少 entryId>'}\``,
        '- 这是抽取结果，**不是漏洞结论**；状态固定为 `legacy-unreviewed`。',
        `- 来源：${sourceMeta.sourceKind} / 可信等级 ${sourceMeta.trust} / 新鲜度 ${sourceMeta.freshness}${sourceMeta.publishedAt ? `（${sourceMeta.publishedAt}）` : '（日期未标注）'} / 去重键 ${sourceMeta.dedupKey}`,
        '- 落库前必须人工确认：路径确实是漏洞入口、判据只在该分支出现、来源 URL 可访问。',
        needsHuman.length ? `- 待人工补全：${needsHuman.join('；')}` : '- 抽取项齐全，仍需确认判据质量。',
        '',
        '```json',
        JSON.stringify(entry, null, 2),
        '```',
        '',
        '确认并补齐 `product` / `vendor` / `vulnClass` / `id` 后，把 JSON 交给 `nday_learn`。',
      ].join('\n')
      return {
        ok: true,
        origin,
        candidates,
        draft: entry,
        needsHuman,
        text,
      }
    },
  }))

  registerNdayTool(defineTool({
    name: 'nday_handoff',
    description: 'Create a scoped Nuclei hand-off plan; does not execute payloads.',
    parameters: {
      entryId: { type: 'string', description: 'Catalog ID; omit for keyword mode' },
      asset: { type: 'string', required: true, description: 'Target URL or host' },
      scope: { type: 'string', required: true, description: 'Exact domains/IPs/CIDRs; target must match.' },
      workspace: { type: 'string', required: true, description: 'Workspace for plan and ledger' },
      keywords: { type: 'string', description: 'Template keywords; required without entryId' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `nday_handoff 失败：${v.error}` }],
    },
    async execute(args, exec) {
      let catalog
      try {
        ({ catalog } = catalogOrThrow())
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
      const entryId = String(args.entryId || '').trim()
      const entry = entryId ? getEntry(catalog, entryId) : undefined
      if (entryId && !entry) return { ok: false, error: `catalog 里没有条目 ${entryId}` }
      const explicitKeywords = String(args.keywords || '').split(',').map((s) => s.trim()).filter(Boolean)
      // 模板直通模式：产品在**模板层有存货、语料层没有条目**时（覆盖缺口表里那一档），
      // 没有 entryId 也应当能出交接单——否则整条流水线会在这一步断掉。
      if (!entry && explicitKeywords.length === 0) {
        return { ok: false, error: '没有 entryId 时必须给 keywords：既无条目又无关键词就无从匹配模板' }
      }
      const requestedAsset = String(args.asset || '').trim()
      if (!requestedAsset) return { ok: false, error: 'asset 不能为空' }
      const scope = String(args.scope || '').trim()
      if (!scope) return { ok: false, error: 'scope 不能为空——交接单中的目标命令必须限定本轮精确范围' }
      const scopedAsset = scopeBoundAsset({ target: requestedAsset }, scope)
      if (!scopedAsset) return { ok: false, error: 'asset 不在本轮精确范围内，拒绝生成可执行命令' }
      const asset = scopedAsset.target
      const workspace = resolveWorkspaceArg(args.workspace, exec)

      const keywords = explicitKeywords.length ? explicitKeywords : (entry.exploit?.nucleiKeywords ?? [])
      const planSlug = entry ? entry.id : `kw-${explicitKeywords.join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40)}`
      const product = entry?.product ?? `关键词直通：${explicitKeywords.join(' / ')}`

      // 1) 在**用户自己的模板库**里找对得上的模板（这才是真正可执行的那一步）
      const templatesDir = resolveNucleiTemplatesDir()
      const templateMatch = templatesDir
        ? scoreNucleiTemplates(templatesDir, keywords)
        : { templates: [], perKeyword: {}, specific: [], genericOnly: false, genericThreshold: 40 }
      const templates = templateMatch.templates
      // 只有通用词凑上时，入选的模板**不是这款产品的模板**——如实说明，别当产品指纹交接。
      const genericWords = Object.entries(templateMatch.perKeyword)
        .filter(([, n]) => n > templateMatch.genericThreshold)
        .map(([w]) => w)
      const nucleiBin = configuredNucleiBin(ctx)
      const nucleiCommand = templates.length
        ? `${nucleiBin} -u ${asset} ${templates.map((t) => `-t "${t}"`).join(' ')} -rl 15 -jsonl -silent -nc`
        : ''

      // 2) 带外确认（通道配好才有——没有就如实说"只能停在疑似"）
      const oob = oobConfig(ctx)
      const oobReady = Boolean(oob.base && oob.token && oob.root)
      const wantsOob = (entry?.verify?.oob ?? []).includes('dnslog')
      let confirm = null
      if (wantsOob && oobReady) {
        const label = `saker-${randomBytes(4).toString('hex')}`
        confirm = { label, domain: `${label}.${oob.root}`, nextCall: `oob_probe action=check label=${label}` }
      } else if (wantsOob) {
        confirm = { ready: false, note: '条目要求 DNS 带外，但 DNSLog 未配置（sec-config.dnslog 需 url/token/domain）' }
      }

      const dir = ensureDirs(workspace)
      const ts = stamp()
      const planFile = path.join(dir, `handoff-${planSlug}-${ts}.md`)
      const tools = Array.isArray(entry?.exploit?.tools) ? entry.exploit.tools : []
      const toolLines = tools.map((t) => (typeof t === 'string' ? `- ${t}` : `- ${t.name}${t.url ? `（${t.url}）` : ''}${t.kind ? ` [${t.kind}]` : ''}`))
      const md = [
        `# Nday 交接单：${product} → ${asset}`,
        '',
        entry
          ? `- 条目：\`${entry.id}\`（状态 ${entry.status}${entry.verification?.reproduced ? '，我方已复现' : '，**我方尚未复现**'}）`
          : `- 条目：**无**（模板直通：该产品在语料层没有条目，直接走你已有的模板库）`,
        entry
          ? `- 编号：${JSON.stringify(entry.ids)} 严重性：CVSS ${entry.severity?.cvss31}（${entry.severity?.level}）`
          : `- 模板关键词：${explicitKeywords.join(' / ')}`,
        entry
          ? `- 类型：${entry.vulnClass}  认证前置：${entry.auth}`
          : '- 类型：未登记（模板命中即为线索，结论仍以模板回执为准）',
        '',
        '## 1. 确认可达（低噪声优先）',
        confirm?.domain
          ? `把 \`${confirm.domain}\` 注入到载荷/参数里，然后 \`${confirm.nextCall}\`。回连只证明载荷被处理，不等于拿到权限。`
          : `（未配置 DNSLog 或条目不含带外验证）${confirm?.note ?? ''}`,
        '',
        '## 2. 本机已有工具：nuclei 模板',
        templates.length
          ? `在你的模板库里找到 **${templates.length}** 个对得上的模板（关键词 ${keywords.join(' / ')}）：`
            + (templateMatch.genericOnly
              ? `\n\n> ⚠ **本机模板库里没有 ${product} 的专属模板**：下面这些全是靠通用词凑上的（${genericWords.join(' / ')}）——命中只说明「存在这类问题」，不代表是这款产品，别当产品指纹用。`
              : '')
            + `\n\n${templates.slice(0, 12).map((t) => `- \`${path.relative(templatesDir, t)}\``).join('\n')}`
            + (templates.length > 12 ? `\n- …还有 ${templates.length - 12} 个` : '')
            + `\n\n可直接执行：\n\n\`\`\`bash\n${nucleiCommand}\n\`\`\``
          : `没有在本机模板库里找到对得上的模板${templatesDir ? `（已查 ${templatesDir}）` : '（未找到模板目录）'}。`
            + `\n关键词：${keywords.length ? keywords.join(' / ') : '（条目未声明）'}`,
        '',
        '## 3. 公开工具（需要就自己去取）',
        toolLines.length ? toolLines.join('\n') : '（条目未点名公开工具）',
        '',
        '## 4. 纪律',
        '- 本交接单**只是计划**：不执行、不投载荷。',
        '- 命中 / 回连都要落台账；进报告前按验证等级（疑似 / 已触发未利用 / 完整利用链 / 影响证明）如实标注。',
        '- 速率按目标防护画像压；该漏洞若已在野利用，更要克制。',
        '',
        `生成时间：${new Date().toISOString()}`,
      ].join('\n')
      fs.writeFileSync(planFile, md + '\n', 'utf8')
      appendEvidence(workspace, `nday-handoff-${ts}`, `nday_handoff ${planSlug} → ${asset}`, path.relative(workspace, planFile))

      const text = [
        `交接单已生成：${path.relative(workspace, planFile)}`,
        entry ? `条目 ${entry.id}（${entry.status}）→ ${asset}` : `模板直通（无条目）→ ${asset}`,
        templates.length
          ? `\n2) 你自己已有的 nuclei 模板命中 ${templates.length} 个`
            + (templateMatch.genericOnly
              ? `（⚠ 全是通用词凑的，本机没有 ${product} 的专属模板——别当产品指纹）`
              : `（其中专属模板 ${templateMatch.specific.length} 个）`)
            + `，直接跑：\n   ${nucleiCommand}`
          : '\n2) 本机 nuclei 模板库里没有对得上的模板——需要按上面的公开工具自己取。',
        confirm?.domain
          ? `\n1) 带外确认：注入 ${confirm.domain} 后调 ${confirm.nextCall}`
          : `\n1) 带外确认不可用：${confirm?.note ?? '该条目不含带外验证'}`,
        '\n（本工具只出计划，不执行、不投载荷。）',
      ].join('\n')
      return {
        ok: true,
        entryId: entry?.id ?? null,
        mode: entry ? 'entry' : 'template-direct',
        asset,
        templates: templates.length,
        templatesSpecific: templateMatch.specific.length,
        templatesGenericOnly: templateMatch.genericOnly,
        nucleiCommand,
        confirm,
        planFile: path.relative(workspace, planFile),
        text,
      }
    },
  }))

  if (enablePostRceTools) registerNdayTool(defineTool({
    name: 'access_confirm',
    description: 'Write a minimal-impact access-confirmation plan with stop and cleanup steps.',
    parameters: {
      entryId: { type: 'string', required: true, description: 'Catalog entry ID' },
      asset: { type: 'string', required: true, description: 'Target URL or host' },
      workspace: { type: 'string', required: true, description: 'Workspace for the plan' },
      bucketId: { type: 'string', description: 'Optional attack-plan bucket' },
      parentTaskId: { type: 'string', description: 'Optional parent task ID' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `access_confirm 失败：${v.error}` }],
    },
    async execute(args, exec) {
      const workspace = resolveWorkspaceArg(args.workspace, exec)
      let catalog
      try {
        ({ catalog } = catalogOrThrow())
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
      const entry = getEntry(catalog, String(args.entryId || '').trim())
      if (!entry) return { ok: false, error: `条目不存在：${args.entryId}` }
      const plan = buildAccessPlan(entry, args.asset, { bucketId: args.bucketId, parentTaskId: args.parentTaskId, memoryBackend: memshellConfig(ctx) })
      const dir = ensureDirs(workspace)
      const ts = stamp()
      const jsonFile = path.join(dir, `access-confirm-${ts}.json`)
      const mdFile = path.join(dir, `access-confirm-${ts}.md`)
      fs.writeFileSync(jsonFile, JSON.stringify(plan, null, 2) + '\n', 'utf8')
      fs.writeFileSync(mdFile, renderAccessPlan(plan), 'utf8')
      appendEvidence(workspace, `access-${ts}`, `access_confirm ${entry.id} @ ${plan.asset}`, path.relative(workspace, jsonFile).replace(/\\/g, '/'))

      const task = { registered: false, skipped: false, reason: '' }
      if (args.bucketId || args.parentTaskId) {
        try {
          const gate = await import('@dsh-external/dsh-stage-gate')
          const state = gate.readOperationState(fs, workspace)
          if (!state) task.reason = 'operation-state.json 不存在'
          else {
            const summary = `访问确认：${entry.id} @ ${plan.asset}`
            if ((state.intents || []).some((intent) => intent.summary === summary)) {
              task.skipped = true
            } else {
              gate.registerIntent(workspace, {
                summary,
                anchorKind: 'boot',
                owner: `subagent-access-${entry.id}`,
                maxAttempts: 2,
                stage: 'S5',
                bucketId: args.bucketId,
                parentTaskId: args.parentTaskId,
              })
              task.registered = true
            }
          }
        } catch (error) {
          task.reason = String(error?.message || error)
        }
      }

      const text = [
        renderAccessPlan(plan).trim(),
        '',
        `计划 JSON：${path.relative(workspace, jsonFile).replace(/\\/g, '/')}`,
        `计划 Markdown：${path.relative(workspace, mdFile).replace(/\\/g, '/')}`,
        task.registered ? '已登记访问确认子任务。' : task.skipped ? '访问确认子任务已存在。' : task.reason ? `任务图未登记：${task.reason}` : '',
      ].filter((line) => line !== '').join('\n')
      return { ok: true, plan, task, files: { json: path.relative(workspace, jsonFile), markdown: path.relative(workspace, mdFile) }, text }
    },
  }))

  registerNdayTool(defineTool({
    name: 'oob_probe',
    description: 'DNSLog callbacks: create, batch, or check labels; callback proves reachability only.',
    parameters: {
      action: { type: 'string', enum: ['new', 'batch', 'check'], required: true, description: 'Create, batch, or check callbacks' },
      label: { type: 'string', description: 'Label returned by new/batch' },
      assets: { type: 'string', description: 'Assets for batch action' },
      workspace: { type: 'string', description: 'Workspace for attribution records' },
      waitMs: { type: 'integer', description: 'Poll duration (default 0, max 60000)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.text : `oob_probe 拒绝/失败：${v.error}` }],
    },
    async execute(args, exec) {
      const cfg = oobConfig(ctx)
      const missing = []
      if (!cfg.base) missing.push('平台地址（设置 → 安全配置 → DNSLog 平台 → 平台地址）')
      if (!cfg.token) missing.push('token（同上）')
      if (!cfg.root) missing.push('接收域名（同上，如 abc123.ceye.io）')
      if (missing.length > 0) {
        return {
          ok: false,
          error: `带外通道未配置：缺 ${missing.join('、')}。缺任一项都无法确认回连——`
            + '没有带外通道时，反序列化/盲 RCE/SSRF 这类面只能停在「疑似」，不要写成已确认。',
        }
      }

      if (args.action === 'new') {
        const label = `saker-${randomBytes(4).toString('hex')}`
        const domain = `${label}.${cfg.root}`
        return {
          ok: true,
          label,
          domain,
          text: `把下面这个域名注入到要确认的载荷/参数里：\n\n    ${domain}\n\n`
            + `注入后调 oob_probe action=check label=${label}（可给 waitMs 轮询等待）。\n`
            + '回连只能证明「载荷被处理并触发了外连」，不等于已拿到权限。',
        }
      }

      // 批量：每个资产一个**可归因**的子域名（共用 label 前缀 + 序号后缀）。
      // 为什么必须每资产一个：共用同一个域名时，回连只能证明「这一类资产里有某个触发了」，
      // 无法回答「是哪几台」——而 P0-0 要的恰恰是**同指纹资产里的命中清单**。
      if (args.action === 'batch') {
        const workspaceArgRaw = String(args.workspace || '').trim()
        if (!workspaceArgRaw) {
          return {
            ok: false,
            error: 'batch 需要 workspace：归因表要落盘，否则 check 无法把回连对回到具体资产。',
          }
        }
        const workspace = resolveWorkspaceArg(workspaceArgRaw, exec)
        const parsed = parseTargets(String(args.assets || ''))
        if (parsed.length === 0) return { ok: false, error: 'batch 需要 assets：逗号/换行分隔的目标列表。' }
        if (parsed.length > 200) return { ok: false, error: 'batch 一次最多 200 个资产，超了请分批。' }
        const label = `saker-${randomBytes(4).toString('hex')}`
        const rows = parsed.map((asset, index) => ({
          asset: asset.base,
          domain: `${label}-${index + 1}.${cfg.root}`,
        }))
        writeOobBatchTable(workspace, label, cfg.root, rows)
        return {
          ok: true,
          label,
          assets: rows.length,
          rows,
          text: `已为 ${rows.length} 个资产各分配一个可归因的子域名（前缀 ${label}）：\n`
            + rows.map((row) => `  - ${row.asset} → ${row.domain}`).join('\n')
            + `\n\n把**对应**的域名注入到每个资产的载荷里，然后调 oob_probe action=check label=${label} workspace=<同一个 workspace>，`
            + '它会按后缀把回连对回到具体资产、给出命中清单。\n'
            + '回连只证明「载荷被处理并触发了外连」，不等于已拿到权限。',
        }
      }

      const label = String(args.label || '').trim()
      if (!OOB_LABEL_RE.test(label)) {
        return {
          ok: false,
          error: 'check 需要 new 返回的 label（形如 saker-1a2b3c4d）。'
            + '没有 label 就无法把回连归因到本次测试——宁可拒绝，也不拿「看到别人的记录」当命中。',
        }
      }
      // 批量模式：归因表在，就用**不带 root 的前缀**过滤，才能同时捞到 `-1` / `-2` 这些后缀名；
      // 单次模式仍按 `label.root` 精确过滤，避免捞到别的测试。
      const batchFile = String(args.workspace || '').trim()
        ? path.join(String(args.workspace).trim(), '.saker', `oob-batch-${label}.json`)
        : ''
      let batchRows = null
      if (batchFile && fs.existsSync(batchFile)) {
        try { batchRows = JSON.parse(fs.readFileSync(batchFile, 'utf8')).rows ?? [] } catch { batchRows = null }
      }
      const filter = batchRows ? label : `${label}.${cfg.root}`
      const waitMs = Math.min(Math.max(Number(args.waitMs) || 0, 0), 60000)
      const deadline = Date.now() + waitMs
      let rows = []
      for (;;) {
        const queried = await oobFetchRecords({ base: cfg.base, token: cfg.token, filter })
        if (!queried.ok) return { ok: false, error: queried.error }
        rows = queried.rows
        if (rows.length > 0 || Date.now() >= deadline) break
        await sleep(3000)
      }

      const hit = rows.length > 0
      // 批量模式：把每条回连按**后缀序号**对回到具体资产，产出命中清单。
      const hits = batchRows
        ? rows.map((row) => {
            const name = String(row?.name ?? row?.domain ?? '')
            const matched = batchRows.find((entry) => name === entry.domain || name.endsWith(`.${entry.domain}`))
            return {
              asset: matched?.asset ?? '(未对上归因表)',
              domain: matched?.domain ?? name,
              remote: row?.remote_addr ?? row?.remoteAddress ?? row?.ip ?? '?',
              at: row?.created_at ?? row?.timestamp ?? '?',
            }
          })
        : []
      const hitAssets = [...new Set(hits.map((h) => h.asset).filter((a) => a !== '(未对上归因表)'))]
      const preview = rows.slice(0, 5).map((row) => {
        const name = row?.name ?? row?.domain ?? '(no name)'
        const remote = row?.remote_addr ?? row?.remoteAddress ?? row?.ip ?? '?'
        const when = row?.created_at ?? row?.timestamp ?? '?'
        return `${name} ← ${remote} @ ${when}`
      })
      return {
        ok: true,
        hit,
        domain: filter,
        count: rows.length,
        ...(batchRows ? { assets: batchRows.length, hitAssets, hits } : {}),
        records: preview,
        text: batchRows
          ? (hit
            ? `✅ 批量回连：${batchRows.length} 个资产里命中 ${hitAssets.length} 个\n`
              + hits.map((h) => `  - ${h.asset} ← ${h.remote} @ ${h.at}（${h.domain}）`).join('\n')
              + '\n\n口径：逐条按子域名后缀归因，所以「哪几台触发了」是可证的；'
              + '但这只证明载荷被处理并触发外连，**不等于已拿到权限**。'
            : `未收到回连（${batchRows.length} 个资产，等待 ${waitMs}ms 内 0 条记录）。\n`
              + '注意：未回连 ≠ 不存在——可能是载荷不对、触发条件不满足、出网被限制，或平台记录有延迟。')
          : (hit
          ? `✅ 收到回连：${filter} 命中 ${rows.length} 条\n${preview.map((l) => `  - ${l}`).join('\n')}\n\n`
            + '口径：这证明载荷被目标处理并触发了外连（可达性/处理链确认）。'
            + '要断言「拿到权限」还需要后续证据（命令回显、文件落地、会话建立等），别把回连写成 RCE 已成。'
          : `未收到回连（${filter}，等待 ${waitMs}ms 内 ${rows.length} 条记录）。\n`
            + '注意：未回连 ≠ 不存在——可能是载荷不对、触发条件不满足、出网被限制，或平台记录有延迟。'),
      }
    },
  }))
}

export { apply, inject, name }
