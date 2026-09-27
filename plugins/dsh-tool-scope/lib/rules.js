// 工具作用域规则表 —— 「把插件既有的运行时门禁，前移到可见性层」。
//
// 背景（2026-09-13 实测）：一轮模型请求 164KB 里 **工具定义占 67.8%**（101 个工具 111.5K），
// 其中宿主内置仅 29 个，**插件贡献 72 个**。而这些插件里有一部分**已经声明了模式门禁** ——
// 例如 webshell-mgr 的 `ALLOWED_MODES = ["pentest"]`：在 code-audit 模式下调用
// `webshell_*` 会被**硬拒绝**（`return { ok:false, error:'webshell 工具面仅限…' }`）。
// 也就是说：那些工具的声明在非适用模式下**纯占上下文、一丝用处都没有**。
//
// 参照 BreachWeave `pi-mcp-adapter` 的「单代理入口 + 元数据缓存 + 懒启动」思路，
// 落到 dsh 上最直接的形态不是再造一层代理，而是用**宿主原生的 `tools.restrict()`**
// （per-agent allow/deny 过滤，见 packages/core/tools/src/index.ts:1061）把这些工具的
// 可见性直接收掉。收益是确定的：模型看不到 = 不进请求体。
//
// 【纪律】既有插件门禁必须与源码保持一致；Pentest 另按产品交付边界收起后渗透、
// 内网和流程管理工具。每条规则标明依据并由 test/run.mjs 锁住。

/** 宿主内置的默认模式（Saker 三个 preset 之外的那个「标准」）。 */
export const DEFAULT_MODES = ['pentest', 'code-audit', 'ctf-solver']

/**
 * 一条规则 = 「某组工具只能在某些模式下可见」。
 * @typedef {object} ToolScopeRule
 * @property {string} id - 稳定标识（设置项按键名）
 * @property {string} label - 中文名（UI 用）
 * @property {string[]} prefixes - 工具名前缀（命中即归本规则）
 * @property {string[]} modes - **可见**的模式白名单；不在此列的模式下这些工具被隐藏
 * @property {string} source - 依据（插件源码里的那行）
 * @property {string} note - 失效语义说明
 */
export const RULES = [
  {
    id: 'webshell',
    label: 'WebShell 工具面',
    prefixes: ['webshell_'],
    modes: ['pentest'],
    source: 'dsh-webshell-mgr/lib/index.js —— ALLOWED_MODES = ["pentest"]',
    note: '非 pentest 模式下调用被硬拒绝（返回错误，非降级），声明纯占上下文',
  },
  {
    id: 'ctf',
    label: 'CTF 解题工具面',
    prefixes: ['ctf_'],
    modes: ['ctf-solver'],
    source: 'dsh-ctf-observer/lib/index.js —— MODE_ID = "ctf-solver"（"只在 ctf-solver 模式生效"）',
    note: '工具的准入「只在 ctf-solver 模式、且有工作目录时可用」',
  },
  {
    id: 'security',
    label: '安全作业工具面（成果/记忆/留痕/知识库）',
    prefixes: ['redteam_', 'campaign_', 'gates_', 'trace_', 'knowledge_'],
    modes: DEFAULT_MODES,
    source: 'dsh-redteam-results MODES / dsh-campaign-memory·dsh-trace-vault·dsh-knowledge-hub 的 MODE_IDS',
    note: '四个插件的模式清单均为 ["pentest","code-audit","ctf-solver"]；标准模式（宿主默认预设）下它们的注入与入库都不生效',
  },
  {
    id: 'pentest-rce-focus',
    label: 'Pentest RCE 主线工具面',
    prefixes: [
      'webshell_', 'operation_', 'subagent', 'workflow', 'attack_',
      'redteam_atlas_', 'redteam_chain_', 'redteam_coverage_',
      'campaign_', 'trace_',
      'crackmapexec_', 'netexec_', 'impacket_',
      'access_confirm', 'memshell_cli',
      'nday_coverage', 'nday_triage', 'nday_learn', 'nday_draft', 'nday_handoff',
    ],
    exceptions: ['attack_plan', 'nday_coverage', 'nday_draft', 'nday_handoff', 'nday_learn'],
    modes: ['code-audit', 'ctf-solver'],
    source: 'preset/pentest/agent.patch.yml —— RCE 后停止；不做子代理派单、流程矩阵、后渗透或内网工作',
    note: 'Pentest 仅保留快速侦察、Nday/常规/0day 路径、最小 RCE 验证与结果记录；按需工具包入口由独立规则控制',
  },
  {
    id: 'toolPack',
    label: '按需工具包入口',
    prefixes: ['tool_pack'],
    modes: ['pentest'],
    source: 'dsh-tool-scope/lib/packs.js —— 工具包是三个安全预设的运行期能力',
    note: '当前仅 Pentest 声明 WebShell 工具包；其他模式下入口不暴露',
  },
]

/**
 * 算出「在当前模式下应当隐藏」的工具名。
 *
 * **为什么从 `known` 里筛而不是写死名字**：宿主的 `tools.restrict()` 对**未知工具名会抛错**
 * （见 index.ts:1080 `names unknown global tool`），它把「名字写错」当成配置错误而非静默忽略 ——
 * 这是好事，但要求我们只 deny **确实存在**的名字。所以每次都用实时工具清单来筛。
 *
 * @param {string} mode - 当前会话的模式（preset id）；空串 = 宿主默认预设
 * @param {readonly string[]} known - 当前已知的全局工具名
 * @param {readonly ToolScopeRule[]} rules - 生效的规则（已按开关过滤）
 * @returns {string[]} 应隐藏的工具名（去重、稳定排序）
 */
export function computeDeny(mode, known, rules) {
  const deny = new Set()
  for (const rule of rules) {
    if (rule.modes.includes(mode)) continue // 该模式下可见
    for (const name of known) {
      if (rule.exceptions?.includes(name)) continue
      if (rule.prefixes.some((p) => name.startsWith(p))) deny.add(name)
    }
  }
  return [...deny].sort()
}

/**
 * 按规则表统计「若应用会省下多少」——给 UI/日志用的预估，不参与过滤。
 * @param {readonly string[]} known - 当前已知工具名
 * @param {readonly ToolScopeRule[]} rules - 规则
 * @returns {Map<string, string[]>} 规则 id -> 该规则命中的工具名
 */
export function matchByRule(known, rules) {
  const out = new Map()
  for (const rule of rules) {
    const hit = known.filter((n) => rule.prefixes.some((p) => n.startsWith(p)))
    if (hit.length) out.set(rule.id, hit.sort())
  }
  return out
}

/**
 * 过滤出启用中的规则。
 * @param {Record<string, unknown>} [toggles] - 规则 id -> 是否启用（缺省视为启用）
 * @returns {ToolScopeRule[]}
 */
export function enabledRules(toggles) {
  const t = toggles && typeof toggles === 'object' ? toggles : {}
  return RULES.filter((r) => t[r.id] !== false)
}
