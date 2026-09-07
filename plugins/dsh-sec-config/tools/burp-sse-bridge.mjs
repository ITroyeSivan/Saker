#!/usr/bin/env node
// burp-sse-bridge.mjs — stdio JSON-RPC ↔ Burp legacy SSE.
//
// Burp's `burp-mcp-all.jar` exposes one HTTP endpoint that combines a server-
// sent event stream and POST-on-message semantics ("legacy SSE" transport,
// spec 2024-11-05). mcp-studio only speaks stdio or streamable-http, so this
// thin bridge re-shapes Burp's SSE into the stdio framing the MCP SDK expects.
//
// Lifecycle:
//   1. GET <sse-url>/ → SSE stream. First event arrives as
//      `event: endpoint\ndata: ?sessionId=<id>`. Stash the session id.
//   2. Subsequent SSE events with `event: message` carry JSON-RPC responses
//      from the server; route them by `id` back to the matching stdio caller.
//   3. Client requests on stdin are POSTed to <sse-url>/message?<sessionId>.
//      The Burp SSE server replies asynchronously on the open SSE stream.
//
// Usage:
//   node burp-sse-bridge.mjs --sse-url http://127.0.0.1:9876
//
// Exits non-zero if the SSE handshake fails (Burp not running, wrong URL).

import process from 'node:process'

const args = process.argv.slice(2)
function getArg(name, fallback) {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  const eq = hit.indexOf('=')
  return eq >= 0 ? hit.slice(eq + 1) : (args[args.indexOf(hit) + 1] ?? fallback)
}

const SSE_URL = getArg('sse-url', process.env.DSH_BURP_SSE_URL || 'http://127.0.0.1:9876').replace(/\/+$/, '')
const REQUEST_TIMEOUT_MS = Number(getArg('timeout-ms', '30000'))

process.stdin.setEncoding('utf8')

let sessionId = null
let sessionReady = null
let resolveSession = null
let sessionReadyReject = null
sessionReady = new Promise((r, rj) => { resolveSession = r; sessionReadyReject = rj })
let connected = false
let closed = false
const inflight = new Map() // id -> { resolve, reject, timer }
let lineBuf = ''
const waitingForSession = [] // pending dispatches buffered until handshake completes

function log(...rest) {
  process.stderr.write('[burp-bridge] ' + rest.join(' ') + '\n')
}

function writeOut(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function failResponse(id, message) {
  if (id === undefined) return
  writeOut({ jsonrpc: '2.0', id, error: { code: -32603, message } })
}

function startSse() {
  const ctrl = new AbortController()
  fetch(SSE_URL + '/', {
    method: 'GET',
    headers: { accept: 'text/event-stream', 'cache-control': 'no-store' },
    signal: ctrl.signal,
  }).then(async (resp) => {
    if (!resp.ok || !resp.body) throw new Error(`SSE handshake ${resp.status} ${resp.statusText}`)
    connected = true
    // Do NOT resolve sessionReady here — sessionId is only known after the
    // first `event: endpoint` SSE frame arrives. The MCP SDK calls
    // `client.connect()` which writes `initialize()` to stdin immediately;
    // if we resolved early, dispatch would fire the "bridge not connected
    // to Burp SSE yet" reject before the session is actually usable.
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (!closed) {
      const { done, value } = await reader.read()
      if (done) { log('SSE stream closed by server'); break }
buf += decoder.decode(value, { stream: true })
    // SSE spec allows CRLF or LF record separators; Burp emits CRLF, others LF.
    buf = buf.replace(/\r\n/g, '\n')
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      handleEvent(block)
    }
    }
  }).catch((err) => {
    if (closed) return
    log('SSE handshake failed:', err.message)
    sessionReadyReject?.(err)
    process.exit(1)
  })
}

function handleEvent(block) {
  let event = 'message'
  let data = ''
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!data) return
  if (event === 'endpoint' && data.startsWith('?sessionId=')) {
    sessionId = data
    log('session established:', sessionId)
    // Now that sessionId is set, release any dispatches waiting on sessionReady.
    resolveSession()
    return
  }
  if (event === 'message') {
    let msg
    try { msg = JSON.parse(data) } catch (err) { log('bad JSON from server:', err.message); return }
    if (msg.id !== undefined) {
      const p = inflight.get(msg.id)
      if (p) {
        clearTimeout(p.timer)
        inflight.delete(msg.id)
        p.resolve(msg)
      } else {
        log('response for unknown id', msg.id)
      }
    } else {
      // server-initiated notification — pass straight through
      writeOut(msg)
    }
  }
}

async function sendRequest(msg) {
  await sessionReady
  if (!sessionId) throw new Error('no session yet')
  // Burp's `endpoint` event data is `?sessionId=<id>` — a relative query-only
  // path anchored at the SSE connection's URL. Joining with the base path
  // yields POST /?sessionId=... (  /message?sessionId=... returns 404 here).
  const sep = SSE_URL.endsWith('/') ? '' : '/'
  const url = `${SSE_URL}${sep}${sessionId}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(msg),
  })
  if (!resp.ok) throw new Error(`POST ${url} -> ${resp.status} ${resp.statusText}`)
  // The HTTP body is just an ack; the actual reply rides the SSE channel.
  // (Burp returns 202 with empty body.)
}

function dispatch(line) {
  let msg
  try { msg = JSON.parse(line) } catch (err) { log('bad JSON from client:', err.message); return }
  if (msg.id === undefined) {
    // client-initiated notification (e.g. notifications/initialized) — forward, no reply expected
    sessionReady.then(() => {
      if (!sessionId) { log('dropping client notification: no session yet'); return }
      sendRequest(msg).catch((err) => log('notification forward failed:', err.message))
    })
    return
  }
  sessionReady.then(() => {
    if (!sessionId) { failResponse(msg.id, 'bridge not connected to Burp SSE yet'); return }
    const entry = {
      resolve: (reply) => writeOut(reply),
      reject: (err) => failResponse(msg.id, String(err && err.message || err)),
      timer: setTimeout(() => {
        if (inflight.has(msg.id)) {
          inflight.delete(msg.id)
          failResponse(msg.id, `request ${msg.id} timed out`)
        }
      }, REQUEST_TIMEOUT_MS),
    }
    inflight.set(msg.id, entry)
    sendRequest(msg).catch((err) => {
      if (inflight.has(msg.id)) {
        clearTimeout(entry.timer)
        inflight.delete(msg.id)
        failResponse(msg.id, String(err && err.message || err))
      }
    })
  })
}

process.stdin.on('data', (chunk) => {
  lineBuf += chunk
  let i
  while ((i = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, i).replace(/\r$/, '').trim()
    lineBuf = lineBuf.slice(i + 1)
    if (line) dispatch(line)
  }
})

process.stdin.on('end', () => { closed = true; log('stdin closed'); process.exit(0) })
process.on('SIGTERM', () => { closed = true; process.exit(0) })
process.on('SIGINT', () => { closed = true; process.exit(0) })

startSse()
