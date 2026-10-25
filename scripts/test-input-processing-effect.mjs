// 输入处理的按机制确认（v6 第 9.1 节）：受控输入必须以「被处理过的形态」出现在响应里，
// 且对照请求只差这一个输入值——参数被忽略、普通报错、原始回显、对照改了别的参数都不算。
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

const MARKER = 'input-probe-marker-7f3a';
const PROCESSED = MARKER.toUpperCase();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-input-processing-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

// 正常：把输入大写后渲染（被处理形态 ≠ 请求里的原始值）。mode 用来造阴性样本。
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  const mode = url.searchParams.get('mode') || 'render';
  const value = url.searchParams.get('name') || '';
  if (mode === 'error' && value === MARKER) { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('template render failed'); }
  if (mode === 'ignored') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Hello GUEST!'); }
  if (mode === 'reflect') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('raw value: ' + value); }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Hello ' + value.toUpperCase() + '!');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/render';
const host = new URL(endpoint).host;
const packet = (query) => 'GET /api/render?' + query + ' HTTP/1.1\r\nHost: ' + host + '\r\nAuthorization: Bearer fixture-operator-token\r\n\r\n';
const method = { id: 'input-processing', version: 'v1', reviewed: true, endpoint,
  effectSpec: { kind: 'input-processing/v1', marker: MARKER, controlValue: 'guest', processedValue: PROCESSED } };
const reflectMethod = { ...method, effectSpec: { kind: 'input-processing/v1', marker: MARKER, controlValue: 'guest', processedValue: MARKER } };
const row = (id, request) => ({ id, revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request, response: 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nfixture baseline',
  inputs: [{ name: 'name', location: 'query', evidenceIds: [id] }] });

async function collect(sid, { controlQuery = 'name=guest', probeQuery = 'name=' + MARKER, spec = method } = {}) {
  startTaskPolicy(store, sid, { mode: 'regular', target: endpoint, budget: { toolCalls: 20 } });
  const active = { ...spec, effectSpec: spec.effectSpec };
  saveTaskContext(store, sid, { assets: [{ id: 'asset', url: endpoint, inScope: true, reachable: true }], methods: [active],
    requests: [row('control', packet(controlQuery)), row('probe', packet(probeQuery))] });
  createResearch(store, sid, { id: 'direction', requestId: 'control', requestRevision: 'v1', controlledInputs: [{ name: 'name', location: 'query' }],
    title: 'Controlled input processing check', serverPath: 'Local render fixture', boundary: 'Same entry, identity and request except one input value',
    normalBehavior: 'Reviewed entry renders the submitted value', supportCriterion: 'Probe response contains the reviewed processed form and the control does not',
    falsifier: 'Ignored parameter, plain error, raw reflection, or a control that changed more than the input', nextInformation: 'Deterministic comparison only',
    knownCheck: { outcome: 'not-assessed', rationale: 'Synthetic fixture, no product claim', sources: [] } });
  const run = (requestId) => executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId, requestRevision: 'v1', methodId: active.id, methodVersion: active.version });
  const control = (await run('control')).id, probe = (await run('probe')).id;
  return { methodId: active.id, methodVersion: active.version, rounds: [{ control, probe }] };
}

try {
  stageMethodClassification(store, { schema: 'saker.method-classification/1', id: method.id, version: method.version,
    digest: 'd'.repeat(64), revision: 1, modules: ['exploit/ssti'], status: 'verified',
    source: { kind: 'manual', version: method.version, position: 'test-input-processing-effect fixture' } });

  await test('受控输入以被处理形态出现在响应里、对照只差这一个值：确认（proofKind=other-impact）', async () => {
    const verdict = verifyEffect(store, 'positive', await collect('positive'));
    assert.equal(verdict.verified, true, verdict.reason);
    assert.equal(verdict.kind, 'input-processing/v1');
    assert.equal(verdict.proofKind, 'other-impact');
    const record = readEffectVerification(store, 'positive', verdict.id);
    assert.equal(record.current, true, record.currentReason);
    assert.equal(record.comparisons[0].singleInputDifference, true);
    assert.equal(record.comparisons[0].ignoredParameterExcluded, true);
    assert.equal(record.comparisons[0].requestReflectionExcluded, true);
  });

  await test('参数被忽略（两次响应一样）：不算确认', async () => {
    const verdict = verifyEffect(store, 'ignored', await collect('ignored', { controlQuery: 'mode=ignored&name=guest', probeQuery: 'mode=ignored&name=' + MARKER }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /identical|ignored/);
  });

  await test('探针请求普通报错（500）：不算确认', async () => {
    const verdict = verifyEffect(store, 'error', await collect('error', { controlQuery: 'mode=error&name=guest', probeQuery: 'mode=error&name=' + MARKER }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /did not complete normally|error/);
  });

  await test('原始回显（处理形态就是输入本身）：不算确认', async () => {
    const verdict = verifyEffect(store, 'reflect', await collect('reflect', { controlQuery: 'mode=reflect&name=guest', probeQuery: 'mode=reflect&name=' + MARKER, spec: reflectMethod }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /reflection/);
  });

  await test('对照请求还改了别的参数（差异无法归因）：不算确认', async () => {
    const verdict = verifyEffect(store, 'other-param', await collect('other-param', { controlQuery: 'name=guest&extra=1', probeQuery: 'name=' + MARKER }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /differ only in the reviewed input value/);
  });

  await test('未复核或错 kind 的方法规格不能用于该配方', async () => {
    const verdict = verifyEffect(store, 'wrong-kind', { methodId: 'nope', methodVersion: 'v1', rounds: [{ control: 'a', probe: 'b' }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /reviewed effect specification|input processing/);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
