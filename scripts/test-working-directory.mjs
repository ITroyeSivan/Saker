import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionWorkingDirectory, ensureWorkingDirectory } from '../lib/working-directory.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const session = { header: { cwd: 'C:\\original-project' } }

assert.equal(
  sessionWorkingDirectory({ get: () => ({ get: () => 'C:\\current-project' }) }, session),
  'C:\\current-project',
  '0.2.1 workingDirectory.get must win over the original header.cwd',
)
assert.equal(
  sessionWorkingDirectory({ get: () => null }, session),
  'C:\\original-project',
  '0.2.0 fallback keeps the original project directory',
)

const calls = []
const ensured = await ensureWorkingDirectory({
  get: () => ({ ensure: async (agent, signal) => { calls.push({ agent, signal }); return 'C:\\ensured-project' } }),
}, { session }, AbortSignal.timeout(1000))
assert.equal(ensured, 'C:\\ensured-project', 'ensure uses the host service before filesystem work')
assert.equal(calls.length, 1, 'ensure called exactly once')
await assert.rejects(
  () => ensureWorkingDirectory({}, { session: { header: {} } }, AbortSignal.timeout(1000)),
  /工作目录缺失/,
  'missing session cwd must not silently fall back to the host process cwd',
)

for (const file of [
  'plugins/dsh-hunter/lib/index.js',
  'plugins/dsh-nday-hunter/lib/index.js',
  'plugins/dsh-scanner-tools/lib/index.js',
  'plugins/dsh-semgrep-audit/lib/index.js',
  'plugins/dsh-redteam-results/lib/index.js',
]) {
  const source = readFileSync(join(root, file), 'utf8')
  assert.match(source, /sessionWorkingDirectory/, `${file} must use the working-directory adapter`)
}

console.log('ok   working directory adapter prefers 0.2.1 current directory and keeps legacy fallback')
