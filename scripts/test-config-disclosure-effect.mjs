// 泄露/配置的按机制确认（v6 第 9.1 节）：同一入口「带凭据」与「完全匿名」拿到同一份含受控
// marker 的内容才算泄露；通用错误页、不同内容、回显、参考回执没带凭据一律不确认。
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

const MARKER = 'CONTROLLED_CONFIG_MARKER_8e1c4d2f6a';
const CONFIG_BODY = 'APP_ENV=production\nAPI_KEY=' + MARKER + '\nDB_HOST=10.0.0.7\nDB_PASSWORD=fixture-not-real\nSIGNING_SECRET=fixture-signing\n';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-config-disclosure-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

// 默认：带凭据与不带凭据都拿到同一份配置（真泄露）。mode 用来造阴性样本。
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  const mode = url.searchParams.get('mode') || 'exposed';
  const authenticated = typeof req.headers.authorization === 'string';
  if (mode === 'echo') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('requested: ' + req.url); }
  if (mode === 'denied' && !authenticated) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('authentication required'); }
  res.writeHead(200, { 'content-type': 'text/plain' });
  if (mode === 'mirror' && !authenticated) return res.end('public mirror page\n' + MARKER + '\nthis is a different body\n');
  res.end(CONFIG_BODY);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/config/app.env';
const host = new URL(endpoint).host;
const packet = (query, credential) => 'GET /config/app.env' + (query ? '?' + query : '') + ' HTTP/1.1\r\nHost: ' + host + '\r\n'
  + (credential ? 'Authorization: Bearer fixture-operator-token\r\n' : '') + '\r\n';
const method = { id: 'config-disclosure', version: 'v1', reviewed: true, endpoint,
  effectSpec: { kind: 'config-disclosure/v1', marker: MARKER } };
const row = (id, request) => ({ id, revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request, response: 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nfixture baseline',
  inputs: [{ name: 'mode', location: 'query', evidenceIds: [id] }] });

async function collect(sid, { query = '', referenceCredential = true, anonymousQuery = '' } = {}) {
  startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: 20 } });
  saveTaskContext(store, sid, { assets: [{ id: 'asset', url: endpoint, inScope: true, reachable: true }], methods: [method],
    requests: [row('reference', packet(query, referenceCredential)), row('anonymous', packet(anonymousQuery, false))] });
  createResearch(store, sid, { id: 'direction', requestId: 'reference', requestRevision: 'v1', controlledInputs: [{ name: 'mode', location: 'query' }],
    title: 'Controlled configuration disclosure check', serverPath: 'Local config fixture', boundary: 'Authenticated reference vs credential-free request',
    normalBehavior: 'Reviewed identity can read its own configuration', supportCriterion: 'Credential-free request returns the same configuration content',
    falsifier: 'Generic error page, different content, reflection, or a reference without credentials', nextInformation: 'Deterministic comparison only',
    knownCheck: { outcome: 'not-assessed', rationale: 'Synthetic fixture, no product claim', sources: [] } });
  const run = (requestId) => executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId, requestRevision: 'v1', methodId: method.id, methodVersion: method.version });
  const reference = (await run('reference')).id, anonymous = (await run('anonymous')).id;
  return { methodId: method.id, methodVersion: method.version, rounds: [{ reference, anonymous }] };
}

try {
  stageMethodClassification(store, { schema: 'saker.method-classification/1', id: method.id, version: method.version,
    digest: 'b'.repeat(64), revision: 1, modules: ['exploit/config-disclosure'], status: 'verified',
    source: { kind: 'manual', version: method.version, position: 'test-config-disclosure-effect fixture' } });

  await test('匿名拿到与复核身份相同的配置原文：确认泄露（proofKind=other-impact）', async () => {
    const verdict = verifyEffect(store, 'positive', await collect('positive'));
    assert.equal(verdict.verified, true, verdict.reason);
    assert.equal(verdict.kind, 'config-disclosure/v1');
    assert.equal(verdict.proofKind, 'other-impact');
    const record = readEffectVerification(store, 'positive', verdict.id);
    assert.equal(record.current, true, record.currentReason);
    assert.equal(record.comparisons[0].identicalContent, true);
    assert.equal(record.comparisons[0].anonymousCredentials, false);
    assert.equal(record.comparisons[0].publicPageExcluded, true);
  });

  await test('匿名请求被拒（401）：不算泄露', async () => {
    const verdict = verifyEffect(store, 'denied', await collect('denied', { query: 'mode=denied', anonymousQuery: 'mode=denied' }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /anonymous request did not return/);
  });

  await test('marker 出现在请求里（回显）：不算泄露', async () => {
    const verdict = verifyEffect(store, 'reflection', await collect('reflection', { query: 'mode=echo', anonymousQuery: 'mode=echo&marker=' + MARKER }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /reflection/);
  });

  await test('匿名拿到的是不同内容（公开镜像页）：不算泄露', async () => {
    const verdict = verifyEffect(store, 'mirror', await collect('mirror', { query: 'mode=mirror', anonymousQuery: 'mode=mirror' }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /differs/);
  });

  await test('参考回执没有身份凭据（只是公开内容）：不算泄露', async () => {
    const verdict = verifyEffect(store, 'no-credential', await collect('no-credential', { referenceCredential: false }));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /credentials/);
  });

  await test('未复核或错 kind 的方法规格不能用于该配方', async () => {
    const verdict = verifyEffect(store, 'wrong-kind', { methodId: 'nope', methodVersion: 'v1', rounds: [{ reference: 'a', anonymous: 'b' }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /reviewed effect specification|config disclosure/);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
