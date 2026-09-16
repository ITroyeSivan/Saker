// 工具描述预算回归：已迁移插件不得把长文重新塞回模型工具 schema。
//
// 这是代价门禁，不是语义测试。语义仍由插件 test/run.mjs 和真宿主抓包负责。
import { join } from 'node:path'
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

if (failed) process.exitCode = 1
