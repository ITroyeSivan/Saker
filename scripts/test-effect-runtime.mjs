import assert from 'node:assert/strict';
import { resolveComparisonPreset, freezeSingleAgentRows, createRunClock, createRunStopper } from '../benchmarks/task-effects/runtime.mjs';

let failed = 0;
async function test(label, body) { try { await body(); console.log('ok ' + label); } catch (error) { failed++; console.error('FAIL ' + label + ': ' + error.stack); } }
await test('plain control uses standard even when the native default is pentest', async () => {
  const calls = [];
  const registry = { async resolve(id) { calls.push(id); return { id: id ?? 'pentest' }; },
    async readDocument(id) { assert.equal(id, 'standard'); return { content: "- name: '@deepseek-ai/dsh-persona'" }; } };
  const selection = await resolveComparisonPreset(registry, 'plain-agent');
  assert.equal(selection.id, 'standard'); assert.deepEqual(calls, ['standard']);
  assert.match(selection.compositionDigest, /^[a-f0-9]{64}$/);
});
await test('missing, broken and customized Saker standard presets cannot enter the plain group', async () => {
  for (const content of ["- name: '@dsh-external/dsh-stage-gate'", "- name: 'dsh-saker'"]) {
    await assert.rejects(() => resolveComparisonPreset({ resolve: async id => ({ id }), readDocument: async () => ({ content }) }, 'plain-agent'), /contaminated/);
  }
  await assert.rejects(() => resolveComparisonPreset({ resolve: async () => ({ id: 'standard', broken: 'waiting dependency' }) }, 'plain-agent'), /unavailable/);
  await assert.rejects(() => resolveComparisonPreset({ resolve: async () => ({ id: 'pentest' }) }, 'plain-agent'), /unavailable/);
  const selection = await resolveComparisonPreset({ resolve: async id => ({ id }), readDocument: async () => ({ content: 'Saker preset' }) }, 'candidate');
  assert.equal(selection.id, 'pentest');
});
await test('native idle seals elapsed time before delayed polling or cleanup; start and end are idempotent', () => {
  let now = 100;
  const clock = createRunClock(() => now);
  assert.equal(clock.elapsedMs(), null); clock.end(); assert.equal(clock.finished, false);
  clock.start(); now = 125; clock.start(); assert.equal(clock.elapsedMs(), 25);
  clock.end(); now = 10000; clock.end(); assert.equal(clock.elapsedMs(), 25); assert(clock.finished);
});
await test('zero-worker standard copy disables only dynamic subagent model selection without changing the source', () => {
  const source = [{ name: 'cordis:group', group: true, config: [{ name: '@deepseek-ai/dsh-tool-subagent', config: { modelSelectionSettings: true, provider: 'spawn' } },
    { name: '@deepseek-ai/dsh-persona', config: { prefix: 'Original persona' } }] }];
  const frozen = freezeSingleAgentRows(source);
  assert.equal(frozen.changed, 1); assert.equal(frozen.rows[0].config[0].config.modelSelectionSettings, false);
  assert.equal(source[0].config[0].config.modelSelectionSettings, true);
  assert.equal(frozen.rows[0].config[0].config.provider, 'spawn');
  assert.deepEqual(frozen.rows[0].config[1], source[0].config[1]);
});
await test('concurrent stops wait for the same cleanup and preserve the first reason', async () => {
  let release, called = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const stop = createRunStopper(async reason => { called++; await gate; return reason; });
  const first = stop('submitted'), second = stop('time-limit');
  assert.equal(first, second);
  await Promise.resolve(); assert.equal(called, 1);
  let settled = false; second.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  release(); assert.equal(await first, 'submitted'); assert.equal(await second, 'submitted');
  assert.equal(await stop('polling'), 'submitted'); assert.equal(called, 1);
});
await test('a cleanup failure remains a failure for all stop callers', async () => {
  let called = 0;
  const stop = createRunStopper(async () => { called++; throw new Error('lab could not close'); });
  await assert.rejects(stop('stop'), /lab could not close/);
  await assert.rejects(stop('again'), /lab could not close/); assert.equal(called, 1);
});
process.exitCode = failed ? 1 : 0;
