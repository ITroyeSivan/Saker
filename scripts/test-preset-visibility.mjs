import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPresetVisibility } from '../lib/preset-visibility.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const defaults = createPresetVisibility('')
assert.ok(defaults.isVisible({ id: 'pentest' }))
assert.ok(defaults.isVisible({ id: 'code-audit' }))
assert.ok(defaults.isVisible({ id: 'standard' }))
assert.ok(!defaults.isVisible({ id: 'ctf-solver' }), 'CTF must stay out of new-session choices by default')
assert.equal(defaults.canResolve('ctf-solver'), true, 'old CTF sessions must keep resolving')
assert.equal(defaults.canResolve('unknown'), false)

const optedIn = createPresetVisibility('ctf-solver')
assert.ok(optedIn.isVisible({ id: 'ctf-solver' }), 'explicit opt-in must expose CTF for new sessions')
assert.equal(optedIn.canResolve('ctf-solver'), true)

const pentestPatch = readFileSync(join(ROOT, 'preset/pentest/agent.patch.yml'), 'utf8')
const pentestCordis = readFileSync(join(ROOT, 'preset/pentest/agent.cordis.yml'), 'utf8')
const pentestOpening = readFileSync(join(ROOT, 'preset/pentest/opening.md'), 'utf8')
assert.match(pentestPatch, /^\s*prefix: ''$/m, 'Pentest persona slot must be owned by the editable mode opening')
assert.match(pentestCordis, /^\s*prefix: ''$/m, 'Pentest declarative persona slot must stay empty')
assert.ok(!pentestOpening.includes('ask_user_question'), 'Pentest persona must not inject an interactive question step')
assert.ok(pentestOpening.includes('Never ask a follow-up question') && pentestOpening.includes('scope_missing'), 'Pentest must stop cleanly when scope is missing')
for (const mode of ['pentest-regular', 'pentest-nday', 'pentest-campaign', 'pentest-0day']) {
  assert.ok(pentestOpening.includes(mode), `editable persona must point to ${mode}`)
}

console.log('ok   默认新会话突出渗透与代码审计，CTF 不抢主线')
console.log('ok   隐藏 CTF 不影响旧会话解析，显式配置可重新显示')
console.log('ok   渗透预设说明指出常规/Nday/0day 的新会话选择方式')
