// run-all-tests.mjs — 跑遍所有插件的 test/run.mjs，按行首 ok / FAIL / skip 汇总。
//
// 为什么要自己统计：各插件的汇总行格式不统一（有的 `all N tests passed`，
// 有的只打最后一段），且 dsh-webshell-mgr 的 ok 行**带前导空格**，
// 用 `grep -c '^ok '` 会少算前置空格和 Node test 的 ✔ 行。这里统一归并统计。
import { readdirSync, existsSync, statSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import './test-home-isolation.mjs'
import { productPluginDirectories } from './lib/product-plugins.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = join(root, 'plugins')
const NODE = process.execPath
const stub = join(root, 'scripts', 'test-stub-register.mjs')
const ownedTempRoot = resolve(root, '..', '_ref', 'tmp')
const preexistingTempNames = new Set(existsSync(ownedTempRoot) ? readdirSync(ownedTempRoot) : [])

let ok = 0, fail = 0, skip = 0
const suites = []
const failures = []

for (const name of productPluginDirectories(root)) {
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
    const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
    const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
    const nSkip = lines.filter((l) => /^\s*skip\s/i.test(l)).length
    ok += nOk; fail += nFail; skip += nSkip
    suites.push({ name: suiteName, nOk, nFail, nSkip, status: r.status })
    if (r.status !== 0 || nFail > 0) {
      failures.push({ name: suiteName, nFail, status: r.status })
      // 打印失败行，便于定位
      for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [${suiteName}] ${l.trim()}`)
      // 进程非零退出但没有任何 FAIL 断言时，必须保留崩溃尾部：
      // 否则语法错误、端口占用或 Node 异常会表现成“FAIL 0”，无法定位。
      if (r.status !== 0 && nFail === 0) {
        const tail = lines.filter((l) => l.trim()).slice(-12).join('\n')
        if (tail) console.log(`   [${suiteName}] exit=${r.status}（无 FAIL 断言）\n${tail}`)
      }
    }
    console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${suiteName.padEnd(26)} ok=${nOk} fail=${nFail} skip=${nSkip}`)
  }
}

const taskRecoveryRunner = join(root, 'scripts', 'test-task-recovery.mjs')
if (existsSync(taskRecoveryRunner)) {
  const r = spawnSync(NODE, ['--import', pathToFileURL(stub).href, taskRecoveryRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'task-recovery', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'task-recovery', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [task-recovery] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'task-recovery'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

// 指标历史：有界追加 + 坏行容错 + 趋势增减，且"没测到必须写 null 不能写 0"。
const metricsHistoryRunner = join(root, 'scripts', 'test-metrics-history.mjs')
if (existsSync(metricsHistoryRunner)) {
  const r = spawnSync(NODE, [metricsHistoryRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'metrics-history', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'metrics-history', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [metrics-history] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'metrics-history'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

// 成本预算：工具定义、请求体、请求增长、大结果裁剪都必须是硬阈值。
const costBudgetRunner = join(root, 'scripts', 'test-cost-budget.mjs')
if (existsSync(costBudgetRunner)) {
  const r = spawnSync(NODE, [costBudgetRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'cost-budget', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'cost-budget', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [cost-budget] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'cost-budget'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

// 报告草稿生成器：把结构化成果落成六字段报告草稿，并要求"证据不足必须过不了门禁"。
const reportDraftsRunner = join(root, 'scripts', 'test-report-drafts.mjs')
if (existsSync(reportDraftsRunner)) {
  const r = spawnSync(NODE, ['--import', pathToFileURL(stub).href, reportDraftsRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'report-drafts', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'report-drafts', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [report-drafts] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'report-drafts'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

// 仓库级代价门禁：不随插件单测省略。已迁移插件的工具描述一旦重新塞入长文，
// 这里会像普通测试套件一样亮红。
const budgetRunner = join(root, 'scripts', 'test-tool-budget.mjs')
if (existsSync(budgetRunner)) {
  const r = spawnSync(NODE, [budgetRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'tool-description-budget', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'tool-description-budget', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [tool-description-budget] ${l.trim()}`)
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
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  const nSkip = lines.filter((l) => /^\s*skip\s/i.test(l)).length
  ok += nOk; fail += nFail; skip += nSkip
  suites.push({ name: 'host-preset-refs', nOk, nFail, nSkip, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'host-preset-refs', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [host-preset-refs] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'host-preset-refs'.padEnd(26)} ok=${nOk} fail=${nFail} skip=${nSkip}`)
}

const bundledSkillRunner = join(root, 'scripts', 'test-bundled-skill-registry.mjs')
if (existsSync(bundledSkillRunner)) {
  const r = spawnSync(NODE, [bundledSkillRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const nOk = out.split('\n').filter(l => /^\s*ok\s/.test(l)).length
  ok += nOk
  suites.push({ name: 'bundled-skill-registry', nOk, nFail: 0, nSkip: 0, status: r.status })
  if (r.status !== 0 || nOk < 1) failures.push({ name: 'bundled-skill-registry', nFail: 1, status: r.status })
  console.log(`${r.status === 0 && nOk > 0 ? 'PASS' : 'FAIL'} ${'bundled-skill-registry'.padEnd(26)} ok=${nOk} fail=${r.status === 0 && nOk > 0 ? 0 : 1} skip=0`)
}

const presetVisibilityRunner = join(root, 'scripts', 'test-preset-visibility.mjs')
if (existsSync(presetVisibilityRunner)) {
  const r = spawnSync(NODE, [presetVisibilityRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'preset-visibility', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'preset-visibility', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [preset-visibility] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'preset-visibility'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

const modelReasoningRunner = join(root, 'scripts', 'test-model-reasoning.mjs')
if (existsSync(modelReasoningRunner)) {
  const r = spawnSync(NODE, [modelReasoningRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  const nSkip = lines.filter((l) => /^\s*skip\s/i.test(l)).length
  ok += nOk; fail += nFail; skip += nSkip
  suites.push({ name: 'model-reasoning', nOk, nFail, nSkip, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'model-reasoning', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [model-reasoning] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'model-reasoning'.padEnd(26)} ok=${nOk} fail=${nFail} skip=${nSkip}`)
}

const projectStatusRunner = join(root, 'scripts', 'test-project-status.mjs')
if (existsSync(projectStatusRunner)) {
  const r = spawnSync(NODE, [projectStatusRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'project-status', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'project-status', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [project-status] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'project-status'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

const reportSchemaRunner = join(root, 'scripts', 'test-report-schema.mjs')
if (existsSync(reportSchemaRunner)) {
  const r = spawnSync(NODE, [reportSchemaRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'report-schema', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'report-schema', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [report-schema] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'report-schema'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

const hygieneRunner = join(root, 'scripts', 'test-repo-hygiene.mjs')

// 资产账本：跨来源归一、scope 过滤、原子落盘与 assets.md 托管区块。
const assetInventoryRunner = join(root, 'scripts', 'test-asset-inventory.mjs')
if (existsSync(assetInventoryRunner)) {
  const r = spawnSync(NODE, [assetInventoryRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'asset-inventory', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'asset-inventory', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [asset-inventory] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'asset-inventory'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

const memoryEffectRunner = join(root, 'scripts', 'test-memory-effect.mjs')
const egressRunners = [
  ['egress-policy', join(root, 'scripts', 'test-egress-policy.mjs')],
  ['egress-consistency', join(root, 'scripts', 'test-egress-policy-consistency.mjs')],
]
for (const [suiteName, runner] of egressRunners) {
  if (!existsSync(runner)) continue
  const r = spawnSync(NODE, [runner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: suiteName, nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: suiteName, nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [${suiteName}] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${suiteName.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

if (existsSync(memoryEffectRunner)) {
  const r = spawnSync(NODE, [memoryEffectRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'memory-effect', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'memory-effect', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [memory-effect] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'memory-effect'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

if (existsSync(hygieneRunner)) {
  const r = spawnSync(NODE, [hygieneRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'repo-hygiene', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'repo-hygiene', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [repo-hygiene] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'repo-hygiene'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

// “跑过”不等于“该跑的还在场”：套件文件被删或整块静默跳过时，
// 仅看总退出码会放过。固定必需套件清单，并要求每套至少有断言。
const modePromptRunner = join(root, 'scripts', 'test-pentest-mode-prompts.mjs')
if (existsSync(modePromptRunner)) {
  const r = spawnSync(NODE, [modePromptRunner], { cwd: root, encoding: 'utf8' })
  const out = (r.stdout || '') + (r.stderr || '')
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'pentest-mode-prompts', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'pentest-mode-prompts', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log('   [pentest-mode-prompts] ' + l.trim())
  }
  console.log((r.status === 0 ? 'PASS' : 'FAIL') + ' ' + 'pentest-mode-prompts'.padEnd(26) + ' ok=' + nOk + ' fail=' + nFail + ' skip=0')
}

for (const [suiteName, runner] of [
  ['desktop-install-boundary', join(root, 'scripts', 'test-desktop-install-boundary.mjs')],
  ['test-home-isolation', join(root, 'scripts', 'test-test-home-isolation.mjs')],
  ['checked-delivery', join(root, 'scripts', 'test-checked-delivery.mjs')],
  ['delivery-bundle', join(root, 'scripts', 'test-delivery-bundle.mjs')],
  ['release-integrity', join(root, 'scripts', 'test-release-integrity.mjs')],
  ['release-integrity-reverse', join(root, 'scripts', 'revcheck-release-integrity.mjs')],
  ['worker-orphan-ownership', join(root, 'scripts', 'test-worker-orphan-ownership.mjs')],
  ['task-policy-runtime', join(root, 'scripts', 'test-task-policy-runtime.mjs')],
  ['model-budget', join(root, 'scripts', 'test-model-budget.mjs')],
  ['model-transport', join(root, 'scripts', 'test-model-transport.mjs')],
  ['model-transport-reverse', join(root, 'scripts', 'revcheck-model-transport.mjs')],
  ['model-budget-reverse', join(root, 'scripts', 'revcheck-model-budget.mjs')],
  ['task-dependencies', join(root, 'scripts', 'test-task-dependencies.mjs')],
  ['task-effect-benchmark', join(root, 'scripts', 'test-task-effect-benchmark.mjs')],
  ['effect-browser-output', join(root, 'scripts', 'test-effect-browser-output.mjs')],
  ['effect-qualification-reverse', join(root, 'scripts', 'revcheck-effect-qualification.mjs')],
  ['effect-home-isolation', join(root, 'scripts', 'test-effect-home-isolation.mjs')],
  ['effect-home-isolation-reverse', join(root, 'scripts', 'revcheck-effect-home-isolation.mjs')],
  ['desktop-shortcut-policy', join(root, 'scripts', 'test-desktop-shortcut-policy.mjs')],
  ['desktop-shortcut-policy-reverse', join(root, 'scripts', 'revcheck-desktop-shortcut-policy.mjs')],
  ['effect-benchmark-driver', join(root, 'scripts', 'test-effect-benchmark-driver.mjs')],
  ['effect-benchmark-driver-reverse', join(root, 'scripts', 'revcheck-effect-benchmark-driver.mjs')],
  ['desktop-launcher-single-instance', join(root, 'scripts', 'test-desktop-launcher-single-instance.mjs')],
  ['desktop-launcher-single-instance-reverse', join(root, 'scripts', 'revcheck-desktop-launcher-single-instance.mjs')],
  ['row-record', join(root, 'scripts', 'test-row-record.mjs')],
  ['row-record-reverse', join(root, 'scripts', 'revcheck-row-record.mjs')],
  ['task-policy-corrupt-row', join(root, 'scripts', 'test-task-policy-corrupt-row.mjs')],
  ['effect-matrix-summary', join(root, 'scripts', 'test-effect-matrix-summary.mjs')],
  ['effect-matrix-summary-reverse', join(root, 'scripts', 'revcheck-effect-matrix-summary.mjs')],
  ['store-migration', join(root, 'scripts', 'test-store-migration.mjs')],
  ['store-migration-reverse', join(root, 'scripts', 'revcheck-store-migration.mjs')],
  ['store-down-migration', join(root, 'scripts', 'test-store-down-migration.mjs')],
  ['store-down-migration-reverse', join(root, 'scripts', 'revcheck-store-down-migration.mjs')],
  ['store-corruption', join(root, 'scripts', 'test-store-corruption.mjs')],
  ['store-corruption-reverse', join(root, 'scripts', 'revcheck-store-corruption.mjs')],
  ['list-path-corrupt-row', join(root, 'scripts', 'test-list-path-corrupt-row.mjs')],
  ['list-path-corrupt-row-reverse', join(root, 'scripts', 'revcheck-list-path-corrupt-row.mjs')],
  ['task-inputs', join(root, 'scripts', 'test-task-inputs.mjs')],
  ['task-inputs-reverse', join(root, 'scripts', 'revcheck-task-inputs.mjs')],
  ['task-prompt-cost', join(root, 'scripts', 'test-task-prompt-cost.mjs')],
  ['task-prompt-cost-reverse', join(root, 'scripts', 'revcheck-task-prompt-cost.mjs')],
  ['tool-startup', join(root, 'scripts', 'test-tool-startup.mjs')],
  ['tool-startup-reverse', join(root, 'scripts', 'revcheck-tool-startup.mjs')],
  ['task-workspace', join(root, 'scripts', 'test-task-workspace.mjs')],
  ['product-pruning', join(root, 'scripts', 'test-product-pruning.mjs')],
  ['effect-agent-interface', join(root, 'scripts', 'test-effect-agent-interface.mjs')],
  ['effect-runtime', join(root, 'scripts', 'test-effect-runtime.mjs')],
  ['effect-runtime-reverse', join(root, 'scripts', 'revcheck-effect-runtime.mjs')],
  ['task-workspace-reverse', join(root, 'scripts', 'revcheck-task-workspace.mjs')],
  ['desktop-tool-schema', join(root, 'scripts', 'test-desktop-tool-schema.mjs')],
  ['desktop-contract-tools', join(root, 'scripts', 'test-desktop-contract-tools.mjs')],
  ['desktop-contract-tools-reverse', join(root, 'scripts', 'revcheck-desktop-contract-tools.mjs')],
  ['task-dependencies-reverse', join(root, 'scripts', 'revcheck-task-dependencies.mjs')],
  ['desktop-task-ui', join(root, 'scripts', 'test-desktop-task-ui.mjs')],
  ['desktop-task-ui-reverse', join(root, 'scripts', 'revcheck-desktop-task-ui.mjs')],
  ['research-ledger', join(root, 'scripts', 'test-research-ledger.mjs')],
  ['execution-receipts', join(root, 'scripts', 'test-execution-receipts.mjs')],
  ['effect-verifications', join(root, 'scripts', 'test-effect-verifications.mjs')],
  ['path-read-effect', join(root, 'scripts', 'test-path-read-effect.mjs')],
  ['state-change-effect', join(root, 'scripts', 'test-state-change-effect.mjs')],
  ['config-disclosure-effect', join(root, 'scripts', 'test-config-disclosure-effect.mjs')],
  ['input-processing-effect', join(root, 'scripts', 'test-input-processing-effect.mjs')],
  ['server-side-access-effect', join(root, 'scripts', 'test-server-side-access-effect.mjs')],
  ['browser-execution-effect', join(root, 'scripts', 'test-browser-execution-effect.mjs')],
  ['retest', join(root, 'scripts', 'test-retest.mjs')],
  ['write-failure-rollback', join(root, 'scripts', 'test-write-failure-rollback.mjs')],
  ['write-failure-rollback-reverse', join(root, 'scripts', 'revcheck-write-failure-rollback.mjs')],
  ['concurrent-fault', join(root, 'scripts', 'test-concurrent-fault.mjs')],
  ['concurrent-fault-reverse', join(root, 'scripts', 'revcheck-concurrent-fault.mjs')],
  ['child-concurrent-fault', join(root, 'scripts', 'test-child-concurrent-fault.mjs')],
  ['child-concurrent-fault-reverse', join(root, 'scripts', 'revcheck-child-concurrent-fault.mjs')],
  ['concurrency-ladder', join(root, 'scripts', 'test-concurrency-ladder.mjs')],
  ['desktop-backup', join(root, 'scripts', 'test-desktop-backup.mjs')],
  ['desktop-backup-reverse', join(root, 'scripts', 'revcheck-desktop-backup.mjs')],
  ['desktop-process', join(root, 'scripts', 'test-desktop-process.mjs')],
  ['purpose-tasks', join(root, 'scripts', 'test-purpose-tasks.mjs')],
  ['worker-dispatch-integrity', join(root, 'scripts', 'test-worker-dispatch-integrity.mjs')],
  ['worker-dispatch-integrity-reverse', join(root, 'scripts', 'revcheck-worker-dispatch-integrity.mjs')],
  ['finding-update-consistency', join(root, 'scripts', 'test-finding-update-consistency.mjs')],
  ['finding-update-consistency-reverse', join(root, 'scripts', 'revcheck-finding-update-consistency.mjs')],
  ['project-store', join(root, 'scripts', 'test-project-store.mjs')],
  ['project-store-reverse', join(root, 'scripts', 'revcheck-project-store.mjs')],
  ['project-documents', join(root, 'scripts', 'test-project-documents.mjs')],
  ['project-documents-reverse', join(root, 'scripts', 'revcheck-project-documents.mjs')],
  ['project-execution', join(root, 'scripts', 'test-project-execution.mjs')],
  ['project-execution-reverse', join(root, 'scripts', 'revcheck-project-execution.mjs')],
  ['browser-session', join(root, 'scripts', 'test-browser-session.mjs')],
  ['project-runtime', join(root, 'scripts', 'test-project-runtime.mjs')],
  ['project-runtime-reverse', join(root, 'scripts', 'revcheck-project-runtime.mjs')],
  ['project-delivery', join(root, 'scripts', 'test-project-delivery.mjs')],
  ['project-delivery-reverse', join(root, 'scripts', 'revcheck-project-delivery.mjs')],
  ['project-tools', join(root, 'scripts', 'test-project-tools.mjs')],
  ['project-ui', join(root, 'scripts', 'test-project-ui.mjs')],
  ['project-knowledge', join(root, 'scripts', 'test-project-knowledge.mjs')],
  ['project-lifecycle', join(root, 'scripts', 'test-project-lifecycle.mjs')],
  ['project-login', join(root, 'scripts', 'test-project-login.mjs')],
  ['theme-fallbacks', join(root, 'scripts', 'test-theme-fallbacks.mjs')],
  ['theme-fallbacks-reverse', join(root, 'scripts', 'revcheck-theme-fallbacks.mjs')],
  ['ui-tokens', join(root, 'scripts', 'test-ui-tokens.mjs')],
  ['ui-tokens-reverse', join(root, 'scripts', 'revcheck-ui-tokens.mjs')],
  ['ui-spacing', join(root, 'scripts', 'test-ui-spacing.mjs')],
  ['ui-spacing-reverse', join(root, 'scripts', 'revcheck-ui-spacing.mjs')],
  ['ui-radius', join(root, 'scripts', 'test-ui-radius.mjs')],
  ['ui-radius-reverse', join(root, 'scripts', 'revcheck-ui-radius.mjs')],
  ['ui-control-metrics', join(root, 'scripts', 'test-ui-control-metrics.mjs')],
  ['ui-control-metrics-reverse', join(root, 'scripts', 'revcheck-ui-control-metrics.mjs')],
  ['ui-line-height', join(root, 'scripts', 'test-ui-line-height.mjs')],
  ['ui-line-height-reverse', join(root, 'scripts', 'revcheck-ui-line-height.mjs')],
  ['ui-scope', join(root, 'scripts', 'test-ui-scope.mjs')],
  ['ui-scope-reverse', join(root, 'scripts', 'revcheck-ui-scope.mjs')],
  ['ui-accent', join(root, 'scripts', 'test-ui-accent.mjs')],
  ['ui-accent-reverse', join(root, 'scripts', 'revcheck-ui-accent.mjs')],
  ['ui-shadow', join(root, 'scripts', 'test-ui-shadow.mjs')],
  ['ui-shadow-reverse', join(root, 'scripts', 'revcheck-ui-shadow.mjs')],
  ['ui-severity', join(root, 'scripts', 'test-ui-severity.mjs')],
  ['ui-severity-reverse', join(root, 'scripts', 'revcheck-ui-severity.mjs')],
  ['ui-kit', join(root, 'scripts', 'test-ui-kit.mjs')],
  ['ui-kit-reverse', join(root, 'scripts', 'revcheck-ui-kit.mjs')],
  ['http-conflict-status', join(root, 'scripts', 'test-http-conflict-status.mjs')],
  ['materials-path-guard', join(root, 'scripts', 'test-materials-path-guard.mjs')],
  ['effect-verifications-reverse', join(root, 'scripts', 'test-effect-verifications-reverse.mjs')],
  ['effect-jobs-reverse', join(root, 'scripts', 'test-effect-jobs-reverse.mjs')],
  ['framework-runtime', join(root, 'scripts', 'test-framework-runtime.mjs')],
  ['prompt-library', join(root, 'scripts', 'test-prompt-library.mjs')],
  ['materials-view', join(root, 'scripts', 'test-materials-view.mjs')],
  // E09 材料任务（v6 第 10.3 节）：HAR 混多账号夹具 + 导入管线自检。跑起来才保证夹具不腐坏。
  ['e09-material-task', join(root, 'scripts', 'test-material-task-e09.mjs')],
  ['execution-view', join(root, 'scripts', 'test-execution-view.mjs')],
  ['request-diagnostics', join(root, 'scripts', 'test-request-diagnostics.mjs')],
  ['task-events', join(root, 'scripts', 'test-task-events.mjs')],
  ['task-context-schema', join(root, 'scripts', 'test-task-context-schema.mjs')],
  ['work-lease', join(root, 'scripts', 'test-work-lease.mjs')],
  ['task-archive', join(root, 'scripts', 'test-task-archive.mjs')],
  ['effect-facts', join(root, 'scripts', 'test-effect-facts.mjs')],
  ['effect-reset-provenance', join(root, 'scripts', 'test-effect-reset-provenance.mjs')],
  ['effect-facts-reverse', join(root, 'scripts', 'revcheck-effect-facts.mjs')],
  ['effect-ledger-facts', join(root, 'scripts', 'test-effect-ledger-facts.mjs')],
  ['auto-recon', join(root, 'scripts', 'test-auto-recon.mjs')],
  ['auto-recon-reverse', join(root, 'scripts', 'revcheck-auto-recon.mjs')],
  ['execution-receipts-reverse', join(root, 'scripts', 'test-execution-receipts-reverse.mjs')],
  ['adaptive-execution-reverse', join(root, 'scripts', 'test-adaptive-execution-reverse.mjs')],
  ['verification-basis-reverse', join(root, 'scripts', 'test-verification-basis-reverse.mjs')],
  ['delivery-semantics-reverse', join(root, 'scripts', 'test-delivery-semantics-reverse.mjs')],
  ['public-content', join(root, 'scripts', 'test-public-content.mjs')],
  ['wire-token-count', join(root, 'scripts', 'test-wire-token-count.mjs')],
  ['working-directory', join(root, 'scripts', 'test-working-directory.mjs')],
  ['preset-root-restore', join(root, 'scripts', 'test-preset-root-restore.mjs')],
  ['preset-root-restore-reverse', join(root, 'scripts', 'revcheck-preset-root-restore.mjs')],
  ['client-json-response', join(root, 'scripts', 'test-client-json-response.mjs')],
]) {
  const r = spawnSync(NODE, ['--import', pathToFileURL(stub).href, runner], { cwd: root, encoding: 'utf8' })
  const lines = `${r.stdout || ''}${r.stderr || ''}`.split('\n')
  const nOk = lines.filter(line => /^\s*ok\s/.test(line)).length
  const nFail = lines.filter(line => /^\s*FAIL\s/.test(line)).length
  ok += nOk; fail += nFail
  suites.push({ name: suiteName, nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail) {
    failures.push({ name: suiteName, nFail, status: r.status })
    console.log(lines.filter(line => /^\s*FAIL\s/.test(line)).join('\n') || lines.slice(-12).join('\n'))
    // A process failure without a counted assertion is still a failed suite.
    if (r.status !== 0 && !nFail) fail++
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${suiteName.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

const REQUIRED_SUITES = [
  ...productPluginDirectories(root),
  'dsh-stage-gate/behavior-locks',
  'task-recovery',
  'metrics-history', 'report-drafts', 'tool-description-budget',
  'host-preset-refs', 'preset-visibility', 'model-reasoning', 'project-status', 'report-schema',
  'egress-policy', 'egress-consistency', 'memory-effect', 'repo-hygiene',
  'pentest-mode-prompts',
  'desktop-install-boundary',
  'test-home-isolation',
  'checked-delivery',
  'delivery-bundle',
  'release-integrity',
  'release-integrity-reverse',
  'worker-orphan-ownership',
  'task-policy-runtime',
  'finding-update-consistency',
  'finding-update-consistency-reverse',
  'project-store',
  'project-store-reverse',
  'project-documents',
  'project-documents-reverse',
  'project-execution',
  'project-execution-reverse',
  'browser-session',
  'project-runtime',
  'project-runtime-reverse',
  'project-delivery',
  'project-delivery-reverse',
  'project-tools',
  'project-ui',
  'project-knowledge',
  'project-lifecycle',
  'project-login',
  'model-budget',
  'model-transport-reverse',
  'model-budget-reverse',
  'task-dependencies',
  'task-effect-benchmark',
  'effect-browser-output',
  'effect-qualification-reverse',
  'effect-home-isolation',
  'effect-home-isolation-reverse',
  'desktop-shortcut-policy',
  'desktop-shortcut-policy-reverse',
  'effect-benchmark-driver',
  'effect-benchmark-driver-reverse',
  'desktop-launcher-single-instance',
  'desktop-launcher-single-instance-reverse',
  'row-record',
  'row-record-reverse',
  'task-policy-corrupt-row',
  'effect-matrix-summary',
  'effect-matrix-summary-reverse',
  'store-migration',
  'store-migration-reverse',
  'store-down-migration',
  'store-down-migration-reverse',
  'store-corruption',
  'store-corruption-reverse',
  'list-path-corrupt-row',
  'list-path-corrupt-row-reverse',
  'task-inputs',
  'task-inputs-reverse',
  'task-prompt-cost',
  'task-prompt-cost-reverse',
  'tool-startup',
  'tool-startup-reverse',
  'task-workspace',
  'prompt-library',
  'materials-view',
  'e09-material-task',
  'execution-view',
  'request-diagnostics',
  'task-events',
  'task-context-schema',
  'work-lease',
  'task-archive',
  'effect-facts',
  'effect-facts-reverse',
  'effect-ledger-facts',
  'auto-recon',
  'auto-recon-reverse',
  'product-pruning',
  'effect-agent-interface',
  'effect-runtime',
  'effect-runtime-reverse',
  'task-workspace-reverse',
  'desktop-contract-tools',
  'desktop-contract-tools-reverse',
  'task-dependencies-reverse',
  'desktop-task-ui',
  'desktop-task-ui-reverse',
  'research-ledger',
  'execution-receipts',
  'effect-verifications',
  'path-read-effect',
  'state-change-effect',
  'config-disclosure-effect',
  'input-processing-effect',
  'server-side-access-effect',
  'browser-execution-effect',
  'retest',
  'write-failure-rollback',
  'write-failure-rollback-reverse',
  'concurrent-fault',
  'concurrent-fault-reverse',
  'child-concurrent-fault',
  'child-concurrent-fault-reverse',
  'desktop-backup',
  'theme-fallbacks',
  'theme-fallbacks-reverse',
  'ui-tokens',
  'ui-tokens-reverse',
  'ui-spacing',
  'ui-spacing-reverse',
  'ui-radius',
  'ui-radius-reverse',
  'ui-control-metrics',
  'ui-control-metrics-reverse',
  'ui-line-height',
  'ui-line-height-reverse',
  'ui-scope',
  'ui-scope-reverse',
  'ui-accent',
  'ui-accent-reverse',
  'ui-shadow',
  'ui-shadow-reverse',
  'ui-severity',
  'ui-severity-reverse',
  'ui-kit',
  'ui-kit-reverse',
  'http-conflict-status',
  'materials-path-guard',
  'effect-verifications-reverse',
  'effect-jobs-reverse',
  'framework-runtime',
  'execution-receipts-reverse',
  'adaptive-execution-reverse',
  'verification-basis-reverse',
  'delivery-semantics-reverse',
  'public-content',
  'wire-token-count',
  'working-directory',
  'preset-root-restore',
  'client-json-response',
  'asset-inventory',
]
const suiteNames = new Set(suites.map((suite) => suite.name))
const missingSuites = REQUIRED_SUITES.filter((name) => !suiteNames.has(name))
const emptySuites = suites.filter((suite) => suite.nOk === 0)
if (missingSuites.length > 0) {
  fail += missingSuites.length
  console.log(`FAIL required suites missing: ${missingSuites.join(', ')}`)
}
if (emptySuites.length > 0) {
  fail += emptySuites.length
  console.log(`FAIL suites without assertions: ${emptySuites.map((suite) => suite.name).join(', ')}`)
}
if (missingSuites.length === 0 && emptySuites.length === 0) {
  console.log(`ok   required suites present (${REQUIRED_SUITES.length})`)
}

// 测试进程的隔离 home 会留下残留：有的是空壳（进程被杀），有的是同一轮进程
// 在退出阶段没来得及释放文件句柄。逐轮累积过一次 464 个 / 3.1 GB。
// 所有套件跑完之后，这些目录必然是陈旧的，因此整目录清理并报出释放量。
// 前缀是显式清单（不用通配符拍脑袋）；`dsh-acl-locks` 之类宿主运行期锁不在其中。
const TEST_SCRATCH_PREFIXES = ['saker-test-home-', 'saker-store-legacy-', 'ctf-board-', 'rb-acc-',
  'scan-gov-', 'trace-vault-', 'wsm-lib-', 'dsh-prodsub-', 'smoke-ws-',
  // 用 _ref/tools/run-under-desktop-node.mjs 跑契约工具时产生的隔离 home / 工作区
  'desktop-node-home-', 'smoke-home-', 'rpc-ws-',
  // 契约四件套回归自己的隔离 home，以及反向检查的替身工具目录
  'desktop-contract-home-', 'revcheck-contract-tools-',
  // 输出处理类别用 headless Chrome 复验时的一次性浏览器 profile
  'echo-browser-',
  // 回退保护套件与其反向检查的一次性库文件目录
  'store-down-migration-', 'revcheck-store-down-migration-',
  // 坏库自愈套件的一次性库文件目录
  'store-corruption-',
  // 文件读取/路径效果配方的隔离 home
  'saker-path-read-',
  // 复测套件的隔离 home
  'saker-retest-',
  // 写入失败回滚套件与其反向检查的隔离 home / 拷贝区
  'saker-write-fail-', 'revcheck-write-failure-',
  // 并发故障注入套件与其反向检查
  'saker-concurrent-fault-', 'revcheck-concurrent-fault-',
  // 多子代理并发故障套件与其反向检查
  'saker-child-fault-', 'revcheck-child-fault-',
  // 更新前备份套件的隔离 home
  'saker-desktop-backup-',
  // HTTP 冲突语义套件的隔离 home
  'saker-http-conflict-',
  // 资料目录越界套件的隔离 home
  'saker-path-guard-',
  // 桌面任务 UI / 工作区 UI 套件的隔离 home（同样自己 mkdtemp，收尾不清）
  'saker-task-ui-', 'saker-workspace-ui-']
let sweptHomes = 0
let sweptBytes = 0
// 按前缀归类：只说"清了多少 MB"没法定位是哪个套件在写临时区，下一次还是查不出来。
const sweptByPrefix = new Map()
try {
  const testTempRoot = resolve(root, '..', '_ref', 'tmp')
  for (const entry of readdirSync(testTempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (preexistingTempNames.has(entry.name)) continue
    const prefix = TEST_SCRATCH_PREFIXES.find(candidate => entry.name.startsWith(candidate))
    if (prefix === undefined) continue
    const directory = join(testTempRoot, entry.name)
    try {
      const size = (() => {
        let total = 0
        for (const file of (function walk(dir) { const out = []; for (const item of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, item.name); if (item.isDirectory()) out.push(...walk(full)); else out.push(full) } return out })(directory)) {
          try { total += statSync(file).size } catch { /* 文件已消失 */ }
        }
        return total
      })()
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      sweptHomes += 1
      sweptBytes += size
      const bucket = sweptByPrefix.get(prefix) ?? { count: 0, bytes: 0 }
      bucket.count += 1
      bucket.bytes += size
      sweptByPrefix.set(prefix, bucket)
    } catch { /* 被占用或已消失，跳过 */ }
  }
} catch { /* 临时区不存在时忽略 */ }
if (sweptHomes) {
  console.log(`cleaned ${sweptHomes} leftover test home(s), ${(sweptBytes / 1024 / 1024).toFixed(1)} MB`)
  const worst = [...sweptByPrefix.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
  for (const [prefix, bucket] of worst.slice(0, 5)) {
    console.log(`   ${prefix}* × ${bucket.count} = ${(bucket.bytes / 1024 / 1024).toFixed(1)} MB`)
  }
}

// 个别套件会按相对路径在仓库里建 `<repo>/_ref/tmp`；发布打包的公开内容门禁会把
// 仓库里的 `_ref/` 判成泄漏。收尾时如果它只含空目录就删掉，避免打包莫名其妙失败。
try {
  const repoRef = join(root, '_ref')
  if (existsSync(repoRef)) {
    const files = (function walk(dir) { const out = []; for (const item of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, item.name); if (item.isDirectory()) out.push(...walk(full)); else out.push(full) } return out })(repoRef)
    if (files.length === 0) {
      rmSync(repoRef, { recursive: true, force: true })
      console.log('cleaned empty repo _ref/ (would break the release content check)')
    }
  }
} catch { /* 不存在或被占用时忽略 */ }

console.log(`\n总计 ${suites.length} 套 · ${ok} ok / ${fail} fail / ${skip} skip`)
if (failures.length) console.log('失败套件：' + failures.map((f) => f.name).join(', '))
process.exit(fail || failures.length ? 1 : 0)
