// Shared result semantics: a feedback count or a callback is not an outcome.
import { createHash } from 'node:crypto';
export { attachDeliveryEvidence } from './delivery-evidence.js';
export const PROOF_KINDS = ['fingerprint', 'interaction', 'execution', 'access', 'write', 'other-impact']
const text = value => typeof value === 'string' && value.trim().length > 0
const strings = value => Array.isArray(value) && value.every(text)
const GAP_LABELS = {
  'result-not-verified': '成果尚未复核', 'impact-evidence-missing': '影响证据不足',
  'independent-review-missing': '缺独立复核', 'impact-or-evidence-reference-missing': '缺影响或证据引用',
  'impact-proof-kind-missing': '尚无影响证明', 'complete-reproduction-missing': '缺完整复现方法',
  'request-response-evidence-missing': '缺关键请求或响应',
  'reproduction-not-executed': '复现方法尚未实测',
  'request-response-evidence-invalid': '关键HTTP报文无效或不属于复现入口',
  'host-execution-evidence-missing': '缺当前宿主执行对照与回执',
  'independent-impact-verification-missing': '缺独立影响验证',
}

export function deliveryMaterialDigest(finding) {
  return createHash('sha256').update(JSON.stringify([finding.sessionId, finding.identity, finding.proofKind,
    finding.reproduction, finding.requestPkt, finding.responsePkt, finding.impact, finding.evidence])).digest('hex')
}

export function parseReproduction(value) {
  const method = typeof value === 'string' ? JSON.parse(value) : value
  if (!method || typeof method !== 'object' || Array.isArray(method)) throw new Error('reproduction must be a method object')
  for (const key of ['mechanism', 'methodVersion', 'endpoint', 'successCriterion', 'reviewSteps', 'recovery']) {
    if (!text(method[key])) throw new Error(`reproduction.${key} is required as a nonempty string, not an array; prerequisites/dependencies/parameters/steps are string arrays`)
  }
  const url = new URL(method.endpoint)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('reproduction endpoint must be HTTP(S) without embedded credentials')
  if (method.hostHeader !== undefined) {
    if (!text(method.hostHeader) || /[\s/?#@]/.test(method.hostHeader)) throw new Error('invalid reproduction Host header')
    const host = new URL('http://' + method.hostHeader)
    if (!host.hostname || host.pathname !== '/') throw new Error('invalid reproduction Host header')
  }
  for (const key of ['prerequisites', 'dependencies', 'parameters']) {
    if (!strings(method[key])) throw new Error(`reproduction.${key} must be an array of strings (empty when none)`)
  }
  if (method.kind === 'script') {
    if (!text(method.code) || !text(method.language) || !text(method.runCommand)) throw new Error('script requires code, language and runCommand')
  } else if (method.kind === 'method') {
    if (!strings(method.steps) || !method.steps.length || method.steps.every(step => /^https?:\/\/\S+$/.test(step))) throw new Error('method requires actionable steps, not just links')
  } else throw new Error('reproduction.kind must be script or method')
  if (!['verified', 'not-run'].includes(method.verification?.status)) throw new Error('reproduction verification status must be verified or not-run')
  if (!strings(method.verification.evidenceIds)) throw new Error('reproduction verification requires evidenceIds array')
  for (const field of ['controlReceiptId', 'probeReceiptId']) {
    if (method.verification[field] !== undefined && (!text(method.verification[field]) || !/^execution-[a-f0-9-]{36}$/.test(method.verification[field]))) throw new Error('invalid reproduction ' + field)
  }
  if (method.verification.effectReceiptId !== undefined && (typeof method.verification.effectReceiptId !== 'string' || !/^effect-[a-f0-9-]{36}$/.test(method.verification.effectReceiptId))) throw new Error('invalid reproduction effectReceiptId')
  if (method.verification.status === 'verified' && !method.verification.evidenceIds.length) throw new Error('verified reproduction requires evidence references')
  url.hash = ''
  return { ...method, endpoint: url.href }
}

export function normalizeReproduction(value) {
  if (value === undefined || value === '') return ''
  const result = JSON.stringify(parseReproduction(value))
  if (result.length > 20000) throw new Error('reproduction exceeds 20000 characters; attach a smaller complete method')
  return result
}

export function findingDeliveryState(finding) {
  const gaps = []
  const hostEvidence = finding.executionEvidence
  const executionVerified = hostEvidence?.verified === true && hostEvidence.binding === deliveryMaterialDigest(finding)
  if (!executionVerified) gaps.push('host-execution-evidence-missing')
  // Material readiness cannot assert a vulnerability from an HTTP exchange.
  // Only a host effect verifier may supply the independent impact verdict.
  if (!executionVerified || hostEvidence.impactVerified !== true) gaps.push('independent-impact-verification-missing')
  if (finding.status !== 'verified') gaps.push('result-not-verified')
  if (!['impact', 'confirmed'].includes(finding.evidenceLevel)) gaps.push('impact-evidence-missing')
  if (!['critical', 'high', 'medium', 'low'].includes(finding.secondRating) || !text(finding.secondRatingNote) || finding.secondRatingNote.length < 40) gaps.push('independent-review-missing')
  if (!text(finding.impact) || !text(finding.evidence)) gaps.push('impact-or-evidence-reference-missing')
  if (!PROOF_KINDS.includes(finding.proofKind) || ['fingerprint', 'interaction'].includes(finding.proofKind)) gaps.push('impact-proof-kind-missing')
  let method = null
  try { method = parseReproduction(finding.reproduction) } catch { gaps.push('complete-reproduction-missing') }
  if (method && method.verification.status !== 'verified') gaps.push('reproduction-not-executed')
  if (method && (!text(finding.requestPkt) || !text(finding.responsePkt))) gaps.push('request-response-evidence-missing')
  else if (method) {
    const request = finding.requestPkt.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/\S+(?:\r?\n|$)/i)
    const response = /^HTTP\/\S+\s+[1-5]\d{2}\b/.test(finding.responsePkt)
    let bound = false
    try {
      const endpoint = new URL(method.endpoint), target = request && new URL(request[2], endpoint)
      const host = finding.requestPkt.match(/^Host:\s*([^\r\n]+)/im)?.[1]?.trim()
      bound = !!target && target.origin === endpoint.origin && target.pathname === endpoint.pathname
        && (!host || host.toLowerCase() === String(method.hostHeader || endpoint.host).toLowerCase())
    } catch { /* Invalid request targets stay incomplete. */ }
    if (!request || !response || !bound) gaps.push('request-response-evidence-invalid')
  }
  return { ready: gaps.length === 0, gaps, missing: gaps.map(gap => GAP_LABELS[gap]), method,
    executionVerified,
    reproductionVerified: method?.verification.status === 'verified',
    rce: gaps.length === 0 && finding.proofKind === 'execution' }
}

export function outcomeSummary(findings = []) {
  const unique = new Map()
  let incomplete = 0
  for (const finding of findings) {
    if (finding.mode !== 'pentest') continue
    const state = findingDeliveryState(finding)
    if (!state.ready) { incomplete++; continue }
    const key = JSON.stringify([finding.sessionId, state.method.endpoint, state.method.mechanism])
    const prior = unique.get(key)
    // Preserve the strongest reviewed proof for a duplicate mechanism/entry.
    if (!prior || (state.rce && !prior.state.rce) || (state.rce === prior.state.rce && state.reproductionVerified && !prior.state.reproductionVerified)) unique.set(key, { finding, state })
  }
  const outcomes = [...unique.values()]
  return { confirmedFindings: outcomes.length, confirmedRce: outcomes.filter(item => item.state.rce).length,
    reproducedFindings: outcomes.filter(item => item.state.reproductionVerified).length,
    reproducibleDeliveryRate: outcomes.length ? outcomes.filter(item => item.state.reproductionVerified).length / outcomes.length : null,
    incompleteRecords: incomplete, outcomes }
}

export function renderReproduction(method) {
  const fence = '`'.repeat(Math.max(3, ...[...String(method.code || '').matchAll(/`+/g)].map(match => match[0].length + 1)))
  return [`入口：${method.endpoint}`, `机制：${method.mechanism}；方法版本：${method.methodVersion}`,
    '利用前提：', ...(method.prerequisites.length ? method.prerequisites.map(value => '- ' + value) : ['- 无额外前提']),
    '依赖：', ...(method.dependencies.length ? method.dependencies.map(value => '- ' + value) : ['- 无额外依赖']),
    '参数与认证输入：', ...(method.parameters.length ? method.parameters.map(value => '- ' + value) : ['- 无额外参数']),
    ...(method.kind === 'script' ? ['运行：' + method.runCommand, fence + method.language, method.code, fence]
      : method.steps.map((step, i) => `${i + 1}. ${step}`)),
    '成功判据：' + method.successCriterion, '复核：' + method.reviewSteps,
    '恢复：' + method.recovery,
    '复现状态：' + (method.verification.status === 'verified' ? '已实测' : '尚未运行生成的方法或脚本'),
    '复现证据：' + (method.verification.evidenceIds.join('、') || '无'), ''].join('\n')
}

export function renderFindingDelivery(finding) {
  const state = findingDeliveryState(finding)
  if (!state.ready) throw new Error('finding delivery incomplete: ' + state.gaps.join(', '))
  return [`# ${finding.title}`, `目标：${finding.target}`, `类型：${finding.type}；证据类型：${finding.proofKind}`,
    '已证实影响：' + finding.impact, '', renderReproduction(state.method),
    '关键请求：', finding.requestPkt || '见证据引用', '关键响应：', finding.responsePkt || '见证据引用',
    '证据引用：' + finding.evidence, '独立复核：' + finding.secondRatingNote, ''].join('\n')
}
