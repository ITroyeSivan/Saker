#!/usr/bin/env node
import { migrateRedteamReport, validateRedteamReport } from './redteam-report-schema.mjs'

let pass = 0
let fail = 0
const ok = (label, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`ok   ${label}`)
  } else {
    fail += 1
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const current = { schema: 'saker.redteam.report.v1', schemaVersion: 1, mode: 'pentest', meta: {}, stats: {}, findings: [] }
const legacy = { mode: 'pentest', meta: {}, stats: {}, findings: [] }
ok('current v1 report validates', validateRedteamReport(current).ok)
ok('legacy v1 report migrates', migrateRedteamReport(legacy).schemaVersion === 1 && migrateRedteamReport(legacy).schema === 'saker.redteam.report.v1')
ok('unknown schema is rejected', validateRedteamReport({ ...current, schema: 'saker.redteam.report.v2' }).ok === false)
ok('malformed findings is rejected', validateRedteamReport({ ...current, findings: {} }).ok === false)
const advisory = validateRedteamReport({
  ...current,
  findings: [
    { id: 'f1', status: 'verified', severity: 'high', evidenceLevel: 'confirmed' },
    { id: 'f2', status: 'fixed', retestNote: '' },
    { id: 'f3', baseline: 'same', diffEvidence: 'same' },
  ],
})
ok('advisory warnings do not reject the report', advisory.ok === true)
ok('verified 缺复核依据/二次评级会告警',
  advisory.warnings.some((x) => x.includes('f1') && x.includes('verifyNote'))
  && advisory.warnings.some((x) => x.includes('f1') && x.includes('secondRating')))
ok('fixed 缺复测记录会告警', advisory.warnings.some((x) => x.includes('f2') && x.includes('retestNote')))
ok('confirmed 缺 evidence 会告警', advisory.warnings.some((x) => x.includes('f1') && x.includes('evidence')))
ok('基线与差分相同会告警', advisory.warnings.some((x) => x.includes('f3') && x.includes('差分')))

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`)
process.exit(fail ? 1 : 0)
