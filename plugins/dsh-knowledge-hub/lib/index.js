// dsh-knowledge-hub — host.
//
// Two-layer knowledge refs for the pentest / code-audit presets:
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
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-knowledge-hub'
export const inject = ['connection', 'tools', 'systemPrompt', 'webServer']

const CHANNEL = '/dsh-knowledge-hub'
const MODE_IDS = ['pentest', 'code-audit']
const MODE_LABELS = { pentest: '渗透测试', 'code-audit': '代码审计' }
const TEXT_EXTS = new Set(['.md', '.txt', '.yaml', '.yml'])
const MAX_READ_BYTES = 1024 * 1024 // 1 MiB single-file read cap
const MAX_SEARCH_FILES = 500 // per search call
const SMALL_FILE_LIMIT = 200 * 1024 // ≤200 KiB scanned fully; larger scans head + filename only
const HEAD_LINES = 1000 // lines scanned from large files

// Exploit-DB：约定目录 imports/exploitdb（官方仓库或元数据快照）。识别标志=两个 CSV。
// 检索=字段化索引（EDB-ID/平台/描述），不做整库 embedding；PoC 原文按需读。
const EDB_DIRNAME = 'exploitdb'
const EDB_INDEX_TTL = 120000

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
function bundleRefsRoots() {
  if (bundleRefs !== null) return bundleRefs
  bundleRefs = []
  try {
    const req = createRequire(import.meta.url)
    const pkgRoot = path.dirname(req.resolve('dsh-saker/package.json'))
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
    const req = createRequire(import.meta.url)
    const pkgRoot = path.dirname(req.resolve('dsh-saker/package.json'))
    const dir = path.join(pkgRoot, 'preset', 'shared', 'refs', 'PayloadsAllTheThings')
    if (fs.existsSync(dir)) pattRef = fs.realpathSync(dir)
  } catch {
    /* root package not installed */
  }
  return pattRef
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
  return TEXT_EXTS.has(path.extname(file).toLowerCase())
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
      if (it.isDirectory()) walk(rel)
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
    const buf = fs.readFileSync(file)
    const text = buf.toString('utf8')
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
let edbCache = { at: 0, rows: [] }
function edbDir() {
  return path.join(importsRoot(), EDB_DIRNAME)
}
function loadEdbIndex() {
  const now = Date.now()
  if (edbCache.at && now - edbCache.at < EDB_INDEX_TTL) return edbCache.rows
  const dir = edbDir()
  const rows = []
  const fileCsv = path.join(dir, 'files_exploits.csv')
  const expCsv = path.join(dir, 'exploits.csv')
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
  edbCache = { at: now, rows }
  return rows
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
  const qNum = q.replace(/[^\d]/g, '')
  const qCve = q.replace(/cve[-_ ]?/i, 'cve-')
  const hits = []
  for (const r of rows) {
    if (hits.length >= 8) break
    const idExact = qNum && r.id === qNum
    const inDesc = r.desc && r.desc.toLowerCase().includes(q)
    const inType = r.type && (q === r.type.toLowerCase() || (q.length > 1 && r.type.toLowerCase().includes(q)))
    const cveHit = r.codes.some((c) => qCve.startsWith(c) || c.startsWith(qCve) || c === qCve)
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

/** Unified search: Exploit-DB 字段层优先，再 PATT/bundle/user/import 文本层。 */
function searchAll(query, mode) {
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
  return hits.slice(0, 60)
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
      if (it.isDirectory()) walk(dir ? `${dir}/${it.name}` : it.name)
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
  const textExts = new Set(['.md', '.txt', '.yaml', '.yml'])
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
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

// ── RPC dispatch ────────────────────────────────────────────────────────────

async function dispatch(endpoint, payload) {
  const ok = (value) => ({ ok: true, value })
  const fail = (error) => ({ ok: false, error })
  const p = payload || {}

  switch (endpoint) {
    case 'stats': {
      return ok(stats())
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
      edbCache = { at: 0, rows: [] } // 强制下次重建索引
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
        const content = fs.readFileSync(target, 'utf8')
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
        fs.writeFileSync(target, content, 'utf8')
        return ok({ path: rel })
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
        const st = fs.statSync(target)
        if (st.isDirectory()) fs.rmSync(target, { recursive: true, force: false })
        else fs.unlinkSync(target)
        return ok({ removed: rel })
      } catch (e) {
        return fail(`删除失败：${e && e.message ? e.message : String(e)}`)
      }
    }

    case 'search': {
      const { query, mode } = p
      const m = MODE_IDS.includes(mode) ? mode : 'pentest'
      return ok({ hits: searchAll(query || '', m) })
    }

    case 'import_git': {
      return await importGit(String(p.url || ''), String(p.name || ''))
    }

    case 'import_local': {
      return await importLocal(String(p.path || ''), String(p.name || ''))
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

  // Front-end RPC (loopback only, same channel style as sec-config).
  // 0.1.5-rc.1：必须用 ctx.inject([... 'webServer']) 作用域块（与 sec-config / mcp-studio 同写法）。
  // 模块级 inject 里带 webServer 不足以让 rpc.handle 注册路由时取到它（connection 服务内部改用
  // 调用方 owner.webServer），会抛 cannot get property "webServer" without inject。
  ctx.inject(['connection', 'webServer'], (web) => {
  try {
    const connection = ctx.connection
    connection.rpc.handle(
      CHANNEL,
      async (endpoint, payload) => {
        try {
          return await dispatch(endpoint, payload)
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
  const describeScope = `分层知识库：随包 PATT(payload 库，commit ${PATT_SNAPSHOT}) + 个人/团队积累 + 导入源（如本地/Git 导入的外部资产）。包内随包手册仍在预设 refs 路径直接读。`
  try {
    ctx.tools.register(
      defineTool({
        name: 'knowledge_search',
        description: `按关键词定位知识库文档（先定位到文件/行，再 knowledge_read 原文）。${describeScope}返回命中的来源（patt/bundle/user/import）、相对路径、行号与预览行。`,
        parameters: {
          query: { type: 'string', required: true, description: '检索关键词（大小写不敏感子串）' },
          mode: { type: 'string', enum: MODE_IDS, description: '预设模式：pentest / code-audit（缺省 pentest；patt/import 为通用内容不受 mode 限制）' },
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
                ? `知识库命中 ${v.value.hits.length} 条` + (v.value.hits.length ? '：' + v.value.hits.map((h) => `[${h.source}] ${h.mode || '通用'}/${h.path}:${h.line} ${h.preview}`).join(' | ') : '')
                : `检索失败：${v.error || ''}`,
            },
          ],
        },
        async execute(args) {
          const mode = MODE_IDS.includes(args && args.mode) ? args.mode : 'pentest'
          const hits = searchAll(String((args && args.query) || ''), mode)
          return { ok: true, value: { hits } }
        },
      }),
      'dsh-knowledge-hub: knowledge_search',
    )

    ctx.tools.register(
      defineTool({
        name: 'knowledge_read',
        description: `按来源与相对路径读取知识库文档片段（禁整读大文件，按需给 offset/limit）。${describeScope}`,
        parameters: {
          source: { type: 'string', required: true, enum: ['bundle', 'patt', 'user', 'import'], description: '来源层' },
          mode: { type: 'string', enum: MODE_IDS, description: 'bundle/user 层需要（patt/import 忽略）' },
          path: { type: 'string', required: true, description: '相对路径（/ 分隔），如 web/web-injection-ssrf.md' },
          offset: { type: 'number', description: '起始行（1 起）' },
          limit: { type: 'number', description: '读多少行（默认 120，最大 400）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: { ok: { type: 'boolean', required: true } },
          },
          render: (_a, v) => [
            { type: 'text', text: v.ok ? `[${v.value.source}] ${v.value.path} 行 ${v.value.from}-${v.value.to}` : `读取失败：${v.error || ''}` },
          ],
        },
        async execute(args) {
          const source = String((args && args.source) || '')
          const mode = MODE_IDS.includes(args && args.mode) ? args.mode : 'pentest'
          const rel = String((args && args.path) || '')
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
            const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/)
            const from = Math.max(1, Number((args && args.offset) || 1))
            const limit = Math.min(400, Math.max(1, Number((args && args.limit) || 120)))
            const slice = lines.slice(from - 1, from - 1 + limit)
            return { ok: true, value: { source, path: rel, from, to: from - 1 + slice.length, text: slice.join('\n') } }
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
        description: `列出知识库目录结构（含来源），先摸清有什么再决定检索/读取。${describeScope}`,
        parameters: {
          mode: { type: 'string', enum: MODE_IDS, description: 'pentest / code-audit（缺省 pentest）' },
          area: { type: 'string', enum: ['patt', 'user', 'import', 'all'], description: '只看随包 PATT/用户层/导入层/全部（缺省 all）' },
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
            lines.push(`- ${label}：分类目录 [${dirs || '无'}] 文件 [${files || '无'}]`)
          }
          lines.push(`模式：${mode}（${MODE_LABELS[mode]}）`)
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
      text: () => {
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
        if (parts.length === 0) return ''
        return `<dsh-knowledge-hub>知识库：${parts.join('，')}。用 knowledge_search / knowledge_read / knowledge_list 检索与读取（知识库含随包 PATT 时，source 用 patt；包内随包手册仍在 preset refs 路径直接读）。</dsh-knowledge-hub>`
      },
    })
  } catch (error) {
    console.error('[dsh-knowledge-hub] systemPrompt unavailable: %s', error && error.message ? error.message : String(error))
  }
}

export { dispatch, stats, searchAll }

