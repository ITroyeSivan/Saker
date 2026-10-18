
// ── 平台数据根（$DSH_HOME）────────────────────────────────────────────
// 宿主按 $DSH_HOME 装配 profiles/会话/存储；插件一律跟随，避免「一半落 A 一半落 B」。
// 未设置时等价于 ~/.dsh，故对既有用户是零行为变更。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
// dsh-method-stack — host.
// 提示词"方法"化：把可切换的测试逻辑组织成 模块组(group)→子方法(method) 两级。
// 模型侧：注册固定 systemPrompt context（order 460，位于 route-boost 500 之前），
// Web 会话只提供当前任务的简短模块目录，正文通过 saker_method 按需读取。
// 其他预设沿用原有组合；模块筛选不能改变任务范围、预算和确认要求。
// 自定义：官方默认方法集随本插件 methods/（只读，可克隆到用户层）；用户层
// ~/.dsh/methods/<group>/<id>/ 同名 shadow 官方（与宿主 scoped section 同构思想）。
// 组合持久化：~/.dsh/method-stack/profiles/<presetId>.json（默认组合+自定义组合）。
// 追溯：组合内容变化递增 rev，追加 ~/.dsh/method-stack/audit.log（时间/模式/组合/rev）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { webCatalog, webSelection, saveWebSelection } from './web-selection.js'
import { methodCatalogEntries } from './selection-config.js'
import { TEST_CONTENT_KEYS, TEST_CONTENT_ITEMS, LEGACY_METHOD_TO_CONTENT, testContentCatalog } from '@dsh-external/dsh-redteam-results/test-catalog'
import { openStore } from '@dsh-external/dsh-redteam-results/store'
import { stageMethodClassification, readMethodClassification, listMethodClassifications, methodModuleRequirement, builtinMethodClassification, methodFingerprint } from '@dsh-external/dsh-redteam-results/method-classification'

export const name = 'dsh-method-stack'
// webServer 必须显式声明：宿主 0.1.5-rc.1 起 connection 服务自身不再 inject webServer，
// connection.rpc.handle 内部改用**调用方**的 owner.webServer（packages/client/connection
// 第 617 行 `owner.effect(() => owner.webServer.register(route))`）。0.1.3-alpha.2 时
// connection 自己声明了它，所以旧代码不需要；0.1.5 不声明即抛
// `cannot get property "webServer" without inject`。
export const inject = ['connection', 'systemPrompt', 'agentPresets', 'webServer', 'tools', 'sessions']

const CHANNEL = '/dsh-method-stack'
const Config = z.object({ enable: z.boolean().default(true) })

// 随包默认方法集（只读；克隆后进用户层编辑）。目录每项含 manifest.yml + prompt.md。
const BUILTIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'methods')
const HOME_ROOT = path.join(DSH_HOME, 'method-stack')
const USER_METHODS_ROOT = path.join(HOME_ROOT, 'methods')
const PROFILES_DIR = path.join(HOME_ROOT, 'profiles')
const AUDIT_LOG = path.join(HOME_ROOT, 'audit.log')
const GROUP_ORDER = ['recon', 'exploit', 'evidence', 'report', 'intranet']
const PRESET_IDS = new Set(['pentest', 'code-audit', 'ctf-solver'])
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_TEXT = 6000 // 单个方法正文截断保护
const MAX_OPENING_TEXT = 65536
const MANIFEST_NAME_RE = /^name:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*$/m

// fs.cpSync crashes Node 22 on Windows paths containing non-ASCII characters.
// Method trees only contain ordinary files and directories, so copy them
// explicitly and reject links/special entries instead of following them.
function copyMethodTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dst, entry.name)
    if (entry.isDirectory()) copyMethodTree(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
    else throw new Error(`不支持复制的方法目录项：${entry.name}`)
  }
}

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
// 方法目录缓存：fullCatalog() 会遍历内置/用户两层目录并逐个 readFileSync，
// 而它被**每轮注入的 context 回调**调用（实测 8.5ms/回合，纯浪费）。
// 目录只在用户改方法正文时才变 → 60s TTL + 保存路径显式失效（save-prompt 之后立刻重建）。
let catalogCache = { at: 0, value: null }
const CATALOG_TTL_MS = 60 * 1000
function invalidateCatalog() {
  catalogCache = { at: 0, value: null }
}
function fullCatalog({ fresh = false } = {}) {
  const now = Date.now()
  if (!fresh && catalogCache.value && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value
  const catalog = []
  for (const g of builtinGroups()) {
    const merged = new Map(g.methods.map((m) => [m.id, m]))
    for (const ug of userGroupsFor()) {
      if (ug.group !== g.group) continue
      for (const um of ug.methods) merged.set(um.id, { ...um })
    }
    catalog.push({ group: g.group, methods: [...merged.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)) })
  }
  catalogCache = { at: now, value: catalog }
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
  // 原子写：半截 JSON 会让 readProfile 返回 null → currentProfile 回退到「全启用」，
  // 用户刚勾好的方法选择**静默消失**（且没有任何报错）。临时文件 + rename 消除这个窗口。
  const file = profileFile(presetId)
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}
function currentProfile(presetId) {
  const p = readProfile(presetId)
  if (p && Array.isArray(p.active)) return p
  // 方法默认关闭；由会话配置显式启用。
  //
  // 为什么改（原来是「开箱全开」）：方法正文是**每轮请求常驻注入**的 systemPrompt context ——
  // 26 个方法全文 ≈ 14KB（约 4–5K token），在 32K 窗口的模型上直接吃掉 15%，
  // 实测出现过 `CONTEXT_WINDOW_EXCEEDED: request (38341 tokens) size (32768 tokens)`。
  // 而多数轮次只用得上其中一两个方法，「默认全开」等于让所有会话替这个默认值付上下文成本。
  // 改为按需勾选；仍保留「全部启用」组合，想全开的人一键即可（UI 里也有该快捷）。
  const all = []
  for (const g of fullCatalog()) for (const m of g.methods) all.push(`${g.group}/${m.id}`)
  // Pentest 的新默认是 17 项测试内容全选（由 test-catalog 声明）；模型再按当前问题挑相关的。
  // 其他预设保留原来的“默认关闭、按需启用”语义。
  const def = presetId === 'pentest'
    ? { preset: presetId, active: [...TEST_CONTENT_KEYS], combos: { '全部启用': [...TEST_CONTENT_KEYS] } }
    : { preset: presetId, active: [], combos: { '全部启用': all } }
  writeProfile(presetId, def)
  return def
}

/** 稳定测试内容 ID → 目录条目；旧 group/id 键也接受（迁移期 UI）。 */
function contentByKey(key) {
  const id = TEST_CONTENT_KEYS.includes(key) ? key : LEGACY_METHOD_TO_CONTENT[key]
  return id ? TEST_CONTENT_ITEMS.find(item => item.id === id) : null;
}
const contentGroup = item => TEST_CONTENT_ITEMS.includes(item)
  ? (item.group === 'recon' ? '信息收集' : 'Web 检查') : '';

/** 把 active（group/id 数组）渲染成按目录实际存在过滤后的正文拼装（按组分节，避免标题堆叠）。 */
function renderActive(presetId, { compact = false, selection } = {}) {
  const profile = currentProfile(presetId)
  if (presetId === 'pentest') {
    const activeIds = (selection?.active || profile.active || []).map(key => contentByKey(key)).filter(Boolean).map(item => item.id)
    const unique = [...new Set(activeIds)]
    if (!unique.length) return { rev: profile.rev || 1, active: unique, count: 0, text: '' }
    if (compact) {
      const groups = new Map();
      for (const id of unique) { const item = contentByKey(id); const g = contentGroup(item); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(item); }
      const listed = [...groups.entries()].map(([g, items]) => g + '：' + items.map(i => i.label).join('、')).join('\n');
      return { rev: profile.rev || 1, active: unique, count: unique.length,
        text: `<saker-methods mode="${selection?.mode || presetId}" rev="${selection?.rev || profile.rev || 1}" count="${unique.length}">\n当前允许的测试内容（由用户设置；knowledge_search 定位、knowledge_read 精读，不要依次全读；全选=允许按需采用，不等于逐项扫描）：\n${listed}\n</saker-methods>` }
    }
    const groups = new Map();
    for (const id of unique) { const item = contentByKey(id); const g = contentGroup(item); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(item); }
    const body = [...groups.entries()].map(([g, items]) => g + '：\n' + items.map(i => '· ' + i.label + '（' + i.id + '）——' + i.purpose).join('\n')).join('\n\n');
    return { rev: profile.rev || 1, active: unique, count: unique.length,
      text: `<saker-methods mode="${presetId}" rev="${profile.rev || 1}" count="${unique.length}">\n当前允许的测试内容（按具体问题选用；全选=允许按需采用，不等于逐项扫描）：\n${body}\n</saker-methods>` }
  }
  const catalog = fullCatalog()
  const byGroup = new Map()
  for (const g of catalog) {
    for (const m of g.methods) byGroup.set(`${g.group}/${m.id}`, { group: g.group, m })
  }
  const activeIds = (selection?.active || profile.active || []).filter((key) => byGroup.has(key))
  if (compact && activeIds.length) return { rev: profile.rev || 1, active: activeIds, count: activeIds.length,
    // 常驻只留目录本身：怎么读正文、怎么找资料、证据要求都已在 saker_method/knowledge_* 的工具描述与
    // 模式 skill 里，重复一遍就是每轮白付。保留"全选=允许按需采用"这条容易误解的语义。
    text: `<saker-methods mode="${selection?.mode || presetId}" rev="${selection?.rev || profile.rev || 1}" count="${activeIds.length}">\n当前允许的Web测试方向（saker_method read 按需读正文；knowledge_search 定位、knowledge_read 精读，不要依次全读；全选=允许按需采用，不等于逐项扫描）：\n${activeIds.slice(0, 24).map(key => key + ': ' + String(byGroup.get(key).m.description || '').slice(0, 100)).join('\n')}${activeIds.length > 24 ? '\n其余方法用saker_method list offset=24查询。' : ''}\n</saker-methods>` }
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

/** 用户模式开场：~/.dsh/method-stack/opening/<preset>.custom.md */
function openingDir() { return path.join(HOME_ROOT, 'opening') }
function openingPath(presetId) { return path.join(openingDir(), `${presetId}.custom.md`) }
function legacyOpeningPath(presetId) { return path.join(openingDir(), `${presetId}.md`) }
function readTextFile(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}
function sakerPackageRoot() {
  const req = createRequire(import.meta.url)
  try { return path.dirname(req.resolve('dsh-saker/package.json')) } catch {
    // Development checkout: plugins/dsh-method-stack/lib -> repository root.
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  }
}
/** 随包默认开场文本；每种模式由独立 opening.md 管理，用户可直接覆盖。 */
function officialOpeningOf(presetId) {
  try {
    if (!PRESET_IDS.has(presetId)) return { sourcePath: '', excerpt: '', text: '' }
    const file = path.join(sakerPackageRoot(), 'preset', presetId, 'opening.md')
    const text = readTextFile(file)
    return { sourcePath: file, excerpt: text, text }
  } catch { return { sourcePath: '', excerpt: '', text: '' } }
}
function openingInfo(presetId) {
  const official = officialOpeningOf(presetId)
  const customFile = openingPath(presetId)
  if (fs.existsSync(customFile)) {
    return { presetId, text: readTextFile(customFile), isCustom: true, migrated: false, sourcePath: official.sourcePath }
  }
  // Earlier versions stored an additive snippet in <preset>.md. Preserve it
  // as an addition to the default until the user saves or restores this editor.
  const legacy = readTextFile(legacyOpeningPath(presetId)).trim()
  if (legacy) {
    const text = [official.text.trimEnd(), legacy].filter(Boolean).join('\n\n')
    return { presetId, text, isCustom: true, migrated: true, sourcePath: official.sourcePath }
  }
  return { presetId, text: official.text, isCustom: false, migrated: false, sourcePath: official.sourcePath }
}
function openingText(presetId) {
  if (!PRESET_IDS.has(presetId)) return ''
  return openingInfo(presetId).text
}

function audit(presetId, action, detail) {
  try {
    fs.mkdirSync(HOME_ROOT, { recursive: true })
    fs.appendFileSync(AUDIT_LOG, `${new Date().toISOString()} | ${presetId} | ${action} | ${detail}\n`, 'utf8')
  } catch { /* 审计失败不阻塞 */ }
}

function ok(value) { return { ok: true, value } }
function failure(message, code = 'method-stack', details = {}) { return { ok: false, error: { code, message: String(message), details } } }

/** 分类读写只碰离线元数据；不开长事务，也不执行任何请求。 */
function withClassificationStore(work) {
  const store = openStore(path.join(DSH_HOME, 'redteam-results', 'results.db'))
  try { return work(store) } finally { store.close() }
}

/**
 * 内置目录映射是**确定**的（目录键即模块键），程序负责把它写进分类表。
 * 幂等：已存在的 (id,version,digest,revision) 直接跳过；失败不阻断插件装载。
 */
function stageBuiltinClassifications() {
  return withClassificationStore((store) => {
    const entries = methodCatalogEntries(DSH_HOME)
    let staged = 0
    for (const entry of Object.values(entries)) {
      const record = builtinMethodClassification(entry)
      if (readMethodClassification(store, record.id, record.version, record.digest, record.revision)) continue
      stageMethodClassification(store, record)
      staged += 1
    }
    return { catalog: Object.keys(entries).length, staged }
  })
}

/** 覆盖写用户文本前保留的份数上限。 */
const BACKUP_KEEP = 5

/**
 * 覆盖写之前先留一份旧内容，返回备份路径（文件原本不存在时返回空串）。
 *
 * 为什么：`save-prompt` / `opening-save` 直接 `writeFileSync` 到用户目录 ——
 * 用户改自己写的方法正文或开场文本，保存一下就永久覆盖上一版，没有回退手段。
 * 备份放 `.backups/`：点开头不会被当成方法/开场文件读取；每个文件最多留 BACKUP_KEEP 份。
 */
function backupFile(target, backupDir) {
  if (!fs.existsSync(target)) return ''
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

export function apply(ctx, config = {}) {
  const cfg = { enable: true, ...config }
  if (!cfg.enable) return
  console.log('[method-stack] apply begin (enable)')
  const { connection, systemPrompt } = ctx
  // 内置分类在装载时落地：执行闸要按它判断"用户关掉的模块"。失败只降级，不阻断插件。
  try { console.log('[method-stack] builtin classifications', JSON.stringify(stageBuiltinClassifications())) }
  catch (error) { ctx.logger?.warn?.('dsh-method-stack: 内置方法分类未能写入（执行闸会按未分类拒绝）：' + String(error && error.message ? error.message : error)) }
  function selectionFor(sessionId) {
    return webSelection(DSH_HOME, sessionId, fullCatalog(), currentProfile('pentest').webDefaults)
  }
  function renderedFor(presetId, agent) {
    if (presetId !== 'pentest') return renderActive(presetId)
    const selection = selectionFor(agent?.session?.id || 'unbound-preview')
    if (!selection.available) return { ...selection, count: 0, text: '' }
    const rendered = renderActive(presetId, { compact: true, selection })
    if (!rendered.count) rendered.text = '<saker-methods>用户已关闭所有Web测试模块。不要主动展开模块测试；可整理已有资料并回应用户明确提出的问题。证据与独立复核要求仍然有效。</saker-methods>'
    return { ...rendered, rev: selection.rev }
  }
  ctx.tools.register(defineTool({
    name: 'saker_method', description: '读取当前启用的测试方法，按具体问题选用；不执行请求。',
    parameters: { action: { type: 'string', enum: ['list', 'read'], required: true }, key: { type: 'string', description: 'read: group/id' }, offset: { type: 'integer', description: 'list偏移，默认0' } },
    output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) {
      try {
        const presetId = ctx.agentPresets.composedPreset(exec.agent.ctx);
        if (!PRESET_IDS.has(presetId)) throw new Error('仅安全测试会话可读取方法');
        const rendered = renderedFor(presetId, exec.agent), catalog = new Map(fullCatalog().flatMap(group => group.methods.map(method => [group.group + '/' + method.id, method])));
        if (args.action === 'read') {
          if (!rendered.active.includes(args.key)) throw new Error('当前组合未启用此测试内容');
          if (presetId === 'pentest') {
            const item = contentByKey(args.key);
            if (!item) throw new Error('测试内容不存在：' + args.key);
            return Promise.resolve({ ok: true, key: item.id, rev: rendered.rev, label: item.label,
              prompt: item.purpose || '本版本不为该测试内容维护单独正文，直接按当前问题选择检查方式。', truncated: false });
          }
          const method = catalog.get(args.key);
          return Promise.resolve({ ok: true, key: args.key, rev: rendered.rev, origin: method.origin, prompt: method.prompt.slice(0, MAX_TEXT), truncated: method.prompt.length > MAX_TEXT });
        }
        if (args.action !== 'list' || !Number.isInteger(args.offset ?? 0) || (args.offset ?? 0) < 0) throw new Error('invalid method query');
        const offset = args.offset ?? 0;
        const describe = key => presetId === 'pentest'
          ? (contentByKey(key)?.purpose || '')
          : (catalog.get(key)?.description || '');
        return Promise.resolve({ ok: true, total: rendered.count, offset, items: rendered.active.slice(offset, offset + 24).map(key => ({ key, description: describe(key) })), more: Math.max(0, rendered.count - offset - 24) });
      } catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
    }
  }));

  // 1) RPC：目录 / 组合读写（设置页「方法编排」用）
  if (!connection || typeof connection.rpc?.handle !== 'function') {
    ctx.logger?.warn?.('dsh-method-stack: connection service unavailable, RPC disabled')
  } else {
    // 宿主 0.1.5-rc.1 起 connection.rpc.handle 内部改用 owner.webServer 注册路由
    // （packages/client/connection `owner.effect(() => owner.webServer.register(route))`）。
    // 若 webServer 未能注入到本插件上下文，会抛 cannot get property "webServer" without inject，
    // 且**插件加载会整体失败**（而非仅 RPC 不可用）。这里捕获降级：RPC 关闭，其余功能不受影响。
    try {
    connection.register(ctx, CHANNEL, async (endpoint, payload) => {
    try {
      const p = payload && typeof payload === 'object' ? payload : {}
      if (endpoint === 'session-list' || endpoint === 'session-set') {
        if (typeof p.sessionId !== 'string' || !p.sessionId.trim()) return failure('请选择会话')
        const session = ctx.sessions.get(p.sessionId)
        if (!session) return failure('会话不存在，请重新选择')
        if (session.header?.agentPreset !== 'pentest') return failure('仅 Web 测试会话可设置测试模块')
        const catalog = fullCatalog()
        const defaults = currentProfile('pentest').webDefaults
        const selection = endpoint === 'session-set'
          ? saveWebSelection(DSH_HOME, p.sessionId, p.mode, p.active, p.rev, catalog, defaults, p.policyRev)
          : selectionFor(p.sessionId)
        // 后台键已是 test-catalog 的稳定 ID，界面不再拼接 group 前缀。
        return ok({ ...selection, groups: webCatalog(catalog).map(group => ({ group: group.group, methods: group.methods.map(method => ({
          id: method.id, label: method.label, description: method.description, active: selection.active.includes(method.id)
        })) })) })
      }
      if (endpoint === 'list') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        const profile = currentProfile(presetId)
        const catalog = presetId === 'pentest' ? webCatalog(fullCatalog()) : fullCatalog()
        const active = new Set(presetId === 'pentest' ? profile.webDefaults ?? catalog.flatMap(g => g.methods.map(m => g.group + '/' + m.id)) : profile.active || [])
        const groups = catalog.map((g) => ({
          group: g.group,
          methods: g.methods.map((m) => ({
            id: m.id, description: m.description, order: m.order, origin: m.origin,
            prompt: m.prompt,
            active: active.has(`${g.group}/${m.id}`),
            hasUser: userHasMethod(g.group, m.id),
          })),
        }))
        return ok({ presetId, groups, combos: profile.combos || {}, active: [...active] })
      }
      if (endpoint === 'set-active') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        if (!Array.isArray(p.active)) return failure('active 需为数组（["sqli", ...]）')
        const profile = currentProfile(presetId)
        // 稳定测试内容 ID 直接接受；旧 "group/id" 方法键仍兼容（迁移期 UI）。
        profile.active = p.active.filter((x) => typeof x === 'string'
          && (TEST_CONTENT_KEYS.includes(x) || (x.includes('/') && ID_RE.test(x.split('/')[1]))))
        if (presetId === 'pentest') profile.webDefaults = profile.active.filter(key => webCatalog(fullCatalog()).some(g => g.methods.some(m => m.id === key)))
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
        if (presetId === 'pentest') profile.webDefaults = combo.filter(key => webCatalog(fullCatalog()).some(g => g.methods.some(m => m.id === key)))
        profile.rev = (profile.rev || 1) + 1
        writeProfile(presetId, profile)
        audit(presetId, 'use-combo', name)
        return ok({ active: profile.active, rev: profile.rev })
      }
      // 删除组合：save-combo 的反操作。此前只能建不能删，误存一个组合就永久留在设置页，
      // 只能手改 profile JSON 才能去掉（2026-09-12 浏览器验收发现）。
      // 不改 rev：rev 是「启用集」的版本，组合定义变化不影响注入正文。
      if (endpoint === 'delete-combo') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        const name = typeof p.name === 'string' ? p.name.trim() : ''
        if (!name) return failure('组合名不能为空')
        const profile = currentProfile(presetId)
        if (!profile.combos || !Object.prototype.hasOwnProperty.call(profile.combos, name)) {
          return failure('组合不存在：' + name)
        }
        delete profile.combos[name]
        writeProfile(presetId, profile)
        audit(presetId, 'delete-combo', name)
        return ok({ combos: profile.combos })
      }
      // 用户方法克隆/还原：clone({presetId? group,id}) / restore({group,id})
      if (endpoint === 'clone') {
        const group = typeof p.group === 'string' ? p.group : ''
        const id = typeof p.id === 'string' ? p.id : ''
        const src = builtinMethodPath(group, id)
        if (!src) return failure('官方方法不存在')
        const dst = path.join(USER_METHODS_ROOT, group, id)
        fs.mkdirSync(dst, { recursive: true })
        copyMethodTree(src, dst)
        invalidateCatalog()
        audit('user', 'clone', `${group}/${id}`)
        return ok({ cloned: `${group}/${id}` })
      }
      if (endpoint === 'restore') {
        const group = typeof p.group === 'string' ? p.group : ''
        const id = typeof p.id === 'string' ? p.id : ''
        const dst = path.join(USER_METHODS_ROOT, group, id)
        if (!fs.existsSync(path.join(dst, 'prompt.md'))) return failure('用户方法不存在：' + `${group}/${id}`)
        // 不直接 rm：用户层那份是**用户自己改过的正文**，删掉就永久没了。
        // 同卷 rename 进 methods/.trash/，点开头不会被当成方法读，可人工找回。
        const trashRoot = path.join(USER_METHODS_ROOT, '.trash')
        fs.mkdirSync(trashRoot, { recursive: true })
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17) + '-' + Math.random().toString(36).slice(2, 8)
        const trash = path.join(trashRoot, `${group}__${id}.${stamp}`)
        fs.renameSync(dst, trash)
        invalidateCatalog()
        audit('user', 'restore', `${group}/${id} trash=${path.basename(trash)}`)
        return ok({ restored: `${group}/${id}`, trash })
      }
      if (endpoint === 'render-preview') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        const rendered = presetId === 'pentest' ? renderActive(presetId, { compact: true, selection: { active: currentProfile(presetId).webDefaults ?? webCatalog(fullCatalog()).flatMap(g => g.methods.map(m => m.id)) } }) : renderActive(presetId)
        return ok({ count: rendered.count, chars: rendered.text.length, rev: rendered.rev })
      }
      if (endpoint === 'opening-get') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        if (!PRESET_IDS.has(presetId)) return failure('未知模式：' + presetId)
        return ok(openingInfo(presetId))
      }
      if (endpoint === 'opening-save') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        if (!PRESET_IDS.has(presetId)) return failure('未知模式：' + presetId)
        if (typeof p.text !== 'string') return failure('开场内容必须是文本')
        const text = p.text
        if (text.length > MAX_OPENING_TEXT) return failure(`开场不能超过 ${MAX_OPENING_TEXT} 个字符`)
        fs.mkdirSync(openingDir(), { recursive: true })
        const openingFile = openingPath(presetId)
        // Keep a recoverable copy before replacing a full mode opening.
        const backup = backupFile(openingFile, path.join(openingDir(), '.backups'))
        fs.writeFileSync(openingFile, text, 'utf8')
        audit('user', 'opening-save', `${presetId} (${text.length} chars)`)
        return ok({ ...openingInfo(presetId), saved: true, backup })
      }
      if (endpoint === 'opening-reset') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        if (!PRESET_IDS.has(presetId)) return failure('未知模式：' + presetId)
        const backups = []
        for (const file of [openingPath(presetId), legacyOpeningPath(presetId)]) {
          if (!fs.existsSync(file)) continue
          const backup = backupFile(file, path.join(openingDir(), '.backups'))
          if (backup) backups.push(backup)
          fs.rmSync(file, { force: true })
        }
        audit('user', 'opening-reset', presetId)
        return ok({ ...openingInfo(presetId), reset: true, backups })
      }
      if (endpoint === 'opening-official') {
        const presetId = typeof p.presetId === 'string' && p.presetId ? p.presetId : 'pentest'
        if (!PRESET_IDS.has(presetId)) return failure('未知模式：' + presetId)
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
        const userPrompt = path.join(dst, 'prompt.md')
        // 先记下"用户层是否本来就有正文"：没有的话接下来是从官方克隆出来的，
        // 那份不是用户写过的东西，不该产生备份。
        const hadOwn = fs.existsSync(userPrompt)
        if (!hadOwn) {
          fs.mkdirSync(dst, { recursive: true })
          copyMethodTree(src, dst)
        }
        // 覆盖用户已有正文前先备份（首次克隆官方时不产生备份，因为没有用户旧版可丢）
        const backup = hadOwn ? backupFile(userPrompt, path.join(USER_METHODS_ROOT, '.backups')) : ''
        fs.writeFileSync(userPrompt, text, 'utf8')
        invalidateCatalog()
        audit('user', 'save-prompt', `${group}/${id} (${text.length} chars)`)
        return ok({ saved: `${group}/${id}`, cloned: true, backup })
      }
      // 方法分类：把"这个方法需要哪些模块"记成版本化记录。
      // 只读写离线元数据（不执行请求、不读远端正文）；执行侧接线在后续卡。
      if (endpoint === 'classification-save' || endpoint === 'classification-list' || endpoint === 'classification-get') {
        return withClassificationStore((store) => {
          if (endpoint === 'classification-list') return ok(listMethodClassifications(store, Number.isInteger(p.offset) ? p.offset : 0))
          const group = typeof p.group === 'string' ? p.group : ''
          const id = typeof p.id === 'string' ? p.id : ''
          // 指纹必须与装载时写入内置分类用的**同一份原始条目**一致（原始正文 + 原始 manifest），
          // 否则同一方法会算出两个摘要，读回就变成"未分类"。
          const entries = methodCatalogEntries(DSH_HOME)
          const entry = entries[group + '/' + id] ?? null
          if (!entry) return failure('方法不存在：' + group + '/' + id)
          const fingerprint = methodFingerprint(entry)
          if (endpoint === 'classification-get') {
            return ok({ fingerprint, requirement: methodModuleRequirement(store, fingerprint, { knownModules: Object.keys(entries) }),
              record: readMethodClassification(store, fingerprint.id, fingerprint.version, fingerprint.digest) })
          }
          // 不带 modules/status/source 时给出内置确定映射（目录键即模块键，status=verified）。
          const explicit = p.modules !== undefined || p.status !== undefined || p.source !== undefined
          const requested = explicit
            ? { schema: 'saker.method-classification/1', ...fingerprint, revision: Number.isInteger(p.revision) ? p.revision : 1,
                modules: p.modules, status: p.status, source: p.source, reason: p.reason, notes: p.notes }
            : builtinMethodClassification(entry)
          return ok({ fingerprint, record: stageMethodClassification(store, requested) })
        })
      }
      return failure('unknown endpoint: ' + endpoint)
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), error.code || 'method-stack', error.details || {})
    }
  }, { authority: 'loopback' })
    } catch (error) {
      ctx.logger?.warn?.('dsh-method-stack: RPC unavailable（设置页「方法编排」不可用，其余功能正常）: ' + String(error && error.message ? error.message : error))
    }
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
          const rendered = renderedFor(presetId, agent)
          return rendered.text // renderActive 已带 <saker-methods> 标签与分节
        },
      })
    } catch (error) {
      ctx.logger?.warn?.('dsh-method-stack: systemPrompt context registration failed: %s', String(error))
    }
  } else {
    ctx.logger?.warn?.('dsh-method-stack: systemPrompt unavailable, method injection disabled')
  }

  // 3) 当前模式的完整开场由 settings 中的 opening.md 默认稿或用户稿提供。
  //    preset persona 槽位在 Saker 模式内留空，避免默认稿与自定义稿叠加。
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      systemPrompt.section({
        name: 'saker-mode-opening',
        order: -50,
        text: (assembly) => {
          const agent = assembly?.agent
          if (!agent) return ''
          let presetId = ''
          try { presetId = ctx.agentPresets.composedPreset(agent.ctx) } catch { /* ignore */ }
          if (!presetId) return ''
          return openingText(presetId)
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
