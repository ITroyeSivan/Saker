/**
 * `install-all.mjs` 的「替换已装包」安全网：**改名暂存 → 成功即弃 / 失败即回滚**。
 *
 * 为什么需要（2026-09-13 实测踩到，代价是三个插件从 profile 里消失）：
 * 原先的 `removeInstalledDir()` 在每次升级前**无条件删除**已装目录，理由是
 * pnpm 的 hoisted node-linker 在 Windows 上会死锁（见 install-all 里的长注释，那部分判断没错，
 * 删掉旧目录确实能解开死锁）。但删除本身**没有回滚** —— pnpm 连续失败 5 次后，
 * 插件就真的没了：`installed ok=16 fail=8` 的输出里只有一行 FAIL，
 * 用户/profile 都不会知道「dsh-route-boost 已经被卸载了」。
 * 实测当晚 `dsh-route-boost` / `dsh-knowledge-hub` / `dsh-skill-browse`
 * 三个目录被删后 pnpm 全部失败 → node_modules 里 23 个插件只剩 20 个，
 * 宿主启动时它们**静默不加载**（无任何报错，只是功能消失）。
 *
 * 改名（rename）与删除同样能解死锁 —— pnpm 面对的是「目标路径不存在」，
 * 这一点没有区别；而改名可逆，于是失败时能原样放回。
 * 暂存目录放在 node_modules **内部**（同盘，rename 才是原子的；
 * 注意 node_modules 可能是 junction，跨盘 rename 会 EXDEV）。
 */

import { existsSync, mkdirSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 暂存根目录名（在 node_modules 内，且以点开头，pnpm 不会把它当作包）。 */
export const STASH_DIRNAME = '.saker-stash'

/**
 * 把一个已装包改名到暂存区。
 *
 * @param {string} nodeModules - profile 的 node_modules 绝对路径。
 * @param {string} pkgName - 包名（如 `@dsh-external/dsh-route-boost`）。
 * @returns {{ stash: string, target: string } | null} 句柄；包里没装东西时返回 null。
 */
export function stashInstalledDir(nodeModules, pkgName) {
  const target = join(nodeModules, pkgName)
  if (!existsSync(target)) return null
  const stashRoot = join(nodeModules, STASH_DIRNAME)
  // 用时间戳避免同一次运行里同名包第二次暂存撞名（pnpm 重试路径可能出现）。
  const stash = join(stashRoot, `${pkgName.replace(/[\\/]/g, '__')}-${Date.now()}`)
  try {
    mkdirSync(stashRoot, { recursive: true })
    renameSync(target, stash)
    return { stash, target }
  } catch {
    // 改名不可用（跨盘 / 被占）时退化为删除 —— 与原行为一致，但至少**不假装成功**：
    // 调用方拿到 null 就知道「没有可回滚的东西」，失败时不会误以为已恢复。
    try { rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* best effort */ }
    return null
  }
}

/**
 * 把暂存的副本放回原位（安装失败时调用）。
 * @returns {boolean} 是否真的恢复了。
 */
export function restoreStash(handle) {
  if (!handle) return false
  try {
    if (!existsSync(handle.stash)) return false
    if (existsSync(handle.target)) return false // 新装的东西在，别覆盖
    mkdirSync(dirname(handle.target), { recursive: true })
    renameSync(handle.stash, handle.target)
    pruneStashRootIfEmpty(dirname(handle.stash))
    return true
  } catch {
    return false
  }
}

/** 丢弃暂存副本（安装成功时调用）。 */
export function dropStash(handle) {
  if (!handle) return
  try { rmSync(handle.stash, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }) } catch { /* 留着不影响运行 */ }
  pruneStashRootIfEmpty(dirname(handle.stash))
}

/**
 * 暂存根空了就删掉它。
 * 为什么：`mkdirSync(stashRoot)` 会留下一个空目录，而「升级失败后 node_modules 里
 * 多出一个陌生的点目录」会让验收时误判为残留。`rmdirSync` 对非空目录会失败 ——
 * 正好是我们想要的语义（有别的暂存项时不动它）。
 */
function pruneStashRootIfEmpty(stashRoot) {
  try { rmdirSync(stashRoot) } catch { /* 非空或已被清理 */ }
}

/** 清掉全部暂存残留（每次运行开始时调用；崩溃留下的残片不该越积越多）。 */
export function sweepStashRoot(nodeModules) {
  const stashRoot = join(nodeModules, STASH_DIRNAME)
  try { rmSync(stashRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }) } catch { /* best effort */ }
}
