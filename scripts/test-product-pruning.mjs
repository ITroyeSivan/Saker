import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { productPluginDirectories, RETIRED_PLUGINS, installedRetiredPlugins, retireInstalledPlugins } from './lib/product-plugins.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const dirs = productPluginDirectories(root)
const names = dirs.map(dir => JSON.parse(readFileSync(join(root, 'plugins', dir, 'package.json'))).name)
assert(!names.some(name => RETIRED_PLUGINS.includes(name)))
assert(names.includes('@dsh-external/dsh-nday-hunter') && names.includes('@dsh-external/dsh-hunter'))
console.log('ok   product selection retires three modules and preserves Nday services')
const temporary = mkdtempSync(join(resolve(root, '../_ref/tmp'), 'product-pruning-'))
try {
  const manifestPath = join(temporary, 'package.json')
  const retained = { dependencies: { 'user-plugin': '1.0.0' }, dsh: { profile: { bundles: ['user-plugin'], config: { mcp: { burp: { enabled: true } } } } } }
  const old = structuredClone(retained)
  old.dependencies[RETIRED_PLUGINS[0]] = 'file:old.tgz'
  old.dsh.profile.bundles.push(...RETIRED_PLUGINS)
  writeFileSync(manifestPath, JSON.stringify(old))
  assert.deepEqual(installedRetiredPlugins(old), RETIRED_PLUGINS)
  assert.throws(() => retireInstalledPlugins(manifestPath, () => {}), /remain/)
  let calls = 0
  assert.deepEqual(retireInstalledPlugins(manifestPath, args => {
    calls++
    assert.deepEqual(args, ['plugin', '--profile', 'desktop', 'remove', ...RETIRED_PLUGINS])
    writeFileSync(manifestPath, JSON.stringify(retained))
  }), RETIRED_PLUGINS)
  assert.equal(calls, 1)
  assert.deepEqual(JSON.parse(readFileSync(manifestPath)), retained)
  retireInstalledPlugins(manifestPath, () => { throw Error('Unexpected removal') })
  console.log('ok   migration checks actual removal, preserves unrelated configuration and is idempotent')
} finally { rmSync(temporary, { recursive: true, force: true }) }
for (const file of ['pack-all.mjs', 'install-all.mjs', 'install-desktop.mjs', 'pack-desktop-release.mjs']) {
  assert.match(readFileSync(join(root, 'scripts', file), 'utf8'), /productPluginDirectories\(root\)/)
}
console.log('ok   every production build, installer and delivery uses one selection')
for (const file of ['plugins/dsh-redteam-results/lib/index.js', 'plugins/dsh-stage-gate/lib/index.js', 'plugins/dsh-route-boost/lib/scope.mjs']) {
  assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /import\([^\n]*dsh-attack-atlas/)
}
assert.doesNotMatch(readFileSync(join(root, 'plugins/dsh-redteam-results/lib/index.js'), 'utf8'), /name:\s*"redteam_chain_reconcile"/)
assert.doesNotMatch(readFileSync(join(root, 'plugins/dsh-hunter/lib/client.js'), 'utf8'), /name:\s*"conversation.view"/)
for (const file of ['preset/code-audit/opening.md','preset/ctf-solver/opening.md','preset/code-audit/skills/audit-playbook/SKILL.md','preset/ctf-solver/skills/ctf-playbook/SKILL.md','plugins/dsh-route-boost/lib/index.js']) {
  assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /campaign_idea_|campaign-memory|redteam_coverage_|redteam_atlas_target/)
}
console.log('ok   runtime links, obsolete chat tab and published prompt requirements are removed')
