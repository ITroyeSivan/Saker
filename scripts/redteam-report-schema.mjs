#!/usr/bin/env node
// Versioned validation/migration for Saker red-team JSON reports.
export const REDTEAM_REPORT_SCHEMA = 'saker.redteam.report.v1'
export const REDTEAM_REPORT_SCHEMA_VERSION = 1

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Advisory consistency checks. These never reject a report: semantics still
 *  require a human/independent reviewer, but obvious contradictions should be
 *  surfaced before the report is treated as delivery-ready. */
export function collectReportWarnings(value) {
  const warnings = []
  const findings = Array.isArray(value?.findings) ? value.findings : []
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index]
    if (!isObject(finding)) continue
    const id = String(finding.id || `#${index + 1}`)
    const status = String(finding.status || '')
    const evidenceLevel = String(finding.evidenceLevel || '')
    const text = (key) => String(finding[key] ?? '').trim()
    if (status === 'verified' && !text('verifyNote')) warnings.push(`${id}: verified 但缺少 verifyNote（复核依据）`)
    if (status === 'verified' && !text('secondRating')) warnings.push(`${id}: verified 但缺少 secondRating（独立二次评级）`)
    if (status === 'fixed' && !text('retestNote')) warnings.push(`${id}: fixed 但缺少 retestNote（修复后复测记录）`)
    if (evidenceLevel === 'confirmed' && !text('evidence')) warnings.push(`${id}: confirmed 但缺少 evidence（证据引用）`)
    const baseline = text('baseline')
    const diff = text('diffEvidence')
    if (baseline && diff && baseline === diff) warnings.push(`${id}: baseline 与 diffEvidence 完全相同，疑似没有真实差分`)
  }
  return warnings.slice(0, 50)
}

/**
 * Normalize a current or legacy report into the current v1 envelope.
 * Unknown future schemas are rejected rather than silently misread.
 */
export function migrateRedteamReport(input) {
  if (!isObject(input)) throw new Error('report must be a JSON object')
  const schema = String(input.schema || '')
  if (schema && schema !== REDTEAM_REPORT_SCHEMA) throw new Error(`unsupported report schema: ${schema}`)
  const looksLegacy = !schema
    && typeof input.mode === 'string'
    && isObject(input.meta)
    && isObject(input.stats)
    && Array.isArray(input.findings)
  if (!schema && !looksLegacy) throw new Error('report is neither current schema nor a recognized legacy v1 report')
  const migrated = {
    ...input,
    schema: REDTEAM_REPORT_SCHEMA,
    schemaVersion: REDTEAM_REPORT_SCHEMA_VERSION,
  }
  if (!Array.isArray(migrated.findings)) throw new Error('report.findings must be an array')
  if (!isObject(migrated.meta)) throw new Error('report.meta must be an object')
  if (!isObject(migrated.stats)) throw new Error('report.stats must be an object')
  return migrated
}

export function validateRedteamReport(input) {
  try {
    const value = migrateRedteamReport(input)
    return {
      ok: true,
      value,
      migrated: input?.schemaVersion !== REDTEAM_REPORT_SCHEMA_VERSION || input?.schema !== REDTEAM_REPORT_SCHEMA,
      warnings: collectReportWarnings(value),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
