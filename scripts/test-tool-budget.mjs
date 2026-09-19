// 工具描述预算回归：已迁移插件不得把长文重新塞回模型工具 schema。
//
// 这是代价门禁，不是语义测试。语义仍由插件 test/run.mjs 和真宿主抓包负责。
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assertToolDescriptionBudget } from './tool-description-budget.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

const TARGETS = [
  ['dsh-redteam-results', 'lib/index.js'],
  ['dsh-attack-atlas', 'lib/index.js'],
  ['dsh-campaign-memory', 'lib/index.js'],
  ['dsh-scanner-tools', 'lib/index.js'],
  ['dsh-stage-gate', 'lib/index.js'],
  ['dsh-webshell-mgr', 'lib/index.js'],
  ['dsh-trace-vault', 'lib/index.js'],
  ['dsh-knowledge-hub', 'lib/index.js'],
  ['dsh-tool-scope', 'lib/index.js'],
]

let failed = 0
for (const [plugin, relative] of TARGETS) {
  const file = join(ROOT, 'plugins', plugin, relative)
  try {
    const result = assertToolDescriptionBudget(file, { maxEntryBytes: 480, maxTotalBytes: 6000 })
    console.log(`ok   ${plugin} 工具描述预算（${result.count} 条 / ${result.total}B）`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${plugin} 工具描述预算：${error instanceof Error ? error.message : String(error)}`)
  }
}

const presetDir = join(ROOT, 'preset')
for (const mode of ['pentest', 'code-audit', 'ctf-solver']) {
  const file = join(presetDir, mode, 'agent.cordis.yml')
  try {
    const source = readFileSync(file, 'utf8')
    const threshold = Number(/thresholdChars:\s*(\d+)/.exec(source)?.[1])
    const head = Number(/headChars:\s*(\d+)/.exec(source)?.[1])
    const tail = Number(/tailChars:\s*(\d+)/.exec(source)?.[1])
    const auto = /name:\s*'@deepseek-ai\/dsh-compaction-basic'[\s\S]{0,160}?auto:\s*true/.test(source)
    if (!(threshold >= 16384 && threshold <= 65536)) throw new Error(`thresholdChars 应在 16K-64K，实际 ${threshold}`)
    if (!(head >= 0 && tail >= 0 && head + tail < threshold)) throw new Error(`head+tail 必须小于 threshold（${head}+${tail} vs ${threshold}）`)
    if (!auto) throw new Error('compaction-basic.auto 必须为 true')
    console.log(`ok   ${mode} 上下文裁剪预算（>${threshold} 字符裁到 ${head}+${tail}）`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${mode} 上下文裁剪预算：${error instanceof Error ? error.message : String(error)}`)
  }
}

if (failed) process.exitCode = 1
