// 状态变更/业务的按机制确认（v6 第 9.1 节）：影响必须由独立 GET 读回证明，
// 动作响应自报、状态未变、GET 冒充写、读回回显一律不确认。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { executeRecordedRequest } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { verifyEffect, readEffectVerification } from '../plugins/dsh-redteam-results/lib/effect-verifications.js';
import { stageMethodClassification } from '../plugins/dsh-redteam-results/lib/method-classification.js';

const MARKER = 'CONTROLLED_STATE_MARKER_4b1e9d7a2c';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-state-change-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

// 每个 id 一份内存状态：POST 只有真的写到状态里，GET 才可能读到 marker。
const states = new Map();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  const id = url.searchParams.get('id') || 'default';
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.method === 'GET') return res.end(JSON.stringify({ id, status: states.get(id) || 'pending' }));
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const echoOnly = /"echoOnly":true/.test(body);
    if (!echoOnly && body.includes(MARKER)) states.set(id, MARKER);
    res.end(JSON.stringify({ id, status: echoOnly ? MARKER : states.get(id) || 'pending', accepted: true }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/state';
const host = new URL(endpoint).host;
const getPacket = (id, marker) => 'GET /api/state?id=' + id + (marker ? '&marker=' + MARKER : '') + ' HTTP/1.1\r\nHost: ' + host + '\r\n\r\n';
const postPacket = (id, body) => 'POST /api/state?id=' + id + ' HTTP/1.1\r\nHost: ' + host + '\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body;
const method = { id: 'state-change', version: 'v1', reviewed: true, endpoint,
  effectSpec: { kind: 'state-change-impact/v1', marker: MARKER, statePath: '/status' } };
const row = (id, request) => ({ id, revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request, response: 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\nfixture baseline',
  inputs: [{ name: 'id', location: 'query', evidenceIds: [id] }] });

function prepare(sid, rows) {
  startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: 20 } });
  saveTaskContext(store, sid, { assets: [{ id: 'asset', url: endpoint, inScope: true, reachable: true }], methods: [method], requests: rows });
  createResearch(store, sid, { id: 'direction', requestId: rows[0].id, requestRevision: 'v1', controlledInputs: [{ name: 'id', location: 'query' }],
    title: 'Controlled state change comparison', serverPath: 'Local state fixture', boundary: 'Reviewed write vs independent readback',
    normalBehavior: 'Reviewed state read returns the current status', supportCriterion: 'Independent readback shows the controlled marker after the write',
    falsifier: 'Unchanged state, response self-report only, or reflection', nextInformation: 'Deterministic comparison only',
    knownCheck: { outcome: 'not-assessed', rationale: 'Synthetic fixture, no product claim', sources: [] } });
}
async function collect(sid, id, { action = 'post', echoOnly = false, readbackEcho = false, markerInAction = true } = {}) {
  const before = getPacket(id);
  const writeBody = JSON.stringify({ id, value: markerInAction ? MARKER : 'benign-value', echoOnly });
  const after = getPacket(id, readbackEcho);
  // GET 冒充写时把 marker 放进查询串：这样"必须写操作"就是唯一拦截点，
  // 否则会先被"写请求不带 marker"拦下，反证检查不到真正的那条判断。
  const rows = [row('before', before), row('action', action === 'get' ? getPacket(id, true) : postPacket(id, writeBody)), row('after', after)];
  prepare(sid, rows);
  const run = (requestId) => executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId, requestRevision: 'v1', methodId: method.id, methodVersion: method.version });
  const beforeId = (await run('before')).id, actionId = (await run('action')).id, afterId = (await run('after')).id;
  return { methodId: method.id, methodVersion: method.version, rounds: [{ before: beforeId, action: actionId, after: afterId }] };
}

try {
  stageMethodClassification(store, { schema: 'saker.method-classification/1', id: method.id, version: method.version,
    digest: 'd'.repeat(64), revision: 1, modules: ['exploit/business-logic'], status: 'verified',
    source: { kind: 'manual', version: method.version, position: 'test-state-change-effect fixture' } });

  await test('写操作后独立读回看到受控 marker：确认为 write', async () => {
    const input = await collect('positive', 'order-1');
    const verdict = verifyEffect(store, 'positive', input);
    assert.equal(verdict.verified, true, verdict.reason);
    assert.equal(verdict.kind, 'state-change-impact/v1');
    assert.equal(verdict.proofKind, 'write');
    const record = readEffectVerification(store, 'positive', verdict.id);
    assert.equal(record.current, true, record.currentReason);
    assert.equal(record.comparisons[0].stateChanged, true);
    assert.equal(record.comparisons[0].independentReadback, true);
    assert.equal(record.comparisons[0].requestReflectionExcluded, true);
    assert.equal(record.comparisons[0].actionMethod, 'POST');
  });

  await test('动作响应里回显 marker 但状态没变：不算确认', async () => {
    const verdict = verifyEffect(store, 'negative-echo-only', await collect('negative-echo-only', 'order-2', { echoOnly: true }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /state did not change|readback/);
  });

  await test('写请求不带受控 marker（无归因）：不算确认', async () => {
    const verdict = verifyEffect(store, 'negative-no-marker', await collect('negative-no-marker', 'order-3', { markerInAction: false }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /controlled marker|state did not change/);
  });

  await test('GET 冒充写操作：不算确认', async () => {
    const verdict = verifyEffect(store, 'negative-get', await collect('negative-get', 'order-4', { action: 'get' }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /write execution/);
  });

  await test('读回请求自带 marker（回显）：不算确认', async () => {
    const verdict = verifyEffect(store, 'negative-reflection', await collect('negative-reflection', 'order-5', { readbackEcho: true }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /reflection/);
  });

  await test('未复核或错 kind 的方法规格不能用于该配方', async () => {
    const verdict = verifyEffect(store, 'wrong-kind', { methodId: 'nope', methodVersion: 'v1', rounds: [{ before: 'a', action: 'b', after: 'c' }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /reviewed effect specification|state-change/);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
