// dsh-tool-scope 测试：规则计算、插件门禁契约和 Pentest RCE 工具面边界。
//
// 为什么需要契约锁：通用规则表镜像插件既有门禁；Pentest 规则单独锁住产品交付边界。
// 如果哪天某个插件放开了门禁
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
    'redteam_atlas_target', 'redteam_coverage_mark', 'operation_goal',
    'subagent', 'subagent_fork', 'workflow', 'attack_plan', 'attack_gate',
    'netexec_scan', 'crackmapexec_scan', 'impacket_suite',
    'access_confirm', 'memshell_cli', 'nday_catalog', 'nday_match', 'nday_coverage',
    'nday_triage', 'nday_learn', 'nday_draft', 'nday_handoff', 'zday_pattern', 'oob_probe',
    'tool_pack',                                      // 按需工具包入口
  ]
  const W = 5  // known 里 webshell_* 个数
  const C = 4  // ctf_* 个数
  const S = 7  // security 组个数（redteam/campaign/gates/trace/knowledge）
  const P = 1  // 工具包入口

  // Pentest：保留侦察/漏洞路径/证据工具；收起 CTF、后渗透与通用流程工具。
  const pt = computeDeny('pentest', known, RULES)
  ok('pentest 隐藏 ctf_*（4 个）', pt.includes('ctf_steer') && C === 4)
  ok(`pentest 基础规则收起数为 ${pt.length}（期望 ${C + 19}，任务工具另按包收起）`, pt.length === C + 19)
  ok('pentest 隐藏 webshell、保留按需工具包入口', pt.includes('webshell_exec') && !pt.includes('tool_pack'))
  ok('pentest 隐藏矩阵、后渗透和内网工具，并收起绕过管理的子代理工具',
    ['attack_gate', 'redteam_atlas_target', 'redteam_coverage_mark', 'netexec_scan', 'crackmapexec_scan', 'impacket_suite', 'access_confirm', 'memshell_cli', 'nday_triage', 'campaign_memory_write', 'trace_recent'].every((n) => pt.includes(n))
    && ['subagent', 'subagent_fork', 'workflow'].every((n) => pt.includes(n))
    && !['attack_plan', 'nday_coverage', 'nday_learn', 'nday_draft', 'nday_handoff'].some((n) => pt.includes(n)))
  ok('pentest 保留 RCE 路径、证据记录与核心侦察工具',
    ['nmap_portscan', 'sqlmap_inject', 'nday_catalog', 'nday_match', 'nday_coverage', 'nday_learn', 'nday_draft', 'nday_handoff', 'attack_plan', 'zday_pattern', 'oob_probe', 'redteam_finding_register', 'knowledge_search'].every((n) => !pt.includes(n)))
  ok('pentest 保留证据登记和 Nday 知识检索', !pt.includes('redteam_finding_register') && !pt.includes('knowledge_search'))

  // code-audit：webshell + ctf 隐藏；security 放行
  const ca = computeDeny('code-audit', known, RULES)
  ok('code-audit 隐藏 webshell_* 全部', ca.includes('webshell_connect') && ca.includes('webshell_list'))
  ok('code-audit 隐藏 ctf_* 全部', ca.includes('ctf_challenge') && ca.includes('ctf_steer'))
  ok('code-audit 不隐藏 security 组（redteam/campaign/trace/knowledge）',
    !ca.includes('redteam_finding_register') && !ca.includes('campaign_memory_write')
    && !ca.includes('trace_recent') && !ca.includes('knowledge_search'))
  ok('code-audit 不隐藏无门禁工具（扫描器）', !ca.includes('nmap_portscan') && !ca.includes('sqlmap_inject'))
  ok('code-audit 不隐藏宿主内置工具', !ca.includes('read') && !ca.includes('pwsh'))
  ok('code-audit 隐藏无适用模式的工具包入口', ca.includes('tool_pack'))
  ok(`code-audit 隐藏数 = webshell ${W} + ctf ${C} + 工具包入口 ${P}`, ca.length === W + C + P)

  // ctf-solver：webshell + security 隐藏；ctf 放行
  const ctf = computeDeny('ctf-solver', known, RULES)
  ok('ctf-solver 不隐藏 ctf_*', !ctf.includes('ctf_challenge'))
  ok('ctf-solver 隐藏 webshell_*', ctf.includes('webshell_exec'))
  // ⚠ 这里**不**隐藏 security 组：四个插件的 MODE_IDS 都含 ctf-solver（CTF 也要登记成果/留痕）
  ok('ctf-solver 不隐藏 security 组（MODE_IDS 含 ctf-solver）', !ctf.includes('knowledge_search'))
  ok('ctf-solver 隐藏无适用模式的工具包入口', ctf.includes('tool_pack'))
  ok(`ctf-solver 隐藏数 = webshell ${W} + 工具包入口 ${P}`, ctf.length === W + P)

  // 标准模式（宿主默认预设，id 为空）：三组全隐藏
  const std = computeDeny('', known, RULES)
  ok(`默认模式（空 id）隐藏三组与 Pentest 专用工具（${std.length}）`, ['webshell_exec', 'ctf_steer', 'knowledge_search', 'operation_goal', 'tool_pack', 'netexec_scan'].every((n) => std.includes(n)))
  ok('默认模式仍不隐藏宿主内置与无门禁工具', !std.includes('read') && !std.includes('nmap_portscan'))

  // 未知模式（未来新增的 preset）：同样按「不在白名单即隐藏」处理
  const unknown = computeDeny('some-future-mode', known, RULES)
  ok('未知模式同样收起受门禁限制的工具', ['webshell_exec', 'ctf_steer', 'knowledge_search', 'operation_goal', 'tool_pack', 'netexec_scan'].every((n) => unknown.includes(n)))

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
  ok('Pentest 的产品边界独立于旧 webshell 模式门禁', computeDeny('pentest', known, off).includes('webshell_exec'))
  ok('默认/未知模式仍由白名单规则收起 webshell', computeDeny('', known, off).includes('webshell_exec'))
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
  const known = ['webshell_connect', 'webshell_exec', 'impacket_suite', 'netexec_scan', 'crackmapexec_scan', 'nmap_portscan', 'dirsearch_dirs', 'ffuf_fuzz', 'nuclei_scan', 'afrog_scan', 'sqlmap_inject', 'katana_crawl', 'gau_urls', 'whatweb_fingerprint', 'wafw00f_detect', 'tool_pack']
  const pt = deferredPackTools('pentest', known, PACKS)
  ok('pentest 默认收起 webshell 全局工具', pt.includes('webshell_connect') && pt.includes('webshell_exec'))
  ok('pentest 默认收起耗时扫描器与爬取工具', ['nmap_portscan', 'dirsearch_dirs', 'ffuf_fuzz', 'nuclei_scan', 'afrog_scan', 'sqlmap_inject', 'katana_crawl', 'gau_urls'].every((n) => pt.includes(n)))
  ok('指纹工具按需加载，不占每轮声明', pt.includes('whatweb_fingerprint') && pt.includes('wafw00f_detect'))
  ok('AD 工具不属于 webshell 延迟包（由 Pentest 主线规则单独收起）', !pt.includes('impacket_suite') && !pt.includes('netexec_scan'))
  ok('pentest 不收工具包入口', !pt.includes('tool_pack'))
  const ca = deferredPackTools('code-audit', known, PACKS)
  ok('code-audit 不额外收起（基础规则已隐藏 webshell）', ca.length === 0)
  ok('packsForMode 只返回模式可用包', packsForMode('pentest', PACKS).length === 5 && packsForMode('code-audit', PACKS).length === 0)
  ok('enabledPacks 可按 id 关闭', enabledPacks({ webshell: false }).length === PACKS.length - 1)
  ok('findPack 严格按 id 匹配', findPack('webshell', PACKS)?.id === 'webshell' && findPack('nope', PACKS) === null)
  ok('webshell 包只命中 webshell_*', JSON.stringify(packTools(known, findPack('webshell', PACKS))) === JSON.stringify(['webshell_connect', 'webshell_exec']))
  ok('active-scan 包不包含快指纹工具', JSON.stringify(packTools(known, findPack('active-scan', PACKS))) === JSON.stringify(['afrog_scan', 'dirsearch_dirs', 'ffuf_fuzz', 'gau_urls', 'katana_crawl', 'nmap_portscan', 'nuclei_scan', 'sqlmap_inject']))
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

  // 4.5 Pentest 的工具边界必须跟随主线提示，且只影响该模式的能力声明。
  const focus = RULES.find((r) => r.id === 'pentest-rce-focus')
  // The mode persona is now a separate, user-editable full opening.
  const pentestPrompt = readFileSync(new URL('../preset/pentest/opening.md', PLUGINS), 'utf8')
  ok('Pentest RCE 工具规则存在并排除该模式', !!focus && !focus.modes.includes('pentest'))
  ok('Pentest 按证据委派独立任务，默认不按每个目标/CVE派模型',
    /never fan out by URL\/CVE/i.test(pentestPrompt)
    && /Delegate only a clear necessary site task/i.test(pentestPrompt)
    && /Default finish the agreed task/i.test(pentestPrompt))
  ok('Pentest 规则收起记忆轨迹、内网、后渗透和非主线 Nday 工具', ['webshell_', 'netexec_', 'crackmapexec_', 'impacket_', 'campaign_', 'trace_', 'access_confirm', 'memshell_cli', 'nday_handoff'].every((p) => focus.prefixes.includes(p)))
  ok('Pentest 主线规则不屏蔽按需工具包入口', !focus.prefixes.includes('tool_pack') && !computeDeny('pentest', ['tool_pack'], RULES).includes('tool_pack'))
  const toolPackRule = RULES.find((r) => r.id === 'toolPack')
  ok('工具包入口只对实际声明工具包的模式开放', JSON.stringify(toolPackRule.modes) === JSON.stringify([...new Set(PACKS.flatMap((p) => p.modes))]))
}

// ── 5. 工具包真实装配：Pentest 基础 RCE 规则无法被包加载覆盖 ────────────────
{
  const known = [
    'read', 'nmap_portscan', 'dirsearch_dirs', 'ffuf_fuzz', 'nuclei_scan', 'afrog_scan', 'sqlmap_inject', 'katana_crawl', 'gau_urls', 'whatweb_fingerprint', 'ctf_state',
    'webshell_connect', 'webshell_exec', 'webshell_file',
    'impacket_suite', 'netexec_scan', 'crackmapexec_scan',
    'tool_pack', 'nday_catalog', 'nday_match', 'asset_search', 'redteam_context',
    'operation_goal', 'operation_scope', 'operation_intent', 'operation_task',
    'operation_progress', 'operation_constraints', 'operation_conclude',
  ]
  const handlers = {}
  const registered = []
  const denyLayers = new Map()
  const deferredScanners = ['nmap_portscan', 'dirsearch_dirs', 'ffuf_fuzz', 'nuclei_scan', 'afrog_scan', 'sqlmap_inject', 'katana_crawl', 'gau_urls']
  let scannerToolsReady = false
  let nextLayerId = 0
  const isDenied = (name) => [...denyLayers.values()].some((set) => set.has(name))
  const disposeCalls = []
  const fakeCtx = {
    tools: {
      // Global schemas omit preset-injected scanner tools; the Agent view contains them.
      schemas: () => known.filter((name) => !deferredScanners.includes(name)).map((name) => ({ name })),
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
        schemas: (scope) => scope === agent ? known.filter((name) => !isDenied(name) && (scannerToolsReady || !deferredScanners.includes(name))).map((name) => ({ name })) : [],
        restrict: (filter) => {
          const layerId = ++nextLayerId
          const deny = new Set(filter.deny)
          denyLayers.set(layerId, deny)
          return () => {
            denyLayers.delete(layerId)
            disposeCalls.push([...deny])
          }
        },
      },
    },
  }
  handlers['agent/created']({ agent })
  ok('agent/created 可先于预设扫描器装配', !deferredScanners.some(isDenied))
  scannerToolsReady = true
  handlers['agent/inbox/inserted']({ agent })
  ok('装配后 webshell、内网与派单不可见，工具包入口可见', ['webshell_exec', 'impacket_suite', 'netexec_scan', 'crackmapexec_scan'].every(isDenied) && !isDenied('tool_pack'))
  ok('Agent 工具视图中的扫描器、指纹、Nday和资产查询默认隐藏', deferredScanners.every(isDenied)
    && ['whatweb_fingerprint', 'nday_catalog', 'nday_match', 'asset_search'].every(isDenied))

  const toolPack = registered.find((tool) => tool.name === 'tool_pack')
  ok('tool_pack 已注册', !!toolPack)
  const taskTools = known.filter((name) => name.startsWith('operation_'))
  ok('任务工作流默认收起，不占小问题的工具声明', taskTools.length === 7 && taskTools.every(isDenied))
  const tasksLoaded = await toolPack.execute({ action: 'load', pack: 'task-workflow' }, { agent })
  ok('依赖任务包加载后七个实际任务工具全部可见', tasksLoaded.ok && taskTools.every((name) => !isDenied(name)))
  handlers['agent/inbox/inserted']({ agent })
  ok('后续消息保持任务包可见且不自动加载扫描器', taskTools.every((name) => !isDenied(name)) && deferredScanners.every(isDenied))
  await toolPack.execute({ action: 'unload', pack: 'task-workflow' }, { agent })
  ok('任务包卸载恢复隐藏并保留工具包入口', taskTools.every(isDenied) && !isDenied('tool_pack'))
  ok('任务包不会给默认或未知模式开放任务工具', ['', 'unknown-mode'].every((mode) => taskTools.every((name) => computeDeny(mode, taskTools, RULES).includes(name))))
  const list = await toolPack.execute({ action: 'list' }, { agent })
  ok('list 通过 Agent 视图识别 8 个扫描器并显示默认收起', list.ok && list.packs.find((p) => p.id === 'active-scan')?.loaded === false && list.packs.find((p) => p.id === 'active-scan')?.tools === 8)
  const ndayLoaded = await toolPack.execute({ action: 'load', pack: 'nday' }, { agent })
  ok('Nday包加载恢复情报工具，保留其他过滤与核心工具', ndayLoaded.ok && !isDenied('nday_catalog') && !isDenied('nday_match') && isDenied('asset_search') && !isDenied('read') && !isDenied('redteam_context'))
  handlers['agent/inbox/inserted']({ agent })
  ok('刷新保留已加载Nday包且不扩展其他包', !isDenied('nday_match') && isDenied('whatweb_fingerprint'))
  await toolPack.execute({ action: 'unload', pack: 'nday' }, { agent })
  ok('Nday包卸载后恢复隐藏', isDenied('nday_catalog') && isDenied('nday_match'))
  const assetLoaded = await toolPack.execute({ action: 'load', pack: 'asset-discovery' }, { agent })
  ok('目标识别包按需恢复资产查询和指纹', assetLoaded.ok && !isDenied('asset_search') && !isDenied('whatweb_fingerprint') && isDenied('nday_match'))
  await toolPack.execute({ action: 'unload', pack: 'asset-discovery' }, { agent })
  ok('目标识别包卸载后仍保留核心记录工具', isDenied('asset_search') && isDenied('whatweb_fingerprint') && !isDenied('redteam_context'))
  const scansLoaded = await toolPack.execute({ action: 'load', pack: 'active-scan' }, { agent })
  ok('常规模式可按需加载主动扫描器包', scansLoaded.ok && !isDenied('nmap_portscan') && !isDenied('nuclei_scan'))
  handlers['agent/inbox/inserted']({ agent })
  ok('后续消息保留已加载的工具包', !isDenied('nmap_portscan') && !isDenied('nuclei_scan'))
  ok('扫描包不会解除 WebShell 主线限制', isDenied('webshell_exec'))
  const scansUnloaded = await toolPack.execute({ action: 'unload', pack: 'active-scan' }, { agent })
  ok('主动扫描器包可卸载并恢复默认隐藏', scansUnloaded.ok && isDenied('nmap_portscan') && isDenied('nuclei_scan'))
  const loaded = await toolPack.execute({ action: 'load', pack: 'webshell' }, { agent })
  ok('加载包不能绕过 Pentest 的 webshell 禁止规则', loaded.ok && isDenied('webshell_exec'))
  const loadedAgain = await toolPack.execute({ action: 'load', pack: 'webshell' }, { agent })
  ok('重复 load 也不能恢复 webshell 工具', loadedAgain.ok && isDenied('webshell_exec'))
  const unloaded = await toolPack.execute({ action: 'unload', pack: 'webshell' }, { agent })
  ok('unload 后 webshell 仍不可见', unloaded.ok && isDenied('webshell_exec'))
  handlers['agent/disposed']({ agent })
  ok('agent 销毁时释放基础过滤与工具包过滤', disposeCalls.length >= 3 && denyLayers.size === 0)
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
