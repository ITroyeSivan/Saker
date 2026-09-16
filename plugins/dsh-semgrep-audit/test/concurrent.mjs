// 并发收尾的回归测试：多路 Solver 同时落地证据与对账时**不能丢行**。
//
// 为什么这条必须是真并发：`evidence-index.md` 与 `scan-reconcile.*` 都是
// 「读全文 → 拼新内容 → 写回全文」。同进程内顺序调用永远看不出问题 ——
// 只有**真多进程同时读写**才会暴露「后写者用旧内容覆盖先写者」。
// （code-audit 的多路并行是常态，所以这不是理论风险。）
//
// 做法：spawn 8 个独立 node 进程，每个往同一 workspace 追加 N 条；
// 全部结束后数行数，应精确等于 8×N。**加锁前实测会少若干行**。
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CHILD = join(HERE, '_child-append.mjs')

const WORKERS = 8
const PER_WORKER = 12

/**
 * 跑并发检查。调用方给 `ok(label, cond)`（与主测试文件同一口径）。
 *
 * 子进程必须带**桩注册器**：`lib/index.js` 顶层 `import { defineTool } from "@deepseek-ai/dsh-tools"`，
 * 那个包只存在于宿主安装树里，插件目录下解析不到。
 * 主测试文件靠 `--import ../../scripts/test-stub-register.mjs` 解决，
 * 这里 spawn 的子进程要自己带上同一份（否则 ERR_MODULE_NOT_FOUND）。
 *
 * @param {(label: string, cond: boolean) => void} ok - 断言收集器
 */
export async function runConcurrencyChecks(ok) {
  const ws = mkdtempSync(join(tmpdir(), 'sg-conc-'))
  // `--import` **只接受 file:// URL 或包名** —— 直接给 Windows 绝对路径会
  // ERR_UNSUPPORTED_ESM_URL_SCHEME（本项目已踩过多次，记在记忆里）。
  const stub = pathToFileURL(join(HERE, '..', '..', '..', 'scripts', 'test-stub-register.mjs')).href

  const children = []
  for (let w = 0; w < WORKERS; w++) {
    const tag = 'w' + w
    const child = spawn(process.execPath, ['--import', stub, CHILD, ws, tag, String(PER_WORKER)], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(new Promise((resolve) => {
      let err = ''
      child.stderr.on('data', (d) => { err += String(d) })
      child.on('close', (code) => resolve({ tag, code, err }))
    }))
  }
  const results = await Promise.all(children)
  const failed = results.filter((r) => r.code !== 0)

  ok('并发子进程全部正常退出', failed.length === 0)
  if (failed.length) console.log('  失败子进程：' + failed.map((f) => `${f.tag}(${f.code}) ${f.err.slice(0, 160)}`).join(' / '))

  const expect = WORKERS * PER_WORKER

  // ① CSV：表头 1 行 + 8×N 数据行
  let csv = ''
  try { csv = readFileSync(join(ws, 'scan-reconcile.csv'), 'utf8') } catch { /* 全没写进去 */ }
  const csvLines = csv ? csv.trimEnd().split('\n') : []
  const csvRows = csvLines.filter((l) => !l.startsWith('scanner,rule,file,line')).length
  ok(`并发 ${WORKERS}×${PER_WORKER} 条命中全部落盘（csv 数据行 = ${expect}）`, csvRows === expect)
  if (csvRows !== expect) console.log(`  csv 实际 ${csvRows} 行（丢了 ${expect - csvRows} 条）`)

  // ② MD
  let md = ''
  try { md = readFileSync(join(ws, 'scan-reconcile.md'), 'utf8') } catch { /* 全没写 */ }
  const mdRows = md.split('\n').filter((l) => l.startsWith('| semgrep |')).length
  ok(`并发写入的 md 行数也是 ${expect}`, mdRows === expect)
  if (mdRows !== expect) console.log(`  md 实际 ${mdRows} 行（丢了 ${expect - mdRows} 条）`)

  // ③ 表头不得重复（重复说明有人拿整份旧内容覆盖，把表头一起抄了一遍）
  const headerCount = csvLines.filter((l) => l.startsWith('scanner,rule,file,line')).length
  ok('csv 表头只有一份（无覆盖重建）', headerCount === 1)

  // ④ 证据编号必须**连续且不重复**（同一号被两个进程拿到就是这个 bug 的指纹）
  let ev = ''
  try { ev = readFileSync(join(ws, 'evidence-index.md'), 'utf8') } catch { /* 无 */ }
  const ids = [...ev.matchAll(/\| (E\d+) \|/g)].map((m) => m[1])
  const uniq = new Set(ids)
  ok(`证据编号无重复（共 ${ids.length} 条，唯一 ${uniq.size} 个）`, ids.length === uniq.size)
  ok(`证据行数 = ${expect}`, ids.length === expect)
  if (ids.length !== uniq.size) console.log(`  重复编号 ${ids.length - uniq.size} 个`)

  rmSync(ws, { recursive: true, force: true })
  return { csvRows, mdRows, evRows: ids.length, expect }
}
