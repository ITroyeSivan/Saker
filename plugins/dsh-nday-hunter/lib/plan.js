// Pure attack-plan builder: asset inventory + Nday catalog -> reusable buckets.
//
// The plan is deliberately deterministic. It orders work by expected reuse, but
// does not execute anything and does not upgrade an entry's verification status.

const HIGH_IMPACT = /rce|code exec|command exec|deserial|file upload|upload|ssti|expression|反序列化|命令执行|代码执行|文件上传|表达式注入|rce/i
const MEDIUM_IMPACT = /auth|admin|unauth|unauthorized|session|idor|ssrf|越权|未授权|认证|管理员|会话|ssrf/i
const LOW_COST = /strong/

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max)
}

function termsFor(entry) {
  const raw = [
    ...(Array.isArray(entry?.aliases) ? entry.aliases : []),
    entry?.product,
    entry?.vendor,
  ]
  const out = []
  for (const value of raw) {
    const text = clean(value, 160).toLowerCase()
    if (!text) continue
    if (text.length >= 3) out.push(text)
    for (const part of text.split(/[\s/|,()[\]{}:_-]+/)) {
      if (part.length >= 3) out.push(part)
    }
  }
  return [...new Set(out)]
}

function haystack(asset) {
  return [
    asset?.target,
    asset?.host,
    asset?.title,
    asset?.server,
    ...(Array.isArray(asset?.tech) ? asset.tech : []),
    ...(Array.isArray(asset?.tags) ? asset.tags : []),
  ].map((value) => clean(value, 300).toLowerCase()).filter(Boolean).join(' ')
}

export function exploitabilityWeight(entry) {
  const text = `${entry?.vulnClass || ''} ${entry?.impact || ''} ${entry?.severity || ''}`
  if (HIGH_IMPACT.test(text)) return 3
  if (MEDIUM_IMPACT.test(text)) return 2
  return 1
}

export function verificationCost(entry) {
  const probes = Array.isArray(entry?.fingerprint?.probes) ? entry.fingerprint.probes : []
  let cost = 3
  if (probes.some((probe) => LOW_COST.test(String(probe?.weight || '')))) cost = 1
  else if (probes.some((probe) => String(probe?.weight || '') === 'medium')) cost = 2
  if ((entry?.verify?.oob || []).includes('dnslog')) cost += 1
  if (entry?.auth && entry.auth !== 'none') cost += 1
  return cost
}

export function buildAttackPlan(entries, assets, options = {}) {
  const minAssets = Math.max(1, Number(options.minAssets) || 1)
  const maxBuckets = Math.max(1, Math.min(Number(options.maxBuckets) || 50, 200))
  const list = Array.isArray(assets) ? assets : []
  const buckets = []
  const clues = []

  for (const entry of Array.isArray(entries) ? entries : []) {
    const terms = termsFor(entry)
    if (terms.length === 0) continue
    const matched = list.filter((asset) => {
      const text = haystack(asset)
      return terms.some((term) => text.includes(term))
    })
    if (matched.length < minAssets) continue
    const siftable = Array.isArray(entry?.fingerprint?.probes) && entry.fingerprint.probes.length > 0
    if (!siftable) {
      clues.push({
        entryId: entry.id,
        product: entry.product,
        status: entry.status,
        assetIds: matched.map((asset) => asset.id),
        reason: 'no machine-checkable probes',
      })
      continue
    }
    const exploit = exploitabilityWeight(entry)
    const cost = verificationCost(entry)
    buckets.push({
      bucketId: `bucket-${entry.id}`,
      entryId: entry.id,
      product: entry.product,
      vendor: entry.vendor,
      vulnClass: entry.vulnClass,
      entryStatus: entry.status,
      fingerprint: terms,
      assetIds: matched.map((asset) => asset.id),
      representativeAssetId: matched[0]?.id || '',
      assets: matched.map((asset) => asset.target || asset.host).filter(Boolean),
      reuseScore: Number(((matched.length * exploit) / cost).toFixed(2)),
      exploitability: exploit,
      verificationCost: cost,
      status: 'queued',
      owner: `subagent-nday-${entry.id}`,
    })
  }

  buckets.sort((a, b) => b.reuseScore - a.reuseScore || b.assetIds.length - a.assetIds.length || a.entryId.localeCompare(b.entryId))
  return {
    schema: 'saker.attack-plan/1',
    generatedAt: new Date().toISOString(),
    totalAssets: list.length,
    buckets: buckets.slice(0, maxBuckets),
    clues,
  }
}

export function renderAttackPlan(plan) {
  const lines = [
    '# 优先攻击清单（按可复用程度排序）',
    '',
    `> 资产 ${plan.totalAssets} 条 · 可打的资产组 ${plan.buckets.length} 个 · 线索 ${plan.clues.length} 条`,
    '',
    '> 优先分 = 覆盖资产数 × 漏洞危害 ÷ 验证成本。分数只用于排序，不是漏洞结论。',
    '',
    '| 排名 | 资产组 | 产品 | 代表资产 | 资产数 | 优先分 | 状态 | 覆盖资产 |',
    '|---:|---|---|---|---:|---:|---|---|',
  ]
  plan.buckets.forEach((bucket, index) => {
    lines.push(`| ${index + 1} | \`${bucket.bucketId}\` | ${bucket.product || bucket.entryId} | \`${bucket.representativeAssetId || '-'}\` | ${bucket.assetIds.length} | ${bucket.reuseScore} | ${bucket.status} | ${(bucket.assets || []).join(', ')} |`)
  })
  lines.push('', '## 执行纪律', '', '- 每组先拿一个资产验证；成功后再铺开同组全部资产。', '- 第一个资产被证伪时写清证据，再转下一组。', '- 本计划不投放任何利用载荷。')
  if (plan.clues.length > 0) {
    lines.push('', '## 只有线索、不能机器筛选', '')
    for (const clue of plan.clues) {
      lines.push(`- \`${clue.entryId}\`（${clue.product || '-'}）：覆盖 ${clue.assetIds.length} 个资产；${clue.reason}`)
    }
  }
  return lines.join('\n') + '\n'
}
