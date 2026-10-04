// Deterministic Nday prioritization and orchestration.
//
// This layer never contacts a target and never carries exploit code. It turns
// a catalog + target context + policy into:
//   1. ranked Nday candidates;
//   2. a deduplicated, per-entry FOFA query plan;
//   3. a verification/EXP-source plan;
//   4. a bounded subagent fan-out plan.
//
// Verification remains evidence-driven: a query hit is a candidate, not a
// vulnerability conclusion.

import { buildNdaySearchPlan, expansionQueries } from './measurement-query.js'
import { verificationCost } from './plan.js'
import { NDAY_SOURCE_REGISTRY, sourceRegistrySummary } from './source-registry.js'
import { taskPolicy } from 'dsh-saker/pentest-policy'
import { buildVerificationQueue, parseVerificationContext } from './verification-queue.js'
import { selectReconCandidates } from './recon-candidates.js'

export const DEFAULT_POLICY = Object.freeze({
  recentDays: 730,
  domesticBoost: 30,
  trendKeywords: ['信创', '国产化', '护网', '攻防演练'],
  excludeVendors: [],
  maxCandidates: 12,
  queriesPerNday: 2,
  concurrency: 4,
})

/**
 * Model-facing guidance. These are decision dimensions, not a rigid truth
 * table: the model may reorder candidates when target evidence says so.
 */
export const NDAY_GUIDANCE = Object.freeze({
  rankingDimensions: [
    { id: 'recency', prompt: '优先实际披露和已核实新检测/绕过的变化时间；旧编号不证明已修复，有目标证据的历史高危继续进入验证队列。' },
    { id: 'domestic', prompt: '信创、国产中间件/OA/数据库/安全设备优先；同类漏洞中优先国内厂商和国内社区已有实战讨论的条目。' },
    { id: 'targetFit', prompt: '产品、版本、端口、路径、证书、favicon、header/body 特征与目标证据逐项匹配；只凭厂商名不算匹配。' },
    { id: 'reachability', prompt: '优先无需认证、外网可达、前置条件少的路径；需要后台、内网跳板或特定依赖的降权。' },
    { id: 'impact', prompt: 'RCE、认证绕过、任意文件读写/反序列化优先；信息泄露、缺头、TLS/CORS 等弱配置只在有完整利用链时保留。' },
    { id: 'exploitMaturity', prompt: '有厂商公告、CNVD/CVE、公开 PoC、补丁差分、社区复现或成熟工具链的优先；仅有标题匹配的降权。' },
    { id: 'verificationCost', prompt: '探针可判定、可回显最小 marker、可用 OOB 的优先；需要破坏性副作用或长时间盲打的降权。' },
    { id: 'communityHeat', prompt: '社区热度、近期公众号/会议/攻防演练讨论、是否被现有工具快速收录，作为时间窗口的信号而非漏洞结论。' },
  ],
  sourcePlaybook: [
    { source: '厂商安全公告', use: '确认影响版本、补丁、前置条件和官方措辞；最高优先级。' },
    { source: 'CNVD / CNNVD', use: '国内产品和国内编号优先；查技术细节、影响范围和公开时间。' },
    { source: 'CVE / NVD', use: '国际编号、CVSS、CWE、引用链；与厂商公告交叉核对。' },
    { source: 'GitHub', use: '搜索 PoC、补丁提交、issue、release diff、nuclei/afrog 模板；先审代码再隔离运行。' },
    { source: 'nuclei-templates 更新', use: '读取公开 commit feed 的模板变更时间、路径与提交链接；模板更新是 PoC 线索，不等于漏洞已确认。' },
    { source: 'ExploitDB / Packet Storm / Metasploit', use: '核对成熟利用路径与前置条件，不直接照搬 payload。' },
    { source: '国内安全情报', use: '奇安信/360/绿盟/长亭/知道创宇/微步/安恒/Seebug/安全客/FreeBuf/先知/看雪等；关注时间、复现条件、是否已修复。' },
    { source: '微信公众号', use: '搜索产品名+漏洞名+复现/分析/利用/修复；公众号无稳定 API 时用站内搜索与 web_search，把可靠链接回写用户层 catalog。' },
    { source: '目标自身', use: '版本页、静态资源、错误页、证书、favicon、header、JS bundle 和 API 响应；目标证据优先于外部热度。' },
  ],
  sourceRadar: {
    policy: '结构化公告/编号源是主源，公众号是提前量；公众号线索必须回到厂商公告、CNVD/CVE 或 GitHub 交叉验证后才能升级为候选。',
    primary: [
      'CNVD / CNNVD 最新漏洞',
      'NVD / CVE 最近发布',
      '厂商安全公告与补丁页',
      'GitHub Security Advisories / PoC / nuclei-templates',
      'CISA KEV / ExploitDB / Packet Storm / Metasploit',
    ],
    enrichment: [
      '微信公众号与安全社区文章',
      'Seebug / 安全客 / FreeBuf / 先知 / 看雪',
      '奇安信 / 360 / 绿盟 / 长亭 / 微步 / 安恒等情报通告',
    ],
    discoveryQueries: [
      { source: 'CNVD/CNNVD', query: 'site:cnvd.org.cn "高危" "远程代码执行" {year}' },
      { source: 'CVE/NVD', query: 'published:last_7_days CVSS:9.0..10.0 RCE' },
      { source: 'GitHub', query: '"CVE-{year}" "PoC" "RCE" OR "CNVD" "复现"' },
      { source: 'nuclei', query: 'nuclei-templates commits CVE-{year} RCE' },
      { source: '微信公众号', query: 'site:mp.weixin.qq.com "CNVD-{year}" "复现"' },
      { source: '微信公众号', query: 'site:mp.weixin.qq.com "最新漏洞" "信创"' },
      { source: '微信公众号', query: 'site:mp.weixin.qq.com "OA" "RCE" "影响版本"' },
    ],
    workflow: [
      '没有目标产品时，先按发布时间和严重性扫主源，不要先猜漏洞名。',
      '把候选归一化为 product / vendor / ID / published / affectedVersions / sourceUrl。',
      '再与目标资产、技术栈和行业线索做相关性过滤。',
      '每个候选至少生成一条 FOFA 语法，并保留来源与推断依据。',
      '公众号发现只进候选池；缺少编号、公告或 PoC 时不得写成已确认漏洞。',
    ],
    sources: NDAY_SOURCE_REGISTRY,
  },
  fofaTiers: [
    { tier: 'exact', prompt: '高精度：product/product.version、body/header、icon_hash、fid、banner 的组合，最少引入无关资产。' },
    { tier: 'product', prompt: '产品级：app 或 title/body 单指纹，适合先扩候选，但必须再做目标证据复核。' },
    { tier: 'related', prompt: '关联级：cert.subject.cn/org、cert、ip、asn、icp、org，用于发现证书复用、同 IP 后台和只有 IP 的隐藏站点。' },
    { tier: 'exclude', prompt: '排除级：is_honeypot=false、is_fraud=false、厂商/云/CDN/反代噪声、无关端口和地区；不要用宽泛单字段直接下结论。' },
  ],
  verificationLadder: [
    'passive candidate: FOFA/情报/目录查询，只产生候选。',
    'fingerprint: 产品、版本、路径、证书、favicon、header/body 证据。',
    'precondition: 认证、版本区间、依赖、代理/网关、补丁状态。',
    'exp discovery: 厂商公告 → CNVD/CVE → GitHub → 国内情报/公众号；没有 EXP 时做补丁差分和协议线索推理。',
    'minimal proof: 机器可判定探针、最小无害 marker、必要时 OOB；命中后立即停止，不建立 shell/webshell/持久化。',
    'evidence: 请求/响应、版本、时间、marker/差分、阻断点；搜索命中不能写成 RCE 结论。',
  ],
  subagentPolicy: [
    '默认单模型规划、批量工具执行；不按每个 Nday 或 URL 派一个子代理。',
    '仅独立且有证据的分支按需委派；工具并发与模型并发分别计费和限额。',
    '每个 worker 必须返回：候选查询、目标证据、版本前提、EXP 来源、验证结论或阻断点。',
    '只有主代理可以登记最终成果；子代理发现先回传，避免重复台账和误报。',
  ],
})

const DOMESTIC_TERMS = [
  '信创', '国产', '东方通', 'tongtech', 'tongweb', '宝兰德', 'bes', '金蝶', 'kingdee',
  '用友', 'yonyou', '致远', 'seeyon', '泛微', 'weaver', '蓝凌', 'landray', '达梦', 'dameng',
  '人大金仓', 'kingbase', '麒麟', 'kylin', '统信', 'uniontech', '润乾', '帆软', 'finereport',
  '若依', 'ruoyi', 'jeecg',
]

const GENERIC_ALIASES = new Set(['oa', 'erp', 'rce', 'cve', 'java', 'web'])
const RELEVANCE_STOPWORDS = new Set([
  'oa', 'erp', 'rce', 'cve', 'java', 'web',
  '信创', '国产', '中间件', '应用服务器', '服务器', '应用', '系统', '漏洞', '远程代码执行',
])

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max)
}

function list(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item)).filter(Boolean)
  return String(value ?? '').split(/[\s,，;；]+/).map((item) => clean(item)).filter(Boolean)
}

function entryText(entry) {
  return [
    entry?.id, entry?.product, entry?.vendor, entry?.category, entry?.vulnClass,
    ...(Array.isArray(entry?.aliases) ? entry.aliases : []),
    entry?.ids?.cve, entry?.ids?.cnvd, entry?.ids?.qvd,
    ...(Array.isArray(entry?.sources) ? entry.sources.map((source) => `${source?.title ?? ''} ${source?.url ?? ''}`) : []),
  ].filter(Boolean).join(' ').toLowerCase()
}

function yearsIn(value) {
  return [...String(value ?? '').matchAll(/\b(20\d{2})\b/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 2000 && year <= 2100)
}

/**
 * Extract the vulnerability year. IDs are authoritative: a 2021 CNVD entry
 * must not become "recent" merely because a 2026 blog post cited it. Only when
 * there is no vulnerability ID do we fall back to source title/URL years.
 */
export function entryYear(entry) {
  const idYears = yearsIn([
    entry?.ids?.cve,
    entry?.ids?.cnvd,
    entry?.ids?.qvd,
    entry?.id,
  ].filter(Boolean).join(' '))
  if (idYears.length) return Math.max(...idYears)
  const sourceYears = yearsIn((entry?.sources ?? [])
    .map((source) => `${source?.title ?? ''} ${source?.url ?? ''}`)
    .join(' '))
  return sourceYears.length ? Math.max(...sourceYears) : 0
}

export function isDomesticEntry(entry) {
  // Category prose and linked articles do not establish product ownership.
  const text = [entry?.vendor, entry?.product, ...(entry?.aliases ?? [])].filter(Boolean).join(' ').toLowerCase()
  return DOMESTIC_TERMS.some((term) => containsTerm(text, term))
}

export function entryTiming(entry, now = Date.now()) {
  const time = value => {
    const parsed = Date.parse(String(value ?? ''))
    return Number.isFinite(parsed) && parsed <= now ? parsed : null
  }
  const disclosed = [entry?.publishedAt, entry?.published, entry?.disclosedAt,
    ...(entry?.sources ?? []).filter(source => source?.kind === 'vendor-advisory').map(source => source.publishedAt)]
    .map(time).filter(value => value !== null)
  const developments = (entry?.developments ?? []).filter(event => event?.verified === true
    && ['public-poc', 'active-exploitation', 'patch-bypass'].includes(event.kind))
    .map(event => ({ kind: event.kind, at: time(event.at) })).filter(event => event.at !== null)
  const disclosedAt = disclosed.length ? Math.min(...disclosed) : null
  const latest = developments.sort((a, b) => b.at - a.at)[0]
  const priorityAt = Math.max(disclosedAt ?? 0, latest?.at ?? 0) || null
  return {
    disclosedAt: disclosedAt === null ? null : new Date(disclosedAt).toISOString(),
    development: latest ? { kind: latest.kind, at: new Date(latest.at).toISOString() } : null,
    priorityAt: priorityAt === null ? null : new Date(priorityAt).toISOString(),
    ageDays: priorityAt === null ? null : Math.floor((now - priorityAt) / 86400000),
    basis: priorityAt === null ? 'unknown' : latest?.at === priorityAt ? latest.kind : 'disclosure',
  }
}

function productText(entry) {
  return [entry?.product, entry?.vendor, ...(entry?.aliases ?? [])].filter(Boolean).join(' ').toLowerCase()
}

function impactTier(entry) {
  const text = `${entry?.vulnClass ?? ''} ${(entry?.exploit?.primitives ?? []).join(' ')}`
  if (/RCE|remote code execution|命令执行|代码执行|反序列化|认证绕过|权限提升|任意文件|SQL.?注入|SQL.?injection/i.test(text)) return 'high'
  if (Number(entry?.severity?.cvss31) >= 7 && !/TLS|CORS|缺头|安全头|certificate/i.test(text)) return 'high'
  return 'other'
}

export function normalizePriorityPolicy(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const recentDays = Math.max(30, Math.min(3650, Number(source.recentDays) || DEFAULT_POLICY.recentDays))
  return {
    recentDays,
    domesticBoost: Number.isFinite(Number(source.domesticBoost)) ? Number(source.domesticBoost) : DEFAULT_POLICY.domesticBoost,
    trendKeywords: [...new Set(list(source.trendKeywords).length ? list(source.trendKeywords) : DEFAULT_POLICY.trendKeywords)].slice(0, 30),
    excludeVendors: [...new Set(list(source.excludeVendors))].slice(0, 50),
    maxCandidates: Math.max(1, Math.min(100, Number(source.maxCandidates) || DEFAULT_POLICY.maxCandidates)),
    queriesPerNday: Math.max(1, Math.min(8, Number(source.queriesPerNday) || DEFAULT_POLICY.queriesPerNday)),
    concurrency: Math.max(1, Math.min(8, Number(source.concurrency) || DEFAULT_POLICY.concurrency)),
  }
}

function targetTermsOf(options = {}) {
  // Explicit targetTerms/keywords are intentional and always honoured. A
  // free-text target is only a convenience: generic words such as "OA" and
  // "RCE" must not make every entry look target-relevant.
  const explicit = [...list(options.targetTerms), ...list(options.keywords)]
  const inferred = list(options.target)
    .map((term) => clean(term).toLowerCase())
    .filter((term) => term.length >= 3 && !RELEVANCE_STOPWORDS.has(term))
  return [...new Set([...explicit, ...inferred].map((term) => term.toLowerCase()))]
}

function containsTerm(text, term) {
  if (!term) return false
  // ASCII short terms need a token boundary; otherwise "oa" matches "load".
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(term) && term.length <= 4) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)
  }
  return text.includes(term)
}

function sourceWeight(entry) {
  const text = entryText(entry)
  let score = 0
  if (/\bgithub\b|github\.com/.test(text)) score += 8
  if (/公众号|wechat|mp\.weixin/.test(text)) score += 4
  if (/\bcnvd\b|cnvd-/.test(text)) score += 10
  if (/\bcve\b|cve-/.test(text)) score += 8
  if (/vendor|厂商|安全公告|advisory/.test(text)) score += 5
  return score
}

function hasExploitArtifact(entry) {
  return Boolean((entry?.exploit?.tools ?? []).length || (entry?.exploit?.primitives ?? []).length || entry?.exploit?.poc)
}

/**
 * Rank one entry. The score is explainable and deterministic: every boost or
 * penalty is emitted in `reasons`, so the model can show why a candidate is
 * above another one instead of hiding the decision in prose.
 */
export function scoreEntry(entry, options = {}) {
  const policy = normalizePriorityPolicy(options.policy)
  const currentYear = Number(options.currentYear) || new Date().getFullYear()
  const now = options.now === undefined ? Date.now() : new Date(options.now).getTime()
  if (!Number.isFinite(now)) throw new Error('invalid ranking timestamp')
  const timing = entryTiming(entry, now)
  const year = entryYear(entry)
  const ageYears = year ? currentYear - year : null
  const targetTerms = targetTermsOf(options)
  const targetText = targetTerms.join(' ')
  const text = entryText(entry)
  const reasons = []
  let score = 0

  if (timing.ageDays !== null) {
    const withinWindow = timing.ageDays <= policy.recentDays
    const recency = withinWindow ? 30 + Math.round(10 * (1 - timing.ageDays / policy.recentDays)) : -10
    score += recency
    const windowLabel = withinWindow
      ? `近 ${policy.recentDays} 天窗口内`
      : `超出近 ${policy.recentDays} 天窗口`
    reasons.push(`时间：${timing.priorityAt.slice(0, 10)} / ${timing.basis}（${recency >= 0 ? '+' : ''}${recency}，${windowLabel}）`)
  } else {
    reasons.push('时间：披露/新利用日期未知（0）；编号年份仅作索引')
  }

  if (isDomesticEntry(entry)) {
    score += policy.domesticBoost
    reasons.push(`国产/信创：+${policy.domesticBoost}`)
  }

  const trendText = [productText(entry), ...(entry?.trends ?? [])].join(' ').toLowerCase()
  const trendHits = policy.trendKeywords.filter((keyword) => trendText.includes(String(keyword).toLowerCase()))
  if (trendHits.length) {
    const boost = Math.min(30, trendHits.length * 10)
    score += boost
    reasons.push(`趋势词：${trendHits.join('/')} +${boost}`)
  }

  const targetFit = Boolean(targetText && targetTerms.some(term => containsTerm(productText(entry), term)))
  if (targetFit) {
    score += 45
    reasons.push('目标相关性：+45')
  }

  const cvss = Number(entry?.severity?.cvss31)
  if (Number.isFinite(cvss)) {
    const boost = Math.round(Math.max(0, Math.min(10, cvss)) * 2)
    score += boost
    reasons.push(`CVSS：+${boost}`)
  }

  if (entry?.status === 'verified' || entry?.verification?.reproduced === true) {
    score += 15
    reasons.push('已复现：+15')
  }
  if (hasExploitArtifact(entry)) {
    score += 8
    reasons.push('有公开工具/原语：+8')
  }
  const source = sourceWeight(entry)
  if (source) {
    score += source
    reasons.push(`来源：CNVD/CVE/GitHub/公告 +${source}`)
  }

  const cost = verificationCost(entry)
  score -= cost * 4
  reasons.push(`验证成本：${cost}（-${cost * 4}）`)

  const impact = impactTier(entry)
  if (impact === 'high') { score += 35; reasons.push('高影响路径：+35') }
  else { score -= 45; reasons.push('非高影响候选：-45') }
  return { score: Number(score.toFixed(2)), year, ageYears, timing, targetFit, impact, reasons }
}

function fallbackQueries(entry, limit) {
  const queries = []
  const aliases = [entry?.product, ...(entry?.aliases ?? [])]
    .map((value) => clean(value))
    .filter((value) => value.length >= 4 && !GENERIC_ALIASES.has(value.toLowerCase()))
  const primary = aliases[0] || clean(entry?.product)
  for (const field of ['title', 'body', 'header']) {
    if (primary) queries.push(`${field}:"${primary.replace(/"/g, '\\"')}"`)
  }
  return [...new Set([...queries, ...expansionQueries(entry)] )].slice(0, limit)
}

function expDiscoveryPlan(entry) {
  const ids = [entry?.ids?.cve, entry?.ids?.cnvd, entry?.ids?.qvd].filter(Boolean)
  const product = clean(entry?.product || entry?.id)
  return {
    officialUrls: (entry?.sources ?? []).map((source) => source?.url).filter(Boolean).slice(0, 5),
    searchQueries: [
      `${product} ${ids.join(' ') || '漏洞'} exploit`,
      `${product} ${ids.join(' ') || '漏洞'} poc`,
      `${product} ${ids.join(' ') || '漏洞'} 复现`,
    ],
    preferredSources: ['厂商公告', 'CNVD', 'CVE/NVD', 'GitHub', 'nuclei-templates 更新', '微信公众号/社区文章'],
    handling: '只检索和阅读公开材料；不直接执行来源不明的脚本，先做静态审阅与本地隔离复现。',
  }
}

function verificationPlan(entry) {
  const probes = entry?.fingerprint?.probes ?? []
  const oob = entry?.verify?.oob ?? []
  const stages = [
    { stage: 'fingerprint', action: '用条目探针/FOFA 指纹确认产品与暴露面；命中只算候选。' },
    { stage: 'version-precondition', action: '核对版本区间、认证前提、路径/端口和补丁状态。' },
    { stage: 'exp-discovery', action: '查官方公告、CNVD/CVE、GitHub、nuclei-templates 更新和社区文章；没有公开 EXP 时先做补丁差分和协议线索推理。' },
    { stage: 'minimal-verification', action: '优先机器可判定探针；能回显最小无害 marker 时不升级到破坏性操作。' },
    { stage: 'evidence', action: '保留请求/响应、时间、版本、marker/差分证据；失败写清阻断点，不把搜索命中当 RCE。' },
  ]
  if (oob.length) stages.splice(3, 0, { stage: 'oob', action: `按条目要求使用带外通道：${oob.join(', ')}。` })
  return { stages, probeCount: probes.length, oob, exp: expDiscoveryPlan(entry) }
}

/**
 * Build the complete priority plan. It performs no network calls.
 */
export function buildPriorityPlan(catalog, options = {}) {
  const policyOverrides = { ...(options.policy ?? {}) }
  for (const key of ['recentDays', 'domesticBoost', 'trendKeywords', 'excludeVendors', 'maxCandidates', 'queriesPerNday', 'concurrency']) {
    if (options[key] !== undefined) policyOverrides[key] = options[key]
  }
  const policy = normalizePriorityPolicy(policyOverrides)
  const excludeVendors = policy.excludeVendors.map((value) => value.toLowerCase())
  const requestedIds = new Set(list(options.entryIds))
  const excludedIds = new Set(list(options.excludeIds))
  const currentYear = Number(options.currentYear) || new Date().getFullYear()
  const candidates = (catalog?.entries ?? [])
    .filter((entry) => !['deprecated'].includes(String(entry?.status || '')))
    .filter((entry) => requestedIds.size === 0 || requestedIds.has(entry.id))
    .filter((entry) => !excludedIds.has(entry.id))
    .filter((entry) => !excludeVendors.some((vendor) => entryText(entry).includes(vendor)))
    .map((entry) => ({ entry, rank: scoreEntry(entry, { ...options, policy, currentYear }) }))
    .sort((left, right) => right.rank.score - left.rank.score || right.rank.year - left.rank.year || left.entry.id.localeCompare(right.entry.id))

  const verificationContext = parseVerificationContext(options.verificationContext)
  const verificationQueue = buildVerificationQueue(candidates, verificationContext)
  const observedAssets = verificationContext.assets
  const relatedIds = new Set(observedAssets.flatMap(asset => selectReconCandidates(candidates.map(row => row.entry), asset).map(row => row.entryId)))
  for (const check of verificationContext.checks) relatedIds.add(check.entryId)
  const scopedCandidates = observedAssets.length && requestedIds.size === 0
    ? candidates.filter(row => relatedIds.has(row.entry.id)) : candidates
  const selectedCandidates = scopedCandidates.slice(0, policy.maxCandidates)

  const selectedIds = selectedCandidates.map(({ entry }) => entry.id).join(',')
  const searchPlan = selectedCandidates.length ? buildNdaySearchPlan(catalog, { focus: 'all', entryIds: selectedIds, limit: 500 })
    : { selected: [], rejectedHints: [] }
  const groupsByEntry = new Map()
  for (const group of searchPlan.selected ?? []) {
    for (const entryId of group.entryIds ?? []) {
      const listForEntry = groupsByEntry.get(entryId) ?? []
      listForEntry.push(group)
      groupsByEntry.set(entryId, listForEntry)
    }
  }

  const seenQueries = new Set()
  const queries = []
  const blockedEntries = new Set((searchPlan.rejectedHints ?? []).map(hint => hint.entryId))
  const results = selectedCandidates.map(({ entry, rank }) => {
    const authored = (groupsByEntry.get(entry.id) ?? [])
      .map((group) => ({ query: group.query, basis: group.basis, score: group.score }))
      .slice(0, policy.queriesPerNday)
    const chosen = authored.length ? authored : blockedEntries.has(entry.id) ? [] : fallbackQueries(entry, policy.queriesPerNday).map((query) => ({ query, basis: 'fallback', score: rank.score }))
    for (const item of chosen) {
      if (seenQueries.has(item.query)) continue
      seenQueries.add(item.query)
      queries.push({ entryId: entry.id, ...item })
    }
    return {
      id: entry.id,
      product: entry.product,
      vendor: entry.vendor,
      ids: entry.ids,
      status: entry.status,
      year: rank.year,
      timing: rank.timing,
      targetFit: rank.targetFit,
      impact: rank.impact,
      score: rank.score,
      reasons: rank.reasons,
      queries: chosen,
      verification: verificationPlan(entry),
      nextAction: rank.targetFit ? 'check-prerequisites' : 'discover-product',
    }
  })

  return {
    schema: 'saker.nday.priority-plan/1',
    generatedAt: new Date().toISOString(),
    policy,
    guidance: NDAY_GUIDANCE,
    target: options.target || '',
    task: taskPolicy({ mode: options.mode || 'nday', stop: options.stop }),
    componentHypotheses: /\bjava\b|tomcat|spring|jdk|jvm/i.test([options.target, ...list(options.targetTerms), ...list(options.technologies),
      ...observedAssets.flatMap(asset => list(asset.tech))].join(' '))
      ? [{ id: 'java-log4j2', component: 'log4j-core', basis: 'Java-family clue', state: 'unknown',
        nextAction: 'check-component-and-logged-input', source: 'https://logging.apache.org/security.html',
        note: 'Java only establishes a hypothesis; check affected component, conditions and input. Callback does not prove execution.' }]
      : [],
    candidates: results,
    relatedCandidateCount: scopedCandidates.length,
    deferredCandidateIds: scopedCandidates.slice(policy.maxCandidates).map(row => row.entry.id),
    reconGaps: observedAssets.map(asset => ({ assetId: asset.id,
      productState: selectReconCandidates(candidates.map(row => row.entry), asset).length ? 'candidate' : 'unknown',
      componentState: 'unassessed', nextAction: 'check-observed-products-components-and-valid-inputs' })),
    verificationQueue,
    queries,
    rejectedHints: searchPlan.rejectedHints ?? [],
    subagentPlan: {
      concurrency: policy.concurrency,
      strategy: 'single-agent-batched-tools',
      workers: [],
      delegateWhen: 'Independent evidence-intensive branches exceed the shared queue; never one worker per CVE or URL by default.',
    },
  }
}

export function renderPriorityPlan(plan) {
  const currentYear = String(plan.generatedAt || new Date().toISOString()).slice(0, 4)
  const exampleQuery = String(plan.guidance.sourceRadar.discoveryQueries[0].query).replace(/\{year\}/g, currentYear)
  const sourceSummary = sourceRegistrySummary(plan.guidance.sourceRadar.sources)
  const lines = [
    `# Nday 优先级计划（${plan.candidates.length} 候选 / ${plan.queries.length} 条 FOFA 查询）`,
    '',
    `策略：近 ${plan.policy.recentDays} 天按实际披露/已核实新利用日期加权；未知日期不称近期；国产/信创 +${plan.policy.domesticBoost}；工具并发上限 ${plan.policy.concurrency}`,
    `外层任务：${plan.task.mode}；停止条件：${plan.task.stop}；常规/研究复用 Nday 时保持外层任务策略。`,
    '',
  ]
  plan.candidates.forEach((item, index) => {
    lines.push(`## ${index + 1}. ${item.product || item.id}  \`${item.id}\``)
    lines.push(`- 分数 ${item.score}；年份 ${item.year || '未知'}；来源 ${item.ids?.cve || item.ids?.cnvd || item.ids?.qvd || '未标注'}`)
    lines.push(`- 理由：${item.reasons.join('；')}`)
    lines.push(`- 下一步：${item.nextAction}；组件/版本未知需要有限补证，不按不适用处理。`)
    lines.push(`- FOFA：${item.queries.map((query) => `\`${query.query}\``).join('；') || '无可靠查询，先人工补语料'}`)
    lines.push(`- 验证：${item.verification.stages.map((stage) => stage.stage).join(' → ')}`)
    lines.push(`- EXP 来源：${item.verification.exp.preferredSources.join(' / ')}；检索式：${item.verification.exp.searchQueries[0]}`)
  })
  if (plan.rejectedHints?.length) lines.push(`无效指纹 ${plan.rejectedHints.length} 条；已拒绝且不自动扩宽，需要修订。`)
  if (plan.deferredCandidateIds?.length) lines.push(`相关候选另有 ${plan.deferredCandidateIds.length} 条未展示；没有删除，下一批用 entryIds 读取。`)
  if (plan.reconGaps?.length) lines.push(`资产画像：产品未知 ${plan.reconGaps.filter(row => row.productState === 'unknown').length} 个；组件未核对 ${plan.reconGaps.length} 个；没有相关候选时先补证或观察真实输入，不回退全库。`)
  if (plan.verificationQueue?.items.length) {
    lines.push('', '## 资产与入口验证队列')
    for (const item of plan.verificationQueue.items) lines.push(`- ${item.assetId}／${item.entryId}／${item.endpoint}：${item.state}；${item.action}；补证剩余 ${item.supplement.remaining}；依据 ${item.reason}`)
  }
  lines.push('', '## 指导原则（模型自行按目标证据调整）')
  lines.push(`- 排序维度：${plan.guidance.rankingDimensions.map((item) => item.id).join(' / ')}`)
  lines.push(`- 情报来源：${plan.guidance.sourcePlaybook.map((item) => item.source).join(' / ')}`)
  lines.push(`- 收集雷达：${plan.guidance.sourceRadar.policy}`)
  lines.push(`- 源接入状态：已接入 API ${sourceSummary.implemented} 个；Git文件来源 ${sourceSummary.git} 个；脚本 ${sourceSummary.script} 个；宿主搜索 ${sourceSummary.hostSearch} 个；计划接入 ${sourceSummary.plannedApi} 个；仅指引 ${sourceSummary.guidance} 个。`)
  lines.push('- 自动采集：CISA KEV / NVD / OSV / GitHub Advisories / nuclei-templates 更新 / 公众号（配置检索词后）可定时运行；所有结果仍是候选，需回源验证。')
  lines.push('- 注意：奇安信 CERT / CNVD / CNNVD 当前未接入自动抓取 API；公众号使用搜狗 search-assisted 适配器，仍属需交叉验证的候选来源。')
  lines.push(`- 不知道产品时：${plan.guidance.sourceRadar.workflow[0]} 示例：\`${exampleQuery}\``)
  lines.push(`- FOFA 分层：${plan.guidance.fofaTiers.map((item) => item.tier).join(' → ')}`)
  lines.push(`- 验证梯：${plan.guidance.verificationLadder.join(' → ')}`)
  if (plan.componentHypotheses?.length) lines.push('', '组件补漏：', ...plan.componentHypotheses.map(item => `- ${item.component}：${item.state}；${item.nextAction}；${item.note}`))
  lines.push('', `执行：${plan.subagentPlan.strategy}；批量工具并发 ${plan.subagentPlan.concurrency}；按证据需要拆分独立分支。`)
  return lines.join('\n') + '\n'
}
