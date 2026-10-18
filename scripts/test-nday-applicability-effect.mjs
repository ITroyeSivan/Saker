// Nday 适用性的按机制确认（v6 第 9.1 / 10.1 节）：只认「产品+版本原文」，
// 且固定 proofKind=fingerprint——适用性永远不能冒充漏洞影响。
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
import { findingDeliveryState } from '../plugins/dsh-redteam-results/lib/delivery.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-nday-applicability-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

// 版本原文只在"真实响应"里出现；回显用例把版本号放进查询串，响应照抄查询串。
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  const mode = url.searchParams.get('mode') || 'banner';
  res.writeHead(200, { 'content-type': 'text/plain' });
  if (mode === 'unknown') return res.end('nginx server (version hidden by the deployment)');
  if (mode === 'no-ubuntu') return res.end('Server: nginx/1.18.0 (Debian)');
  // 回显用例：产品名照常出现，版本号完全照抄请求查询串——产品名检查会先通过，
  // 让"版本来自请求回显"成为唯一拦截点。
  if (mode === 'echo') return res.end('Server: nginx/' + (url.searchParams.get('v') || ''));
  return res.end('HTTP/1.1 200 OK\nServer: nginx/1.18.0 (Ubuntu)\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/version';
const host = new URL(endpoint).host;
const packet = (query) => 'GET /api/version' + (query ? '?' + query : '') + ' HTTP/1.1\r\nHost: ' + host + '\r\n\r\n';
const method = { id: 'nday-applicability', version: 'v1', reviewed: true, endpoint,
  effectSpec: { kind: 'nday-applicability/v1', product: 'nginx', versionPattern: 'nginx/(\\d+\\.\\d+\\.\\d+)' } };
const methodWithDeployment = { ...method, effectSpec: { ...method.effectSpec, deploymentPattern: 'Ubuntu' } };
const row = (id, request) => ({ id, revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request, response: 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nfixture baseline',
  inputs: [{ name: 'mode', location: 'query', evidenceIds: [id] }] });

async function collect(sid, query, spec = method) {
  startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: 20 } });
  const active = { ...spec, effectSpec: spec.effectSpec };
  saveTaskContext(store, sid, { assets: [{ id: 'asset', url: endpoint, inScope: true, reachable: true }], methods: [active], requests: [row('fingerprint', packet(query))] });
  createResearch(store, sid, { id: 'direction', requestId: 'fingerprint', requestRevision: 'v1', controlledInputs: [{ name: 'mode', location: 'query' }],
    title: 'Controlled Nday applicability check', serverPath: 'Local version fixture', boundary: 'Reviewed product/version text only',
    normalBehavior: 'Reviewed product surface returns its banner', supportCriterion: 'Response contains the reviewed product and version text',
    falsifier: 'Unknown version, scanner label only, or reflection', nextInformation: 'Deterministic comparison only',
    knownCheck: { outcome: 'not-assessed', rationale: 'Synthetic fixture, no product claim', sources: [] } });
  const receipt = await executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId: 'fingerprint', requestRevision: 'v1', methodId: active.id, methodVersion: active.version });
  return { methodId: active.id, methodVersion: active.version, rounds: [{ fingerprint: receipt.id }] };
}

try {
  stageMethodClassification(store, { schema: 'saker.method-classification/1', id: method.id, version: method.version,
    digest: 'f'.repeat(64), revision: 1, modules: ['exploit/nday'], status: 'verified',
    source: { kind: 'manual', version: method.version, position: 'test-nday-applicability-effect fixture' } });

  await test('产品与版本原文都在真实响应里：确认适用性（proofKind=fingerprint）', async () => {
    const verdict = verifyEffect(store, 'positive', await collect('positive', 'mode=banner'));
    assert.equal(verdict.verified, true, verdict.reason);
    assert.equal(verdict.kind, 'nday-applicability/v1');
    assert.equal(verdict.proofKind, 'fingerprint');
    const record = readEffectVerification(store, 'positive', verdict.id);
    assert.equal(record.current, true, record.currentReason);
    assert.equal(record.comparisons[0].version, '1.18.0');
    assert.equal(record.comparisons[0].requestReflectionExcluded, true);
    assert.match(String(record.evidenceLimit), /NOT a verified vulnerability/);
  });

  await test('适用性不能当影响交付：fingerprint 触发 impact-proof-kind-missing', async () => {
    const base = { mode: 'pentest', status: 'verified', evidenceLevel: 'impact', proofKind: 'fingerprint',
      impact: 'x', evidence: 'y', executionEvidence: null, reproduction: null, requestPkt: '', responsePkt: '' };
    const applicability = findingDeliveryState({ ...base });
    const impact = findingDeliveryState({ ...base, proofKind: 'other-impact' });
    assert.equal(applicability.gaps.includes('impact-proof-kind-missing'), true);
    assert.equal(impact.gaps.includes('impact-proof-kind-missing'), false);
  });

  await test('版本未知（只有产品名）：不确认', async () => {
    const verdict = verifyEffect(store, 'unknown', await collect('unknown', 'mode=unknown'));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /version evidence|unknown/);
  });

  await test('版本原文来自请求回显：不确认', async () => {
    const verdict = verifyEffect(store, 'reflection', await collect('reflection', 'mode=echo&v=1.18.0'));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /reflection/);
  });

  await test('声明了部署条件但响应里没有对应原文：不确认', async () => {
    const verdict = verifyEffect(store, 'deployment', await collect('deployment', 'mode=no-ubuntu', methodWithDeployment));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /deployment condition/);
  });

  await test('未复核或错 kind 的方法规格不能用于该配方', async () => {
    const verdict = verifyEffect(store, 'wrong-kind', { methodId: 'nope', methodVersion: 'v1', rounds: [{ fingerprint: 'a' }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /reviewed effect specification|Nday applicability/);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
