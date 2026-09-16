// run-all-tests.mjs — 跑遍所有插件的 test/run.mjs，按行首 ok / FAIL / skip 汇总。
//
// 为什么要自己统计：各插件的汇总行格式不统一（有的 `all N tests passed`，
// 有的只打最后一段），且 dsh-webshell-mgr 的 ok 行**带前导空格**，
// 用 `grep -c '^ok '` 会少算 21 条。这里统一用 /^\s*ok\s/ 统计。
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = join(root, 'plugins')
const NODE = process.execPath
const stub = join(root, 'scripts', 'test-stub-register.mjs')

let ok = 0, fail = 0, skip = 0
const suites = []
const failures = []

for (const name of readdirSync(pluginsDir).sort()) {
  const dir = join(pluginsDir, name)
  if (!statSync(dir).isDirectory()) continue
  const runners = [['run', join(dir, 'test', 'run.mjs')]]
  if (name === 'dsh-stage-gate') runners.push(['behavior-locks', join(dir, 'test', 'behavior-locks.mjs')])

  for (const [suffix, runner] of runners) {
    if (!existsSync(runner)) continue
    const suiteName = suffix === 'run' ? name : `${name}/${suffix}`
    const r = spawnSync(NODE, ['--import', '../../scripts/test-stub-register.mjs', runner.slice(dir.length + 1)], {
      cwd: dir, encoding: 'utf8',
    })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    const lines = out.split('\n')
    const nOk = lines.filter((l) => /^\s*ok\s/.test(l)).length
    const nFail = lines.filter((l) => /^\s*FAIL\s/.test(l)).length
    const nSkip = lines.filter((l) => /^\s*skip\s/i.test(l)).length
    ok += nOk; fail += nFail; skip += nSkip
    suites.push({ name: suiteName, nOk, nFail, nSkip, status: r.status })
    if (r.status !== 0 || nFail > 0) {
      failures.push({ name: suiteName, nFail, status: r.status })
      // 打印失败行，便于定位
      for (const l of lines) if (/^\s*FAIL\s/.test(l)) console.log(`   [${suiteName}] ${l.trim()}`)
    }
    console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${suiteName.padEnd(26)} ok=${nOk} fail=${nFail} skip=${nSkip}`)
  }
}

// 仓库级代价门禁：不随插件单测省略。已迁移插件的工具描述一旦重新塞入长文，
// 这里会像普通测试套件一样亮红。
const budgetRunner = join(root, 'scripts', 'test-tool-budget.mjs')
if (existsSync(budgetRunner)) {
  const r = spawnSync(NODE, [budgetRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*ok\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*FAIL\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'tool-description-budget', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'tool-description-budget', nFail, status: r.status })
    for (const l of lines) if (/^\s*FAIL\s/.test(l)) console.log(`   [tool-description-budget] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'tool-description-budget'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

// Host upgrade gate: a dsh version bump can delete/rename a plugin that a Saker agent
// preset names. That failure is invisible to normal unit tests because the old package
// may still exist in the installed profile. Run the reference check whenever a host
// source snapshot is available next to this repository.
const hostCompatRunner = join(root, 'scripts', 'test-host-preset-refs.mjs')
if (existsSync(hostCompatRunner)) {
  const r = spawnSync(NODE, [hostCompatRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*ok\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*FAIL\s/.test(l)).length
  const nSkip = lines.filter((l) => /^\s*skip\s/i.test(l)).length
  ok += nOk; fail += nFail; skip += nSkip
  suites.push({ name: 'host-preset-refs', nOk, nFail, nSkip, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'host-preset-refs', nFail, status: r.status })
    for (const l of lines) if (/^\s*FAIL\s/.test(l)) console.log(`   [host-preset-refs] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'host-preset-refs'.padEnd(26)} ok=${nOk} fail=${nFail} skip=${nSkip}`)
}

console.log(`\n总计 ${suites.length} 套 · ${ok} ok / ${fail} fail / ${skip} skip`)
if (failures.length) console.log('失败套件：' + failures.map((f) => f.name).join(', '))
process.exit(fail ? 1 : 0)
