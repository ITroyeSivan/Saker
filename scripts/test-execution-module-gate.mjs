import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy, readTaskPolicy, pauseTaskPolicy, resumeTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { executeRecordedRequest, readExecutionReceipt, preflightRecordedRequest } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { moduleGateFor, rootModuleSelection } from '../plugins/dsh-redteam-results/lib/execution-modules.js';
import { moduleInitialization } from '../plugins/dsh-method-stack/lib/selection-config.js';
import { taskModuleSelection, saveTaskModules } from '../plugins/dsh-redteam-results/lib/task-modules.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-content-gate-'));
process.env.DSH_HOME = home;
const dbPath = path.join(home, 'redteam-results/results.db');
let store = openStore(dbPath), failed = 0;
const received = [];
const server = http.createServer((req, res) => { received.push({ url: req.url, auth: req.headers.authorization ?? '' }); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fixture response'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/object';
const host = new URL(endpoint).host;
const packet = () => 'GET /api/object HTTP/1.1\r\nHost: ' + host + '\r\nAuthorization: fixture\r\n\r\n';
const request = { id: 'normal', revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request: packet(), response: 'HTTP/1.1 200 OK\r\n\r\nfixture baseline', inputs: [{ name: 'id', location: 'query', evidenceIds: ['normal'] }] };
const context = () => ({ assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [request], methods: [] });
const ALL = moduleInitialization(home, 'fixture', 'regular').keys;
// Structured execution no longer requires a method classification; the caller selects
// which test content it is exercising, and only that stable id is gated.
const input = (patch = {}) => ({ hypothesisId: 'direction', requestId: 'normal', requestRevision: 'v1', contentKeys: ['sqli'], ...patch });
const setContent = (sid, active) => {
  const config = moduleInitialization(home, sid, 'regular');
  const current = taskModuleSelection(store, sid, config);
  return saveTaskModules(store, sid, { mode: current.mode, active, rev: current.rev, policyRev: current.policyRev }, config);
};
function setup(sid, budget = 20) {
  startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: budget, discoveryCalls: 3 } });
  saveTaskContext(store, sid, context());
  createResearch(store, sid, { id: 'direction', requestId: 'normal', requestRevision: 'v1', controlledInputs: [{ name: 'id', location: 'query' }],
    title: 'Fixture content gate', serverPath: 'Local fixture', boundary: 'Synthetic comparison', normalBehavior: 'Fixture own response',
    supportCriterion: 'A separately assessed controlled effect', falsifier: 'No controlled effect', nextInformation: 'Read the actual response',
    knownCheck: { outcome: 'not-assessed', rationale: 'No product claim', sources: [] } });
}
async function test(label, fn) { try { await fn(); console.log('ok   ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }
try {
  await test('an enabled test content lets the probe reach the fixture and records the content requirement and policy', async () => {
    setup('enabled');
    const before = received.length;
    const result = await executeRecordedRequest(store, 'enabled', input());
    assert.equal(received.length, before + 1, 'an enabled content must still dispatch');
    const detail = readExecutionReceipt(store, 'enabled', result.id);
    assert.deepEqual(detail.contentRequirement, ['sqli'], 'the receipt records which test content was exercised');
    assert.equal(detail.methodClassification, undefined, 'no method classification is bound to execution anymore');
    assert(detail.modulePolicy.policyRev >= 1);
    assert(detail.modulePolicy.active.includes('sqli'));
  });

  await test('closing the test content blocks the probe and nothing reaches the fixture or the budget', async () => {
    setup('closed');
    setContent('closed', ALL.filter(key => key !== 'sqli'));
    const before = received.length, policy = readTaskPolicy(store, 'closed');
    await assert.rejects(executeRecordedRequest(store, 'closed', input()), /module_disabled/);
    assert.equal(received.length, before, 'a closed content must not send the request');
    assert.equal(readTaskPolicy(store, 'closed').used.toolCalls, policy.used.toolCalls, 'a refused dispatch must not consume the tool budget');
    assert.equal(readTaskPolicy(store, 'closed').policyRev, policy.policyRev, 'the in-transaction content check must refuse before any reservation');
    assert.throws(() => preflightRecordedRequest(store, 'closed', input()), /module_disabled/);
  });

  await test('an empty test-content selection blocks every structured dispatch with a concrete reason', async () => {
    setup('empty');
    const before = received.length;
    setContent('empty', []);
    await assert.rejects(executeRecordedRequest(store, 'empty', input()), /all_content_disabled/);
    assert.equal(received.length, before);
  });

  await test('a caller-supplied content name is not permission, and an unknown key is refused', async () => {
    setup('forged');
    setContent('forged', ALL.filter(key => key !== 'sqli'));
    const before = received.length;
    await assert.rejects(executeRecordedRequest(store, 'forged', input({ contentKeys: ['sqli'], modules: ['sqli'], category: 'sqli' })), /module_disabled/);
    // An unknown content key is not in the catalog and therefore cannot authorize anything.
    const forgedDenial = moduleGateFor(store, 'forged', ['not-a-real-check'])();
    assert.match(String(forgedDenial), /module_disabled|未知测试内容/, 'an unknown content key must not authorize execution');
    assert.equal(received.length, before);
  });

  await test('a child session follows the root task current content and cannot widen it', async () => {
    setup('root');
    store.db.prepare('INSERT INTO site_workers (parent_session,child_id,site,record) VALUES (?,?,?,?)')
      .run('root', 'child', new URL(endpoint).origin, JSON.stringify({ state: 'running', site: new URL(endpoint).origin, allowedTools: ['redteam_execution'] }));
    startTaskPolicy(store, 'child', { mode: 'regular', budget: { toolCalls: 5, workers: 0 } });
    saveTaskContext(store, 'child', context());
    createResearch(store, 'child', { id: 'direction', requestId: 'normal', requestRevision: 'v1', controlledInputs: [{ name: 'id', location: 'query' }],
      title: 'Child fixture gate', serverPath: 'Local fixture', boundary: 'Synthetic comparison', normalBehavior: 'Fixture own response',
      supportCriterion: 'A separately assessed controlled effect', falsifier: 'No controlled effect', nextInformation: 'Read the actual response',
      knownCheck: { outcome: 'not-assessed', rationale: 'No product claim', sources: [] } });
    const root = rootModuleSelection(store, 'child');
    assert.equal(root.selection.owner, 'root', 'a child must resolve the root owner');
    assert.equal(root.selection.inherited, true);
    setContent('root', ALL.filter(key => key !== 'sqli'));
    const before = received.length;
    await assert.rejects(executeRecordedRequest(store, 'child', input()), /module_disabled/);
    assert.equal(received.length, before);
    assert.throws(() => setContent('child', ALL), /主任务/);
    setContent('root', ALL);
    const result = await executeRecordedRequest(store, 'child', input());
    assert.equal(received.length, before + 1);
    assert.equal(readExecutionReceipt(store, 'child', result.id).modulePolicy.active.includes('sqli'), true);
  });

  await test('a content closed between admission and dispatch is caught before the network and the reservation is released', async () => {
    setup('race');
    // 用一个触发器模拟"另一个进程在准入后、派发前关掉了内容"：预留写 task_policy 时把 modules 清空。
    store.db.exec("CREATE TRIGGER close_module_after_reserve AFTER UPDATE ON task_policy WHEN NEW.session_id='race' "
      + "BEGIN UPDATE task_policy SET record=json_set(NEW.record,'$.modules', json('[]')) WHERE session_id='race'; END");
    const before = received.length, budget = readTaskPolicy(store, 'race').used.toolCalls;
    try {
      await assert.rejects(executeRecordedRequest(store, 'race', input()), /已准入、未派发/);
    } finally { store.db.exec('DROP TRIGGER close_module_after_reserve'); }
    assert.equal(received.length, before, 'the late check must stop the request before the network');
    assert.equal(readTaskPolicy(store, 'race').used.toolCalls, budget, 'the released reservation must not charge the budget');
  });

  await test('with every test content closed the baseline recheck is blocked and closing never deletes history or clears budget', async () => {
    setup('baseline');
    const first = await executeRecordedRequest(store, 'baseline', input());
    assert.equal(readExecutionReceipt(store, 'baseline', first.id).id, first.id);
    const budget = readTaskPolicy(store, 'baseline').used.toolCalls;
    setContent('baseline', []);
    const before = received.length;
    await assert.rejects(executeRecordedRequest(store, 'baseline', input()), /all_content_disabled/);
    assert.equal(received.length, before);
    pauseTaskPolicy(store, 'baseline', { code: 'login-expired', reason: 'fixture identity expired', evidence: 'fixture' });
    resumeTaskPolicy(store, 'baseline', 'restored fixture identity', 'desktop-user');
    // The baseline recheck is itself a target operation, so it is blocked while all content is off
    // (the content gate runs before the baseline-recheck guard, so the concrete reason is the all-off one).
    await assert.rejects(executeRecordedRequest(store, 'baseline', { purpose: 'baseline', requestId: 'normal', requestRevision: 'v1' }), /all_content_disabled/);
    assert.equal(readExecutionReceipt(store, 'baseline', first.id).id, first.id, 'closing content must not delete historical receipts');
    assert.equal(readTaskPolicy(store, 'baseline').used.toolCalls, budget, 'a refused baseline recheck is not charged');
  });
} finally {
  store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
