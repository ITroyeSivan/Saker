#!/usr/bin/env node
// pack-all.mjs — rebuild every publishable tgz in the repo.
//
// pnpm pack runs inside each plugin directory (producing
// dsh-external-<name>-<version>.tgz) and once at the repo root (producing
// dsh-saker-<version>.tgz). The .tgz files are git-ignored on purpose: they
// are build artifacts. Run this after cloning or after editing any plugin.
//
// Usage:  node scripts/pack-all.mjs        (pnpm must be on PATH)
//
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let ok = 0
let fail = 0

// pnpm is an npm shim on Windows; running it through the shell handles
// pnpm / pnpm.cmd / pnpm.ps1 whichever is installed.
function pack(dir, label) {
  try {
    const r = spawnSync('pnpm', ['pack'], {
      cwd: dir,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    if (r.error || r.status !== 0) throw r.error || new Error(`pnpm exit ${r.status}: ${(r.stderr || '').slice(0, 200)}`)
    const m = String(r.stdout).match(/Tarball: .*?\/([^/\s]+\.tgz)/)
    console.log(`OK   ${label}  ${m ? m[1] : ''}`)
    ok++
  } catch (e) {
    console.error(`FAIL ${label} :: ${String(e.message).split('\n')[0]}`)
    fail++
  }
}

// repo root bundle
if (existsSync(join(root, 'package.json'))) pack(root, 'root dsh-saker')

// plugin bundles
for (const name of readdirSync(join(root, 'plugins')).sort()) {
  const dir = join(root, 'plugins', name)
  if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'package.json'))) continue
  if (name.startsWith('dsh-')) pack(dir, name)
}

console.log(`\npacked ok=${ok} fail=${fail}`)
process.exit(fail ? 1 : 0)
