// dsh-method-stack — host.
// 提示词"方法"化：把可切换的测试逻辑组织成 模块组(group)→子方法(method) 两级。
// 模型侧：注册固定 systemPrompt context（order 460，位于 route-boost 500 之前），
// text 回调按 agent→preset 读取该模式的"方法组合"，把启用方法正文按 order 拼装注入
// 每轮 —— 用户改动组合后下一轮即生效（agent-loop 每轮重渲染 contexts）。
// 自定义：官方默认方法集随本插件 methods/（只读，可克隆到用户层）；用户层
// ~/.dsh/methods/<group>/<id>/ 同名 shadow 官方（与宿主 scoped section 同构思想）。
// 组合持久化：~/.dsh/method-stack/profiles/<presetId>.yml（默认组合+自定义组合）。
// 追溯：组合内容变化递增 rev，追加 ~/.dsh/method-stack/audit.log（时间/模式/组合/rev）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-method-stack'
export const inject = ['connection', 'systemPrompt', 'agentPresets']

const CHANNEL = '/dsh-method-stack'
const Config = z.object({ enable: z.boolean().default(true) })

// 随包默认方法集（只读；克隆后进用户层编辑）。目录每项含 manifest.yml + prompt.md。
const BUILTIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'methods')
const HOME_ROOT = path.join(os.homedir(), '.dsh', 'method-stack')
const USER_METHODS_ROOT = path.join(HOME_ROOT, 'methods')
const PROFILES_DIR = path.join(HOME_ROOT, 'profiles')
const AUDIT_LOG = path.join(HOME_ROOT, 'audit.log')
const GROUP_ORDER = ['recon', 'exploit', 'evidence', 'report', 'intranet']
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_TEXT = 6000 // 单个方法正文截断保护
const MANIFEST_NAME_RE = /^name:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*$/m

function builtinGroups() {
  const out = []
  let entries
  try { entries = fs.readdirSync(BUILTIN_ROOT, { withFileTypes: true }) } catch { return out }
  for (const g of entries) {
    if (!g.isDirectory() || !GROUP_ORDER.includes(g.name)) continue
    const methods = []
    let mEntries
    try { mEntries = fs.readdirSync(path.join(BUILTIN_ROOT, g.name), { withFileTypes: true }) } catch { continue }
    for (const m of mEntries) {
      if (!m.isDirectory()) continue
      const man = readManifest(path.join(BUILTIN_ROOT, g.name, m.name, 'manifest.yml'))
      const md = readText(path.join(BUILTIN_ROOT, g.name, m.name, 'prompt.md'))
      if (man && md) methods.push({ id: m.name, ...man, prompt: md, origin: 'official' })
    }
    if (methods.length > 0) out.push({ group: g.name, methods })
  }
  // 稳定组序
  out.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
  return out
}

/** 用户层方法：用户 group 目录下的全部条目。
 *  与官方同名 → 覆盖（origin:'user'，官方版不受影响，restore 可还原）；
 *  官方没有 → 新增（origin:'custom'，restore 即删除）。
 *  目录名即 id，先过 ID_RE 防路径穿越；无官方同名同样必须落在官方已有的组内。 */
function userGroupsFor() {
  const out = []
  for (const g of builtinGroups()) {
    const dir = path.join(USER_METHODS_ROOT, g.group)
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    const byId = new Map(g.methods.map((m) => [m.id, m]))
    const users = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (!ID_RE.test(e.name)) continue
      const man = readManifest(path.join(dir, e.name, 'manifest.yml'))
      const md = readText(path.join(dir, e.name, 'prompt.md'))
      if (man && md) users.push({ id: e.name, ...man, prompt: md, origin: byId.has(e.name) ? 'user' : 'custom' })
    }
    if (users.length > 0) out.push({ group: g.group, methods: users })
  }
  return out
}

function readManifest(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) return null
    const name = MANIFEST_NAME_RE.exec(m[1])?.[1]
    const desc = m[1].match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim() ?? ''
    const order = Number(m[1].match(/^order:\s*(\d+)\s*$/m)?.[1] ?? 0)
    return { description: desc || name || '', order: Number.isFinite(order) ? order : 0 }
  } catch { return null }
}

function readText(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim()
    return t ? t.slice(0, MAX_TEXT) : ''
  } catch { return '' }
}

/** 全量目录：官方 + 用户覆盖（用户层同名替换官方正文与描述）。 */
function fullCatalog() {
  const catalog = []
  for (const g of builtinGroups()) {
    const merged = new Map(g.methods.map((m) => [m.id, m]))
    for (const ug of userGroupsFor()) {
      if (ug.group !== g.group) continue
      for (const um of ug.methods) merged.set(um.id, { ...um })
    }
    catalog.push({ group: g.group, methods: [...merged.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)) })
  }
  return catalog
}

// ── profile / 组合 ──────────────────────────────────────────────────────────
const DEFAULT_ALL = catalogAllIds()
function catalogAllIds() {
  const out = {}
  for (const g of builtinGroups()) out[g.group] = g.methods.map((m) => m.id)
  return out
}

function profileFile(presetId) { return path.join(PROFILES_DIR, `${presetId}.json`) }

function readProfile(presetId) {
  try { return JSON.parse(fs.readFileSync(profileFile(presetId), 'utf8')) } catch { return null }
}
function writeProfile(presetId, data) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true })
  fs.writeFileSync(profileFile(presetId), JSON.stringify(data, null, 2), 'utf8')
}
function currentProfile(presetId) {
  const p = readProfile(presetId)
  if (p && Array.isArray(p.active)) return p
  // 默认：全启用（官方方法集即"开箱全开"，用户可关）
  const all = []
  for (const g of fullCatalog()) for (const m of g.methods) all.push(`${g.group}/${m.id}`)
  const def = { preset: presetId, active: all, combos: { '全部启用': all } }
  writeProfile(presetId, def)
  return def
}

/** 把 active（group/id 数组）渲染成按目录实际存在过滤后的正文拼装（按组分节，避免标题堆叠）。 */
function renderActive(presetId) {
  const profile = currentProfile(presetId)
  const catalog = fullCatalog()
  const byGroup = new Map()
  for (const g of catalog) {
    for (const m of g.methods) byGroup.set(`${g.group}/${m.id}`, { group: g.group, m })
  }
  const activeIds = (profile.active || []).filter((key) => byGroup.has(key))
  const groupOrder = []
  for (const key of activeIds) { const grp = key.split('/')[0]; if (!groupOrder.includes(grp)) groupOrder.push(grp) }
  const groupSeq = new Map(groupOrder.map((g, i) => [g, i + 1]))
  const parts = []
  let seq = 0
  for (const g of groupOrder) {
    const rows = []
    for (const key of activeIds) {
      if (key.split('/')[0] !== g) continue
      const { m } = byGroup.get(key)
      seq += 1
      const tag = m.origin === 'user' ? '（用户版）' : m.origin === 'custom' ? '（自定义）' : ''
      rows.push(`【方法 ${seq}】${m.id}${tag}（PATT 关联见正文）\n${m.prompt}`)
    }
    parts.push(`▍模块 ${groupSeq.get(g)}/${groupOrder.length} · ${g}\n${rows.join('\n\n')}`)
  }
  const text = parts.length ? `<saker-methods mode="${presetId}" rev="${profile.rev || 1}" count="${activeIds.length}">\n下面是本次启用的一组测试方法（每个含 目的→步骤→证据；按方法编号执行，方法之间按目标与证据自然衔接）：\n${parts.join('\n\n')}\n</saker-methods>` : ''
  return { rev: profile.rev || 1, active: activeIds, text, count: activeIds.length }
}

/** 用户"开场"（显示于官方 persona 之前）：~/.dsh/method-stack/opening/<preset>.md */
function openingDir() { return path.join(HOME_ROOT, 'opening') }
function openingText(presetId) {
  try { return fs.readFileSync(path.join(openingDir(), `${presetId}.md`), 'utf8').trim() } catch { return '' }
}
/** 官方开场来源：preset 包 agent.cordis.yml 中 persona 行段原文（透明展示用）。 */
function officialOpeningOf(presetId) {
  try {
    const req = createRequire(import.meta.url)
    const pkgRoot = path.dirname(req.resolve('dsh-saker/package.json'))
    const file = path.join(pkgRoot, 'preset', presetId, 'agent.cordis.yml')
    if (!fs.existsSync(file)) return { sourcePath: file, excerpt: '' }
    const raw = fs.readFileSync(file, 'utf8')
    const start = raw.indexOf('id: persona')
    if (start < 0) return { sourcePath: file, excerpt: '' }
    const next = raw.indexOf('\n- id:', start + 5)
    const seg = (next < 0 ? raw.slice(start) : raw.slice(start, next)).slice(0, 1500)
    return { sourcePath: file, excerpt: seg }
  } catch { return { sourcePath: '', excerpt: '' } }
}

function audit(presetId, action, detail) {
  try {
    fs.mkdirSync(HOME_ROOT, { recursive: true })
    fs.appendFileSync(AUDIT_LOG, `${new Date().toISOString()} | ${presetId} | ${action} | ${detail}\n`, 'utf8')
  } catch { /* 审计失败不阻塞 */ }
}

function ok(value) { return { ok: true, value } }
function failure(message) { return { ok: false, error: { code: 'method-stack', message: String(message), details: {} } } }

export function apply(ctx, config = {}) {
  const cfg = { enable: true, ...config }
  if (!cfg.enable) return
  console.log('[method-stack] apply begin (enable)')
  const { connection, systemPrompt } = ctx

  // 1) RPC：目录 / 组合读写（设置页「方法编排」用）
  if (!connection || typeof connection.rpc?.handle !== 'function') {
    ctx.logger?.warn?.('dsh-method-stack: connection service unavailable, RPC disabled')
  } else {
    connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
    try {
      const p = payload && typeof payload === 'object' ? payload : {}
      if (endpoint === 'list') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        const profile = currentProfile(presetId)
        const active = new Set(profile.active || [])
        const groups = fullCatalog().map((g) => ({
          group: g.group,
          methods: g.methods.map((m) => ({
            id: m.id, description: m.description, order: m.order, origin: m.origin,
            prompt: m.prompt,
            active: active.has(`${g.group}/${m.id}`),
            hasUser: userHasMethod(g.group, m.id),
          })),
        }))
        return ok({ presetId, groups, combos: profile.combos || {}, active: profile.active || [] })
      }
      if (endpoint === 'set-active') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        if (!Array.isArray(p.active)) return failure('active 需为数组（["group/id", ...]）')
        const profile = currentProfile(presetId)
        profile.active = p.active.filter((x) => typeof x === 'string' && x.includes('/') && ID_RE.test(x.split('/')[1]))
        profile.rev = (profile.rev || 1) + 1
        writeProfile(presetId, profile)
        audit(presetId, 'set-active', `${profile.active.length} methods`)
        return ok({ active: profile.active, rev: profile.rev })
      }
      if (endpoint === 'save-combo') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : ''
        if (!name) return failure('组合名不能为空')
        const profile = currentProfile(presetId)
        profile.combos = profile.combos || {}
        profile.combos[name] = Array.isArray(p.active) ? p.active : (profile.active || [])
        writeProfile(presetId, profile)
        audit(presetId, 'save-combo', name)
        return ok({ combos: profile.combos })
      }
      if (endpoint === 'use-combo') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        const name = typeof p.name === 'string' ? p.name : ''
        const profile = currentProfile(presetId)
        const combo = (profile.combos || {})[name]
        if (!combo) return failure('组合不存在：' + name)
        profile.active = combo
        profile.rev = (profile.rev || 1) + 1
        writeProfile(presetId, profile)
        audit(presetId, 'use-combo', name)
        return ok({ active: profile.active, rev: profile.rev })
      }
      // 用户方法克隆/还原：clone({presetId? group,id}) / restore({group,id})
      if (endpoint === 'clone') {
        const group = typeof p.group === 'string' ? p.group : ''
        const id = typeof p.id === 'string' ? p.id : ''
        const src = builtinMethodPath(group, id)
        if (!src) return failure('官方方法不存在')
        const dst = path.join(USER_METHODS_ROOT, group, id)
        fs.mkdirSync(dst, { recursive: true })
        fs.cpSync(src, dst, { recursive: true, force: true })
        audit('user', 'clone', `${group}/${id}`)
        return ok({ cloned: `${group}/${id}` })
      }
      if (endpoint === 'restore') {
        const group = typeof p.group === 'string' ? p.group : ''
        const id = typeof p.id === 'string' ? p.id : ''
        const dst = path.join(USER_METHODS_ROOT, group, id)
        if (!fs.existsSync(path.join(dst, 'prompt.md'))) return failure('用户方法不存在：' + `${group}/${id}`)
        fs.rmSync(dst, { recursive: true, force: true })
        audit('user', 'restore', `${group}/${id}`)
        return ok({ restored: `${group}/${id}` })
      }
      if (endpoint === 'render-preview') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        const rendered = renderActive(presetId)
        return ok({ count: rendered.count, chars: rendered.text.length, rev: rendered.rev })
      }
      if (endpoint === 'opening-get') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        return ok({ presetId, text: openingText(presetId) })
      }
      if (endpoint === 'opening-save') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        const text = typeof p.text === 'string' ? p.text.trim() : ''
        fs.mkdirSync(openingDir(), { recursive: true })
        if (!text) {
          try { fs.rmSync(path.join(openingDir(), `${presetId}.md`), { force: true }) } catch { /* ignore */ }
        } else {
          fs.writeFileSync(path.join(openingDir(), `${presetId}.md`), text, 'utf8')
        }
        audit('user', 'opening-save', presetId + (text ? ` (${text.length} chars)` : ' (cleared)'))
        return ok({ presetId, saved: true })
      }
      if (endpoint === 'opening-official') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        return ok(officialOpeningOf(presetId))
      }
      if (endpoint === 'save-prompt') {
        // 保存方法正文（透明编辑）：若用户层不存在则先自动克隆官方，再写 prompt.md。
        const group = typeof p.group === 'string' ? p.group : ''
        const id = typeof p.id === 'string' ? p.id : ''
        const text = typeof p.text === 'string' ? p.text.slice(0, MAX_TEXT) : ''
        const src = builtinMethodPath(group, id)
        if (!src) return failure('官方方法不存在：' + `${group}/${id}`)
        if (!text) return failure('正文不能为空')
        const dst = path.join(USER_METHODS_ROOT, group, id)
        if (!fs.existsSync(path.join(dst, 'prompt.md'))) {
          fs.mkdirSync(dst, { recursive: true })
          fs.cpSync(src, dst, { recursive: true, force: true })
        }
        fs.writeFileSync(path.join(dst, 'prompt.md'), text, 'utf8')
        audit('user', 'save-prompt', `${group}/${id} (${text.length} chars)`)
        return ok({ saved: `${group}/${id}`, cloned: true })
      }
      return failure('unknown endpoint: ' + endpoint)
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
  }, { authority: 'loopback' })
  }

  // 2) 每轮注入：把当前模式启用方法正文作为一段 context。
  //    复用 route-boost 姿势：context text 由 agent-loop 每轮重渲染。
  if (systemPrompt && typeof systemPrompt.context === 'function') {
    try {
      systemPrompt.context({
        name: 'saker-methods',
        order: 460,
        text: (assembly) => {
          const agent = assembly?.agent
          if (!agent) return ''
          let presetId = ''
          try { presetId = ctx.agentPresets.composedPreset(agent.ctx) } catch { /* ignore */ }
          if (!presetId) return ''
          const rendered = renderActive(presetId)
          return rendered.text // renderActive 已带 <saker-methods> 标签与分节
        },
      })
    } catch (error) {
      ctx.logger?.warn?.('dsh-method-stack: systemPrompt context registration failed: %s', String(error))
    }
  } else {
    ctx.logger?.warn?.('dsh-method-stack: systemPrompt unavailable, method injection disabled')
  }

  // 3) 用户"开场"：order -50（官方 persona order=0 之前）注册 section；
  //    有 ~/.dsh/method-stack/opening/<preset>.md 时注入，让"开头"可自定义。
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      systemPrompt.section({
        name: 'saker-opening',
        order: -50,
        text: (assembly) => {
          const agent = assembly?.agent
          if (!agent) return ''
          let presetId = ''
          try { presetId = ctx.agentPresets.composedPreset(agent.ctx) } catch { /* ignore */ }
          if (!presetId) return ''
          const text = openingText(presetId)
          return text ? `<user-opening mode="${presetId}">${text}</user-opening>` : ''
        },
      })
    } catch (error) {
      ctx.logger?.warn?.('dsh-method-stack: saker-opening section registration failed: %s', String(error))
    }
  }
  console.log('[method-stack] apply done')
}

function builtinMethodPath(group, id) {
  const p = path.join(BUILTIN_ROOT, group, id, 'prompt.md')
  return fs.existsSync(p) ? path.join(BUILTIN_ROOT, group, id) : ''
}
function userHasMethod(group, id) {
  return fs.existsSync(path.join(USER_METHODS_ROOT, group, id, 'prompt.md'))
}

// 导出供 headless 单测/文档（不参与运行时路径）。
export { renderActive, currentProfile, fullCatalog, builtinGroups, userHasMethod }

export { Config }
