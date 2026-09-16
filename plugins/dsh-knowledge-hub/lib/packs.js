// Knowledge-pack catalog and sparse Git synchronizer.
//
// Pack metadata ships with the plugin; pack content never does. Third-party
// repositories are cloned into DSH_HOME/refs/imports so users can update or
// remove them without touching the Saker package.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const BUNDLED_CATALOG = path.join(PLUGIN_ROOT, 'packs', 'knowledge-packs.json')
const STATE_FILE = 'knowledge-packs-state.json'
const DEFAULT_INTERVAL_DAYS = 7
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

function dshHome() {
  return DSH_HOME
}

function refsRoot() {
  return path.join(dshHome(), 'refs')
}

function importsRoot() {
  return path.join(refsRoot(), 'imports')
}

function userPackDir() {
  return path.join(refsRoot(), 'packs')
}

function statePath() {
  return path.join(refsRoot(), STATE_FILE)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function safeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return []
  return value.map((x) => String(x || '').trim()).filter(Boolean)
}

export function normalizePack(raw, source = 'bundled') {
  const id = safeId(raw && raw.id)
  if (!id) throw new Error(`knowledge pack has no valid id (${source})`)
  const repo = String((raw && raw.repo) || '').trim()
  if (!/^https?:\/\//i.test(repo)) throw new Error(`knowledge pack ${id}: repo must be http(s)`)
  return {
    id,
    title: String(raw.title || id).trim(),
    description: String(raw.description || '').trim(),
    repo,
    branch: String(raw.branch || '').trim(),
    license: String(raw.license || '').trim(),
    licenseUrl: String(raw.licenseUrl || '').trim(),
    distribution: String(raw.distribution || 'bundle-safe').trim(),
    modes: normalizeStringList(raw.modes),
    domains: normalizeStringList(raw.domains),
    tags: normalizeStringList(raw.tags),
    sparse: normalizeStringList(raw.sparse),
    priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 0,
    autoInstall: raw.autoInstall !== false,
    enabled: raw.enabled !== false,
    index: raw.index !== false,
    source,
  }
}

export function validateCatalog(raw, source = 'bundled') {
  if (!raw || typeof raw !== 'object') throw new Error(`invalid knowledge pack catalog: ${source}`)
  const packs = Array.isArray(raw.packs) ? raw.packs.map((pack) => normalizePack(pack, source)) : []
  const seen = new Set()
  for (const pack of packs) {
    if (seen.has(pack.id)) throw new Error(`duplicate knowledge pack id: ${pack.id}`)
    seen.add(pack.id)
  }
  return {
    version: Number(raw.version) || 1,
    release: String(raw.release || '').trim(),
    autoSyncIntervalDays: Math.max(1, Number(raw.autoSyncIntervalDays) || DEFAULT_INTERVAL_DAYS),
    packs,
  }
}

export function loadCatalog(options = {}) {
  const bundled = validateCatalog(readJson(BUNDLED_CATALOG) || { packs: [] }, 'bundled')
  const byId = new Map(bundled.packs.map((pack) => [pack.id, pack]))
  const dir = userPackDir()
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    for (const name of files) {
      try {
        const user = validateCatalog(readJson(path.join(dir, name)), `user:${name}`)
        for (const pack of user.packs) byId.set(pack.id, pack)
      } catch (error) {
        // A broken user pack must not disable the bundled catalog.
        console.error('[dsh-knowledge-hub] user pack ignored (%s): %s', name, error.message)
      }
    }
  }
  return {
    version: bundled.version,
    release: bundled.release,
    autoSyncIntervalDays: bundled.autoSyncIntervalDays,
    packs: [...byId.values()].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)),
    catalogPath: BUNDLED_CATALOG,
    userPackDir: dir,
  }
}

function readState() {
  const value = readJson(statePath())
  return value && typeof value === 'object' && value.packs && typeof value.packs === 'object'
    ? value
    : { version: 1, packs: {} }
}

function writeState(state) {
  writeJsonAtomic(statePath(), state)
}

function runGit(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-4000) })
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4000) })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, code: -1, stdout, stderr: stderr + '\ntimeout' })
    }, Number(options.timeoutMs) || 180000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

function packDir(pack) {
  return path.join(importsRoot(), pack.id)
}

function countIndexableFiles(root) {
  let count = 0
  const stack = ['']
  const exts = new Set(['.md', '.txt', '.yaml', '.yml', '.json', '.csv', '.py', '.ps1', '.sh', '.c', '.gz'])
  while (stack.length) {
    const rel = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== '.git') stack.push(rel ? `${rel}/${entry.name}` : entry.name)
      } else if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
        count++
      }
    }
  }
  return count
}

async function ensureSparseCheckout(pack, dir) {
  if (!pack.sparse.length) return { ok: true }
  const r = await runGit(['sparse-checkout', 'set', '--no-cone', ...pack.sparse], { cwd: dir })
  if (!r.ok) return { ok: false, error: `sparse-checkout 失败：${r.stderr.trim()}` }
  return { ok: true }
}

export async function syncPack(pack, options = {}) {
  const dir = packDir(pack)
  const exists = fs.existsSync(dir)
  const hasGit = fs.existsSync(path.join(dir, '.git'))
  let mode = exists ? 'update' : 'clone'
  if (exists && !hasGit) {
    return { id: pack.id, ok: false, mode: 'conflict', error: `目录已存在但不是托管仓库：${dir}` }
  }

  if (!exists) {
    fs.mkdirSync(importsRoot(), { recursive: true })
    const args = ['clone', '--depth', '1', '--filter=blob:none', '--sparse']
    if (pack.branch) args.push('--branch', pack.branch)
    args.push('--single-branch', '--', pack.repo, dir)
    const clone = await runGit(args)
    if (!clone.ok) {
      return { id: pack.id, ok: false, mode, error: `git clone 失败：${clone.stderr.trim().split('\n').slice(-2).join(' | ')}` }
    }
  } else {
    const args = ['pull', '--ff-only', '--depth', '1', '--quiet']
    if (pack.branch) args.push('origin', pack.branch)
    const pull = await runGit(args, { cwd: dir })
    if (!pull.ok) {
      return { id: pack.id, ok: false, mode, error: `git pull 失败：${pull.stderr.trim().split('\n').slice(-2).join(' | ')}` }
    }
  }

  const sparse = await ensureSparseCheckout(pack, dir)
  if (!sparse.ok) return { id: pack.id, ok: false, mode, error: sparse.error }

  const head = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: dir })
  return {
    id: pack.id,
    ok: true,
    mode,
    path: dir,
    commit: head.ok ? head.stdout.trim() : '',
    files: countIndexableFiles(dir),
  }
}

function shouldSync(pack, state, catalog, force) {
  if (!pack.enabled || (!pack.autoInstall && !force)) return false
  if (force) return true
  const previous = state.packs[pack.id]
  if (!previous || !previous.lastSyncAt) return true
  const age = Date.now() - Date.parse(previous.lastSyncAt)
  return !Number.isFinite(age) || age >= catalog.autoSyncIntervalDays * 24 * 60 * 60 * 1000
}

async function runLimited(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  async function run() {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, run))
  return results
}

export function packsStatus() {
  const catalog = loadCatalog()
  const state = readState()
  const packs = catalog.packs.map((pack) => {
    const dir = packDir(pack)
    const previous = state.packs[pack.id] || {}
    return {
      id: pack.id,
      title: pack.title,
      description: pack.description,
      license: pack.license,
      distribution: pack.distribution,
      modes: pack.modes,
      domains: pack.domains,
      tags: pack.tags,
      autoInstall: pack.autoInstall,
      enabled: pack.enabled,
      installed: fs.existsSync(dir),
      managed: fs.existsSync(path.join(dir, '.git')),
      path: dir,
      commit: previous.commit || '',
      files: Number(previous.files || 0),
      lastSyncAt: previous.lastSyncAt || '',
      lastAttemptAt: previous.lastAttemptAt || '',
      error: previous.error || '',
    }
  })
  return {
    release: catalog.release,
    autoSyncIntervalDays: catalog.autoSyncIntervalDays,
    total: packs.length,
    installed: packs.filter((p) => p.installed).length,
    failed: packs.filter((p) => p.error).length,
    packs,
  }
}

export async function syncPacks(options = {}) {
  const catalog = loadCatalog()
  const state = readState()
  const requested = Array.isArray(options.ids) && options.ids.length
    ? new Set(options.ids.map((x) => safeId(x)))
    : null
  const selected = catalog.packs.filter((pack) => {
    if (requested && !requested.has(pack.id)) return false
    return shouldSync(pack, state, catalog, !!options.force)
  })
  const startedAt = new Date().toISOString()
  const results = await runLimited(selected, Math.max(1, Number(options.concurrency) || 3), async (pack) => {
    const result = await syncPack(pack, options)
    state.packs[pack.id] = {
      ...(state.packs[pack.id] || {}),
      status: result.ok ? 'ok' : 'error',
      commit: result.commit || state.packs[pack.id]?.commit || '',
      files: result.files || state.packs[pack.id]?.files || 0,
      lastAttemptAt: new Date().toISOString(),
      lastSyncAt: result.ok ? new Date().toISOString() : state.packs[pack.id]?.lastSyncAt || '',
      error: result.ok ? '' : result.error || 'unknown error',
    }
    writeState(state)
    return result
  })
  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    requested: selected.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  }
  return summary
}

export function packRoots(importsPath, catalog = loadCatalog()) {
  const packById = new Map(catalog.packs.map((pack) => [pack.id, pack]))
  const roots = []
  if (!fs.existsSync(importsPath)) return roots
  for (const entry of fs.readdirSync(importsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'exploitdb' || entry.name.startsWith('.')) continue
    const pack = packById.get(entry.name)
    if (pack && pack.index === false) continue
    roots.push({
      id: entry.name,
      kind: 'import',
      mode: '',
      packId: entry.name,
      license: pack?.license || '',
      priority: pack?.priority || 0,
      pathPrefix: entry.name,
      root: path.join(importsPath, entry.name),
    })
  }
  return roots
}

export function statePathForDebug() {
  return statePath()
}

export function catalogPathForDebug() {
  return BUNDLED_CATALOG
}
