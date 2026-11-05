// Host preset reference gate: every plugin named by an agent preset must exist in the
// host source tree selected for compatibility testing.
//
// The break this prevents: dsh 0.1.7-rc.2 may remove or rename a host package, but a
// stale profile link kept the old package loadable while the preset named a provider the
// new host no longer shipped. Unit tests and normal startup looked healthy; a session
// failed only when the preset tried to mount. This gate fails at that exact boundary.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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
        .find(dir => existsSync(join(dir, 'packages')) || existsSync(join(dir, 'resources', 'app.asar')))
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
if (existsSync(join(hostRoot, 'packages'))) {
  for (const file of walkPackageJsons(join(hostRoot, 'packages'))) {
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof pkg.name === 'string') hostNames.add(pkg.name)
    } catch { /* malformed package.json in a source snapshot is ignored here */ }
  }
} else {
  const executable = join(hostRoot, 'DeepSeek Harness.exe')
  const runtime = join(hostRoot, 'resources', 'app.asar', 'dsh')
  const inspect = spawnSync(executable, ['--expose-internals', '-e', `
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const names = [];
function walk(dir, depth) {
  if (!fs.existsSync(dir) || depth < 0) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    const manifest = path.join(full, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (typeof pkg.name === 'string') names.push(pkg.name);
      } catch {}
    }
    if (entry.name.startsWith('@') && depth > 0) walk(full, depth - 1);
  }
}
walk(path.join(root, 'node_modules'), 1);
process.stdout.write(JSON.stringify(names));
`, runtime], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
  })
  if (inspect.status !== 0) {
    console.log('FAIL cannot inspect the installed host package set: ' + ((inspect.stderr || inspect.stdout || inspect.error) + '').slice(-2000))
    process.exit(1)
  }
  for (const name of JSON.parse(inspect.stdout || '[]')) hostNames.add(name)
}

function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

const refs = new Set()
const files = []
const allPresetFiles = []
for (const preset of readdirSync(join(ROOT, 'preset'), { withFileTypes: true })) {
  if (!preset.isDirectory()) continue
  const dir = join(ROOT, 'preset', preset.name)
  for (const name of ['agent.cordis.yml', 'agent.patch.yml']) {
    const candidate = join(dir, name)
    if (existsSync(candidate) && statSync(candidate).isFile()) allPresetFiles.push(candidate)
  }
  const file = ['agent.cordis.yml', 'agent.patch.yml']
    .map(name => join(dir, name))
    .find(candidate => existsSync(candidate) && statSync(candidate).isFile())
  if (file === undefined || !existsSync(file) || !statSync(file).isFile()) continue
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
// dsh 0.2.2 keeps this package in the host graph but cannot start it inside an
// agent preset group; the preset then fails at session/create. Keep the
// host-plane control rows out until the host exposes a startable preset face.
const hostPlaneControl = allPresetFiles.filter(file =>
  /@deepseek-ai\/dsh-tool-subagent-control/.test(readFileSync(file, 'utf8')))
if (hostPlaneControl.length > 0) {
  console.log(`FAIL ${hostPlaneControl.length} preset file(s) mount an unstartable host-plane subagent control:`)
  for (const file of hostPlaneControl) console.log(`  - ${file}`)
  process.exit(1)
}
console.log('ok   presets do not mount the unstartable host-plane subagent control')
console.log('ok   every agent-preset host package exists in the selected dsh source')
