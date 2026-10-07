// Build a Windows Desktop delivery from the exact current pnpm artifacts.
// Include package contents so install-desktop can verify installed bytes.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, copyFileSync, cpSync, existsSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Desktop release packaging currently supports Windows only.')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version
const output = join(root, 'dist', 'releases')
const payload = join(output, `Saker-${version}-desktop`)
if (existsSync(payload)) throw new Error(`Release directory already exists: ${payload}; use a fresh directory after reviewing its contents.`)
mkdirSync(payload, { recursive: true })
const dirs = [root, ...readdirSync(join(root, 'plugins')).filter(x => x.startsWith('dsh-')).sort().map(x => join(root, 'plugins', x))]
const manifest = []
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json')))
  const name = `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`
  const artifact = join(dir, name)
  const destination = dir === root ? payload : join(payload, 'plugins', dir.split(/[\\/]/).at(-1))
  mkdirSync(destination, { recursive: true })
  const list = spawnSync('tar', ['-tzf', artifact], { encoding: 'utf8', windowsHide: true })
  if (list.status !== 0 || list.stdout.split(/\r?\n/).filter(Boolean).some(x => !x.startsWith('package/') || x.split('/').includes('..'))) throw new Error(`Invalid package archive: ${name}`)
  const unpack = spawnSync('tar', ['-xzf', artifact, '--strip-components=1', '-C', destination], { encoding: 'utf8', windowsHide: true })
  if (unpack.status !== 0) throw new Error(`Could not extract ${name}`)
  copyFileSync(artifact, join(destination, name))
  manifest.push({ name: pkg.name, version: pkg.version, artifact: dir === root ? name : `plugins/${dir.split(/[\\/]/).at(-1)}/${name}`, sha256: createHash('sha256').update(readFileSync(artifact)).digest('hex') })
}
for (const file of ['scripts/install-desktop.mjs', 'scripts/update-desktop-shortcut.mjs', 'scripts/lib/desktop-artifacts.mjs', 'scripts/lib/desktop-shortcut.mjs', 'scripts/lib/desktop-launch.ps1', 'docs/getting-started.md', 'docs/plugin-list.md', `docs/release-v${version}.md`]) {
  const destination = join(payload, file)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(join(root, file), destination)
}
cpSync(join(root, 'docs', 'verification'), join(payload, 'docs', 'verification'), { recursive: true })
cpSync(join(root, 'docs', 'images'), join(payload, 'docs', 'images'), { recursive: true })
// README and the usage guide link to design/progress documents as well.
for (const file of readdirSync(join(root, 'docs')).filter(name => name.endsWith('.md'))) {
  copyFileSync(join(root, 'docs', file), join(payload, 'docs', file))
}
writeFileSync(join(payload, 'packages.json'), JSON.stringify(manifest, null, 2) + '\n')
const zip = payload + '.zip'
const quote = x => "'" + x.replaceAll("'", "''") + "'"
const script = `$ErrorActionPreference='Stop'; Get-ChildItem -LiteralPath ${quote(payload)} | Compress-Archive -DestinationPath ${quote(zip)} -Force`
const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, env: process.env })
if (result.error || result.status !== 0) throw result.error || new Error('Desktop release ZIP creation failed: ' + result.stderr)
console.log(JSON.stringify({ version, packages: manifest.length, directory: payload, zip }, null, 2))
