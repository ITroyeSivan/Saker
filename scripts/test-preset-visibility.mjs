import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPresetVisibility } from '../lib/preset-visibility.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const defaults = createPresetVisibility('')
assert.ok(defaults.isVisible({ id: 'pentest' }))
assert.ok(!defaults.isVisible({ id: 'code-audit' }))
assert.equal(defaults.canResolve('code-audit'), true, 'old audit sessions must keep resolving')
assert.ok(defaults.isVisible({ id: 'standard' }))
assert.ok(!defaults.isVisible({ id: 'ctf-solver' }), 'CTF must stay out of new-session choices by default')
assert.equal(defaults.canResolve('ctf-solver'), true, 'old CTF sessions must keep resolving')
assert.equal(defaults.canResolve('unknown'), false)

const optedIn = createPresetVisibility('ctf-solver')
assert.ok(!optedIn.isVisible({ id: 'ctf-solver' }), 'compatibility presets cannot reappear in new-session choices')
assert.equal(optedIn.canResolve('ctf-solver'), true)

const pentestPatch = readFileSync(join(ROOT, 'preset/pentest/agent.patch.yml'), 'utf8')
const pentestCordis = readFileSync(join(ROOT, 'preset/pentest/agent.cordis.yml'), 'utf8')
const pentestOpening = readFileSync(join(ROOT, 'preset/pentest/opening.md'), 'utf8')
assert.match(pentestPatch, /^\s*prefix: ''$/m, 'Pentest persona slot must be owned by the editable mode opening')
assert.match(pentestCordis, /^\s*prefix: ''$/m, 'Pentest declarative persona slot must stay empty')
assert.ok(!pentestOpening.includes('ask_user_question'), 'Pentest persona must not inject an interactive question step')
// v6 第 4.1 节：长角色正文、方法编排开场与固定七流程退出模型请求。
// opening.md 只保留迁移说明，固定能力说明由 dsh-redteam-results 的 task-prompt 一处维护。
assert.ok(pentestOpening.includes('task-prompt'), '固定能力说明由 task-prompt 一处维护')
assert.ok(!/pentest-regular|pentest-nday|pentest-0day|scope_missing|Legacy \/pentest-campaign/.test(pentestOpening),
  '旧角色正文与方法开场不再进入模型请求')

console.log('ok   新会话仅保留渗透专业入口，代码审计和CTF均隐藏')
console.log('ok   旧会话继续解析，显式旧配置不重开已移除入口')
console.log('ok   渗透预设说明指出常规/Nday/0day 的新会话选择方式')
