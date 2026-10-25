// 服务端访问的按机制确认（v6 第 9.1 节）：必须有宿主回查 DNSLog 平台的真实命中记录，
// 且命中发生在触发请求之后。只有客户端访问、单一报错、记录早于触发、域名对不上都不算。
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
import { verifyEffect } from '../plugins/dsh-redteam-results/lib/effect-verifications.js';
import { stageMethodClassification } from '../plugins/dsh-redteam-results/lib/method-classification.js';
import { fetchOobRecords, recordInteraction, readInteractionRecord, issueCallbackHost, oobMissingConfig, readOobConfig } from '../plugins/dsh-redteam-results/lib/server-side-access.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-server-side-access-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

// 本地夹具：一个"DNSLog 平台"（记录命中、提供 CEYE 兼容回查）+ 一个"目标"（替我们发外连）。
const hits = [];
const dnslog = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  if (url.pathname === '/hit') {
    hits.push({ host: url.searchParams.get('domain') || '', type: 'dns', created_at: new Date().toISOString(), remote_addr: '127.0.0.1' });
    res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok');
  }
  if (url.searchParams.get('mode') === 'garbage') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>platform error page</html>'); }
  // 真实平台按 filter（label）过滤；夹具也照做，否则别人的/历史的命中会被算进来。
  const filter = url.searchParams.get('filter') || '';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: hits.filter(hit => !filter || hit.host.startsWith(filter)) }));
});
await new Promise(resolve => dnslog.listen(0, '127.0.0.1', resolve));
const dnslogPort = dnslog.address().port;
let callbacksEnabled = true;
const target = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  const callback = url.searchParams.get('url') || '';
  const label = callback.split('/')[2]?.split('.')[0] || '';
  if (callbacksEnabled && label) {
    // 模拟"目标服务器解析回调域名"：真发一次到平台的请求。
    fetch('http://127.0.0.1:' + dnslogPort + '/hit?domain=' + encodeURIComponent(callback.split('/')[2] || '')).catch(() => {});
  }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('queued');
});
await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + target.address().port + '/proxy';
const host = new URL(endpoint).host;
const CALLBACK_HOST = 'saker-a1b2c3d4.fixture.test';
const LABEL = 'saker-a1b2c3d4';
const packet = (callback) => 'GET /proxy?url=' + encodeURIComponent('http://' + callback + '/') + ' HTTP/1.1\r\nHost: ' + host + '\r\n\r\n';
const method = { id: 'server-side-access', version: 'v1', reviewed: true, endpoint,
  effectSpec: { kind: 'server-side-access/v1', callbackHost: CALLBACK_HOST } };
const row = (id, request) => ({ id, revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request, response: 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nfixture baseline',
  inputs: [{ name: 'url', location: 'query', evidenceIds: [id] }] });

async function prepare(sid, callbackHost = CALLBACK_HOST) {
  startTaskPolicy(store, sid, { mode: 'regular', target: endpoint, budget: { toolCalls: 20 } });
  const active = { ...method, effectSpec: { ...method.effectSpec, callbackHost } };
  saveTaskContext(store, sid, { assets: [{ id: 'asset', url: endpoint, inScope: true, reachable: true }], methods: [active],
    requests: [row('trigger', packet(callbackHost))] });
  createResearch(store, sid, { id: 'direction', requestId: 'trigger', requestRevision: 'v1', controlledInputs: [{ name: 'url', location: 'query' }],
    title: 'Controlled server-side access check', serverPath: 'Local proxy fixture', boundary: 'Payload carries the reviewed callback host',
    normalBehavior: 'Reviewed entry accepts a URL parameter', supportCriterion: 'The callback host receives a request after the trigger',
    falsifier: 'Client-side only, plain error, no platform record, or a record older than the trigger', nextInformation: 'Deterministic comparison only',
    knownCheck: { outcome: 'not-assessed', rationale: 'Synthetic fixture, no product claim', sources: [] } });
  const trigger = await executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId: 'trigger', requestRevision: 'v1', methodId: active.id, methodVersion: active.version });
  return { methodId: active.id, methodVersion: active.version, triggerId: trigger.id, startedAt: trigger.startedAt };
}

try {
  stageMethodClassification(store, { schema: 'saker.method-classification/1', id: method.id, version: method.version,
    digest: '1'.repeat(64), revision: 1, modules: ['exploit/ssrf'], status: 'verified',
    source: { kind: 'manual', version: method.version, position: 'test-server-side-access-effect fixture' } });

  await test('回调平台回查到命中、且发生在触发之后：确认为服务端访问（proofKind=interaction）', async () => {
    const sid = 'positive';
    const run = await prepare(sid);
    await new Promise(r => setTimeout(r, 300));
    const { rows } = await fetchOobRecords({ base: 'http://127.0.0.1:' + dnslogPort, token: 'fixture-token', filter: LABEL });
    assert.equal(rows.length > 0, true, 'fixture platform should have recorded the callback');
    const interaction = recordInteraction(store, sid, { label: LABEL, host: CALLBACK_HOST, rows });
    const verdict = verifyEffect(store, sid, { methodId: method.id, methodVersion: method.version, rounds: [{ trigger: run.triggerId, interaction: interaction.id }] });
    assert.equal(verdict.verified, true, verdict.reason);
    assert.equal(verdict.kind, 'server-side-access/v1');
    assert.equal(verdict.proofKind, 'interaction');
    const record = readInteractionRecord(store, sid, interaction.id);
    assert.equal(record.source, 'host-dnslog-query');
    assert.equal(record.rowCount > 0, true);
  });

  await test('只有客户端访问（目标没有回调）：平台无命中，宿主记录直接拒绝', async () => {
    const sid = 'client-only';
    // 换一个没用过的 label/域名，平台对这个标签确实一条命中都没有。
    const idleHost = 'saker-deadbeef.fixture.test';
    // 先关掉回调再发触发请求：这才是"只有客户端访问"的场景。
    callbacksEnabled = false;
    const run = await prepare(sid, idleHost);
    await new Promise(r => setTimeout(r, 200));
    const { rows } = await fetchOobRecords({ base: 'http://127.0.0.1:' + dnslogPort, token: 'fixture-token', filter: 'saker-deadbeef' });
    callbacksEnabled = true;
    assert.equal(rows.length, 0);
    assert.throws(() => recordInteraction(store, sid, { label: 'saker-deadbeef', host: idleHost, rows }), /no callback recorded/);
    assert.equal(run.triggerId.startsWith('execution-'), true);
  });

  await test('记录早于触发请求（因果不成立）：不算确认', async () => {
    const sid = 'stale-record';
    const run = await prepare(sid);
    await new Promise(r => setTimeout(r, 250));
    const { rows } = await fetchOobRecords({ base: 'http://127.0.0.1:' + dnslogPort, token: 'fixture-token', filter: LABEL });
    const past = new Date(Date.parse(run.startedAt) - 60000).toISOString();
    const interaction = recordInteraction(store, sid, { label: LABEL, host: CALLBACK_HOST, rows, queriedAt: past });
    const verdict = verifyEffect(store, sid, { methodId: method.id, methodVersion: method.version, rounds: [{ trigger: run.triggerId, interaction: interaction.id }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /predates the trigger/);
  });

  await test('回调域名与复核规格对不上：不算确认', async () => {
    const sid = 'host-mismatch';
    const run = await prepare(sid);
    await new Promise(r => setTimeout(r, 250));
    const { rows } = await fetchOobRecords({ base: 'http://127.0.0.1:' + dnslogPort, token: 'fixture-token', filter: LABEL });
    const interaction = recordInteraction(store, sid, { label: LABEL, host: 'saker-ffffffff.fixture.test', rows });
    const verdict = verifyEffect(store, sid, { methodId: method.id, methodVersion: method.version, rounds: [{ trigger: run.triggerId, interaction: interaction.id }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /does not match/);
  });

  await test('平台返回认不出的响应：当失败，不把错误页当命中', async () => {
    await assert.rejects(
      () => fetchOobRecords({ base: 'http://127.0.0.1:' + dnslogPort + '/v1/records?mode=garbage', token: 'fixture-token', filter: LABEL }),
      /无法识别的响应/);
  });

  await test('DNSLog 配置缺项时明确报出缺哪一项；issued host 用配置的接收域名', async () => {
    assert.deepEqual(oobMissingConfig({ base: '', token: 't', root: '' }), ['平台地址', '接收域名']);
    const issued = issueCallbackHost({ base: 'http://fixture', token: 't', root: 'abc123.ceye.io' }, { label: LABEL });
    assert.equal(issued.host, LABEL + '.abc123.ceye.io');
    assert.throws(() => issueCallbackHost({ base: '', token: '', root: '' }), /DNSLog 未配置/);
    // 从 sec-config 命名空间读三项（跨版本：describe 视图）。
    const settings = { describe: () => [{ ns: 'sec-config', value: { dnslog: { url: 'http://ceye.io/', token: 'fixture-token', domain: 'abc123.ceye.io' } } }] };
    assert.deepEqual(readOobConfig(settings), { base: 'http://ceye.io', token: 'fixture-token', root: 'abc123.ceye.io' });
    assert.deepEqual(readOobConfig({}), { base: '', token: '', root: '' });
  });

  await test('未复核或错 kind 的方法规格不能用于该配方', async () => {
    const verdict = verifyEffect(store, 'wrong-kind', { methodId: 'nope', methodVersion: 'v1', rounds: [{ trigger: 'a', interaction: 'b' }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /reviewed effect specification|server-side access/);
  });
} finally {
  await new Promise(resolve => dnslog.close(resolve));
  await new Promise(resolve => target.close(resolve));
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
