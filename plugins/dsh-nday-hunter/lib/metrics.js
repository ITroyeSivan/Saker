// Small, local metrics ledger for Nday work.
//
// We record facts, not scores: how many candidates were returned, how many API
// requests were spent, how many screened assets produced leads, and feedback
// feedback reports remain observations. Outcomes come from the current reviewed
// result store; unavailable records and unsupported rates remain unknown.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDshHome } from './home.js'

let outcomeSummary, attachDeliveryEvidence
try { ({ outcomeSummary, attachDeliveryEvidence } = await import('@dsh-external/dsh-redteam-results/delivery')) } catch { /* optional result plugin */ }

export function readOutcomeMetrics(home = resolveDshHome(), sessionId = '') {
  const unavailable = reason => ({ available: false, reason, confirmedFindings: null, confirmedRce: null,
    reproducedFindings: null, reproducibleDeliveryRate: null, incompleteRecords: null, outcomes: [] })
  if (!outcomeSummary) return unavailable('result-plugin-unavailable')
  if (!attachDeliveryEvidence) return unavailable('result-plugin-needs-execution-evidence-support')
  const file = path.join(home, 'redteam-results', 'results.db')
  if (!fs.existsSync(file)) return unavailable('result-store-missing')
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const columns = new Set(db.prepare('PRAGMA table_info(findings)').all().map(row => row.name))
    if (!columns.has('reproduction') || !columns.has('proof_kind')) return unavailable('result-store-needs-migration')
    const sql = `SELECT *, session_id AS sessionId, evidence_level AS evidenceLevel, proof_kind AS proofKind,
      request_pkt AS requestPkt, response_pkt AS responsePkt, second_rating AS secondRating,
      second_rating_note AS secondRatingNote FROM findings WHERE mode='pentest'${sessionId ? ' AND session_id=?' : ''}`
    const findings = sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()
    return { available: true, reason: '', ...outcomeSummary(findings.map(finding => attachDeliveryEvidence({ db }, finding.sessionId, finding))) }
  } catch (error) { return unavailable('result-store-unreadable: ' + String(error.message).slice(0, 150)) }
  finally { db?.close() }
}

export const METRICS_SCHEMA = 'saker.nday.metrics/1'
const MAX_EVENTS = 1000

function metricsFile(home = resolveDshHome()) {
  return path.join(home, 'nday-hunter', 'metrics.json')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function asNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback
}

export function readMetrics(home = resolveDshHome()) {
  const value = readJson(metricsFile(home), {})
  return {
    schema: METRICS_SCHEMA,
    events: Array.isArray(value.events) ? value.events : [],
  }
}

export function appendMetric(event, home = resolveDshHome()) {
  const state = readMetrics(home)
  const row = {
    schema: METRICS_SCHEMA,
    at: new Date().toISOString(),
    kind: clean(event?.kind, 60) || 'unknown',
    runId: clean(event?.runId, 160),
    sessionId: clean(event?.sessionId, 160),
    findingId: clean(event?.findingId, 160),
    source: clean(event?.source, 60),
    candidateCount: asNumber(event?.candidateCount),
    apiRequests: asNumber(event?.apiRequests),
    queryCount: asNumber(event?.queryCount),
    successfulGroups: asNumber(event?.successfulGroups),
    assetCount: asNumber(event?.assetCount),
    hitCount: asNumber(event?.hitCount),
    falsePositiveCount: asNumber(event?.falsePositiveCount),
    confirmedCount: asNumber(event?.confirmedCount),
    startedAt: event?.startedAt ? clean(event.startedAt, 80) : '',
    finishedAt: event?.finishedAt ? clean(event.finishedAt, 80) : '',
    note: clean(event?.note, 500),
  }
  state.events = [...state.events, row].slice(-MAX_EVENTS)
  writeJson(metricsFile(home), state)
  return row
}

export function summarizeMetrics(home = resolveDshHome(), { sessionId = '' } = {}) {
  const { events } = readMetrics(home)
  const searches = events.filter((event) => event.kind === 'scope-hunt')
  const matches = events.filter((event) => event.kind === 'match')
  const feedback = events.filter((event) => event.kind === 'false-positive' || event.kind === 'confirmed-rce')
  const totalHits = matches.reduce((sum, event) => sum + event.hitCount, 0)
  const falsePositives = feedback
    .filter((event) => event.kind === 'false-positive')
    .reduce((sum, event) => sum + event.falsePositiveCount, 0)
  const firstRoundHits = matches.filter((event) => event.hitCount > 0).length
  const outcome = readOutcomeMetrics(home, sessionId)
  const resultIds = new Set(outcome.outcomes.filter(item => item.state.rce)
    .map(item => JSON.stringify([item.finding.sessionId, item.finding.id])))
  const rceEvents = feedback.filter(event => event.kind === 'confirmed-rce'
    && resultIds.has(JSON.stringify([event.sessionId, event.findingId])))
    .sort((a, b) => Date.parse(a.finishedAt || a.at) - Date.parse(b.finishedAt || b.at))
  const measuredRuns = new Set()
  const rceDurations = rceEvents.map((event) => {
    if (measuredRuns.has(event.runId)) return null
    const search = searches.find((row) => event.runId !== '' && row.runId === event.runId)
    if (!search) return null
    const start = Date.parse(search.startedAt || search.at), end = Date.parse(event.finishedAt || event.at)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
    measuredRuns.add(event.runId)
    return end - start
  }).filter((value) => value !== null)
  return {
    schema: METRICS_SCHEMA,
    events: events.length,
    searches: searches.length,
    matches: matches.length,
    candidates: searches.reduce((sum, event) => sum + event.candidateCount, 0),
    apiRequests: searches.reduce((sum, event) => sum + event.apiRequests, 0),
    queryGroups: searches.reduce((sum, event) => sum + event.queryCount, 0),
    successfulGroups: searches.reduce((sum, event) => sum + event.successfulGroups, 0),
    screenedAssets: matches.reduce((sum, event) => sum + event.assetCount, 0),
    leads: totalHits,
    firstRoundHitRate: matches.length === 0 ? null : firstRoundHits / matches.length,
    falsePositives: null,
    falsePositiveFeedbackCount: falsePositives,
    fingerprintFalsePositiveRate: null,
    fingerprintRateReason: 'unique-screening-and-review-records-required',
    outcomeSource: { available: outcome.available, reason: outcome.reason, scope: sessionId || 'all-sessions' },
    confirmedFindings: outcome.confirmedFindings,
    confirmedRce: outcome.confirmedRce,
    reproducedFindings: outcome.reproducedFindings,
    reproducibleDeliveryRate: outcome.reproducibleDeliveryRate,
    incompleteResultRecords: outcome.incompleteRecords,
    rceFeedbackReports: feedback.filter(event => event.kind === 'confirmed-rce').length,
    averageQueryToRceMs: rceDurations.length === 0
      ? null
      : Math.round(rceDurations.reduce((sum, value) => sum + value, 0) / rceDurations.length),
    recent: events.slice(-30).reverse(),
  }
}

export function recordSearchMetric({ runId, source = '', candidateCount, apiRequests, queryCount, successfulGroups, startedAt, finishedAt, home }) {
  return appendMetric({
    kind: 'scope-hunt',
    runId,
    source,
    candidateCount,
    apiRequests,
    queryCount,
    successfulGroups,
    startedAt,
    finishedAt,
  }, home)
}

export function recordMatchMetric({ runId, assetCount, hitCount, startedAt, finishedAt, home }) {
  return appendMetric({
    kind: 'match',
    runId,
    assetCount,
    hitCount,
    startedAt,
    finishedAt,
  }, home)
}

export function recordFeedbackMetric({ kind, runId = '', sessionId = '', findingId = '', count = 1, note = '', finishedAt = new Date().toISOString(), home }) {
  if (!['confirmed-rce', 'false-positive'].includes(kind)) throw new Error('invalid feedback kind')
  const normalized = kind === 'confirmed-rce' ? 'confirmed-rce' : 'false-positive'
  return appendMetric({
    kind: normalized,
    runId,
    sessionId,
    findingId,
    falsePositiveCount: normalized === 'false-positive' ? count : 0,
    confirmedCount: normalized === 'confirmed-rce' ? count : 0,
    finishedAt,
    note,
  }, home)
}
