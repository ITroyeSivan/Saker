#!/usr/bin/env node
// install-all.mjs — one-shot install of the saker root bundle + all plugins.
//
// For a fresh deployment this does exactly what the README describes, in the
// right order (root bundle first, then the 20 feature plugins), so you do not
// have to type 21 `dsh plugin add` commands. Already-installed packages are
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.env.SAKER_PROFILE || 'web'
const cli = process.env.DSH_CLI || 'dsh'

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
    if (existsSync(spec.slice('file:'.length))) continue
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

// installed: package name -> installed version (read from the profile's node_modules)const installed = new Map()
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

function addWithRetry(label, pkgName, spec, version) {
  const want = String(version || '')
  if (installed.has(pkgName)) {
    const have = installed.get(pkgName)
    if (have && want && have === want) {
      console.log(`SKIP ${label}  (already installed: ${pkgName}@${have})`)
      return true
    }
    console.log(`UPGRADE ${label}  ${pkgName}@${have || '?'} -> ${want || '?'}`)
  }
  for (let tryN = 1; tryN <= 5; tryN++) {
    const { status, out } = runAdd(spec)
    if (status === 0 && /Done in|Already up to date|Progress: resolved/i.test(out)) {
      console.log(`OK   ${label}@${want}`)
      installed.set(pkgName, want)
      return true
    }
    if (tryN < 5) {
      console.log(`     ${label} attempt ${tryN} failed, retrying in 4s… (${(out.split('\n').filter(Boolean).pop() || '').slice(0, 120)})`)
      spawnSync('ping', ['-n', '4', '127.0.0.1'], { stdio: 'ignore' })
    } else {
      console.error(`FAIL ${label}\n${out.split('\n').slice(-6).join('\n')}`)
      return false
    }
  }
  return false
}

// 0. reconcile the profile first: drop Saker-managed file: deps whose tgz is
//    gone, so a repack + version bump cannot poison the whole pnpm resolve.
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

console.log('Restart `dsh web`, then open 设置 → 安全配置 to point tools / MCP endpoints at your local services.')
