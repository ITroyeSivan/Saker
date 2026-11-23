import { createHash } from 'node:crypto'
import { capabilityPrompt, resolveCapabilities } from './capabilities.js'
import { completionPrompt } from './completion.js'
import { publicDefinition, validateDefinition } from './schema.js'

export function compileWorkflow(input, { liveTools = [], verifiedCapabilityAdapters = {} } = {}) {
  const checked = validateDefinition(input)
  if (!checked.ok) throw Object.assign(new Error(`invalid workflow: ${checked.errors.join('; ')}`), { code: 'workflow_invalid' })
  const definition = publicDefinition(checked.definition)
  const nodes = definition.nodes.map((node, index) => {
    const next = node.next ?? definition.nodes[index + 1]?.id ?? null
    const capabilities = resolveCapabilities(node.tools, liveTools, { verifiedAdapters: verifiedCapabilityAdapters })
    return { ...node, order: index, next, capabilities, ready: index === 0, status: index === 0 ? 'ready' : 'pending' }
  })
  const prompt = nodes.map((node, index) =>
    `${index + 1}. [stepId=${node.id}] ${node.title}\n任务：${node.instruction}\n完成条件：${node.output}\n完成校验：${completionPrompt(node)}\n工具：${capabilityPrompt(node.capabilities)}`).join('\n\n')
  return {
    definition,
    nodes,
    prompt: `默认方法：${definition.title}\n${definition.description}\n\n${prompt}\n\n执行约束：一次只推进当前步骤。分析步骤用 artifacts=[{kind,title,detail}] 交付结构化材料；执行步骤用 evidenceRefs=[{kind:"execution"|"browser",id}]。标注“必须本次新执行”的步骤只接受本 run 创建后采集、仍为 current、目标与身份匹配的宿主回执；标注“允许复用历史材料”的步骤可引用完整性有效的旧回执，但必须保留来源边界。不要用任意字符串冒充回执；发现不能复现或前提不成立，用 blocked/unknown 并写清原因。`,
    semanticHash: createHash('sha256').update(JSON.stringify({ definition, nodes: nodes.map(({ capabilities, ...node }) => node) })).digest('hex'),
  }
}

export function stepPrompt(run) {
  const nodes = run?.data?.nodes ?? run?.nodes ?? []
  const index = run?.current_index ?? run?.currentIndex ?? 0
  if (run?.state === 'stopped') return '工作流已停止。已有证据保留；停止后的迟到推进不再接受，需要继续时请新建运行。'
  if (run?.state === 'done') {
    const outcome = run?.data?.outcome || 'completed'
    return `方法已结束（${outcome}）。这只表示步骤账本已收口，不等于目标已经验证成功；结论以已登记发现、回执和未覆盖项为准。`
  }
  const node = nodes[index]
  if (!node) return '工作流已完成。'
  const next = nodes[index + 1]
  return [
    `运行 ID：${run.run_id}`,
    `revision：${run.revision ?? 0}`,
    `当前步骤：${node.order + 1}/${nodes.length} · ${node.title}`,
    `当前步骤 ID：${node.id}`,
    node.instruction,
    `完成条件：${node.output}`,
    `完成校验：${completionPrompt(node)}`,
    `工具：${capabilityPrompt(node.capabilities)}`,
    `完成后调用：saker_workflow action=advance runId=${run.run_id} stepId=${node.id} status=done|blocked|unknown`,
    `下一步：${next ? `[stepId=${next.id}] ${next.title}` : '无（本次为最后一步）'}`,
    '只能推进当前步骤；stepId 可直接使用上面的稳定 ID。若状态或 revision 已变化，先 action=status 重新读取。',
  ].join('\n')
}
