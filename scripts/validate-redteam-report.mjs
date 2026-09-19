#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateRedteamReport } from './redteam-report-schema.mjs'

if (!process.argv[2]) {
  console.error('usage: node scripts/validate-redteam-report.mjs <report.json>')
  process.exit(2)
}
const file = resolve(process.argv[2])
try {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const result = validateRedteamReport(parsed)
  if (!result.ok) {
    console.error(`FAIL ${file}: ${result.error}`)
    process.exit(1)
  }
  console.log(`ok   ${file} schema=${result.value.schema} version=${result.value.schemaVersion} migrated=${result.migrated} warnings=${result.warnings.length}`)
  for (const warning of result.warnings) console.log(`warn ${warning}`)
} catch (error) {
  console.error(`FAIL ${file}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
