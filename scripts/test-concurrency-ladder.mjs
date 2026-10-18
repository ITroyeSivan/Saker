// 并发阶梯（方案 10.5）：1/2/4/8/16 路固定预算下，实际请求、回执和预算计数必须一一对应；
// 16 路取消要能收口，不能留下孤儿回执或继续占预算。
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-concurrency-ladder-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => {
  try { await work(); console.log('ok   ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const receipts = sid => store.db.prepare('SELECT count(*) AS n FROM execution_receipts WHERE session_id=?').get(sid).n;

let hits = 0, holdHits = 0;
const server = http.createServer((req, res) => {
  const mode = new URL(req.url, 'http://fixture.test').searchParams.get('mode');
  if (mode === 'hold') { holdHits += 1; return; }
  hits += 1;
  setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }, 20);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/object';
const host = new URL(endpoint).host;
const packet = mode => 'GET /api/object?mode=' + mode + ' HTTP/1.1\r\nHost: ' + host + '\r\n\r\n';
const method = { id: 'fixture-method', version: 'v1', reviewed: true, definition: 'Concurrency ladder fixture only' };
const row = (id, mode) => ({ id, revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request: packet(mode), response: 'HTTP/1.1 200 OK\r\n\r\nold baseline', inputs: [{ name: 'mode', location: 'query', evidenceIds: [id] }] });

function setup(sid, count, mode) {
  const rows = Array.from({ length: count }, (_, index) => row('r' + index, mode));
  startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: count + 4 } });
  saveTaskContext(store, sid, { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: rows, methods: [method] });
  createResearch(store, sid, { id: 'direction', requestId: 'r0', requestRevision: 'v1', controlledInputs: [{ name: 'mode', location: 'query' }],
    title: 'Concurrency ladder fixture', serverPath: 'Local fixture', boundary: 'Synthetic', normalBehavior: 'Fixture own response',
    supportCriterion: 'Fixture', falsifier: 'Fixture', nextInformation: 'Fixture',
    knownCheck: { outcome: 'not-assessed', rationale: 'fixture', sources: [] } });
  return rows;
}

try {
  stageMethodClassification(store, { schema: 'saker.method-classification/1', id: method.id, version: method.version,
    digest: 'c'.repeat(64), revision: 1, modules: ['exploit/sqli'], status: 'verified',
    source: { kind: 'manual', version: method.version, position: 'test-concurrency-ladder fixture' } });

  await test('1/2/4/8/16 concurrent executions keep hits, receipts and budget in exact agreement', async () => {
    for (const level of [1, 2, 4, 8, 16]) {
      const sid = 'ladder-' + level;
      const rows = setup(sid, level, 'ok');
      const before = hits;
      const results = await Promise.all(rows.map(item => executeRecordedRequest(store, sid, {
        hypothesisId: 'direction', requestId: item.id, requestRevision: 'v1',
        methodId: method.id, methodVersion: method.version, timeoutMs: 2000,
      })));
      assert.equal(results.length, level, `level ${level} settles every execution`);
      assert.equal(hits - before, level, `level ${level} sends exactly ${level} requests`);
      assert.equal(receipts(sid), level, `level ${level} stores exactly ${level} receipts`);
      assert.equal(readTaskPolicy(store, sid).used.toolCalls, level, `level ${level} charges exactly ${level} operations`);
      assert.equal(new Set(results.map(result => result.id)).size, level, `level ${level} has no duplicate receipt ids`);
    }
  });

  await test('16-way cancellation settles without orphan receipts or leaked budget', async () => {
    const sid = 'ladder-cancel';
    const rows = setup(sid, 16, 'hold');
    const controller = new AbortController();
    const beforeHold = holdHits;
    const attempts = rows.map(item => executeRecordedRequest(store, sid, {
      hypothesisId: 'direction', requestId: item.id, requestRevision: 'v1',
      methodId: method.id, methodVersion: method.version, timeoutMs: 5000,
    }, undefined, controller.signal));
    const start = Date.now();
    while (holdHits - beforeHold < 16 && Date.now() - start < 2000) await sleep(10);
    assert.equal(holdHits - beforeHold, 16, 'all 16 requests reached the fixture before cancellation');
    const abortAt = Date.now();
    controller.abort();
    const results = await Promise.all(attempts);
    const cancellationMs = Date.now() - abortAt;
    assert.equal(results.length, 16, 'every cancelled attempt settles');
    assert(results.every(result => result.outcome === 'interrupted' || result.outcome === 'timeout'),
      'cancelled attempts report an interrupted/timeout outcome');
    assert(cancellationMs < 1000, `cancellation latency ${cancellationMs}ms must stay below 1000ms`);
    assert.equal(receipts(sid), 16, 'cancelled requests retain one receipt each, never orphans');
    assert.equal(readTaskPolicy(store, sid).used.toolCalls, 16, 'cancelled requests are charged exactly once');
  });
} finally {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
