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
const WRITABLE_FIELDS = new Set(['tools', 'services', 'dnslog', 'apiKeys', 'scanRoots', 'hiddenTools', 'roots', 'categories', 'entries'])

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
   * 不进 shell 环境；路径配置值保留，随时可恢复（移除 ≠ 删除配置）。 */
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
 * 规范化写入的路径类字段，避免 `E:/工作/Web Security\Tools` 这类混用分隔符
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
    // 排序：短路径优先（更接近工具根）；同长度按字母序稳定
    hits.sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
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
      // CJK characters ("E:\工作\..." → "E:工作...").
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

/** Schedule a sync that survives mcp-studio not-yet-registered at first watch tick. */
function scheduleSync(settings, services, logger) {
  let attempts = 0
  const attempt = async () => {
    try {
      const result = await syncMcpServers(settings, services)
      logger?.debug?.('dsh-sec-config: MCP bridge synced servers=%s missingProxy=%s', JSON.stringify((result && result.synced) || []), JSON.stringify((result && result.missingProxy) || []))
      return result
    } catch (err) {
      attempts += 1
      const msg = err && err.message ? err.message : String(err)
      if (attempts >= 8) console.error('[dsh-sec-config] MCP bridge sync failed after 8 attempts: %s', msg)
      else setTimeout(attempt, 800)
    }
    return null
  }
  setTimeout(attempt, 400)
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
        })
        scheduleSync(settings, (current() && current().services) || {}, ctx.logger)
      } else {
        console.error('[dsh-sec-config] NO settings scope — MCP bridge disabled (scope=%s)', scope === null ? 'null' : typeof scope)
      }
    } catch (error) {
      console.error('[dsh-sec-config] bridge setup error:', error && error.message ? error.message : String(error))
    }
  })
}
