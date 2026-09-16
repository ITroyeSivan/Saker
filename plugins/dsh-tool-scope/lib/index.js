// dsh-tool-scope —— 按模式收窄全局工具可见性。
//
// 【解决什么问题】一轮模型请求里**工具定义占 67.8%**（实测 101 个 / 111.5K），
// 而其中一批工具在**当前模式下本来就调不动** —— 插件自己已经声明了模式门禁
// （webshell 仅 pentest、ctf 仅 ctf-solver、成果/记忆/留痕/知识库仅三个安全模式），
// 非适用模式下调用会被硬拒绝。这些声明留在上下文里纯属白占。
//
// 【做法】用**宿主原生的 per-agent 工具过滤**（`agent.ctx.tools.restrict({deny})`，
// packages/core/tools/src/index.ts:1061）在会话创建时把不该出现的工具收掉。
// 参照 BreachWeave `pi-mcp-adapter` 的「别把全部声明塞进上下文」思路，
// 但落地形态更轻：不造代理层、不加新工具，直接复用宿主的可见性过滤。
//
// 【纪律】
//   · 只收「插件已声明的门禁」，规则表在 lib/rules.js，每条都带源码依据；
//   · **只减不增**：从不 enable 任何东西，只在必要模式下 deny；
//   · 失败**必须可见**：restrict 抛错只 warn 并放行（宁可多带工具，不可悄悄改坏工具面）；
//   · 可关：config.enable 与逐规则开关，随时退回原状。
export const name = 'dsh-tool-scope'

/** 需要 tools 服务（读全局工具清单 + 在 agent scope 下挂过滤）。 */
export const inject = ['tools']

import { computeDeny, enabledRules, matchByRule, RULES } from './rules.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文
 * @param {{ enable?: boolean, rules?: Record<string, boolean>, log?: boolean }} config - 插件配置
 */
export function apply(ctx, config = {}) {
  const enable = config.enable !== false
  const rules = enabledRules(config.rules)
  const verbose = config.log !== false

  /** agentId -> 该 agent 的过滤器 disposer（agent 销毁时必须释放）。 */
  const disposers = new Map()

  /**
   * 一次输出两路：`ctx.logger.info`（宿主日志）与 `console.log`（进程 stdout）。
   *
   * 为什么两路都要：实测宿主默认只把 warn 及以上送到 stderr，`logger.info` **不上屏** ——
   * 于是插件悄悄改了工具面，而用户在启动日志里看不到任何痕迹。
   * 「工具面变了」属于用户必须知情的事，所以额外走 console（与 ctf-observer 的做法一致）。
   */
  const say = (line) => {
    if (!verbose) return
    ctx.logger?.info?.('dsh-tool-scope: %s', line)
    console.log('[tool-scope] ' + line)
  }

  /** 读当前会话的模式 id；composedPreset 优先（它能处理子代理继承），退回 header。 */
  const modeOf = (agent) => {
    try {
      const id = ctx.agentPresets?.composedPreset?.(agent?.ctx)
      if (typeof id === 'string' && id) return id
    } catch { /* 组合未就绪 */ }
    const header = agent?.session?.header?.agentPreset
    return typeof header === 'string' ? header : ''
  }

  const bind = (agent) => {
    if (!enable || !agent?.id || !agent?.ctx) return
    if (disposers.has(agent.id)) return // 幂等：同 agent 只挂一次

    const known = (() => {
      try {
        // 无参 = 全局视图；插件的工具都注册在全局，正是 restrict 能过滤的那批。
        return ctx.tools.schemas().map((s) => s.name)
      } catch (error) {
        const msg = `读取工具清单失败，跳过本轮收窄: ${String(error?.message ?? error)}`
        ctx.logger?.warn?.('dsh-tool-scope: %s', msg)
        console.error('[tool-scope] ' + msg)
        return []
      }
    })()
    if (!known.length) return

    const mode = modeOf(agent)
    const deny = computeDeny(mode, known, rules)
    if (!deny.length) {
      say(`模式 ${mode || '(默认)'} 无需要收窄的工具`)
      return
    }

    try {
      const dispose = agent.ctx.tools.restrict({ deny })
      disposers.set(agent.id, dispose)
      const byRule = matchByRule(known, rules)
      const parts = []
      for (const [rid, names] of byRule) {
        const hit = names.filter((n) => deny.includes(n))
        if (hit.length) parts.push(`${rid}×${hit.length}`)
      }
      say(`模式 ${mode || '(默认)'} 隐藏 ${deny.length} 个工具（${parts.join(' ')}）`)
    } catch (error) {
      // 不静默：宁可多带工具，也不要把工具面改成半截。
      const msg = `restrict 失败（工具面保持原样）: ${String(error?.message ?? error)}`
      ctx.logger?.warn?.('dsh-tool-scope: %s', msg)
      console.error('[tool-scope] ' + msg)
    }
  }

  ctx.on('agent/created', (payload) => bind(payload?.agent))
  // 会话恢复/接手时也会走到这里：同 agent 幂等，不会重复挂。
  ctx.on('agent/inbox/inserted', (info) => bind(info?.agent))

  ctx.on('agent/disposed', (agent) => {
    const id = agent?.id
    if (!id) return
    const dispose = disposers.get(id)
    if (!dispose) return
    disposers.delete(id)
    try { dispose() } catch { /* agent scope 随 agent 一起销毁，这里只做尽力释放 */ }
  })

  say(
    `启用=${enable ? '是' : '否'} 规则=${rules.map((r) => `${r.id}(${r.modes.join('/')})`).join(' ') || '(无)'}`,
  )
}

export { RULES, computeDeny, enabledRules, matchByRule }
