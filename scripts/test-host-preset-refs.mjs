// Host preset reference gate: every plugin named by an agent preset must exist in the
// host source tree selected for compatibility testing.
//
// The break this prevents: dsh 0.1.6-alpha.1 removed `dsh-workflow-worker-thread`, but a
// stale profile link kept the old package loadable while the preset named a provider the
// new host no longer shipped. Unit tests and normal startup looked healthy; a session
// failed only when the preset tried to mount. This gate fails at that exact boundary.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REF = resolve(ROOT, '..', '_ref')
const configured = process.env.DSH_SRC
const hostRoot = configured
  ? resolve(configured)
  : (() => {
      if (!existsSync(REF)) return undefined
      return readdirSync(REF, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith('dsh-src'))
        .map(entry => join(REF, entry.name))
        .sort()
        .reverse()
        .find(dir => existsSync(join(dir, 'packages')))
    })()

if (hostRoot === undefined || !existsSync(hostRoot)) {
  console.log('skip dsh src not present; set DSH_SRC to run the host preset reference gate')
  process.exit(0)
}

function walkPackageJsons(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkPackageJsons(path, out)
    else if (entry.isFile() && entry.name === 'package.json') out.push(path)
  }
  return out
}

const hostNames = new Set()
for (const file of walkPackageJsons(join(hostRoot, 'packages'))) {
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof pkg.name === 'string') hostNames.add(pkg.name)
  } catch { /* malformed package.json in a source snapshot is ignored here */ }
}

function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

const refs = new Set()
const files = []
for (const preset of readdirSync(join(ROOT, 'preset'), { withFileTypes: true })) {
  if (!preset.isDirectory()) continue
  const file = join(ROOT, 'preset', preset.name, 'agent.cordis.yml')
  if (!existsSync(file) || !statSync(file).isFile()) continue
  files.push(file)
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/name:\s*'(@deepseek-ai\/[^']+)'/g)) refs.add(packageNameOf(match[1]))
}

const missing = [...refs].filter(name => !hostNames.has(name)).sort()
console.log(`host ${hostRoot}`)
console.log(`preset files ${files.length} · referenced host packages ${refs.size}`)
if (missing.length > 0) {
  console.log(`FAIL ${missing.length} preset reference(s) missing from host source:`)
  for (const name of missing) console.log(`  - ${name}`)
  process.exit(1)
}
console.log('ok   every agent-preset host package exists in the selected dsh source')
