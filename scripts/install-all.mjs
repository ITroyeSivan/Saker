#!/usr/bin/env node
// install-all.mjs — one-shot install of the saker root bundle + all plugins.
//
// For a fresh deployment this does exactly what the README describes, in the
// right order (root bundle first, then the feature plugins), so you do not
// have to type one `dsh plugin add` command per package. Already-installed packages are
// skipped (detected via the profile package.json), so re-runs are safe.
//
// Prerequisites:
//   - `dsh` CLI reachable (the DeepSeek Harness install), or point DSH_CLI at
//     the CLI entry. When the harness lives in a source tree (no global `dsh`),
//     pass a double-quoted node+entry pair, e.g. on Windows:
//       DSH_CLI="\"C:/Program Files/nodejs/node.exe\" \"E:/harness/apps/cli/lib/bin.js\""
//     (cmd treats only double quotes as quotes — that is what tokenize() handles.)
//     the harness CLI entry, e.g.:
//       DSH_CLI="node /abs/path/to/deepseek-harness/apps/cli/lib/bin.js"
//   - tgz artifacts present (run `node scripts/pack-all.mjs` after a clone)
//
// Usage:
//   node scripts/install-all.mjs              # profile `web`
//   SAKER_PROFILE=prod node scripts/install-all.mjs
//
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { stashInstalledDir, restoreStash, dropStash, sweepStashRoot } from './lib/install-stash.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.env.SAKER_PROFILE || 'web'
const cli = process.env.DSH_CLI || 'dsh'
/**
 * 每个包的安装尝试次数（默认 5）。
 * 为什么可配：失败重试之间有 4s 等待，全量 24 个包 × 5 次约 8 分钟 ——
 * 对「明知会失败」的场景（离线校验、CI、回归测试）纯属浪费时间。
 * 设 SAKER_RETRIES=1 即可快速失败一次看结果。
 */
const MAX_TRIES = Math.max(1, Number(process.env.SAKER_RETRIES || 5) || 5)
/**
 * `--force`：同版本也重装一次。
 * 为什么需要：安装器按**版本号**跳过同版本包，所以「改了 lib 但没升版本」
 * 会静默不生效（宿主跑的还是旧代码）。发版前若确认根包/插件内容变了却不打算
 * 动版本号，用 `--force` 强制刷一遍；平时仍走版本号，避免无谓重装。
 */
const FORCE = process.argv.includes('--force')

// profile home: honour DSH_HOME like the harness does, else ~/.dsh
const homeRoot = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const profilePkgPath = join(homeRoot, 'profiles', profile, 'package.json')

// --- Saker-managed package names (root bundle + every plugin) ----------------
// Only these are pruned/reconciled below; a user's own third-party profile deps
// are never touched.
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const sakerPackages = new Set([rootPkg.name])
const pluginDirs = []
for (const name of readdirSync(join(root, 'plugins')).sort()) {
  const dir = join(root, 'plugins', name)
  if (!name.startsWith('dsh-') || !statSync(dir).isDirectory()) continue
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) continue
  pluginDirs.push({ name, dir, pkg: JSON.parse(readFileSync(pkgPath, 'utf8')) })
  sakerPackages.add(pluginDirs[pluginDirs.length - 1].pkg.name)
}

/**
 * Drop Saker-managed `file:` deps whose target tgz no longer exists.
 *
 * `dsh plugin add` rewrites the profile's package.json first and only then runs
 * `pnpm install`. pnpm resolves the WHOLE dependency graph, so one dangling
 * `file:` spec — e.g. the previous version's tgz was cleaned up after a repack
 * — makes every subsequent install fail with ENOENT, including the package the
 * operator is actually trying to upgrade. Pruning the stale entry first keeps
 * the script idempotent; the package is re-added at its current version below.
 */
function pruneDanglingSakerDeps() {
  if (!existsSync(profilePkgPath)) return []
  let p
  try { p = JSON.parse(readFileSync(profilePkgPath, 'utf8')) } catch { return [] }
  const deps = p.dependencies || {}
  const bundles = p.dsh && p.dsh.profile && Array.isArray(p.dsh.profile.bundles) ? p.dsh.profile.bundles : null
  const removed = []
  for (const [name, spec] of Object.entries(deps)) {
    if (!sakerPackages.has(name)) continue
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
    const rawPath = spec.slice('file:'.length)
    // `file:` specs in a profile are resolved from the profile directory by pnpm.
    // Resolving from the current working directory falsely prunes valid relative
    // specs such as `file:saker(github)/...` whenever the installer is run from
    // the repository root, and a later install failure leaves the plugin gone.
    const targetPath = resolve(dirname(profilePkgPath), rawPath)
    if (existsSync(targetPath)) continue
    delete deps[name]
    removed.push(name)
    if (bundles) {
      const i = bundles.indexOf(name)
      if (i >= 0) bundles.splice(i, 1)
    }
  }
  if (removed.length) writeFileSync(profilePkgPath, JSON.stringify(p, null, 2) + '\n', 'utf8')
  return removed
}

/**
 * Ensure every Saker-managed package that is a dependency of the profile also
 * appears in `dsh.profile.bundles` (the layer stack that actually loads it).
 * `pruneDanglingSakerDeps()` splices a dangling entry out of that stack; pnpm
 * add restores the dependency but not the layer, so re-add it here. Without
 * this the plugin installs cleanly yet is never loaded — the operator sees the
 * feature silently disappear.
 */
function ensureBundles() {
  if (!existsSync(profilePkgPath)) return []
  let p
  try { p = JSON.parse(readFileSync(profilePkgPath, 'utf8')) } catch { return [] }
  const bundles = p.dsh && p.dsh.profile && Array.isArray(p.dsh.profile.bundles) ? p.dsh.profile.bundles : null
  if (!bundles) return []
  const deps = p.dependencies || {}
  const added = []
  // root bundle + feature plugins, in the same order the install loop uses
  const wanted = [rootPkg.name, ...pluginDirs.map((d) => d.pkg.name)]
  for (const name of wanted) {
    if (!deps[name]) continue
    if (bundles.includes(name)) continue
    bundles.push(name)
    added.push(name)
  }
  if (added.length) writeFileSync(profilePkgPath, JSON.stringify(p, null, 2) + '\n', 'utf8')
  return added
}

// installed: package name -> installed version (read from the profile's node_modules)
const installed = new Map()
if (existsSync(profilePkgPath)) {
  try {
    const p = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
    for (const name of Object.keys(p.dependencies || {})) {
      try {
        const pkg = JSON.parse(readFileSync(join(homeRoot, 'profiles', profile, 'node_modules', name, 'package.json'), 'utf8'))
        installed.set(name, String(pkg.version || ''))
      } catch { installed.set(name, '') }
    }
  } catch { /* profile not readable -> assume empty */ }
}

function fileSpec(absPath) {
  return 'file:' + absPath.replace(/\\/g, '/')
}

/** Quote-aware tokenizer so DSH_CLI entries like
 *  `"C:/x/node.exe" "E:/d/apps/cli/lib/bin.js"` survive cmd.exe (single quotes
 *  are NOT quotes in cmd — only double quotes are). */
function tokenize(s) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

function runAdd(spec) {
  const base = tokenize(cli)
  const first = base[0] || ''
  const isShim = /\.(cmd|bat)$/i.test(first) || first === 'dsh'
  if (isShim) {
    // .cmd shims need a shell; wrap the spec in double quotes (cmd-safe)
    const cmd = `${cli} plugin --profile ${profile} add "${spec}"`
    const r = spawnSync(cmd, { shell: true, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
    return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
  }
  const args = [...base.slice(1), 'plugin', '--profile', profile, 'add', spec]
  const r = spawnSync(first, args, { shell: false, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
}

/**
 * Drop the installed copy of a package before (re)installing it.
 *
 * pnpm's `hoisted` node-linker — the layout the dsh profile uses — opens a
 * handle on the existing package directory and then deadlocks trying to
 * replace it on Windows. The symptom is brutal to diagnose: `pnpm add` sits
 * forever with zero network connections and near-zero CPU while the target
 * dir is un-renamable for as long as the pnpm process lives (measured: 9m43s,
 * 68s CPU, no TCP sockets, `mv` denied). Killing pnpm releases the lock
 * instantly, which is how the holder was identified.
 *
 * Removing the directory up front sidesteps the deadlock entirely. Deletion
 * goes through the Node fs API rather than the shell, so external
 * "safe delete" shims cannot intercept it.
 *
 * **2026-09-13 修正**：这一步不再是「删除」而是「改名暂存」（见 lib/install-stash.mjs）。
 * 原因是删除没有任何回滚 —— pnpm 连续失败时，插件会被**真正卸载**而输出里只有一行 FAIL。
 * 当晚实测：route-boost / knowledge-hub / skill-browse 三个目录被删后 pnpm 全部失败，
 * 23 个插件只剩 20 个，宿主静默不加载它们（无报错、功能凭空消失）。
 * 改名与删除解死锁的效力相同（pnpm 只要看到目标路径不存在即可），但改名可逆。
 */
function stashDir(pkgName) {
  return stashInstalledDir(join(homeRoot, 'profiles', profile, 'node_modules'), pkgName)
}

function addWithRetry(label, pkgName, spec, version) {
  const want = String(version || '')
  if (installed.has(pkgName)) {
    const have = installed.get(pkgName)
    if (have && want && have === want && !FORCE) {
      console.log(`SKIP ${label}  (already installed: ${pkgName}@${have})`)
      return true
    }
    console.log(FORCE && have === want
      ? `FORCE ${label}  (--force，重装同版本 ${pkgName}@${have})`
      : `UPGRADE ${label}  ${pkgName}@${have || '?'} -> ${want || '?'}`)
  }
  // 替换前先把旧副本改名到暂存区：装成功就丢弃，装失败就放回。
  const stash = stashDir(pkgName)
  for (let tryN = 1; tryN <= MAX_TRIES; tryN++) {
    const { status, out } = runAdd(spec)
    if (status === 0 && /Done in|Already up to date|Progress: resolved/i.test(out)) {
      // 只有**目标真的在了**才丢弃暂存副本。pnpm 偶尔会回 "Already up to date" 而不落盘
      // （例如它认为 lockfile 已满足），此时若把暂存删掉，包里就什么都没了。
      const landed = existsSync(join(homeRoot, 'profiles', profile, 'node_modules', pkgName))
      if (!landed) {
        if (restoreStash(stash)) {
          console.error(`WARN ${label} :: 安装报告成功但目标目录不存在 —— 已放回升级前的副本（未丢失）`)
          return false
        }
      }
      console.log(`OK   ${label}@${want}`)
      installed.set(pkgName, want)
      dropStash(stash)
      return true
    }
    if (tryN < MAX_TRIES) {
      console.log(`     ${label} attempt ${tryN} failed, retrying in 4s… (${(out.split('\n').filter(Boolean).pop() || '').slice(0, 120)})`)
      spawnSync('ping', ['-n', '4', '127.0.0.1'], { stdio: 'ignore' })
    } else {
      console.error(`FAIL ${label}\n${out.split('\n').slice(-6).join('\n')}`)
      if (restoreStash(stash)) {
        console.error(`     ↩ 已回滚：${pkgName} 保持升级前的已有副本（未被卸载）`)
      } else if (stash) {
        console.error(`     ⚠ 回滚失败：旧副本仍在暂存区 ${stash.stash}，请手动改名回 node_modules`)
      } else {
        console.error(`     （该包此前未安装，无旧副本可回滚）`)
      }
      return false
    }
  }
  return false
}

// 0. reconcile the profile first: drop Saker-managed file: deps whose tgz is
//    gone, so a repack + version bump cannot poison the whole pnpm resolve.
//    顺手清掉上次运行可能留下的暂存残片（此前崩溃会把改名后的旧副本留在这里）。
sweepStashRoot(join(homeRoot, 'profiles', profile, 'node_modules'))
const pruned = pruneDanglingSakerDeps()
if (pruned.length) {
  console.log(`pruned ${pruned.length} dangling dep(s): ${pruned.join(', ')}`)
}

// 1. root bundle first (presets + preset-root registration)
let ok = 0
let fail = 0
const rootTgz = join(root, `dsh-saker-${rootPkg.version}.tgz`)
if (!existsSync(rootTgz)) {
  console.error(`root tgz missing: ${rootTgz}\nrun \`node scripts/pack-all.mjs\` first`)
  process.exit(1)
}
if (addWithRetry('root dsh-saker', rootPkg.name, fileSpec(rootTgz), rootPkg.version)) ok++
else fail++

// 2. feature plugins
for (const { name, dir, pkg: p } of pluginDirs) {
  const tgz = join(dir, `dsh-external-${name}-${p.version}.tgz`)
  if (!existsSync(tgz)) {
    console.error(`FAIL ${name} :: tgz missing ${tgz}`)
    fail++
    continue
  }
  if (addWithRetry(name, p.name, fileSpec(tgz), p.version)) ok++
  else fail++
}

console.log(`\ninstalled ok=${ok} fail=${fail}`)
if (fail) process.exit(1)

// 3. reconcile the bundle layer stack: pruneDanglingSakerDeps() removes a stale
//    entry from dsh.profile.bundles, but pnpm add only restores the dependency —
//    the bundle layer itself is not re-added. Without this step the plugin is
//    installed yet never loaded (silent "my feature disappeared" reports).
const ensured = ensureBundles()
if (ensured.length) console.log(`re-added ${ensured.length} bundle layer(s): ${ensured.join(', ')}`)

// 3b. Keep hand-declared model reasoning metadata in sync. The selector is
// invisible without it, and a fresh profile otherwise requires a manual YAML
// edit. Failure is non-fatal: the plugin install itself already succeeded.
if ((process.env.SAKER_MODEL_REASONING || 'auto') !== '0') {
  const settingsFile = join(homeRoot, 'settings.yaml')
  const reasoningScript = join(root, 'scripts', 'configure-model-reasoning.mjs')
  if (existsSync(settingsFile) && existsSync(reasoningScript)) {
    const r = spawnSync(process.execPath, [
      reasoningScript,
      '--settings', settingsFile,
      '--provider', process.env.SAKER_MODEL_PROVIDER || 'custom',
      '--model', process.env.SAKER_MODEL_ID || 'deepseek-flash',
      '--apply',
    ], { encoding: 'utf8', env: { ...process.env, DSH_SRC: process.env.DSH_SRC || root } })
    const output = `${r.stdout || ''}${r.stderr || ''}`.trim()
    if (output) console.log(output)
    if (r.status !== 0) {
      console.warn('model reasoning metadata was not updated; install remains valid')
    }
  }
}

console.log('Restart `dsh web`, then open 设置 → 安全配置 to point tools / MCP endpoints at your local services.')
