import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// One selection for build, installation and delivery. Retired packages must
// also be removed from existing profiles through the official plugin command.
export const RETIRED_PLUGINS = Object.freeze([
  '@dsh-external/dsh-attack-atlas',
  '@dsh-external/dsh-campaign-memory',
  '@dsh-external/dsh-webshell-mgr',
  // 旧 Web 编排本体：方法目录/开场/saker_method 与 route 信封已由 task-prompt、
  // 测试内容目录和任务设置替代；保留仓库源码只作迁移参考，不再进入产品安装。
  '@dsh-external/dsh-method-stack',
  '@dsh-external/dsh-route-boost',
  '@dsh-external/dsh-knowledge-hub',
  '@dsh-external/dsh-nday-hunter',
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
export function retireInstalledPlugins(manifestPath, invoke, profile = 'desktop') {
  const retired = installedRetiredPlugins(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (!retired.length) return []
  invoke(['plugin', '--profile', profile, 'remove', ...retired])
  const remaining = installedRetiredPlugins(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (remaining.length) throw Error('Retired plugins remain in the Desktop profile: ' + remaining.join(', '))
  return retired
}
