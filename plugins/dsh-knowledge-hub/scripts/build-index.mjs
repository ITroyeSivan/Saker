#!/usr/bin/env node
// Build the offline FTS5 index in a detached process.
//
// Usage:
//   node scripts/build-index.mjs
//   node scripts/build-index.mjs --force

import { buildKnowledgeIndex } from '../lib/index-build.js'

const force = !process.argv.includes('--incremental')
try {
  const result = buildKnowledgeIndex({ force })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
}
