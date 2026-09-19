#!/usr/bin/env node
// Run the package's own Node test suite through the repository-wide test
// harness. mcp-studio keeps its tests under tests/*.test.ts instead of
// plugins/*/test/run.mjs, so without this bridge the transport/proxy tests
// would be invisible to release-gate.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const files = readdirSync('tests')
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `tests/${name}`)
const result = spawnSync(process.execPath, [
  '--import',
  'tsx',
  '--import',
  './tests/stub-register.mjs',
  '--test',
  ...files,
], { encoding: 'utf8' })
const output = `${result.stdout || ''}${result.stderr || ''}`
const passed = Number((/ℹ pass (\d+)/.exec(output) || [])[1] || 0)
const failed = Number((/ℹ fail (\d+)/.exec(output) || [])[1] || 0)
if ((result.status ?? 1) === 0 && passed > 0 && failed === 0) {
  console.log(`ok   ${passed} tests passed`)
  process.exit(0)
}
process.stdout.write(output)
process.exit(result.status ?? 1)
