// 浏览器执行的按机制确认（v6 第 9.1 节）：宿主真的开浏览器，载荷必须在真实 HTTP(S) origin 上执行；
// 仅回显、被转义、被 CSP 拦下、本地 file 环境都不算。
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
import { runBrowserExecution, recordBrowserReceipt, findBrowserExecutable } from '../plugins/dsh-redteam-results/lib/browser-execution.js';

const MARKER = 'browser-probe-marker-42';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-browser-execution-'));
process.env.DSH_HOME = home;
const cft = process.env.SAKER_CFT_PATH || 'E:\\software\\ChromeForTesting\\chrome-win64\\chrome.exe';
if (fs.existsSync(cft)) process.env.SAKER_CFT_PATH = cft;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
// 三种页面：会执行、被转义、被 CSP 拦下。
const page = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  const payload = decodeURIComponent(url.searchParams.get('payload') || '');
  const escaped = url.searchParams.get('escaped') || '';
  if (escaped) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body><pre>' + escapeHtml(decodeURIComponent(escaped)) + '</pre></body></html>'); }
  if (url.searchParams.get('csp')) { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'none'" }); return res.end('<html><body><script>' + payload + '</script></body></html>'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body><script>' + payload + '</script></body></html>');
});
await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + page.address().port;
const endpoint = origin + '/echo';
const host = new URL(endpoint).host;
const payload = 'window.__sakerProbe="' + MARKER + '"';
const packet = 'GET /echo?payload=' + encodeURIComponent(payload) + ' HTTP/1.1\r\nHost: ' + host + '\r\n\r\n';
const method = { id: 'browser-execution', version: 'v1', reviewed: true, endpoint, effectSpec: { kind: 'browser-execution/v1', marker: MARKER } };
const row = (id, request) => ({ id, revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request, response: 'HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\nfixture baseline',
  inputs: [{ name: 'payload', location: 'query', evidenceIds: [id] }] });

async function prepare(sid) {
  startTaskPolicy(store, sid, { mode: 'regular', target: endpoint, budget: { toolCalls: 20 } });
  saveTaskContext(store, sid, { assets: [{ id: 'asset', url: endpoint, inScope: true, reachable: true }], methods: [method], requests: [row('trigger', packet)] });
  createResearch(store, sid, { id: 'direction', requestId: 'trigger', requestRevision: 'v1', controlledInputs: [{ name: 'payload', location: 'query' }],
    title: 'Controlled browser execution check', serverPath: 'Local HTML fixture', boundary: 'Reviewed payload on the reviewed HTTP origin',
    normalBehavior: 'Reviewed page renders the submitted value', supportCriterion: 'window.__sakerProbe is set to the reviewed marker in a real browser',
    falsifier: 'Reflection only, escaping, CSP blocking, or a local file environment', nextInformation: 'Deterministic comparison only',
    knownCheck: { outcome: 'not-assessed', rationale: 'Synthetic fixture, no product claim', sources: [] } });
  const trigger = await executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId: 'trigger', requestRevision: 'v1', methodId: method.id, methodVersion: method.version });
  return trigger.id;
}

try {
  stageMethodClassification(store, { schema: 'saker.method-classification/1', id: method.id, version: method.version,
    digest: '3'.repeat(64), revision: 1, modules: ['exploit/xss'], status: 'verified',
    source: { kind: 'manual', version: method.version, position: 'test-browser-execution-effect fixture' } });

  await test('真实浏览器里载荷执行（probe 命中）：确认为浏览器执行（proofKind=other-impact）', async () => {
    const sid = 'positive';
    const trigger = await prepare(sid);
    const receipt = await runBrowserExecution({ url: endpoint + '?payload=' + encodeURIComponent(payload), marker: MARKER });
    const stored = recordBrowserReceipt(store, sid, receipt);
    assert.equal(stored.executed, true, 'payload should execute on the vulnerable fixture page');
    assert.equal(stored.origin, origin);
    const verdict = verifyEffect(store, sid, { methodId: method.id, methodVersion: method.version, rounds: [{ trigger, browser: stored.id }] });
    assert.equal(verdict.verified, true, verdict.reason);
    assert.equal(verdict.kind, 'browser-execution/v1');
    assert.equal(verdict.proofKind, 'other-impact');
    const record = readEffectVerification(store, sid, verdict.id);
    assert.equal(record.comparisons[0].origin, origin);
    assert.equal(record.comparisons[0].executedInBrowser, true);
    assert.equal(record.comparisons[0].localFileExcluded, true);
  });

  await test('被转义（只有文本回显）：不算执行', async () => {
    const sid = 'escaped';
    const trigger = await prepare(sid);
    const receipt = await runBrowserExecution({ url: endpoint + '?escaped=' + encodeURIComponent(payload), marker: MARKER });
    const stored = recordBrowserReceipt(store, sid, receipt);
    assert.equal(stored.executed, false);
    const verdict = verifyEffect(store, sid, { methodId: method.id, methodVersion: method.version, rounds: [{ trigger, browser: stored.id }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /did not execute/);
  });

  await test('CSP 拦下脚本：不算执行', async () => {
    const sid = 'csp';
    const trigger = await prepare(sid);
    const receipt = await runBrowserExecution({ url: endpoint + '?csp=1&payload=' + encodeURIComponent(payload), marker: MARKER });
    const stored = recordBrowserReceipt(store, sid, receipt);
    assert.equal(stored.executed, false);
    const verdict = verifyEffect(store, sid, { methodId: method.id, methodVersion: method.version, rounds: [{ trigger, browser: stored.id }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /did not execute/);
  });

  await test('浏览器回执的 origin 与复核入口对不上：不算确认', async () => {
    const sid = 'origin-mismatch';
    const trigger = await prepare(sid);
    const other = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><script>' + payload + '</script></body></html>'); });
    await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
    try {
      const receipt = await runBrowserExecution({ url: 'http://127.0.0.1:' + other.address().port + '/', marker: MARKER });
      const stored = recordBrowserReceipt(store, sid, receipt);
      assert.equal(stored.executed, true);
      const verdict = verifyEffect(store, sid, { methodId: method.id, methodVersion: method.version, rounds: [{ trigger, browser: stored.id }] });
      assert.equal(verdict.verified, false);
      assert.match(String(verdict.reason), /origin does not match/);
    } finally { await new Promise(resolve => other.close(resolve)); }
  });

  await test('本地 file 环境：直接拒绝（不作为浏览器执行证据）', async () => {
    await assert.rejects(() => runBrowserExecution({ url: 'file:///C:/Windows/win.ini', marker: MARKER }), /只接受真实 HTTP\(S\) origin/);
  });

  await test('未复核或错 kind 的方法规格不能用于该配方；找不到浏览器时明确报错', async () => {
    const verdict = verifyEffect(store, 'wrong-kind', { methodId: 'nope', methodVersion: 'v1', rounds: [{ trigger: 'a', browser: 'b' }] });
    assert.equal(verdict.verified, false);
    assert.match(String(verdict.reason), /reviewed effect specification|browser execution/);
    // 显式路径不存在时回退到本机 Chrome/Edge，而不是假装"执行过"。
    const found = findBrowserExecutable('C:/definitely/not/a/browser.exe');
    assert.equal(fs.statSync(found).isFile(), true);
  });
} finally {
  await new Promise(resolve => page.close(resolve));
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
