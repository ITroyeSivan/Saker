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
//   · 通用规则镜像插件已有门禁；Pentest 额外按 RCE 交付边界收起不需要的能力；
//   · **只减不增**：从不 enable 任何东西，只在必要模式下 deny；
//   · 失败**必须可见**：restrict 抛错只 warn 并放行（宁可多带工具，不可悄悄改坏工具面）；
//   · 可关：config.enable 与逐规则开关，随时退回原状。
export const name = 'dsh-tool-scope'

/** 需要 tools 服务（读全局工具清单 + 在 agent scope 下挂过滤）。 */
export const inject = ['tools']

import { defineTool } from '@deepseek-ai/dsh-tools'
import { computeDeny, enabledRules, matchByRule, RULES } from './rules.js'
import { PACKS, deferredPackTools, enabledPacks, findPack, packsForMode, packTools } from './packs.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文
 * @param {{ enable?: boolean, rules?: Record<string, boolean>, log?: boolean }} config - 插件配置
 */
export function apply(ctx, config = {}) {
  const enable = config.enable !== false
  const rules = enabledRules(config.rules)
  const packs = enabledPacks(config.packs)
  const verbose = config.log !== false

  /** agentId -> { baseDispose, packDisposers, mode }（agent 销毁时必须全部释放）。 */
  const states = new Map()

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

  const knownTools = () => {
    try {
      // 无参 = 全局视图；插件的工具都注册在全局，正是 restrict 能过滤的那批。
      return ctx.tools.schemas().map((s) => s.name)
    } catch (error) {
      const msg = `读取工具清单失败，跳过本轮收窄: ${String(error?.message ?? error)}`
      ctx.logger?.warn?.('dsh-tool-scope: %s', msg)
      console.error('[tool-scope] ' + msg)
      return []
    }
  }

  // 工具包要看当前 Agent 的完整可见面。Pentest 扫描器由 preset 注入，
  // 不一定出现在插件上下文的全局 schemas() 里；全局清单仍用于原有模式规则。
  const visibleTools = (agent) => {
    try {
      const schemas = agent?.ctx?.tools?.schemas?.(agent)
      if (Array.isArray(schemas)) return schemas.map((s) => s.name)
      return knownTools()
    } catch (error) {
      const msg = `读取 Agent 工具清单失败，工具包不可用: ${String(error?.message ?? error)}`
      ctx.logger?.warn?.('dsh-tool-scope: %s', msg)
      console.error('[tool-scope] ' + msg)
      return []
    }
  }

  const stateOf = (agent) => {
    if (!agent?.id) return null
    const current = states.get(agent.id)
    if (current) return current
    return bind(agent)
  }

  const installPack = (agent, state, known, pack) => {
    if (state.packDisposers.has(pack.id)) return false
    const names = packTools(known, pack)
    if (!names.length) return false
    const dispose = agent.ctx.tools.restrict({ deny: names })
    state.packDisposers.set(pack.id, { dispose, names })
    return true
  }

  const refreshPacks = (agent, state) => {
    const current = visibleTools(agent)
    state.toolNames = [...new Set([...state.toolNames, ...current])]
    for (const pack of packsForMode(state.mode, packs)) {
      if (state.loadedPacks.has(pack.id)) continue
      try {
        if (installPack(agent, state, state.toolNames, pack)) {
          say(`模式 ${state.mode || '(默认)'} 收起工具包 ${pack.id}（${packTools(state.toolNames, pack).length} 个）`)
        }
      } catch (error) {
        const msg = `工具包 ${pack.id} 收起失败（该包保持可见）: ${String(error?.message ?? error)}`
        ctx.logger?.warn?.('dsh-tool-scope: %s', msg)
        console.error('[tool-scope] ' + msg)
      }
    }
  }

  const bind = (agent) => {
    if (!enable || !agent?.id || !agent?.ctx) return
    if (states.has(agent.id)) {
      // agent/created may precede preset tool injection; refresh after inbox insertion.
      refreshPacks(agent, states.get(agent.id))
      return states.get(agent.id)
    }

    const known = knownTools()
    if (!known.length) return

    const mode = modeOf(agent)
    const deny = computeDeny(mode, known, rules)
    const agentTools = visibleTools(agent)
    const state = { baseDispose: null, packDisposers: new Map(), loadedPacks: new Set(), mode, toolNames: agentTools }
    states.set(agent.id, state)

    if (deny.length) {
      try {
        state.baseDispose = agent.ctx.tools.restrict({ deny })
        const byRule = matchByRule(known, rules)
        const parts = []
        for (const [rid, names] of byRule) {
          const hit = names.filter((n) => deny.includes(n))
          if (hit.length) parts.push(`${rid}×${hit.length}`)
        }
        say(`模式 ${mode || '(默认)'} 隐藏 ${deny.length} 个工具（${parts.join(' ')}）`)
      } catch (error) {
        states.delete(agent.id)
        // 不静默：宁可多带工具，也不要把工具面改成半截。
        const msg = `restrict 失败（工具面保持原样）: ${String(error?.message ?? error)}`
        ctx.logger?.warn?.('dsh-tool-scope: %s', msg)
        console.error('[tool-scope] ' + msg)
        return state
      }
    }

    const packDeny = deferredPackTools(mode, agentTools, packs)
    refreshPacks(agent, state)
    if (!deny.length && !packDeny.length) say(`模式 ${mode || '(默认)'} 无需要收窄的工具`)
    return state
  }

  if (enable && packs.length) {
    ctx.tools.register(defineTool({
      name: 'tool_pack',
      description: '按需加载工具包，action=list/load/unload。pack=asset-discovery 用于有限目标识别和资产查询；nday 用于公开漏洞与情报源；active-scan 用于明确假设的扫描。加载不扩大权限或范围。',
      parameters: {
        action: { type: 'string', enum: ['list', 'load', 'unload'], required: true, description: 'list/load/unload' },
        pack: { type: 'string', description: 'asset-discovery / nday / active-scan / webshell' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
        render: (_args, v) => [{ type: 'text', text: v.ok
          ? (v.packs ? `工具包：${v.packs.map((p) => `${p.id}=${p.loaded ? '已加载' : '收起'}(${p.tools})`).join('；') || '无'}`
            : `工具包 ${v.pack}：${v.loaded ? '已加载' : '已收起'}`)
          : `工具包操作失败：${v.error}` }],
      },
      execute(args, exec) {
        const agent = exec?.agent
        const state = stateOf(agent)
        if (!state) return Promise.resolve({ ok: false, error: '当前会话不可用' })
        const mode = modeOf(agent)
        const available = packsForMode(mode, packs)
        if (args.action === 'list') {
          return Promise.resolve({
            ok: true,
            packs: packs.map((pack) => {
              const names = packTools(state.toolNames, pack)
              const availableNow = available.some((p) => p.id === pack.id) && names.length > 0
              return {
                id: pack.id,
                label: pack.label,
                available: availableNow,
                loaded: availableNow && state.loadedPacks.has(pack.id),
                tools: names.length,
                hint: pack.hint,
              }
            }),
          })
        }
        const pack = findPack(args.pack, available)
        const known = state.toolNames
        if (!pack || !packTools(known, pack).length) return Promise.resolve({ ok: false, error: `当前模式无此工具包：${args.pack ?? '(empty)'}` })
        if (args.action === 'load') {
          const entry = state.packDisposers.get(pack.id)
          if (entry) {
            try { entry.dispose() } catch { /* already released by agent teardown */ }
            state.packDisposers.delete(pack.id)
          }
          state.loadedPacks.add(pack.id)
          return Promise.resolve({ ok: true, pack: pack.id, loaded: true })
        }
        if (args.action === 'unload') {
          state.loadedPacks.delete(pack.id)
          if (!state.packDisposers.has(pack.id)) {
            try { installPack(agent, state, known, pack) } catch (error) {
              return Promise.resolve({ ok: false, error: `工具包收起失败：${error?.message ?? String(error)}` })
            }
          }
          return Promise.resolve({ ok: true, pack: pack.id, loaded: false })
        }
        return Promise.resolve({ ok: false, error: `未知 action：${args.action}` })
      },
    }))
  }

  ctx.on('agent/created', (payload) => bind(payload?.agent))
  // 会话恢复/接手时也会走到这里：同 agent 幂等，不会重复挂。
  ctx.on('agent/inbox/inserted', (info) => bind(info?.agent))

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload
    const id = agent?.id
    if (!id) return
    const state = states.get(id)
    if (!state) return
    states.delete(id)
    for (const entry of state.packDisposers.values()) {
      try { entry.dispose() } catch { /* agent scope 随 agent 一起销毁，这里只做尽力释放 */ }
    }
    try { state.baseDispose?.() } catch { /* 同上 */ }
  })

  say(
    `启用=${enable ? '是' : '否'} 规则=${rules.map((r) => `${r.id}(${r.modes.join('/')})`).join(' ') || '(无)'} 工具包=${packs.map((p) => p.id).join('/') || '(无)'}`,
  )
}

export { RULES, computeDeny, enabledRules, matchByRule, PACKS, deferredPackTools, enabledPacks, findPack, packTools, packsForMode }
