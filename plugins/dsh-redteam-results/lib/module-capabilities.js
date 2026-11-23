// Runtime capability projection for test modules. This is a read-only view:
// browsing never executes a binary, starts an MCP server or runs a target
// request. It only combines the current Host tool schema with the operator's
// sec-config path map and the verified tool-runtime resolver.
import process from 'node:process'
import { configuredToolPaths, resolveToolBin } from 'dsh-saker/tool-runtime'
import { readSettingsSection } from 'dsh-saker/settings-compat'
import { availableToolNames } from 'dsh-saker/tool-availability'

const CACHE_TTL_MS = 15_000
let cache = null

const HOST_CAPABILITIES = {
  http: { label: '受管 HTTP/回执', tool: 'redteam_execution' },
  browser: { label: '隔离浏览器', tool: 'redteam_execution' },
  material: { label: '材料读取/解析', tool: 'saker_material' },
  component: { label: '组件事实/公告/上游', tool: 'saker_component' },
  hunter: { label: 'FOFA/Quake 资产检索', tool: 'asset_search' },
  oob: { label: '带外回连', tool: 'oob_probe' },
  'raw-protocol': { label: '原始请求/报文', tool: 'redteam_execution' },
  tls: { label: 'TLS 握手/证书', tool: 'tls_probe' },
  'ad-export': { label: 'AD 导出解析', tool: 'ad_export_ingest' },
  isolation: { label: '隔离容器复现', tool: 'version_reproduce' },
  task: { label: '任务/项目检查', tool: 'redteam_task' },
  research: { label: '公开资料研究', tool: 'redteam_research' },
}

const BINARY_CAPABILITIES = {
  httpx: { label: 'httpx', tool: 'httpx_probe', bin: 'httpx', key: 'httpx' },
  subfinder: { label: 'subfinder', tool: 'subfinder_enum', bin: 'subfinder', key: 'subfinder' },
  nuclei: { label: 'nuclei', tool: 'nuclei_scan', bin: 'nuclei', key: 'nuclei' },
  afrog: { label: 'afrog', tool: 'afrog_scan', bin: 'afrog', key: 'afrog' },
  ffuf: { label: 'ffuf', tool: 'ffuf_fuzz', bin: 'ffuf', key: 'ffuf' },
  dirsearch: { label: 'dirsearch', tool: 'dirsearch_dirs', bin: 'dirsearch', key: 'dirsearch' },
  katana: { label: 'katana', tool: 'katana_crawl', bin: 'katana', key: 'katana' },
  nmap: { label: 'nmap', tool: 'nmap_portscan', bin: 'nmap', key: 'nmap' },
  fscan: { label: 'fscan', tool: 'fscan_portscan', bin: 'fscan', key: 'fscan' },
  sqlmap: { label: 'sqlmap', tool: 'sqlmap_inject', bin: 'sqlmap', key: 'sqlmap' },
  semgrep: { label: 'semgrep', tool: 'semgrep_scan', bin: 'semgrep', key: 'semgrep' },
  tshark: { label: 'tshark', tool: '', bin: 'tshark', key: 'tshark' },
  jwt: { label: 'jwt_tool', tool: '', bin: 'jwt_tool', key: 'jwt_tool' },
  sourcemapper: { label: 'sourcemapper', tool: '', bin: 'sourcemapper', key: 'sourcemapper' },
  jshunter: { label: 'jshunter', tool: '', bin: 'jshunter', key: 'jshunter' },
  jsluice: { label: 'jsluice', tool: '', bin: 'jsluice', key: 'jsluice' },
  getjs: { label: 'getJS', tool: '', bin: 'getJS', key: 'getjs' },
  subjs: { label: 'subjs', tool: '', bin: 'subjs', key: 'subjs' },
  webcrack: { label: 'webcrack', tool: 'js_deobfuscate', bin: 'webcrack', key: 'webcrack' },
  synchrony: { label: 'synchrony', tool: '', bin: 'synchrony', key: 'synchrony' },
  chisel: { label: 'chisel', tool: '', bin: 'chisel', key: 'chisel' },
  ligolo: { label: 'ligolo-ng', tool: '', bin: 'ligolo-ng', key: 'ligolo' },
  adalanche: { label: 'Adalanche', tool: '', bin: 'Adalanche', key: 'adalanche' },
  seatbelt: { label: 'Seatbelt', tool: 'seatbelt_posture', bin: 'Seatbelt', key: 'seatbelt' },
  sharphound: { label: 'SharpHound', tool: '', bin: 'SharpHound', key: 'sharphound' },
}

// Each inner array is one required group; any member of the group satisfies
// it. Groups are ANDed. Missing groups are shown to the user instead of
// pretending the module is fully available.
const MODULE_REQUIREMENTS = {
  'scope-attribution': [['material', 'http', 'research']],
  'asset-discovery': [['hunter', 'research']],
  'subdomain-discovery': [['subfinder', 'research']],
  'dns-origin-analysis': [['http', 'research']],
  'service-discovery': [['nmap', 'fscan']],
  'web-liveness': [['httpx', 'http', 'browser']],
  'surface-discovery': [['katana', 'browser', 'http']],
  'content-discovery': [['ffuf', 'dirsearch', 'http']],
  'js-analysis': [['material', 'browser', 'katana']],
  'api-schema-analysis': [['material', 'http', 'browser']],
  'fingerprint': [['httpx', 'http']],
  'public-source-research': [['research', 'http']],
  'material-parse': [['material']],
  'business-map': [['material', 'http', 'browser']],
  'nday-match': [['component']],
  'change-research': [['component'], ['http', 'research']],
  'component-applicability': [['component']],
  'version-reproduction': [['isolation']],
  'variant-research': [['material', 'component']],
  'template-check': [['nuclei', 'afrog']],
  'identity-compare': [['http', 'browser']],
  'auth-session-test': [['http', 'browser', 'material']],
  'api-contract-test': [['http', 'material']],
  'injection-test': [['http', 'sqlmap']],
  'client-side-test': [['browser', 'material']],
  'server-fetch-test': [['http', 'oob']],
  'file-boundary-test': [['http', 'browser', 'material']],
  'business-logic-test': [['http', 'browser']],
  'protocol-boundary-test': [['raw-protocol', 'http']],
  'config-exposure-test': [['http', 'material']],
  'crypto-transport-test': [['tls']],
  'ai-app-test': [['http', 'material']],
  'targeted-verify': [['http', 'material', 'browser']],
  'impact-proof': [['http', 'material']],
  'response-diff': [['material', 'http']],
  'evidence-review': [['material', 'http']],
  'local-retest': [['http', 'browser', 'material']],
  'result-summary': [['material']],
  'code-audit': [['semgrep', 'material']],
  'project-check': [['task', 'material']],
  'ctf-solve': [['task', 'http']],
  'js-resource-discovery': [['katana', 'browser', 'getjs', 'subjs', 'http']],
  'js-chunk-discovery': [['katana', 'browser', 'jshunter']],
  'sourcemap-recovery': [['sourcemapper', 'http', 'material']],
  'js-deobfuscation': [['webcrack', 'synchrony']],
  'secret-assessment': [['jsluice', 'jshunter', 'material']],
  'jwt-analysis': [['jwt', 'http']],
  'traffic-analysis': [['tshark', 'material']],
  'ad-recon': [['ad-export', 'sharphound', 'adalanche']],
  'ad-path-review': [['ad-export', 'adalanche', 'sharphound']],
  'host-posture': [['seatbelt']],
  'internal-service-review': [['nmap', 'fscan']],
  'credential-policy-audit': [['material']],
  'network-path-check': [['http'], ['chisel', 'ligolo']],
}

const STATUS_LABEL = {
  available: '可用',
  partial: '部分可用',
  blocked: '缺少能力',
  unknown: '未探测',
}

function splitRoots(value) {
  return String(value || '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map(item => item.trim())
    .filter(Boolean)
}

function visibleToolNames(ctx, agent) {
  const names = new Set()
  try {
    for (const tool of (ctx?.tools?.schemas?.(agent) || [])) {
      const name = String(tool?.name || '')
      if (name) names.add(name)
    }
  } catch { /* scoped schema may be unavailable outside a model step */ }
  try {
    for (const name of (ctx?.tools?.view?.(agent)?.knownNames || [])) {
      const value = String(name || '')
      if (value) names.add(value)
    }
  } catch { /* older hosts expose only schemas */ }
  for (const name of availableToolNames()) names.add(name)
  return names
}

function inspectCapabilities(ctx, agent) {
  const section = readSettingsSection(ctx?.settings, 'sec-config', {}) || {}
  const configured = configuredToolPaths(section)
  const roots = [...new Set([
    ...(Array.isArray(section.roots) ? section.roots.filter(item => typeof item === 'string' && item.trim()) : []),
    ...splitRoots(process.env.SAKER_TOOL_ROOTS),
  ])]
  const visible = visibleToolNames(ctx, agent)
  const cacheKey = JSON.stringify({ roots, configured, visible: [...visible].sort(), available: [...availableToolNames()].sort() })
  const now = Date.now()
  if (cache && cache.key === cacheKey && now - cache.at < CACHE_TTL_MS) return cache.snapshot

  const capabilities = {}
  for (const [key, spec] of Object.entries(HOST_CAPABILITIES)) {
    const available = visible.has(spec.tool)
    capabilities[key] = {
      key, label: spec.label, kind: 'host-tool', tool: spec.tool || '',
      status: available ? 'verified' : 'missing',
      detail: available ? '当前 Host 已暴露该工具。' : '当前 Host 未暴露该工具。',
    }
  }
  for (const [key, spec] of Object.entries(BINARY_CAPABILITIES)) {
    let file = null
    try { file = resolveToolBin(spec.bin, configured[spec.key] || configured[spec.bin] || '', { roots }) } catch { file = null }
    const wrapped = spec.tool ? visible.has(spec.tool) : false
    capabilities[key] = {
      key, label: spec.label, kind: 'binary', tool: spec.tool || '',
      status: file && wrapped ? 'verified' : file ? 'present' : 'missing',
      path: file || '',
      detail: file
        ? (wrapped ? '二进制已解析，Host 工具合同已暴露。' : '二进制已解析，但没有已验证的 Host 工具合同。')
        : '未在配置路径、工具根或 PATH 中解析到。',
    }
  }
  // The public-research tool is usually a Host search/browser capability, not
  // a Saker tool. Any visible search/fetch/browser tool satisfies the source
  // research path without claiming a specific provider is configured.
  if (capabilities.research.status === 'missing' && [...visible].some(name => /search|fetch|browser|web/i.test(name))) {
    capabilities.research = { ...capabilities.research, status: 'verified', tool: [...visible].find(name => /search|fetch|browser|web/i.test(name)) || '', detail: '当前 Host 暴露了公开检索/网页能力。' }
  }
  const snapshot = { capabilities, roots, configured, visible: [...visible] }
  cache = { key: cacheKey, at: now, snapshot }
  return snapshot
}

function statusOf(capability) {
  return capability && ['verified', 'present'].includes(capability.status) ? capability.status : 'missing'
}

export function evaluateModuleCapabilities(definition = {}, snapshot) {
  const groups = MODULE_REQUIREMENTS[definition.id] || [['http', 'material', 'research']]
  const capabilityMap = snapshot?.capabilities || {}
  if (!snapshot || !Array.isArray(snapshot.visible) || snapshot.visible.length === 0) {
    return {
      definitionStatus: definition.source === 'builtin' ? 'defined' : definition.source === 'personal' ? 'personal' : 'draft',
      adapterStatus: 'unknown',
      runtimeStatus: 'unknown',
      statusLabel: STATUS_LABEL.unknown,
      canExecute: true,
      capabilities: groups.flatMap(group => group).map(key => capabilityMap[key] || {
        key, label: key, status: 'unknown', detail: '当前上下文没有可用的 Host schema，尚未探测。', kind: 'unknown', tool: '',
      }),
      tools: [],
      missingPrerequisites: [],
    }
  }
  const evaluated = groups.map(group => {
    const members = group.map(key => capabilityMap[key] || {
      key, label: key, status: 'missing', detail: '该能力没有已注册适配器。', kind: 'unknown', tool: '',
    })
    const verified = members.some(item => item.status === 'verified')
    const satisfied = verified || members.some(item => item.status === 'present')
    return { satisfied, verified, members }
  })
  const missingPrerequisites = evaluated.filter(item => !item.satisfied).map(item => ({
    code: 'MISSING_CAPABILITY',
    message: '缺少：' + item.members.map(member => member.label || member.key).join(' / '),
    alternatives: item.members.map(member => member.key),
  }))
  const satisfiedCount = evaluated.filter(item => item.satisfied).length
  const presentOnly = evaluated.some(item => item.satisfied && !item.verified)
  const runtimeStatus = satisfiedCount === 0 ? 'blocked' : missingPrerequisites.length || presentOnly ? 'partial' : 'available'
  const capabilities = [...new Map(evaluated.flatMap(item => item.members).map(item => [item.key, item])).values()]
  const adapterStatus = capabilities.some(item => item.status === 'verified')
    ? 'verified'
    : capabilities.some(item => item.status === 'present') ? 'candidate' : 'missing'
  return {
    definitionStatus: definition.source === 'builtin' ? 'defined' : definition.source === 'personal' ? 'personal' : 'draft',
    adapterStatus,
    runtimeStatus,
    statusLabel: STATUS_LABEL[runtimeStatus],
    canExecute: runtimeStatus !== 'blocked',
    capabilities,
    tools: capabilities.filter(item => item.status !== 'missing').map(item => item.label),
    missingPrerequisites,
  }
}

export function moduleCapabilityResolver(ctx, agent) {
  const snapshot = inspectCapabilities(ctx, agent)
  return definition => evaluateModuleCapabilities(definition, snapshot)
}
