// Pure attack-plan builder: asset inventory + Nday catalog -> reusable buckets.
//
// The plan is deliberately deterministic. It orders work by expected reuse, but
// does not execute anything and does not upgrade an entry's verification status.
import { groupServices } from './service-groups.js';
import { createHash } from 'node:crypto';
import { selectReconCandidates, productTerms } from './recon-candidates.js';

const HIGH_IMPACT = /rce|code exec|command exec|deserial|file upload|upload|ssti|expression|反序列化|命令执行|代码执行|文件上传|表达式注入|rce/i
const MEDIUM_IMPACT = /auth|admin|unauth|unauthorized|session|idor|ssrf|越权|未授权|认证|管理员|会话|ssrf/i
const LOW_COST = /strong/

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
    const terms = productTerms(entry)
    if (terms.length === 0) continue
    const matched = list.filter((asset) => {
      return selectReconCandidates([entry], asset).length > 0
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
    const services = groupServices(matched)
    for (const service of services) buckets.push({
      bucketId: `bucket-${entry.id}${services.length > 1 ? '-' + service.id : ''}`,
      serviceSignature: createHash('sha256').update(JSON.stringify([service.signature, entry.id, entry.version, entry.updatedAt, entry.auth, entry.fingerprint, entry.conditions])).digest('hex'),
      identityConfirmed: service.identityConfirmed,
      groupingEvidenceIds: service.evidenceIds,
      independentChecks: service.independentChecks,
      entryId: entry.id,
      product: entry.product,
      vendor: entry.vendor,
      vulnClass: entry.vulnClass,
      entryStatus: entry.status,
      fingerprint: terms,
      assetIds: service.assets.map((asset) => asset.id),
      representativeAssetId: service.representativeAssetId,
      assets: service.assets.map((asset) => asset.target || asset.host).filter(Boolean),
      reuseScore: Number(((service.assets.length * exploit) / cost).toFixed(2)),
      exploitability: exploit,
      verificationCost: cost,
      status: 'queued',
      owner: 'main',
    })
  }

  buckets.sort((a, b) => b.reuseScore - a.reuseScore || b.assetIds.length - a.assetIds.length || a.entryId.localeCompare(b.entryId))
  return {
    schema: 'saker.attack-plan/2',
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
  lines.push('', '## 执行纪律', '', '- 每个独立应用先校准代表入口；共享IP、标题和产品不证明同一应用。', '- 同组只共享已确认部署和方法资料；每个入口独立核对当前身份、有效请求、适用条件和实际影响。', '- 代表入口证伪不推导其他独立应用安全。', '- 按redteam_task的当前停止规则工作；本计划不执行请求。')
  if (plan.clues.length > 0) {
    lines.push('', '## 只有线索、不能机器筛选', '')
    for (const clue of plan.clues) {
      lines.push(`- \`${clue.entryId}\`（${clue.product || '-'}）：覆盖 ${clue.assetIds.length} 个资产；${clue.reason}`)
    }
  }
  return lines.join('\n') + '\n'
}
