// dsh-knowledge-hub — host.
//
// Two-layer knowledge refs for the pentest / code-audit / ctf-solver presets:
//   bundle  <profile>/node_modules/dsh-saker/preset/<mode>/refs      read-only, ships with the root package
//   user    DSH_HOME/refs/<mode>/<topic>/…                          writable, mirrors bundle topics
//   import  DSH_HOME/refs/imports/<source-name>/…                    writable, external full assets (PATT etc.)
//
// Read-side layering (user-first): same relative path in the user layer shadows
// the bundle copy; imports sit in their own area and are searchable from both
// modes. The hub never writes into the bundle.
//
// Serves a loopback RPC for the "知识库" settings tab, three model tools
// (knowledge_search / knowledge_read / knowledge_list), and a small
// systemPrompt.context manifest so the model knows the extension layer exists.

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { KnowledgeIndex, TEXT_EXTS } from './index-engine.js'
import { getSyncMode, loadCatalog, packRoots, packsStatus, setSyncMode, syncPacks } from './packs.js'
import { indexBuildStatus, indexDbPath, startBackgroundIndexBuild } from './index-build.js'

export const name = 'dsh-knowledge-hub'
export const inject = ['connection', 'tools', 'systemPrompt', 'webServer']

const CHANNEL = '/dsh-knowledge-hub'
const MODE_IDS = ['pentest', 'code-audit', 'ctf-solver']
const MODE_LABELS = { pentest: '渗透测试', 'code-audit': '代码审计', 'ctf-solver': 'CTF 解题' }
const SEARCH_SOURCES = new Set(['bundle', 'patt', 'user', 'import'])
const MAX_READ_BYTES = 1024 * 1024 // 1 MiB single-file read cap
const MAX_SEARCH_FILES = 500 // per search call
const SMALL_FILE_LIMIT = 200 * 1024 // ≤200 KiB scanned fully; larger scans head + filename only
const HEAD_LINES = 1000 // lines scanned from large files

// Exploit-DB：约定目录 imports/exploitdb（官方仓库或元数据快照）。识别标志=两个 CSV。
// 检索=字段化索引（EDB-ID/平台/描述），不做整库 embedding；PoC 原文按需读。
const EDB_DIRNAME = 'exploitdb'

/** 中文问句 → 英文/缩写同义词展开（轻量召回增强，不做语义检索）。 */
const ALIASES = {
  越权: ['access-control', 'access control', 'idor', 'authorization', 'privilege', '越权', '未授权'],
  注入: ['injection', 'sqli', 'sql injection', '注入'],
  'sql注入': ['sqli', 'sql-injection', 'sql injection', '注入'],
  xss: ['xss', 'cross-site', 'cross site', 'reflected', 'stored'],
  csrf: ['csrf', 'xsrf', 'cross-site request', 'cross site request'],
  ssrf: ['ssrf', 'server-side request', 'server side request', 'fetch'],
  rce: ['rce', 'remote code execution', '命令执行', '代码执行'],
  命令执行: ['rce', 'command execution', 'command injection', '命令执行', '代码执行'],
  反序列化: ['deserialization', 'unserialize', '反序列化'],
  文件包含: ['file inclusion', 'lfi', 'rfi', 'path traversal', '文件包含', '目录穿越'],
  上传: ['upload', 'unrestricted file upload', '上传'],
  弱口令: ['weak password', 'weak credential', '弱口令', '默认口令', 'default credential'],
  爆破: ['brute', 'brute-force', 'bruteforce', '爆破'],
  提权: ['privilege escalation', 'privesc', '提权'],
  横向: ['lateral', '横向', 'movement'],
  内网: ['intranet', 'internal network', '内网', 'network'],
  webshell: ['webshell', 'shell', '一句话', '马', 'backdoor'],
  免杀: ['evasion', 'bypass av', '免杀', 'obfuscation'],
  内存马: ['memory shell', 'memoryshell', 'filter inject', '内存马'],
  钓鱼: ['phishing', '钓鱼'],
  侦察: ['recon', 'reconnaissance', 'discovery', '侦察', '信息收集'],
  目录: ['directory', 'dir', 'path', '目录'],
  子域: ['subdomain', '子域名', '子域'],
  'incident response': ['incident response', '应急响应', 'dfir', 'forensics', 'ransomware', 'containment', 'eradication'],
  应急响应: ['incident response', '应急响应', 'dfir', 'forensics', 'ransomware', 'containment'],
  ransomware: ['ransomware', '勒索', '应急响应', 'incident response'],
  dfir: ['dfir', 'forensics', 'incident response', '应急响应', 'memory forensics', 'disk forensics'],
  'active directory': ['active directory', 'ad', 'kerberos', 'ntlm', 'bloodhound', '域渗透'],
  云安全: ['cloud security', 'aws', 'azure', 'gcp', 'kubernetes', 'cloud native'],
  'cloud security': ['cloud security', 'aws', 'azure', 'gcp', 'kubernetes', '云安全'],
  mobile: ['mobile', 'android', 'ios', 'frida', 'mastg', '移动安全'],
  // 2026-09-18 补：混合语种查询里最常出现、但旧表没有的检测/取证类术语。
  // 加这些的依据是真机评测：中文查询「Sigma 检测规则 powershell 编码命令」在补表前
  // 只命中一篇无关中文文档，而同一语义的英文查询能命中 3 条 sigma 规则。
  检测规则: ['detection rule', 'detection', 'sigma', 'rule', 'yara'],
  编码命令: ['encoded command', 'encodedcommand', 'base64', 'obfuscation', 'command line'],
  计划任务: ['scheduled task', 'schtasks', 'cron', 'task scheduler'],
  持久化: ['persistence', 'persist', 'autorun', 'registry run'],
  内存取证: ['memory forensics', 'volatility', 'memory dump', 'memory analysis'],
  进程注入: ['process injection', 'inject', 'process hollowing'],
  磁盘取证: ['disk forensics', 'filesystem timeline', 'autopsy'],
  时间线: ['timeline', 'timelining', 'event log'],
  日志分析: ['log analysis', 'event log', 'audit log'],
  供应链: ['supply chain', 'dependency', 'npm', 'malicious package'],
  证书模板: ['certificate template', 'ad cs', 'esc1', 'esc8'],
  凭据: ['credential', 'lsass', 'secretsdump', 'credential dumping'],
  权限维持: ['persistence', 'backdoor', 'maintain access'],
  横向移动: ['lateral movement', 'psexec', 'wmi', 'smb'],
  容器逃逸: ['container escape', 'docker escape', 'privileged container', 'cgroup'],
  越权访问: ['broken access control', 'idor', 'authorization', 'bola'],
}
function expandTerms(query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  const out = [q]
  for (const [cn, terms] of Object.entries(ALIASES)) {
    if (q.includes(cn)) {
      for (const t of terms) if (!out.includes(t)) out.push(t)
    }
  }
  // CVE / EDB-数字 归一化：CVE 再按数字段匹配；EDB-n 抽出数字精确找 id
  let cve
  if ((cve = q.match(/cve[-_ ]?(\d{4}[-_ ]?\d+)/i))) out.push('cve-' + cve[1].toLowerCase().replace(/[_\s]/g, '-'))
  let edbId
  if ((edbId = q.match(/edb[-_ ]?(\d+)/i))) out.push(edbId[1])
  return out.slice(0, 6)
}

/**
 * 混合语种查询的**术语替换**：把已知的中文安全术语替换成对应的英文说法，
 * 让「Sigma 检测规则 powershell 编码命令」这类查询在英文语料（sigma 规则、hacktricks 等）
 * 上也有命中的可能。只在术语表命中时生效，原查询照常参与检索，两者结果合并（替换结果 -1.5）。
 * 不做机器翻译、不调模型——表里的每一条都是人工维护的固定对应。
 */
export function translateQuery(query) {
  let out = String(query || '')
  if (!out.trim()) return ''
  for (const [cn, terms] of Object.entries(ALIASES)) {
    if (!out.includes(cn)) continue
    const replacement = terms.find((term) => /^[\x00-\x7f]/.test(term))
    if (replacement) out = out.split(cn).join(` ${replacement} `)
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Lexical coverage terms used only as a confidence signal, never as a hard filter. */
function coverageTerms(query) {
  const out = []
  for (const word of String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}|[\u4e00-\u9fff]{2,}/g) || []) {
    if (/^[a-z0-9]/.test(word)) out.push(word)
    else if (word.length <= 2) out.push(word)
    else for (let i = 0; i < word.length - 1; i += 1) out.push(word.slice(i, i + 2))
  }
  return [...new Set(out)].slice(0, 32)
}

/**
 * 查询概念（用于**覆盖度 rerank**）：拉丁实词 + 已知中文术语翻译后的英文词。
 *
 * 为什么需要：BM25 会把"路径/标题里出现 rule、sigma 这种元数据词"的文档顶到前面。
 * 实测「Sigma 检测规则 powershell 编码命令」top-1 是 `net_connection_win_domain_ngrok.yml`
 * （只匹配 rule），而真正对症的 `...powershell_base64_encoded_*.yml`（匹配
 * powershell/encoded/base64/rule 四个概念）排在第 9。加覆盖度加成能把"命中概念多"的
 * 文档提上来——这是确定性的重排，不引入向量库或外部模型。
 */
export function queryConcepts(query) {
  const raw = String(query || '').toLowerCase()
  const out = []
  for (const token of raw.match(/[a-z0-9][a-z0-9_.:+-]{2,}/g) || []) out.push(token.replace(/[.:]+$/, ''))
  for (const [cn, terms] of Object.entries(ALIASES)) {
    if (!raw.includes(cn)) continue
    const english = terms.find((term) => /^[\x00-\x7f]/.test(term)) || ''
    for (const word of english.toLowerCase().split(/[^a-z0-9]+/)) if (word.length >= 4) out.push(word)
  }
  return [...new Set(out.filter(Boolean))].slice(0, 10)
}

/** 覆盖度加成：命中概念数 ×3，封顶 +12（够把对症文档提上来，又压不过精确 ID 命中）。 */
export function coverageBonusOf(hit, concepts) {
  if (!concepts.length) return 0
  const hay = `${hit.path || ''}\n${hit.title || ''}\n${hit.heading || ''}\n${hit.preview || ''}`.toLowerCase()
  const matched = concepts.filter((term) => hay.includes(term)).length
  return Math.min(12, matched * 3)
}

function annotateCoverage(hits, query) {
  const terms = coverageTerms(query)
  if (terms.length === 0) return hits
  return hits.map((hit) => {
    const hay = `${hit.path || ''}\n${hit.title || ''}\n${hit.heading || ''}\n${hit.preview || ''}`.toLowerCase()
    const matched = terms.filter((term) => hay.includes(term)).length
    const termCoverage = matched / terms.length
    const exactEdb = Number(hit.score || 0) >= 1000 && hit.edb
    return {
      ...hit,
      termCoverage: Number(termCoverage.toFixed(3)),
      lowConfidence: !exactEdb && terms.length >= 2 && termCoverage < 0.4,
    }
  })
}

// ── path resolution ─────────────────────────────────────────────────────────

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
function userRefsRoot() {
  return path.join(dshHome(), 'refs')
}
function userModeDir(mode) {
  return path.join(userRefsRoot(), mode)
}
function importsRoot() {
  return path.join(userRefsRoot(), 'imports')
}

/** Bundle refs, resolved once. Empty when dsh-saker is not installed (degrade: user layer only). */
let bundleRefs = null
function sakerRoot() {
  if (process.env.SAKER_DISABLE_BUNDLE === '1') return ''
  const candidates = []
  if (process.env.SAKER_ROOT) candidates.push(process.env.SAKER_ROOT)
  try {
    const req = createRequire(import.meta.url)
    candidates.push(path.dirname(req.resolve('dsh-saker/package.json')))
  } catch {
    // Source checkout outside an installed profile: fall back below.
  }
  // lib/index.js -> plugin -> plugins -> repository root
  candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
    } catch {
      // try the next candidate
    }
  }
  return ''
}
function bundleRefsRoots() {
  if (bundleRefs !== null) return bundleRefs
  bundleRefs = []
  try {
    const pkgRoot = sakerRoot()
    if (!pkgRoot) return bundleRefs
    for (const mode of MODE_IDS) {
      const dir = path.join(pkgRoot, 'preset', mode, 'refs')
      if (fs.existsSync(dir)) bundleRefs.push({ mode, root: fs.realpathSync(dir) })
    }
  } catch {
    /* root package not installed — user layer only */
  }
  return bundleRefs
}

/** PATT snapshot shipped in the root package (read-only, mode-agnostic). */
const PATT_SNAPSHOT = '3ac2790'
let pattRef = null
function pattRoot() {
  if (pattRef !== null) return pattRef
  pattRef = ''
  try {
    const pkgRoot = sakerRoot()
    if (!pkgRoot) return pattRef
    const dir = path.join(pkgRoot, 'preset', 'shared', 'refs', 'PayloadsAllTheThings')
    if (fs.existsSync(dir)) pattRef = fs.realpathSync(dir)
  } catch {
    /* root package not installed */
  }
  return pattRef
}

let knowledgeIndex = null
let autoSyncPromise = null
let lastSyncSummary = null

function indexRoots() {
  const roots = []
  for (const source of bundleRefsRoots()) {
    roots.push({
      id: `bundle-${source.mode}`,
      kind: 'bundle',
      mode: source.mode,
      root: source.root,
      priority: 8,
    })
  }
  if (pattRoot()) {
    roots.push({
      id: 'patt',
      kind: 'patt',
      mode: '',
      root: pattRoot(),
      priority: 5,
    })
  }
  for (const mode of MODE_IDS) {
    roots.push({
      id: `user-${mode}`,
      kind: 'user',
      mode,
      root: userModeDir(mode),
      priority: 9,
    })
  }
  roots.push(...packRoots(importsRoot(), loadCatalog()))
  return roots
}

function getKnowledgeIndex() {
  if (knowledgeIndex) return knowledgeIndex
  knowledgeIndex = new KnowledgeIndex({
    dbPath: indexDbPath(),
    roots: indexRoots(),
    logger: console,
  })
  return knowledgeIndex
}

function ensureKnowledgeIndex(force = false) {
  const index = getKnowledgeIndex()
  index.roots = indexRoots()
  const build = indexBuildStatus()
  if (force) {
    if (build.status === 'running') return null
    return index.countFiles() <= 2500 ? index.rebuild({ force: true }) && index : (startBackgroundIndexBuild(), null)
  }
  if (!fs.existsSync(indexDbPath())) {
    if (build.status === 'running') return null
    if (index.countFiles() > 2500) {
      startBackgroundIndexBuild()
      return null
    }
    index.rebuild({ force: true })
    return index
  }
  if (build.status === 'running') return index
  const status = index.status()
  if (
    status.dirty
    && build.status === 'ok'
    && build.finishedAt
    && Date.parse(build.finishedAt) >= Number(status.dirtyAt || 0)
    && status.version === 2
  ) {
    index.markClean()
    return index
  }
  if (status.dirty || !status.indexedAt || status.version !== 2) {
    // A dirty index can mean thousands of files changed while the host was
    // offline. Do not stall the first search on a full rebuild; serve the
    // current index and let the detached builder publish the next generation.
    if (status.dirty && index.countFiles() > 2500 && build.status !== 'running') {
      startBackgroundIndexBuild({ force: false })
      return index
    }
    index.rebuild({ force: false })
  }
  return index
}

// 提示词清单缓存：这条 manifest **每个回合都会被装配一次**，而 stats() 要把整个知识目录
// 遍历一遍（9.5k 文件，实测 ~33ms/次），topImportNames() 还会再扫一次 imports。
// 内容只在导入/同步/重建时才变 → 缓存 5 分钟，并在那些动作里显式失效（invalidateKnowledgeIndex）。
const MANIFEST_TTL_MS = 5 * 60 * 1000
const manifestCache = { text: '', at: 0 }

function buildManifestText() {
  const s = stats()
  const parts = []
  if (s.patt > 0) parts.push(`随包 PayloadsAllTheThings payload 库 ${s.patt} 篇（commit ${PATT_SNAPSHOT}，MIT，离线）`)
  if (s.user > 0) parts.push(`个人/团队知识 ${s.user} 篇`)
  const edbRows = loadEdbIndex().length
  if (edbRows > 0) parts.push(`Exploit-DB 元数据索引 ${edbRows} 条（离线；命中形如 [EDB-12345]，PoC 原文按需读 exploitdb/<path>）`)
  if (s.imports > 0) {
    const names = topImportNames()
    parts.push(
      `导入知识源 ${s.imports} 篇` +
        (names.length ? `（来源：${names.slice(0, 8).join('、')}${names.length > 8 ? ' 等' : ''}）` : ''),
    )
  }
  const packState = packsStatus()
  if (packState.total > 0) parts.push(`推荐知识包 ${packState.installed}/${packState.total} 已同步`)
  const indexState = knowledgeIndexStatus()
  if (indexState.docs > 0) parts.push(`混合检索索引 ${indexState.docs} 文档 / ${indexState.chunks} chunks`)
  if (parts.length === 0) return ''
  return `<dsh-knowledge-hub>知识库：${parts.join('，')}。按需用 knowledge_search → knowledge_read；不要整库读取。</dsh-knowledge-hub>`
}

/**
 * 知识库提示词清单（带缓存）。
 * 为什么要缓存：它在**每个回合的装配路径**上，而内容（知识源篇数、索引规模）只在
 * 导入/同步/重建时变——旧实现每回合都全量遍历知识目录，实测 ~33ms/回合的纯浪费。
 */
export function knowledgeManifest(now = Date.now()) {
  // 用 at>0 当"已算过"的判据（不能用 text!==''：知识库为空时清单本来就是空串，
  // 那样会退化成每次重算，缓存等于没做）。
  if (manifestCache.at > 0 && now - manifestCache.at < MANIFEST_TTL_MS) return manifestCache.text
  manifestCache.text = buildManifestText()
  manifestCache.at = now
  return manifestCache.text
}

function invalidateKnowledgeIndex() {
  manifestCache.text = ''
  manifestCache.at = 0
  if (knowledgeIndex) knowledgeIndex.invalidate()
}

function closeKnowledgeIndex() {
  if (!knowledgeIndex) return
  knowledgeIndex.close()
  knowledgeIndex = null
}

function knowledgeIndexStatus() {
  const build = indexBuildStatus()
  if (!fs.existsSync(indexDbPath())) {
    return { ready: false, version: 2, docs: 0, chunks: 0, build }
  }
  const status = getKnowledgeIndex().status()
  return { ...status, ready: true, build }
}

function autoSyncKnowledgePacks(force = false) {
  if (process.env.DSH_KNOWLEDGE_AUTOSYNC === '0') {
    return Promise.resolve({ skipped: true, reason: 'DSH_KNOWLEDGE_AUTOSYNC=0' })
  }
  const mode = getSyncMode()
  if (mode !== 'auto') {
    return Promise.resolve({ skipped: true, reason: `知识同步模式：${mode}` })
  }
  if (autoSyncPromise) return autoSyncPromise
  autoSyncPromise = (async () => {
    try {
      const summary = await syncPacks({ force, concurrency: 3 })
      lastSyncSummary = summary
      if (summary.ok > 0) {
        invalidateKnowledgeIndex()
        const build = indexBuildStatus()
        if (build.status !== 'running') startBackgroundIndexBuild({ force: !fs.existsSync(indexDbPath()) })
      }
      return summary
    } catch (error) {
      const summary = {
        requested: 0,
        ok: 0,
        failed: 1,
        error: error instanceof Error ? error.message : String(error),
      }
      lastSyncSummary = summary
      console.error('[dsh-knowledge-hub] auto sync failed: %s', summary.error)
      return summary
    } finally {
      autoSyncPromise = null
    }
  })()
  return autoSyncPromise
}

/**
 * Resolve `rel` under `base` and refuse any escape. Returns null when the path
 * leaves the base. Existence is NOT checked here — callers stat as needed.
 * `rel` uses forward slashes on the wire.
 */
function safeResolve(base, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null
  const target = path.resolve(base, ...rel.split('/').filter((s) => s !== '' && s !== '.'))
  if (target !== base && !target.startsWith(base + path.sep)) return null
  return target
}

/** 覆盖写用户文件前保留的份数上限。 */
const BACKUP_KEEP = 5

/**
 * 覆盖写之前先留一份旧内容，返回备份路径（文件原本不存在时返回空串）。
 *
 * 为什么：`write` 直接 `writeFileSync` 到用户层/导入层 —— 用户改自己写的知识条目
 * 时，保存一下就永久覆盖上一版，没有任何回退手段。
 * （同一类问题 2026-09-19 已在 webshell-mgr 上真实踩过一次数据丢失。）
 * 备份放同层 `.backups/`：点开头，listEntries / packRoots 都会跳过，
 * 不会出现在目录树或检索里；每个文件最多留 BACKUP_KEEP 份。
 */
function backupExistingFile(base, target) {
  if (!fs.existsSync(target)) return ''
  const backupDir = path.join(base, '.backups')
  try {
    fs.mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17) + '-' + Math.random().toString(36).slice(2, 8)
    const dest = path.join(backupDir, `${path.basename(target)}.${stamp}.bak`)
    fs.copyFileSync(target, dest)
    const mine = fs.readdirSync(backupDir).filter((f) => f.startsWith(path.basename(target) + '.')).sort()
    for (const old of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP))) {
      try { fs.rmSync(path.join(backupDir, old), { recursive: true, force: true }) } catch { /* 清理旧备份失败不影响本次写入 */ }
    }
    return dest
  } catch {
    return '' // 备份失败不阻断写入；调用方据返回值如实告知"没有备份"
  }
}

/** Base directory of a writable layer for a payload. Returns null for bundle or bad input. */
function writeBaseOf(source, mode) {
  if (source === 'user') {
    if (!MODE_IDS.includes(mode)) return null
    return userModeDir(mode)
  }
  if (source === 'import') return importsRoot()
  return null
}

/** Real directory root of a layer (read side). */
function readRootOf(source, mode) {
  if (source === 'bundle') {
    const hit = bundleRefsRoots().find((b) => b.mode === mode)
    return hit ? hit.root : null
  }
  if (source === 'patt') return pattRoot()
  return writeBaseOf(source, mode)
}

function isTextFile(file) {
  const rel = String(file).replace(/\\/g, '/')
  return TEXT_EXTS.has(path.extname(file).toLowerCase())
    || path.extname(file).toLowerCase() === '.pdf'
    || rel.startsWith('_gtfobins/')
    || rel.includes('/_gtfobins/')
}

function readTextContent(file, st = null) {
  if (path.extname(file).toLowerCase() === '.pdf') {
    const title = path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ')
    return `# ${title}\n\nPDF document. Search matches its title and path; extract the PDF contents locally when the full text is needed.`
  }
  return fs.readFileSync(file, 'utf8')
}

function listEntries(root, dir) {
  const abs = path.join(root, dir)
  let items = []
  try {
    items = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return { dirs: [], files: [] }
  }
  const dirs = []
  const files = []
  for (const it of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = dir ? `${dir}/${it.name}` : it.name
    if (it.isDirectory()) {
      if (it.name.startsWith('.') || /\.(?:diverged|recover)-/.test(it.name)) continue
      // fileCount = recursive count of searchable text files inside (for the
      // category badge in the UI). Bundled PATT chapters make this worthwhile.
      let fileCount = 0
      try {
        fileCount = countByExt(path.join(abs, it.name), TEXT_EXTS)
      } catch {
        fileCount = 0
      }
      dirs.push({ name: it.name, rel, fileCount })
    } else if (it.isFile() && isTextFile(it.name)) {
      let size = 0
      try {
        size = fs.statSync(path.join(abs, it.name)).size
      } catch { /* skip */ }
      files.push({ name: it.name, rel, size })
    }
  }
  return { dirs, files }
}

/** Recursively collect relative md/text paths under root, depth-first, capped. */
function walkFiles(root, maxFiles) {
  const out = []
  const walk = (dir) => {
    if (out.length >= maxFiles) return
    let items = []
    try {
      items = fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      if (out.length >= maxFiles) return
      const rel = dir ? `${dir}/${it.name}` : it.name
      if (it.isDirectory()) {
        const name = it.name.toLowerCase()
        if (name !== '.git' && name !== '.svn' && name !== '.index' && name !== 'node_modules') walk(rel)
      }
      else if (it.isFile() && isTextFile(it.name)) out.push(rel)
    }
  }
  walk('')
  return out
}

// ── search ──────────────────────────────────────────────────────────────────

function readHead(file, maxBytes) {
  try {
    const st = fs.statSync(file)
    if (st.size > MAX_READ_BYTES) return null
    const text = readTextContent(file, st)
    const head = text.length > maxBytes ? text.slice(0, maxBytes) : text
    return { text: head, truncated: text.length > maxBytes }
  } catch {
    return null
  }
}

function linesOf(text) {
  return text.split(/\r?\n/)
}

/** Match `query` (plain substring) inside a file's text; returns up to 3 {line, preview}. */
function matchIn(text, query) {
  const q = query.toLowerCase()
  const hits = []
  const lines = linesOf(text)
  for (let i = 0; i < lines.length && hits.length < 3; i++) {
    if (lines[i].toLowerCase().includes(q)) {
      const preview = lines[i].trim().slice(0, 180)
      hits.push({ line: i + 1, preview })
    }
  }
  return hits
}

/** terms 任一命中即命中（行级；供别名展开后的多词检索）。 */
function matchTermsIn(text, terms) {
  const lower = []
  const lines = linesOf(text)
  for (let i = 0; i < lines.length; i++) lower.push(lines[i].toLowerCase())
  const hits = []
  const seen = new Set()
  for (const term of terms) {
    for (let i = 0; i < lower.length && hits.length < 5; i++) {
      if (lower[i].includes(term) && !seen.has(i)) {
        seen.add(i)
        hits.push({ line: i + 1, preview: lines[i].trim().slice(0, 180), term })
      }
    }
  }
  return hits.slice(0, 4)
}

// ── Exploit-DB 字段化索引层（imports/exploitdb）────────────────────────────
// 现代 files_exploits.csv（16 列：id,file,description,date_published,author,type,platform,
// port,date_added,date_updated,verified,codes,tags,...）自带完整描述与 CVE codes——
// 单文件即可离线按 标题/类型/平台/CVE/EDB-ID 检索并定位 PoC 路径。
// 兼容旧布局 exploits.csv（id,file,description,date,author,type,platform,port）作为兜底。
let edbCache = { key: null, rows: [] }
function edbDir() {
  return path.join(importsRoot(), EDB_DIRNAME)
}
function loadEdbIndex() {
  const dir = edbDir()
  const fileCsv = path.join(dir, 'files_exploits.csv')
  const expCsv = path.join(dir, 'exploits.csv')
  // 缓存键 = 实际命中文件的「路径 + mtime + size」，**不是**纯时间窗。
  // 为什么必须这样：官方「下载索引」路径（edb-sync）会显式失效缓存，但
  //   · 用户按提示手动 clone / 拷贝索引进 imports/exploitdb/
  //   · 外部工具替换了索引文件
  // 这两条路径都不会失效缓存 —— 纯 TTL 会让「文件已就位」期间检索与 edb-status
  // 一致读不到新数据（实测：CSV 已落盘仍报 rows:0，且无任何提示），最长憋满 TTL。
  // 换成文件版本键后：内容一变立刻重建，且同一版本只解析一次
  //（比 TTL 更省——不再每 2 分钟无条件重解析一个约 10MB 的 CSV）。
  // 键里同时放 mtime 与 size：单靠 size 挡不住等长覆盖，单靠 mtime 挡不住
  // 同毫秒内的改写。
  let key = ''
  if (fs.existsSync(fileCsv)) key = versionKey(fileCsv)
  else if (fs.existsSync(expCsv)) key = versionKey(expCsv)
  if (edbCache.key === key) return edbCache.rows
  const rows = []
  try {
    if (fs.existsSync(fileCsv)) {
      const text = fs.readFileSync(fileCsv, 'utf8')
      const nl = text.indexOf('\n')
      const body = nl < 0 ? '' : text.slice(nl + 1)
      for (const line of body.split('\n')) {
        if (!line.trim()) continue
        const p = splitCsvLine(line)
        if (p.length < 6) continue
        const codes = (p[11] || '').split(';').map((s) => s.trim().toLowerCase()).filter((s) => s.startsWith('cve-'))
        rows.push({
          id: p[0], path: p[1] || '', desc: (p[2] || '').slice(0, 240),
          date: p[3] || '', author: p[4] || '', type: p[5] || '', platform: p[6] || '',
          codes, verified: p[10] === '1',
        })
      }
    } else if (fs.existsSync(expCsv)) {
      const text = fs.readFileSync(expCsv, 'utf8')
      const nl = text.indexOf('\n')
      const body = nl < 0 ? '' : text.slice(nl + 1)
      for (const line of body.split('\n')) {
        if (!line.trim()) continue
        const p = splitCsvLine(line)
        if (p.length < 6) continue
        rows.push({
          id: p[0], path: p[1] || '', desc: (p[2] || '').slice(0, 240),
          date: p[3] || '', author: p[4] || '', type: p[5] || '', platform: p[6] || '', codes: [],
        })
      }
    }
  } catch { /* 解析失败返回空 */ }
  edbCache = { key, rows }
  return rows
}

/** 文件的版本键（路径+mtime+size）。读不到 stat 时返回路径本身——
 *  让「存在但 stat 失败」与「不存在（key='')」仍是两个不同的键，不会互相污染缓存。 */
function versionKey(file) {
  try {
    const st = fs.statSync(file)
    return `${file}|${st.mtimeMs}|${st.size}`
  } catch {
    return String(file)
  }
}
/** CSV 行解析（支持带引号字段内的逗号）。 */
function splitCsvLine(line) {
  const out = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') q = !q
    else if (c === ',' && !q) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

function searchEdbLayer(query) {
  const rows = loadEdbIndex()
  if (rows.length === 0) return []
  const terms = expandTerms(query)
  const q = String(query || '').toLowerCase().trim()
  // Numeric EDB ids are exact only when the whole query is an id. A year in
  // "2026 World Cup" must not become EDB-2026 and receive an exact-match boost.
  const qNum = /^(?:edb[-_ ]?)?\d{3,6}$/i.test(q) ? q.replace(/[^\d]/g, '') : ''
  const qCve = /cve[-_ ]?\d/i.test(q) ? q.replace(/cve[-_ ]?/i, 'cve-') : ''
  const hits = []
  for (const r of rows) {
    if (hits.length >= 8) break
    const idExact = qNum && r.id === qNum
    const inDesc = r.desc && r.desc.toLowerCase().includes(q)
    const inType = r.type && (q === r.type.toLowerCase() || (q.length > 1 && r.type.toLowerCase().includes(q)))
    const cveHit = qCve !== '' && r.codes.some((c) => qCve.startsWith(c) || c.startsWith(qCve) || c === qCve)
    const termHit = terms.some((t) => t.length >= 2 && (r.desc.toLowerCase().includes(t) || (r.platform || '').toLowerCase().includes(t) || (r.author || '').toLowerCase().includes(t)))
    if (idExact || inDesc || inType || cveHit || termHit) {
      const cveTxt = r.codes.length ? ' ' + r.codes[0] : ''
      hits.push({
        source: 'import', mode: '', path: `exploitdb/${r.path || r.id}`,
        line: 0, preview: `[EDB-${r.id}]${r.verified ? '' : ' (未验证)'}${cveTxt} ${r.platform || ''} ${r.type || ''} ${r.desc.slice(0, 140)}`,
        edb: true, edbId: r.id,
      })
    }
  }
  return hits
}

function searchLayer(dir, query, maxFiles, sourceLabel, mode) {
  const files = walkFiles(dir, maxFiles)
  const hits = []
  const terms = expandTerms(query)
  const nameTerm = String(query || '').toLowerCase()
  for (const rel of files) {
    // 跳过 exploitdb 目录（走字段化层，避免把巨型 CSV/源码当文本扫）
    if (rel.split('/')[0] === EDB_DIRNAME) continue
    const file = path.join(dir, rel)
    const nameHits = terms.some((t) => t.length >= 2 && rel.toLowerCase().includes(t))
    const data = readHead(file, SMALL_FILE_LIMIT)
    if (!data) {
      if (nameHits) hits.push({ source: sourceLabel, mode, path: rel, line: 0, preview: '(文件名命中，文件过大未扫描)' })
      continue
    }
    const inHead = matchTermsIn(data.text, terms)
    if (inHead.length > 0) {
      for (const h of inHead) hits.push({ source: sourceLabel, mode, path: rel, line: h.line, preview: h.preview })
    } else if (nameHits) {
      hits.push({ source: sourceLabel, mode, path: rel, line: 0, preview: '(文件名命中)' })
    }
  }
  return hits
}

/** Legacy scanner kept as a fallback when SQLite/FTS5 cannot initialize. */
function searchLegacy(query, mode, limit = 60) {
  if (!query || !query.trim()) return []
  const hits = []
  hits.push(...searchEdbLayer(query))
  const bRoot = readRootOf('bundle', mode)
  if (bRoot && fs.existsSync(bRoot)) hits.push(...searchLayer(bRoot, query, MAX_SEARCH_FILES, 'bundle', mode))
  const pRoot = pattRoot()
  if (pRoot && fs.existsSync(pRoot)) hits.push(...searchLayer(pRoot, query, MAX_SEARCH_FILES, 'patt', ''))
  const uRoot = writeBaseOf('user', mode)
  if (uRoot && fs.existsSync(uRoot)) hits.push(...searchLayer(uRoot, query, MAX_SEARCH_FILES, 'user', mode))
  const iRoot = importsRoot()
  if (iRoot && fs.existsSync(iRoot)) hits.push(...searchLayer(iRoot, query, MAX_SEARCH_FILES, 'import', ''))
  return hits.slice(0, limit)
}

/**
 * Unified hybrid search:
 *   · FTS5 + BM25 for local docs, with Chinese bigrams and metadata boosts
 *   · alias expansion as a low-cost recall pass
 *   · Exploit-DB exact/field hits merged deterministically
 */
function searchAll(query, mode, limit = 60, source = '') {
  if (!query || !query.trim()) return []
  const max = Math.max(1, Number(limit) || 60)
  const sourceFilter = SEARCH_SOURCES.has(source) ? source : ''
  // 带来源过滤时先多取候选，再按来源裁到调用方上限；否则单一来源的词
  // 会被其它来源的更高分命中挤出前 N，过滤后看起来像“没有结果”。
  const scanMax = sourceFilter ? Math.max(max * 8, 80) : max
  const merged = new Map()
  const keyOf = (hit) => `${hit.source}\u0000${hit.mode || ''}\u0000${hit.path}\u0000${hit.line || 0}`
  const add = (hit, bonus = 0) => {
    if (sourceFilter && hit.source !== sourceFilter) return
    const copy = { ...hit, score: Number(hit.score || 0) + bonus }
    const key = keyOf(copy)
    const previous = merged.get(key)
    if (!previous || copy.score > previous.score) merged.set(key, copy)
  }

  let textHits = []
  try {
    const index = ensureKnowledgeIndex()
    textHits = index.search(query, { mode, limit: scanMax })
    for (const hit of textHits) add(hit)
    // 别名碎片扩展只在候选不足时跑（省检索次数）：语义上的跨语种召回由下面的
    // 术语替换整句检索负责，碎片扩展留着兜底。
    if (merged.size < scanMax) {
      for (const alias of expandTerms(query).slice(1, 5)) {
        for (const hit of index.search(alias, { mode, limit: Math.max(4, Math.ceil(scanMax / 2)) })) {
          add(hit, -1.5)
        }
      }
    }
    // 术语替换（中文概念 → 英文说法）再搜一遍：这是"混合语种"场景真正的召回来源，
    // 实测「Sigma 检测规则 powershell 编码命令」只有走这条路才能召回
    // sigma-rules/...powershell_base64_encoded_*.yml。
    const translated = translateQuery(query)
    if (translated !== String(query || '').trim()) {
      for (const hit of index.search(translated, { mode, limit: Math.max(6, Math.ceil(scanMax / 2)) })) {
        add(hit, -1.5)
      }
    }
  } catch (error) {
    console.error('[dsh-knowledge-hub] FTS index unavailable, using scanner: %s', error && error.message ? error.message : String(error))
    for (const hit of searchLegacy(query, mode, scanMax)) add(hit)
  }

  const edbHits = searchEdbLayer(query)
  for (const hit of edbHits) {
    const normalizedQuery = String(query || '').trim()
    const exact = /^(?:edb[-_ ]?)?\d{3,6}$/i.test(normalizedQuery) || /^cve[-_ ]?\d{4}[-_ ]?\d+$/i.test(normalizedQuery)
    add(hit, exact ? 1000 : 12)
  }
  // 覆盖度 rerank（只算总分，不丢候选）：同一个候选集里，命中查询概念多的排前面。
  const concepts = queryConcepts(query)
  const ranked = [...merged.values()]
    .map((hit) => ({ ...hit, score: Number(hit.score || 0) + coverageBonusOf(hit, concepts) }))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, max)
  return annotateCoverage(ranked, query)
}

// ── stats ───────────────────────────────────────────────────────────────────

function countByExt(root, exts) {
  if (!root || !fs.existsSync(root)) return 0
  let n = 0
  const walk = (dir) => {
    if (n > 1000000) return
    let items = []
    try {
      items = fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      const name = it.name.toLowerCase()
      if (it.isDirectory()) {
        if (name !== '.git' && name !== '.svn' && name !== '.index' && name !== 'node_modules' && !/\.(?:diverged|recover)-/.test(name)) {
          walk(dir ? `${dir}/${it.name}` : it.name)
        }
      }
      else if (it.isFile() && exts.has(path.extname(it.name).toLowerCase())) n++
    }
  }
  walk('')
  return n
}

function stats() {
  let bundleMd = 0
  let bundleRules = 0
  for (const b of bundleRefsRoots()) {
    bundleMd += countByExt(b.root, new Set(['.md']))
    bundleRules += countByExt(b.root, new Set(['.yaml', '.yml']))
  }
  const textExts = TEXT_EXTS
  const patt = countByExt(pattRoot(), textExts)
  // user layer counts the two mode dirs only — imports/ lives beside them and is counted separately
  let user = 0
  for (const mode of MODE_IDS) user += countByExt(userModeDir(mode), textExts)
  const imports = countByExt(importsRoot(), textExts)
  return { bundleMd, bundleRules, patt, user, imports, total: bundleMd + bundleRules + patt + user + imports }
}

// ── git import ──────────────────────────────────────────────────────────────

function importGit(url, name) {
  return new Promise((resolve) => {
    const safeName = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
    if (!/^https?:\/\//.test(url) || !safeName) {
      resolve({ ok: false, error: '需要合法的 http(s) Git 地址与名称' })
      return
    }
    const target = path.join(importsRoot(), safeName)
    try {
      if (fs.existsSync(target)) {
        resolve({ ok: false, error: `目录已存在：imports/${safeName}（先删除或换名）` })
        return
      }
      fs.mkdirSync(importsRoot(), { recursive: true })
    } catch (e) {
      resolve({ ok: false, error: `无法创建导入目录：${e && e.message ? e.message : String(e)}` })
      return
    }
    const child = spawn('git', ['clone', '--depth', '1', '--', url, target], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (d) => {
      err = (err + String(d)).slice(-2000)
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: '导入超时（120s）。网络/代理问题见宿主环境，可手动 clone 后放入 DSH_HOME/refs/imports/ 同名目录。' })
    }, 120000)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `git 不可用：${e && e.message ? e.message : String(e)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
        if (code === 0) {
          let ref = ''
          try {
            const r = spawnSync('git', ['-C', target, 'rev-parse', '--short', 'HEAD'], {
              encoding: 'utf8',
              windowsHide: true,
              timeout: 10000,
            })
            if (r.status === 0) ref = String(r.stdout || '').trim().slice(0, 12)
          } catch {
            /* snapshot optional */
          }
          resolve({ ok: true, value: { path: `imports/${safeName}`, ref } })
        } else {
          resolve({ ok: false, error: `git clone 失败（exit ${code}）：${err.trim().split('\n').slice(-2).join(' | ')}` })
        }
    })
  })
}

/** Copy a local folder (on the dsh machine) into the import layer. Skips .git. */
function importLocal(srcPath, name) {
  const safeName = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
  if (!safeName) {
    return Promise.resolve({ ok: false, error: '需要名称' })
  }
  let src = ''
  try {
    src = path.resolve(String(srcPath || '').trim())
  } catch {
    return Promise.resolve({ ok: false, error: '路径不合法' })
  }
  let st = null
  try {
    st = fs.statSync(src)
  } catch {
    return Promise.resolve({ ok: false, error: `本机路径不存在：${srcPath}` })
  }
  if (!st.isDirectory()) {
    return Promise.resolve({ ok: false, error: '源不是文件夹' })
  }
  const target = path.join(importsRoot(), safeName)
  // Never copy a layer into itself (target inside src, incl. imports root).
  if (target === src || target.startsWith(src + path.sep)) {
    return Promise.resolve({ ok: false, error: '源目录不能是导入区或其子目录（换个名称或先移走内容）' })
  }
  try {
    if (fs.existsSync(target)) {
      return Promise.resolve({ ok: false, error: `目录已存在：imports/${safeName}（先删除或换名）` })
    }
    fs.mkdirSync(importsRoot(), { recursive: true })
    fs.cpSync(src, target, {
      recursive: true,
      filter: (s) => path.basename(s) !== '.git',
    })
  } catch (e) {
    return Promise.resolve({ ok: false, error: `导入失败：${e && e.message ? e.message : String(e)}` })
  }
  // Report how many text files are now searchable.
  let textFiles = 0
  try {
    textFiles = walkFiles(target, 100000).length
  } catch {
    textFiles = 0
  }
  return Promise.resolve({ ok: true, value: { path: `imports/${safeName}`, files: textFiles } })
}

/** Top-level import package names, for provenance in the prompt manifest. */
function topImportNames() {
  const root = importsRoot()
  if (!root || !fs.existsSync(root)) return []
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== EDB_DIRNAME)
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

// ── RPC dispatch ────────────────────────────────────────────────────────────

async function dispatch(endpoint, payload) {
  const ok = (value) => ({ ok: true, value })
  // 失败必须回**结构化**错误：宿主连接层只认 `{ok:false, error:{code,message,details}}`，
  // 回字符串会被 parseConnectionResponse 判成 `invalid server-response result` 并
  // **reject 掉 Promise** —— 客户端 `.then` 永远不执行，界面就卡在"保存中…"+ 空白，
  // 连一句错误都不显示。实测：点开 Exploit-DB 命中（只有元数据、没有 PoC 正文）时，
  // read 返回「文件不存在」把整块详情区打成白板。
  const fail = (error) => ({
    ok: false,
    error: { code: 'knowledge-hub', message: String(error && error.message ? error.message : error), details: {} },
  })
  const p = payload || {}

  switch (endpoint) {
    case 'stats': {
      return ok({ ...stats(), index: knowledgeIndexStatus() })
    }

    case 'packs-status': {
      const status = packsStatus()
      status.lastSync = lastSyncSummary
      status.build = indexBuildStatus()
      status.catalog = loadCatalog().packs.map((pack) => ({
        id: pack.id,
        title: pack.title,
        license: pack.license,
        distribution: pack.distribution,
        modes: pack.modes,
        domains: pack.domains,
        autoInstall: pack.autoInstall,
      }))
      return ok(status)
    }

    case 'packs-mode': {
      const mode = setSyncMode(p.mode)
      return ok({ mode })
    }

    case 'packs-sync': {
      const ids = Array.isArray(p.ids) ? p.ids.map(String) : []
      const summary = await syncPacks({ ids, force: p.force !== false, concurrency: 3 })
      lastSyncSummary = summary
      if (summary.ok > 0) {
        invalidateKnowledgeIndex()
        startBackgroundIndexBuild({ force: true })
      }
      return ok(summary)
    }

    case 'index-status': {
      return ok(knowledgeIndexStatus())
    }

    case 'index-rebuild': {
      const index = ensureKnowledgeIndex(true)
      if (!index) return ok({ started: true, status: knowledgeIndexStatus() })
      return ok({ started: false, ...index.status() })
    }

    case 'edb-status': {
      const dir = edbDir()
      const present = fs.existsSync(path.join(dir, 'files_exploits.csv'))
      const rows = present ? loadEdbIndex() : []
      return ok({
        dir, present, rows: rows.length, hasFiles: true,
        hasExp: fs.existsSync(path.join(dir, 'exploits.csv')),
        hasShellcodes: fs.existsSync(path.join(dir, 'files_shellcodes.csv')),
        hint: present
          ? 'Exploit-DB 已就绪：knowledge_search 自动字段化命中 [EDB-ID]（含 CVE/平台/类型/标题），共 ' + rows.length + ' 条。注意：仅索引时 knowledge_read PoC 原文需目录中确有对应文件（完整仓库才有）；描述/定位检索不受影响。'
          : 'Exploit-DB 未接入。点「下载官方索引」抓取 files_exploits.csv（约 10MB，含 16 列完整元数据：标题/作者/类型/平台/CVE codes，可离线检索），需本机可访问 gitlab.com。',
      })
    }

    case 'edb-sync': {
      // 下载 exploitdb 官方仓库根的两个索引 csv（现代仓库不随仓发布 exploits.csv 描述表，
      // 描述检索需在线或依赖本地完整目录；本索引支持 EDB-ID 定位与 shellcode 索引）。
      const dir = edbDir()
      fs.mkdirSync(dir, { recursive: true })
      const urls = [
        ['files_exploits.csv', 'https://gitlab.com/exploit-database/exploitdb/-/raw/main/files_exploits.csv'],
        ['files_shellcodes.csv', 'https://gitlab.com/exploit-database/exploitdb/-/raw/main/files_shellcodes.csv'],
      ]
      const results = []
      try {
        for (const [name, url] of urls) {
          const tmp = path.join(dir, name + '.part')
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 60000)
          let res
          try {
            res = await fetch(url, { redirect: 'follow', signal: ctrl.signal })
          } catch (e) {
            results.push({ name, ok: false, error: e && e.name === 'AbortError' ? '超时(60s)' : (e && e.message ? e.message : String(e)) })
            continue
          } finally {
            clearTimeout(timer)
          }
          if (!res.ok) {
            results.push({ name, ok: false, error: `HTTP ${res.status}` })
            continue
          }
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length < 1024 || buf.length > 300 * 1024 * 1024) {
            results.push({ name, ok: false, error: `内容异常(${buf.length} bytes)` })
            continue
          }
          fs.writeFileSync(tmp, buf)
          fs.renameSync(tmp, path.join(dir, name))
          results.push({ name, ok: true, bytes: buf.length })
        }
      } catch (e) {
        return ok({ ok: false, results, error: e && e.message ? e.message : String(e) })
      }
      const allOk = results.length === urls.length && results.every((r) => r.ok)
      // 显式失效：本次刚改写了 CSV，键必然变，但清零能让语义明确（不依赖 mtime 粒度）。
      edbCache = { key: null, rows: [] }
      return ok({ ok: allOk, results, rows: allOk ? loadEdbIndex().length : 0 })
    }

    case 'browse': {
      const { source, mode, dir } = p
      if (source === 'import') {
        // imports: top level = import packages (dirs), then drill into a package
        if (!dir) return ok(listEntries(importsRoot(), ''))
        const target = safeResolve(importsRoot(), dir)
        if (!target) return fail('路径越界')
        return ok(listEntries(importsRoot(), dir))
      }
      const root = readRootOf(source, mode)
      if (!root || !fs.existsSync(root)) return ok({ dirs: [], files: [] })
      if (dir) {
        const target = safeResolve(root, dir)
        if (!target) return fail('路径越界')
      }
      return ok(listEntries(root, dir || ''))
    }

    case 'read': {
      const { source, mode, path: rel } = p
      const root = readRootOf(source, mode)
      if (!root) return fail('未知来源')
      const target = safeResolve(root, rel || '')
      if (!target) return fail('路径越界或不存在')
      let st
      try {
        st = fs.statSync(target)
      } catch {
        return fail('文件不存在')
      }
      if (!st.isFile() || st.size > MAX_READ_BYTES) return fail('过大或非文件（仅支持 ≤1MiB 文本）')
      try {
        const content = readTextContent(target, st)
        return ok({ content, source, size: st.size })
      } catch (e) {
        return fail(`读取失败：${e && e.message ? e.message : String(e)}`)
      }
    }

    case 'write': {
      const { source, mode, path: rel, content } = p
      const base = writeBaseOf(source, mode)
      if (!base) return fail('该层只读（bundle 不可写）')
      const target = safeResolve(base, rel || '')
      if (!target) return fail('路径越界')
      if (typeof content !== 'string') return fail('缺少 content')
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        // 覆盖已有文件前先备份：这是用户改自己写的条目，保存一下就永久覆盖上一版。
        const backup = backupExistingFile(base, target)
        fs.writeFileSync(target, content, 'utf8')
        invalidateKnowledgeIndex()
        return ok({ path: rel, backup })
      } catch (e) {
        return fail(`写入失败：${e && e.message ? e.message : String(e)}`)
      }
    }

    case 'remove': {
      const { source, mode, path: rel } = p
      const base = writeBaseOf(source, mode)
      if (!base) return fail('该层只读（bundle 不可写）')
      const target = safeResolve(base, rel || '')
      if (!target || target === base) return fail('路径越界')
      try {
        fs.statSync(target)
        // 删除前先移进同层 `.trash/`：这条路径删的是**用户自己写的知识条目/导入包**，
        // 直接 rm 就永久没了（2026-09-19 已在 webshell-mgr 上真实踩过一次覆盖丢数据）。
        // 同卷 rename 是原子的、几乎零成本，且可人工找回。
        // `.trash` 以点开头，listEntries / packRoots 都会跳过，不会出现在树或检索里。
        const trashDir = path.join(base, '.trash')
        fs.mkdirSync(trashDir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17) + '-' + Math.random().toString(36).slice(2, 8)
        const dest = path.join(trashDir, `${path.basename(target)}.${stamp}`)
        fs.renameSync(target, dest)
        // 回收站封顶：只留最近 50 条，避免删多了无限涨
        try {
          const kept = fs.readdirSync(trashDir).sort()
          for (const old of kept.slice(0, Math.max(0, kept.length - 50))) {
            fs.rmSync(path.join(trashDir, old), { recursive: true, force: true })
          }
        } catch { /* 清理旧回收项失败不影响本次删除 */ }
        invalidateKnowledgeIndex()
        return ok({ removed: rel, trash: dest })
      } catch (e) {
        return fail(`删除失败：${e && e.message ? e.message : String(e)}`)
      }
    }

    case 'search': {
      const { query, mode, source = '', limit = 20 } = p
      const m = MODE_IDS.includes(mode) ? mode : 'pentest'
      const n = Math.max(1, Math.min(100, Number(limit) || 20))
      return ok({ hits: searchAll(query || '', m, n, String(source || '')), index: knowledgeIndexStatus() })
    }

    case 'import_git': {
      const result = await importGit(String(p.url || ''), String(p.name || ''))
      if (result.ok) invalidateKnowledgeIndex()
      return result
    }

    case 'import_local': {
      const result = await importLocal(String(p.path || ''), String(p.name || ''))
      if (result.ok) invalidateKnowledgeIndex()
      return result
    }

    default:
      return fail('unknown endpoint: ' + endpoint)
  }
}

// ── apply ───────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const priority = (config && config.priority) || 'user-first'
  void priority // reserved for later layered-priority policy

  // Pre-create writable roots so the tab always has somewhere to write.
  try {
    for (const mode of MODE_IDS) fs.mkdirSync(userModeDir(mode), { recursive: true })
    fs.mkdirSync(importsRoot(), { recursive: true })
  } catch (e) {
    console.error('[dsh-knowledge-hub] cannot create user refs roots: %s', e && e.message ? e.message : String(e))
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (knowledgeIndex) knowledgeIndex.close()
    })
  }

  // Do not block host startup or model turns. Missing packs are synchronized
  // in the background and the first explicit search builds the index.
  setTimeout(() => {
    autoSyncKnowledgePacks(false).catch((error) => {
      console.error('[dsh-knowledge-hub] background sync rejected: %s', error && error.message ? error.message : String(error))
    })
  }, 3000)

  // Front-end RPC (loopback only, same channel style as sec-config).
  // 0.1.5-rc.1：必须用 ctx.inject([... 'webServer']) 作用域块（与 sec-config / mcp-studio 同写法）。
  // 模块级 inject 里带 webServer 不足以让 rpc.handle 注册路由时取到它（connection 服务内部改用
  // 调用方 owner.webServer），会抛 cannot get property "webServer" without inject。
  ctx.inject(['connection', 'webServer'], (web) => {
  try {
    const connection = ctx.connection
    connection.register(ctx, 
      CHANNEL,
      async (endpoint, payload) => {
        try {
          return await dispatch(endpoint, payload)
        } catch (error) {
          // 同上：连接层要结构化错误，抛异常这条路径也得给同样的形状。
          return {
            ok: false,
            error: { code: 'knowledge-hub', message: error instanceof Error ? error.message : String(error), details: {} },
          }
        }
      },
      { authority: 'loopback' },
    )
  } catch (error) {
    console.error('[dsh-knowledge-hub] RPC unavailable: %s', error && error.message ? error.message : String(error))
  }
  })

  // Model tools: extension-layer lookup plus the bundled PATT payload library;
  // the other bundled handbook docs keep being read directly at their preset
  // paths by the playbooks.
  const describeScope = `离线混合 RAG：随包手册/PATT + 用户积累 + 自动同步的知识包。先 knowledge_search 定位，再 knowledge_read 精读；不必整库载入上下文。`
  try {
    ctx.tools.register(
      defineTool({
        name: 'knowledge_search',
        description: `检索知识库并返回少量高相关片段与 chunkId（再用 knowledge_read 精读）。${describeScope}`,
        parameters: {
          query: { type: 'string', required: true, description: '关键词、CVE/EDB-ID 或自然语言问题' },
          mode: { type: 'string', enum: MODE_IDS, description: '预设模式（缺省 pentest）' },
          source: { type: 'string', enum: ['bundle', 'patt', 'user', 'import'], description: '限定来源层（缺省全部）' },
          limit: { type: 'number', description: '返回条数（默认 8，最大 20）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: { ok: { type: 'boolean', required: true } },
          },
          render: (_a, v) => [
            {
              type: 'text',
              text: v.ok
                ? `知识库命中 ${v.value.hits.length} 条` + (v.value.hits.length
                    ? '\n' + v.value.hits.map((h) => {
                        const pack = h.packId ? ` pack=${h.packId}` : ''
                        const title = h.title ? `${h.title} · ` : ''
                        return `${h.lowConfidence ? '[低置信] ' : ''}[${h.source}${pack}] ${h.path}:${h.line} chunk=${h.chunkId}\n${title}${h.preview}`
                      }).join('\n---\n')
                    : '')
                : `检索失败：${v.error || ''}`,
            },
          ],
        },
        async execute(args) {
          const mode = MODE_IDS.includes(args && args.mode) ? args.mode : 'pentest'
          const limit = Math.min(20, Math.max(1, Number((args && args.limit) || 8)))
          const source = SEARCH_SOURCES.has(args && args.source) ? args.source : ''
          const hits = searchAll(String((args && args.query) || ''), mode, limit, source)
          return { ok: true, value: { hits, index: knowledgeIndexStatus() } }
        },
      }),
      'dsh-knowledge-hub: knowledge_search',
    )

    ctx.tools.register(
      defineTool({
        name: 'knowledge_read',
        description: `按 chunkId 精读知识片段，或按 source+path 读取指定行段。${describeScope}`,
        parameters: {
          hitId: { type: 'string', description: 'knowledge_search 返回的 chunkId（优先）' },
          source: { type: 'string', enum: ['bundle', 'patt', 'user', 'import'], description: '来源层（未给 hitId 时必填）' },
          mode: { type: 'string', enum: MODE_IDS, description: 'bundle/user 层需要' },
          path: { type: 'string', description: '相对路径（/ 分隔；未给 hitId 时必填）' },
          offset: { type: 'number', description: '起始行（1 起）' },
          limit: { type: 'number', description: '读多少行（默认 80，最大 240）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: { ok: { type: 'boolean', required: true } },
          },
          render: (_a, v) => [
            {
              type: 'text',
              text: v.ok
                ? `[${v.value.source}] ${v.value.path} 行 ${v.value.from}-${v.value.to}\n文件：${v.value.absPath}\n${v.value.text}`
                : `读取失败：${v.error || ''}`,
            },
          ],
        },
        async execute(args) {
          let source = String((args && args.source) || '')
          const mode = MODE_IDS.includes(args && args.mode) ? args.mode : 'pentest'
          let rel = String((args && args.path) || '')
          let offset = Number((args && args.offset) || 0)
          if (args && args.hitId) {
            const chunk = getKnowledgeIndex().getChunk(args.hitId)
            if (!chunk) return { ok: false, error: 'chunkId 不存在，请重新检索' }
            source = chunk.kind
            rel = chunk.path
            if (!offset) offset = Math.max(1, Number(chunk.start_line || 1) - 30)
          }
          if (!source || !rel) return { ok: false, error: '需要 hitId，或 source + path' }
          const root = readRootOf(source, mode)
          if (!root) return { ok: false, error: '未知来源' }
          const target = safeResolve(root, rel)
          if (!target) return { ok: false, error: '路径越界或不存在' }
          let st
          try {
            st = fs.statSync(target)
          } catch {
            return { ok: false, error: '文件不存在' }
          }
          if (!st.isFile() || st.size > MAX_READ_BYTES) return { ok: false, error: '过大或非文件' }
          try {
            const lines = readTextContent(target, st).split(/\r?\n/)
            const from = Math.max(1, offset || 1)
            const limit = Math.min(240, Math.max(1, Number((args && args.limit) || 80)))
            const slice = lines.slice(from - 1, from - 1 + limit)
            return {
              ok: true,
              value: {
                source,
                path: rel,
                root,
                absPath: target,
                from,
                to: from - 1 + slice.length,
                text: slice.join('\n'),
              },
            }
          } catch (e) {
            return { ok: false, error: `读取失败：${e && e.message ? e.message : String(e)}` }
          }
        },
      }),
      'dsh-knowledge-hub: knowledge_read',
    )

    ctx.tools.register(
      defineTool({
        name: 'knowledge_list',
        description: `列出知识包、同步/索引状态与知识库目录，先确认有什么再检索。${describeScope}`,
        parameters: {
          mode: { type: 'string', enum: MODE_IDS, description: 'pentest / code-audit / ctf-solver（缺省 pentest）' },
          area: { type: 'string', enum: ['patt', 'user', 'import', 'packs', 'index', 'all'], description: '查看区域（缺省 all）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: { ok: { type: 'boolean', required: true } },
          },
          render: (_a, v) => [{ type: 'text', text: v.ok ? v.value.summary : `失败：${v.error || ''}` }],
        },
        async execute(args) {
          const mode = MODE_IDS.includes(args && args.mode) ? args.mode : 'pentest'
          const area = String((args && args.area) || 'all')
          const lines = []
          const dump = (label, root) => {
            if (!root || !fs.existsSync(root)) return
            const top = listEntries(root, '')
            const dirs = top.dirs.map((d) => d.name).join(', ')
            const files = top.files.map((f) => f.name).join(', ')
            lines.push(`- ${label}（root=${root}）：分类目录 [${dirs || '无'}] 文件 [${files || '无'}]`)
          }
          lines.push(`模式：${mode}（${MODE_LABELS[mode]}）`)
          if (area === 'all' || area === 'packs') {
            const ps = packsStatus()
            lines.push(`知识包：${ps.installed}/${ps.total} 已安装，${ps.failed} 个失败`)
            for (const pack of ps.packs.filter((item) => item.installed || item.enabled).slice(0, 30)) {
              lines.push(`- ${pack.installed ? '已装' : '未装'} ${pack.id}（${pack.license || 'license unknown'}）${pack.commit ? ` @${pack.commit}` : ''}${pack.error ? ` ⚠ ${pack.error}` : ''}`)
            }
          }
          if (area === 'all' || area === 'index') {
            const index = knowledgeIndexStatus()
            const build = index.build && index.build.status !== 'idle' ? ` / 构建=${index.build.status}` : ''
            lines.push(`索引：${index.ready ? '就绪' : '未就绪'} / ${index.docs} 文档 / ${index.chunks} chunks${index.indexedAt ? ` / ${index.indexedAt}` : ''}${build}${index.lastError ? ` / ⚠ ${index.lastError}` : ''}`)
          }
          if (area === 'all' || area === 'patt') dump(`随包 PATT（commit ${PATT_SNAPSHOT}，MIT）`, pattRoot())
          if (area === 'all' || area === 'user') dump('用户层', userModeDir(mode))
          if (area === 'all' || area === 'import') dump('导入层', importsRoot())
          const s = stats()
          lines.push(`统计：随包手册 ${s.bundleMd} 篇 + 规则 ${s.bundleRules} 条 / PATT ${s.patt} / 用户 ${s.user} / 导入 ${s.imports}`)
          return { ok: true, value: { summary: lines.join('\n') } }
        },
      }),
      'dsh-knowledge-hub: knowledge_list',
    )
  } catch (error) {
    console.error('[dsh-knowledge-hub] tools unavailable: %s', error && error.message ? error.message : String(error))
  }

  // Prompt manifest: one deterministic line when the layer has content.
  try {
    ctx.systemPrompt.context({
      name: 'knowledge-hub',
      order: 560,
      // 走缓存版本：这条文本每个回合都会被装配一次，全量遍历知识目录的代价不能放在热路径上。
      text: () => knowledgeManifest(),
    })
  } catch (error) {
    console.error('[dsh-knowledge-hub] systemPrompt unavailable: %s', error && error.message ? error.message : String(error))
  }
}

export { dispatch, stats, searchAll, ensureKnowledgeIndex, autoSyncKnowledgePacks, closeKnowledgeIndex, getSyncMode, setSyncMode }
