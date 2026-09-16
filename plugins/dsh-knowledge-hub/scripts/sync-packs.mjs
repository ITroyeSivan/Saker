#!/usr/bin/env node
// Synchronize the curated sparse knowledge packs into DSH_HOME.
//
// Usage:
//   node scripts/sync-packs.mjs
//   node scripts/sync-packs.mjs --all
//   node scripts/sync-packs.mjs --only ctf-skills,owasp-wstg
//   node scripts/sync-packs.mjs --status

import { packsStatus, syncPacks } from '../lib/packs.js'

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] || '' : ''
}

if (process.argv.includes('--status')) {
  console.log(JSON.stringify(packsStatus(), null, 2))
  process.exit(0)
}

const only = argValue('--only')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

const result = await syncPacks({
  ids: only,
  force: process.argv.includes('--all') || process.argv.includes('--force') || only.length > 0,
  concurrency: 3,
})

for (const item of result.results) {
  const label = item.ok ? 'OK  ' : 'FAIL'
  console.log(`${label} ${item.id.padEnd(34)} ${item.commit || item.error || ''}`)
}
console.log(`\nsync requested=${result.requested} ok=${result.ok} fail=${result.failed}`)
process.exit(result.failed ? 1 : 0)
