import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readCompetitionChallenge } from './competition-store.js'
import { readSceneContext } from './scene-context.js'

const RUNNING = new Map()
const MAX_MEMORY = 1024 * 1024
const READ_CHUNK = 65536
const nowIso = () => new Date().toISOString()
const safe = value => String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
const parse = row => { try { return row ? JSON.parse(row.record) : null } catch { return null } }

export function publicCompetitionExecution(record) {
  if (!record) return null
  const {
    child, deadlineTimer, dirs, stdout, stderr, memory, ...publicRecord
  } = record
  return publicRecord
}

function competitionSettings(store, sessionId) {
  const scene = readSceneContext(store, sessionId, 'ctf-solver')
  if (!scene || scene.sceneId !== 'competition') return null
  const configured = scene.preferences && typeof scene.preferences === 'object' && Object.keys(scene.preferences).length > 0
  const preferences = configured ? scene.preferences : {}
  const minutes = Number(preferences.budget?.minutes)
  const startedAt = Date.parse(preferences.budget?.startedAt || preferences.updatedAt || '')
  const deadlineAt = Number.isFinite(minutes) && minutes > 0 && Number.isFinite(startedAt)
    ? startedAt + minutes * 60000
    : null
  return { preferences, configured, deadlineAt, continuationPaused: scene.continuationPaused === true,
    controlReason: String(scene.continuationReason || '') }
}

function parseEnv(value) {
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out[key] = String(item)
  }
  return out
}

function challengeRoot(sessionId, challengeId) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'competition', safe(sessionId), safe(challengeId))
}

function competitionToolBudgetDenial(store, sessionId, settings) {
  const limit = settings?.preferences?.budget?.toolCalls
  if (!Number.isInteger(limit) || limit < 1) return ''
  const rows = store.db.prepare('SELECT record FROM competition_executions WHERE session_id=?').all(sessionId)
  const used = rows.map(row => parse(row)).filter(record => record
    && !record.idempotent).length
  return used >= limit ? 'competition tool-call budget exhausted (' + limit + ')' : ''
}

function ensureDirs(sessionId, challengeId) {
  const root = challengeRoot(sessionId, challengeId)
  const dirs = { root, input: path.join(root, 'input'), work: path.join(root, 'work'), output: path.join(root, 'output') }
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
  return dirs
}

export function readCompetitionExecution(store, sessionId, challengeId, executionId) {
  return parse(store.db.prepare('SELECT record FROM competition_executions WHERE session_id=? AND challenge_id=? AND execution_id=?')
    .get(sessionId, challengeId, executionId))
}

export function listCompetitionExecutions(store, sessionId, challengeId) {
  return store.db.prepare('SELECT record FROM competition_executions WHERE session_id=? AND challenge_id=? ORDER BY updated_at DESC')
    .all(sessionId, challengeId).map(parse).filter(Boolean)
}

function saveExecution(store, record) {
  store.db.prepare('INSERT INTO competition_executions(session_id,challenge_id,execution_id,state,record,updated_at) VALUES(?,?,?,?,?,?) '
    + 'ON CONFLICT(session_id,challenge_id,execution_id) DO UPDATE SET state=excluded.state,record=excluded.record,updated_at=excluded.updated_at')
    .run(record.sessionId, record.challengeId, record.executionId, record.state,
      JSON.stringify(record, (key, value) => ['child', 'deadlineTimer'].includes(key) ? undefined : value), record.updatedAt)
  return record
}

function appendOutput(state, stream, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  const output = state[stream + 'File']
  fs.appendFileSync(output, buffer)
  state[stream] += buffer.toString('utf8')
  if (Buffer.byteLength(state[stream]) > MAX_MEMORY) {
    const keep = Buffer.from(state[stream]).subarray(-Math.floor(MAX_MEMORY / 2))
    let text = keep.toString('utf8')
    while (text && text.charCodeAt(0) >= 0xDC00 && text.charCodeAt(0) <= 0xDFFF) text = text.slice(1)
    state[stream] = text
  }
  state.memory = Buffer.byteLength(state.stdout) + Buffer.byteLength(state.stderr)
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function ownedLiveExecution(sessionId, challengeId, current) {
  const live = RUNNING.get(current?.executionId)
  if (!live || live.state !== 'running') return null
  if (live.sessionId !== sessionId || live.challengeId !== challengeId
    || Number(live.instanceRevision || 1) !== Number(current?.instanceRevision || 1)) return null
  return live
}

function materialBuffer(store, sessionId, materialId) {
  if (!materialId) return null
  const row = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sessionId, materialId)
  if (!row) return null
  try {
    const record = JSON.parse(row.record)
    if (record?.source !== 'competition-output' || typeof record.originalBase64 !== 'string') return null
    const buffer = Buffer.from(record.originalBase64, 'base64')
    if (record.digest && createHash('sha256').update(buffer).digest('hex') !== record.digest) return null
    return buffer
  } catch { return null }
}

export function recoverCompetitionExecutions(store) {
  for (const row of store.db.prepare("SELECT record FROM competition_executions WHERE state IN ('starting','running')").all()) {
    const record = parse(row)
    if (!record) continue
    if (RUNNING.has(record.executionId)) continue
    // A PID is not proof that the process is the one Saker started. After restart
    // keep the execution unknown until its owner/container identity can be checked.
    saveExecution(store, { ...record, state: 'unknown',
      recoveredAfterRestart: true,
      recoveryReason: processAlive(record.pid) ? 'pid-exists-but-owner-identity-unverified' : 'owner-process-not-observed',
      updatedAt: nowIso() })
  }
}

export function runCompetitionExecution(store, sessionId, challengeId, input = {}) {
  const challenge = readCompetitionChallenge(store, sessionId, challengeId)
  if (!challenge) throw new Error('competition challenge not found')
  const settings = competitionSettings(store, sessionId)
  if (settings?.deadlineAt !== null && settings?.deadlineAt !== undefined && Date.now() >= settings.deadlineAt)
    throw new Error('competition time limit exhausted; update the time setting before starting another action')
  if (settings && String(settings.preferences.interaction || 'auto') !== 'auto')
    throw new Error('competition interaction confirmation is not supported for arbitrary managed commands; keep the automatic mode or execute the confirmed step outside competition_execution')
  if (settings?.configured) {
    const limit = Math.max(1, (Number(settings.preferences.workers) || 0) + 1)
    const active = [...RUNNING.values()].filter(record => record.sessionId === sessionId
      && ['running', 'stopping'].includes(record.state)).length
    if (active >= limit)
      throw new Error('competition concurrency limit reached (' + limit + '); stop an execution or change the worker setting')
  }
  const command = typeof input.command === 'string' ? input.command : ''
  if (!command.trim()) throw new Error('command required')
  if (command.length > 200000) throw new Error('command exceeds limit')
  const environment = input.environment === 'docker' ? 'docker' : input.environment === 'host' ? 'host' : challenge.environment.kind
  const image = String(input.image || challenge.environment.image || '').trim()
  const requestId = String(input.requestId || '').trim()
  const instanceRevision = Math.max(1, Number(challenge.instance?.revision) || 1)
  const network = input.network === 'none' || challenge.environment?.network === 'none' ? 'none' : 'bridge'
  if (requestId) {
    const duplicate = findExecutionByRequest(store, sessionId, challengeId, requestId)
    if (duplicate) {
      if (duplicate.command !== command || duplicate.environment !== environment || String(duplicate.image || '') !== image
        || Number(duplicate.instanceRevision || 1) !== instanceRevision
        || String(duplicate.network || 'bridge') !== network)
        throw Object.assign(new Error('competition requestId was already used with different execution content'), { code: 'competition-request-conflict' })
      return { ...publicCompetitionExecution(duplicate), idempotent: true }
    }
  }
  if (settings?.continuationPaused)
    throw Object.assign(new Error('competition task is paused or cancelled; resume before starting another action'), {
      code: 'competition-task-paused',
    })
  const toolBudgetDenial = competitionToolBudgetDenial(store, sessionId, settings)
  if (toolBudgetDenial) throw Object.assign(new Error(toolBudgetDenial), { code: 'competition-tool-budget-exhausted' })
  if (environment === 'docker') inspectDockerImage(image)
  const dirs = ensureDirs(sessionId, challengeId)
  const executionId = 'competition-execution-' + randomUUID()
  let child, containerName = ''
  const at = nowIso()
  const stdoutFile = path.join(dirs.output, executionId + '.stdout.log')
  const stderrFile = path.join(dirs.output, executionId + '.stderr.log')
  if (environment === 'docker') {
    containerName = 'saker-' + executionId.toLowerCase()
    child = spawn('docker', ['run', '--rm', '-i', '--pull=never', '--network', network, '--name', containerName,
      '-v', dirs.input + ':/input:ro', '-v', dirs.work + ':/work', '-v', dirs.output + ':/output',
      '-w', '/work', image, '/bin/sh'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
  } else if (process.platform === 'win32') {
    child = spawn(command, { cwd: dirs.work, env: { ...process.env, ...parseEnv(input.env) }, windowsHide: true, shell: process.env.ComSpec || 'cmd.exe', stdio: ['pipe', 'pipe', 'pipe'] })
  } else {
    child = spawn(command, { cwd: dirs.work, env: { ...process.env, ...parseEnv(input.env) }, shell: process.env.SHELL || '/bin/sh', stdio: ['pipe', 'pipe', 'pipe'] })
  }
  const state = {
    sessionId, challengeId, executionId, state: 'running', pid: child.pid || null, child,
    environment, image, command, containerName, dirs, instanceRevision, network,
    workDir: dirs.work, inputDir: dirs.input, outputDir: dirs.output,
    stdoutFile, stderrFile, stdout: '', stderr: '', memory: 0,
    requestId, requestFingerprint: requestId ? JSON.stringify([command, environment, image, instanceRevision, network]) : '',
    startedAt: at, deadlineAt: settings?.deadlineAt ?? null, timedOut: false,
    endedAt: null, exitCode: null, signal: null, updatedAt: at,
  }
  fs.writeFileSync(stdoutFile, Buffer.alloc(0))
  fs.writeFileSync(stderrFile, Buffer.alloc(0))
  RUNNING.set(executionId, state)
  child.stdout.on('data', chunk => appendOutput(state, 'stdout', chunk))
  child.stderr.on('data', chunk => appendOutput(state, 'stderr', chunk))
  child.on('close', (code, signal) => {
    if (state.deadlineTimer) clearTimeout(state.deadlineTimer)
    if (!['stopping', 'stopped'].includes(state.state)) {
      state.state = code === 0 ? 'completed' : 'failed'
      state.exitCode = code
      state.signal = signal
      state.endedAt = nowIso()
      state.updatedAt = state.endedAt
      try { saveExecution(store, state) } catch { /* store may be closing */ }
    }
    RUNNING.delete(executionId)
  })
  child.on('error', error => {
    if (state.deadlineTimer) clearTimeout(state.deadlineTimer)
    if (['stopping', 'stopped'].includes(state.state)) return
    state.state = 'failed'
    state.error = error.message
    state.endedAt = nowIso()
    state.updatedAt = state.endedAt
    try { saveExecution(store, state) } catch { /* store may be closing */ }
    RUNNING.delete(executionId)
  })
  saveExecution(store, state)
  if (Number.isFinite(state.deadlineAt)) {
    state.deadlineTimer = setTimeout(() => {
      if (state.state !== 'running') return
      state.timedOut = true
      state.stopReason = 'time_limit_exhausted'
      try { stopCompetitionExecution(store, sessionId, challengeId, executionId) }
      catch (error) {
        state.stopError = String(error.message || error)
        state.updatedAt = nowIso()
        try { saveExecution(store, state) } catch { /* store may be closing */ }
      }
    }, Math.max(0, state.deadlineAt - Date.now()))
    state.deadlineTimer.unref?.()
    saveExecution(store, state)
  }
  if (environment === 'docker') child.stdin.write(command + '\n')
  return publicCompetitionExecution(state)
}

export function readCompetitionOutput(store, sessionId, challengeId, executionId, input = {}) {
  const current = readCompetitionExecution(store, sessionId, challengeId, executionId)
  if (!current) throw new Error('competition execution not found')
  const live = ownedLiveExecution(sessionId, challengeId, current)
  const legacyOffset = Math.max(0, Math.trunc(Number(input.offset) || 0))
  const stdoutOffset = Math.max(0, Math.trunc(Number(input.stdoutOffset ?? legacyOffset) || 0))
  const stderrOffset = Math.max(0, Math.trunc(Number(input.stderrOffset ?? legacyOffset) || 0))
  const max = Math.max(1, Math.min(65536, Number(input.maxBytes) || 16384))
  const fileStdout = readFileSlice(current.stdoutFile, stdoutOffset, max)
  const fileStderr = readFileSlice(current.stderrFile, stderrOffset, max)
  const stdoutMaterial = fileStdout.missing ? materialBuffer(store, sessionId, current.stdoutMaterialId) : null
  const stderrMaterial = fileStderr.missing ? materialBuffer(store, sessionId, current.stderrMaterialId) : null
  const stdout = stdoutMaterial ? readBufferSlice(stdoutMaterial, stdoutOffset, max) : fileStdout
  const stderr = stderrMaterial ? readBufferSlice(stderrMaterial, stderrOffset, max) : fileStderr
  if (current.stdoutMissing) stdout.missing = true
  if (current.stderrMissing) stderr.missing = true
  return {
    executionId, state: live?.state || current.state, pid: current.pid, environment: current.environment,
    instanceRevision: current.instanceRevision || 1,
    workDir: current.workDir, stdinOpen: !!live && live.state === 'running',
    stdout, stderr, stdoutOffset, stderrOffset,
    nextStdoutOffset: stdout.nextOffset, nextStderrOffset: stderr.nextOffset,
    nextOffset: Math.max(stdout.nextOffset, stderr.nextOffset),
    exitCode: live?.exitCode ?? current.exitCode, endedAt: live?.endedAt || current.endedAt || null,
    deadlineAt: current.deadlineAt || null, timedOut: live?.timedOut === true || current.timedOut === true,
    stopReason: live?.stopReason || current.stopReason || '',
  }
}

function readFileSlice(file, offset, length) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const totalBytes = fs.fstatSync(fd).size
    const start = Math.min(offset, totalBytes)
    const count = Math.max(0, Math.min(totalBytes - start, length + 4))
    const buffer = Buffer.allocUnsafe(count)
    const bytesRead = count ? fs.readSync(fd, buffer, 0, count, start) : 0
    const raw = buffer.subarray(0, bytesRead)
    const boundary = utf8Boundary(raw, Math.min(raw.length, length))
    const slice = raw.subarray(0, boundary)
    return {
      text: slice.toString('utf8'),
      bytes: slice.length,
      totalBytes,
      nextOffset: start + slice.length,
      hasMore: start + slice.length < totalBytes,
    }
  } catch {
    return { text: '', bytes: 0, totalBytes: 0, nextOffset: offset, hasMore: false, missing: true }
  } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch { /* closed */ } }
}

function utf8Boundary(buffer, end) {
  if (end <= 0 || end >= buffer.length) return Math.max(0, end)
  let index = end
  while (index > 0 && (buffer[index] & 0xC0) === 0x80) index -= 1
  if (index === end) return end
  const lead = buffer[index]
  const needed = lead < 0x80 ? 1 : lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1
  return index + needed <= end ? end : index
}

function readBufferSlice(buffer, offset, length) {
  const start = Math.max(0, Math.min(buffer.length, offset))
  const count = Math.max(0, Math.min(buffer.length - start, length + 4))
  const raw = buffer.subarray(start, start + count)
  const boundary = utf8Boundary(raw, Math.min(raw.length, length))
  const slice = raw.subarray(0, boundary)
  return {
    text: slice.toString('utf8'), bytes: slice.length, totalBytes: buffer.length,
    nextOffset: start + slice.length, hasMore: start + slice.length < buffer.length, missing: false,
  }
}

export function writeCompetitionInput(store, sessionId, challengeId, executionId, input = {}) {
  const current = readCompetitionExecution(store, sessionId, challengeId, executionId)
  if (!current) throw new Error('competition execution not found')
  const rawLive = RUNNING.get(executionId)
  const live = ownedLiveExecution(sessionId, challengeId, current)
  if (rawLive && !live) return {
    ok: false, executionId,
    error: 'competition execution is owned by another task or instance',
    code: 'competition-execution-not-owned',
  }
  if (!live || live.state !== 'running' || !live.child?.stdin?.writable) return {
    ok: false, executionId, error: 'process stdin is not open', code: 'competition-stdin-closed',
  }
  const value = typeof input.text === 'string' ? input.text : ''
  if (!value) throw new Error('stdin text required')
  live.child.stdin.write(value + (input.newline === false ? '' : '\n'))
  return { ok: true, executionId, writtenBytes: Buffer.byteLength(value + (input.newline === false ? '' : '\n')) }
}

export function stopCompetitionExecution(store, sessionId, challengeId, executionId) {
  const current = readCompetitionExecution(store, sessionId, challengeId, executionId)
  if (!current) throw new Error('competition execution not found')
  const rawLive = RUNNING.get(executionId)
  const live = ownedLiveExecution(sessionId, challengeId, current)
  if (rawLive && !live) return {
    ok: false, state: current.state, executionId,
    error: 'competition execution is owned by another task or instance',
    code: 'competition-execution-not-owned',
  }
  if (!live || !['running', 'stopping'].includes(live.state)) {
    return { ok: ['completed', 'failed', 'stopped'].includes(current.state), alreadyEnded: true, state: current.state }
  }
  live.state = 'stopping'
  live.updatedAt = nowIso()
  saveExecution(store, live)
  let confirmed = false
  let reason = ''
  if (live.environment === 'docker' && live.containerName) {
    const removed = spawnSync('docker', ['rm', '-f', live.containerName], { windowsHide: true, encoding: 'utf8', timeout: 15000 })
    confirmed = removed.status === 0
    const exists = spawnSync('docker', ['inspect', live.containerName], { windowsHide: true, encoding: 'utf8', timeout: 15000 })
    if (!confirmed && exists.status !== 0 && /no such (?:object|container)|not found/i.test(String(exists.stderr || exists.stdout || '')))
      confirmed = true
    if (!confirmed) reason = String(removed.stderr || removed.stdout || exists.stderr || exists.stdout
      || 'docker container still exists or daemon could not confirm absence').trim()
  } else if (process.platform === 'win32' && live.pid) {
    const killed = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'taskkill', '/PID', String(live.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 15000 })
    confirmed = killed.status === 0 || !processAlive(live.pid)
    if (!confirmed) reason = String(killed.stderr || killed.stdout || 'process still running').trim()
  } else {
    try { live.child.kill('SIGTERM') } catch { /* already gone */ }
    const deadline = Date.now() + 1500
    while (processAlive(live.pid) && Date.now() < deadline) awaitDelay(50)
    confirmed = !processAlive(live.pid)
    if (!confirmed) reason = 'process did not exit after SIGTERM'
  }
  if (!confirmed) {
    live.state = 'running'
    live.stopError = reason
    live.updatedAt = nowIso()
    saveExecution(store, live)
    return { ok: false, state: 'running', executionId, error: reason || 'stop-not-confirmed' }
  }
  live.state = 'stopped'; live.exitCode = null; live.endedAt = nowIso(); live.updatedAt = live.endedAt
  saveExecution(store, live)
  RUNNING.delete(executionId)
  return { ok: true, state: 'stopped', executionId }
}

export function stopAllCompetitionExecutions(store, sessionId = '') {
  const stopped = []
  const sql = "SELECT session_id,challenge_id,execution_id FROM competition_executions WHERE state IN ('starting','running')"
    + (sessionId ? ' AND session_id=?' : '')
  const rows = sessionId ? store.db.prepare(sql).all(String(sessionId)) : store.db.prepare(sql).all()
  for (const row of rows) {
    try {
      const result = stopCompetitionExecution(store, row.session_id, row.challenge_id, row.execution_id)
      if (result?.state === 'stopped') stopped.push(row.execution_id)
    } catch { /* preserve the truthful running/unknown record */ }
  }
  return stopped
}

function findExecutionByRequest(store, sessionId, challengeId, requestId) {
  const rows = store.db.prepare('SELECT record FROM competition_executions WHERE session_id=? AND challenge_id=? ORDER BY updated_at DESC')
    .all(sessionId, challengeId)
  for (const row of rows) {
    const record = parse(row)
    if (record?.requestId === requestId) return record
  }
  return null
}

function inspectDockerImage(image) {
  if (!image) throw new Error('docker image is required')
  const daemon = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { windowsHide: true, encoding: 'utf8', timeout: 10000 })
  if (daemon.status !== 0) throw new Error('Docker daemon is unavailable; competition Docker execution is not ready')
  const inspected = spawnSync('docker', ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image], {
    windowsHide: true, encoding: 'utf8', timeout: 10000,
  })
  if (inspected.status !== 0) throw new Error('Docker image is not available locally; prepare it explicitly. Saker never pulls images automatically')
  const platform = String(inspected.stdout || '').trim()
  const expected = 'linux/amd64'
  if (platform !== expected) throw new Error('Docker image platform ' + platform + ' is incompatible; expected ' + expected)
  return platform
}

const awaitDelay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export { challengeRoot, ensureDirs }
