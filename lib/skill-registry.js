import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['skills']

// The current web slash menu reads the host-wide registry, so Pentest's mode
// prompts must be registered here. CTF stays discoverable through its own
// preset filesystem but is deliberately omitted here to avoid leaking it into
// Pentest's new-session menu.
const roots = ['shared', 'preset/pentest']

function bundledSkills() {
  const skills = []
  for (const root of roots) {
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

export function apply(ctx) {
  const disposers = bundledSkills().map(skill => ctx.skills.register(skill))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

export { bundledSkills }
