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
  'actual-evidence-reference-invalid': '引用的事实材料不存在或不属于当前会话',
  'judgment-source-invalid': '判定来源没有对应的宿主执行或用户确认',
  'reproduction-evidence-reference-invalid': '复现声明引用了不存在或不属于当前会话的材料',
  'host-execution-evidence-missing': '缺当前宿主执行对照与回执',
  'independent-impact-verification-missing': '缺独立影响验证',
  'actual-evidence-missing': '缺实际依据',
  'judgment-basis-missing': '缺判定依据',
}

export function deliveryMaterialDigest(finding) {
  return createHash('sha256').update(JSON.stringify([finding.sessionId, finding.identity, finding.proofKind,
    finding.reproduction, finding.requestPkt, finding.responsePkt, finding.impact, finding.evidence]
    .map(value => value ?? ''))).digest('hex')
}

export function parseReproduction(value) {
  // 空值/坏 JSON 要说人话：以前直接把 JSON.parse 的英文异常抛出去，
  // 发现详情里就显示 "Unexpected end of JSON input"，既看不懂也不是缺项清单该有的样子。
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    throw new Error('还没有完整复现方法：请先记录入口、成功标准、复核步骤与恢复方式')
  }
  let method
  try { method = typeof value === 'string' ? JSON.parse(value) : value }
  catch { throw new Error('复现方法不是有效 JSON：请重新保存入口、成功标准、复核步骤与恢复方式') }
  if (!method || typeof method !== 'object' || Array.isArray(method)) throw new Error('reproduction must be a method object')
  for (const key of ['mechanism', 'methodVersion', 'successCriterion', 'reviewSteps']) {
    if (!text(method[key])) throw new Error(`reproduction.${key} is required as a nonempty string, not an array; prerequisites/dependencies/parameters/steps are string arrays`)
  }
  if (method.endpoint !== undefined) {
    const url = new URL(method.endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('reproduction endpoint must be HTTP(S) without embedded credentials')
    url.hash = ''
    method.endpoint = url.href
  }
  if (method.hostHeader !== undefined) {
    if (!text(method.hostHeader) || /[\s/?#@]/.test(method.hostHeader)) throw new Error('invalid reproduction Host header')
    const host = new URL('http://' + method.hostHeader)
    if (!host.hostname || host.pathname !== '/') throw new Error('invalid reproduction Host header')
  }
  method.prerequisites ??= []
  method.dependencies ??= []
  method.parameters ??= []
  for (const key of ['prerequisites', 'dependencies', 'parameters']) {
    if (!strings(method[key])) throw new Error(`reproduction.${key} must be an array of strings (empty when none)`)
  }
  if (method.sideEffects === 'changes' && !text(method.recovery)) throw new Error('changing reproduction requires a recovery note')
  if (method.kind === 'script') {
    if (!text(method.code) || !text(method.language) || !text(method.runCommand)) throw new Error('script requires code, language and runCommand')
  } else if (method.kind === 'method') {
    if (!strings(method.steps) || !method.steps.length || method.steps.every(step => /^https?:\/\/\S+$/.test(step))) throw new Error('method requires actionable steps, not just links')
  } else if (method.kind === 'analysis') {
    if (!strings(method.steps) || !method.steps.length) throw new Error('analysis reproduction requires concrete steps or references')
  } else if (method.kind === 'file' || method.kind === 'command') {
    if (!text(method.command || method.code || method.file || method.steps?.join('\n'))) throw new Error(method.kind + ' reproduction requires an actual command, file or steps')
  } else throw new Error('reproduction.kind must be script, method, analysis, file or command')
  if (!['verified', 'not-run'].includes(method.verification?.status)) throw new Error('reproduction verification status must be verified or not-run')
  if (!strings(method.verification.evidenceIds)) throw new Error('reproduction verification requires evidenceIds array')
  for (const field of ['controlReceiptId', 'probeReceiptId']) {
    if (method.verification[field] !== undefined && (!text(method.verification[field]) || !/^execution-[a-f0-9-]{36}$/.test(method.verification[field]))) throw new Error('invalid reproduction ' + field)
  }
  if (method.verification.effectReceiptId !== undefined && (typeof method.verification.effectReceiptId !== 'string' || !/^effect-[a-f0-9-]{36}$/.test(method.verification.effectReceiptId))) throw new Error('invalid reproduction effectReceiptId')
  if (method.verification.status === 'verified' && !method.verification.evidenceIds.length) throw new Error('verified reproduction requires evidence references')
  if (method.judgment !== undefined) {
    if (!['host', 'user', 'model'].includes(method.judgment?.source) || !text(method.judgment?.basis))
      throw new Error('reproduction.judgment requires source=host|user|model and a concrete basis')
  }
  return method
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
  let method = null
  try { method = parseReproduction(finding.reproduction) } catch { gaps.push('complete-reproduction-missing') }
  const hostProofRequired = ['execution', 'access', 'write'].includes(finding.proofKind)
  const actualRefs = Array.isArray(finding.evidenceRefs) ? finding.evidenceRefs.filter(Boolean) : []
  const reproductionRefs = Array.isArray(method?.verification?.evidenceIds) ? method.verification.evidenceIds.filter(Boolean) : []
  const validation = finding.evidenceReferenceValidation
  const judgment = finding.judgmentValidation || validation
  const invalidActualRefs = validation?.missing?.length || 0
  const invalidReproductionRefs = validation?.reproductionMissing?.length || 0
  if (invalidActualRefs) gaps.push('actual-evidence-reference-invalid')
  if (invalidReproductionRefs) gaps.push('reproduction-evidence-reference-invalid')
  const factualEvidence = actualRefs.length > invalidActualRefs
    || reproductionRefs.length > invalidReproductionRefs
    || text(finding.requestPkt) || text(finding.responsePkt)
  if (hostProofRequired && !executionVerified) gaps.push('host-execution-evidence-missing')
  const judgmentSource = method?.judgment?.source || (hostEvidence?.impactVerified === true ? 'host' : '')
  if (judgment && judgmentSource === 'host' && !(judgment.host || hostEvidence?.impactVerified === true)) gaps.push('judgment-source-invalid')
  if (judgment && judgmentSource === 'user' && judgment.user !== true) gaps.push('judgment-source-invalid')
  if (hostProofRequired && (!executionVerified || hostEvidence.impactVerified !== true)) gaps.push('independent-impact-verification-missing')
  else if (!hostProofRequired) {
    if (!factualEvidence) gaps.push('actual-evidence-missing')
    if (!['model', 'user', 'host'].includes(judgmentSource) || !text(method?.judgment?.basis)) gaps.push('judgment-basis-missing')
  }
  if (finding.status !== 'verified') gaps.push('result-not-verified')
  if (!['impact', 'confirmed'].includes(finding.evidenceLevel)) gaps.push('impact-evidence-missing')
  const reviewClaimed = finding.secondRating !== undefined && finding.secondRating !== null
    && String(finding.secondRating).trim() !== '';
  const reviewComplete = ['critical', 'high', 'medium', 'low'].includes(finding.secondRating)
    && text(finding.secondRatingNote);
  if (reviewClaimed && !reviewComplete) gaps.push('independent-review-missing')
  if (!text(finding.impact) || !text(finding.evidence)) gaps.push('impact-or-evidence-reference-missing')
  if (!PROOF_KINDS.includes(finding.proofKind) || ['fingerprint', 'interaction'].includes(finding.proofKind)) gaps.push('impact-proof-kind-missing')
  if (method && method.verification.status !== 'verified') gaps.push('reproduction-not-executed')
  const httpMethod = method && (method.endpoint !== undefined || ['script', 'method'].includes(method.kind))
  if (httpMethod && (!text(finding.requestPkt) || !text(finding.responsePkt))) gaps.push('request-response-evidence-missing')
  else if (httpMethod) {
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
    judgmentSource,
    actualEvidence: factualEvidence,
    reproductionVerified: method?.verification.status === 'verified',
    independentReview: reviewComplete,
    reviewRecommended: !reviewComplete && (finding.severity === 'critical' || finding.severity === 'high'
      || finding.secondRating !== undefined || String(finding.type || '').toLowerCase().includes('权限')),
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
  return [...(method.endpoint ? [`入口：${method.endpoint}`] : []), `机制：${method.mechanism}；方法版本：${method.methodVersion}`,
    '利用前提：', ...(method.prerequisites.length ? method.prerequisites.map(value => '- ' + value) : ['- 无额外前提']),
    '依赖：', ...(method.dependencies.length ? method.dependencies.map(value => '- ' + value) : ['- 无额外依赖']),
    '参数与认证输入：', ...(method.parameters.length ? method.parameters.map(value => '- ' + value) : ['- 无额外参数']),
    ...(method.kind === 'script' ? ['运行：' + method.runCommand, fence + method.language, method.code, fence]
      : method.kind === 'file' || method.kind === 'command'
        ? ['复现材料：' + (method.file || method.command || method.code || '')]
        : method.steps.map((step, i) => `${i + 1}. ${step}`)),
    '成功判据：' + method.successCriterion, '复核：' + method.reviewSteps,
    ...(method.recovery ? ['恢复：' + method.recovery] : []),
    ...(method.judgment ? ['判定来源：' + method.judgment.source + '；依据：' + method.judgment.basis] : []),
    '复现状态：' + (method.verification.status === 'verified' ? '已实测' : '尚未运行生成的方法或脚本'),
    '复现证据：' + (method.verification.evidenceIds.join('、') || '无'), ''].join('\n')
}

export function renderFindingDelivery(finding) {
  const state = findingDeliveryState(finding)
  if (!state.ready) throw new Error('finding delivery incomplete: ' + state.gaps.join(', '))
  return [`# ${finding.title}`, `目标：${finding.target}`, `类型：${finding.type}；证据类型：${finding.proofKind}`,
    '已证实影响：' + finding.impact, '', renderReproduction(state.method),
    '关键请求：', finding.requestPkt || '见证据引用', '关键响应：', finding.responsePkt || '见证据引用',
    '证据引用：' + finding.evidence,
    ...(state.independentReview ? ['独立复核：' + finding.secondRatingNote] : []), ''].join('\n')
}
