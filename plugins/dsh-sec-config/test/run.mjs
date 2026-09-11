// dsh-sec-config 离线单测：内置模型代理的剥字段与目标地址推导。
//
// 全部为纯函数，**不联网**、不起服务 —— 需要真打上游的活体测试见同目录 live-upstream.mjs。
import { sanitizeBody, outboundHeaders } from '../lib/model-proxy.js'
import { modelBaseUrl, trimUrl } from '../lib/index.js'

let pass = 0
let fail = 0
const ok = (label, cond) => {
  if (cond) {
    pass++
    console.log(`ok   ${label}`)
  } else {
    fail++
    console.log(`FAIL ${label}`)
  }
}

// 1. 目标地址推导 —— baseURL 只能到 /v1，多写一层会变成双层路径被上游 404
{
  ok('proxy：默认 127.0.0.1:8788，且只到 /v1',
    modelBaseUrl({}) === 'http://127.0.0.1:8788/v1')
  ok('proxy：自定义端口生效',
    modelBaseUrl({ mode: 'proxy', listenPort: 18788 }) === 'http://127.0.0.1:18788/v1')
  ok('proxy：不留尾斜杠（否则拼出 //chat/completions）',
    modelBaseUrl({ mode: 'proxy', listenPort: 8788 }) === 'http://127.0.0.1:8788/v1')
  ok('direct：上游只到 /v1，**不带** /chat/completions',
    modelBaseUrl({ mode: 'direct', upstream: 'https://opencode.ai/zen/go' }) === 'https://opencode.ai/zen/go/v1')
  ok('custom：原样采用并去尾斜杠',
    modelBaseUrl({ mode: 'custom', customBaseUrl: 'http://10.0.0.5:9000/v1/' }) === 'http://10.0.0.5:9000/v1')
  ok('custom：空值返回空（面板据此拦下写入）',
    modelBaseUrl({ mode: 'custom', customBaseUrl: '  ' }) === '')
  ok('trimUrl', trimUrl(' https://x.test// ') === 'https://x.test')
}

// 2. 剥私有字段
{
  const raw = Buffer.from(JSON.stringify({
    model: 'glm-5.3-flash',
    agent: 'junk',
    traceId: 'junk',
    messages: [
      { role: 'user', content: 'hi', usage: { a: 1 }, agent: 'x', messageId: 'm1', reasoning: 'r' },
      { role: 'assistant', content: [{ type: 'text', text: 'yo', annotations: [] }], traceId: 't' },
    ],
  }))
  const { body, stripped } = sanitizeBody(raw, true)
  const o = JSON.parse(body.toString('utf8'))
  ok('顶层 model 必须保留（剥错会得到「Model is not supported」）', o.model === 'glm-5.3-flash')
  ok('顶层 agent / traceId 被剥', o.agent === undefined && o.traceId === undefined)
  ok('消息上的 usage / agent / messageId / reasoning 被剥',
    o.messages[0].usage === undefined && o.messages[0].agent === undefined
    && o.messages[0].messageId === undefined && o.messages[0].reasoning === undefined)
  ok('消息上的 model 被剥（只有顶层的才合法）', o.messages[0].model === undefined)
  ok('content block 上的 annotations 被剥', o.messages[1].content[0].annotations === undefined)
  ok('统计到剥了几处', stripped > 0)
}

// 2b. 不能误伤工具 schema —— 只走「已知容器」，不做全量递归
{
  const raw = Buffer.from(JSON.stringify({
    model: 'm',
    tools: [{ type: 'function', function: { name: 'f', parameters: { properties: { usage: { type: 'string' }, model: { type: 'string' }, reasoning: { type: 'string' } } } } }],
    input: [{ role: 'user', content: 'x', usage: 1 }],
  }))
  const o = JSON.parse(sanitizeBody(raw, true).body.toString('utf8'))
  const props = o.tools[0].function.parameters.properties
  ok('工具 schema 里叫 usage / model / reasoning 的属性**不被误伤**',
    props.usage !== undefined && props.model !== undefined && props.reasoning !== undefined)
  ok('input[] 里的私有字段照剥（Responses 协议也覆盖）', o.input[0].usage === undefined)
}

// 2c. 开关与非 JSON
{
  const raw = Buffer.from('{"model":"m","agent":"x"}')
  ok('关掉开关则原样放过', sanitizeBody(raw, false).body.equals(raw))
  const bin = Buffer.from([0x00, 0x01, 0x02])
  ok('非 JSON 原样放过（文件上传等）', sanitizeBody(bin, true).body.equals(bin))
  ok('空 body 原样放过', sanitizeBody(Buffer.alloc(0), true).stripped === 0)
}

// 3. 注入头：会话头必须有值；逐跳头不能带过去
{
  const h = outboundHeaders(
    { host: 'x', connection: 'keep-alive', 'content-length': '10', authorization: 'Bearer k', 'accept-encoding': 'gzip, br' },
    { session: 'ses_test', userAgent: 'ua', clientId: 'saker', projectId: 'saker' },
  )
  ok('补上 x-opencode-session', h['x-opencode-session'] === 'ses_test')
  ok('补上 user-agent', h['user-agent'] === 'ua')
  ok('补上 x-opencode-client / project', h['x-opencode-client'] === 'saker' && h['x-opencode-project'] === 'saker')
  ok('x-opencode-request 形如 req-<hex>', /^req-[0-9a-f]{8}$/.test(h['x-opencode-request']))
  ok('authorization 原样透传（代理不碰密钥）', h.authorization === 'Bearer k')
  ok('逐跳头不外传', h.host === undefined && h.connection === undefined && h['content-length'] === undefined)
  ok('强制未压缩（避免解压后 content-encoding 错位）', h['accept-encoding'] === 'identity')
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`)
process.exit(fail ? 1 : 0)
