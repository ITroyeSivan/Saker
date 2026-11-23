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
  '@dsh-external/dsh-ctf-observer',
  // 自动拒答纠偏会把“缺少文档/缺少账号”的正常说明误判为拒答，
  // 并在后台自动重发；正常对话的结束和继续应由用户与模型处理。
  '@dsh-external/dsh-refusal-guard',
  // Turn-end 自动续接由同一 Host 主助手的显式继续/任务事件处理；保留源码
  // 和测试作迁移历史，不再让第二个 hook 自动重开已结束的回合。
  '@dsh-external/dsh-auto-advance',
  // 旧会话状态 Web 面板由工作台 query-store 和官方会话界面替代。
  '@dsh-external/dsh-session-pulse',
  // 外部 Claude/Codex CLI provider 无法保证同 root 工具、预算和取消合同；
  // 协作统一走 Host。已有配置和 trace 保留只读。
  '@dsh-external/dsh-product-subagents',
  // 旧阶段门禁/operation-state 台账已由项目检查、覆盖矩阵和发现/回执替代；
  // 代码审计技能不再调用 gates_list/stage_gate/operation_*。
  '@dsh-external/dsh-stage-gate',
  // 仍有用的工作区写入边界、高危命令、速率纪律和人工审批已迁到根包
  // lib/security-guard.js；旧 gate-log/operation-state 门不再保留第二个 hook。
  '@dsh-external/dsh-sec-enforce',
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
