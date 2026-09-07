#!/usr/bin/env node
// install-all.mjs — one-shot install of the saker root bundle + all plugins.
//
// For a fresh deployment this does exactly what the README describes, in the
// right order (root bundle first, then the 18 feature plugins), so you do not
// have to type 19 `dsh plugin add` commands. Already-installed packages are
// skipped (detected via the profile package.json), so re-runs are safe.
//
// Prerequisites:
//   - `dsh` CLI reachable (the DeepSeek Harness install), or point DSH_CLI at
//     the harness CLI entry, e.g.:
//       DSH_CLI="node /abs/path/to/deepseek-harness/apps/cli/lib/bin.js"
//   - tgz artifacts present (run `node scripts/pack-all.mjs` after a clone)
//
// Usage:
//   node scripts/install-all.mjs              # profile `web`
//   SAKER_PROFILE=prod node scripts/install-all.mjs
//
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.env.SAKER_PROFILE || 'web'
const cli = process.env.DSH_CLI || 'dsh'

// profile home: honour DSH_HOME like the harness does, else ~/.dsh
const homeRoot = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const profilePkgPath = join(homeRoot, 'profiles', profile, 'package.json')
const installed = new Set()
if (existsSync(profilePkgPath)) {
  try {
    const p = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
    Object.keys(p.dependencies || {}).forEach((k) => installed.add(k))
  } catch { /* profile not readable -> assume empty */ }
}

function fileSpec(absPath) {
  return 'file:' + absPath.replace(/\\/g, '/')
}

function runAdd(spec) {
  const cmd = `${cli} plugin --profile ${profile} add "${spec}"`
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
}

function addWithRetry(label, pkgName, spec) {
  if (installed.has(pkgName)) {
    console.log(`SKIP ${label}  (already installed: ${pkgName})`)
    return true
  }
  for (let tryN = 1; tryN <= 5; tryN++) {
    const { status, out } = runAdd(spec)
    if (status === 0 && /Done in|Already up to date|Progress: resolved/i.test(out)) {
      console.log(`OK   ${label}`)
      installed.add(pkgName)
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

// 1. root bundle first (presets + preset-root registration)
let ok = 0
let fail = 0
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const rootTgz = join(root, `dsh-saker-${rootPkg.version}.tgz`)
if (!existsSync(rootTgz)) {
  console.error(`root tgz missing: ${rootTgz}\nrun \`node scripts/pack-all.mjs\` first`)
  process.exit(1)
}
if (addWithRetry('root dsh-saker', rootPkg.name, fileSpec(rootTgz))) ok++
else fail++

// 2. feature plugins
for (const name of readdirSync(join(root, 'plugins')).sort()) {
  const dir = join(root, 'plugins', name)
  if (!name.startsWith('dsh-') || !statSync(dir).isDirectory()) continue
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) continue
  const p = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const tgz = join(dir, `dsh-external-${name}-${p.version}.tgz`)
  if (!existsSync(tgz)) {
    console.error(`FAIL ${name} :: tgz missing ${tgz}`)
    fail++
    continue
  }
  if (addWithRetry(name, p.name, fileSpec(tgz))) ok++
  else fail++
}

console.log(`\ninstalled ok=${ok} fail=${fail}`)
if (fail) process.exit(1)
console.log('Restart `dsh web`, then open 设置 → 安全配置 to point tools / MCP endpoints at your local services.')
