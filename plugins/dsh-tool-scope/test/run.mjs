// dsh-tool-scope 测试：① 规则计算逻辑 ② **规则表与各插件实际门禁的源码契约锁**。
//
// 为什么需要契约锁：本插件的规则表是「插件既有门禁的镜像」。如果哪天某个插件放开了门禁
// （例如 webshell 支持 code-audit 了），而这里没跟着改，就会出现**静默功能损失** ——
// 工具被隐藏、模型看不到、用户也不知道为什么。这类不一致必须由测试抓出来，
// 而不是等用户在实战里发现「工具怎么没了」。
import { readFileSync, existsSync } from 'node:fs'
import { RULES, computeDeny, enabledRules, matchByRule, DEFAULT_MODES } from '../lib/rules.js'
import { PACKS, deferredPackTools, enabledPacks, findPack, packTools, packsForMode } from '../lib/packs.js'
import { apply } from '../lib/index.js'

let pass = 0
let fail = 0
const ok = (label, cond) => {
  if (cond) { pass++; console.log(`ok   ${label}`) } else { fail++; console.log(`FAIL ${label}`) }
}

const PLUGINS = new URL('../../', import.meta.url) // saker(github)/plugins/
const readPlugin = (name, file = 'lib/index.js') => {
  const u = new URL(`${name}/${file}`, PLUGINS)
  return existsSync(u) ? readFileSync(u, 'utf8') : ''
}

// ── 1. 规则计算 ─────────────────────────────────────────────────────────────
{
  const known = [
    'read', 'write', 'pwsh',                       // 宿主内置（3）
    'webshell_connect', 'webshell_exec', 'webshell_list', 'webshell_db', 'webshell_file', // webshell（5）
    'ctf_challenge', 'ctf_dispatch', 'ctf_state', 'ctf_steer',                             // ctf（4）
    'redteam_finding_register', 'campaign_memory_write', 'gates_list',                     // security（3）
    'trace_recent', 'knowledge_search',                                                    // security（2）→ 共 5
    'nmap_portscan', 'sqlmap_inject',              // 无门禁的插件工具（不该被动）
    'tool_pack',                                      // 按需工具包入口
  ]
  const W = 5  // known 里 webshell_* 个数
  const C = 4  // ctf_* 个数
  const S = 5  // security 组个数（redteam/campaign/gates/trace/knowledge）
  const P = 1  // 工具包入口

  // pentest：webshell 与 security 放行，**ctf 隐藏**（CTF 工具在渗透模式调不动）
  const pt = computeDeny('pentest', known, RULES)
  ok('pentest 隐藏 ctf_*（4 个）', pt.length === C && pt.includes('ctf_steer'))
  ok('pentest 不隐藏 webshell_*', !pt.includes('webshell_exec'))
  ok('pentest 不隐藏 security 组', !pt.includes('redteam_finding_register') && !pt.includes('knowledge_search'))

  // code-audit：webshell + ctf 隐藏；security 放行
  const ca = computeDeny('code-audit', known, RULES)
  ok('code-audit 隐藏 webshell_* 全部', ca.includes('webshell_connect') && ca.includes('webshell_list'))
  ok('code-audit 隐藏 ctf_* 全部', ca.includes('ctf_challenge') && ca.includes('ctf_steer'))
  ok('code-audit 不隐藏 security 组（redteam/campaign/trace/knowledge）',
    !ca.includes('redteam_finding_register') && !ca.includes('campaign_memory_write')
    && !ca.includes('trace_recent') && !ca.includes('knowledge_search'))
  ok('code-audit 不隐藏无门禁工具（扫描器）', !ca.includes('nmap_portscan') && !ca.includes('sqlmap_inject'))
  ok('code-audit 不隐藏宿主内置工具', !ca.includes('read') && !ca.includes('pwsh'))
  ok(`code-audit 隐藏数 = webshell ${W} + ctf ${C}`, ca.length === W + C)

  // ctf-solver：webshell + security 隐藏；ctf 放行
  const ctf = computeDeny('ctf-solver', known, RULES)
  ok('ctf-solver 不隐藏 ctf_*', !ctf.includes('ctf_challenge'))
  ok('ctf-solver 隐藏 webshell_*', ctf.includes('webshell_exec'))
  // ⚠ 这里**不**隐藏 security 组：四个插件的 MODE_IDS 都含 ctf-solver（CTF 也要登记成果/留痕）
  ok('ctf-solver 不隐藏 security 组（MODE_IDS 含 ctf-solver）', !ctf.includes('knowledge_search'))
  ok(`ctf-solver 隐藏数 = webshell ${W}`, ctf.length === W)

  // 标准模式（宿主默认预设，id 为空）：三组全隐藏
  const std = computeDeny('', known, RULES)
  ok(`默认模式（空 id）隐藏三组全部（${W + C + S + P}）`, std.length === W + C + S + P)
  ok('默认模式仍不隐藏宿主内置与无门禁工具', !std.includes('read') && !std.includes('nmap_portscan'))

  // 未知模式（未来新增的 preset）：同样按「不在白名单即隐藏」处理
  const unknown = computeDeny('some-future-mode', known, RULES)
  ok(`未知模式同标准模式（${W + C + S + P}）`, unknown.length === W + C + S + P)

  // 空清单：绝不抛错、返回空
  ok('空工具清单返回空数组', computeDeny('code-audit', [], RULES).length === 0)

  // 结果去重且稳定排序（同一次调用两次结果一致）
  const a1 = computeDeny('', known, RULES)
  const a2 = computeDeny('', known, RULES)
  ok('结果稳定可复现', JSON.stringify(a1) === JSON.stringify(a2))
  ok('结果无重复', new Set(a1).size === a1.length)
}

// ── 2. 规则开关 ─────────────────────────────────────────────────────────────
{
  ok('enabledRules() 默认全开', enabledRules().length === RULES.length)
  const off = enabledRules({ webshell: false })
  ok('可按 id 关掉单条规则', off.length === RULES.length - 1 && !off.some((r) => r.id === 'webshell'))
  const known = ['webshell_exec', 'ctf_state']
  ok('关掉 webshell 规则后不再隐藏它', !computeDeny('', known, off).includes('webshell_exec'))
  ok('其余规则不受影响', computeDeny('', known, off).includes('ctf_state'))
  ok('显式 true 视为启用', enabledRules({ webshell: true }).length === RULES.length)
}

// ── 3. matchByRule（UI/日志用的预估）────────────────────────────────────────
{
  const known = ['webshell_exec', 'webshell_list', 'ctf_state', 'read']
  const byRule = matchByRule(known, RULES)
  ok('matchByRule 按规则分组', byRule.get('webshell')?.length === 2 && byRule.get('ctf')?.length === 1)
  ok('matchByRule 不含未命中的规则', !byRule.has('security'))
}

// ── 3b. 按需工具包 ─────────────────────────────────────────────────────────
{
  const known = ['webshell_connect', 'webshell_exec', 'impacket_suite', 'netexec_scan', 'crackmapexec_scan', 'nmap_portscan', 'tool_pack']
  const pt = deferredPackTools('pentest', known, PACKS)
  ok('pentest 默认收起 webshell 全局工具', pt.length === 2 && pt.includes('webshell_exec'))
  ok('preset 平面注册的 AD 工具不进入 restrict 包（宿主限制只覆盖全局工具）', !pt.includes('impacket_suite') && !pt.includes('netexec_scan'))
  ok('pentest 不收核心扫描器与工具包入口', !pt.includes('nmap_portscan') && !pt.includes('tool_pack'))
  const ca = deferredPackTools('code-audit', known, PACKS)
  ok('code-audit 不额外收起（基础规则已隐藏 webshell）', ca.length === 0)
  ok('packsForMode 只返回模式可用包', packsForMode('pentest', PACKS).length === 1 && packsForMode('code-audit', PACKS).length === 0)
  ok('enabledPacks 可按 id 关闭', enabledPacks({ webshell: false }).length === PACKS.length - 1)
  ok('findPack 严格按 id 匹配', findPack('webshell', PACKS)?.id === 'webshell' && findPack('nope', PACKS) === null)
  ok('webshell 包只命中 webshell_*', JSON.stringify(packTools(known, PACKS[0])) === JSON.stringify(['webshell_connect', 'webshell_exec']))
}

// ── 4. 源码契约锁：规则表必须与各插件的实际门禁一致 ──────────────────────────
{
  // 4.1 webshell-mgr：ALLOWED_MODES 必须仍等于规则里的 modes
  const ws = readPlugin('dsh-webshell-mgr')
  ok('能读到 dsh-webshell-mgr 源码', ws.length > 0)
  const wsModes = /const ALLOWED_MODES = \[([^\]]*)\]/.exec(ws)
  const wsList = wsModes ? wsModes[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : null
  const ruleWs = RULES.find((r) => r.id === 'webshell')
  ok('webshell 规则存在', !!ruleWs)
  ok('规则表的 webshell modes 与 ALLOWED_MODES 逐字一致',
    wsList !== null && JSON.stringify(wsList) === JSON.stringify(ruleWs.modes))
  ok('webshell-mgr 确实在入口硬拒绝（非降级）', /ALLOWED_MODES\.includes\(session\.mode\)/.test(ws))

  // 4.2 ctf-observer：MODE_ID 必须仍是规则里的那一个
  const ctf = readPlugin('dsh-ctf-observer')
  ok('能读到 dsh-ctf-observer 源码', ctf.length > 0)
  const ctfMode = /const MODE_ID = ["']([a-z-]+)["']/.exec(ctf)
  const ruleCtf = RULES.find((r) => r.id === 'ctf')
  ok('规则表的 ctf modes 与 MODE_ID 一致',
    ctfMode !== null && JSON.stringify([ctfMode[1]]) === JSON.stringify(ruleCtf.modes))

  // 4.3 三件套：MODE_IDS / MODES 必须与规则里的 modes 一致
  const securityRule = RULES.find((r) => r.id === 'security')
  const sources = [
    ['dsh-redteam-results', /const MODES = \[([^\]]*)\]/],
    ['dsh-campaign-memory', /const MODE_IDS = \[([^\]]*)\]/],
    ['dsh-trace-vault', /const MODE_IDS = \[([^\]]*)\]/],
    ['dsh-knowledge-hub', /const MODE_IDS = \[([^\]]*)\]/],
  ]
  for (const [plugin, re] of sources) {
    const src = readPlugin(plugin)
    ok(`能读到 ${plugin} 源码`, src.length > 0)
    const m = re.exec(src)
    const list = m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : null
    ok(`${plugin} 的模式清单与 security 规则一致`,
      list !== null && JSON.stringify(list) === JSON.stringify(securityRule.modes))
  }

  // 4.4 DEFAULT_MODES 必须与上面三件套一致（防止两处定义漂移）
  ok('DEFAULT_MODES 与 security 规则的 modes 一致',
    JSON.stringify(DEFAULT_MODES) === JSON.stringify(securityRule.modes))
}

// ── 5. 工具包真实装配：默认收起、加载可见、卸载再收起、销毁释放 ─────────────
{
  const known = [
    'read', 'nmap_portscan', 'ctf_state',
    'webshell_connect', 'webshell_exec', 'webshell_file',
    'impacket_suite', 'netexec_scan', 'crackmapexec_scan',
    'tool_pack',
  ]
  const handlers = {}
  const registered = []
  const activeDeny = new Set()
  const disposeCalls = []
  const fakeCtx = {
    tools: {
      schemas: () => known.map((name) => ({ name })),
      register: (tool) => registered.push(tool),
    },
    logger: { info: () => {}, warn: () => {} },
    agentPresets: { composedPreset: () => 'pentest' },
    on: (event, fn) => { handlers[event] = fn },
  }
  apply(fakeCtx, { log: false })
  const agent = {
    id: 'agent-pack-test',
    ctx: {
      tools: {
        restrict: (filter) => {
          for (const name of filter.deny) activeDeny.add(name)
          const deny = [...filter.deny]
          return () => {
            for (const name of deny) activeDeny.delete(name)
            disposeCalls.push(deny)
          }
        },
      },
    },
  }
  handlers['agent/created']({ agent })
  ok('装配后默认收起 webshell', activeDeny.has('webshell_exec'))
  ok('装配不影响 preset 平面 AD 工具', !activeDeny.has('impacket_suite'))
  ok('装配后核心扫描器仍可见', !activeDeny.has('nmap_portscan'))

  const toolPack = registered.find((tool) => tool.name === 'tool_pack')
  ok('tool_pack 已注册', !!toolPack)
  const list = await toolPack.execute({ action: 'list' }, { agent })
  ok('list 显示 webshell 默认收起', list.ok && list.packs.find((p) => p.id === 'webshell')?.loaded === false)
  const loaded = await toolPack.execute({ action: 'load', pack: 'webshell' }, { agent })
  ok('load webshell 后工具恢复可见', loaded.ok && !activeDeny.has('webshell_exec'))
  const loadedAgain = await toolPack.execute({ action: 'load', pack: 'webshell' }, { agent })
  ok('重复 load 幂等', loadedAgain.ok && activeDeny.has('webshell_exec') === false)
  const unloaded = await toolPack.execute({ action: 'unload', pack: 'webshell' }, { agent })
  ok('unload webshell 后重新收起', unloaded.ok && activeDeny.has('webshell_exec'))
  handlers['agent/disposed']({ agent })
  ok('agent 销毁时释放基础过滤与工具包过滤', disposeCalls.length >= 2 && !activeDeny.has('webshell_exec') && !activeDeny.has('ctf_state'))
}

// ── 6. 反向锚：断言「实现不越界」─────────────────────────────────────────────
{
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 只 deny，不得出现 allow（allow 会把「未列出的工具」全部隐藏 —— 那是另一种语义，
  // 一旦误用会把宿主工具也收掉，属于危险写法）
  ok('index.js 只用 deny，不出现 allow', /restrict\(\{\s*deny/.test(src) && !/restrict\(\{[^}]*allow/.test(src))
  // restrict 失败必须可见
  ok('restrict 失败走 logger.warn（不静默）', /restrict 失败/.test(src) && /logger\?\.warn\?\./.test(src))
  // 幂等：同 agent 不重复挂
  ok('同 agent 幂等（states.has 守卫）', /states\.has\(agent\.id\)/.test(src))
  // agent 销毁时释放
  ok('agent/disposed 时释放过滤器', /agent\/disposed/.test(src) && /dispose\(\)/.test(src))
  // 日志必须两路都打：宿主 logger.info **不上屏**（实测只送 warn+ 到 stderr），
  // 只写 logger 等于用户看不到「工具面被改了」这件事。
  ok('日志同时走 logger.info 与 console.log', /logger\?\.info\?\./.test(src) && /console\.log\('\[tool-scope\] '/.test(src))
  // say/bind 各只有一处定义（曾因重复声明把整个插件打挂）
  ok('say 只有一处定义', (src.match(/const say = \(line\)/g) || []).length === 1)
  ok('bind 只有一处定义', (src.match(/const bind = \(agent\)/g) || []).length === 1)
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`)
process.exit(fail ? 1 : 0)
