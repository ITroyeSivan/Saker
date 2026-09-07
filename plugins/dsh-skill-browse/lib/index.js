// dsh-skill-browse — host.
// 扫描本 bundle 内的 SKILL.md（shared/skills/* 与 preset/*/skills/*），通过
// loopback RPC 提供给设置页「技能」面板。每个技能含 name / description /
// origin（shared / preset:<mode>）三件套。安装市场技能的能力留 `install-skill`
// 端点，初期返回 not-yet-implemented（提示用户到市场手工安装；不阻塞当前发布）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-skill-browse'
export const inject = ['connection']

const CHANNEL = '/dsh-skill-browse'

const Config = z.object({
  enable: z.boolean().default(true),
})

const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const SCAN_ROOTS = [
  { kind: 'shared', dir: path.join(BUNDLE_ROOT, 'shared', 'skills') },
  { kind: 'preset', dir: path.join(BUNDLE_ROOT, 'preset') },
]
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/
const NAME_RE = /^name:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*$/m
const DESC_RE = /^description:\s*(.+?)\s*$/m

function readSkillMd(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const fm = FRONTMATTER_RE.exec(text)
    if (!fm) return null
    const name = NAME_RE.exec(fm[1])?.[1]
    if (!name) return null
    const description = DESC_RE.exec(fm[1])?.[1] ?? ''
    return { name, description }
  } catch { return null }
}

function listSkills(presetId) {
  const out = []
  const seen = new Set()
  for (const root of SCAN_ROOTS) {
    let entries
    try { entries = fs.readdirSync(root.dir, { withFileTypes: true }) } catch { continue }
    if (root.kind === 'shared') {
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const meta = readSkillMd(path.join(root.dir, e.name, 'SKILL.md'))
        if (meta && !seen.has(meta.name)) { seen.add(meta.name); out.push({ ...meta, origin: 'shared' }) }
      }
    } else {
      for (const presetDir of entries) {
        if (!presetDir.isDirectory()) continue
        const mode = presetDir.name
        if (presetId && mode !== presetId) continue
        const skillsDir = path.join(root.dir, mode, 'skills')
        let skillEntries
        try { skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true }) } catch { continue }
        for (const e of skillEntries) {
          if (!e.isDirectory()) continue
          const meta = readSkillMd(path.join(skillsDir, e.name, 'SKILL.md'))
          if (meta && !seen.has(meta.name)) { seen.add(meta.name); out.push({ ...meta, origin: `preset:${mode}` }) }
        }
      }
    }
  }
  return out
}

function ok(value) { return { ok: true, value } }
function failure(message, code = 'skill-browse') { return { ok: false, error: { code, message: String(message), details: {} } } }

export function apply(ctx, config = {}) {
  const cfg = { enable: true, ...config }
  if (!cfg.enable) return
  const { connection } = ctx
  connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
    if (endpoint === 'list') {
      const presetId = payload && typeof payload.presetId === 'string' ? payload.presetId : ''
      return ok({ skills: listSkills(presetId) })
    }
    if (endpoint === 'install-skill') {
      // 市场安装能力依赖宿主层的 marketplace 集成；本版本先返 not-yet-implemented
      // 并提示用户到「市场」手工安装（不阻塞本期发布）。
      return ok({ installed: false, reason: '市场安装未在本版本提供——请到 marketplace 手工安装；安装后重启平台生效' })
    }
    return failure('unknown endpoint: ' + endpoint)
  }, { authority: 'loopback' })
}

export { Config }
