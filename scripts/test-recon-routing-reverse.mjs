// Mutations run only in a self-contained copy under the workspace temp boundary.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('..', import.meta.url))
const tempBoundary = path.resolve(root, '../_ref/tmp')
assert.equal(path.resolve(os.tmpdir()), tempBoundary, 'set TEMP/TMP/TMPDIR to workspace _ref/tmp')
const copy = fs.mkdtempSync(path.join(tempBoundary, 'recon-reverse-'))
const files = ['package.json', 'lib', 'plugins/dsh-nday-hunter/lib', 'preset/pentest/refs/nday/catalog.json',
  'scripts/test-recon-routing.mjs', 'scripts/test-home-isolation.mjs', 'scripts/test-stub-loader.mjs', 'scripts/test-stub-register.mjs']
for (const file of files) { fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true }); fs.cpSync(path.join(root, file), path.join(copy, file), { recursive: true }) }
const cases = [
  ['plugins/dsh-nday-hunter/lib/index.js', "const automaticSelection = assetSource !== 'nday-search' && entryIds.length === 0", 'const automaticSelection = false', 'production default identifies once and screens only related product, retaining component gap'],
  ['plugins/dsh-nday-hunter/lib/index.js', 'const key = JSON.stringify([parsed.base, hostHeader])', 'const key = JSON.stringify([parsed.base])', 'real virtual hosts retain independent routing; inventory clues skip rediscovery and constrain priority tool'],
  ['plugins/dsh-nday-hunter/lib/priority.js', '? candidates.filter(row => relatedIds.has(row.entry.id)) : candidates', '? candidates : candidates', 'cold relevant entry survives hot unrelated ranking and unknown context never yields full-catalog queries'],
  ['plugins/dsh-nday-hunter/lib/recon-candidates.js', 'return entries.filter(entry => productTerms(entry).some', 'return entries.filter(entry => true || productTerms(entry).some', 'generic terms, vendor words and chosen hostnames cannot select products or launch agents'],
]
try {
  for (const [file, anchor, mutation, assertion] of cases) {
    const target = path.join(copy, file), original = fs.readFileSync(target, 'utf8')
    assert.equal(original.split(anchor).length - 1, 1, 'mutation anchor must occur once')
    fs.writeFileSync(target, original.replace(anchor, mutation))
    try {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(copy, 'scripts/test-stub-register.mjs')).href, 'scripts/test-recon-routing.mjs'],
        { cwd: copy, env: { ...process.env, SAKER_ROOT: copy }, encoding: 'utf8', timeout: 60000 })
      assert.notEqual(result.status, 0, 'legacy behavior must fail')
      assert(result.stdout?.includes('FAIL ' + assertion + ':'), 'must fail the targeted behavioral assertion, not a loader error: ' + (result.stderr || result.stdout))
      console.log('ok   reverse caught ' + assertion)
    } finally { fs.writeFileSync(target, original) }
  }
} finally { assert(copy.startsWith(tempBoundary + path.sep)); fs.rmSync(copy, { recursive: true, force: true }) }
