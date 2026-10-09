#!/usr/bin/env node
// Desktop package operations belong to the signed application's bundled CLI.
// This orchestrator reads artifacts and verifies the result; it never edits a profile.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preserveDesktopArtifact } from './lib/desktop-artifacts.mjs'
import { refreshDesktopShortcut } from './lib/desktop-shortcut.mjs'
import { productPluginDirectories, retireInstalledPlugins } from './lib/product-plugins.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const directoryIndex = argv.indexOf('--desktop-dir')
const directory = directoryIndex < 0 ? process.env.DSH_DESKTOP_DIR : argv[directoryIndex + 1]
const checkOnly = argv.includes('--check')
const known = new Set(['--check', '--desktop-dir'])
for (let i = 0; i < argv.length; i++) {
  if (!known.has(argv[i])) throw new Error(`Unknown argument: ${argv[i]}`)
  if (argv[i] === '--desktop-dir') i++
}
if (!directory || directory.startsWith('--')) {
  console.error('Usage: node scripts/install-desktop.mjs --desktop-dir "C:/path/to/DeepSeek Harness" [--check]')
  process.exit(1)
}
if (process.platform !== 'win32') throw new Error('This installer currently supports the verified Windows desktop runtime only.')
const desktop = resolve(directory)
const executable = join(desktop, 'DeepSeek Harness.exe')
const cli = join(desktop, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
if (!existsSync(executable) || !existsSync(join(desktop, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))) {
  throw new Error('Select the official Desktop installation directory containing its executable and bundled dsh command.')
}
const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const manifestPath = join(home, 'profiles', 'desktop', 'package.json')
if (!existsSync(manifestPath)) throw new Error('Open Desktop once to initialize its profile, then fully quit it before installing.')

// Query process ownership by full executable path. Do not kill or guess by process name.
const processQuery = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${executable.replaceAll("'", "''")}' } | Select-Object ProcessId | ConvertTo-Json -Compress`
const inspect = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(processQuery, 'utf16le').toString('base64')],
  { encoding: 'utf8', env: process.env, windowsHide: true })
if (inspect.error || inspect.status !== 0) throw new Error('Cannot verify that Desktop has fully quit; no package operation was run.')
const running = inspect.stdout.trim() ? JSON.parse(inspect.stdout) : []
if ((Array.isArray(running) ? running : [running]).length) throw new Error('Fully quit this Desktop installation before managing plugins; no package operation was run.')

function invoke(args) {
  const result = spawnSync(executable, ['--expose-internals', cli, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error || result.status !== 0) throw result.error || new Error(`Official desktop command failed (${result.status}); see its diagnostics above.`)
  return result.stdout.trim()
}
const version = invoke(['--version'])
if (version !== '0.2.0-rc.2') throw new Error(`Desktop ${version} has not been verified by this installer; expected 0.2.0-rc.2.`)
const directories = productPluginDirectories(root)
const packages = [...directories.map(name => join(root, 'plugins', name)), root].map(dir => {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const filename = `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`
  const artifact = join(dir, filename)
  if (!existsSync(artifact)) throw new Error(`Missing ${artifact}; run node scripts/pack-all.mjs first.`)
  return { name: pkg.name, version: pkg.version, artifact, dir, files: pkg.files ?? [] }
})
console.log(`Desktop ${version}: ${packages.length} packages; profile ${manifestPath}`)
if (checkOnly) {
  for (const pkg of packages) console.log(`${pkg.name}@${pkg.version}`)
  process.exit(0)
}
// One official transaction avoids loading a partially assembled root bundle.
// A changed tarball gets a different immutable file: dependency. Same-version
// re-add and even --force otherwise reuse pnpm's previous local tarball snapshot.
const outputDirectory = join(root, 'dist', 'desktop')
const artifacts = packages.map(pkg => preserveDesktopArtifact(pkg.artifact, outputDirectory))
const retired = retireInstalledPlugins(manifestPath, invoke)
if (retired.length) console.log('Retired plugin packages removed: ' + retired.join(', '))
invoke(['plugin', '--profile', 'desktop', 'add', ...artifacts.map(artifact => `file:${artifact.replaceAll('\\', '/')}`)])
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
function verifyTree(source, destination) {
  if (!existsSync(source)) return
  if (statSync(source).isDirectory()) {
    for (const name of readdirSync(source)) verifyTree(join(source, name), join(destination, name))
    return
  }
  if (!existsSync(destination) || !statSync(destination).isFile()) throw new Error(`Installed file is missing: ${destination}`)
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
  if (hash(source) !== hash(destination)) throw new Error(`Installed bytes differ from source: ${destination}; rebuild the artifacts before retrying.`)
}
for (const pkg of packages) {
  const installedDir = join(dirname(manifestPath), 'node_modules', pkg.name)
  const installed = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
  if (installed.version !== pkg.version || !manifest.dependencies?.[pkg.name]) throw new Error(`Installation verification failed for ${pkg.name}.`)
  for (const entry of pkg.files) {
    if (entry.includes('*') || entry.includes('..') || entry.startsWith('/')) throw new Error(`Unsupported package file selection: ${entry}`)
    verifyTree(join(pkg.dir, entry), join(installedDir, entry))
  }
  // Official operations preserve a previously disabled plugin. Do not silently enable it.
  if (!manifest.dsh?.profile?.bundles?.includes(pkg.name)) console.log(`Disabled selection preserved: ${pkg.name}; enable it in Desktop's Plugins page when needed.`)
}
console.log('Desktop plugin installation verified. Reopen Desktop to load the updated packages.')
const shortcut = refreshDesktopShortcut({ desktopDirectory: desktop })
console.log(`Desktop shortcut refreshed: ${shortcut.shortcut}`)
