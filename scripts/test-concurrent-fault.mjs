// 并发下的批量故障注入（v6 第 10.5 节）：多路同时执行时，
// **实际发出的目标请求**与**回执**与**预算计数**必须一一对应，不能出现
// "发了没记账"（预算被绕过）或"记了没发"（幻觉计数）；限流要把任务停下来而不是继续打。
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-concurrent-fault-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

let serverHits = 0;
const server = http.createServer((req, res) => {
  serverHits += 1;
  const mode = new URL(req.url, 'http://fixture.test').searchParams.get('mode');
  if (mode === 'rate') { res.writeHead(429); res.end('too many requests'); return; }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/object';
const host = new URL(endpoint).host;
const packet = (mode) => 'GET /api/object?mode=' + mode + ' HTTP/1.1\r\nHost: ' + host + '\r\n\r\n';
const fixtureMethod = { id: 'fixture-method', version: 'v1', reviewed: true, definition: 'Concurrency fixture only' };
const row = (id, mode) => ({ id, revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request: packet(mode), response: 'HTTP/1.1 200 OK\r\n\r\nold baseline', inputs: [{ name: 'mode', location: 'query', evidenceIds: [id] }] });
const receipts = sid => store.db.prepare('SELECT count(*) AS n FROM execution_receipts WHERE session_id=?').get(sid).n;

try {
  stageMethodClassification(store, { schema: 'saker.method-classification/1', id: fixtureMethod.id, version: fixtureMethod.version,
    digest: 'f'.repeat(64), revision: 1, modules: ['exploit/sqli'], status: 'verified',
    source: { kind: 'manual', version: fixtureMethod.version, position: 'test-concurrent-fault fixture' } });

  await test('并发 8 路（含 4 路限流）：实际请求数 = 回执数 = 预算计数，限流后任务停住', async () => {
    const sid = 'concurrent';
    const rows = [0, 1, 2, 3].map(i => row('ok' + i, 'ok')).concat([4, 5, 6, 7].map(i => row('rate' + i, 'rate')));
    startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: 20 } });
    saveTaskContext(store, sid, { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: rows, methods: [fixtureMethod] });
    createResearch(store, sid, { id: 'direction', requestId: 'ok0', requestRevision: 'v1', controlledInputs: [{ name: 'mode', location: 'query' }],
      title: 'Concurrent fixture', serverPath: 'Local fixture', boundary: 'Synthetic', normalBehavior: 'Fixture own response',
      supportCriterion: 'Fixture', falsifier: 'Fixture', nextInformation: 'Fixture',
      knownCheck: { outcome: 'not-assessed', rationale: 'fixture', sources: [] } });
    const before = serverHits;
    const attempts = rows.map(item => executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId: item.id, requestRevision: 'v1',
      methodId: fixtureMethod.id, methodVersion: fixtureMethod.version, timeoutMs: 2000 })
      .then(value => ({ sent: true, value })).catch(error => ({ sent: false, error: error.message })));
    const results = await Promise.all(attempts);
    const sent = results.filter(item => item.sent).length;
    const hits = serverHits - before;
    const recorded = receipts(sid);
    assert.equal(hits, sent, '实际发出的请求数必须等于成功执行的次数');
    assert.equal(recorded, sent, '每次实际发出的请求有且仅有一条回执');
    const policy = readTaskPolicy(store, sid);
    assert.equal(policy.used.toolCalls, sent, '预算计数必须等于实际发出的请求数（不多记也不少记）');
    assert.equal(policy.blocker?.code, 'normal-access-failed', '并发里出现限流要把任务停下来');
    // 已经停下来的任务不能再发新的目标操作。
    const after = serverHits;
    await assert.rejects(executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId: 'ok0', requestRevision: 'v1',
      methodId: fixtureMethod.id, methodVersion: fixtureMethod.version }), /任务已停止|baseline_recheck_required|active direction/);
    assert.equal(serverHits, after, '停下来的任务不能再发出请求');
  });

  await test('并发不重复计费：同一批请求不会因为并发而多记预算', async () => {
    const sid = 'no-double-count';
    const rows = [0, 1, 2, 3, 4, 5, 6, 7].map(i => row('r' + i, 'ok'));
    startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: 20 } });
    saveTaskContext(store, sid, { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: rows, methods: [fixtureMethod] });
    createResearch(store, sid, { id: 'direction', requestId: 'r0', requestRevision: 'v1', controlledInputs: [{ name: 'mode', location: 'query' }],
      title: 'Concurrent fixture', serverPath: 'Local fixture', boundary: 'Synthetic', normalBehavior: 'Fixture own response',
      supportCriterion: 'Fixture', falsifier: 'Fixture', nextInformation: 'Fixture',
      knownCheck: { outcome: 'not-assessed', rationale: 'fixture', sources: [] } });
    const before = serverHits;
    await Promise.all(rows.map(item => executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId: item.id, requestRevision: 'v1',
      methodId: fixtureMethod.id, methodVersion: fixtureMethod.version, timeoutMs: 2000 })));
    assert.equal(readTaskPolicy(store, sid).used.toolCalls, 8, '八次执行就记八次');
    assert.equal(serverHits - before, 8, '八次执行就发八次');
    assert.equal(receipts(sid), 8, '八次执行就留八条回执');
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
