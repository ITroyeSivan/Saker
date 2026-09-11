// 内置模型代理的**活体**测试：真起一个代理，真打上游。
//
// 与 run.mjs 分开，因为它需要联网、需要真实 API Key —— 不适合进离线测试套件。
// 跑法：
//   cd plugins/dsh-sec-config
//   node --import ../../scripts/test-stub-register.mjs test/live-upstream.mjs
//
// 密钥从 dsh 凭据库读（~/.dsh/.credentials.yaml 的 refs.CUSTOM_API_KEY）。
import fs from 'node:fs'
import { startModelProxy } from '../lib/model-proxy.js'

// 默认用一个冷端口：8788/18788 很可能已被正在运行的代理（宿主内置的或用户自备的）占用。
// 撞了就换：PROXY_TEST_PORT=18xxx node ... test/live-upstream.mjs
const PORT = Number(process.env.PROXY_TEST_PORT) || 18789
const key = (() => {
  try {
    const text = fs.readFileSync(process.env.USERPROFILE + '/.dsh/.credentials.yaml', 'utf8')
    const m = text.match(/CUSTOM_API_KEY:\s*'?([^'\r\n]+)'?/)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
})()

let pass = 0
let fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`ok   ${label}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`FAIL ${label}${extra ? '  ' + extra : ''}`) }
}

if (!key) {
  console.log('skip 未找到 CUSTOM_API_KEY（~/.dsh/.credentials.yaml），跳过活体测试')
  process.exit(0)
}

const proxy = await startModelProxy({
  host: '127.0.0.1',
  port: PORT,
  upstreamBase: 'https://opencode.ai/zen/go',
  log: (line) => console.log('     [proxy] ' + line),
})

try {
  const health = await (await fetch(`http://127.0.0.1:${PORT}/__health`)).json()
  ok('/__health 标识为内置代理', health.ok === true && health.kind === 'builtin',
    JSON.stringify(health).slice(0, 110))

  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      max_tokens: 8,
      stream: false,
      agent: 'junk',
      traceId: 'junk',
      messages: [{ role: 'user', content: '只回复两个字：通了', usage: { x: 1 }, reasoning: 'junk' }],
    }),
  })
  const text = await res.text()
  ok('补会话头后上游返回 200（直连同一请求会 400 MissingSessionID）', res.status === 200, 'status=' + res.status)
  ok('拿到模型回复', /"content"/.test(text), text.slice(0, 110))

  const after = await (await fetch(`http://127.0.0.1:${PORT}/__health`)).json()
  ok('统计记到转发与剥字段', after.stats.requests >= 1 && after.stats.stripped > 0, JSON.stringify(after.stats))
} finally {
  await proxy.close()
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`)
process.exit(fail ? 1 : 0)
