// Optional development bundle. Never included in Saker's production preset or release.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { load, dump } from 'js-yaml';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import saker from 'dsh-saker/package.json' with { type: 'json' };
import benchmarkPackage from './package.json' with { type: 'json' };
import { dispatch as dispatchTask, openStore } from '@dsh-external/dsh-redteam-results';
import { createEffectLab } from './lab.mjs';
import { CASES } from './cases.mjs';
import { createAgentInterface, mountRestrictedAgent, assertRestrictedSurface, countUsage } from './agent-interface.mjs';
import { resolveComparisonPreset, freezeSingleAgentRows, createRunClock, createRunStopper } from './runtime.mjs';
import { assessRunQualification, assessHomeIsolation, assessMatrixComparability } from './protocol.mjs';
import { buildRunFacts, ledgerFacts } from './run-facts.mjs';

export const name = 'saker-effect-benchmark';
export const inject = ['agents', 'agentPresets', 'connection', 'tools', 'sessions', 'webServer'];
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2);
const benchmarkPackageVersion = benchmarkPackage.version;
/** 类别完整任务挂上的受控工具面：sessionId → guard disposer 列表。 */
const categoryRestrictions = new Map();

export function apply(ctx) {
  const runs = new Map();
  let preparing = false;
  // 辅助调用（会话标题、上下文整理等）与对话调用分开计数。只观察、不改写请求。
  const auxiliaryStreams = [];
  try {
    ctx.on?.('llm/stream', (options, next) => {
      const purpose = typeof options?.purpose === 'string' && options.purpose ? options.purpose : 'conversation';
      if (purpose !== 'conversation') auxiliaryStreams.push({ purpose, sessionId: typeof options?.sessionId === 'string' ? options.sessionId : null, at: Date.now() });
      return next();
    });
  } catch { /* 观察不到辅助流时按未知处理，不假装为零 */ }
  // 校准运行会写会话、projcache、workspace.json 与 redteam-results/results.db，全部跟随
  // DSH_HOME。日常桌面启动器把 DSH_HOME 指向真实 home，所以这里要求运行方显式声明隔离根，
  // 不满足就在创建任何运行之前停住，而不是跑完再去清用户的 home。
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const homeIsolation = assessHomeIsolation({ home, declaredRoot: process.env.SAKER_EFFECT_HOME_ROOT });
  const persist = run => {
    const result = {
      interfaceVersion: run.bridge.version, caseId: run.lab.caseId, runId: run.lab.runId,
      sessionId: run.agent.id, variant: run.variant, sakerVersion: saker.version,
      caseSplit: run.caseSplit,
      home: homeIsolation.home, homeIsolation,
      model: run.model, provider: run.provider, toolDigest: run.toolDigest, accessDigest: run.bridge.accessDigest,
      reasoningEffort: run.reasoningEffort ?? null,
      preset: run.preset, presetCompositionDigest: run.presetCompositionDigest,
      sourcePreset: run.sourcePreset, sourcePresetCompositionDigest: run.sourcePresetCompositionDigest,
      presetAdjustments: run.presetAdjustments,
      budget: run.budget, startedAt: run.startedAt, elapsedMs: run.clock.elapsedMs(),
      durationFinal: run.clock.finished, cleanupComplete: run.stopped === true,
      status: run.agent.status, stopReason: run.stopReason ?? null,
      isolationFailures: run.isolationFailures, toolCalls: run.toolCalls,
      facts: run.facts,
      usage: { modelCalls: run.modelCalls, tokens: run.unknownUsage ? null : run.tokens, knownTokens: run.tokens,
        unknownUsage: run.unknownUsage,
        // 缓存读写与未缓存输入分开记账；任一条消息缺字段就标 complete:false，不按零补齐。
        tokenParts: { ...run.tokenParts.parts, complete: run.tokenParts.complete },
        auxiliary: (() => {
          const mine = auxiliaryStreams.filter(row => row.sessionId === run.agent.id);
          const byPurpose = {};
          for (const row of mine) byPurpose[row.purpose] = (byPurpose[row.purpose] ?? 0) + 1;
          return { calls: mine.length, byPurpose, tokenUsage: null,
            note: '辅助流（标题/整理）按 purpose 单独计数；token 不在本组口径内归属，记为 null 而不是 0。' };
        })(),
        ledger: ledgerFacts(home, run.agent.id),
        elapsedMs: run.clock.elapsedMs(), humanInterventions: 0 },
      submission: run.bridge.controller.snapshot().submission,
      score: run.bridge.controller.grade(),
      // 可比性由可核对的事实决定：有没有校准记录、预算是否达到校准下限、三组是否都跑够了重复次数。
      // 调用方自报"已校准"不算数（记录必须带 digest 且预算不低于其下限）。
      comparability: assessMatrixComparability({
        calibration: run.calibration, budget: run.budget, requiredRepeats: run.requiredRepeats,
        // 逐例闸要求"每一例 × 每一组"都跑够次数，所以这里既带上本实例已有的 caseId，
        // 也带上该 split 的全部分区用例，避免"只跑了 p1 却自报可比"。
        expectedCases: CASES.filter(item => item.split === run.caseSplit).map(item => item.id),
        runs: [...runs.values()].map(other => ({ caseId: other.lab.caseId, variant: other.variant, durationFinal: other.clock.finished === true })),
      }),
    };
    result.qualification = assessRunQualification(result);
    writeFileSync(join(run.directory, 'result.json'), json(result));
    writeFileSync(join(run.directory, 'audit.json'), json(run.lab.audit()));
    return result;
  };
  async function stop(run, reason) {
    return run.stop(reason);
  }
  ctx.connection.register(ctx, '/saker-effect-benchmark', async (endpoint, payload = {}) => {
    try {
      if (endpoint === 'inventory') return { ok: true, value: { sakerVersion: saker.version,
        defaultPreset: ctx.agentPresets.defaultId, presets: await ctx.agentPresets.list(), homeIsolation } };
      // 类别完整任务（E01–E12）走的是产品自己的预设，模型因此能读到同机上的夹具源码与
      // 控制端报告（2026-10-18 实测：模型在仓库里找到夹具源码并照抄答案）。
      // 这个端点给指定会话挂一条**拒绝式** guard：工具仍然可见，但越界的调用会被硬拒，
      // 不依赖模型自觉。合成靶场用的是 allow 式受控接口；这里是 deny 式，因为类别任务要保留
      // 产品真实的 redteam_* / knowledge_* 工具面。
      if (endpoint === 'restrict') {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
        if (!sessionId) throw new Error('sessionId required');
        const agent = ctx.agents.get(sessionId);
        if (!agent) throw new Error('session is not live: ' + sessionId);
        const deny = Array.isArray(payload.deny) ? [...new Set(payload.deny.filter(name => typeof name === 'string' && name.trim()))] : [];
        if (!deny.length) throw new Error('deny list required');
        if (typeof agent.ctx?.tools?.guard !== 'function') throw new Error('host lacks enforced scoped tool isolation');
        const previous = categoryRestrictions.get(sessionId) ?? [];
        const dispose = agent.ctx.tools.guard(exec => {
          if (exec.agent?.id !== agent.id) return undefined;
          return deny.includes(exec.name) ? 'controlled surface: ' + exec.name + ' 不在本次评测允许的工具面内' : undefined;
        });
        previous.push(dispose);
        categoryRestrictions.set(sessionId, previous);
        const visible = agent.ctx.tools.schemas(agent).map(tool => tool.name);
        return { ok: true, value: { sessionId, denied: deny, visibleCount: visible.length,
          visibleBlocked: visible.filter(name => deny.includes(name)) } };
      }
      if (endpoint === 'start') {
        if (!homeIsolation.isolated) throw new Error('benchmark host home is not isolated (' + homeIsolation.reasons.join('; ')
          + '): home=' + homeIsolation.home + ' isolatedRoot=' + (homeIsolation.isolatedRoot ?? 'unset'));
        if (preparing || [...runs.values()].some(run => !run.stopped)) throw new Error('one calibration run at a time');
        if (!['candidate', 'plain-agent', 'saker-0.4.92'].includes(payload.variant)) throw new Error('explicit comparison variant required');
        if (payload.variant === 'saker-0.4.92' && saker.version !== '0.4.92') throw new Error('frozen baseline version is not installed');
        for (const key of ['provider', 'model']) if (typeof payload[key] !== 'string' || !payload[key].trim()) throw new Error(`explicit ${key} required`);
        // 思考程度：测试时固定 low。空串/非字符串一律拒绝，避免把"没传"混成"传了空"。
        const reasoningEffort = payload.reasoningEffort ?? null;
        if (reasoningEffort !== null && (typeof reasoningEffort !== 'string' || !reasoningEffort.trim())) throw new Error('invalid reasoningEffort');
        const budget = payload.budget;
        if (!budget || !['minutes', 'targetRequests', 'tokens'].every(key => Number.isSafeInteger(budget[key]) && budget[key] > 0)
          || budget.minutes > 30 || budget.targetRequests > 200 || budget.tokens > 1500000) throw new Error('invalid calibration budget');
        const calibration = payload.calibration ?? null;
        if (calibration) {
          if (!calibration.budget || typeof calibration.digest !== 'string' || !calibration.digest.trim()) throw new Error('invalid calibration record');
          for (const key of ['minutes', 'targetRequests', 'tokens']) {
            if (!Number.isSafeInteger(calibration.budget[key]) || calibration.budget[key] < 1) throw new Error(`invalid calibration ${key}`);
            if (budget[key] < calibration.budget[key]) throw new Error(`budget ${key} is below the calibrated floor ${calibration.budget[key]}`);
          }
        }
        const requiredRepeats = payload.repeats ?? 3;
        if (!Number.isSafeInteger(requiredRepeats) || requiredRepeats < 1 || requiredRepeats > 10) throw new Error('invalid repeats');
        const caseSplit = payload.split ?? 'calibration';
        if (!['calibration', 'holdout'].includes(caseSplit)) throw new Error('invalid case split');
        preparing = true;
        let lab, handle, presetRelease;
        try {
          lab = await createEffectLab(payload.caseId, { maxRequests: budget.targetRequests, split: caseSplit });
          const bridge = createAgentInterface(lab);
          const resetReceipt = lab.captureInitialState();
          const directory = mkdtempSync(join(tmpdir(), 'saker-effect-desktop-'));
          const cwd = join(directory, 'agent'); mkdirSync(cwd);
          const selection = await resolveComparisonPreset(ctx.agentPresets, payload.variant, { normalizePaths: [home] });
          let preset = selection.id, compositionDigest = selection.compositionDigest;
          let presetAdjustments = [];
          if (payload.variant === 'plain-agent') {
            const frozen = freezeSingleAgentRows(load(selection.content, { schema: entryListSchema }));
            preset = 'saker-effect-standard-' + lab.runId;
            presetRelease = await ctx.agentPresets.register({ id: preset, name: 'Effect benchmark: single standard agent', plugins: frozen.rows });
            compositionDigest = sha(dump(frozen.rows, { schema: entryListSchema, noRefs: true }));
            presetAdjustments = [{ property: 'subagent.modelSelectionSettings', value: false, rows: frozen.changed,
              reason: 'shared controlled interface has zero workers; prevent late agent-local tool registration' }];
          }
          // 运行前事实（来源/安装/宿主/preset/工具/访问/预算/材料/身份/环境复位 + 试次与预注册选择）。
          // 身份只记角色与摘要，不把账号 token 写进记录；缺项记 null，不补造。
          const facts = buildRunFacts({ sakerVersion: saker.version, benchmarkVersion: benchmarkPackageVersion,
            home, homeIsolation, preset, compositionDigest, sourcePreset: selection.id,
            sourcePresetCompositionDigest: selection.compositionDigest, lab, bridge, budget, payload,
            calibration, requiredRepeats, caseSplit, resetReceipt });
          if (!facts.environment.snapshotRestored || !facts.sourceFiles?.files || !facts.installFiles?.files)
            throw new Error('formal run requires actual source/install contents and a verified fresh-lab receipt');
          const run = { lab, bridge, directory, facts, variant: payload.variant, provider: payload.provider, model: payload.model,
            reasoningEffort,
            preset, presetRelease, presetCompositionDigest: compositionDigest, presetAdjustments,
            sourcePreset: selection.id, sourcePresetCompositionDigest: selection.compositionDigest,
            budget: structuredClone(budget), clock: createRunClock(), startedAt: null,
            calibration, requiredRepeats,
            caseSplit,
            modelCalls: 0, tokens: 0, unknownUsage: false,
            tokenParts: { parts: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, complete: true },
            toolCalls: [], isolationFailures: [] };
          run.stop = createRunStopper(async reason => {
            run.stopReason = reason; clearTimeout(run.timer);
            try { run.agent.cancel({ kind: 'hook', reason }); await run.agent.whenIdle(); }
            catch (error) { run.isolationFailures.push('agent cleanup failed: ' + error.message); }
            run.clock.end(); run.bridge.controller.close();
            if (run.variant !== 'plain-agent') {
              try {
                const stopped = await ctx.tools.get('redteam_task').execute({ action: 'cancel' }, { agent: run.agent, signal: new AbortController().signal });
                if (!stopped.ok) throw new Error(stopped.error);
              } catch (error) { run.isolationFailures.push('native task cleanup failed: ' + error.message); }
            }
            try { await run.lab.close(); } catch (error) { run.isolationFailures.push('lab cleanup failed: ' + error.message); }
            run.stopped = true;
            return persist(run);
          });
          handle = await ctx.agents.create({ sessionId: 'session-' + randomUUID(), meta: { cwd, agentPreset: preset },
            agentOptions: { provider: payload.provider, model: payload.model, maxTokens: Math.min(4096, budget.tokens),
              ...(reasoningEffort === null ? {} : { reasoningEffort }) },
            setup: async (agentCtx, agent) => {
              await ctx.agentPresets.mount(agentCtx, preset);
              mountRestrictedAgent(agent, bridge, defineTool);
              agentCtx.on('agent/pre-step', async (_payload, next) => {
                try { assertRestrictedSurface(agent); } catch (error) { run.isolationFailures.push(error.message); run.stopReason = 'isolation-failed'; return { kind: 'reject' }; }
                if (run.unknownUsage || run.tokens >= budget.tokens || run.clock.elapsedMs() >= budget.minutes * 60000) {
                  run.stopReason = run.unknownUsage ? 'usage-unknown' : 'budget-exhausted'; return { kind: 'reject' };
                }
                return next();
              });
              agentCtx.on('agent/status', ({ status }) => {
                if (status === 'idle' && run.clock.started) {
                  run.clock.end();
                  // Run cleanup after the native lifecycle callback returns.
                  setTimeout(() => stop(run, run.stopReason ?? (bridge.controller.snapshot().submission ? 'submitted' : 'missing-submission'))
                    .catch(error => ctx.logger.warn(error)), 0);
                }
              });
              agentCtx.on('session/event', (_session, event) => {
                if (event.type === 'request/header') {
                  const tools = event.data.header.tools;
                  const digest = sha(JSON.stringify(tools));
                  if (run.toolDigest && run.toolDigest !== digest) run.isolationFailures.push('compiled tool interface changed');
                  run.toolDigest = digest;
                  run.facts.tools.digest = digest;
                }
                if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
                  run.modelCalls++;
                  const usage = event.data?.usage;
                  const tokens = countUsage(usage);
                  if (tokens !== null) run.tokens += tokens;
                  else run.unknownUsage = true;
                  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
                    if (Number.isSafeInteger(usage?.[key]) && usage[key] >= 0) run.tokenParts.parts[key] += usage[key];
                    else run.tokenParts.complete = false;
                  }
                }
                if (event.type === 'tool/call') run.toolCalls.push({ seq: event.seq, name: event.data.name ?? event.data.call?.name ?? null });
              });
            },
          });
          run.agent = handle.agent; run.handle = handle;
          assertRestrictedSurface(run.agent);
          // Controller-only setup: preserves the production task guard instead of exempting benchmark requests.
          if (payload.variant !== 'plain-agent') {
            const store = openStore(join(home, 'redteam-results', 'results.db'));
            try {
              await dispatchTask(ctx, store, 'task.choose', { sessionId: run.agent.id, mode: 'regular', workflow: 'single', workers: 0, interaction: 'continuous', reporting: 'summary' });
              // 任务设置两条等价路径：
              //   `tool`  —— 调 redteam_task 工具，只落库、不注入开场消息（基准原本的做法）；
              //   `route` —— 调产品自己的 `task.start` 路由（Desktop UI 走的就是这条），会额外注入一条
              //              「请开始桌面已经设置的小任务…」开场消息，随后基准自己再发题面。
              // 冻结的 0.4.92 在同一个宿主里注册方式不同，`ctx.tools.get('redteam_task')` 解析不到，
              // 工具路径会让整个冻结组起不来（2026-10-18 实测）。默认 `auto`：能用工具就用工具，否则回退路由；
              // 显式 `--setup route|tool` 用于把"开场消息"这个变量单独拎出来做归因。
              const setupMode = payload.setup ?? 'tool';
              if (setupMode !== 'tool') throw new Error('formal comparisons require controller-only tool setup before the shared task message');
              const policyInput = {
                mode: 'regular', workflow: 'single', target: lab.origin, question: bridge.brief.question,
                stop: 'budget', budget: { toolCalls: budget.targetRequests + 2, minutes: budget.minutes, workers: 0 },
              };
              // 工具的可见性随变体不同：候选版在插件自己的 ctx 上解析得到，冻结的 0.4.92 只在 agent 作用域里注册。
              // 三个候选位置都试一遍，避免把"作用域没对上"误判成"这个版本没有该工具"。
              let taskTool
              let toolLookup = []
              if (setupMode !== 'route') {
                for (const [label, probe] of [
                  ['ctx.tools.get', () => ctx.tools.get('redteam_task')],
                  ['agent.ctx.tools.get', () => run.agent.ctx?.tools?.get?.('redteam_task')],
                  ['ctx.tools.get(agent.ctx)', () => ctx.tools.get?.('redteam_task', run.agent.ctx)],
                ]) {
                  try { const found = probe(); toolLookup.push([label, typeof found?.execute === 'function']); if (typeof found?.execute === 'function') { taskTool = found; break } }
                  catch (error) { toolLookup.push([label, 'error:' + String(error?.message ?? error).slice(0, 60)]) }
                }
              }
              if (typeof taskTool?.execute === 'function') {
                const prepared = await taskTool.execute({ action: 'start', policy: JSON.stringify(policyInput) },
                  { agent: run.agent, signal: new AbortController().signal });
                if (!prepared?.ok) throw new Error('native task setup failed: ' + prepared?.error);
                run.setupPath = 'tool:' + (toolLookup.at(-1)?.[0] ?? 'ctx.tools.get');
              } else {
                if (setupMode === 'tool') {
                  // 归因用：把"这个变体里工具注册表长什么样"如实记下来，别只报一句"解析不到"。
                  let names = null
                  try { names = ctx.tools.schemas?.(run.agent)?.map(row => row.name) ?? null } catch { names = null }
                  throw new Error('native task setup unavailable: redteam_task tool not reachable; agent tools=' + JSON.stringify(names)
                    + '; lookups=' + JSON.stringify(toolLookup))
                }
                await dispatchTask(ctx, store, 'task.start', { sessionId: run.agent.id, policy: policyInput });
                run.setupPath = 'route';
              }
            } finally { store.close(); }
          }
          // 启动路径也是"口径"的一部分：工具路径不注入开场消息，路由路径会。两者不可直接比较，
          // 所以写进运行事实，由冻结契约逐变体核对（2026-10-18 实测：只换启动路径就能让同一候选
          // 从"预算内成功"变成"60 请求 / 33 万 token 全部超预算"）。
          run.facts.setupPath = payload.variant === 'plain-agent' ? 'none' : (run.setupPath ?? 'unknown')
          runs.set(lab.runId, run);
          run.timer = setTimeout(() => { stop(run, 'time-budget-exhausted').catch(error => ctx.logger.warn(error)); }, budget.minutes * 60000);
          run.timer.unref();
          run.startedAt = new Date().toISOString(); run.clock.start();
          // 开场话术**不能点名任何类别**：这里以前写死"本地访问边界测试"，那是"所有用例都是越权读取"
          // 时代的措辞。2026-10-11 把类别扩到适用性/越权写入/越界文件读取/输出处理/服务端取件之后，
          // 这句话会把模型往访问控制上带 —— 等于在题面里加提示。真正的题面在 bridge.brief.question 里，
          // 这里只负责说明"怎么交"。
          run.agent.followup(createUserMessage({ content: [{ type: 'text', text: '按任务说明完成本轮本地练习，用 exercise_submit 提交结论。caseId 使用下列不透明标识。\n' + json(bridge.brief) }], source: { kind: 'user' } }));
          return { ok: true, value: { runId: lab.runId, sessionId: run.agent.id, directory, preset } };
        } catch (error) { if (handle) await handle.dispose(); if (presetRelease) await presetRelease(); if (lab) await lab.close(); throw error; }
        finally { preparing = false; }
      }
      const run = runs.get(payload.runId);
      if (!run) throw new Error('unknown benchmark run');
      if (endpoint === 'status') {
        if (run.agent.status === 'idle' && !run.stopped) await stop(run, run.stopReason ?? (run.bridge.controller.snapshot().submission ? 'submitted' : 'missing-submission'));
        return { ok: true, value: persist(run) };
      }
      if (endpoint === 'stop') { await stop(run, 'controller-stop'); return { ok: true, value: persist(run) }; }
      throw new Error('unknown benchmark endpoint');
    } catch (error) { return { ok: false, error: error.message }; }
  }, { authority: 'loopback' });
  ctx.effect(() => async () => {
    for (const run of runs.values()) { await stop(run, run.stopReason ?? 'plugin-unloaded'); await run.handle.dispose(); if (run.presetRelease) await run.presetRelease(); }
  }, 'effect benchmark owned agents and labs');
}
