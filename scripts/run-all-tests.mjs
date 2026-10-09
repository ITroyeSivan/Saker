// run-all-tests.mjs — 跑遍所有插件的 test/run.mjs，按行首 ok / FAIL / skip 汇总。
//
// 为什么要自己统计：各插件的汇总行格式不统一（有的 `all N tests passed`，
// 有的只打最后一段），且 dsh-webshell-mgr 的 ok 行**带前导空格**，
// 用 `grep -c '^ok '` 会少算前置空格和 Node test 的 ✔ 行。这里统一归并统计。
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import './test-home-isolation.mjs'

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

// 知识评测的反向锁：删掉大部分用例后即使显示 100% 也必须 fail。
const knowledgeGuardRunner = join(root, 'scripts', 'test-knowledge-eval-guards.mjs')
if (existsSync(knowledgeGuardRunner)) {
  const r = spawnSync(NODE, [knowledgeGuardRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'knowledge-eval-guard', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'knowledge-eval-guard', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [knowledge-eval-guard] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'knowledge-eval-guard'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
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
// Nday 语料（信创优先）：结构与诚实性门禁。字段缺项或"未复现却标 verified"
// 都不会让任何其它测试变红，必须单独钉住。
const ndayCatalogRunner = join(root, 'scripts', 'test-nday-catalog.mjs')
if (existsSync(ndayCatalogRunner)) {
  const r = spawnSync(NODE, [ndayCatalogRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'nday-catalog', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'nday-catalog', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [nday-catalog] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'nday-catalog'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

// Nday 语料的**运行时**门禁：结构合法 ≠ 探针打得中。一条 expect 自相矛盾的探针
// 会被同条目里其它活探针盖住，条目照样命中、结构门禁照样全绿。这里逐条探针断言。
const ndayRuntimeRunner = join(root, 'scripts', 'test-nday-corpus-runtime.mjs')
if (existsSync(ndayRuntimeRunner)) {
  const r = spawnSync(NODE, ['--import', pathToFileURL(stub).href, ndayRuntimeRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'nday-corpus-runtime', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'nday-corpus-runtime', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [nday-corpus-runtime] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'nday-corpus-runtime'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

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

// P0-4 跨插件链路：fake FOFA → 账本 → attack_plan → nday_match → handoff。
const attackFlowRunner = join(root, 'scripts', 'test-attack-flow.mjs')
if (existsSync(attackFlowRunner)) {
  const r = spawnSync(NODE, ['--import', pathToFileURL(stub).href, attackFlowRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'attack-flow', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'attack-flow', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [attack-flow] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'attack-flow'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
}

// 0day 模式库：模式必须带可观察信号、假设、先行证伪与最小验证，而不是 payload 合集。
const zerodayCatalogRunner = join(root, 'scripts', 'test-zeroday-catalog.mjs')
if (existsSync(zerodayCatalogRunner)) {
  const r = spawnSync(NODE, [zerodayCatalogRunner], { cwd: root, encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lines = out.split('\n')
  const nOk = lines.filter((l) => /^\s*(?:ok|✔)\s/.test(l)).length
  const nFail = lines.filter((l) => /^\s*(?:FAIL|✖)\s/.test(l)).length
  ok += nOk; fail += nFail
  suites.push({ name: 'zeroday-catalog', nOk, nFail, nSkip: 0, status: r.status })
  if (r.status !== 0 || nFail > 0) {
    failures.push({ name: 'zeroday-catalog', nFail, status: r.status })
    for (const l of lines) if (/^\s*(?:FAIL|✖)\s/.test(l)) console.log(`   [zeroday-catalog] ${l.trim()}`)
  }
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${'zeroday-catalog'.padEnd(26)} ok=${nOk} fail=${nFail} skip=0`)
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
  ['nday-planning', join(root, 'scripts', 'test-nday-planning.mjs')],
  ['desktop-install-boundary', join(root, 'scripts', 'test-desktop-install-boundary.mjs')],
  ['nday-outcomes', join(root, 'scripts', 'test-nday-outcomes.mjs')],
  ['test-home-isolation', join(root, 'scripts', 'test-test-home-isolation.mjs')],
  ['checked-delivery', join(root, 'scripts', 'test-checked-delivery.mjs')],
  ['delivery-bundle', join(root, 'scripts', 'test-delivery-bundle.mjs')],
  ['shared-verification', join(root, 'scripts', 'test-shared-verification.mjs')],
  ['source-update-ui', join(root, 'scripts', 'test-source-update-ui.mjs')],
  ['source-maintenance', join(root, 'scripts', 'test-source-maintenance.mjs')],
  ['source-maintenance-reverse', join(root, 'scripts', 'test-source-maintenance-reverse.mjs')],
  ['probe-batch', join(root, 'scripts', 'test-probe-batch.mjs')],
  ['match-efficiency', join(root, 'scripts', 'test-match-efficiency.mjs')],
  ['recon-routing', join(root, 'scripts', 'test-recon-routing.mjs')],
  ['recon-routing-reverse', join(root, 'scripts', 'test-recon-routing-reverse.mjs')],
  ['source-incremental', join(root, 'scripts', 'test-source-incremental.mjs')],
  ['source-index', join(root, 'scripts', 'test-source-index.mjs')],
  ['osv-export', join(root, 'scripts', 'test-osv-export.mjs')],
  ['cve-official', join(root, 'scripts', 'test-cve-official.mjs')],
  ['source-git', join(root, 'scripts', 'test-source-git.mjs')],
  ['repository-sources', join(root, 'scripts', 'test-repository-sources.mjs')],
  ['research-input', join(root, 'scripts', 'test-research-input.mjs')],
  ['task-policy-runtime', join(root, 'scripts', 'test-task-policy-runtime.mjs')],
  ['task-dependencies', join(root, 'scripts', 'test-task-dependencies.mjs')],
  ['task-effect-benchmark', join(root, 'scripts', 'test-task-effect-benchmark.mjs')],
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
  ['task-dependencies-reverse', join(root, 'scripts', 'revcheck-task-dependencies.mjs')],
  ['desktop-task-ui', join(root, 'scripts', 'test-desktop-task-ui.mjs')],
  ['method-packages', join(root, 'scripts', 'test-method-packages.mjs')],
  ['service-groups', join(root, 'scripts', 'test-service-groups.mjs')],
  ['research-ledger', join(root, 'scripts', 'test-research-ledger.mjs')],
  ['execution-receipts', join(root, 'scripts', 'test-execution-receipts.mjs')],
  ['effect-verifications', join(root, 'scripts', 'test-effect-verifications.mjs')],
  ['effect-verifications-reverse', join(root, 'scripts', 'test-effect-verifications-reverse.mjs')],
  ['effect-jobs-reverse', join(root, 'scripts', 'test-effect-jobs-reverse.mjs')],
  ['framework-runtime', join(root, 'scripts', 'test-framework-runtime.mjs')],
  ['task-flow', join(root, 'scripts', 'test-task-flow.mjs')],
  ['execution-receipts-reverse', join(root, 'scripts', 'test-execution-receipts-reverse.mjs')],
  ['adaptive-execution-reverse', join(root, 'scripts', 'test-adaptive-execution-reverse.mjs')],
  ['verification-basis-reverse', join(root, 'scripts', 'test-verification-basis-reverse.mjs')],
  ['delivery-semantics-reverse', join(root, 'scripts', 'test-delivery-semantics-reverse.mjs')],
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
  'dsh-attack-atlas', 'dsh-auto-advance', 'dsh-campaign-memory', 'dsh-ctf-observer',
  'dsh-hunter', 'dsh-knowledge-hub', 'dsh-mcp-studio', 'dsh-method-stack',
  'dsh-mode-group',
  'dsh-product-subagents', 'dsh-redteam-results', 'dsh-refusal-guard', 'dsh-route-boost',
  'dsh-scanner-tools', 'dsh-sec-config', 'dsh-sec-enforce', 'dsh-semgrep-audit',
  'dsh-session-pulse', 'dsh-skill-browse', 'dsh-stage-gate', 'dsh-stage-gate/behavior-locks',
  'dsh-tool-scope', 'dsh-trace-vault', 'dsh-webshell-mgr', 'task-recovery',
  'metrics-history', 'knowledge-eval-guard', 'report-drafts', 'tool-description-budget',
  'host-preset-refs', 'preset-visibility', 'model-reasoning', 'project-status', 'report-schema',
  'egress-policy', 'egress-consistency', 'memory-effect', 'repo-hygiene',
  'nday-catalog',
  'nday-corpus-runtime',
  'pentest-mode-prompts',
  'nday-planning',
  'desktop-install-boundary',
  'nday-outcomes',
  'test-home-isolation',
  'checked-delivery',
  'delivery-bundle',
  'shared-verification',
  'source-update-ui',
  'source-maintenance',
  'source-maintenance-reverse',
  'probe-batch',
  'match-efficiency',
  'recon-routing',
  'recon-routing-reverse',
  'source-incremental',
  'source-index',
  'osv-export',
  'cve-official',
  'source-git',
  'repository-sources',
  'research-input',
  'task-policy-runtime',
  'task-dependencies',
  'task-effect-benchmark',
  'task-inputs',
  'task-inputs-reverse',
  'task-prompt-cost',
  'task-prompt-cost-reverse',
  'tool-startup',
  'tool-startup-reverse',
  'task-workspace',
  'product-pruning',
  'effect-agent-interface',
  'effect-runtime',
  'effect-runtime-reverse',
  'task-workspace-reverse',
  'task-dependencies-reverse',
  'desktop-task-ui',
  'method-packages',
  'service-groups',
  'research-ledger',
  'execution-receipts',
  'effect-verifications',
  'effect-verifications-reverse',
  'effect-jobs-reverse',
  'framework-runtime',
  'execution-receipts-reverse',
  'adaptive-execution-reverse',
  'verification-basis-reverse',
  'delivery-semantics-reverse',
  'asset-inventory',
  'attack-flow',
  'zeroday-catalog',
  'dsh-nday-hunter',
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

console.log(`\n总计 ${suites.length} 套 · ${ok} ok / ${fail} fail / ${skip} skip`)
if (failures.length) console.log('失败套件：' + failures.map((f) => f.name).join(', '))
process.exit(fail || failures.length ? 1 : 0)
