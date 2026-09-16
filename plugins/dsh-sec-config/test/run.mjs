// dsh-sec-config 离线单测：内置模型代理的剥字段与目标地址推导。
//
// 全部为纯函数，**不联网**、不起服务 —— 需要真打上游的活体测试见同目录 live-upstream.mjs。
import { readFileSync } from 'node:fs'
import { sanitizeBody, outboundHeaders } from '../lib/model-proxy.js'
import { modelBaseUrl, scheduleSync, trimUrl, normalizeEndpoints, planEndpointUse, suggestEndpoints, matchEndpoint, endpointPool, unsetFailureHint, shouldCaptureBaseline } from '../lib/index.js'

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

// 4. MCP bridge 等待 mcp-studio 命名空间就绪（启动顺序竞态）
//
// mcp-studio 在自己的 apply() 里注册 `mcp-studio` 命名空间，插件激活顺序不保证，
// 所以 sec-config 第一次同步时 `settings.update()` 可能抛
// `settings namespace "mcp-studio" is not registered`（宿主实跑里就是这样）。
// 旧实现固定重试 8 次后**永久放弃** —— 一次启动竞态就变成一块永久不同步的 MCP bridge，
// 且只留一行 console.error。这里让 update 连抛 12 次再成功：旧实现必然停在 8 次，
// 新实现必须一直等到命名空间出现。timing 调小只为让测试不真等几十秒。
{
  let updates = 0
  const settings = {
    get: () => ({ servers: [] }),
    update: async (ns) => {
      if (ns !== 'mcp-studio') throw new Error(`unexpected namespace ${ns}`)
      updates += 1
      if (updates <= 12) throw new Error('settings namespace "mcp-studio" is not registered')
    },
  }
  scheduleSync(settings, { burpUrl: 'http://127.0.0.1:9876' }, null, {
    firstDelayMs: 1, maxDelayMs: 2, factor: 1.5, summarizeAt: 8,
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  ok('命名空间迟到时不会永久放弃（旧实现在第 8 次就停了）', updates > 8)
  ok('一直重试到第 13 次成功为止', updates === 13)
}

// 5. 工具区消息配色 —— msgStyle(ok) 本就支持错误色，渲染处必须读显式标记。
//    历史缺陷：渲染处硬编码 msgStyle(true)，于是「探测失败：…」「添加目录出错：…」
//    「工具名只允许字母/数字/下划线」全部显示成成功绿（#1a7f37），会误导用户。
{
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('消息渲染读显式成功标记，不再硬编码 true', src.includes('msgStyle(S.msgOk === true)') && !src.includes('style: msgStyle(true) }'))
  ok('成功后仍走成功色：恰好 6 处 msgOk 标记', (src.match(/msgOk/g) || []).length === 6)
}

// 6. 已绑定工具行必须带 title。路径 span 是 flex:1 + ellipsis，实测宽 239px、scrollWidth 442px，
//    于是 BloodHound / Kerbrute / Mimikatz / Impacket 四行显示完全一样，只能靠悬停看全路径；
//    同一份代码里的「探测预览行」本来就有 title，两处口径必须一致。
{
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('已绑定工具行的路径 span 带 title（悬停可见完整路径）', src.includes("el('span', { title: e.path,"))
  ok('探测预览行的 title 未被误删（两行口径一致）', src.includes("el('span', { title: f.path,"))
  ok('两行都是 ellipsis + nowrap（title 是唯一的补救手段）',
    (src.match(/textOverflow: 'ellipsis', whiteSpace: 'nowrap'/g) || []).length >= 2)
}

// 7. 端点档案 —— 「切回 dsh 默认」必须走 unset，**绝不能写空串**。
//    写成空串时 provider 会拿到畸形请求地址，表现为「切回默认后模型全挂」——比不切还糟。
{
  const p = planEndpointUse({ kind: 'default', baseURL: '' })
  ok('default 档 → op=unset（清除覆盖，不是 set 空串）', p.op === 'unset')
  ok('default 档不带 baseURL 值', p.baseURL === '')

  // 反向锚：如果哪天有人「顺手」把 default 也走 set，这条会亮红
  ok('default 档明确不是 set（防止退化成写空串）', p.op !== 'set')

  const c = planEndpointUse({ kind: 'proxy', baseURL: 'http://127.0.0.1:8788/v1/' })
  ok('普通档 → op=set', c.op === 'set')
  ok('地址末尾多余的斜杠被去掉（否则拼路径会出现 //）', c.baseURL === 'http://127.0.0.1:8788/v1')

  let threw = false
  try { planEndpointUse({ kind: 'custom', baseURL: 'ftp://x/y' }) } catch { threw = true }
  ok('非 http(s) 地址直接拒绝', threw)

  threw = false
  try { planEndpointUse({ kind: 'custom', baseURL: '' }) } catch { threw = true }
  ok('普通档空地址直接拒绝（空串是坏配置）', threw)

  threw = false
  try { planEndpointUse(null) } catch { threw = true }
  ok('不存在的端点直接拒绝', threw)
}

// 8. 档案归一化：id 去重 / 名称兜底 / 未知 kind 收敛成 custom
{
  const list = normalizeEndpoints([
    { id: 'a', name: 'A', baseURL: 'http://a/v1', kind: 'proxy' },
    { id: 'a', name: '', baseURL: 'http://b/v1', kind: '乱写' },
    null,
    'not-an-object',
  ])
  ok('丢弃非对象项', list.length === 2)
  ok('id 冲突自动去重（否则「删除/切换」会打错目标）', list[0].id !== list[1].id)
  ok('空名称有兜底名（列表行不会空白）', list[1].name.length > 0)
  ok('未知 kind 收敛成 custom', list[1].kind === 'custom')
  ok('非数组输入不炸', normalizeEndpoints(undefined).length === 0)
}

// 9. 建议档位必须**永远**含「dsh 默认」——否则「切回来」这个动作在 UI 上会消失
{
  const sug = suggestEndpoints({ listenHost: '127.0.0.1', listenPort: 8788, upstream: 'https://opencode.ai/zen/go' })
  ok('建议档位里一定有 default 档', sug.some((x) => x.kind === 'default'))
  ok('建议档位里一定有本机代理档', sug.some((x) => x.kind === 'proxy' && x.baseURL === 'http://127.0.0.1:8788/v1'))
  ok('上游为空时不给出空地址的直连档', suggestEndpoints({ upstream: '' }).every((x) => x.baseURL !== '' || x.kind === 'default'))
}

// 10. 命中判定：installed 为 null（无覆盖）必须命中 default 档，而不是「不匹配」
{
  const profiles = [
    { id: 'p1', name: '代理', baseURL: 'http://127.0.0.1:8788/v1', kind: 'proxy' },
    { id: 'p0', name: 'dsh 默认', baseURL: '', kind: 'default' },
  ]
  ok('无覆盖 → 命中 default 档', matchEndpoint(profiles, null)?.id === 'p0')
  ok('空串也按无覆盖处理', matchEndpoint(profiles, '')?.id === 'p0')
  ok('地址命中对应档（尾斜杠不敏感）', matchEndpoint(profiles, 'http://127.0.0.1:8788/v1/')?.id === 'p1')
  ok('都不命中时返回 null（UI 显示「不匹配任何档案」）', matchEndpoint(profiles, 'http://x/v1') === null)
}

// 11. UI 接线：设置区真的渲染了端点档案面板，且切换走 RPC（不直接改 llm-pi-ai）
{
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('Page 里渲染了端点档案面板', src.includes('React.createElement(EndpointProfiles'))
  ok('切档走 model/endpoint-use RPC', src.includes("'model/endpoint-use'"))
  ok('保存/删除走各自 RPC', src.includes("'model/endpoint-save'") && src.includes("'model/endpoint-delete'"))
  ok('切换成功后刷新 ModelLink（用 key 重挂载）', src.includes("key: 'model-' + rev"))
}

// 12. 命中池：没存档案时，界面显示的就是建议档 —— 池子必须跟着一起换，
//     否则会出现「明明写着直连上游、命中档位却说『不匹配任何档案』」的自相矛盾（实测踩到过）。
{
  const model = { listenHost: '127.0.0.1', listenPort: 18788, upstream: 'https://opencode.ai/zen/go' }

  const poolEmpty = endpointPool([], model)
  ok('档案为空时池子=建议档', poolEmpty.length > 0 && poolEmpty.some((x) => x.kind === 'default'))
  ok('在建议档上也能命中直连上游（这正是踩到的那个矛盾）',
    matchEndpoint(poolEmpty, 'https://opencode.ai/zen/go')?.kind === 'upstream')
  ok('在建议档上也能命中 dsh 默认（无覆盖）', matchEndpoint(poolEmpty, null)?.kind === 'default')

  const saved = [{ id: 'mine', name: '自建', baseURL: 'https://opencode.ai/zen/go', kind: 'custom' }]
  const poolSaved = endpointPool(saved, model)
  ok('有档案时池子只看档案（建议档不混进来）', poolSaved.length === 1 && poolSaved[0].id === 'mine')
  ok('同地址时命中用户自建档、而不是建议档', matchEndpoint(poolSaved, 'https://opencode.ai/zen/go')?.id === 'mine')
  ok('有档案时不再给出 default 建议（否则「切回默认」会出现两个入口）', !poolSaved.some((x) => x.kind === 'default'))
}

// 13. 错误文案必须收口成字符串。RPC 的 res.error 是 `{code,message,details}` **对象**，
//     直接当 React 子节点渲染会抛 React #31，宿主 error boundary 再把整个「安全配置」
//     区吞成空白 —— 一个只该显示一行红字的错误，代价是整块面板消失（实测踩到过）。
{
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('存在统一的 errText 收口函数', src.includes('function errText('))
  ok('没有把 res.error 对象直接当文本渲染的残留',
    !/text:\s*\(res\s*&&\s*res\.error\)/.test(src))
  ok('errText 会把对象拆成 message/code（不是 String(obj) 变成 [object Object]）',
    src.includes('e.message || e.code || fallback'))
  ok('errText 丢掉空 details 占位（否则文案尾巴挂一个「（{}）」）',
    src.includes("raw === '{}'") && src.includes("raw === '[]'"))
  ok('ModelLink 的三处错误出口都过了 errText（写入/探测/启停）',
    src.includes("errText(res, '写入失败')") && src.includes("errText(res, '探测失败')") && src.includes("errText(res, '操作失败')"))
  ok('端点档案三处错误出口也都过了 errText',
    src.includes("errText(res, '切换失败')") && src.includes("errText(res, '保存失败')") && src.includes("errText(res, '删除失败')"))
}

// 14. 「回得去」的真正手段是初始地址快照，不是清除覆盖。
//     实测宿主拒绝清空自定义 provider 的 baseURL：
//       provider "custom" model "glm-5.3-flash" needs a baseURL;
//       the installed catalog does not describe this route
//     （自定义模型 id 不在内建目录里 → baseURL 必填 → 没有「默认端点」可回退）
{
  const withBase = { listenHost: '127.0.0.1', listenPort: 8788, upstream: 'https://opencode.ai/zen/go',
    baseline: { provider: 'custom', baseURL: 'http://127.0.0.1:8788/v1', capturedAt: 'x' } }
  const sug = suggestEndpoints(withBase)
  ok('有初始地址快照时，建议档里出现「恢复初始地址」', sug.some((x) => x.kind === 'baseline' && x.baseURL === 'http://127.0.0.1:8788/v1'))
  ok('恢复初始地址排在最前（最常用的「回得去」入口）', sug[0].kind === 'baseline')
  ok('初始地址档走 set（不是 unset）', planEndpointUse(sug[0]).op === 'set')
  ok('初始地址也去掉尾斜杠', planEndpointUse({ kind: 'baseline', baseURL: 'http://a/v1/' }).baseURL === 'http://a/v1')

  const noBase = suggestEndpoints({ listenHost: '127.0.0.1', listenPort: 8788, upstream: 'https://x' })
  ok('没有快照时不出现空的「恢复初始地址」档', !noBase.some((x) => x.kind === 'baseline'))

  // 清除覆盖失败的提示必须是可照做的指引，而不是宿主的原文
  const hint = unsetFailureHint('custom')
  ok('提示里点名 provider', hint.includes('custom'))
  ok('提示解释了原因（模型不在内建目录 → baseURL 必填）', hint.includes('内建目录') && hint.includes('必填'))
  ok('提示给了替代动作（恢复初始地址 / 代理 / 直连）', hint.includes('恢复初始地址') && hint.includes('本机代理') && hint.includes('直连上游'))
  ok('提示保留了宿主原文便于排查', hint.includes('needs a baseURL'))
}

// 15. 建议档里的「清除覆盖」必须自带限制说明（否则用户以为它对任何 provider 都能用）
{
  const sug = suggestEndpoints({ listenHost: '127.0.0.1', listenPort: 8788, upstream: 'https://x' })
  const d = sug.find((x) => x.kind === 'default')
  ok('清除覆盖档仍存在（内建 provider 场景下有用）', !!d)
  ok('它的 note 写明只对内建 provider 有效', /内建/.test(d.note) && /自定义/.test(d.note))
}

// 16. baseline 快照的写入条件 —— 这里踩过一个**真 bug**：
//     写成「当前生效值 ≠ 快照就重记」时，快照会跟着当前值一路跑，等于没有快照：
//     切到直连上游后，下次读面板把快照也改成了上游地址，
//     于是「恢复初始地址」指向的正是刚切过去的地址，永远回不到最初那个（端到端实跑才发现）。
//     正确条件：只在「没有快照」或「换了 provider」时记。
{
  const base = { provider: 'custom', baseURL: 'http://127.0.0.1:8788/v1', capturedAt: 'x' }

  ok('没有快照 → 记一次', shouldCaptureBaseline({}, 'custom', 'http://a/v1') === true)
  ok('没有生效地址 → 不记（记了也是空的）', shouldCaptureBaseline({}, 'custom', null) === false)

  // ★ 这条就是那个 bug 的锁：快照存在且 provider 未变时，**无论当前值差多少都不许重记**
  ok('已有快照且 provider 未变 → 绝不重记（哪怕当前值不同）',
    shouldCaptureBaseline(base, 'custom', 'https://opencode.ai/zen/go') === false)
  ok('已有快照、当前值与快照相同 → 也不重记（幂等）',
    shouldCaptureBaseline(base, 'custom', 'http://127.0.0.1:8788/v1') === false)
  ok('换了 provider → 为新 provider 记一次', shouldCaptureBaseline(base, 'deepseek', 'https://api.deepseek.com') === true)
}
{
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok('落地用的是 shouldCaptureBaseline 而不是内联比较', src.includes('if (shouldCaptureBaseline(b0, provider, installed))'))
  ok('不存在「当前值≠快照就重记」的旧写法残留',
    !src.includes('effBaseline.baseURL !== installed'))
  ok('响应里回的是 effBaseline 而不是写前的 b0', src.includes('baseline: effBaseline,'))
  ok('插件 UI 文案里不残留 markdown 星号（React 不会渲染 markdown）',
    !readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').includes('**初始地址**'))
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`)
process.exit(fail ? 1 : 0)
