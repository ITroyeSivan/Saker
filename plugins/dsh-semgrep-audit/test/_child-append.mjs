// 并发写入的子进程（被 concurrent.mjs spawn）。
//
// 用法: node _child-append.mjs <workspace> <tag> <n>
//
// 为什么单独一个文件而不是 `node -e`：ESM 下 `-e` 里 import 绝对路径需要
// file:// URL，且 Windows 路径转义极易出错（本项目踩过多次）。写成真文件最稳。
import fs from 'node:fs'
import path from 'node:path'
import { appendReconcile } from '../lib/index.js'

const [ws, tag, nRaw] = process.argv.slice(2)
const n = Number(nRaw)

// 对账双写（这条路走插件自己的锁）
for (let i = 0; i < n; i++) {
  appendReconcile(fs, ws, [{ rule: `r-${tag}-${i}`, file: `${tag}.java`, line: i, severity: 'ERROR', message: '' }])
}

// 证据索引（与 appendReconcile 用同一把锁约定 —— 这里直接按同样方式写，
// 目的是验证「读 id + 写行」在同一把锁内不会互相覆盖）
const evPath = path.join(ws, 'evidence-index.md')
const lockPath = evPath + '.lock'
const deadline = Date.now() + 5000
for (;;) {
  try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); break } catch {
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > 15000) { try { fs.unlinkSync(lockPath) } catch { /* 已被回收 */ } ; continue }
    } catch { /* 刚释放，重试 */ }
    if (Date.now() > deadline) throw new Error('lock timeout')
  }
}
try {
  let head = ''
  try { head = fs.readFileSync(evPath, 'utf8') } catch {
    head = '# 证据索引\n\n| 编号 | 时间 | 证据 | 产生方式 | 交接/消费 |\n|---|---|---|---|---|\n'
  }
  let maxN = 0
  for (const m of head.matchAll(/\| E(\d+) \|/g)) maxN = Math.max(maxN, Number(m[1]))
  for (let i = 0; i < n; i++) {
    maxN += 1
    head += `| E${maxN} | ${new Date().toISOString()} | ${tag}-${i}.json | semgrep | 扫描产物 |\n`
  }
  fs.writeFileSync(evPath, head)
} finally {
  try { fs.unlinkSync(lockPath) } catch { /* 已被回收 */ }
}
process.exit(0)
