import assert from 'node:assert/strict'
import { apply, bundledSkills, presetSkills } from '../lib/skill-registry.js'

const bundled = bundledSkills()
const names = bundled.map(skill => skill.name)
for (const name of names) {
  assert(!name.startsWith('pentest-'), `${name} leaked into the global prompt registry`)
}
assert(!names.includes('ctf-playbook'), 'ctf-playbook leaked into the global prompt registry')
const pentestNames = presetSkills('pentest').map(skill => skill.name)
for (const name of ['pentest-playbook', 'pentest-regular', 'pentest-nday', 'pentest-0day']) {
  assert(pentestNames.includes(name), `${name} missing from the pentest preset layer`)
}
assert(!pentestNames.includes('ctf-playbook'), 'ctf-playbook leaked into the pentest preset layer')
assert(!pentestNames.includes('pentest-campaign'), 'legacy campaign is a route alias, not a fourth mode')
assert.equal(new Set(names).size, names.length, 'duplicate shared skill names')
const registered = new Map()
const dispose = apply({ skills: { register(skill) {
  assert(!registered.has(skill.name), `duplicate registration ${skill.name}`)
  registered.set(skill.name, skill)
  return () => registered.delete(skill.name)
} } })
const prompt = registered.get(names[0])
assert(prompt, 'shared skill body unavailable')
assert.equal(prompt.resourceBase.kind, 'directory')
assert(prompt.path.endsWith('SKILL.md'))
dispose()
assert.equal(registered.size, 0, 'skill registrations not disposed')
console.log(`ok prompt skills registered ${names.length}, CTF stays out of the global menu`)
