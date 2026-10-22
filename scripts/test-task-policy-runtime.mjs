import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, registerFinding, updateFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { createResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { startTaskPolicy, readTaskPolicy, taskPolicyStatus, taskExecutionGuard, updateTaskProgress } from '../plugins/dsh-redteam-results/lib/task-policy.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-task-policy-'));
process.env.DSH_HOME = home;
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
let store = openStore(path.join(home, 'redteam-results', 'results.db'));
const disposers = [], tools = new Map(), guards = [];
results.apply({ tools: { register: tool => tools.set(tool.name, tool), guard: fn => guards.push(fn) },
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); }, webServer: { register: () => () => {} } });
const exec = sessionId => ({ agent: { session: { id: sessionId, header: { agentPreset: 'pentest' } } } });
const call = (id, args) => tools.get('redteam_task').execute(args, exec(id));
const method = { kind: 'method', mechanism: 'fixture-read', methodVersion: 'v1', endpoint: 'https://fixture.test/api',
  prerequisites: [], dependencies: [], parameters: [], steps: ['Replay the fixture request and compare its response with the normal control.'],
  successCriterion: 'The isolated fixture returns the recorded protected marker.', reviewSteps: 'Repeat the isolated fixture with an independent account.', recovery: 'No persistent fixture changes.',
  verification: { status: 'verified', evidenceIds: ['fixture-response'] } };
function finding(id, patch = {}, reviewPatch = {}) {
  const record = registerFinding(store, id, 'pentest', { title: 'Controlled fixture', severity: 'high', type: 'fixture', target: 'https://fixture.test',
    evidenceLevel: 'impact', impact: 'Isolated fixture exposes the protected marker.', evidence: 'fixture-response', proofKind: 'access',
    requestPkt: 'GET /api HTTP/1.1', responsePkt: 'HTTP/1.1 200 OK\nfixture-marker', reproduction: JSON.stringify(method), ...patch });
  return updateFinding(store, id, 'pentest', record.id, { status: 'verified', secondRating: 'high',
    secondRatingNote: 'Independent controlled fixture replay compared the protected marker with a valid normal control and confirmed the impact.', ...reviewPatch });
}
let failed = 0;
async function test(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); } }
try {
  await test('budget reservation and durable dispatch marker commit together and failed reservations roll back both', () => {
    store.db.exec('CREATE TABLE reservation_fixture (id TEXT PRIMARY KEY)');
    startTaskPolicy(store, 'reservation', { mode: 'regular', budget: { toolCalls: 1 } });
    assert.throws(() => taskExecutionGuard(store, 'reservation', 'recorded-http-execution', Date.now(), { onReserve: () => {
      store.db.prepare('INSERT INTO reservation_fixture (id) VALUES (?)').run('rollback');
      throw new Error('simulated durable marker failure');
    } }), /simulated durable marker failure/);
    assert.equal(readTaskPolicy(store, 'reservation').used.toolCalls, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reservation_fixture').get().n, 0);
    assert.equal(taskExecutionGuard(store, 'reservation', 'recorded-http-execution', Date.now(), { onReserve: () => {
      store.db.prepare('INSERT INTO reservation_fixture (id) VALUES (?)').run('committed');
    } }), undefined);
    assert.equal(readTaskPolicy(store, 'reservation').used.toolCalls, 1);
    assert.equal(store.db.prepare('SELECT id FROM reservation_fixture').get().id, 'committed');
    let reserved = false;
    assert.match(taskExecutionGuard(store, 'reservation', 'recorded-http-execution', Date.now(), { onReserve: () => { reserved = true; } }), /tool_budget_exhausted/);
    assert.equal(reserved, false, 'denied dispatch cannot create an in-flight marker');
  });
  await test('actual registered task tool and monotonic guard stop extra target operations while keeping delivery available', async () => {
    const started = await call('actual', { action: 'start', policy: JSON.stringify({ mode: 'regular', budget: { toolCalls: 2, unmeteredToolCalls: 2 } }) });
    assert.equal(started.ok, true, started.error); assert.equal(started.enforcementAvailable, true);
    assert.equal(guards[0]({ ...exec('actual'), name: 'fetch' }), undefined);
    assert.equal(guards[0]({ ...exec('actual'), name: 'pwsh' }), undefined);
    assert.match(guards[0]({ ...exec('actual'), name: 'fetch' }), /tool_budget_exhausted/);
    assert.equal(guards[0]({ ...exec('actual'), name: 'redteam_delivery' }), undefined);
    assert.equal((await call('actual', { action: 'status' })).policy.used.toolCalls, 2);
    assert.equal((await call('actual', { action: 'start', policy: JSON.stringify({ mode: 'regular', budget: { toolCalls: 99 } }) })).ok, false);
    assert.equal(readTaskPolicy(store, 'actual').budget.toolCalls, 2);
  });
  await test('budget counts survive database reopen and another session never consumes this task budget', () => {
    store.close(); store = openStore(path.join(home, 'redteam-results', 'results.db'));
    assert.equal(taskPolicyStatus(store, 'actual').reason, 'tool_budget_exhausted');
    assert.match(taskExecutionGuard(store, 'other', 'fetch'), /task_policy_missing/);
    assert.equal(readTaskPolicy(store, 'actual').used.toolCalls, 2);
    assert.equal(readTaskPolicy(store, 'other'), null);
  });
  await test('method-orchestration and abstract-workbench tools are retired, refused for every session, and never counted as local work', () => {
    // 批次 A：这些工具已退出运行，任何会话都不再当作本地登记放行。
    for (const name of ['saker_method', 'operation_goal', 'operation_progress', 'operation_intent',
      'operation_scope', 'operation_constraints', 'operation_conclude', 'stage_gate', 'gates_list']) {
      assert.match(taskExecutionGuard(store, 'retired', name), /retired_tool/, name + ' must be refused even without a task policy');
    }
    // A retired tool is refused on name alone: the answer never depends on whether a task policy exists.
    assert.doesNotMatch(String(taskExecutionGuard(store, 'no-policy-here', 'stage_gate')), /task_policy_missing/);
  });
  await test('Nday default never stops on caller verification claims without host execution and independent impact proof', () => {
    for (const [id, patch, reviewPatch, reason] of [
      ['callback', { proofKind: 'interaction' }, {}, ''],
      ['not-run', { reproduction: JSON.stringify({ ...method, verification: { status: 'not-run', evidenceIds: [] } }) }, {}, ''],
      ['low-reviewed', {}, { secondRating: 'low' }, ''],
      ['confirmed', {}, {}, '']
    ]) {
      startTaskPolicy(store, id, { mode: 'nday', budget: { toolCalls: 20, unmeteredToolCalls: 20 } }); finding(id, patch, reviewPatch);
      assert.equal(taskPolicyStatus(store, id).reason, reason, id);
    }
    assert.equal(taskExecutionGuard(store, 'confirmed', 'fetch'), undefined);
  });
  await test('regular and research do not stop at first high finding and explicit RCE and queue rules remain distinct', () => {
    startTaskPolicy(store, 'regular', { mode: 'regular', budget: { toolCalls: 20 } }); finding('regular');
    assert.equal(taskPolicyStatus(store, 'regular').stopped, false);
    updateTaskProgress(store, 'regular', { planComplete: true }); assert.equal(taskPolicyStatus(store, 'regular').reason, 'plan_complete');
    startTaskPolicy(store, 'rce', { mode: 'nday', stop: 'first-rce', budget: { toolCalls: 20 } }); finding('rce');
    assert.equal(taskPolicyStatus(store, 'rce').stopped, false);
    finding('rce', { proofKind: 'execution' }); assert.equal(taskPolicyStatus(store, 'rce').stopped, false);
    startTaskPolicy(store, 'queue', { mode: 'nday', stop: 'queue', budget: { toolCalls: 20 } }); finding('queue');
    assert.equal(taskPolicyStatus(store, 'queue').stopped, false);
    updateTaskProgress(store, 'queue', { queueComplete: true }); assert.equal(taskPolicyStatus(store, 'queue').reason, 'queue_complete');
    assert.throws(() => updateTaskProgress(store, 'queue', { queueComplete: false }), /cannot be reopened/);
  });
  await test('time deadline cancellation malformed progress and unsupported hosts cannot silently reset or evade task limits', async () => {
    startTaskPolicy(store, 'deadline', { mode: 'regular', budget: { toolCalls: 5, minutes: 1 } }, 1000);
    assert.equal(taskPolicyStatus(store, 'deadline', 60999).stopped, false);
    assert.match(taskExecutionGuard(store, 'deadline', 'fetch', 61000), /time_budget_exhausted/);
    assert.throws(() => updateTaskProgress(store, 'deadline', { budget: { toolCalls: 99 } }));
    assert.equal((await call('regular', { action: 'cancel' })).reason, 'cancelled');
    assert.equal((await call('actual', { action: 'status', sessionId: 'other' })).reason, 'tool_budget_exhausted');
    assert.equal((await tools.get('redteam_task').execute({ action: 'status' }, { agent: { session: { id: 'actual', header: { agentPreset: 'code-audit' } } } })).ok, false);
    for (const budget of [{ toolCalls: -1 }, { toolCalls: 10, discoveryCalls: 11 }, { toolCalls: 10.5, discoveryCalls: 1 }]) {
      assert.throws(() => startTaskPolicy(store, 'bad', { mode: '0day', budget }));
      assert.equal(readTaskPolicy(store, 'bad'), null);
    }
    const oldTools = new Map();
    results.apply({ tools: { register: tool => oldTools.set(tool.name, tool) }, effect: () => {}, webServer: {} });
    assert.equal((await oldTools.get('redteam_task').execute({ action: 'start', policy: JSON.stringify({ mode: 'regular', budget: { toolCalls: 10 } }) }, exec('old-host'))).ok, false);
    assert.equal(readTaskPolicy(store, 'old-host'), null);
  });
} finally {
  for (const dispose of disposers.reverse()) await dispose();
  store.close(); fs.rmSync(home, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
