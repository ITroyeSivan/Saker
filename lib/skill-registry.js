import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['skills']

// Mode-specific skills belong to each preset's skill-filesystem layer. The
// host-wide registry only carries resources shared by every Saker scene;
// registering preset/pentest here leaked penetration skills into CTF.
const roots = ['shared']

function readBundledRoots(inputRoots) {
  const skills = []
  for (const root of inputRoots) {
    const dir = fileURLToPath(new URL(`../${root}/skills/`, import.meta.url))
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillDir = join(dir, entry.name)
      const path = join(skillDir, 'SKILL.md')
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf8')
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
      if (!match) throw new Error(`invalid skill frontmatter: ${path}`)
      const fields = Object.fromEntries(match[1].split(/\r?\n/).map(line => /^([a-zA-Z]+):\s*(.+)$/.exec(line)).filter(Boolean).map(([, key, value]) => [key, value.startsWith('"') ? JSON.parse(value) : value]))
      if (typeof fields.name !== 'string' || typeof fields.description !== 'string') {
        throw new Error(`skill requires name and description: ${path}`)
      }
      skills.push({
        name: fields.name,
        description: fields.description,
        content: match[2].trim(),
        path,
        source: 'bundled',
        provider: 'saker-bundled',
        resourceBase: { kind: 'directory', path: skillDir },
      })
    }
  }
  return skills
}

export function bundledSkills() {
  return readBundledRoots(roots)
}

export function presetSkills(presetId) {
  return presetId ? readBundledRoots([`preset/${presetId}`]) : []
}

export function apply(ctx) {
  const disposers = bundledSkills().map(skill => ctx.skills.register(skill))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
