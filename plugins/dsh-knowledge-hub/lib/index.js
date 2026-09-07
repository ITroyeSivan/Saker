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
export const inject = ['connection', 'tools', 'systemPrompt']

const CHANNEL = '/dsh-knowledge-hub'
const MODE_IDS = ['pentest', 'code-audit']
const MODE_LABELS = { pentest: '渗透测试', 'code-audit': '代码审计' }
const TEXT_EXTS = new Set(['.md', '.txt', '.yaml', '.yml'])
const MAX_READ_BYTES = 1024 * 1024 // 1 MiB single-file read cap
const MAX_SEARCH_FILES = 500 // per search call
const SMALL_FILE_LIMIT = 200 * 1024 // ≤200 KiB scanned fully; larger scans head + filename only
const HEAD_LINES = 1000 // lines scanned from large files

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

function searchLayer(dir, query, maxFiles, sourceLabel, mode) {
  const files = walkFiles(dir, maxFiles)
  const hits = []
  const q = query.toLowerCase()
  for (const rel of files) {
    const file = path.join(dir, rel)
    const nameHits = rel.toLowerCase().includes(q)
    const data = readHead(file, SMALL_FILE_LIMIT)
    if (!data) {
      if (nameHits) hits.push({ source: sourceLabel, mode, path: rel, line: 0, preview: '(文件名命中，文件过大未扫描)' })
      continue
    }
    const inHead = matchIn(data.text, q)
    if (inHead.length > 0) {
      for (const h of inHead) hits.push({ source: sourceLabel, mode, path: rel, line: h.line, preview: h.preview })
    } else if (nameHits) {
      hits.push({ source: sourceLabel, mode, path: rel, line: 0, preview: '(文件名命中)' })
    }
  }
  return hits
}

/** Unified search across bundled PATT + bundle(mode) + user(mode) + all imports. */
function searchAll(query, mode) {
  if (!query || !query.trim()) return []
  const hits = []
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
  try {
    ctx.connection.rpc.handle(
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

