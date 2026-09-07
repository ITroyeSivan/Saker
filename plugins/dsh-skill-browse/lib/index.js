// dsh-skill-browse — host.
// 提供设置页「技能」面板的数据与动作。真实语义对齐宿主 skill 子系统
// （@deepseek-ai/dsh-skill + dsh-skill-filesystem + dsh-tool-skill）：
//
//   - 会话技能目录 = 各 preset 挂载的 skill-filesystem（customSkillDirs 指向
//     preset/<mode>/skills 与 shared/skills）+ 宿主 user 根（$DSH_HOME/skills）。
//   - 模型调用：会话开始时 tool-skill 注入 <available_skills> 目录，模型可调
//     `skill` 工具按名加载正文。
//   - 用户调用：输入框打 `/` 触发宿主 ui-skill 源，选 `/<name>` 即注入当轮。
//     本面板不发明新语法（上版 `@skill:` 提法是误导，已移除）。
//
// 本插件只负责「看」与「装」：列出当前可见技能（shared / preset / user 三层，
// 附带描述与可卸载标记）；上传 zip/tgz 压缩包解到 $DSH_HOME/skills/<name>/，
// 由宿主 skill-filesystem 热载入目录（watcher 常驻），无需重启。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-skill-browse'
export const inject = ['connection']

const CHANNEL = '/dsh-skill-browse'

const Config = z.object({
  enable: z.boolean().default(true),
  /** Override for $DSH_HOME; defaults to ~/.dsh (only used when DSH_HOME unset). */
  dshHome: z.string().default(''),
})

const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/
const NAME_RE = /^name:\s*([a-z0-9][a-z0-9-]*)\s*$/m
const DESC_RE = /^description:\s*(.+?)\s*$/m
// 宿主 isSkillName 镜像：小写 kebab-case（/^[a-z0-9]+(?:-[a-z0-9]+)*$/）。
// 上传名若不合此规则，filesystem 提供方不会把它暴露进会话目录——先拒绝更诚实。
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function readSkillMd(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const fm = FRONTMATTER_RE.exec(text)
    if (!fm) return null
    const name = NAME_RE.exec(fm[1])?.[1]
    if (!name || !SKILL_NAME_RE.test(name)) return null
    const description = (DESC_RE.exec(fm[1])?.[1] ?? '').trim()
    return { name, description }
  } catch { return null }
}

function dshHomeOf(config) {
  return config?.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
function userSkillRoot(config) {
  return path.join(dshHomeOf(config), 'skills')
}

/** 只列含 SKILL.md 的目录（filesystem 的目录式布局）或顶层 .md 文件。 */
function readUserSkills(root) {
  const out = []
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.isDirectory()) {
      const meta = readSkillMd(path.join(root, e.name, 'SKILL.md'))
      if (meta) out.push({ ...meta, origin: 'user', dir: e.name })
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      const meta = readSkillMd(path.join(root, e.name))
      if (meta) out.push({ ...meta, origin: 'user', dir: null })
    }
  }
  return out
}

function listSkills(presetId, config) {
  const out = []
  const seen = new Set()
  const add = (meta, origin) => {
    if (!meta || seen.has(meta.name)) return
    seen.add(meta.name)
    out.push({ ...meta, origin })
  }
  // shared
  try {
    for (const e of fs.readdirSync(path.join(BUNDLE_ROOT, 'shared', 'skills'), { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      add(readSkillMd(path.join(BUNDLE_ROOT, 'shared', 'skills', e.name, 'SKILL.md')), 'shared')
    }
  } catch { /* 缺 shared 目录时忽略 */ }
  // preset/<mode>
  if (presetId) {
    try {
      for (const e of fs.readdirSync(path.join(BUNDLE_ROOT, 'preset', presetId, 'skills'), { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        add(readSkillMd(path.join(BUNDLE_ROOT, 'preset', presetId, 'skills', e.name, 'SKILL.md')), 'preset')
      }
    } catch { /* 该模式无 skills */ }
  }
  // user
  for (const s of readUserSkills(userSkillRoot(config))) add(s, 'user')
  return out
}

// ── 压缩包安装（zip / tgz / tar.gz）────────────────────────────────────────
// 上传 base64 → 临时目录解出 → 要求归档恰好含一个 skill（顶层 <name>/SKILL.md
// 目录式，或顶层单个 .md）→ 校验 frontmatter name 合法 → 复制到
// $DSH_HOME/skills/<name>/（保留同目录资源文件）。watcher 自动热载。
// 平台原生 `tar`（Windows bsdtar / GNU tar）处理 tgz；zip 用 PowerShell
// Expand-Archive。Windows 平台两者都可用，非 Windows 走系统 unzip/tar。

/** 选一个能解 tgz 的 tar：Windows 自带 bsdtar 优先（System32，路径处理稳），
 *  否则退 PATH 里的 tar（GNU tar 需 forward-slash）。返回 null 表示都不可用。 */
function resolveTar() {
  if (process.platform === 'win32') {
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    try { if (fs.existsSync(systemTar)) return systemTar } catch { /* fall through */ }
  }
  return 'tar'
}

function unpackToTemp(archivePath, dest, isZip) {
  const ap = archivePath.replace(/\\/g, '/')
  const dp = dest.replace(/\\/g, '/')
  if (isZip) {
    if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null',
        `[System.IO.Compression.ZipFile]::ExtractToDirectory('${ap.replace(/'/g, "''")}', '${dp.replace(/'/g, "''")}')`,
      ].join('; ')
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60_000 })
      if (r.error) throw new Error('zip extract failed: ' + r.error.message)
      if (r.status !== 0) throw new Error('zip extract failed: ' + (r.stderr || r.stdout || '').slice(0, 300))
      return
    }
    const r = spawnSync('unzip', ['-q', '-o', ap, '-d', dp], { encoding: 'utf8', timeout: 60_000 })
    if (r.status !== 0) throw new Error('unzip failed: ' + (r.stderr || r.stdout || '').slice(0, 300))
    return
  }
  // tgz / tar.gz：System32 bsdtar 优先（原生支持 Windows 路径）
  const tarBin = resolveTar()
  const r = spawnSync(tarBin, ['-xzf', ap, '-C', dp], { encoding: 'utf8', timeout: 60_000 })
  if (r.error) throw new Error('tar extract failed: ' + r.error.message)
  if (r.status !== 0) throw new Error('tar extract failed: ' + (r.stderr || r.stdout || '').slice(0, 300))
}

/** 递归收集一个 skill 目录内的全部常规文件相对路径（防 symlink/越界）。 */
function collectSkillFiles(root) {
  const files = []
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      const relp = rel ? path.join(rel, e.name) : e.name
      if (e.isSymbolicLink()) continue // 拒绝符号链接（防逃逸）
      if (e.isDirectory()) walk(abs, relp)
      else if (e.isFile()) files.push(relp)
    }
  }
  walk(root, '')
  return files
}

/**
 * 只读探测：从已解开目录识别唯一 skill，返回 { name, description }（不落盘）。
 * 结构与 installSkillDir 同规则；重复/畸形均抛错。
 */
export function probeSkillDir(tmpRoot) {
  const top = fs.readdirSync(tmpRoot, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isFile())
  let name = null
  let description = ''
  const mdFiles = top.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
  const dirsWithSkill = top.filter((e) => e.isDirectory() && fs.existsSync(path.join(tmpRoot, e.name, 'SKILL.md')))
  if (dirsWithSkill.length === 1 && mdFiles.length === 0 && top.filter((e) => e.isDirectory()).length === 1) {
    const meta = readSkillMd(path.join(tmpRoot, dirsWithSkill[0].name, 'SKILL.md'))
    if (!meta) throw new Error('SKILL.md 缺少合法 frontmatter（name + description）')
    name = meta.name; description = meta.description
  } else if (dirsWithSkill.length === 0 && mdFiles.length === 1 && top.length === 1) {
    const meta = readSkillMd(path.join(tmpRoot, mdFiles[0].name))
    if (!meta) throw new Error('SKILL.md 缺少合法 frontmatter（name + description）')
    name = meta.name; description = meta.description
  } else {
    throw new Error('压缩包应含一个技能目录（含 SKILL.md）或一个顶层 <name>.md，且无多余顶层文件')
  }
  if (!SKILL_NAME_RE.test(name)) throw new Error('技能名不合法：' + name)
  return { name, description }
}

/**
 * 从已解开的临时目录中识别出唯一 skill 并装入 user 根。
 * 规则：顶层恰好含一个 SKILL.md（目录式），或恰好一个顶层 .md（平铺式）。
 * @returns 安装后的 { name, dir } 或抛错。
 */
export function installSkillDir(tmpRoot, userRoot) {
  const probe = probeSkillDir(tmpRoot)
  const name = probe.name
  const top = fs.readdirSync(tmpRoot, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isFile())
  const dirsWithSkill = top.filter((e) => e.isDirectory() && fs.existsSync(path.join(tmpRoot, e.name, 'SKILL.md')))
  if (dirsWithSkill.length === 1) {
    // 目录式 → ~/.dsh/skills/<name>/SKILL.md（同目录资源随迁）
    const targetRoot = path.join(userRoot, name)
    if (fs.existsSync(targetRoot)) throw new Error(`$DSH_HOME/skills/${name} 已存在——先卸载或换名再装`)
    fs.mkdirSync(targetRoot, { recursive: true })
    const srcDir = path.join(tmpRoot, dirsWithSkill[0].name)
    for (const rel of collectSkillFiles(srcDir)) {
      const from = path.join(srcDir, rel)
      const to = path.join(targetRoot, rel)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
    }
    if (!fs.existsSync(path.join(targetRoot, 'SKILL.md'))) {
      fs.rmSync(targetRoot, { recursive: true, force: true })
      throw new Error('复制后缺少 SKILL.md（异常终止）')
    }
    return { name, description: probe.description, path: targetRoot }
  }
  // 平铺式 → ~/.dsh/skills/<name>.md（filesystem 平铺发现需要文件直接躺在根层）
  const flat = top.find((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
  const targetFile = path.join(userRoot, name + '.md')
  if (fs.existsSync(targetFile)) throw new Error(`$DSH_HOME/skills/${name}.md 已存在——先卸载或换名再装`)
  fs.copyFileSync(path.join(tmpRoot, flat.name), targetFile)
  return { name, description: probe.description, path: targetFile }
}

function ok(value) { return { ok: true, value } }
function failure(message, code = 'skill-browse') { return { ok: false, error: { code, message: String(message), details: {} } } }

/** 随包技能名集合（shared + 全部 preset）——这些名字优先级高于用户层，用户同名上传会被遮蔽，直接拒绝。 */
function bundledSkillNames() {
  const names = new Set()
  const scan = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const meta = readSkillMd(path.join(dir, e.name, 'SKILL.md'))
      if (meta) names.add(meta.name)
    }
  }
  scan(path.join(BUNDLE_ROOT, 'shared', 'skills'))
  try {
    for (const p of fs.readdirSync(path.join(BUNDLE_ROOT, 'preset'), { withFileTypes: true })) {
      if (p.isDirectory()) scan(path.join(BUNDLE_ROOT, 'preset', p.name, 'skills'))
    }
  } catch { /* 无 preset 目录 */ }
  return names
}

export function apply(ctx, config = {}) {
  const cfg = { enable: true, dshHome: '', ...config }
  if (!cfg.enable) return
  const { connection } = ctx
  const root = userSkillRoot(cfg)

  connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
    if (endpoint === 'list') {
      const presetId = payload && typeof payload.presetId === 'string' ? payload.presetId : ''
      return ok({ skills: listSkills(presetId, cfg) })
    }
    if (endpoint === 'install-archive') {
      // payload: { fileName, dataBase64 }；zip 或 tgz。
      const p = payload && typeof payload === 'object' ? payload : {}
      if (typeof p.fileName !== 'string' || typeof p.dataBase64 !== 'string' || p.dataBase64.length > 32 * 1024 * 1024) {
        return failure('需提供 fileName 与 dataBase64（≤32MB）')
      }
      const lower = p.fileName.toLowerCase()
      const isZip = lower.endsWith('.zip')
      if (!isZip && !lower.endsWith('.tgz') && !lower.endsWith('.tar.gz')) {
        return failure('仅支持 .zip / .tgz / .tar.gz 压缩包')
      }
      let archivePath
      const session = path.join(os.tmpdir(), 'dsh-skill-' + randomBytes(8).toString('hex'))
      try {
        fs.mkdirSync(session, { recursive: true })
        const extracted = path.join(session, 'x')
        fs.mkdirSync(extracted, { recursive: true })
        archivePath = path.join(session, 'archive' + (isZip ? '.zip' : '.tgz'))
        fs.writeFileSync(archivePath, Buffer.from(p.dataBase64, 'base64'))
        unpackToTemp(archivePath, extracted, isZip)
        // 先只读探测，撞随包名（shared/preset rank 更高必遮蔽）即拒绝
        let probe
        try { probe = probeSkillDir(extracted) } catch (err) { return failure(err && err.message ? err.message : String(err)) }
        if (bundledSkillNames().has(probe.name)) {
          return failure(`随包已内置技能 /${probe.name}（shared 或 preset），同名上传会被遮蔽——请改 frontmatter name 后重试`)
        }
        const installed = installSkillDir(extracted, root)
        return ok({ installed: { name: installed.name, description: installed.description, origin: 'user' } })
      } catch (err) {
        return failure(err && err.message ? err.message : String(err))
      } finally {
        try { fs.rmSync(session, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
    if (endpoint === 'remove-skill') {
      const name = payload && typeof payload.name === 'string' ? payload.name : ''
      if (!SKILL_NAME_RE.test(name)) return failure('技能名不合法')
      const target = path.join(root, name)
      const meta = readSkillMd(path.join(target, 'SKILL.md'))
      if (!meta || meta.name !== name) {
        // 也可能是顶层平铺 <name>.md
        const flat = path.join(root, name + '.md')
        if (!fs.existsSync(flat) || !readSkillMd(flat) || readSkillMd(flat).name !== name) {
          return failure('未找到用户技能 ' + name)
        }
        try { fs.unlinkSync(flat); return ok({ removed: name }) } catch (err) { return failure(err.message) }
      }
      try { fs.rmSync(target, { recursive: true, force: true }); return ok({ removed: name }) } catch (err) { return failure(err.message) }
    }
    return failure('unknown endpoint: ' + endpoint)
  }, { authority: 'loopback' })
}

export { Config }
