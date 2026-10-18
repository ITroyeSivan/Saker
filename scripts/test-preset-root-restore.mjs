import assert from 'node:assert/strict'
import { patchAgentPresets } from '../lib/preset-roster-patch.mjs'

const originalList = async () => [{ id: 'pentest' }, { id: 'hidden' }]
const originalExport = async () => ({ presets: [{ id: 'pentest' }, { id: 'hidden' }] })
const originalResolve = async id => id
const presets = {
  list: originalList,
  remoteExportList: originalExport,
  resolve: originalResolve,
  config: { default: 'original-default' },
}

const restore = patchAgentPresets(presets, { filterPreset: () => true, defaultPreset: 'pentest' })
assert.notEqual(presets.list, originalList, 'list is wrapped while the plugin is active')
assert.equal(presets.config.default, 'pentest', 'default is pinned while active')
assert.equal(presets.__sakerRosterPatched, true)

restore()
assert.equal(presets.list, originalList, 'list owner is restored')
assert.equal(presets.remoteExportList, originalExport, 'remote export owner is restored')
assert.equal(presets.resolve, originalResolve, 'resolve owner is restored')
assert.equal(presets.config.default, 'original-default', 'original default is restored')
assert.equal(presets.__sakerRosterPatched, undefined, 'ownership marker is removed')

console.log('ok   preset roster wrappers are reversible and do not outlive the plugin')

const defaulted = {
  config: { default: 'standard' },
  async list() { return [{ id: 'pentest' }, { id: 'code-audit' }] },
  async resolve(id) { return { id: id ?? this.config.default } },
}
const stopDefault = patchAgentPresets(defaulted, { filterPreset: row => row.id === 'pentest' })
assert.deepEqual(await defaulted.resolve(undefined), { id: 'pentest' }, 'new sessions must resolve the host default')
assert.deepEqual(await defaulted.resolve('code-audit'), { id: 'code-audit' }, 'hidden historical sessions must still resume')
assert.deepEqual(await defaulted.list(), [{ id: 'pentest' }])
const wrapped = defaulted.list
const laterOwner = async () => [...await wrapped(), { id: 'later-owner' }]
defaulted.list = laterOwner
defaulted.config.default = 'later-default'
stopDefault()
assert.equal(defaulted.list, laterOwner, 'teardown must preserve a subsequent owner')
assert.equal(defaulted.config.default, 'later-default')
assert.deepEqual((await defaulted.list()).map(row => row.id), ['pentest', 'code-audit', 'later-owner'], 'retained wrapper becomes inert after teardown')
stopDefault()
console.log('ok   default creation, hidden-session resume and later wrapper ownership are preserved')
