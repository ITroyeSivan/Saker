// Knowledge-pack catalog and sparse Git synchronizer.
//
// Pack metadata ships with the plugin; pack content never does. Third-party
// repositories are cloned into DSH_HOME/refs/imports so users can update or
// remove them without touching the Saker package.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const BUNDLED_CATALOG = path.join(PLUGIN_ROOT, 'packs', 'knowledge-packs.json')
const STATE_FILE = 'knowledge-packs-state.json'
const DEFAULT_INTERVAL_DAYS = 7
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SYNC_MODES = new Set(['auto', 'manual', 'frozen'])

// 统一出站策略实现住在根包（`dsh-saker/egress`），这里只解析、不复制判定逻辑。
// 解析不到（只装了插件没装根包的极端布局）时不拦，保持旧行为，并如实回报原因。
const requireFromHere = createRequire(import.meta.url)
let egressModule
async function egressLib() {
  if (egressModule !== undefined) return egressModule
  try {
    egressModule = await import(pathToFileURL(requireFromHere.resolve('dsh-saker/egress')).href)
  } catch {
    try {
      egressModule = await import(pathToFileURL(path.resolve(HERE, '..', '..', '..', 'lib', 'egress.js')).href)
    } catch {
      egressModule = null
    }
  }
  return egressModule
}

/** 基础设施出站闸门：知识包 clone/pull 属于 infra 出站，冻结档必须拦在 git 之前。 */
export async function gateInfraEgress(options = {}) {
  const lib = await egressLib()
  if (!lib) return { decision: 'allow', reason: 'egress-module-missing', mode: 'allow', policySource: 'module-missing' }
  const source = String(options.source || '')
  const { host, local } = lib.describeSource(source)
  return lib.checkEgress(options.home || dshHome(), {
    plugin: options.plugin || 'dsh-knowledge-hub',
    kind: 'infra',
    host,
    local,
    note: String(options.note || source),
  })
}

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
  if (!value || typeof value !== 'object' || !value.packs || typeof value.packs !== 'object') {
    return { version: 1, packs: {}, syncMode: 'auto' }
  }
  return {
    version: Number(value.version) || 1,
    packs: value.packs,
    syncMode: SYNC_MODES.has(value.syncMode) ? value.syncMode : 'auto',
  }
}

function writeState(state) {
  writeJsonAtomic(statePath(), state)
}

export function getSyncMode() {
  return readState().syncMode
}

export function setSyncMode(mode) {
  const next = String(mode || '').trim().toLowerCase()
  if (!SYNC_MODES.has(next)) throw new Error(`未知知识同步模式：${mode}`)
  const state = readState()
  state.syncMode = next
  writeState(state)
  return next
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

async function ensureSparseCheckout(pack, dir, git = runGit) {
  if (!pack.sparse.length) return { ok: true }
  const r = await git(['sparse-checkout', 'set', '--no-cone', ...pack.sparse], { cwd: dir })
  if (!r.ok) return { ok: false, error: `sparse-checkout 失败：${r.stderr.trim()}` }
  return { ok: true }
}

function removeDirSafe(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Best-effort cleanup. The caller keeps the original error if cleanup fails.
  }
}

/** 残骸目录名：`.hacktricks.recover-<ts>-<pid>-<rand>` / `hacktricks.diverged-<ts>-<pid>-<rand>`。 */
const DEBRIS_RE = /^\.?([A-Za-z0-9._-]+?)\.(recover|diverged)-\d+-\d+-[a-z0-9]+$/i

/**
 * 清理 pack 同步留下的残骸。
 *
 * 为什么需要：`recoverDivergedPack` 会先 clone 到 `.{id}.recover-*`，再把旧目录改名成
 * `.{id}.diverged-*`。正常路径下两者都会被移走或删掉，但
 *   - 进程在 rename 之前死掉 → `.recover-*` 永久留在盘上（实测真 home 里堆了 4 份、
 *     其中 3 份是完整的 1035 文件仓库，占 41MB）；
 *   - 每次发生分歧恢复都留一份 `.diverged-*` 旧仓库，而没人回收。
 * 这些目录虽然被 `packRoots()` 排除（不会污染检索），但会一直吃磁盘、越积越多。
 *
 * 保留规则（保守，宁可不删也不误删用户的东西）：
 *   - `.recover-*`：纯临时 clone，默认就清，但只清 `minAgeMs` 之前的，
 *     避免打断并发中的同步。
 *   - `.diverged-*`：**里面可能有用户对导入层做过的本地修改**，所以默认一份都不删。
 *     只有显式传 `includeBackups: true` 才会回收；那时也保留
 *     `state.packs[*].backup` 引用着的目录，以及每个 pack 最新的一份作为兜底。
 */
export function prunePackDebris(importsPath, state = {}, options = {}) {
  const minAgeMs = Number.isFinite(options.minAgeMs) ? options.minAgeMs : 60_000
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const removeDir = options.removeDir || removeDirSafe
  const includeBackups = options.includeBackups === true

  const referenced = new Set()
  for (const entry of Object.values(state.packs || {})) {
    const backup = entry && typeof entry.backup === 'string' ? entry.backup : ''
    if (backup) referenced.add(path.resolve(backup))
  }

  let entries = []
  try {
    entries = fs.readdirSync(importsPath, { withFileTypes: true })
  } catch {
    return { removed: [], kept: [] }
  }

  const recover = []
  const diverged = new Map() // packId -> [{ dir, mtimeMs }]
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const match = DEBRIS_RE.exec(entry.name)
    if (!match) continue
    const [, packId, kind] = match
    const dir = path.join(importsPath, entry.name)
    let mtimeMs = 0
    try { mtimeMs = fs.statSync(dir).mtimeMs } catch { continue }
    if (kind === 'recover') recover.push({ dir, mtimeMs })
    else diverged.set(packId, [...(diverged.get(packId) || []), { dir, mtimeMs }])
  }

  const doomed = []
  const kept = []
  for (const item of recover) {
    if (referenced.has(path.resolve(item.dir)) || now - item.mtimeMs < minAgeMs) kept.push(item.dir)
    else doomed.push(item.dir)
  }
  for (const list of diverged.values()) {
    if (!includeBackups) {
      for (const item of list) kept.push(item.dir)
      continue
    }
    const newest = list.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))
    for (const item of list) {
      if (referenced.has(path.resolve(item.dir)) || item.dir === newest.dir) kept.push(item.dir)
      else doomed.push(item.dir)
    }
  }

  const removed = []
  for (const dir of doomed) {
    removeDir(dir)
    if (!fs.existsSync(dir)) removed.push(dir)
  }
  return { removed, kept }
}

async function clonePack(pack, dir, git) {
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  const args = ['clone', '--depth', '1', '--filter=blob:none', '--sparse']
  if (pack.branch) args.push('--branch', pack.branch)
  args.push('--single-branch', '--', pack.repo, dir)
  const clone = await git(args)
  if (!clone.ok) {
    removeDirSafe(dir)
    return { ok: false, error: `git clone 失败：${clone.stderr.trim().split('\n').slice(-2).join(' | ')}` }
  }
  // HackTricks and other large docs repos exceed the legacy Windows MAX_PATH.
  // Keep this local to each managed clone instead of depending on machine-wide config.
  await git(['config', 'core.longpaths', 'true'], { cwd: dir })
  return { ok: true }
}

/**
 * Rebuild a managed pack clone after a shallow history diverges.
 *
 * Imported packs are mirrors, but users can still edit the import layer. The old
 * checkout is renamed to a timestamped backup before the fresh clone is moved
 * into place, so a failed pull never silently destroys local work.
 */
async function recoverDivergedPack(pack, dir, pull, git) {
  const parent = path.dirname(dir)
  const stamp = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = path.join(parent, `.${pack.id}.recover-${stamp}`)
  const backup = path.join(parent, `.${pack.id}.diverged-${stamp}`)

  const cloned = await clonePack(pack, tmp, git)
  if (!cloned.ok) return { recovered: false, error: cloned.error }

  const sparse = await ensureSparseCheckout(pack, tmp, git)
  if (!sparse.ok) {
    removeDirSafe(tmp)
    return { recovered: false, error: sparse.error }
  }

  try {
    fs.renameSync(dir, backup)
  } catch (error) {
    removeDirSafe(tmp)
    return { recovered: false, error: `旧目录备份失败：${error.message}` }
  }

  try {
    fs.renameSync(tmp, dir)
  } catch (error) {
    try { fs.renameSync(backup, dir) } catch { /* keep the backup path visible in the error */ }
    removeDirSafe(tmp)
    return { recovered: false, error: `新目录就位失败：${error.message}；旧目录：${backup}` }
  }

  return {
    recovered: true,
    backup,
    reason: pull.stderr.trim().split('\n').slice(-2).join(' | '),
  }
}

export async function syncPack(pack, options = {}) {
  const dir = packDir(pack)
  const exists = fs.existsSync(dir)
  const hasGit = fs.existsSync(path.join(dir, '.git'))
  const git = options.git || runGit
  let mode = exists ? 'update' : 'clone'
  let recovery
  if (exists && !hasGit) {
    return { id: pack.id, ok: false, mode: 'conflict', error: `目录已存在但不是托管仓库：${dir}` }
  }

  // 统一出站策略总闸：冻结档下 git 一次都不跑（在 clone/pull 之前拦）
  const gate = options.gate ? await options.gate(pack) : await gateInfraEgress({ source: pack.repo, note: `${pack.id} ${pack.repo}` })
  if (gate && gate.decision === 'deny') {
    return { id: pack.id, ok: false, mode: 'blocked', error: `统一出站策略拦截（${gate.reason} / mode=${gate.mode}）：${pack.repo}` }
  }

  if (!exists) {
    const clone = await clonePack(pack, dir, git)
    if (!clone.ok) return { id: pack.id, ok: false, mode, error: clone.error }
  } else {
    await git(['config', 'core.longpaths', 'true'], { cwd: dir })
    const args = ['pull', '--ff-only', '--depth', '1', '--quiet']
    if (pack.branch) args.push('origin', pack.branch)
    const pull = await git(args, { cwd: dir })
    if (!pull.ok) {
      recovery = await recoverDivergedPack(pack, dir, pull, git)
      if (!recovery.recovered) {
        const pullError = pull.stderr.trim().split('\n').slice(-2).join(' | ')
        return { id: pack.id, ok: false, mode, error: `git pull 失败：${pullError}；自动恢复失败：${recovery.error}` }
      }
      mode = 'recover'
    }
  }

  const sparse = await ensureSparseCheckout(pack, dir, git)
  if (!sparse.ok) return { id: pack.id, ok: false, mode, error: sparse.error }

  const head = await git(['rev-parse', '--short', 'HEAD'], { cwd: dir })
  return {
    id: pack.id,
    ok: true,
    mode,
    path: dir,
    commit: head.ok ? head.stdout.trim() : '',
    files: countIndexableFiles(dir),
    recovered: !!recovery?.recovered,
    backup: recovery?.backup || '',
  }
}

function shouldSync(pack, state, catalog, force) {
  if (!pack.enabled || (!pack.autoInstall && !force)) return false
  if (state.syncMode === 'frozen') return false
  if (state.syncMode === 'manual' && !force) return false
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
      backup: previous.backup || '',
    }
  })
  return {
    release: catalog.release,
    autoSyncIntervalDays: catalog.autoSyncIntervalDays,
    syncMode: state.syncMode,
    total: packs.length,
    installed: packs.filter((p) => p.installed).length,
    failed: packs.filter((p) => p.error).length,
    packs,
  }
}

export async function syncPacks(options = {}) {
  const catalog = loadCatalog()
  const state = readState()
  if (state.syncMode === 'frozen' && !options.allowFrozen) {
    return {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      requested: 0,
      ok: 0,
      failed: 0,
      skipped: true,
      reason: '知识同步已冻结',
      results: [],
    }
  }
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
      backup: result.backup || '',
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
  // 顺手回收同步残骸（临时 clone / 旧仓库备份）。这不是"顺手加功能"：
  // 不回收的话每次分歧恢复都留一整份仓库，实测几天就堆了 42MB。
  try {
    summary.debris = prunePackDebris(importsRoot(), state)
  } catch {
    // 回收失败不影响同步结论。
  }
  return summary
}

export function packRoots(importsPath, catalog = loadCatalog()) {
  const packById = new Map(catalog.packs.map((pack) => [pack.id, pack]))
  const roots = []
  if (!fs.existsSync(importsPath)) return roots
  for (const entry of fs.readdirSync(importsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'exploitdb' || entry.name.startsWith('.') || /\.(?:diverged|recover)-/.test(entry.name)) continue
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
