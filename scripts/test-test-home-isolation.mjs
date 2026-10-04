import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'

const runnerSource = readFileSync(new URL('./run-all-tests.mjs', import.meta.url), 'utf8')
const exitStatement = runnerSource.trim().split('\n').at(-1)
for (const [fail, failures, expected] of [[0, [], 0], [0, [{ status: 1 }], 1], [1, [], 1]]) {
  let exitCode
  runInNewContext(exitStatement, { fail, failures, process: { exit: value => { exitCode = value } } })
  assert.equal(exitCode, expected, 'suite process failure must fail the overall runner even without a FAIL assertion')
}
console.log('ok   regression exit reflects process failures without FAIL assertions')

const fixture = mkdtempSync(join(tmpdir(), 'saker-home-isolation-check-'))
try {
  const live = join(fixture, 'live-user-home'), file = join(live, 'nday-hunter', 'metrics.json')
  mkdirSync(join(live, 'nday-hunter'), { recursive: true })
  const original = '{"events":[],"sentinel":"user-data-do-not-modify"}\n'
  writeFileSync(file, original)
  const source = `import { appendMetric } from ${JSON.stringify(new URL('../plugins/dsh-nday-hunter/lib/metrics.js', import.meta.url).href)};
    appendMetric({kind:'test-isolation-probe'}); console.log(JSON.stringify({home:process.env.DSH_HOME}));`
  const result = spawnSync(process.execPath, ['--import', new URL('./test-stub-register.mjs', import.meta.url).href, '--input-type=module', '-e', source], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: live, SAKER_TEST_HOME_PROCESS: '' },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const output = JSON.parse(result.stdout.trim())
  assert.notEqual(output.home, live, 'test inherited live application home')
  const rel = relative(tmpdir(), output.home)
  assert(!rel.startsWith('..') && !isAbsolute(rel), 'test home escaped configured temporary boundary')
  assert.equal(readFileSync(file, 'utf8'), original, 'test overwrote live user metrics')
  assert.equal(existsSync(output.home), false, 'test left its owned home behind')
  console.log('ok   test child isolates inherited live home, preserves user bytes and removes its own home')
} catch (error) {
  console.log('FAIL test child isolates inherited live home, preserves user bytes and removes its own home: ' + error.message)
  process.exitCode = 1
} finally { rmSync(fixture, { recursive: true, force: true }) }
