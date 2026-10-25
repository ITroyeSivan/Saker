// 多子代理同时故障（v6 第 8.3/10.5 节）：两个子任务**并发**命中限流时，
// 每个子任务各自停下，父任务只被暂停一次（不重复/不损坏），且父子预算计数一致。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { executeRecordedRequest } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { stageMethodClassification } from '../plugins/dsh-redteam-results/lib/method-classification.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-child-fault-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

// site_workers 有 UNIQUE(parent_session, site)：每个父任务每个站点只能一个子代理，
// 所以两个子任务用两个不同 origin（不同端口）——这也是真实里"两个站点各一个子代理"的形状。
const servers = [], endpoints = [];
for (let i = 0; i < 2; i += 1) {
  const server = http.createServer((req, res) => { res.writeHead(429); res.end('too many requests'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  endpoints.push('http://127.0.0.1:' + server.address().port + '/api/object');
}
const method = { id: 'fixture-method', version: 'v1', reviewed: true, definition: 'Child concurrency fixture only' };
const requestRow = (endpoint) => ({ id: 'probe', revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request: 'GET /api/object HTTP/1.1\r\nHost: ' + new URL(endpoint).host + '\r\n\r\n', response: 'HTTP/1.1 200 OK\r\n\r\nold baseline',
  inputs: [{ name: 'mode', location: 'query', evidenceIds: ['probe'] }] });

function linkChild(parentId, childId, site) {
  store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)')
    .run(parentId, childId, site, JSON.stringify({ parentId, childId, site, state: 'running', allowedTools: ['redteam_execution'] }));
}
function prepareChild(parentId, childId, site) {
  linkChild(parentId, childId, site);
  startTaskPolicy(store, childId, { mode: 'regular', target: site, budget: { toolCalls: 20, workers: 0 } });
  saveTaskContext(store, childId, { assets: [{ id: 'a', url: site, inScope: true, reachable: true }], requests: [requestRow(site)], methods: [method] });
  createResearch(store, childId, { id: 'direction', requestId: 'probe', requestRevision: 'v1', controlledInputs: [{ name: 'mode', location: 'query' }],
    title: 'Child concurrency fixture', serverPath: 'Local fixture', boundary: 'Synthetic', normalBehavior: 'Fixture own response',
    supportCriterion: 'Fixture', falsifier: 'Fixture', nextInformation: 'Fixture',
    knownCheck: { outcome: 'not-assessed', rationale: 'fixture', sources: [] } });
}
const run = (sid) => executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId: 'probe', requestRevision: 'v1',
  methodId: method.id, methodVersion: method.version, timeoutMs: 2000 });

try {
  stageMethodClassification(store, { schema: 'saker.method-classification/1', id: method.id, version: method.version,
    digest: 'a1'.repeat(32), revision: 1, modules: ['exploit/sqli'], status: 'verified',
    source: { kind: 'manual', version: method.version, position: 'test-child-concurrent-fault fixture' } });

  await test('两个子任务并发限流：各自停下，父任务只被暂停一次且计数一致', async () => {
    const parent = 'parent', children = ['child-a', 'child-b'];
    startTaskPolicy(store, parent, { mode: 'regular', target: endpoints.join('\n'), budget: { toolCalls: 20, workers: 2 } });
    saveTaskContext(store, parent, { assets: endpoints.map((url, i) => ({ id: 'a' + i, url, inScope: true, reachable: true })), requests: [], methods: [method] });
    for (const [index, child] of children.entries()) prepareChild(parent, child, endpoints[index]);
    const results = await Promise.all(children.map(child => run(child)));
    for (const [index, result] of results.entries()) {
      assert.equal(result.blocker, 'normal-access-failed', children[index] + ' 应记录限流');
      assert.equal(readTaskPolicy(store, children[index]).blocker.code, 'normal-access-failed');
    }
    const parentPolicy = readTaskPolicy(store, parent);
    assert.equal(parentPolicy.blocker?.code, 'normal-access-failed', '父任务被暂停');
    // 只暂停一次：阻碍只有一个 code，且历史里没有被重复写入。
    assert.equal((parentPolicy.blockerHistory || []).length, 0, '并发传播不写历史，只保留当前阻碍');
    assert.match(String(parentPolicy.blocker.evidence), /HTTP=429/);
    // 父子预算计数一致：两次子操作各自计入自己与父任务。
    assert.equal(parentPolicy.used.toolCalls, 2, '两个子任务的操作都计入父任务共享预算');
    for (const child of children) assert.equal(readTaskPolicy(store, child).used.toolCalls, 1);
    // 停下来的父子任务都不能再发目标操作。
    await assert.rejects(run('child-a'), /任务已停止|baseline_recheck_required|active direction/);
    // 父任务本身也已停：不再接受新的目标操作（父任务没登记请求，先被请求解析挡住同样算拒绝）。
    await assert.rejects(run(parent));
  });

  await test('父任务已停止时，子任务也不能被重新放行', async () => {
    const child = 'child-c', parent = 'parent2';
    startTaskPolicy(store, parent, { mode: 'regular', target: endpoints[0], budget: { toolCalls: 20, workers: 2 } });
    prepareChild(parent, child, endpoints[0]);
    store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify({ ...readTaskPolicy(store, parent), cancelled: true, finishedAt: Date.now() }), parent);
    await assert.rejects(run(child), /任务已停止|active direction|direction/);
  });
} finally {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
