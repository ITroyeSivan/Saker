// Shared full-index builder used by the host, the settings UI, and the
// detached build process. Keeping this outside lib/index.js avoids loading the
// dsh host SDK in a plain Node child process.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { KnowledgeIndex, INDEX_VERSION } from './index-engine.js'
import { packRoots } from './packs.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const BUILD_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'build-index.mjs')

export function knowledgeHome(home = '') {
  return path.resolve(home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
}

function resolveSakerRoot() {
  if (process.env.SAKER_ROOT && fs.existsSync(path.join(process.env.SAKER_ROOT, 'package.json'))) {
    return path.resolve(process.env.SAKER_ROOT)
  }
  try {
    const req = createRequire(import.meta.url)
    return path.dirname(req.resolve('dsh-saker/package.json'))
  } catch {
    // Source checkout: plugin/lib -> plugin -> plugins -> repository root.
    return path.resolve(PLUGIN_ROOT, '..', '..')
  }
}

export function indexDbPath(home = '') {
  return path.join(knowledgeHome(home), 'refs', '.index', 'knowledge.sqlite')
}

export function buildStatePath(home = '') {
  return path.join(knowledgeHome(home), 'refs', '.index', 'build-state.json')
}

export function buildIndexRoots(home = '') {
  const base = knowledgeHome(home)
  const sakerRoot = resolveSakerRoot()
  const roots = []
  for (const mode of ['pentest', 'code-audit', 'ctf-solver']) {
    const root = path.join(sakerRoot, 'preset', mode, 'refs')
    if (fs.existsSync(root)) roots.push({ id: `bundle-${mode}`, kind: 'bundle', mode, root, priority: 8 })
  }
  const patt = path.join(sakerRoot, 'preset', 'shared', 'refs', 'PayloadsAllTheThings')
  if (fs.existsSync(patt)) roots.push({ id: 'patt', kind: 'patt', mode: '', root: patt, priority: 5 })
  for (const mode of ['pentest', 'code-audit', 'ctf-solver']) {
    roots.push({ id: `user-${mode}`, kind: 'user', mode, root: path.join(base, 'refs', mode), priority: 9 })
  }
  roots.push(...packRoots(path.join(base, 'refs', 'imports')))
  return roots
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

export function indexBuildStatus(home = '') {
  const state = readState(buildStatePath(home))
  if (!state) return { status: 'idle', version: INDEX_VERSION }
  if (state.status === 'running' && state.pid) {
    try {
      process.kill(Number(state.pid), 0)
    } catch {
      return { ...state, status: 'stale', error: state.error || 'build process is no longer running' }
    }
  }
  return state
}

export function buildKnowledgeIndex(options = {}) {
  const home = knowledgeHome(options.home)
  const dbPath = indexDbPath(home)
  const stateFile = buildStatePath(home)
  const roots = buildIndexRoots(home)
  const startedAt = new Date().toISOString()
  writeState(stateFile, {
    status: 'running',
    version: INDEX_VERSION,
    pid: process.pid,
    startedAt,
    roots: roots.length,
  })
  const index = new KnowledgeIndex({ dbPath, roots, logger: console })
  try {
    const result = index.rebuild({ force: options.force !== false })
    const status = index.status()
    writeState(stateFile, {
      status: 'ok',
      version: INDEX_VERSION,
      pid: process.pid,
      startedAt,
      finishedAt: new Date().toISOString(),
      roots: roots.length,
      result,
      index: status,
    })
    return { result, status }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeState(stateFile, {
      status: 'error',
      version: INDEX_VERSION,
      pid: process.pid,
      startedAt,
      finishedAt: new Date().toISOString(),
      roots: roots.length,
      error: message,
    })
    throw error
  } finally {
    index.close()
  }
}

export function startBackgroundIndexBuild(options = {}) {
  const home = knowledgeHome(options.home)
  const current = indexBuildStatus(home)
  if (current.status === 'running') return { started: false, status: current }
  const child = spawn(process.execPath, [BUILD_SCRIPT, '--force'], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DSH_HOME: home,
      SAKER_ROOT: resolveSakerRoot(),
      NODE_OPTIONS: '',
    },
  })
  child.unref()
  const state = {
    status: 'running',
    version: INDEX_VERSION,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    detached: true,
  }
  writeState(buildStatePath(home), state)
  return { started: true, status: state }
}
