// dsh-sec-config — host plugin.
// Owns the `sec-config` settings namespace (local tool paths, service endpoints,
// DNSLog, API keys), serves a loopback RPC for the settings page, and injects
// the configured tool paths into the agent shell as DSH_TOOL_* variables so the
// pentest/audit playbooks can discover tools without hardcoded paths.
//
// Bridges `services.burpUrl` / `services.yakitUrl` into mcp-studio.servers so
// editing these endpoints in the "安全配置" page also feeds the model's MCP tool
// registry (mcp__burp__* / mcp__yakit__*) — saves the operator a second trip
// to the "MCP 工作台" for the same source-of-truth data.
import z from '@deepseek-ai/schemastery'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { startModelProxy } from './model-proxy.js'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-sec-config'
export const inject = ['connection', 'settings', 'shellEnv', 'systemPrompt', 'webServer']

const NAMESPACE = 'sec-config'
const CHANNEL = '/dsh-sec-config'
const MCP_STUDIO_NAMESPACE = 'mcp-studio'

/**
 * Preset tool definitions shown in the 安全配置 page, grouped by category.
 * The page lets the operator pick from this list, add their own custom tools
 * (arbitrary key), or remove any entry — the manifest below always reflects the
 * live tools object (preset keys + custom keys), and every preset key is
 * injected into the shell as DSH_TOOL_<NAME>.
 */
export const TOOL_PRESETS = [
  { key: 'subfinder', label: 'Subfinder', category: '信息收集' },
  { key: 'httpx', label: 'Httpx', category: '信息收集' },
  { key: 'nmap', label: 'Nmap', category: '信息收集' },
  { key: 'nuclei', label: 'Nuclei', category: '漏洞扫描' },
  { key: 'afrog', label: 'Afrog', category: '漏洞扫描' },
  { key: 'dirsearch', label: 'Dirsearch', category: '目录与接口' },
  { key: 'katana', label: 'Katana', category: '目录与接口' },
  { key: 'ffuf', label: 'Ffuf', category: '目录与接口' },
  { key: 'sqlmap', label: 'SQLMap', category: '注入与利用' },
  { key: 'jwt_tool', label: 'JWT Tool', category: '令牌与认证' },
  // 内网与横向（v0.3.0 新增；fscan 归类于此，二进制由用户自备）
  { key: 'fscan', label: 'Fscan', category: '内网与横向' },
  { key: 'chisel', label: 'Chisel', category: '内网与横向' },
  { key: 'frp', label: 'Frp', category: '内网与横向' },
  { key: 'impacket', label: 'Impacket', category: '内网与横向' },
  { key: 'ladon', label: 'Ladon', category: '内网与横向' },
  { key: 'kerbrute', label: 'Kerbrute', category: '内网与横向' },
  { key: 'mimikatz', label: 'Mimikatz', category: '内网与横向' },
  { key: 'bloodhound', label: 'BloodHound', category: '内网与横向' },
]

export const TOOL_CATEGORIES = ['信息收集', '漏洞扫描', '目录与接口', '注入与利用', '令牌与认证', '内网与横向']

/** Preset tool keys whose paths the shell receives as DSH_TOOL_<NAME>. */
const TOOL_KEYS = TOOL_PRESETS.map((t) => t.key)

/** Custom (operator-defined) tool keys may also be configured; they are listed
 * in the prompt manifest and callable via PATH, but are not declared as
 * DSH_TOOL_* shell variables (the shell-env registry requires a static
 * declaration set at registration time). */
const TOOL_KEY_RE = /^[A-Za-z0-9_]+$/

function isToolKey(key) {
  return typeof key === 'string' && TOOL_KEY_RE.test(key) && key.length <= 40
}

/** Fields the client may write through settings/mutate. */
const WRITABLE_FIELDS = new Set(['tools', 'services', 'dnslog', 'apiKeys', 'scanRoots', 'hiddenTools', 'roots', 'categories', 'entries', 'model'])

/** 模型接入落在 llm-pi-ai 命名空间下的 providers.<id>.baseURL。 */
const LLM_PI_AI_NAMESPACE = 'llm-pi-ai'
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** Secret-bearing fields: redacted on read; an empty/`***` write is ignored. */
const SECRET_FIELDS = new Set(['dnslog.token', 'apiKeys.deepseekKey'])

/**
 * Default search paths for the Burp MCP stdio proxy JAR. The Burp
 * `burp-mcp-all.jar` ships the proxy logic compiled into one fat jar with no
 * extract command exposed; this list lets the operator drop the JAR (e.g.
 * extracted from the Burp MCP tab "Extract server proxy..." button) at a
 * predictable location and have sec-config wire it up without further config.
 *
 * Paths are derived from the user profile / common install roots rather than
 * any machine-specific absolute path, so a fresh clone works unchanged on
 * another host. The JAR is optional: the in-package stdio bridge is preferred
 * and needs no Java runtime at all.
 */
const BURP_PROXY_DEFAULT_PATHS = [
  join(homedir(), 'Downloads', 'mcp-proxy-all.jar'),
  join(homedir(), 'mcp-proxy-all.jar'),
  join(homedir(), 'burp-mcp', 'mcp-proxy-all.jar'),
]

/**
 * Candidate locations for the stdio-to-SSE bridge script, in order:
 *   1. `services.burpBridgeScript` — explicit operator override (settings).
 *   2. In-package copy shipped with this plugin (tools/burp-sse-bridge.mjs),
 *      resolved from import.meta.url so it works wherever the plugin lands.
 * The bridge is preferred over the fat-jar proxy because the Burp extension
 * failed the "Extract server proxy..." step with `Could not find
 * mcp-proxy-all.jar in extension resources` (proxy compiled in, not
 * extractable) and the bridge needs no Java runtime.
 */

/** Locate the preferred stdio bridge script; empty string when absent. */
function resolveBurpBridgeScript(section) {
  // 1. explicit override in settings
  const override = section && section.services && section.services.burpBridgeScript
  if (typeof override === 'string' && override.trim()) {
    try { if (existsSync(override)) return override } catch { /* fall through */ }
  }
  // 2. in-package copy (import.meta.url -> ../tools/burp-sse-bridge.mjs)
  try {
    const pkg = new URL('../tools/burp-sse-bridge.mjs', import.meta.url)
    if (existsSync(fileURLToPath(pkg))) return fileURLToPath(pkg)
  } catch { /* fall through */ }
  return ''
}

/**
 * Absolute path to the Node interpreter used for stdio MCP children.
 *
 * A bare `node` would be resolved against the HOST process PATH, which differs
 * from the interactive shell PATH: when the platform is started by absolute
 * path (Start-Process / service / .lnk), PATH frequently has no node directory
 * and the child dies with `'node' 不是内部或外部命令`. `process.execPath` is
 * the exact interpreter running us, so it always works and avoids version drift
 * between host and child. Forward slashes keep mcp-studio's splitArgs from
 * treating backslashes as shell escapes.
 */
function resolveNodeCommand() {
  try {
    const exe = process.execPath
    if (typeof exe === 'string' && exe) return exe.replace(/\\/g, '/')
  } catch { /* fall through */ }
  return 'node'
}

/**
 * Stable ids the sec-config bridge writes for the servers it manages. Picking a
 * fixed id (instead of a timestamp) keeps writes idempotent across page reloads
 * and lets mcp-studio reconcile without churning the mount cycle.
 */
const SEC_MANAGED_IDS = {
  burp: 'srv-sec-burp',
  yakit: 'srv-sec-yakit',
}

const toolShape = {}
for (const key of TOOL_KEYS) toolShape[key] = z.string().default('')

const Config = z.object({
  tools: z.object(toolShape),
  services: z.object({
    burpUrl: z.string().default(''),
    yakitUrl: z.string().default(''),
    burpBridgeScript: z.string().default(''),
  }),
  dnslog: z.object({
    url: z.string().default(''),
    token: z.string().default(''),
  }),
  apiKeys: z.object({
    deepseekKey: z.string().default(''),
  }),
  /** 模型接入：把 dsh 的 llm-pi-ai provider 指向「本机代理」还是「直连上游」。
   *  OpenCode Go 这类网关要求 x-opencode-session 头，dsh 不自带 —— 直连必报
   *  400 MissingSessionID，走本机代理由代理补齐会话头并按需剥私有字段。
   *  注意 dsh 会在 baseURL 后自动拼 /chat/completions，所以这里只到 /v1。 */
  model: z.object({
    provider: z.string().default('custom'),
    /** proxy=走本机代理（推荐） / direct=直连上游 / custom=自定义地址 */
    mode: z.string().default('proxy'),
    /** mode=proxy 时：由本插件自己起内置代理（false 则假定已有外部程序在监听该端口） */
    builtin: z.boolean().default(true),
    listenHost: z.string().default('127.0.0.1'),
    listenPort: z.number().default(8788),
    upstream: z.string().default('https://opencode.ai/zen/go'),
    customBaseUrl: z.string().default(''),
    /** 剥掉客户端注入的私有字段（不剥上游会 400 Extra inputs are not permitted） */
    sanitize: z.boolean().default(true),
    userAgent: z.string().default('saker-sec-config/1.0'),
    /**
     * 端点档案：可一键切换的多个上游地址。存在的意义是「换供应商不用手改配置」——
     * 上游（如 OpenCode Go）改了鉴权方式、或将来 dsh 原生就能接，点一下切过去即可，
     * 不用去「设置 → 模型」手改 baseURL。
     * kind=default 的档位是**清除覆盖**（unset providers.<id>.baseURL）。
     *
     * ⚠️ 但清除覆盖**只对 dsh 内建目录里的 provider 成立**。实测报错原文：
     *   `provider "custom" model "glm-5.3-flash" needs a baseURL;
     *    the installed catalog does not describe this route`
     * 即：自定义 provider + 不在内建目录里的模型 id 时，baseURL 是**必填**，
     * 所谓「dsh 默认端点」根本不存在。所以真正的「回得去」要靠下面的 baseline
     * （第一次见到该 provider 的地址时存下来），而不是靠 unset。
     */
    endpoints: z.array(z.object({
      id: z.string().default(''),
      name: z.string().default(''),
      baseURL: z.string().default(''),
      kind: z.string().default('custom'),
      note: z.string().default(''),
    })).default([]),
    /** 初始地址快照：首次读到某 provider 的 baseURL 时记下。用于「恢复初始地址」——
     *  这是自定义 provider 唯一可靠的「回得去」手段（unset 会被宿主判为非法配置）。 */
    baseline: z.object({
      provider: z.string().default(''),
      baseURL: z.string().default(''),
      capturedAt: z.string().default(''),
    }).default({}),
  }),
  /** 工具库 v2：一个或多个「工具根目录」。选择后一键探测并按分类导入；也支持单目录。 */
  roots: z.array(z.string()).default([]),
  /** 分类自定义：内置分类不可删，追加的自定义分类名放这里。 */
  categories: z.array(z.string()).default([]),
  /** 工具库资产条目：key=稳定标识（preset key 或文件名规整），name=展示名，
   * path=绝对路径，category=分类 id。entries 为空且 tools 有值（旧版）时按 tools 兼容。 */
  entries: z.array(z.object({
    key: z.string(),
    name: z.string().default(''),
    path: z.string().default(''),
    category: z.string().default('其他'),
  })).default([]),
  /** 供「工具自动探测」扫描的候选根（用户可选填；留空则用已配工具父目录）。 */
  scanRoots: z.array(z.string()).default([]),
  /** 被用户从工具行「隐藏」的 preset/自定义工具 key：行不展示、不进 manifest、
   * 不进 shell 环境；路径配置值保留，随时可恢复（移除 ≠ 删除配置）。
   *
   *  ⚠ **它不是「从模型工具列表移除」**（2026-09-14 澄清）：只过滤提示词里那一行
   *  `tools: …` 清单文字与 `DSH_TOOL_*` 环境变量，**工具 schema 该带还是带** ——
   *  勾了不省请求字节。真正要把声明从每轮请求里去掉，用 `dsh-tool-scope`
   *  （走宿主 `agent.ctx.tools.restrict({deny})`）。
   *  另注：当前版本 UI 未提供该字段的勾选入口，默认空数组 —— 属预留能力。 */
  hiddenTools: z.array(z.string()).default([]),
})

/** 兜底/缺省分类。 */
const CATEGORY_FALLBACK = '其他'

/** 内置分类顺序（对应常见攻防工具库目录结构；自定义分类追加在其后）。 */
export const TOOL_CATEGORY_ORDER = ['信息收集', '漏洞扫描', '目录与接口', '注入与利用', '令牌与认证', '内网与横向', CATEGORY_FALLBACK]

/** 由路径（目录名/文件名）推断分类的线索。命中先后即优先级。 */
const CATEGORY_HINTS = [
  { category: '内网与横向', re: /内网|域渗透|横向|kerberos|ad |bloodhound|mimikatz|impacket|内网扫描|提权|权限维持|隧道/i },
  { category: '目录与接口', re: /目录|接口|fuzz|ffuf|dirsearch|katana|爆破|字典/i },
  { category: '漏洞扫描', re: /漏洞|扫描|nuclei|afrog|xray|vuln/i },
  { category: '注入与利用', re: /注入|利用|sqlmap|exploit|payload|upload|上传/i },
  { category: '令牌与认证', re: /令牌|认证|jwt|token|cookie|登录|auth/i },
  { category: '信息收集', re: /信息收集|recon|subfinder|httpx|指纹|资产|测绘|whois|枚举/i },
]

/** 内置分类目录名（用户 tools 目录风格）到分类的精确映射，优先级高于线索。 */
const CATEGORY_DIR_EXACT = [
  ['01-信息收集', '信息收集'], ['信息收集', '信息收集'],
  ['02-漏洞扫描', '漏洞扫描'], ['漏洞扫描', '漏洞扫描'],
  ['03-目录与接口', '目录与接口'], ['目录与接口', '目录与接口'], ['目录爆破', '目录与接口'],
  ['04-注入与利用', '注入与利用'], ['注入与利用', '注入与利用'], ['漏洞利用', '注入与利用'], ['利用工具', '注入与利用'],
  ['05-令牌与认证', '令牌与认证'], ['令牌与认证', '令牌与认证'], ['认证与令牌', '令牌与认证'],
  ['06-内网与域渗透', '内网与横向'], ['05-内网与域渗透', '内网与横向'], ['内网与域渗透', '内网与横向'], ['内网渗透', '内网与横向'], ['内网', '内网与横向'], ['域渗透', '内网与横向'], ['横向', '内网与横向'],
]

/**
 * 用户目录风格分类（Tools/01-WebShell管理 … 11-报告与模板）。当「工具根目录」
 * 下就是这种编号分类目录时，直接沿用目录名作为分类 id（保留编号前缀，与
 * 操作者自己的目录一一对应），不再猜内置分类。
 */
const USER_CATEGORY_DIR_RE = /^\d{1,2}\s*[-_.]\s*\S/

/** 分类 id：优先沿用用户自己的编号分类目录名，其次内置精确映射/线索，最后兜底。 */
function categoryForPath(full) {
  const parts = String(full || '').split(/[\\/]/).filter(Boolean)
  const lower = String(full || '').toLowerCase()
  for (const [dir, cat] of CATEGORY_DIR_EXACT) {
    if (lower.includes(dir.toLowerCase())) return cat
  }
  for (const { category, re } of CATEGORY_HINTS) {
    if (re.test(lower)) return category
  }
  return CATEGORY_FALLBACK
}

/**
 * 分类 id（目录感知版）：若路径的「根目录下一级」是编号分类目录
 * （01-WebShell管理 / 05-内网与域渗透…），直接用它——这是操作者自己的分类
 * 体系，必须原样沿用；否则退回内置精确映射/线索推断。
 * 注意：roots 可能来自浏览器输入（分隔符可能是 / 或 //），路径比较需归一化。
 */
function normSep(value) {
  return String(value || '').replace(/[\\/]+/g, '\\')
}

/**
 * 规范化写入的路径类字段，避免 `<盘符>/dir/subdir\leaf` 这类混用分隔符
 * 落盘后让下游插件（webshell-mgr / scanner-tools 等）解析失败：
 *   - roots / scanRoots：数组，逐项归一化并去掉尾部斜杠
 *   - tools / entries[].path：字符串绝对路径，归一化为反斜杠
 */
function normalizeOpValue(pathArr, value) {
  const head = String(pathArr[0] || '')
  if (head === 'roots' || head === 'scanRoots') {
    if (!Array.isArray(value)) return value
    return value.map((v) => (typeof v === 'string' ? normSep(v.trim()).replace(/\\+$/, '') : v)).filter((v) => v !== '')
  }
  if (head === 'tools') {
    return typeof value === 'string' ? normSep(value.trim()) : value
  }
  if (head === 'entries') {
    const fixOne = (e) => (e && typeof e === 'object' && typeof e.path === 'string'
      ? { ...e, path: normSep(e.path.trim()) }
      : e)
    if (Array.isArray(value)) return value.map(fixOne)
    return fixOne(value)
  }
  return value
}

function categoryForScanPath(full, root) {
  const fullNorm = normSep(full)
  const rootNorm = normSep(root).replace(/\\+$/, '')
  const rel = rootNorm && fullNorm.toLowerCase().startsWith(rootNorm.toLowerCase())
    ? fullNorm.slice(rootNorm.length).replace(/^\\+/, '')
    : fullNorm
  const segs = rel.split('\\').filter(Boolean)
  if (segs.length >= 2 && USER_CATEGORY_DIR_RE.test(segs[0])) return segs[0]
  return categoryForPath(fullNorm)
}

/** 由旧版 tools（仅 preset key）或自定义 key 生成兼容条目。 */
function entriesFromLegacyTools(tools) {
  const byKey = new Map(TOOL_PRESETS.map((t) => [t.key, t]))
  const out = []
  for (const [key, val] of Object.entries(tools || {})) {
    if (typeof val !== 'string' || !val) continue
    const meta = byKey.get(key)
    out.push({
      key,
      name: meta ? meta.label : key,
      path: val,
      category: meta ? meta.category : CATEGORY_FALLBACK,
    })
  }
  return out
}

/** 工具库条目（v2 entries；空时回退旧版 tools 以兼容历史配置）。 */
export function entriesOf(section) {
  if (Array.isArray(section && section.entries) && section.entries.length > 0) return section.entries
  const tools = (section && section.tools) || {}
  const legacy = entriesFromLegacyTools(tools)
  return legacy.length > 0 ? legacy : []
}

/** 条目 → tools 映射（供 manifest/shell 等既有消费者）。 */
export function toolsOf(section) {
  const out = {}
  for (const e of entriesOf(section)) {
    if (e && typeof e.key === 'string' && e.key && typeof e.path === 'string' && e.path) {
      if (out[e.key] === undefined) out[e.key] = e.path
    }
  }
  return out
}

function ok(value) { return { ok: true, value } }
function failure(message) { return { ok: false, error: { code: 'sec-config', message: String(message), details: {} } } }

function redact(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redact)
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = redact(v)
  if (value && typeof value.token === 'string' && value.token) out.token = '***'
  if (value && typeof value.deepseekKey === 'string' && value.deepseekKey) out.deepseekKey = '***'
  return out
}

/** Merge a `set` op into the current object, resolving dotted secret paths. */
function applyOps(current, ops) {
  const next = JSON.parse(JSON.stringify(current))
  for (const raw of ops) {
    if (!raw || typeof raw !== 'object' || raw.op !== 'set') continue
    const path = Array.isArray(raw.path) ? raw.path : []
    if (path.length === 0 || !WRITABLE_FIELDS.has(String(path[0]))) continue
    if (path.length === 1) {
      next[path[0]] = raw.value
      continue
    }
    const leaf = String(path[path.length - 1])
    let cursor = next
    for (const seg of path.slice(0, -1)) {
      if (cursor[seg] === undefined || cursor[seg] === null) cursor[seg] = {}
      cursor = cursor[seg]
    }
    cursor[leaf] = raw.value
  }
  return next
}

/** Neutralize `{{` so interpolated prompt rendering treats it as literal prose. */
function escapePromptBraces(text) {
  return text.includes('{{') ? text.replace(/\{(?=\{)/gu, '{\u2060') : text
}

function ensureSuffix(url, suffix) {
  if (!url) return url
  const trimmed = url.replace(/\/+$/u, '')
  return trimmed.endsWith(suffix) ? trimmed : trimmed + suffix
}

/** Resolve the Burp MCP stdio proxy JAR location; empty string when not found. */
function resolveBurpProxyPath() {
  for (const p of BURP_PROXY_DEFAULT_PATHS) {
    try { if (existsSync(p)) return p } catch { /* ignore */ }
  }
  return ''
}

/**
 * 工具路径"自动探测"（替代原生目录对话框——浏览器给不了绝对路径，而宿主弹窗
 * 在无交互桌面/远程会话下会不可见甚至卡死，且无法自动化验证）。
 *
 * 方案：宿主在**候选根**（用户显式填的扫描根 + 所有已配工具路径的父目录 +
 * 已知工具目录常量）里做深度受限的静默扫描，按工具名匹配出候选绝对路径，
 * 前端渲染成"一键点选"列表——体验与技能上传一致，永不弹窗、永不冻结。
 */
const TOOL_NAME_EXT_RE = /\.(exe|py|py3|jar|sh|ps1|bat|cmd|pl)$/i

/** 可作为「工具入口」的扩展名（比候选白名单更严：脚本需额外满足目录名匹配）。 */
const ENTRY_EXT_RE = /\.(exe|jar|py|py3|ps1|sh|bat|cmd|pl|rb)$/i

/** 安装包/构建残留：不作为工具（jdk-21_windows-x64_bin.exe、xxx-setup.exe…）。 */
const INSTALLER_RE = /(setup|install|uninstall|\.msi$|\.paf\.exe$|portable.*\.exe$|jdk.*_bin\.exe$)/i

/** 工具仓库里的「支撑目录」：只放库代码/测试/文档，不是工具入口。 */
const SUPPORT_DIR_RE = /^(tests?|testing|tamper|lib|libs|docs?|documentation|build|dist|thirdparty|vendor|node_modules|__pycache__|hooks?|utils?|util|modules?|config|common|templates?|certs?|servers?|poisoners?|private|plugins?|assets|static|fonts|data|include|share|man|locale|i18n|examples?|samples?|src|images?|logs?|pyinstaller|offline|db|sessions?|resources?|frontend|public|keys)$/i

/** 通用/噪音文件名主部（__init__/utils/core/cli/readme…）。
 * 注意 test 相关只匹配「测试文件」形态（test / test_xxx / xxx_test / tests），
 * 不能用 test\w* —— 那会把 testssl 这类真工具名一起吞掉。 */
const NOISE_STEM_RE = /^(__init__|__main__|utils?|core|cli|logger|log|database|db|version|entry|console|main|conftest|setup|noxfile|walkmodules|_testutils|build|build_\w+|tests?|test_\w+|\w+_test|configure|makefile|dockerfile|readme\w*|license\w*|changelog\w*|notice\w*|authors?|contributors?|copying|contributing|requirements\w*|pyproject|install\w*|package\w*|__version__|gemfile|rakefile|gemspec)$/i

/** 变体后缀（accesschk64a / Rubeus_net45 / tool-v1.2 …）→ 归一后合并为同一工具。 */
const VARIANT_RE = /[_\-]?(x64|x86|win32|win64|amd64|i386|64a?|32|net2|net35|net45|net48|v?\d+(\.\d+)*|windows|linux|osx|portable|release|debug|bin)$/i

function isToolCandidateFile(name, toolKey) {
  const lower = name.toLowerCase()
  const base = lower.replace(/\.[^.]+$/, '')
  const extOk = TOOL_NAME_EXT_RE.test(lower) || !lower.includes('.')
  if (!extOk) return false
  // 排除安装包/构建残留（nmap-7.99-setup.exe 等）
  if (/setup|install|uninstall|\.msi$|\.zip$/.test(lower)) return false
  // 文件名主部 === 工具 key（jwt_tool.py / nuclei.exe / sqlmap 等）
  if (base === toolKey.toLowerCase()) return true
  // 工具目录常见命名：fscan_2.2.1_windows_x64.exe / sqlmap-dev 等前缀匹配
  if (base.startsWith(toolKey.toLowerCase() + '_')) return true
  if (base.startsWith(toolKey.toLowerCase() + '-')) return true
  return false
}

/** 文件名命中的第一个 preset key（无则空串）。 */
function presetKeyForName(name) {
  for (const t of TOOL_PRESETS) {
    if (isToolCandidateFile(name, t.key)) return t.key
  }
  return ''
}

/** 归一化：小写 + 去非字母数字，用于目录名/文件名互比。 */
function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 去掉变体后缀后的主部，用于把 accesschk / accesschk64 / accesschk64a 归为一组。 */
function canonicalStem(value) {
  let out = String(value || '').toLowerCase()
  let prev = null
  while (prev !== out) {
    prev = out
    out = out.replace(VARIANT_RE, '').replace(/[_\- ]+$/, '')
  }
  return normName(out)
}

/**
 * 判断一个文件是否为「工具入口」。
 * - exe/jar：默认是（非安装包）；一个二进制就是一个工具。
 * - 脚本（py/ps1/sh/bat/cmd/pl）：仅当文件名主部与所在目录名互相匹配时才算
 *   （OneForAll/oneforall.py、jwt_tool/jwt_tool.py），避免把仓库内部模块
 *   （impacket/impacket/IP6.py、sqlmap/tamper/*.py）当工具收进来。
 */
function isToolEntryFile(fileName, dirName) {
  const name = String(fileName || '')
  if (INSTALLER_RE.test(name)) return false
  const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase()
  const stem = name.replace(/\.[^.]+$/, '')
  if (ext === '.exe' || ext === '.jar') return true
  if (NOISE_STEM_RE.test(stem)) return false
  const ns = normName(stem)
  const nd = normName(dirName)
  if (!ns || ns.length < 3) return false
  if (!nd || nd.length < 3) return false
  return ns === nd || ns.startsWith(nd) || nd.startsWith(ns)
}

/** 仓库标记文件：出现即说明该目录是一个独立工具仓库（而非工具内的子目录）。 */
const REPO_MARKER_RE = /^(readme\w*\.(md|txt|rst)|license\w*(\.(md|txt))?|pyproject\.toml|setup\.py|setup\.cfg|cargo\.toml|go\.mod|.*\.gemspec|.*\.sln|.*\.csproj|makefile|dockerfile)$/i

/** 源码镜像目录后缀（Rubeus-src / Seatbelt-src）——同一工具的源码副本，不重复收录。 */
const SRC_SUFFIX_RE = /[-_](src|source|dev|master|git)$/i

/**
 * 从包元数据解析仓库内的真实入口文件（Python / Go 两类常见形态）：
 *  - pyproject.toml / setup.cfg 的 console_scripts：`certipy = "certipy.entry:main"`
 *  - setup.py 的 scripts=[glob('examples/*.py')] / scripts=['bin/x.py']：
 *    impacket 这类「一仓多工具」入口只在 setup.py 里声明
 *  - go.mod：Go 项目主包入口，优先与目录同名的 .go（LadonGo/Ladon.go）
 * 返回仓库内相对路径（正斜杠），找不到返回 null。
 */
function declaredEntryForDir(dir) {
  let metaText = ''
  for (const name of ['pyproject.toml', 'setup.cfg']) {
    try { metaText = readFileSync(join(dir, name), 'utf8'); break } catch { /* try next */ }
  }
  if (metaText) {
    const re = /^\s*["']?([A-Za-z0-9_.\-]+)["']?\s*=\s*["']([A-Za-z0-9_.]+)\s*:\s*[A-Za-z0-9_]+["']/gm
    let m
    while ((m = re.exec(metaText)) !== null) {
      const parts = m[2].split('.')
      const mod = parts.pop()
      const pkg = parts.join('/')
      const rel = pkg ? `${pkg}/${mod}.py` : `${mod}.py`
      if (existsSync(join(dir, rel.split('/').join(sep)))) return rel
    }
  }
  // setup.py 的 scripts=... ：支持两种写法
  //   scripts=["bin/foo.py", "bin/bar.py"]
  //   scripts=glob.glob(os.path.join('examples', '*.py'))   ← impacket 这类多工具仓
  try {
    const setupText = readFileSync(join(dir, 'setup.py'), 'utf8')
    const sm = setupText.match(/scripts\s*=\s*(\[[\s\S]*?\]|glob[\s\S]{0,200}?\)\s*\))/)
    if (sm) {
      for (const q of sm[1].matchAll(/["']([^"']+\.(?:py|sh|pl|rb))["']/g)) {
        if (existsSync(join(dir, q[1].split('/').join(sep)))) return q[1]
      }
      const gm = sm[1].match(/glob[^)]*?["']([A-Za-z0-9_\-./]+)["']\s*,\s*["']([^"']+\.[a-z]+)["']/)
      if (gm) {
        const sub = gm[1]
        const pat = new RegExp('^' + gm[2].replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i')
        try {
          const cand = readdirSync(join(dir, sub)).filter((f) => pat.test(f)).sort()[0]
          if (cand) return `${sub}/${cand}`
        } catch { /* no such subdir */ }
      }
    }
  } catch { /* no setup.py */ }
  // Go 项目：主包入口优先与目录同名（LadonGo/Ladon.go 这类前缀匹配也算）
  try {
    if (existsSync(join(dir, 'go.mod'))) {
      const nd = normName(basename(dir))
      const cand = readdirSync(dir)
        .filter((f) => /\.go$/i.test(f) && !/^_/.test(f))
        .map((f) => ({ f, ns: normName(f.replace(/\.go$/i, '')) }))
        .filter((x) => x.ns.length >= 3 && (x.ns === nd || nd.startsWith(x.ns) || x.ns.startsWith(nd)))
        .sort((a, b) => b.ns.length - a.ns.length)[0]
      if (cand) return cand.f
    }
  } catch { /* unreadable */ }
  return null
}

/**
 * 扫描一个「工具根目录」，产出工具级候选（每个工具一项，而不是每个文件一项）。
 * 规则：
 *  1. 递归（深度 3）遍历，跳过支撑目录（tests/tamper/lib/docs…）与隐藏目录。
 *  2. exe/jar 一律视为工具；脚本需与所在目录名匹配。
 *  3. 同目录内「归一主部」相同的变体（accesschk64/64a）合并，优先 exe/jar。
 *  4. preset key 命中去重，优先 exe/jar、再取路径最短者。
 *  5. 分类沿用根目录下一级的编号分类目录名（01-WebShell管理…）。
 *  6. 目录即工具兜底：整仓库型工具（impacket/Nishang/PKINITtools…）内部没有
 *     与目录同名的脚本，此时按「仓库标记 + 声明的入口 / 代表性脚本」收录一项。
 */
function collectToolEntries(root, maxEntries = 1500) {
  const raw = []
  const dirRecords = []
  const walk = (dir, depth) => {
    if (depth > 3 || raw.length > maxEntries * 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    const fileNames = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.name === 'node_modules' || e.name === '__pycache__') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SUPPORT_DIR_RE.test(e.name)) continue
        walk(full, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      fileNames.push(e.name)
      if (!ENTRY_EXT_RE.test(e.name)) continue
      const dirName = dir.split(/[\\/]/).filter(Boolean).pop() || ''
      if (!isToolEntryFile(e.name, dirName)) continue
      raw.push({
        name: e.name,
        path: full,
        stem: e.name.replace(/\.[^.]+$/, ''),
        dir,
        category: categoryForScanPath(full, root),
        presetKey: presetKeyForName(e.name),
      })
    }
    dirRecords.push({ dir, name: basename(dir), depth, files: fileNames })
  }
  walk(root, 0)

  // 6) 目录即工具兜底：只处理「整目录未产出任何工具」的仓库型目录。
  const coveredDirs = new Set(raw.map((r) => r.dir.toLowerCase()))
  const coveredStems = new Set(raw.map((r) => normName(r.stem)))
  for (const d of dirRecords) {
    if (d.depth === 0 || d.depth > 3) continue
    if (coveredDirs.has(d.dir.toLowerCase())) continue
    // 目录内（含子目录）已有工具收录 → 不重复
    if ([...coveredDirs].some((c) => c.startsWith(d.dir.toLowerCase() + sep))) continue
    if (SRC_SUFFIX_RE.test(d.name)) continue
    if (!d.files.some((f) => REPO_MARKER_RE.test(f))) continue
    const nd = normName(d.name)
    if (nd.length < 3 || coveredStems.has(nd)) continue
    // Python 包常把入口写在元数据里（impacket/Certipy/DonPAPI），先取声明入口；
    // 没有声明时才退回目录内的代表性脚本。
    const declared = declaredEntryForDir(d.dir)
    const scripts = d.files.filter((f) => ENTRY_EXT_RE.test(f) && !INSTALLER_RE.test(f) && !NOISE_STEM_RE.test(f.replace(/\.[^.]+$/, '')))
    if (!declared && scripts.length === 0) continue
    const pickName = declared ? declared.split('/').pop() : scripts.slice().sort((a, b) => a.length - b.length)[0]
    // 展示名：有声明入口时用目录名（Certipy/DonPAPI），否则用被选脚本的主部
    // （PowerSploit/Recon/PowerView.ps1 应显示为 PowerView 而非 Recon）。
    const stem = declared ? d.name : pickName.replace(/\.[^.]+$/, '')
    raw.push({
      name: pickName,
      path: join(d.dir, declared ? declared.split('/').join(sep) : pickName),
      stem,
      dir: d.dir,
      category: categoryForScanPath(join(d.dir, pickName), root),
      presetKey: presetKeyForName(stem),
    })
  }

  // 同目录 + 同归一主部 → 合并变体
  const groups = new Map()
  for (const item of raw) {
    const key = `${item.dir}\u0000${canonicalStem(item.stem)}`
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }
  const rank = (item) => {
    const ext = (item.name.match(/\.[^.]+$/) || [''])[0].toLowerCase()
    return [ext === '.exe' || ext === '.jar' ? 0 : 1, item.stem.length, item.path.length]
  }
  const collapsed = []
  for (const list of groups.values()) {
    list.sort((a, b) => { const ra = rank(a); const rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] })
    collapsed.push(list[0])
  }
  // preset 去重（优先 exe/jar + 短路径）
  const bestPreset = new Map()
  for (const item of collapsed) {
    if (!item.presetKey) continue
    const prev = bestPreset.get(item.presetKey)
    if (!prev) { bestPreset.set(item.presetKey, item); continue }
    const ra = rank(item); const rb = rank(prev)
    if (ra[0] < rb[0] || (ra[0] === rb[0] && ra[2] < rb[2])) bestPreset.set(item.presetKey, item)
  }
  const out = [...bestPreset.values()]
  const seen = new Set(out.map((i) => `${i.stem.toLowerCase()}\u0000${i.category}`))
  for (const item of collapsed.slice().sort((a, b) => { const ra = rank(a); const rb = rank(b); return ra[0] - rb[0] || ra[2] - rb[2] })) {
    if (item.presetKey) continue
    const key = `${item.stem.toLowerCase()}\u0000${item.category}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out.slice(0, maxEntries)
}

/**
 * 收集根目录（含）下所有"可能候选"文件：扩展名在白名单内或无扩展名、
 * 且非安装包/构建残留。单次遍历一棵树，供全部工具 key 复用匹配。
 * 跳过隐藏目录（含 .git）与依赖/构建目录，避免把巨型仓库拉进探测。
 */
function collectCandidateFiles(root, sink, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.name === 'node_modules' || e.name === '__pycache__' || e.name === 'dist' || e.name === 'build') continue
    const full = join(root, e.name)
    if (e.isDirectory()) {
      collectCandidateFiles(full, sink, depth + 1, maxDepth)
    } else if (e.isFile()) {
      const lower = e.name.toLowerCase()
      const base = lower.replace(/\.[^.]+$/, '')
      const extOk = TOOL_NAME_EXT_RE.test(lower) || !lower.includes('.')
      // 文件名噪音：仓库元文件（Dockerfile/README/Makefile/锁文件等）即使命中
      // 路径段也不该作为工具候选（impacket/…/Dockerfile）。
      const noiseBase = /^(dockerfile|makefile|readme|readme\.\w+|license|copying|changelog|notice|authors|contributing|requirements.*|pyproject|cmakelists|setup|setup\.cfg|install|package.*|.*lock.*|\.env|gitignore)$/i.test(base)
      if (extOk && !noiseBase && !/setup|install|uninstall|\.msi$|\.zip$|\.7z$|\.tar|\.gz$/.test(lower)) {
        sink.push({ name: e.name, full })
      }
    }
  }
}

/**
 * 汇总候选根并扫描。同步执行；候选根 = 用户 scanRoots + 已配工具父目录两级
 * + 已配工具所在"工具基目录"（Tools/…工具…）下的数字/主题分类目录
 * （如 05-内网与域渗透），因此内网/漏扫等整库工具即使未逐一点配也能被探到。
 * 结果按短路径优先排序（更接近工具根），同一路径跨根去重。
 */
const SCAN_MAX_ROOTS = 32
const SCAN_MAX_HITS = 64

/** 是否像"工具库基目录"（Tools / 安全工具 / …bin 扁平仓除外）。 */
function isToolBaseName(name) {
  const lower = name.toLowerCase()
  return lower === 'tools' || lower === 'tool' || lower.includes('工具')
}

/** 是否像分类子目录（03-扫描与信息收集 / 05-内网与域渗透 / scan/exploit…）。 */
function isCategoryDirName(name) {
  if (/^\d{1,2}\s*[-_.]/.test(name)) return true
  return /(扫描|信息收集|漏洞|利用|注入|爆破|内网|域渗透|横向|webshell|payload|fuzz)/i.test(name)
}

/** 从已配路径上溯，找最近的"工具库基目录"。 */
function findToolBase(leaf) {
  let dir = leaf
  for (let i = 0; i < 6 && dir; i++) {
    const parent = dirname(dir)
    if (!parent || parent === dir) break
    if (isToolBaseName(parent)) return parent
    dir = parent
  }
  return ''
}

function findToolCandidates(section) {
  const tools = toolsOf(section)
  const roots = []
  const seen = new Set()
  const addRoot = (r) => {
    if (!r || seen.has(r)) return
    seen.add(r)
    roots.push(r)
  }
  // 1) 用户显式填的扫描根：v2 roots（工具根目录）+ 顶层配置 scanRoots
  if (Array.isArray(section && section.roots)) section.roots.forEach(addRoot)
  if (Array.isArray(section && section.scanRoots)) section.scanRoots.forEach(addRoot)
  // 2) 所有已配工具路径的父目录及其上一级（Tools\04-...\sqlmap → 扫 04-... 与 Tools，
  //    让同大类/同目录的 nuclei/ffuf 等互见；bin 型扁平目录自动覆盖）
  const bases = new Set()
  for (const v of Object.values(tools)) {
    if (typeof v !== 'string' || !v || v === '***') continue
    addRoot(dirname(v))
    addRoot(dirname(dirname(v)))
    const base = findToolBase(dirname(v))
    if (base) bases.add(base)
  }
  // 3) 工具基目录下的分类子目录整体纳入扫描：05-内网与域渗透/… 里即使只配过
  //    外网工具，也能据此把整类目录扫到（分类目录自身作为根，深度预算充足）。
  for (const base of bases) {
    addRoot(base)
    let entries
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      if (isCategoryDirName(e.name)) addRoot(join(base, e.name))
      if (roots.length >= SCAN_MAX_ROOTS + 8) break
    }
  }
  // 4) 随包常量里的工具根线索（mcp-proxy 父目录等）
  for (const p of BURP_PROXY_DEFAULT_PATHS) {
    try { if (existsSync(p)) addRoot(dirname(dirname(p))) } catch { /* ignore */ }
  }
  if (roots.length === 0) return { roots: [], candidates: {} }
  // 每根单次遍历收集候选文件，再按工具 key 过滤，跨根去重。
  const collected = []
  for (const root of roots.slice(0, SCAN_MAX_ROOTS)) collectCandidateFiles(root, collected)
  const candidates = {}
  for (const t of TOOL_PRESETS) {
    const hits = []
    const dup = new Set()
    for (const c of collected) {
      // 文件名匹配之外，还接受「路径某段 == 工具 key」的可执行文件：典型如
      // impacket/…/examples/secretsdump.py（仓库内脚本不带 impacket 前缀）。
      const segMatch = c.full.toLowerCase().split(/[\\/]/).includes(t.key.toLowerCase())
      if (!isToolCandidateFile(c.name, t.key) && !segMatch) continue
      if (dup.has(c.full)) continue
      dup.add(c.full)
      hits.push(c.full)
      if (hits.length >= SCAN_MAX_HITS) break
    }
    // 排序：先「可执行体名 == 工具 key」（nmap 目录里的 nmap.exe 必须排在
    // ncat.exe / ndiff.py / nping.exe 之前，否则操作者在候选里挑错东西），
    // 再短路径优先（更接近工具根），最后按字母序稳定。
    const stemOf = (p) => String(p).replace(/[\\/]/g, '/').split('/').pop().toLowerCase().replace(/\.[^.]+$/, '')
    const want = t.key.toLowerCase()
    hits.sort((a, b) => (stemOf(a) === want ? 0 : 1) - (stemOf(b) === want ? 0 : 1) || a.length - b.length || (a < b ? -1 : 1))
    candidates[t.key] = hits.slice(0, 8)
  }
  return { roots, candidates }
}

/**
 * Build one mcp-studio server entry from a sec-config service endpoint. Returns
 * `null` when the entry cannot be built (e.g. Burp with no proxy jar available).
 */
function buildServerEntry(name, rawUrl, section) {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!url) return null
  if (name === 'burp') {
    // Prefer the in-repo stdio bridge script: Burp's fat-jar proxy extraction
    // can fail on some Burp builds ("Could not find mcp-proxy-all.jar in
    // extension resources"), and the bridge is a plain Node script with no
    // Java prerequisite. Fall back to the JAR if the script is missing.
    const scriptPath = resolveBurpBridgeScript(section)
    if (scriptPath) {
      // Use forward slashes — mcp-studio's splitArgs treats backslashes as
      // shell escapes and would mangle Windows paths containing spaces and
      // CJK characters (for example, a Windows path containing CJK segments).
      const scriptPosix = scriptPath.replace(/\\/g, '/')
      return {
        id: SEC_MANAGED_IDS.burp,
        enabled: true,
        name: 'burp',
        transport: 'stdio',
        // Absolute interpreter path: a bare "node" relies on the host process
        // PATH, which is NOT the interactive shell PATH — when the platform is
        // launched by absolute path (Start-Process / service / shortcut) PATH
        // often lacks the node dir and the stdio child dies with
        // "'node' 不是内部或外部命令". process.execPath is always correct.
        command: resolveNodeCommand(),
        argsLine: `"${scriptPosix}" --sse-url ${url}`,
        env: {},
        cwd: '',
        url: '',
        headers: {},
        toolCallTimeoutMs: 60000,
        failOnStartupError: false,
      }
    }
    const proxyPath = resolveBurpProxyPath()
    if (!proxyPath) {
      return {
        id: SEC_MANAGED_IDS.burp,
        enabled: false,
        name: 'burp',
        transport: 'stdio',
        command: 'java',
        argsLine: `-jar "${proxyPath || 'PATH_MISSING'}" --sse-url ${url}`,
        env: {},
        cwd: '',
        url: '',
        headers: {},
        toolCallTimeoutMs: 60000,
        failOnStartupError: false,
        _missingProxy: true,
      }
    }
    const proxyPosix = proxyPath.replace(/\\/g, '/')
    return {
      id: SEC_MANAGED_IDS.burp,
      enabled: true,
      name: 'burp',
      transport: 'stdio',
      command: 'java',
      argsLine: `-jar "${proxyPosix}" --sse-url ${url}`,
      env: {},
      cwd: '',
      url: '',
      headers: {},
      toolCallTimeoutMs: 60000,
      failOnStartupError: false,
    }
  }
  if (name === 'yakit') {
    return {
      id: SEC_MANAGED_IDS.yakit,
      enabled: true,
      name: 'yakit',
      transport: 'streamable-http',
      command: '',
      argsLine: '',
      env: {},
      cwd: '',
      url: ensureSuffix(url, '/mcp'),
      headers: {},
      toolCallTimeoutMs: 60000,
      failOnStartupError: false,
    }
  }
  return null
}

/**
 * Mirror the current sec-config.services into mcp-studio.servers (merge by
 * name). Operators keep the convenience of a single source-of-truth page; the
 * MCP 工作台 gets auto-synced and the model's mcp__* tool registry lights up
 * on the next prompt assembly.
 */
/** 去掉首尾空白与尾部斜杠。导出供离线单测直接覆盖。 */
export function trimUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '')
}

/**
 * 按当前配置算出该写进 provider 的 baseURL。
 *
 * **只到 /v1，不要带 /chat/completions** —— dsh 会在 baseURL 后自行拼
 * `/chat/completions`，多写一层会变成 `/v1/chat/completions/chat/completions`，
 * 上游回 404（实测踩过）。
 */
export function modelBaseUrl(model) {
  const m = model && typeof model === 'object' ? model : {}
  const mode = String(m.mode || 'proxy')
  if (mode === 'direct') return trimUrl(m.upstream || 'https://opencode.ai/zen/go') + '/v1'
  if (mode === 'custom') return trimUrl(m.customBaseUrl)
  const host = String(m.listenHost || '127.0.0.1').trim() || '127.0.0.1'
  const port = Number(m.listenPort) || 8788
  return `http://${host}:${port}/v1`
}

/** 读 llm-pi-ai 里该 provider 当前生效的 baseURL；命名空间未注册时返回 null。 */
function readProviderBaseUrl(settings, provider) {
  try {
    const ns = settings.get(LLM_PI_AI_NAMESPACE)
    const entry = ns && ns.providers && ns.providers[provider]
    return entry && typeof entry.baseURL === 'string' ? entry.baseURL : null
  } catch {
    return null
  }
}

//#region 端点档案（换供应商不用手改配置）

/** 允许的档位类型。`default` 是特殊档：清除 baseURL 覆盖、回到 dsh 内建默认。 */
const ENDPOINT_KINDS = ['proxy', 'upstream', 'direct', 'default', 'custom']

/** 档案归一化（纯函数，供测试）：补齐 id/name，收敛 kind，去重 id。 */
export function normalizeEndpoints(list) {
  const out = []
  const seen = new Set()
  const arr = Array.isArray(list) ? list : []
  arr.forEach((e, i) => {
    if (!e || typeof e !== 'object') return
    let id = String(e.id || '').trim() || `ep${i + 1}`
    while (seen.has(id)) id = `${id}_`
    seen.add(id)
    const kind = ENDPOINT_KINDS.includes(String(e.kind)) ? String(e.kind) : 'custom'
    out.push({
      id,
      name: String(e.name || '').trim() || `端点 ${i + 1}`,
      baseURL: String(e.baseURL || '').trim().replace(/\/+$/, ''),
      kind,
      note: String(e.note || '').trim(),
    })
  })
  return out
}

/**
 * 决定「切到某档」要往 llm-pi-ai 写什么（纯函数，供测试）。
 *
 * 这里是整个功能唯一的易错点：`kind=default` **必须** unset 而不是 set 空串。
 * 写成空串会让 provider 拿到一个空 baseURL（请求 URL 直接畸形），
 * 表现为「切回默认之后模型全挂」——比不切还糟。
 */
export function planEndpointUse(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('端点不存在')
  if (String(profile.kind) === 'default') return { op: 'unset', baseURL: '' }
  const url = String(profile.baseURL || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('端点地址必须是 http(s):// 开头的 URL：' + (url || '（空）'))
  return { op: 'set', baseURL: url }
}

/**
 * 命中判定用的档位池（纯函数，供测试）。
 * 用户还没存档案时，界面上显示的就是**建议档**；此时如果只拿「已存档案」去比，
 * 会出现「明明写着直连上游、命中档位却说不匹配任何档案」的自相矛盾。
 * 所以池子必须 = 已存档案（非空时）否则建议档；且**两者不混**（存了档案就只看档案，
 * 否则建议档会和用户自建的同地址档案打架，命中谁全看顺序）。
 */
export function endpointPool(profiles, model) {
  const saved = normalizeEndpoints(profiles)
  return saved.length ? saved : normalizeEndpoints(suggestEndpoints(model))
}

/**
 * 是否该为新 provider 记录初始地址快照（纯函数，供测试）。
 *
 * **只在「还没有快照」或「换了 provider」时记**。
 * 绝不能写成「当前生效值 ≠ 快照就重记」——那样快照会跟着当前值一路跑，
 * 等价于没有快照（实测踩到过：切到直连上游后，下次读面板把快照也改成了上游地址，
 * 于是「恢复初始地址」指向的就是刚切过去的地址，永远回不到最初那个）。
 */
export function shouldCaptureBaseline(baseline, provider, installed) {
  if (!installed) return false
  const b = baseline || {}
  if (!String(b.baseURL || '')) return true
  return String(b.provider || '') !== provider
}

/** 无档案时给 UI 的现成档位（本机代理 / 直连上游 / 初始地址 / 清除覆盖），让功能开箱可用。 */
export function suggestEndpoints(model) {
  const m = model || {}
  const host = String(m.listenHost || '127.0.0.1').trim() || '127.0.0.1'
  const port = Number(m.listenPort) || 8788
  const out = []
  const base = String((m.baseline && m.baseline.baseURL) || '').trim().replace(/\/+$/, '')
  // 初始地址排在最前：这是自定义 provider 唯一可靠的「回得去」手段
  if (base) out.push({ id: 'sug-baseline', name: '恢复初始地址', baseURL: base, kind: 'baseline', note: '首次接入时记下的地址' })
  out.push({ id: 'sug-proxy', name: '本机代理（内置）', baseURL: `http://${host}:${port}/v1`, kind: 'proxy', note: '由本插件在宿主内起代理，补齐上游要求的会话头' })
  const up = String(m.upstream || '').trim().replace(/\/+$/, '')
  if (up) out.push({ id: 'sug-upstream', name: '直连上游', baseURL: up, kind: 'upstream', note: '不走代理；上游若要求自定义头会 400' })
  out.push({ id: 'sug-default', name: '清除 baseURL 覆盖', baseURL: '', kind: 'default', note: '仅对 dsh 内建 provider 有效；自定义 provider 会被判为缺 baseURL' })
  return out
}

/** 清除覆盖失败时的说明（纯函数，供测试）。宿主对自定义 provider 会以「needs a baseURL」拒绝，
 *  原样抛给用户是看不懂的，这里翻译成能照做的指引。 */
export function unsetFailureHint(provider) {
  return `无法清除 provider「${provider}」的 baseURL 覆盖：它的模型不在 dsh 内建目录里，baseURL 是必填项`
    + '（宿主原文：needs a baseURL; the installed catalog does not describe this route）。'
    + '请改选「恢复初始地址」「本机代理」或「直连上游」；'
    + '若确实想用 dsh 内建端点，应改用内建 provider（如 deepseek），而不是清空这个 provider 的地址。'
}

/**
 * 判断某个已生效的 baseURL 命中哪一档。
 * `installed === null` 表示 provider 没有 baseURL 覆盖 → 命中 kind=default 档
 * （约定：`default` 档取「第一个」default 类档案）。
 */
export function matchEndpoint(profiles, installed) {
  const list = normalizeEndpoints(profiles)
  const isDefault = installed === null || installed === ''
  if (isDefault) return list.find((p) => p.kind === 'default') || null
  const norm = String(installed).trim().replace(/\/+$/, '')
  return list.find((p) => p.kind !== 'default' && p.baseURL === norm) || null
}
//#endregion

/** 带超时的 fetch（探测用，失败即返回错误文本而不是抛）。 */
async function probeUrl(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { authorization: 'Bearer sk-local' },
      signal: controller.signal,
    })
    const body = await res.text()
    return { ok: res.ok, status: res.status, ms: Date.now() - started, body: body.slice(0, 400) }
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: err && err.message ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 内置代理的生命周期。
 *
 * 代理由插件在**宿主进程内**起一个 loopback 服务，不依赖任何外部程序 ——
 * 任何用户装上插件就能用，不必额外装或手动起别的东西。
 */
function createModelProxyController(logger) {
  let handle = null
  let lastError = ''
  let lastKey = ''

  const keyOf = (model) => JSON.stringify([
    String(model.mode || 'proxy'),
    model.builtin !== false,
    String(model.listenHost || '127.0.0.1'),
    Number(model.listenPort) || 8788,
    String(model.upstream || ''),
    model.sanitize !== false,
    String(model.userAgent || ''),
  ])

  async function stop() {
    if (!handle) return
    try { await handle.close() } catch { /* 关闭异常不影响后续重启 */ }
    handle = null
  }

  async function start(model) {
    await stop()
    lastError = ''
    lastKey = keyOf(model)
    if (String(model.mode || 'proxy') !== 'proxy' || model.builtin === false) {
      return { running: false, managed: false }
    }
    try {
      handle = await startModelProxy({
        host: String(model.listenHost || '127.0.0.1').trim() || '127.0.0.1',
        port: Number(model.listenPort) || 8788,
        upstreamBase: trimUrl(model.upstream || 'https://opencode.ai/zen/go'),
        userAgent: String(model.userAgent || 'saker-sec-config/1.0'),
        sanitize: model.sanitize !== false,
        log: (line) => logger?.info?.(`dsh-sec-config: ${line}`),
      })
      return { running: true, managed: true, port: handle.port }
    } catch (err) {
      const raw = err && err.message ? err.message : String(err)
      const port = Number(model.listenPort) || 8788
      lastError = /EADDRINUSE/.test(raw)
        ? `端口 ${port} 已被占用。若你已有别的代理在跑（例如自己起的脚本），保持即可 —— 面板会显示该端口在线；否则换个端口，或先停掉占用方。`
        : raw
      logger?.warn?.(`dsh-sec-config: 内置代理启动失败：${lastError}`)
      return { running: false, managed: true, error: lastError }
    }
  }

  /** 配置没变就空操作，变了才重启。 */
  async function sync(model) {
    if (keyOf(model) === lastKey) return { skipped: true }
    return start(model)
  }

  return {
    sync,
    start,
    stop,
    status: () => ({
      running: !!handle,
      port: handle ? handle.port : null,
      error: lastError,
      stats: handle ? handle.stats() : null,
    }),
  }
}

async function syncMcpServers(settings, services) {
  const wanted = new Map()
  const missingProxy = []
  const section = { services: services || {} }
  for (const [name, rawUrl] of [['burp', services && services.burpUrl], ['yakit', services && services.yakitUrl]]) {
    if (typeof rawUrl === 'string' && rawUrl.trim().length > 0) {
      const entry = buildServerEntry(name, rawUrl, section)
      if (entry) {
        wanted.set(name, entry)
        if (entry._missingProxy) missingProxy.push(name)
      }
    }
  }
  let current
  try {
    current = settings.get(MCP_STUDIO_NAMESPACE)
  } catch (err) {
    throw new Error(`mcp-studio namespace not registered yet: ${err && err.message ? err.message : String(err)}`)
  }
  const list = current && Array.isArray(current.servers) ? current.servers : []
  const consumed = new Set()
  const merged = []
  for (const srv of list) {
    if (!srv || typeof srv !== 'object') continue
    if (srv.name === 'burp' || srv.name === 'yakit') {
      consumed.add(srv.name)
      const entry = wanted.get(srv.name)
      if (entry) {
        // Preserve any operator-edited fields we don't manage (e.g. custom headers)
        const { _missingProxy: _drop, ...cleanEntry } = entry
        merged.push(cleanEntry)
      }
      // else: services cleared the URL → drop the managed server row
    } else {
      merged.push(srv)
    }
  }
  for (const [name, entry] of wanted) {
    if (!consumed.has(name)) {
      const { _missingProxy: _drop, ...cleanEntry } = entry
      merged.push(cleanEntry)
    }
  }
  merged.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  await settings.update(MCP_STUDIO_NAMESPACE, { servers: merged })
  return {
    synced: Array.from(wanted.keys()),
    missingProxy,
    servers: merged,
  }
}

/**
 * Schedule a sync that survives mcp-studio not-yet-registered at the first watch tick.
 *
 * mcp-studio owns the `mcp-studio` settings namespace and registers it inside its own
 * apply(). Activation order across plugins is not guaranteed, so at the first tick the
 * namespace may legitimately not exist yet and the settings call throws. The previous
 * version retried a fixed 8 times (fixed 800 ms) and then gave up for the rest of the
 * process lifetime — a boot-order race became a permanently unsynced MCP bridge, reported
 * by a single console.error. Wait for the namespace instead: exponential backoff up to a
 * ceiling, and **no attempt ceiling**. A failed attempt throws before any I/O, so waiting
 * indefinitely costs nothing. `timing` exists so tests do not have to wait for real delays.
 */
export function scheduleSync(settings, services, logger, timing = {}) {
  const pick = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback)
  const firstDelayMs = pick(timing.firstDelayMs, 400)
  const maxDelayMs = pick(timing.maxDelayMs, 30_000)
  const factor = Number.isFinite(timing.factor) && timing.factor > 1 ? timing.factor : 1.7
  const summarizeAt = pick(timing.summarizeAt, 8)
  let delay = firstDelayMs
  let failures = 0
  const attempt = async () => {
    try {
      const result = await syncMcpServers(settings, services)
      logger?.debug?.('dsh-sec-config: MCP bridge synced servers=%s missingProxy=%s', JSON.stringify((result && result.synced) || []), JSON.stringify((result && result.missingProxy) || []))
      return result
    } catch (err) {
      failures += 1
      const msg = err && err.message ? err.message : String(err)
      const next = Math.min(Math.round(delay * factor), maxDelayMs)
      if (failures === summarizeAt) {
        const every = maxDelayMs >= 1000 ? `${Math.round(maxDelayMs / 1000)}s` : `${maxDelayMs}ms`
        console.error('[dsh-sec-config] MCP bridge still waiting for the "%s" settings namespace after %d tries (%s); will keep retrying every %s until it appears', MCP_STUDIO_NAMESPACE, failures, msg, every)
      } else if (failures < summarizeAt) {
        logger?.debug?.('dsh-sec-config: MCP bridge sync retry %d in %dms: %s', failures, next, msg)
      }
      delay = next
      setTimeout(attempt, next)
    }
    return null
  }
  setTimeout(attempt, firstDelayMs)
}

/**
 * Render the runtime tool/MCP manifest as one dynamic prompt context.
 * Deterministic in (tools, services, dnslog, mounted mcp tool names) — identical
 * inputs must produce identical text, otherwise the runtime-context projection
 * re-snapshots on every turn.
 * The model never needs absolute paths (DSH_TOOL_<NAME> carries them into every
 * shell call); what it needs is *which* tools/services/MCP servers are live, so
 * a configured-but-empty tool is not silently assumed available.
 */
export function renderManifest(section, listMountedMcpTools) {
  const lines = []
  const entries = entriesOf(section)
  const hidden = new Set(Array.isArray(section && section.hiddenTools) ? section.hiddenTools : [])
  const byKey = new Map(TOOL_PRESETS.map((t) => [t.key, t]))
  const configured = []
  const seen = new Set()
  for (const e of entries) {
    if (!e || typeof e.path !== 'string' || !e.path) continue
    if (hidden.has(e.key)) continue
    const preset = byKey.get(e.key)
    const label = preset ? preset.label : (e.name || e.key)
    const display = preset ? label : `${label}(自定义)`
    if (seen.has(display)) continue
    seen.add(display)
    configured.push(display)
  }
  if (configured.length > 0) lines.push(`tools: ${configured.join(' ')}`)
  const services = section && section.services ? section.services : {}
  const serviceParts = []
  if (services.burpUrl) serviceParts.push(`burp=${services.burpUrl}`)
  if (services.yakitUrl) serviceParts.push(`yakit=${services.yakitUrl}`)
  if (serviceParts.length > 0) lines.push(`services: ${serviceParts.join(' ')}`)
  if (section && section.dnslog && section.dnslog.url) lines.push('dnslog: url 已配（token 不回显）')
  let mcpNames = []
  try {
    const view = listMountedMcpTools ? listMountedMcpTools() : []
    mcpNames = Array.isArray(view)
      ? view.map((t) => (t && typeof t.name === 'string' ? t.name : '')).filter((name) => name.startsWith('mcp__'))
      : []
  } catch { /* registry read failure contributes no mcp line */ }
  if (mcpNames.length > 0) {
    const perServer = new Map()
    for (const name of mcpNames) {
      const server = name.split('__')[1] ?? '?'
      perServer.set(server, (perServer.get(server) ?? 0) + 1)
    }
    const summary = [...perServer.entries()]
      .map(([server, count]) => `${server}(${count})`)
      .sort()
      .join(' ')
    lines.push(`mcp: ${summary}`)
  }
  if (lines.length === 0) return ''
  return escapePromptBraces(`<sec-config manifest>\n${lines.join('\n')}\n</sec-config manifest>`)
}

export function apply(ctx, config = {}) {
  let current = () => config
  let scope = null
  const base = { tools: {}, services: {}, dnslog: {}, apiKeys: {}, scanRoots: [], ...(config ?? {}) }

  try {
    scope = ctx.settings.register(NAMESPACE, Config, { base })
    current = () => scope.get()
  } catch (error) {
    ctx.logger?.warn?.('dsh-sec-config: settings provider unavailable, using patch baseline: %s', String(error))
  }

  ctx.inject(['connection', 'settings', 'shellEnv', 'systemPrompt'], (web) => {
    const { connection, settings, shellEnv } = web
    // 内置代理：随插件走，不依赖任何外部程序
    const modelProxy = createModelProxyController(ctx.logger)

    connection.register(ctx, CHANNEL, async (endpoint, payload) => {
      try {
        if (endpoint === 'tool-presets') {
          return ok({ presets: TOOL_PRESETS, categories: TOOL_CATEGORIES })
        }
        if (endpoint === 'settings/get') {
          return ok({
            status: 'ready',
            value: redact(current()),
            writable: settings.writable !== false,
            mode: 'host',
          })
        }
        if (endpoint === 'settings/mutate') {
          if (settings.writable === false) return failure('DSH settings are read-only')
          const raw = payload && typeof payload === 'object' ? payload : {}
          const rawOps = raw.ops
          if (!Array.isArray(rawOps) || rawOps.length === 0 || rawOps.length > 16) {
            return failure('ops must contain 1..16 settings edits')
          }
          const ops = rawOps
            .filter((op) => op && typeof op === 'object' && op.op === 'set' && Array.isArray(op.path) && op.path.length >= 1 && WRITABLE_FIELDS.has(String(op.path[0])))
            .map((op) => ({ op: 'set', path: op.path.map(String), value: normalizeOpValue(op.path, op.value) }))
          // Preserve existing secrets when the client echoes a mask back.
          const before = current()
          const merged = applyOps(before, ops)
          const revision = typeof raw.expectedRevision === 'number' ? raw.expectedRevision : undefined
          await settings.mutate(NAMESPACE, ops, revision)
          const after = current()
          // Mirror services into mcp-studio on the same write so the operator
          // sees the MCP card turn green in the 工作台 without a second save.
          scheduleSync(settings, (after && after.services) || {}, ctx.logger)
          return ok({ status: 'ready', value: redact(after), writable: true, mode: 'host' })
        }
        if (endpoint === 'mount-services') {
          const services = (current() && current().services) || {}
          try {
            const result = await syncMcpServers(settings, services)
            return ok(result)
          } catch (err) {
            return failure(err && err.message ? err.message : String(err))
          }
        }
        if (endpoint === 'model/state') {
          // 模型接入：当前配置 + 该写进去的 baseURL + llm-pi-ai 里实际生效的值 + 代理健康
          const model = (current() || {}).model || {}
          const provider = String(model.provider || 'custom')
          const target = modelBaseUrl(model)
          const installed = readProviderBaseUrl(settings, provider)
          const host = String(model.listenHost || '127.0.0.1').trim() || '127.0.0.1'
          const port = Number(model.listenPort) || 8788
          let proxy = null
          if (String(model.mode || 'proxy') === 'proxy') {
            proxy = await probeUrl(`http://${host}:${port}/__health`, 4000)
            if (proxy.ok) {
              try { proxy.health = JSON.parse(proxy.body) } catch { /* 非 JSON 就只看状态码 */ }
            }
          }
          return ok({
            mode: String(model.mode || 'proxy'),
            provider,
            targetBaseUrl: target,
            installedBaseUrl: installed,
            inSync: installed === target,
            namespaceReady: installed !== null,
            upstream: String(model.upstream || ''),
            listenHost: host,
            listenPort: port,
            builtin: model.builtin !== false,
            sanitize: model.sanitize !== false,
            customBaseUrl: String(model.customBaseUrl || ''),
            proxy,
            builtinProxy: modelProxy.status(),
          })
        }
        if (endpoint === 'model/proxy') {
          // 起/停内置代理。代理是补 x-opencode-session 头的那一环，dsh 自己做不到；
          // 代理由本插件在宿主进程内起，不依赖外部程序。
          const model = (current() || {}).model || {}
          const action = String((payload && payload.action) || 'start')
          const result = action === 'stop'
            ? (await modelProxy.stop(), { running: false })
            : await modelProxy.start(model)
          // 起停都要一点时间落地，等一拍再回报健康
          await new Promise((r) => setTimeout(r, action === 'stop' ? 600 : 900))
          const host = String(model.listenHost || '127.0.0.1').trim() || '127.0.0.1'
          const port = Number(model.listenPort) || 8788
          const health = await probeUrl(`http://${host}:${port}/__health`, 4000)
          if (health.ok) {
            try { health.health = JSON.parse(health.body) } catch { /* 非 JSON 只留状态码 */ }
          }
          return ok({ action, result, proxy: health, builtinProxy: modelProxy.status() })
        }
        if (endpoint === 'model/apply') {
          // 只改 providers.<id>.baseURL 一个字段 —— 用 path-ops，不重述也不误删
          // 同一命名空间下的其他 provider 与模型列表。
          if (settings.writable === false) return failure('DSH settings are read-only')
          const model = (current() || {}).model || {}
          const provider = String(model.provider || 'custom')
          if (!PROVIDER_ID_RE.test(provider)) return failure('provider 名不合法：' + provider)
          const target = modelBaseUrl(model)
          if (!target) return failure('目标地址为空，请先填写自定义地址')
          if (readProviderBaseUrl(settings, provider) === null) {
            return failure(`llm-pi-ai 里没有 provider「${provider}」—— 先在「设置 → 模型」建好它，这里只负责改它的地址`)
          }
          await settings.mutate(LLM_PI_AI_NAMESPACE, [
            { op: 'set', path: ['providers', provider, 'baseURL'], value: target },
          ])
          return ok({ applied: true, provider, baseURL: target, restartRequired: true })
        }
        if (endpoint === 'model/endpoints') {
          // 端点档案列表 + 当前生效值 + 命中的档位。档案为空时给三档现成建议，
          // 让用户「装上就能用」，不必先手工建档案。
          // 命中判定必须把**建议档**也算进池子：用户还没存档案时看到的就是建议档，
          // 若只拿已存档案去比，会出现「明明写着直连上游、却说不匹配任何档案」的自相矛盾。
          const model = (current() || {}).model || {}
          const provider = String(model.provider || 'custom')
          const installed = readProviderBaseUrl(settings, provider)
          const profiles = normalizeEndpoints(model.endpoints)
          // 初始地址快照：只在「还没有快照 / provider 变了 / 地址变了」时写一次，
          // 幂等且收敛（写完下一轮就读到，不再写）。自定义 provider 的 baseURL 必填，
          // 没有这个快照，「回得去」就无从谈起。
          const b0 = model.baseline || {}
          // 回给 UI 的必须是**写后**的值：用写前的 b0 回，界面会一直显示「尚未记录」，
          // 用户以为按钮没生效（实测踩到过）。写了就更新返回值。
          let effBaseline = {
            provider: String(b0.provider || ''),
            baseURL: String(b0.baseURL || ''),
            capturedAt: String(b0.capturedAt || ''),
          }
          if (shouldCaptureBaseline(b0, provider, installed)) {
            effBaseline = { provider, baseURL: installed, capturedAt: new Date().toISOString() }
            try {
              await settings.mutate(NAMESPACE, [{ op: 'set', path: ['model', 'baseline'], value: effBaseline }])
            } catch { /* 快照失败不影响读取（effBaseline 仍回报，便于界面提示）*/ }
          }
          const pool = endpointPool(model.endpoints, model)
          const match = matchEndpoint(pool, installed)
          return ok({
            provider,
            namespaceReady: installed !== null,
            installedBaseUrl: installed,
            isDefault: installed === null || installed === '',
            profiles,
            suggestions: profiles.length ? [] : pool,
            activeProfileId: match ? match.id : null,
            activeProfileName: match ? match.name : '',
            baseline: effBaseline,
          })
        }
        if (endpoint === 'model/endpoint-baseline') {
          // 手动把当前生效地址记为初始地址（例如换过供应商后想重定基准）。
          const model = (current() || {}).model || {}
          const provider = String(model.provider || 'custom')
          const installed = readProviderBaseUrl(settings, provider)
          if (!installed) return failure('当前 provider 没有生效的 baseURL，无从记录')
          const value = { provider, baseURL: installed, capturedAt: new Date().toISOString() }
          await settings.mutate(NAMESPACE, [{ op: 'set', path: ['model', 'baseline'], value }])
          return ok({ baseline: value })
        }
        if (endpoint === 'model/endpoint-save') {
          // 档案增改（有 id 且已存在=更新，否则新增）。只动自己的命名空间。
          const model = (current() || {}).model || {}
          const list = normalizeEndpoints(model.endpoints)
          const raw = (payload || {}).profile || payload || {}
          const name = String(raw.name || '').trim()
          if (!name) return failure('档案名必填')
          const kind = ENDPOINT_KINDS.includes(String(raw.kind)) ? String(raw.kind) : 'custom'
          const baseURL = String(raw.baseURL || '').trim().replace(/\/+$/, '')
          if (kind !== 'default' && !/^https?:\/\/[^\s]+$/i.test(baseURL)) {
            return failure('端点地址必须是 http(s):// 开头的 URL')
          }
          const note = String(raw.note || '').trim()
          const id = String(raw.id || '').trim()
          const idx = id ? list.findIndex((p) => p.id === id) : -1
          let saved
          if (idx >= 0) {
            list[idx] = Object.assign({}, list[idx], { name, baseURL, kind, note })
            saved = list[idx]
          } else {
            const nid = id || `ep${Date.now().toString(36)}`
            saved = { id: nid, name, baseURL, kind, note }
            list.push(saved)
          }
          await settings.mutate(NAMESPACE, [{ op: 'set', path: ['model', 'endpoints'], value: list }])
          return ok({ saved, profiles: list })
        }
        if (endpoint === 'model/endpoint-delete') {
          const model = (current() || {}).model || {}
          const id = String((payload || {}).id || '').trim()
          if (!id) return failure('缺少 id')
          const list = normalizeEndpoints(model.endpoints).filter((p) => p.id !== id)
          await settings.mutate(NAMESPACE, [{ op: 'set', path: ['model', 'endpoints'], value: list }])
          return ok({ profiles: list })
        }
        if (endpoint === 'model/endpoint-use') {
          // 真正的一键切换：把该档地址写进 llm-pi-ai 的 providers.<id>.baseURL。
          // kind=default 走 unset（清除覆盖回 dsh 内建默认），绝不写空串。
          if (settings.writable === false) return failure('DSH settings are read-only')
          const model = (current() || {}).model || {}
          const provider = String(model.provider || 'custom')
          if (!PROVIDER_ID_RE.test(provider)) return failure('provider 名不合法：' + provider)
          if (readProviderBaseUrl(settings, provider) === null) {
            return failure(`llm-pi-ai 里没有 provider「${provider}」—— 先在「设置 → 模型」建好它，这里只负责改它的地址`)
          }
          const p = payload || {}
          const id = String(p.id || '').trim()
          // 池子与列表一致（档案非空时只看档案，否则看建议档）——避免同地址两条记录
          // 命中谁全看顺序。UI 上出现过的 id 一定在这里能找到。
          const all = endpointPool(model.endpoints, model)
          const profile = id
            ? all.find((x) => x.id === id)
            : { kind: p.kind, baseURL: p.baseURL, name: p.name }
          if (!profile) return failure('端点不存在：' + id)
          let plan
          try { plan = planEndpointUse(profile) } catch (err) { return failure(err && err.message ? err.message : String(err)) }
          const ops = plan.op === 'unset'
            ? [{ op: 'unset', path: ['providers', provider, 'baseURL'] }]
            : [{ op: 'set', path: ['providers', provider, 'baseURL'], value: plan.baseURL }]
          try {
            await settings.mutate(LLM_PI_AI_NAMESPACE, ops)
          } catch (err) {
            // 自定义 provider（模型不在 dsh 内建目录里）清掉 baseURL 会被判为非法配置。
            // 把宿主的原文翻译成能照做的指引，别让用户对着 "needs a baseURL" 发愣。
            if (plan.op === 'unset') return failure(unsetFailureHint(provider))
            return failure((err && err.message) ? err.message : String(err))
          }
          const nowInstalled = readProviderBaseUrl(settings, provider)
          return ok({
            used: profile.name || profile.baseURL || 'dsh 默认',
            op: plan.op,
            provider,
            baseURL: plan.baseURL,
            installedBaseUrl: nowInstalled,
            isDefault: nowInstalled === null || nowInstalled === '',
            restartRequired: true,
          })
        }
        if (endpoint === 'model/probe') {
          // 真发一个请求看通不通：GET <baseURL>/models，不消耗 token
          const model = (current() || {}).model || {}
          const target = modelBaseUrl(model)
          if (!target) return failure('目标地址为空')
          const result = await probeUrl(target + '/models', 8000)
          return ok(Object.assign({ url: target + '/models' }, result))
        }
        if (endpoint === 'scan-candidates') {
          // 工具自动探测：静默扫描候选根（scanRoots + 已配工具父目录两级），
          // 按预设工具名匹配返回候选绝对路径。无弹窗、毫秒级、可 headless 验证。
          try {
            const { roots, candidates } = findToolCandidates(current())
            return ok({ roots: roots.slice(0, 12), candidates })
          } catch (err) {
            return failure(err && err.message ? err.message : String(err))
          }
        }
        if (endpoint === 'catalog/scan') {
          // 工具库 v2：对给定「工具根目录」做**工具级**枚举（每个工具一项，而非
          // 每个文件一项）：exe/jar 直接成工具，脚本需与所在目录名匹配，同目录
          // 变体合并（accesschk/64/64a），preset 去重；分类沿用用户编号分类目录。
          try {
            const raw = (payload && Array.isArray(payload.roots) ? payload.roots : []).filter((r) => typeof r === 'string' && r)
            if (raw.length === 0) return ok({ roots: [], files: [] })
            const MAX = 1500
            const files = []
            const seenPath = new Set()
            for (const root of raw) {
              if (!existsSync(root)) continue
              for (const item of collectToolEntries(root, MAX)) {
                if (seenPath.has(item.path)) continue
                seenPath.add(item.path)
                files.push({
                  name: item.name,
                  path: item.path,
                  category: item.category,
                  presetKey: item.presetKey,
                  tool: item.stem,
                })
                if (files.length >= MAX) break
              }
              if (files.length >= MAX) break
            }
            files.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : a.path < b.path ? -1 : 1))
            return ok({ roots: raw, files: files.slice(0, MAX) })
          } catch (err) {
            return failure(err && err.message ? err.message : String(err))
          }
        }
        if (endpoint === 'services/probe') {
          // Cheap reachability probe for the UI badge — connects (no full MCP handshake)
          // and reports whether the endpoint accepts traffic. Does not require
          // mcp-studio to be registered.
          const services = (current() && current().services) || {}
          const targets = []
          if (services.burpUrl) targets.push({ name: 'burp', url: services.burpUrl })
          if (services.yakitUrl) targets.push({ name: 'yakit', url: ensureSuffix(services.yakitUrl, '/mcp') })
          const results = await Promise.all(targets.map(async (t) => {
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 4000)
            try {
              const res = await fetch(t.url, { method: 'GET', signal: ctrl.signal })
              return { name: t.name, url: t.url, reachable: true, status: res.status }
            } catch (err) {
              return { name: t.name, url: t.url, reachable: false, error: err && err.message ? err.message : String(err) }
            } finally {
              clearTimeout(timer)
            }
          }))
          return ok({ probes: results })
        }
        return failure('unknown endpoint: ' + endpoint)
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
    }, { authority: 'loopback' })

    const variables = {}
    for (const key of TOOL_KEYS) {
      variables['DSH_TOOL_' + key.toUpperCase()] = { description: 'Configured path to the ' + key + ' security tool (empty when unset).' }
    }
    shellEnv.register({
      name: 'sec-config-tools',
      variables,
      resolve: () => {
        const section = current()
        const out = {}
        const tools = toolsOf(section)
        const hidden = new Set(Array.isArray(section && section.hiddenTools) ? section.hiddenTools : [])
        for (const key of TOOL_KEYS) {
          out['DSH_TOOL_' + key.toUpperCase()] = hidden.has(key) ? '' : (typeof tools[key] === 'string' ? tools[key] : '')
        }
        return out
      },
    })

    // Dynamic prompt context: re-rendered at every prompt assembly from the
    // LIVE settings scope (UI saves and external settings.yaml edits both flow
    // through the hot-reloading settings provider), so config changes reach the
    // model's next context snapshot without a restart. Same mechanism the
    // governance envelope uses; deterministic text means zero cost when nothing
    // changed. Mounted MCP tools are introspected from the live tool registry.
    try {
      ctx.systemPrompt.context({
        name: 'sec-config-manifest',
        order: 550,
        text: () => renderManifest(current(), () => ctx.get('tools')?.view(void 0)),
      })
    } catch (error) {
      ctx.logger?.warn?.('dsh-sec-config: systemPrompt unavailable, runtime manifest disabled: %s', String(error))
    }

    // Initial mount pass + ongoing reconciliation. scope.watch delivers every
    // commit, so UI saves and direct yaml edits both flow into
    // mcp-studio.servers without a second round-trip.
    try {
      if (scope && typeof scope.watch === 'function') {
        scope.watch((next) => {
          const services = (next && next.services) || {}
          scheduleSync(settings, services, ctx.logger)
          // 代理参数变了就重启内置代理；参数没变时 sync 是空操作
          void modelProxy.sync((next && next.model) || {})
        })
        scheduleSync(settings, (current() && current().services) || {}, ctx.logger)
        void modelProxy.sync((current() && current().model) || {})
      } else {
        console.error('[dsh-sec-config] NO settings scope — MCP bridge disabled (scope=%s)', scope === null ? 'null' : typeof scope)
      }
    } catch (error) {
      console.error('[dsh-sec-config] bridge setup error:', error && error.message ? error.message : String(error))
    }
  })
}
