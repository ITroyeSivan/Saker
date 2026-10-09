import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// One selection for build, installation and delivery. Retired packages must
// also be removed from existing profiles through the official plugin command.
export const RETIRED_PLUGINS = Object.freeze([
  '@dsh-external/dsh-attack-atlas',
  '@dsh-external/dsh-campaign-memory',
  '@dsh-external/dsh-webshell-mgr',
])
export function productPluginDirectories(root) {
  return readdirSync(join(root, 'plugins')).sort().filter(name => {
    const dir = join(root, 'plugins', name)
    if (!name.startsWith('dsh-') || !statSync(dir).isDirectory() || !existsSync(join(dir, 'package.json'))) return false
    return !RETIRED_PLUGINS.includes(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name)
  })
}
export function installedRetiredPlugins(manifest) {
  const bundles = manifest.dsh?.profile?.bundles ?? []
  return RETIRED_PLUGINS.filter(name => Object.hasOwn(manifest.dependencies ?? {}, name) || bundles.includes(name))
}
export function retireInstalledPlugins(manifestPath, invoke) {
  const retired = installedRetiredPlugins(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (!retired.length) return []
  invoke(['plugin', '--profile', 'desktop', 'remove', ...retired])
  const remaining = installedRetiredPlugins(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (remaining.length) throw Error('Retired plugins remain in the Desktop profile: ' + remaining.join(', '))
  return retired
}
