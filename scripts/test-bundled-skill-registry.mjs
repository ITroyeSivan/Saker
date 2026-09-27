import assert from 'node:assert/strict'
import { apply, bundledSkills } from '../lib/skill-registry.js'

const bundled = bundledSkills()
const names = bundled.map(skill => skill.name)
for (const name of ['browser-recon', 'audit-playbook', 'pentest-playbook', 'pentest-regular', 'pentest-nday', 'pentest-0day']) {
  assert(names.includes(name), `${name} missing from the global prompt registry`)
}
assert(!names.includes('ctf-playbook'), 'ctf-playbook leaked into the global prompt registry')
assert.equal(new Set(names).size, names.length, 'duplicate skill names')
const registered = new Map()
const dispose = apply({ skills: { register(skill) {
  assert(!registered.has(skill.name), `duplicate registration ${skill.name}`)
  registered.set(skill.name, skill)
  return () => registered.delete(skill.name)
} } })
const prompt = registered.get('pentest-nday')
assert(prompt?.content.includes('Nday'), 'pentest-nday body unavailable')
assert.equal(prompt.resourceBase.kind, 'directory')
assert(prompt.path.endsWith('SKILL.md'))
dispose()
assert.equal(registered.size, 0, 'skill registrations not disposed')
console.log(`ok prompt skills registered ${names.length}, CTF stays out of the global menu`)
