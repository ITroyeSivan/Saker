import assert from 'node:assert/strict';
import http from 'node:http';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { chooseTaskMode, startTaskPolicy, readTaskPolicy, taskExecutionGuard, setTaskActionLimits } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createPurposeTasks } from '../plugins/dsh-redteam-results/lib/purpose-tasks.js';
import { createSiteWorkers } from '../plugins/dsh-redteam-results/lib/site-workers.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { captureTaskCost, taskCostOverview } from '../plugins/dsh-redteam-results/lib/task-cost.js';
import { executionLedger } from '../plugins/dsh-redteam-results/lib/execution-view.js';
import { executeRecordedRequest } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { reserveModelCall, dispatchModelCall, settleModelCall } from '../plugins/dsh-redteam-results/lib/model-budget.js';
import { ownedPurposeTasks } from '../plugins/dsh-redteam-results/lib/task-policy-record.js';

const parent = (store, id, target = 'http://127.0.0.1:1', options = {}) => {
  chooseTaskMode(store, id, 'regular', { workers: 1, ...options });
  startTaskPolicy(store, id, { mode: 'regular', target, budget: { toolCalls: 20, modelCalls: 12, workers: 1 } });
  saveTaskContext(store, id, { assets: [{ id: 'a', url: target, inScope: true, reachable: true }] });
  return { session: { id, header: { agentPreset: 'pentest' } } };
};
let failed = 0;
async function test(name, work) {
  try { await work(); console.log('ok   ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error.stack || error)); }
}
await test('report policy blocks the real HTTP executor before the loopback server receives a request', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.end('private fixture'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = openStore(':memory:'), target = 'http://127.0.0.1:' + server.address().port;
  const agent = parent(store, 'report-network', target);
  const tasks = createPurposeTasks({ subagents: { async startActivation(spec) {
    const child = readTaskPolicy(store, spec.childId);
    assert.equal(child.allowTargetNetwork, false);
    saveTaskContext(store, spec.childId, { assets: [{ id: 'a', url: target, inScope: true, reachable: true }],
      requests: [{ id: 'r', revision: 'v1', endpoint: target + '/private', authContext: 'fixture', kind: 'web', valid: false,
        request: 'GET /private HTTP/1.1\r\nHost: ' + new URL(target).host + '\r\n\r\n', response: 'HTTP/1.1 200 OK\r\n\r\nfixture' }] });
    await assert.rejects(executeRecordedRequest(store, spec.childId, { purpose: 'first-contact', requestId: 'r', requestRevision: 'v1' }), /target_network_disabled|关闭/);
    assert.match(taskExecutionGuard(store, spec.childId, 'pwsh', Date.now(), { args: {} }), /worker_tool_not_allowed/);
    return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} };
  } } }, () => store);
  try { assert.equal((await tasks.run(agent, 'report')).ok, true); assert.equal(hits, 0); }
  finally { await tasks.dispose(); store.close(); await new Promise(resolve => server.close(resolve)); }
});
await test('uncertain release reserves capacity until a later successful cleanup', async () => {
  const store = openStore(':memory:'), agent = parent(store, 'uncertain');
  let starts = 0, rejectRelease = true;
  const tasks = createPurposeTasks({ subagents: { async startActivation() {
    starts++;
    return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => { if (rejectRelease) throw Error('release unknown'); } };
  } } }, () => store);
  try {
    const first = await tasks.run(agent, 'review');
    assert.equal(first.ok, false); assert.equal(first.cleanupFailed, true); assert.equal(tasks.activeCount(), 1);
    assert.equal(readTaskPolicy(store, first.childId).activationState, 'cleanup-failed');
    await assert.rejects(tasks.run(agent, 'report'), /worker limit/); assert.equal(starts, 1);
    rejectRelease = false; assert.deepEqual(await tasks.cleanup(agent), []);
    assert.equal((await tasks.run(agent, 'report')).ok, true); assert.equal(starts, 2);
  } finally { rejectRelease = false; await tasks.dispose(); store.close(); }
});
await test('all purpose costs belong to the parent even after release', async () => {
  const store = openStore(':memory:'), agent = parent(store, 'cost');
  const tasks = createPurposeTasks({ subagents: { async startActivation(spec) {
    captureTaskCost(store, { id: spec.childId }, { seq: 1, time: Date.now(), type: 'assistant/message', data: { usage: { totalTokens: 90 } } });
    return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} };
  } } }, () => store);
  try {
    captureTaskCost(store, agent.session, { seq: 1, time: Date.now(), type: 'assistant/message', data: { usage: { totalTokens: 10 } } });
    await tasks.run(agent, 'review');
    const cost = taskCostOverview({}, store, 'cost');
    assert.equal(cost.totalTokens, 100); assert.equal(cost.modelCalls, 2);
  } finally { await tasks.dispose(); store.close(); }
});
await test('agent scoped tools excluded by visibility API remain denied by the dispatch guard', async () => {
  const store = openStore(':memory:'), agent = parent(store, 'scope'), hooks = new Map();
  store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)')
    .run('scope', 'child', 'http://127.0.0.1:1', JSON.stringify({ parentId: 'scope', childId: 'child', state: 'starting', allowedTools: ['read'] }));
  startTaskPolicy(store, 'child', { mode: 'regular', parentSession: 'scope', budget: { toolCalls: 4, workers: 0 } });
  let dispatchGuard;
  const manager = createSiteWorkers({ on: (name, fn) => hooks.set(name, fn) }, () => store);
  try {
    await hooks.get('agent/created')({ agent: { session: { id: 'child' }, ctx: { tools: {
      schemas: () => ['read', 'write', 'custom_scoped_write'].map(name => ({ name })),
      guard(fn) { dispatchGuard = fn; return () => {}; },
      restrict({ deny }) { if (deny.includes('custom_scoped_write')) throw Error('unknown global tool "custom_scoped_write"'); return () => {}; },
    } } } });
    assert.match(taskExecutionGuard(store, 'child', 'custom_scoped_write'), /worker_tool_not_allowed/);
    assert.match(dispatchGuard({ agent: { session: { id: 'child' } }, name: 'custom_scoped_write' }), /worker_tool_not_allowed/);
    assert.match(taskExecutionGuard(store, 'child', 'write'), /worker_tool_not_allowed/);
    assert.equal(taskExecutionGuard(store, 'child', 'read'), undefined);
  } finally { await manager.dispose(); store.close(); }
});
await test('HTTPS raw requests and unknown network tools require explicit unmetered quota', async () => {
  const store = openStore(':memory:'); parent(store, 'tls', 'https://127.0.0.1:1');
  try {
    for (const args of [{ https: true, request: 'GET / HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n' },
      { https: false, host: '127.0.0.1', port: 1 }, { batch: [{ isHttps: true, host: '127.0.0.1:1' }] }, {}])
      assert.match(taskExecutionGuard(store, 'tls', 'mcp_http', Date.now(), { args }), /unmetered_target_traffic/);
    assert.equal(taskExecutionGuard(store, 'tls', 'knowledge_search', Date.now(), { args: { query: 'offline' } }), undefined);
  } finally { store.close(); }
});
await test('a historical HTTP receipt never hides an unrelated successful tool call', async () => {
  const store = openStore(':memory:'); parent(store, 'ledger');
  try {
    store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run('ledger', 'old', JSON.stringify({ id: 'old', outcome: 'completed', endpoint: 'http://127.0.0.1:1', callId: 'old-call' }));
    for (const [seq, callId] of [[1, 'new-call'], [3, 'old-call']]) {
      captureTaskCost(store, { id: 'ledger' }, { seq, time: Date.now(), type: 'tool/call', data: { name: 'redteam_execution', callId } });
      captureTaskCost(store, { id: 'ledger' }, { seq: seq + 1, time: Date.now(), type: 'tool/result', data: { message: { name: 'redteam_execution', toolCallId: callId } } });
    }
    const ledger = executionLedger(store, 'ledger');
    assert(ledger.rows.some(row => row.id === 'tool-new-call'));
    assert(!ledger.rows.some(row => row.id === 'tool-old-call'));
    assert.equal(ledger.counts.all, 2);
  } finally { store.close(); }
});
await test('dispatch totals include auxiliary calls and failed retries without double counting session messages', async () => {
  const store = openStore(':memory:'); const agent = parent(store, 'wire-cost');
  try {
    for (const [purpose, total] of [['conversation', 10], ['title', 20], ['conversation', null]]) {
      const call = reserveModelCall(store, agent.session.id, { provider: 'fixture', model: 'fixture', purpose });
      assert.equal(call.ok, true); assert.equal(dispatchModelCall(store, call.id), true);
      settleModelCall(store, call.id, total === null ? { reason: 'failed wire' }
        : { complete: true, usage: { inputTokens: total, outputTokens: 0, totalTokens: total } });
    }
    captureTaskCost(store, agent.session, { seq: 1, time: Date.now(), type: 'assistant/message', data: { usage: { totalTokens: 10 } } });
    const cost = taskCostOverview({}, store, agent.session.id);
    assert.equal(cost.totalTokens, 30); assert.equal(cost.modelCalls, 3); assert.equal(cost.auxiliaryCalls, 1);
    assert.equal(cost.unknownUsageCalls, 1); assert.match(cost.source, /dispatch-ledger/);
  } finally { store.close(); }
});
await test('cancelling a starting purpose task prevents native dispatch and returns its reservation', async () => {
  const store = openStore(':memory:'); const agent = parent(store, 'cancel-start', 'http://127.0.0.1:1', { reviewModel: { provider: 'fixture', model: 'fixture' } });
  let prepared, releasePreflight, starts = 0;
  const preparing = new Promise(resolve => { prepared = resolve; });
  const pending = new Promise(resolve => { releasePreflight = resolve; });
  const tasks = createPurposeTasks({ llm: { async resolveModelInfo() { prepared(); await pending; } },
    subagents: { async startActivation() { starts++; throw Error('must not dispatch'); } } }, () => store);
  try {
    const result = tasks.run(agent, 'review').catch(error => error);
    await preparing;
    const cancelling = tasks.cleanup(agent); releasePreflight();
    assert.match(String(await result), /abort/i); assert.deepEqual(await cancelling, []);
    assert.equal(starts, 0); assert.equal(tasks.activeCount(), 0);
  } finally { await tasks.dispose(); store.close(); }
});
await test('malformed owned purpose records block admission rather than disappearing from the count', async () => {
  const store = openStore(':memory:'); parent(store, 'bad-owner');
  try {
    store.db.prepare('INSERT INTO task_policy(session_id,parent_session,task_kind,record,updated_at) VALUES(?,?,?,?,?)')
      .run('corrupt-child', 'bad-owner', 'purpose', '{broken', new Date().toISOString());
    assert.throws(() => ownedPurposeTasks(store, 'bad-owner'), /task_policy|JSON|损坏/);
  } finally { store.close(); }
});
await test('explicit unmetered quota still enforces TLS origins, every batch address and enforceable request limits', async () => {
  const store = openStore(':memory:');
  try {
    startTaskPolicy(store, 'scope-limits', { mode: 'regular', target: 'https://fixture.test:8443',
      budget: { toolCalls: 10, unmeteredToolCalls: 10 } });
    const raw = { https: true, request: 'GET /allowed HTTP/1.1\r\nHost: fixture.test:8443\r\n\r\n' };
    assert.equal(taskExecutionGuard(store, 'scope-limits', 'mcp_http', Date.now(), { args: raw }), undefined);
    assert.match(taskExecutionGuard(store, 'scope-limits', 'mcp_http', Date.now(), { args: { ...raw, https: false } }), /outside_scope/);
    assert.match(taskExecutionGuard(store, 'scope-limits', 'mcp_http', Date.now(), { args: { batch: [raw, { https: true, host: 'outside.test' }] } }), /outside_scope/);
    setTaskActionLimits(store, 'scope-limits', { excludedPaths: ['/private'] }, 'desktop-user');
    assert.match(taskExecutionGuard(store, 'scope-limits', 'mcp_http', Date.now(), { args: { ...raw, request: raw.request.replace('/allowed', '/private') } }), /excluded/);
    setTaskActionLimits(store, 'scope-limits', { readOnly: true }, 'desktop-user');
    assert.match(taskExecutionGuard(store, 'scope-limits', 'mcp_http', Date.now(), { args: raw }), /read_only_unverified/);
    assert.equal(readTaskPolicy(store, 'scope-limits').used.unmeteredToolCalls, 1, 'refused calls never consume the allowance');
  } finally { store.close(); }
});
await test('offline review and report accept a parent task with no website address', async () => {
  const store = openStore(':memory:');
  chooseTaskMode(store, 'offline-purpose', 'regular', { workers: 1, allowTargetNetwork: false });
  startTaskPolicy(store, 'offline-purpose', { mode: 'regular', question: 'Review existing material only', budget: { toolCalls: 12, modelCalls: 12, workers: 1 } });
  let starts = 0;
  const tasks = createPurposeTasks({ subagents: { async startActivation(spec) {
    starts++;
    const child = readTaskPolicy(store, spec.childId);
    assert.equal(child.target, ''); assert.equal(child.allowTargetNetwork, false);
    return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} };
  } } }, () => store);
  try {
    const agent = { session: { id: 'offline-purpose', header: { agentPreset: 'pentest' } } };
    assert.equal((await tasks.run(agent, 'review')).ok, true);
    assert.equal((await tasks.run(agent, 'report')).ok, true);
    assert.equal(starts, 2); assert.equal(tasks.activeCount(), 0);
  } finally { await tasks.dispose(); store.close(); }
});
await test('starting managed accounting preserves earlier historical session usage', async () => {
  const store = openStore(':memory:'); const agent = parent(store, 'mixed-cost');
  try {
    captureTaskCost(store, agent.session, { seq: 1, time: Date.now() - 1000, type: 'assistant/message', data: { usage: { totalTokens: 100 } } });
    const call = reserveModelCall(store, agent.session.id, { provider: 'fixture', model: 'fixture', purpose: 'conversation' });
    assert(call.ok); dispatchModelCall(store, call.id);
    settleModelCall(store, call.id, { complete: true, usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 } });
    captureTaskCost(store, agent.session, { seq: 2, time: Date.now(), type: 'assistant/message', data: { usage: { totalTokens: 10 } } });
    const cost = taskCostOverview({}, store, agent.session.id);
    assert.equal(cost.totalTokens, 110); assert.equal(cost.modelCalls, 2);
  } finally { store.close(); }
});
await test('MCP catalog lookup works without a target task while execution remains guarded', async () => {
  const store = openStore(':memory:');
  try {
    assert.equal(taskExecutionGuard(store, 'catalog', 'mcp_search', Date.now(), { args: { server: 'burp', query: 'base64' } }), undefined);
    assert.equal(taskExecutionGuard(store, 'catalog', 'mcp_call', Date.now(), { args: { server: 'yakit', tool: 'encode', args: { type: 'base64', text: 'Saker' } } }), undefined);
    assert.equal(taskExecutionGuard(store, 'catalog', 'mcp_call', Date.now(), { args: { server: 'yakit', tool: 'decode', args: { type: 'base64', text: 'U2FrZXI=' } } }), undefined);
    for (const args of [{ server: 'yakit', tool: 'exec_codec', args: { workFlow: [{ codecType: 'CustomCodecPlugin' }] } },
      { server: 'yakit', tool: 'encode', args: { type: 'script', text: 'Saker' } },
      { server: 'yakit', tool: 'encode', args: { type: 'base64', text: 'Saker', command: 'unexpected' } }])
      assert.match(taskExecutionGuard(store, 'catalog', 'mcp_call', Date.now(), { args }), /task_policy_missing/);
    assert.match(taskExecutionGuard(store, 'catalog', 'mcp_call', Date.now(), { args: { server: 'burp', tool: 'send_http_request', arguments: {} } }), /task_policy_missing/);
    chooseTaskMode(store, 'catalog', 'regular', { allowTargetNetwork: false });
    startTaskPolicy(store, 'catalog', { mode: 'regular', budget: { toolCalls: 5, modelCalls: 5, workers: 0 } });
    setTaskActionLimits(store, 'catalog', { allowTargetNetwork: false }, 'desktop-user');
    assert.equal(taskExecutionGuard(store, 'catalog', 'mcp_search', Date.now(), { args: { server: 'burp', query: 'http://example.invalid/' } }), undefined);
    assert.match(taskExecutionGuard(store, 'catalog', 'mcp_call', Date.now(), { args: { server: 'burp', tool: 'send_http_request', arguments: {} } }), /target_network_disabled/);
  } finally { store.close(); }
});
await test('local benchmark submission stays available when target access is disabled', async () => {
  const store = openStore(':memory:');
  try {
    const agent = parent(store, 'submit-local');
    setTaskActionLimits(store, agent.session.id, { allowTargetNetwork: false }, 'desktop-user');
    assert.equal(taskExecutionGuard(store, agent.session.id, 'exercise_submit', Date.now(), { args: { outcome: 'no-finding', evidenceIds: '[]' } }), undefined);
    assert.match(taskExecutionGuard(store, agent.session.id, 'exercise_request', Date.now(), { args: { url: 'http://127.0.0.1:1' } }), /target_network_disabled/);
  } finally { store.close(); }
});
process.exitCode = failed ? 1 : 0;
