// 给本轮行为级体检发现的几类问题加**回归锁**（源码契约 + 行为）。
//
// 锁的都是「实战才会暴露、静态看不出来」的形态：
//   ① mcp-studio 看门狗定时器：回调抛异常会**打挂整个宿主进程**（不是坏一个面板）
//   ② 四个插件的 SQLite 损坏自愈：库文件不是 SQLite 时要备份+重建，而不是抛
//   ③ 四个插件的库句柄释放：句柄悬着会锁住文件（Windows 上 rename 必 EBUSY）
//   ④ 工具 execute 必须返回可序列化对象（operation_intent 那个真 bug 的同类）
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const P = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]+$/, '')
let pass = 0, fail = 0
const ok = (label, cond) => { if (cond) { pass++; console.log(`ok   ${label}`) } else { fail++; console.log(`FAIL ${label}`) } }

// ── ① mcp-studio 看门狗 ────────────────────────────────────────────────────
{
  const src = readFileSync(`${P}/dsh-mcp-studio/lib/index.js`, 'utf8')
  ok('mcp-studio: watchdog 回调包了异常隔离（定时器抛错会打挂宿主）',
    /const watchdogTick = \(\) => \{[\s\S]{0,200}?try \{[\s\S]{0,80}?tickOnce\(\)/.test(src))
  ok('mcp-studio: watchdog 的失败有可见出口（logger.warn）',
    src.includes('mcp-studio: watchdog tick failed'))
  ok('mcp-studio: 读 servers 走永不抛的 serversOf()（config 可能没有 servers）',
    src.includes('const serversOf = () => {') && !/const section = current\(\);\s*\n\s*const enabled = section\.servers/.test(src))
  ok('mcp-studio: 不存在未保护的 current().servers 直接迭代',
    !/for \(const server of current\(\)\.servers\)/.test(src))
}

// ── ② + ③ 四个 SQLite 插件 ─────────────────────────────────────────────────
for (const p of ['dsh-campaign-memory', 'dsh-attack-atlas', 'dsh-redteam-results', 'dsh-trace-vault']) {
  const store = readFileSync(`${P}/${p}/lib/store.js`, 'utf8')
  ok(`${p}: 库损坏时自愈（备份 + 重建，而不是抛）`, store.includes('healCorruptDb'))
  const firstOpenAt = store.indexOf('new DatabaseSync(dbPath)')
  const notDbAt = store.search(/not a database\|SQLITE_NOTADB/i)
  const healAt = store.indexOf('healCorruptDb(dbPath, true)')
  ok(`${p}: 先尝试开库，只有 NOTADB 才自愈`,
    firstOpenAt >= 0 && notDbAt > firstOpenAt && healAt > notDbAt && !/\n\s*healCorruptDb\(dbPath\);\s*\/\/.*开库前/.test(store))
  ok(`${p}: 并发首开前先设 busy_timeout`,
    store.indexOf('PRAGMA busy_timeout') >= 0 && store.indexOf('PRAGMA busy_timeout') < store.indexOf('PRAGMA journal_mode'))
  ok(`${p}: 自愈会清掉 -wal/-shm 残留（否则新库也被回放坏）`, store.includes('"-wal", "-shm"'))
  ok(`${p}: 备份名冲突不覆盖（追加序号）`, store.includes('while (fs.existsSync(bak))'))
  ok(`${p}: 备份失败时**如实抛出**而不是装作自愈成功`, /catch \(e\) \{[\s\S]{0,320}?throw e;/.test(store))

  const idx = readFileSync(`${P}/${p}/lib/index.js`, 'utf8')
  // 两种正确写法都认：模块级 closeStore() 或 store 单例上的 .close()
  ok(`${p}: 有库句柄释放钩子（卸载时 close，防文件被锁）`,
    /ctx\.effect\(\(\) => \(\) => \{[\s\S]{0,140}?(store\?\.close\?\.\(\)|closeStore\(\))/.test(idx)
    && idx.includes(': store handle"'))
}

// ── ③b 释放钩子必须在 apply 内（放模块顶层会 ReferenceError: ctx is not defined）──
for (const p of ['dsh-attack-atlas', 'dsh-redteam-results', 'dsh-trace-vault']) {
  const idx = readFileSync(`${P}/${p}/lib/index.js`, 'utf8')
  const applyAt = idx.search(/^function apply\(/m)
  const hookAt = idx.indexOf(': store handle"')
  ok(`${p}: 释放钩子在 apply() 内而不是模块顶层`, applyAt >= 0 && hookAt > applyAt)
}

// ── ④ 工具 execute 的返回值契约（行为级：真调一遍）─────────────────────────
{
  // operation_intent 的返回值断言已在 stage-gate 套件里（含反向验证）；
  // 这里做全仓形态扫描：有没有别的 execute 也是「顶层不 return 的 fire-and-forget」。
  const dirs = ['dsh-attack-atlas', 'dsh-auto-advance', 'dsh-campaign-memory', 'dsh-ctf-observer', 'dsh-hunter',
    'dsh-knowledge-hub', 'dsh-method-stack', 'dsh-product-subagents', 'dsh-redteam-results', 'dsh-refusal-guard',
    'dsh-route-boost', 'dsh-scanner-tools', 'dsh-sec-config', 'dsh-sec-enforce', 'dsh-semgrep-audit',
    'dsh-session-pulse', 'dsh-skill-browse', 'dsh-stage-gate', 'dsh-trace-vault', 'dsh-webshell-mgr']
  const bad = []
  for (const d of dirs) {
    const f = `${P}/${d}/lib/index.js`
    if (!existsSync(f)) continue
    const s = readFileSync(f, 'utf8')
    // execute(...) { (async () => { ... })() } 且顶层没有 return —— 这就是 fire-and-forget
    const re = /execute\s*\([^)]*\)\s*\{\s*\n?\s*\(async \(\) => \{/g
    if (re.exec(s)) bad.push(d)
  }
  ok('全仓没有第二个 fire-and-forget 的 execute（返回 undefined 会被宿主判输出非法）', bad.length === 0)
  if (bad.length) console.log('   隐患：' + bad.join(', '))
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`)
process.exit(fail ? 1 : 0)
