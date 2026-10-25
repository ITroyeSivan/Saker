import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { deployDesktopLauncherAssets } from './lib/desktop-shortcut.mjs'
import { pruneDesktopAuthCookies } from './lib/desktop-prune-auth-cookies.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const boundary = resolve(root, '../_ref/tmp')
const directory = mkdtempSync(join(boundary, 'desktop-auth-cookie-prune-'))
const inside = relative(boundary, directory)
assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp')

function createCookieDatabase(path) {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO cookies (host_key, name, value) VALUES (?, ?, ?)')
  for (let i = 0; i < 71; i += 1) insert.run('127.0.0.1', `dsh-auth-launch-${i}`, String(i))
  insert.run('localhost', 'dsh-auth-loopback', 'keep-localhost')
  insert.run('example.test', 'dsh-auth-remote', 'keep-remote')
  insert.run('127.0.0.1', 'ordinary-session', 'keep-ordinary')
  db.close()
}

try {
  const dbPath = join(directory, 'Cookies')
  createCookieDatabase(dbPath)
  assert.deepEqual(pruneDesktopAuthCookies(dbPath), { removed: 71, skipped: false })

  const db = new DatabaseSync(dbPath)
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM cookies WHERE host_key='127.0.0.1' AND name LIKE 'dsh-auth-%'").get().n, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM cookies').get().n, 3)
    assert.equal(db.prepare("SELECT count(*) AS n FROM cookies WHERE host_key='localhost' AND name='dsh-auth-loopback'").get().n, 1)
    assert.equal(db.prepare("SELECT count(*) AS n FROM cookies WHERE host_key='example.test' AND name='dsh-auth-remote'").get().n, 1)
    assert.equal(db.prepare("SELECT count(*) AS n FROM cookies WHERE host_key='127.0.0.1' AND name='ordinary-session'").get().n, 1)
  } finally {
    db.close()
  }
  assert.deepEqual(pruneDesktopAuthCookies(dbPath), { removed: 0, skipped: false })
  console.log('ok   removes only matching loopback launch cookies and is idempotent')

  const toolsDirectory = join(directory, '_ref', 'tools')
  const config = {
    desktopDirectory: join(directory, 'runtime'),
    userDataDirectory: join(directory, 'user-data'),
    home: join(directory, 'home'),
    workspace: directory,
    tempDirectory: directory,
    nodeExecutable: resolve(process.execPath),
  }
  const assets = deployDesktopLauncherAssets({ toolsDirectory, config })
  assert(existsSync(assets.launcher))
  assert(existsSync(assets.cookiePruner))
  const deployedConfig = JSON.parse(readFileSync(assets.configPath, 'utf8').replace(/^\uFEFF/, ''))
  assert.equal(deployedConfig.nodeExecutable, resolve(process.execPath))
  const launcher = readFileSync(assets.launcher, 'utf8')
  assert.match(launcher, /prune-desktop-auth-cookies\.mjs/)
  assert.match(launcher, /\$settings\.nodeExecutable/)
  assert.doesNotMatch(launcher, /&\s+node\s+/)
  console.log('ok   shortcut asset staging deploys launcher, helper and explicit Node path')

  const cliDb = join(directory, 'Cookies-cli')
  createCookieDatabase(cliDb)
  const cli = spawnSync(resolve(process.execPath), [assets.cookiePruner, cliDb], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr || cli.stdout)
  assert.match(`${cli.stdout || ''}${cli.stderr || ''}`, /removed 71 loopback launch cookie/)
  console.log('ok   deployed helper executes through the captured runtime path')

  const pack = readFileSync(join(root, 'scripts', 'pack-desktop-release.mjs'), 'utf8')
  assert.match(pack, /scripts\/lib\/desktop-prune-auth-cookies\.mjs/, 'release packaging must include the helper')
  console.log('ok   release packaging includes the cookie pruner')
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log('all passed')
