import { compileWorkflow, stepPrompt } from './compiler.js'
import { advanceWorkflowRun, createWorkflowRun, latestWorkflowRun, readWorkflowDefinition,
  readWorkflowRun, selectedWorkflow, stopWorkflowRun, listWorkflowDefinitions } from './store.js'
import { readTaskPolicy, startTaskPolicy } from '../task-policy.js'

export function registerWorkflowTools(ctx, {
  sessionOf,
  store,
  liveTools,
  verifiedCapabilityAdapters = {},
  defineTool,
}) {
  if (typeof defineTool !== 'function') throw new Error('workflow tool registration requires host defineTool')
  const resolveSession = exec => {
    try {
      const agent = exec?.agent
      const id = agent?.session?.id
      if (!id) return undefined
      const mode = agent?.session?.mode || agent?.session?.header?.agentPreset || ''
      return { id: String(id), mode: String(mode || '') }
    } catch { return undefined }
  }
  ctx.tools.register(defineTool({
    name: 'saker_workflow',
    description: '启动、查看或推进默认安全测试工作流。新目标先 start；返回稳定 stepId 与 revision，完成后用同一 stepId advance。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'start', 'status', 'advance', 'stop'] },
      workflowId: { type: 'string', description: 'start：默认 web-default；可选 nday-default/code-default' },
      target: { type: 'string', description: 'start：目标 URL、域名或组件' },
      goal: { type: 'string', description: 'start：用户原始要求' },
      runId: { type: 'string', description: 'status/advance/stop：运行ID' },
      stepId: { type: 'string', description: 'advance：当前步骤ID' },
      status: { type: 'string', enum: ['done', 'blocked', 'unknown'], description: 'advance：步骤结果' },
      note: { type: 'string', description: 'advance：实际发生了什么、证据和缺口' },
      evidenceRefs: {
        type: 'array',
        description: 'advance：真实回执引用，形如 [{kind:"execution"|"browser",id:"..."}]；字符串不算回执',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['execution', 'browser'] },
            id: { type: 'string' },
          },
        },
      },
      artifacts: {
        type: 'array',
        description: 'advance：分析步骤的结构化产物；kind 只能 observation/analysis/coverage/gap/answer/material',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['observation', 'analysis', 'coverage', 'gap', 'answer', 'material'] },
            title: { type: 'string' },
            detail: { type: 'string' },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.ok
        ? (value.prompt || JSON.stringify(value.run || value.workflows || { ok: true }, null, 2))
        : `工作流操作失败：${value.error}${value.recovery ? '\n' + value.recovery : ''}` }],
    },
    execute(args, exec) {
      const session = resolveSession(exec) || (() => { try { return sessionOf(ctx, exec) } catch { return undefined } })()
      if (!session?.id) return Promise.resolve({ ok: false, error: '当前会话不可用' })
      let activeRun = null
      try {
        const db = store()
        const tools = typeof liveTools === 'function' ? liveTools() : liveTools
        if (args.action === 'list') {
          const current = latestWorkflowRun(db, session.id)
          const selected = selectedWorkflow(db, session.id, session.mode)
          const workflows = listWorkflowDefinitions(db, session.id)
          const listing = workflows.map(item => `- ${item.id}：${item.title}（${item.nodes} 步，${item.source === 'builtin' ? '内置' : '自定义'}）— ${item.description}`).join('\n')
          return Promise.resolve({ ok: true, workflows, selected, run: current,
            prompt: `当前选择：${selected.title}（${selected.id}）\n\n可用方法：\n${listing}${current ? `\n\n当前运行：${current.run_id}（${current.state}，第 ${current.current_index + 1}/${current.data.nodes.length} 步）` : '\n\n当前没有运行中的工作流。'}` })
        }
        if (args.action === 'start') {
          const workflow = readWorkflowDefinition(db, args.workflowId || selectedWorkflow(db, session.id, session.mode).id, session.id)
          if (!workflow) throw new Error('unknown workflow')
          const target = String(args.target || '').trim()
          let scopeStarted = ''
          let scopeWarning = ''
          if (target) {
            const policy = readTaskPolicy(db, session.id)
            if (!policy) {
              try {
                startTaskPolicy(db, session.id, {
                  mode: 'regular', target,
    question: String(args.goal || '按当前测试流程完成用户要求'),
                })
                scopeStarted = target
              } catch (error) {
                scopeWarning = String(error?.message || error)
              }
            } else if (!String(policy.target || '').trim()) {
              scopeWarning = '任务已存在但还没有测试范围；请在会话设置里填写目标并允许访问。'
            }
          }
          const compiled = compileWorkflow(workflow, {
            liveTools: tools || [],
            verifiedCapabilityAdapters,
          })
          const run = createWorkflowRun(db, session.id, { workflow, compiled, target: args.target || '', goal: args.goal || '' })
          const step = run.data.nodes[run.current_index]
          return Promise.resolve({ ok: true, runId: run.run_id, stepId: step?.id || '', revision: run.revision ?? 0, run,
            scopeStarted, ...(scopeWarning ? { scopeWarning } : {}),
            prompt: `运行 ID：${run.run_id}\n\n${stepPrompt(run)}\n\n完整计划：\n${compiled.prompt}\n\n计划已完整返回；不要搜索插件源码或工作区文件来查找方法定义。${scopeStarted ? `\n本次测试范围已登记：${scopeStarted}` : ''}${scopeWarning ? `\n范围提示：${scopeWarning}` : ''}` })
        }
        activeRun = args.runId ? readWorkflowRun(db, session.id, args.runId) : latestWorkflowRun(db, session.id)
        if (!activeRun) throw Object.assign(new Error('workflow run not found in this session'), { code: 'workflow_run_not_found' })
        if (args.action === 'status') {
          const step = activeRun.data.nodes[activeRun.current_index]
          return Promise.resolve({ ok: true, runId: activeRun.run_id, stepId: step?.id || '', revision: activeRun.revision ?? 0,
            run: activeRun, prompt: stepPrompt(activeRun) })
        }
        if (args.action === 'stop') {
          const stopped = stopWorkflowRun(db, activeRun, args.note)
          return Promise.resolve({ ok: true, run: stopped, prompt: '工作流已停止，保留已有证据。' })
        }
        if (args.action === 'advance') {
          const currentStep = activeRun.data.nodes[activeRun.current_index]
          const stepId = String(args.stepId || currentStep?.id || '').trim()
          if (!stepId) throw Object.assign(new Error('workflow has no current step to advance'), {
            code: 'workflow_no_current_step', runId: activeRun.run_id, revision: activeRun.revision ?? 0,
          })
          const updated = advanceWorkflowRun(db, activeRun, {
            stepId,
            status: args.status || 'done',
            note: args.note || '',
            evidenceRefs: args.evidenceRefs || [],
            artifacts: args.artifacts || [],
          })
          const nextStep = updated.data.nodes[updated.current_index]
          return Promise.resolve({ ok: true, runId: updated.run_id, stepId: nextStep?.id || '', revision: updated.revision ?? 0,
            run: updated, prompt: stepPrompt(updated) })
        }
        throw new Error('invalid workflow action')
      } catch (error) {
        let latest = activeRun
        if (!latest) {
          try {
            const db = store()
            latest = args.runId ? readWorkflowRun(db, session.id, args.runId) : latestWorkflowRun(db, session.id)
          } catch { /* recovery is best effort; the original error remains authoritative */ }
        }
        const step = latest?.data?.nodes?.[latest.current_index]
        const recovery = step
          ? `当前可推进步骤：stepId=${step.id}（第 ${step.order + 1}/${latest.data.nodes.length} 步）；revision=${latest.revision ?? 0}。`
            + `请用 saker_workflow action=advance runId=${latest.run_id} stepId=${step.id} 重试；或先 action=status。`
          : '先调用 saker_workflow action=start 或 action=status 取得当前运行、stepId 和 revision。'
        return Promise.resolve({ ok: false, error: error.message, code: error.code || 'workflow_error',
          ...(latest ? { runId: latest.run_id, revision: latest.revision ?? 0, currentStepId: step?.id || '',
            allowedStepIds: step ? [step.id] : [] } : {}), recovery })
      }
    },
  }))
}
