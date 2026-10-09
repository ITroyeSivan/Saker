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
import { dispatch as dispatchTask, openStore } from '@dsh-external/dsh-redteam-results';
import { createEffectLab } from './lab.mjs';
import { createAgentInterface, mountRestrictedAgent, assertRestrictedSurface, countUsage } from './agent-interface.mjs';
import { resolveComparisonPreset, freezeSingleAgentRows, createRunClock, createRunStopper } from './runtime.mjs';
import { assessRunQualification } from './protocol.mjs';

export const name = 'saker-effect-benchmark';
export const inject = ['agents', 'agentPresets', 'connection', 'tools', 'sessions', 'webServer'];
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2);

export function apply(ctx) {
  const runs = new Map();
  let preparing = false;
  const persist = run => {
    const result = {
      interfaceVersion: run.bridge.version, caseId: run.lab.caseId, runId: run.lab.runId,
      sessionId: run.agent.id, variant: run.variant, sakerVersion: saker.version,
      model: run.model, provider: run.provider, toolDigest: run.toolDigest, accessDigest: run.bridge.accessDigest,
      preset: run.preset, presetCompositionDigest: run.presetCompositionDigest,
      sourcePreset: run.sourcePreset, sourcePresetCompositionDigest: run.sourcePresetCompositionDigest,
      presetAdjustments: run.presetAdjustments,
      budget: run.budget, startedAt: run.startedAt, elapsedMs: run.clock.elapsedMs(),
      durationFinal: run.clock.finished, cleanupComplete: run.stopped === true,
      status: run.agent.status, stopReason: run.stopReason ?? null,
      isolationFailures: run.isolationFailures, toolCalls: run.toolCalls,
      usage: { modelCalls: run.modelCalls, tokens: run.unknownUsage ? null : run.tokens, knownTokens: run.tokens,
        unknownUsage: run.unknownUsage, elapsedMs: run.clock.elapsedMs(), humanInterventions: 0 },
      submission: run.bridge.controller.snapshot().submission,
      score: run.bridge.controller.grade(),
      comparability: { comparable: false, mismatches: ['budget-not-calibrated', 'frozen-three-group-comparison-not-run'] },
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
        defaultPreset: ctx.agentPresets.defaultId, presets: await ctx.agentPresets.list() } };
      if (endpoint === 'start') {
        if (preparing || [...runs.values()].some(run => !run.stopped)) throw new Error('one calibration run at a time');
        if (!['candidate', 'plain-agent', 'saker-0.4.92'].includes(payload.variant)) throw new Error('explicit comparison variant required');
        if (payload.variant === 'saker-0.4.92' && saker.version !== '0.4.92') throw new Error('frozen baseline version is not installed');
        for (const key of ['provider', 'model']) if (typeof payload[key] !== 'string' || !payload[key].trim()) throw new Error(`explicit ${key} required`);
        const budget = payload.budget;
        if (!budget || !['minutes', 'targetRequests', 'tokens'].every(key => Number.isSafeInteger(budget[key]) && budget[key] > 0)
          || budget.minutes > 30 || budget.targetRequests > 200 || budget.tokens > 1500000) throw new Error('invalid calibration budget');
        preparing = true;
        let lab, handle, presetRelease;
        try {
          lab = await createEffectLab(payload.caseId, { maxRequests: budget.targetRequests });
          const bridge = createAgentInterface(lab);
          const directory = mkdtempSync(join(tmpdir(), 'saker-effect-desktop-'));
          const cwd = join(directory, 'agent'); mkdirSync(cwd);
          const selection = await resolveComparisonPreset(ctx.agentPresets, payload.variant);
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
          const run = { lab, bridge, directory, variant: payload.variant, provider: payload.provider, model: payload.model,
            preset, presetRelease, presetCompositionDigest: compositionDigest, presetAdjustments,
            sourcePreset: selection.id, sourcePresetCompositionDigest: selection.compositionDigest,
            budget: structuredClone(budget), clock: createRunClock(), startedAt: null,
            modelCalls: 0, tokens: 0, unknownUsage: false, toolCalls: [], isolationFailures: [] };
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
            agentOptions: { provider: payload.provider, model: payload.model, maxTokens: Math.min(4096, budget.tokens) },
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
                }
                if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
                  run.modelCalls++;
                  const tokens = countUsage(event.data.usage);
                  if (tokens !== null) run.tokens += tokens;
                  else run.unknownUsage = true;
                }
                if (event.type === 'tool/call') run.toolCalls.push({ seq: event.seq, name: event.data.name ?? event.data.call?.name ?? null });
              });
            },
          });
          run.agent = handle.agent; run.handle = handle;
          assertRestrictedSurface(run.agent);
          // Controller-only setup: preserves the production task guard instead of exempting benchmark requests.
          if (payload.variant !== 'plain-agent') {
            const store = openStore(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'redteam-results', 'results.db'));
            try { await dispatchTask(ctx, store, 'task.choose', { sessionId: run.agent.id, mode: 'regular', workflow: 'single', workers: 0, interaction: 'continuous', reporting: 'summary' }); }
            finally { store.close(); }
            const prepared = await ctx.tools.get('redteam_task').execute({ action: 'start', policy: JSON.stringify({
              mode: 'regular', workflow: 'single', target: lab.origin, question: bridge.brief.question,
              stop: 'budget', budget: { toolCalls: budget.targetRequests + 2, minutes: budget.minutes, workers: 0 },
            }) }, { agent: run.agent, signal: new AbortController().signal });
            if (!prepared.ok) throw new Error('native task setup failed: ' + prepared.error);
          }
          runs.set(lab.runId, run);
          run.timer = setTimeout(() => { stop(run, 'time-budget-exhausted').catch(error => ctx.logger.warn(error)); }, budget.minutes * 60000);
          run.timer.unref();
          run.startedAt = new Date().toISOString(); run.clock.start();
          run.agent.followup(createUserMessage({ content: [{ type: 'text', text: '完成本轮本地访问边界测试，用 exercise_submit 提交结论。caseId 使用下列不透明标识。\n' + json(bridge.brief) }], source: { kind: 'user' } }));
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
