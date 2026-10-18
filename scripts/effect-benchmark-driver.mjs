#!/usr/bin/env node
// 驱动 @saker-dev/effect-benchmark 的插件通道（不开浏览器、不点 UI）。
//
// 协议来自宿主 packages/client/connection/src/rpc-host.ts：
//   · `connection.register(ctx, channel, handler)` 把**绝对 channel** 注册成 web 服务器的
//     前缀 HTTP 路由；端点由路径决定：POST <base><channel>/<endpoint>
//   · body = { type: 'client-request', rpcId, method, payload }
//     —— `method` 必须等于路径里的 endpoint，否则返回 gateway/bad-request；
//        content-type 必须是 application/json；GET 一律 404
//   · 返回 { type: 'server-response', rpcId, result: { ok:true, value } | { ok:false, error } }
//
// 两个容易踩错的点（本文件存在的理由）：
//   1) 这是**插件通道**，不是 `/api` 共享通道 —— payload 直接是插件参数，
//      不要像 rpc-call.mjs 那样包成 { args }。
//   2) 路由有 operator/loopback 准入：必须先 `GET <base>/?token=…` 拿到会话 cookie。
//
// 用法:
//   node scripts/effect-benchmark-driver.mjs --base <url> --token <launchToken> inventory
//   node scripts/effect-benchmark-driver.mjs --base <url> --token-file <path> start --payload '<json>'
//   node scripts/effect-benchmark-driver.mjs --base <url> --token-file <path> status --run-id <id>
// 退出码: 0 成功 / 1 通道或 HTTP 失败 / 2 用法错误
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const CHANNEL = '/saker-effect-benchmark'

/** 取会话 cookie（宿主用登录跳转下发）。 */
export async function login({ base, token, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token) throw new Error('launch token is required')
  const response = await fetchImpl(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookie = (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
  if (!cookie) throw new Error(`login failed: no session cookie (HTTP ${response.status})`)
  return cookie
}

/** 打一个插件端点，返回 result.value；失败一律抛出可读错误。 */
export async function callChannel({ base, cookie, endpoint, payload = {}, channel = CHANNEL, fetchImpl = fetch }) {
  const rpcId = randomUUID()
  const response = await fetchImpl(`${base}${channel}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
  let body
  try { body = JSON.parse(text) } catch { throw new Error(`response is not JSON: ${text.slice(0, 200)}`) }
  if (body?.type !== 'server-response') throw new Error(`unexpected envelope: ${text.slice(0, 200)}`)
  // rpcId 对不上说明协议变了（或串了响应）—— 宁可报错也不要拿错结果。
  if (body.rpcId !== rpcId) throw new Error(`rpcId mismatch (protocol drift): sent ${rpcId}, got ${body.rpcId}`)
  const result = body.result
  if (!result || typeof result !== 'object') throw new Error(`missing result: ${text.slice(0, 200)}`)
  if (result.ok !== true) {
    // 端点自己可能返回字符串错误（`{ ok:false, error:'…' }`），也可能是宿主风格的 {code,message}。
    // 只认对象会把「冻结版本未安装」这类关键原因显示成 `channel error ?: unknown`（踩过）。
    if (typeof result.error === 'string') throw new Error(`channel error: ${result.error}`)
    throw new Error(`channel error ${result.error?.code ?? '?'}: ${result.error?.message ?? 'unknown'}`)
  }
  return result.value
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1] ?? true; i++ }
    else positional.push(argv[i])
  }
  return { flags, positional }
}

// 只有被当作脚本直接运行时才走 CLI（被测试 import 时不要动 process.exit）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const base = String(flags.base ?? '').replace(/\/$/, '')
  const token = flags['token-file'] ? readFileSync(String(flags['token-file']), 'utf8').trim() : flags.token
  const action = positional[0]
  if (!base || !action) {
    console.error('usage: node scripts/effect-benchmark-driver.mjs --base <url> (--token <t>|--token-file <f>) <inventory|start|status|stop> [--payload <json>] [--run-id <id>]')
    process.exit(2)
  }
  try {
    const cookie = await login({ base, token })
    const payload = {}
    if (flags.payload) Object.assign(payload, JSON.parse(String(flags.payload)))
    if (flags['run-id']) payload.runId = String(flags['run-id'])
    const value = await callChannel({ base, cookie, endpoint: action, payload })
    console.log(JSON.stringify(value, null, 2))
  } catch (error) {
    console.error('FAILED: ' + (error?.message ?? error))
    process.exit(1)
  }
}
