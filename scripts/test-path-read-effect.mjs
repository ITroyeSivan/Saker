// 文件读取/路径的按机制确认（v6 第 9.1 节）：只认"实际文件内容"，不认通用错误页、回显或正常路径已有内容。
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

const MARKER = 'FIXTURE_FILE_MARKER_9f3a2b7c1d';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-path-read-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

// 固定返回：正常文件、越界文件（含 marker）、通用错误页、正常路径已含 marker、回显请求。
const server = http.createServer((req, res) => {
  const file = new URL(req.url, 'http://fixture.test').searchParams.get('file') || '';
  res.writeHead(200, { 'content-type': 'text/plain' });
  if (file === 'readme.txt') return res.end('public readme content; nothing sensitive here');
  if (file === 'leak.txt') return res.end(MARKER + '\nthis normal path already exposes the marker');
  if (file === 'missing.txt') return res.end('Not Found: the requested file does not exist');
  if (file === 'echo') return res.end('requested: ' + req.url);
  if (file.includes('secret.txt')) return res.end(MARKER + '\n' + 'secret file body '.repeat(8));
  return res.end('generic application page');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/object';
const host = new URL(endpoint).host;
const packet = (file) => 'GET /api/object?file=' + file + ' HTTP/1.1\r\nHost: ' + host + '\r\n\r\n';
const method = { id: 'path-read', version: 'v1', reviewed: true, endpoint,
  effectSpec: { kind: 'path-read-disclosure/v1', marker: MARKER, normalTarget: '/api/object?file=readme.txt' } };
const row = (id, file) => ({ id, revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request: packet(file), response: 'HTTP/1.1 200 OK\r\n\r\nnormal fixture baseline', inputs: [{ name: 'file', location: 'query', evidenceIds: [id] }] });

function prepare(sid, rows) {
  startTaskPolicy(store, sid, { mode: 'regular', target: endpoint, budget: { toolCalls: 20 } });
  saveTaskContext(store, sid, { assets: [{ id: 'asset', url: endpoint, inScope: true, reachable: true }], methods: [method], requests: rows });
  createResearch(store, sid, { id: 'direction', requestId: 'normal', requestRevision: 'v1', controlledInputs: [{ name: 'file', location: 'query' }],
    title: 'Controlled file read comparison', serverPath: 'Local file fixture', boundary: 'Reviewed normal read vs out-of-bounds read',
    normalBehavior: 'Reviewed normal file is served', supportCriterion: 'Out-of-bounds read returns file content containing the reviewed marker',
    falsifier: 'Generic error page, reflection, or normal path already exposes the marker', nextInformation: 'Deterministic comparison only',
    knownCheck: { outcome: 'not-assessed', rationale: 'Synthetic fixture, no product claim', sources: [] } });
}
async function collect(sid, probeFile) {
  prepare(sid, [row('normal', 'readme.txt'), row('probe', probeFile)]);
  const run = (requestId) => executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId, requestRevision: 'v1', methodId: method.id, methodVersion: method.version });
  const normal = (await run('normal')).id, probe = (await run('probe')).id;
  return { methodId: method.id, methodVersion: method.version, rounds: [{ normal, probe }] };
}

try {
  stageMethodClassification(store, { schema: 'saker.method-classification/1', id: method.id, version: method.version,
    digest: 'c'.repeat(64), revision: 1, modules: ['exploit/file-upload'], status: 'verified',
    source: { kind: 'manual', version: method.version, position: 'test-path-read-effect fixture' } });

  await test('越界读到的实际文件内容（含复核 marker）通过，一次有效观察即成立', async () => {
    const input = await collect('positive', '../../etc/secret.txt');
    const verdict = verifyEffect(store, 'positive', input);
    assert.equal(verdict.verified, true, verdict.reason);
    assert.equal(verdict.kind, 'path-read-disclosure/v1');
    assert.equal(verdict.proofKind, 'other-impact');
    // effectSummary 会剥掉 input/comparisons；完整对照从记录里读。
    const record = readEffectVerification(store, 'positive', verdict.id);
    assert.equal(record.current, true, record.currentReason);
    assert.equal(record.comparisons[0].requestReflectionExcluded, true);
    assert.equal(record.comparisons[0].genericErrorExcluded, true);
    assert.equal(record.comparisons[0].probeTarget, '/api/object?file=../../etc/secret.txt');
  });

  await test('通用错误页（200 但无实际内容）不算确认', async () => {
    const verdict = verifyEffect(store, 'negative-error', await collect('negative-error', 'missing.txt'));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /marker|generic error/);
  });

  await test('只在响应里回显请求（marker 出现在请求里）不算确认', async () => {
    const verdict = verifyEffect(store, 'negative-echo', await collect('negative-echo', 'echo&marker=' + MARKER));
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /marker|reflection/);
  });

  await test('正常路径本来就含 marker 时不算越界确认', async () => {
    // 正常请求目标换成会泄露 marker 的那个，probe 仍读越界文件 → 正常对照不成立。
    const sid = 'negative-normal-leak';
    prepare(sid, [row('normal', 'leak.txt'), row('probe', '../../etc/secret.txt')]);
    const run = (requestId) => executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId, requestRevision: 'v1', methodId: method.id, methodVersion: method.version });
    const normal = (await run('normal')).id, probe = (await run('probe')).id;
    // 复核规格里的 normalTarget 仍是 readme，正常请求用了别的目标 → 直接判不成立。
    const verdict = verifyEffect(store, sid, { methodId: method.id, methodVersion: method.version, rounds: [{ normal, probe }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /normal request target|marker/);
  });

  await test('未复核或错 kind 的方法规格不能用于该配方', async () => {
    const verdict = verifyEffect(store, 'wrong-kind', { methodId: 'nope', methodVersion: 'v1', rounds: [{ normal: 'a', probe: 'b' }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /reviewed effect specification|path-read/);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
