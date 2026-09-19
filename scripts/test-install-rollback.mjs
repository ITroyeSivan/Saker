// test-install-rollback.mjs —— 仓库级不变量：**升级失败不得把插件卸载掉**。
//
// 为什么单独立这个（2026-09-13 实测事故）：
//   `install-all.mjs` 原先在每次升级前**无条件删除**已装目录（为了绕开 pnpm 在 Windows 上的
//   替换死锁 —— 这个理由成立），但删除没有回滚。pnpm 连续失败 5 次后，插件就是真的没了：
//   输出只有一行 FAIL，用户与 profile 都不知道「某个插件已被卸载」。
//   当晚实测：route-boost / knowledge-hub / skill-browse 被删后 pnpm 全失败，
//   node_modules 里 23 个插件只剩 20 个，宿主启动时静默不加载它们。
//
// 本脚本分两层证伪：
//   层 1（单元）—— stash/restore/drop 三个原语的真文件行为。
//   层 2（端到端）—— 真跑 `install-all.mjs`，把 DSH_CLI 指向一个**必定失败**的假 CLI，
//                    断言「升级前存在的插件在失败后依然存在」。
//                    反向验证：把 stashDir 改回真删除，层 1 的 restore 断言会红。
//
// 用法: node scripts/test-install-rollback.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { stashInstalledDir, restoreStash, dropStash, sweepStashRoot, STASH_DIRNAME } =
  await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'install-stash.mjs')).href)

let pass = 0, fail = 0
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log(`ok   ${label}`) }
  else { fail++; console.log(`FAIL ${label}${extra !== undefined ? ' —— ' + String(extra) : ''}`) }
}

// ── 层 1：stash / restore / drop 原语 ───────────────────────────────────────
{
  const nm = mkdtempSync(join(tmpdir(), 'stash-nm-'))
  const pkg = '@dsh-external/dsh-demo'
  const target = join(nm, pkg)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0' }))
  writeFileSync(join(target, 'lib.js'), 'export const v = "1.0.0"\n')

  const h = stashInstalledDir(nm, pkg)
  ok('stash：返回句柄', h !== null && typeof h.stash === 'string', JSON.stringify(h))
  ok('stash：原位置已让开（pnpm 可在此新建）', !existsSync(target))
  ok('stash：旧副本仍完整保留在暂存区', existsSync(join(h.stash, 'package.json')) && existsSync(join(h.stash, 'lib.js')))
  ok('stash：暂存目录在 node_modules 内部（同盘，rename 才原子）', h.stash.startsWith(nm + (process.platform === 'win32' ? '\\' : '/')))
  ok('stash：暂存目录以点开头（pnpm 不当它是包）', STASH_DIRNAME.startsWith('.'))

  // 模拟安装失败 → 回滚
  const restored = restoreStash(h)
  ok('restore：报告已恢复', restored === true)
  ok('restore：原位置重新有包', existsSync(join(target, 'package.json')))
  ok('restore：内容与原版一致（未被卸载）', readFileSync(join(target, 'lib.js'), 'utf8').includes('1.0.0'))
  ok('restore：暂存区已清空该副本', !existsSync(h.stash))

  // 再 stash 一次，模拟安装成功 → 丢弃
  const h2 = stashInstalledDir(nm, pkg)
  dropStash(h2)
  ok('drop：暂存副本被删除', !existsSync(h2.stash))
  ok('drop：暂存区无残片', !existsSync(join(nm, STASH_DIRNAME)) || readdirSync(join(nm, STASH_DIRNAME)).length === 0)

  // 目标不存在时是空操作（不应报错，也不该建出个空目录）
  const h3 = stashInstalledDir(nm, '@dsh-external/never-installed')
  ok('stash：包不存在时返回 null（无旧副本可回滚）', h3 === null)
  ok('stash：未凭空创建目标目录', !existsSync(join(nm, '@dsh-external/never-installed')))

  // 残留清扫（先把包放回去：上一步 drop 之后目标位置已空 —— 这正是「装成功后旧副本被丢弃」的语义）
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0' }))
  const h4 = stashInstalledDir(nm, pkg)
  ok('准备：已有暂存残片', h4 !== null && existsSync(h4.stash))
  sweepStashRoot(nm)
  ok('sweep：清掉暂存残片（崩溃遗留不累积）', !existsSync(join(nm, STASH_DIRNAME)))
  restoreStash(h4) // 句柄已失效，安全空转
  ok('sweep 后 restore 安全空转（不抛错）', true)

  rmSync(nm, { recursive: true, force: true })
}

// ── 层 2：端到端 —— 真跑 install-all，CLI 必失败 ────────────────────────────
//
// ⚠ 这里必须用**自包含的 fixture 仓库**，不能用本仓库的 plugins/：
//   第一版把这层写成「在真仓库的 home 里放一个探针包」→ 探针不在 `plugins/` 清单里，
//   install-all 根本不会处理它 → 断言**恒真**（新旧实现都「通过」）。
//   自包含 fixture 的做法：临时目录里搭一个最小仓库（root package.json + 一个
//   plugins/dsh-<name>/ + 对应 tgz + scripts/ 下的脚本副本）。install-all 用
//   `dirname(__filename)/..` 推导 root，所以副本必须放在 `<fixture>/scripts/` 下。
{
  const fixture = mkdtempSync(join(tmpdir(), 'stash-repo-'))
  const home = mkdtempSync(join(tmpdir(), 'stash-home-'))
  const profile = 'web'
  const profileDir = join(home, 'profiles', profile)
  const nm = join(profileDir, 'node_modules')

  const ROOT_PKG_NAME = '@fixture/dsh-saker'
  const ROOT_VERSION = '0.0.1'
  const PROBE_NAME = '@dsh-external/dsh-probe'
  const PROBE_VERSION = '2.0.0'
  const OLD_VERSION = '1.0.0'

  // fixture 仓库骨架
  mkdirSync(join(fixture, 'plugins', 'dsh-probe'), { recursive: true })
  mkdirSync(join(fixture, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: ROOT_PKG_NAME, version: ROOT_VERSION }, null, 2) + '\n')
  writeFileSync(join(fixture, `dsh-saker-${ROOT_VERSION}.tgz`), 'dummy')   // 只校验存在性
  writeFileSync(join(fixture, 'plugins', 'dsh-probe', 'package.json'), JSON.stringify({ name: PROBE_NAME, version: PROBE_VERSION }, null, 2) + '\n')
  writeFileSync(join(fixture, 'plugins', 'dsh-probe', `dsh-external-dsh-probe-${PROBE_VERSION}.tgz`), 'dummy')
  // 脚本副本（含被改写的 legacy 版本 —— 反向验证时由 SAKER_INSTALL_ALL_SCRIPT 指过来）
  const srcScript = process.env.SAKER_INSTALL_ALL_SCRIPT || join(ROOT, 'scripts', 'install-all.mjs')
  writeFileSync(join(fixture, 'scripts', 'install-all.mjs'), readFileSync(srcScript, 'utf8'))
  writeFileSync(join(fixture, 'scripts', 'lib', 'install-stash.mjs'),
    readFileSync(join(ROOT, 'scripts', 'lib', 'install-stash.mjs'), 'utf8'))

  // 已装旧版探针（升级目标）
  const target = join(nm, PROBE_NAME)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: PROBE_NAME, version: OLD_VERSION }))
  writeFileSync(join(target, 'marker.txt'), 'PRE-EXISTING')

  const probeTgz = join(fixture, 'plugins', 'dsh-probe', `dsh-external-dsh-probe-${PROBE_VERSION}.tgz`)
  // Use a profile-relative file spec on purpose. pnpm resolves `file:` from the
  // profile directory; the installer used to resolve it from cwd, classify the
  // still-valid dependency as dangling, prune it, and leave the profile broken
  // if the subsequent install failed.
  const relativeProbeTgz = relative(profileDir, probeTgz).replace(/\\/g, '/')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'profile', private: true,
    dependencies: { [PROBE_NAME]: 'file:' + relativeProbeTgz },
    dsh: { profile: { bundles: [PROBE_NAME] } },
  }, null, 2) + '\n')

  // 假 CLI：永远失败（模拟 pnpm 装不上 / 网断 / store 冲突）
  const fakeCli = join(home, 'fake-failing-cli.mjs')
  writeFileSync(fakeCli, 'process.stderr.write("simulated install failure\\n"); process.exit(1)\n')

  const r = spawnSync(process.execPath, [join(fixture, 'scripts', 'install-all.mjs')], {
    cwd: fixture,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      DSH_HOME: home,
      SAKER_PROFILE: profile,
      // 只试 1 次：失败重试之间有 4s 等待，全量 24 个包 × 5 次 ≈ 8 分钟，对「明知会失败」的
      // 校验纯属浪费。SAKER_RETRIES=1 让本层在几秒内跑完，且覆盖的正是最后那次失败分支。
      SAKER_RETRIES: '1',
      // DSH_CLI 传「node 假脚本」：install-all 的 tokenize 支持双引号对
      DSH_CLI: `${process.execPath} ${fakeCli}`,
      NODE_OPTIONS: '',
    },
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`

  ok('端到端：install-all 以非零码结束（失败被上报）', r.status !== 0, `status=${r.status}`)
  ok('端到端：有效的 profile 相对 file: 依赖不会被误判为 dangling',
    !/pruned 1 dangling dep/.test(out), out.split('\n').filter((l) => /dangling|pruned/.test(l)).join(' | ').slice(0, 200))
  ok('端到端：确实走到了探针包的升级分支（假 CLI 对它报过 FAIL）',
    new RegExp(`FAIL\\s+dsh-probe`).test(out), out.split('\n').filter((l) => /dsh-probe|UPGRADE/.test(l)).join(' | ').slice(0, 200))
  ok('端到端：**升级失败后旧插件仍在**（这就是本次修复的核心断言）', existsSync(target), '插件目录不见了')
  ok('端到端：旧插件内容未被破坏', existsSync(join(target, 'marker.txt')) && readFileSync(join(target, 'marker.txt'), 'utf8') === 'PRE-EXISTING')
  ok('端到端：旧 package.json 未被破坏（版本仍是旧版）',
    (() => { try { return JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version === OLD_VERSION } catch { return false } })())
  ok('端到端：没有把暂存残片留在 node_modules 里', !existsSync(join(nm, STASH_DIRNAME)),
    existsSync(join(nm, STASH_DIRNAME)) ? readdirSync(join(nm, STASH_DIRNAME)).join(',') : '')
  ok('端到端：回滚在输出里有痕迹（用户能知道发生了什么）', /↩ 已回滚/.test(out),
    out.split('\n').filter((l) => /回滚|卸载/.test(l)).join(' | ').slice(0, 160))

  rmSync(home, { recursive: true, force: true })
  rmSync(fixture, { recursive: true, force: true })
}

console.log(`\n${pass}/${pass + fail} 项通过`)
console.log(fail === 0
  ? 'PASS 升级失败不会卸载插件（stash/restore 生效）'
  : `FAIL ${fail} 项`)
process.exit(fail ? 1 : 0)
