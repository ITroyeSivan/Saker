import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore, registerFinding, updateFinding, getFinding, computeStats, listFindings } from '../plugins/dsh-redteam-results/lib/store.js';
import { summarizeMetrics } from '../plugins/dsh-nday-hunter/lib/metrics.js';
import { saveTaskContext, readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { createResearch, closeResearch, observeResearch, researchDetail } from '../plugins/dsh-redteam-results/lib/research.js';
import { startTaskPolicy, readTaskPolicy, pauseTaskPolicy, resumeTaskPolicy, setTaskActionLimits } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { executeRecordedRequest, readExecutionReceipt } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { stageMethodClassification } from '../plugins/dsh-redteam-results/lib/method-classification.js';
import { saveAccount } from '../plugins/dsh-redteam-results/lib/accounts.js';
import { listTaskEvents } from '../plugins/dsh-redteam-results/lib/task-policy-record.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-receipts-'));
process.env.DSH_HOME = home;
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const file = path.join(home, 'redteam-results/results.db');
let store = openStore(file), failed = 0;
const received = [], tools = new Map(), disposers = [];
results.apply({ tools: { register: tool => tools.set(tool.name, tool), guard: () => {} },
  webServer: { register: () => () => {} }, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); } });
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    const mode = new URL(req.url, 'http://fixture.test').searchParams.get('mode');
    if (mode === 'hang') return;
    if (mode === 'abort') { req.socket.destroy(); return; }
    if (mode === 'redirect') { res.writeHead(302, { location: '/different-entry' }); res.end('redirect'); return; }
    if (mode === 'denied') { res.writeHead(403); res.end('identity denied'); return; }
    if (mode === 'rate') { res.writeHead(429); res.end('too many requests; slow down'); return; }
    if (mode === 'missing') { res.writeHead(404); res.end('route not found'); return; }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-fixture-exchange': String(received.length) });
    res.end(mode === 'large' ? 'x'.repeat(4096) : mode === 'other' ? 'other controlled fixture response' : 'actual fixture response; not a submitted success claim');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/object';
const host = new URL(endpoint).host;
const packet = (query = '') => 'GET /api/object' + query + ' HTTP/1.1\r\nHost: ' + host + '\r\nAuthorization: fixture-only\r\n\r\n';
const normal = { id: 'normal', revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
  request: packet(), response: 'HTTP/1.1 200 OK\r\n\r\nsubmitted old response', inputs: [{ name: 'mode', location: 'query', evidenceIds: ['normal'] }] };
const fixtureMethod = { id: 'fixture-method', version: 'v1', reviewed: true, definition: 'Normal fixture response comparison only' };
// 结构化执行现在必须引用一个**已分类**的方法：它的分类决定哪些模块可以派发。
stageMethodClassification(store, { schema: 'saker.method-classification/1', id: fixtureMethod.id, version: fixtureMethod.version,
  digest: 'a'.repeat(64), revision: 1, modules: ['exploit/sqli'], status: 'verified',
  source: { kind: 'manual', version: fixtureMethod.version, position: 'test-execution-receipts fixture' } });
const context = request => ({ assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [normal, ...(request ? [request] : [])], methods: [fixtureMethod] });
function setup(sid, request, budget = 20) {
  startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: budget, discoveryCalls: 3 } });
  saveTaskContext(store, sid, context(request));
  createResearch(store, sid, { id: 'direction', requestId: 'normal', requestRevision: 'v1', controlledInputs: [{ name: 'mode', location: 'query' }],
    title: 'Fixture response comparison', serverPath: 'Local fixture', boundary: 'Synthetic comparison', normalBehavior: 'Fixture own response',
    supportCriterion: 'A separately assessed controlled effect', falsifier: 'No controlled effect', nextInformation: 'Read the actual response',
    knownCheck: { outcome: 'not-assessed', rationale: 'No product claim', sources: [] } });
}
const input = (requestId = 'normal', patch = {}) => ({ hypothesisId: 'direction', requestId, requestRevision: 'v1',
  methodId: fixtureMethod.id, methodVersion: fixtureMethod.version, ...patch });
const exec = sid => ({ agent: { session: { id: sid, header: { agentPreset: 'pentest' } } } });
async function test(label, fn) { try { await fn(); console.log('ok   ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }
try {
  await test('registered host execution captures actual wire response without accepting a supplied receipt or impact verdict', async () => {
    setup('actual');
    const before = received.length, tool = tools.get('redteam_execution');
    const result = await tool.execute({ action: 'run', ...input(), id: 'invented', impactVerified: true }, exec('actual'));
    assert.equal(result.ok, true, result.error); assert.notEqual(result.id, 'invented'); assert.equal(received.length, before + 1);
    assert.equal(result.source, 'host-http-execution'); assert.equal(result.impactVerified, false); assert.equal(result.requestAttempts, 1); assert.equal(result.requestsWritten, 1);
    assert.equal(result.status, 200); assert.equal(result.outcome, 'response');
    const detail = readExecutionReceipt(store, 'actual', result.id);
    assert.equal(detail.current, true);
    assert.equal(Buffer.from(detail.responseBodyBase64, 'base64').toString(), 'actual fixture response; not a submitted success claim');
    assert(!detail.responseHead.includes('submitted old response'));
    assert.equal(received.at(-1).headers.authorization, 'fixture-only'); assert.equal(received.at(-1).url, '/api/object');
    const rendered = JSON.stringify(tool.output.render({ action: 'run' }, result));
    assert(!rendered.includes('fixture-only')); assert(!rendered.includes('actual fixture response;'));
    assert.equal(readTaskPolicy(store, 'actual').used.toolCalls, 1);
    store.close(); store = openStore(file); assert.equal(readExecutionReceipt(store, 'actual', result.id).requestSha256, result.requestSha256);
    await assert.rejects(tool.execute({ action: 'invalid' }, exec('actual')).then(value => { if (!value.ok) throw Error(value.error); }), /invalid execution|invalid arguments/);
    assert.throws(() => readExecutionReceipt(store, 'other', result.id), /current session/);
    saveTaskContext(store, 'actual', { ...context(), requests: [{ ...normal, revision: 'v2', request: packet('?mode=changed') }] });
    assert.equal(readExecutionReceipt(store, 'actual', result.id).current, false);
  });
  await test('身份绑定：有效账号的秘密套到没带认证头的已存请求，待确认/已失效被拒绝', async () => {
    const bare = { id: 'bare', revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
      request: 'GET /api/object HTTP/1.1\r\nHost: ' + host + '\r\n\r\n', response: 'HTTP/1.1 200 OK\r\n\r\nok', inputs: [] };
    setup('identity', bare);
    const tool = tools.get('redteam_execution');
    saveAccount(store, 'identity', { id: 'acct-1', name: 'fixture-user', status: 'valid', secret: 'Cookie: sid=task-account' });
    const before = received.length;
    const result = await tool.execute({ action: 'run', ...input('bare') }, exec('identity'));
    assert.equal(result.ok, true, result.error);
    assert.equal(received.length, before + 1);
    assert.equal(received.at(-1).headers.cookie, 'sid=task-account', '有效账号的秘密要套到没带认证头的请求上');
    assert.equal(result.identitySecretApplied, 'cookie');
    assert.deepEqual(result.identity, { name: 'fixture-user', status: 'valid' });
    assert(!JSON.stringify(result).includes('sid=task-account'), '工具输出不能带秘密');
    const stored = JSON.parse(store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?').get('identity', result.id).record);
    assert(!JSON.stringify(stored).includes('sid=task-account'), '库里回执也不能带秘密');
    assert.equal(readExecutionReceipt(store, 'identity', result.id).current, true, '注入秘密不应把回执判成过期');
    // 执行回执要同事务写一条带 executionId 的任务事件（v6 第 9.3 节：事件带任务/工作/执行引用）。
    const recorded = listTaskEvents(store, 'identity', { limit: 200 }).events
      .filter(event => event.kind === 'execution-recorded' && event.refs.execution === result.id);
    assert.equal(recorded.length, 1, '执行回执要写一条带 executionId 的任务事件');
    assert.equal(recorded[0].refs.task, 'identity', '事件要指回任务');
    assert.equal(recorded[0].refs.work, 'identity', '事件要指回工作');
    // 请求自己带了认证头时不被覆盖
    const kept = await tool.execute({ action: 'run', ...input('normal') }, exec('identity'));
    assert.equal(kept.ok, true, kept.error);
    assert.equal(received.at(-1).headers.authorization, 'fixture-only', '请求自带的认证头不被覆盖');
    assert.equal(kept.identitySecretApplied, undefined);
    // 待确认 / 已失效都不被当成有效
    saveAccount(store, 'identity', { id: 'acct-1', name: 'fixture-user', status: 'unconfirmed', secret: '' });
    const pending = await tool.execute({ action: 'run', ...input('bare') }, exec('identity'));
    assert.equal(pending.ok, false); assert.match(pending.error, /identity_unconfirmed/);
    saveAccount(store, 'identity', { id: 'acct-1', name: 'fixture-user', status: 'expired', secret: '' });
    const expired = await tool.execute({ action: 'run', ...input('bare') }, exec('identity'));
    assert.equal(expired.ok, false); assert.match(expired.error, /identity_expired/);
  });
  await test('关闭“允许访问网站”后浏览器执行在启动浏览器前被拒绝', async () => {
    setup('browser-guard');
    const tool = tools.get('redteam_execution');
    setTaskActionLimits(store, 'browser-guard', { allowTargetNetwork: false }, 'desktop-user');
    const blocked = await tool.execute({ action: 'browser-run', document: JSON.stringify({ url: 'https://fixture.test/' }) }, exec('browser-guard'));
    assert.equal(blocked.ok, false, '浏览器执行必须被拒绝');
    assert.match(blocked.error, /target_network_disabled/);
    // 打开网站访问后不再被动作限制拦下（其余校验按各自规则继续）
    setTaskActionLimits(store, 'browser-guard', { allowTargetNetwork: true }, 'desktop-user');
    const allowed = await tool.execute({ action: 'browser-run', document: JSON.stringify({ url: 'not-a-url' }) }, exec('browser-guard'));
    assert.equal(allowed.ok, false);
    assert(!/target_network_disabled/.test(allowed.error), '打开后不应再由动作限制拦下：' + allowed.error);
  });
  await test('parser rejects endpoint Host framing and identity errors before requests or budget are consumed', async () => {
    for (const [name, patch] of [
      ['path', { request: packet().replace('/api/object', '/other') }], ['host', { request: packet().replace(host, 'outside.test') }],
      ['length', { request: packet().replace('\r\n\r\n', '\r\nContent-Length: 3\r\n\r\n') }],
      ['duplicate', { request: packet().replace('\r\n\r\n', '\r\nHost: ' + host + '\r\n\r\n') }],
      ['identity', { authContext: 'other-user' }], ['revision', {}],
      ['header-encoding', { request: packet().replace('fixture-only', '非ASCII') }],
      ['chunked', { request: packet().replace('\r\n\r\n', '\r\nTransfer-Encoding: chunked\r\n\r\n') }]
    ]) {
      const sid = 'invalid-' + name; setup(sid, { ...normal, id: 'probe', ...patch });
      const before = received.length;
      await assert.rejects(executeRecordedRequest(store, sid, input('probe', name === 'revision' ? { requestRevision: 'missing' } : {})));
      assert.equal(received.length, before); assert.equal(readTaskPolicy(store, sid).used.toolCalls, 0);
    }
    setup('scope'); saveTaskContext(store, 'scope', { ...context(), assets: [{ ...context().assets[0], inScope: false }] });
    await assert.rejects(executeRecordedRequest(store, 'scope', input()), /reachable authorized asset/);
  });
  await test('redirect blocked identity truncation timeout and transport failure remain execution outcomes, never impact', async () => {
    for (const [mode, outcome] of [['redirect', 'redirect-not-followed'], ['denied', 'response'], ['large', 'response-limit'], ['hang', 'timeout'], ['abort', 'transport-error']]) {
      const sid = 'result-' + mode;
      setup(sid, { ...normal, id: 'probe', request: packet('?mode=' + mode), valid: false });
      const before = received.length;
      const result = await executeRecordedRequest(store, sid, input('probe', { timeoutMs: 100, maxBytes: 128 }));
      assert.equal(result.outcome, outcome); assert.equal(result.impactVerified, false); assert.equal(result.redirectFollowed, false);
      assert.equal(received.length, before + 1); assert.equal(result.requestAttempts, 1); assert.equal(result.requestsWritten, 1); assert(result.capturedBytes <= 128);
      assert.equal(readTaskPolicy(store, sid).used.toolCalls, 1);
      assert.equal(readExecutionReceipt(store, sid, result.id).outcome, outcome);
      if (mode === 'denied') assert.equal(result.status, 403);
      if (mode === 'large') assert(result.responseBytes > result.capturedBytes);
    }
  });
  await test('限流 429 暂停任务并给出具体原因，不自动重试', async () => {
    const sid = 'result-rate';
    setup(sid, { ...normal, id: 'probe', request: packet('?mode=rate'), valid: false });
    const before = received.length;
    const result = await executeRecordedRequest(store, sid, input('probe', { timeoutMs: 500, maxBytes: 256 }));
    assert.equal(result.outcome, 'response'); assert.equal(result.status, 429);
    assert.equal(result.taskPaused, true); assert.equal(result.blocker, 'normal-access-failed');
    assert.equal(received.length, before + 1, 'a rate-limited call is attempted exactly once, never retried');
    assert.equal(readTaskPolicy(store, sid).blocker.code, 'normal-access-failed');
    // 已暂停的任务不再派发新的目标操作
    await assert.rejects(executeRecordedRequest(store, sid, input('probe')), /任务已停止|baseline_recheck_required|active direction/);
    assert.equal(received.length, before + 1);
  });
  await test('身份失效（login-expired）沿任务树传播到父任务，父任务一并暂停', async () => {
    const parent = 'parent-login', child = 'child-login';
    // 复查的正常对照在真实目标上返回 403 → 身份失效（login-expired）。
    const probe = { ...normal, id: 'probe', request: packet('?mode=denied'), valid: true, response: 'HTTP/1.1 200 OK\r\n\r\nold normal response' };
    startTaskPolicy(store, parent, { mode: 'regular', budget: { toolCalls: 20 } });
    // 子任务必须在 site_workers 里挂到父任务下：startTaskPolicy 只认这张表判定父子关系。
    store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)')
      .run(parent, child, endpoint, JSON.stringify({ parentId: parent, childId: child, site: endpoint, state: 'running', allowedTools: ['redteam_execution'] }));
    startTaskPolicy(store, child, { mode: 'regular', budget: { toolCalls: 20, discoveryCalls: 3, workers: 0 } });
    saveTaskContext(store, child, context(probe));
    createResearch(store, child, { id: 'direction', requestId: 'normal', requestRevision: 'v1', controlledInputs: [{ name: 'mode', location: 'query' }],
      title: 'Fixture response comparison', serverPath: 'Local fixture', boundary: 'Synthetic comparison', normalBehavior: 'Fixture own response',
      supportCriterion: 'A separately assessed controlled effect', falsifier: 'No controlled effect', nextInformation: 'Read the actual response',
      knownCheck: { outcome: 'not-assessed', rationale: 'No product claim', sources: [] } });
    // 用户处理过一次阻碍 → 进入"需要 baseline 复查"；复查返回 403 即判定身份失效。
    pauseTaskPolicy(store, child, { code: 'ip-blocked', reason: 'fixture blocker', evidence: 'fixture' });
    resumeTaskPolicy(store, child, '访问已恢复', 'desktop-user');
    const result = await executeRecordedRequest(store, child, { ...input('probe'), purpose: 'baseline' });
    assert.equal(result.taskPaused, true);
    assert.equal(result.blocker, 'login-expired');
    assert.equal(readTaskPolicy(store, child).blocker.code, 'login-expired');
    const parentPolicy = readTaskPolicy(store, parent);
    assert.equal(parentPolicy.blocker?.code, 'login-expired', '身份失效必须沿任务树传播到父任务');
    assert.match(String(parentPolicy.blocker.evidence), /HTTP=403/);
    // 子操作计入主子共享预算（第 8.2 节），父任务额度随之 +1；传播只加阻碍、不重置预算。
    assert.equal(parentPolicy.used.toolCalls, 1, '子操作计入父任务共享预算');
    assert.equal(parentPolicy.budget.toolCalls, 20, '传播不改变父任务预算上限');
  });
  await test('HTTP body bytes are sent with exact bounded length and stored separately from submitted response', async () => {
    const body = 'normal business fixture 参数';
    const request = 'POST /api/object HTTP/1.1\r\nHost: ' + host + '\r\nContent-Type: text/plain\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body;
    setup('body', { ...normal, id: 'post', request });
    const result = await executeRecordedRequest(store, 'body', input('post'));
    assert.equal(received.at(-1).body, body); assert.equal(received.at(-1).headers['content-length'], String(Buffer.byteLength(body)));
    assert.equal(readExecutionReceipt(store, 'body', result.id).request.split('\r\n\r\n')[1], body);
  });
  await test('repeated probes run on the task budget, and a restricted direction cannot dispatch', async () => {
    setup('gate');
    for (let index = 0; index < 5; index += 1) await executeRecordedRequest(store, 'gate', input());
    assert.equal(readTaskPolicy(store, 'gate').used.toolCalls, 5, 'probing is bounded by the task budget, not by a per-direction count');
    let before = received.length;
    setup('budget', undefined, 1); await executeRecordedRequest(store, 'budget', input()); before = received.length;
    await assert.rejects(executeRecordedRequest(store, 'budget', input()), /任务已停止/); assert.equal(received.length, before);
    setup('restricted'); closeResearch(store, 'restricted', 'direction', 'Reported policy interruption', 'safety-policy');
    await assert.rejects(executeRecordedRequest(store, 'restricted', input()), /active direction/); assert.equal(received.length, before);
  });
  await test('research observations derive packets and times from two distinct session-bound host receipts without reusing executions', async () => {
    setup('observation', { ...normal, id: 'probe', request: packet('?mode=other') });
    const control = await executeRecordedRequest(store, 'observation', input());
    const probe = await executeRecordedRequest(store, 'observation', input('probe'));
    const observation = { id: 'round-1', outcome: 'support', endpoint, authContext: normal.authContext,
      controlReceiptId: control.id, probeReceiptId: probe.id,
      control: { request: 'fabricated', response: 'fabricated' }, probe: { request: 'fabricated', response: 'fabricated' },
      executedAt: 'invented', runner: 'invented', expected: 'Controlled fixture difference', observed: 'Actual controlled response',
      interpretation: 'Fixture execution only, no real product impact', nextInformation: 'Independently assess effect' };
    assert.throws(() => observeResearch(store, 'observation', 'direction', { ...observation, controlReceiptId: 'invented' }), /current session/);
    assert.throws(() => observeResearch(store, 'observation', 'direction', { ...observation, probeReceiptId: control.id }), /distinct/);
    const value = observeResearch(store, 'observation', 'direction', observation);
    assert.equal(value.observations[0].evidenceOrigin, 'host-http-execution');
    assert.equal(value.observations[0].runner, 'host-http-execution');
    assert(value.observations[0].probe.response.includes('other controlled fixture response'));
    assert(!value.observations[0].probe.response.includes('fabricated'));
    assert.equal(value.observations[0].executedAt, probe.completedAt);
    assert.throws(() => observeResearch(store, 'observation', 'direction', { ...observation, id: 'recycled' }), /already used/);
    assert.equal(researchDetail(store, 'observation', 'direction').attempts, 1);
    assert.equal(readTaskPolicy(store, 'observation').used.toolCalls, 2);
    const otherControl = await executeRecordedRequest(store, 'observation', input());
    const otherProbe = await executeRecordedRequest(store, 'observation', input('probe'));
    const second = observeResearch(store, 'observation', 'direction', { ...observation, id: 'round-2', controlReceiptId: otherControl.id, probeReceiptId: otherProbe.id });
    assert.equal(second.state, 'supported'); assert.equal(second.observations.length, 2); assert.equal(second.noveltyProven, false);
  });
  await test('changing response headers alone cannot promote identical host response bodies to support', async () => {
    setup('headers-only');
    const control = await executeRecordedRequest(store, 'headers-only', input());
    const probe = await executeRecordedRequest(store, 'headers-only', input());
    const controlDetail = readExecutionReceipt(store, 'headers-only', control.id), probeDetail = readExecutionReceipt(store, 'headers-only', probe.id);
    assert.notEqual(controlDetail.responseHead, probeDetail.responseHead);
    assert.equal(controlDetail.responseBodyBase64, probeDetail.responseBodyBase64);
    assert.throws(() => observeResearch(store, 'headers-only', 'direction', { id: 'false-support', outcome: 'support', endpoint,
      authContext: normal.authContext, controlReceiptId: control.id, probeReceiptId: probe.id }), /observed difference/);
    assert.equal(researchDetail(store, 'headers-only', 'direction').attempts, 0);
  });
  await test('finding delivery derives current execution binding but cannot count HTTP responses or supplied impact verdicts as confirmed effects', async () => {
    const sid = 'delivery-binding', probeRequest = { ...normal, id: 'probe', request: packet('?mode=other') };
    setup(sid, probeRequest);
    const methodInput = { methodId: fixtureMethod.id, methodVersion: fixtureMethod.version };
    const control = await executeRecordedRequest(store, sid, input('normal', methodInput));
    const probe = await executeRecordedRequest(store, sid, input('probe', methodInput));
    const detail = readExecutionReceipt(store, sid, probe.id);
    const reproduction = { kind: 'method', methodId: fixtureMethod.id, mechanism: 'fixture-comparison', methodVersion: 'v1', endpoint,
      prerequisites: [], dependencies: [], parameters: [], steps: ['Replay the saved fixture request'], successCriterion: 'A controlled response difference',
      reviewSteps: 'Independently verify the effect rather than status', recovery: 'No persistent changes',
      verification: { status: 'verified', evidenceIds: [probe.id], controlReceiptId: control.id, probeReceiptId: probe.id } };
    const pending = registerFinding(store, sid, 'pentest', { title: 'Claimed fixture effect', severity: 'high', evidenceLevel: 'impact', proofKind: 'execution',
      identity: normal.authContext, impact: 'Caller claims execution', evidence: probe.id, target: endpoint,
      requestPkt: detail.request, responsePkt: detail.responseHead + Buffer.from(detail.responseBodyBase64, 'base64').toString(),
      reproduction: JSON.stringify(reproduction), executionEvidence: { verified: true, impactVerified: true } });
    let row = updateFinding(store, sid, 'pentest', pending.id, { status: 'verified', secondRating: 'high',
      secondRatingNote: 'Caller claims a successful execution effect despite only presenting a normal HTTP response.' });
    assert.equal(row.delivery.executionVerified, true, row.executionEvidence.reason); assert.equal(row.executionEvidence.impactVerified, false);
    assert.equal(row.delivery.ready, false); assert.equal(row.delivery.rce, false);
    assert(!row.delivery.gaps.includes('host-execution-evidence-missing'));
    assert(row.delivery.gaps.includes('independent-impact-verification-missing'));
    assert.equal(computeStats(store, sid, 'pentest').delivery.ready, 0);
    assert.equal(listFindings(store, sid, 'pentest', { delivery: 'ready' }).total, 0);
    assert.equal(listFindings(store, sid, 'pentest', { delivery: 'incomplete' }).total, 1);
    assert.equal(summarizeMetrics(home, { sessionId: sid }).confirmedRce, 0);
    saveTaskContext(store, sid, { ...context(probeRequest), methods: [{ ...fixtureMethod, reviewer: 'Updated review annotation', reviewNotes: 'Same method content' }] });
    assert.equal(getFinding(store, sid, row.id).delivery.executionVerified, true);
    row = updateFinding(store, sid, 'pentest', row.id, { responsePkt: 'HTTP/1.1 200 OK\r\n\r\ninvented impact' });
    assert.equal(row.delivery.executionVerified, false);
    row = updateFinding(store, sid, 'pentest', row.id, { responsePkt: detail.responseHead + Buffer.from(detail.responseBodyBase64, 'base64').toString(),
      reproduction: JSON.stringify({ ...reproduction, methodVersion: 'v2' }) });
    assert.equal(row.delivery.executionVerified, false);
    updateFinding(store, sid, 'pentest', row.id, { reproduction: JSON.stringify(reproduction) });
    saveTaskContext(store, sid, { ...context(probeRequest), methods: [{ ...fixtureMethod, version: 'v2', definition: 'Changed method semantics' }] });
    assert.equal(getFinding(store, sid, row.id).delivery.executionVerified, false);
    assert.equal(summarizeMetrics(home, { sessionId: sid }).confirmedFindings, 0);
  });
  await test('first contact: 没有任何研究方向时，已存的 in-scope GET 可以先跑一次拿回执，之后不再放行', async () => {
    const sid = 'first-contact';
    const request = { ...normal, id: 'fc-1', valid: false, request: packet('?mode=fc') };
    startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: 10 } });
    saveTaskContext(store, sid, { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [request], methods: [] });
    const receipt = await executeRecordedRequest(store, sid, { requestId: 'fc-1', requestRevision: 'v1', purpose: 'first-contact' });
    assert.equal(receipt.outcome, 'response');
    assert.equal(receipt.hypothesisId, 'first-contact');
    assert.equal(readExecutionReceipt(store, sid, receipt.id).source, 'host-http-execution');
    // 同一请求已经拿过回执：不能重复走第一次接触
    await assert.rejects(executeRecordedRequest(store, sid, { requestId: 'fc-1', requestRevision: 'v1', purpose: 'first-contact' }),
      /unconfirmed baseline|already has a first-contact receipt/);
    // 没有 purpose 依然要求研究方向（不许拿它当常开后门）
    // 没有 purpose 时报错必须可执行：说明该给研究方向，或先用 first-contact 取基线
    await assert.rejects(executeRecordedRequest(store, sid, { requestId: 'fc-1', requestRevision: 'v1' }),
      error => /research direction/.test(error.message) && /first-contact/.test(error.message));
    // 拿到回执后：用 responseReceiptId 让宿主回填原文 → 标 valid → 建研究方向（整条链打通）
    const saved = saveTaskContext(store, sid, { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [{
      ...request, valid: true, kind: 'api', responseReceiptId: receipt.id,
      inputs: [{ name: 'mode', location: 'query', evidenceIds: ['fc-1'] }],
    }], methods: [] });
    assert.equal(saved.requests[0].valid, true);
    assert.match(saved.requests[0].response, /^HTTP\/\S+\s+200\b/, saved.requests[0].response);
    assert.equal(saved.requests[0].request, readExecutionReceipt(store, sid, receipt.id).request, '请求原文按回执逐字回填');
    // J11c 实测：宿主回填会把"模型手写报文"规范成实际发出的报文——这次规范化**不能**让
    // 已执行的回执变 stale（旧口径按行原文哈希，回填后整条对照链都评估不了）。
    assert.equal(readExecutionReceipt(store, sid, receipt.id).current, true, '回填的格式规范化不得让回执失效');
    // 但语义变化（查询参数改了）必须撤销回执——规范化不等于"随便改都不算"。
    const storedContext = JSON.parse(store.db.prepare('SELECT record FROM task_context WHERE session_id=?').get(sid).record);
    storedContext.requests[0].request = packet('?mode=changed');
    store.db.prepare('UPDATE task_context SET record=?, updated_at=? WHERE session_id=?')
      .run(JSON.stringify(storedContext), new Date().toISOString(), sid);
    assert.equal(readExecutionReceipt(store, sid, receipt.id).current, false, '报文语义变化必须撤销回执');
    const direction = createResearch(store, sid, { id: 'fc-direction', requestId: 'fc-1', requestRevision: 'v1',
      question: 'q 参数是否进入后端查询？', expectedEffect: '可归因的响应差异', negativeResult: '参数被忽略', nextStep: '读原始响应' });
    assert.equal(direction.id, 'fc-direction');
    assert.deepEqual(direction.controlledInputs, [{ name: 'mode', location: 'query' }]);
  });
  await test('first contact can skip a 404 and try another unexecuted GET until a 2xx baseline appears', async () => {
    const sid = 'first-contact-404';
    const root = { ...normal, id: 'fc-root', valid: false, request: packet('?mode=missing') };
    const live = { ...normal, id: 'fc-live', valid: false, request: packet('?mode=ok') };
    startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: 10 } });
    saveTaskContext(store, sid, { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [root, live], methods: [] });
    const missing = await executeRecordedRequest(store, sid, { requestId: 'fc-root', requestRevision: 'v1', purpose: 'first-contact' });
    assert.equal(missing.status, 404);
    await assert.rejects(executeRecordedRequest(store, sid, { requestId: 'fc-root', requestRevision: 'v1', purpose: 'first-contact' }),
      /already has a first-contact receipt/);
    const receipt = await executeRecordedRequest(store, sid, { requestId: 'fc-live', requestRevision: 'v1', purpose: 'first-contact' });
    assert.equal(receipt.status, 200);
    assert.equal(readTaskPolicy(store, sid).used.toolCalls, 2);
    const third = { ...normal, id: 'fc-third', valid: false, request: packet('?mode=other') };
    saveTaskContext(store, sid, { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [root, live, third], methods: [] });
    const thirdReceipt = await executeRecordedRequest(store, sid, { requestId: 'fc-third', requestRevision: 'v1', purpose: 'first-contact' });
    assert.equal(thirdReceipt.status, 200, 'material path checks remain available after the first successful baseline');
    for (const id of ['fc-4', 'fc-5']) {
      const extra = { ...normal, id, valid: false, request: packet('?mode=' + id) };
      saveTaskContext(store, sid, { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [root, live, third, extra], methods: [] });
      await executeRecordedRequest(store, sid, { requestId: id, requestRevision: 'v1', purpose: 'first-contact' });
    }
    const sixth = { ...normal, id: 'fc-6', valid: false, request: packet('?mode=fc6') };
    saveTaskContext(store, sid, { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [root, live, third, sixth], methods: [] });
    await assert.rejects(executeRecordedRequest(store, sid, { requestId: 'fc-6', requestRevision: 'v1', purpose: 'first-contact' }),
      /limit reached/);
  });
  await test('已绑定方向的基线证据被改写后，后续执行/对照给出可执行原因而不是静默失效', async () => {
    const sid = 'bound-baseline';
    const request = { ...normal, id: 'bb-1', valid: false, request: packet('?mode=bb') };
    const assets = [{ id: 'a', url: endpoint, inScope: true, reachable: true }];
    startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: 10 } });
    saveTaskContext(store, sid, { assets, requests: [request], methods: [] });
    const receipt = await executeRecordedRequest(store, sid, { requestId: 'bb-1', requestRevision: 'v1', purpose: 'first-contact' });
    const base = { ...request, valid: true, kind: 'api', responseReceiptId: receipt.id,
      inputs: [{ name: 'mode', location: 'query', evidenceIds: ['bb-1'] }] };
    saveTaskContext(store, sid, { assets, requests: [base], methods: [] });
    createResearch(store, sid, { id: 'bb-direction', requestId: 'bb-1', requestRevision: 'v1',
      question: '基线被改写后会怎样？', expectedEffect: '后续操作给可执行原因', negativeResult: '静默失效', nextStep: '先加探针再改写' });
    // 原样重存（含同一回执）必须放行。
    saveTaskContext(store, sid, { assets, requests: [{ ...base }], methods: [] });
    assert.equal(researchDetail(store, sid, 'bb-direction').current, true);
    // 探针请求可以随便加——对照不受影响。
    saveTaskContext(store, sid, { assets, requests: [base, { ...request, id: 'bb-probe', request: packet('?mode=other'), valid: false }], methods: [] });
    assert.equal(readTaskContext(store, sid).requests.length, 2);
    assert.equal(researchDetail(store, sid, 'bb-direction').current, true, '追加探针不得影响方向绑定');
    // J11e 实测：给已绑定基线换一份"更新"的响应原文（等价于换证据）会改变绑定。按既有设计，
    // 保存仍然放行（保留历史），但后续执行/对照必须给出**可执行原因**（research baseline changed），
    // 不能再只报模糊的 "current research baseline required"。
    const probe = { ...request, id: 'bb-probe', request: packet('?mode=other'), valid: false };
    saveTaskContext(store, sid, { assets, requests: [base, probe], methods: [] });
    const probeReceipt = await executeRecordedRequest(store, sid, { hypothesisId: 'bb-direction', requestId: 'bb-probe', requestRevision: 'v1' });
    saveTaskContext(store, sid, { assets, requests: [{ ...base, responseReceiptId: probeReceipt.id }, probe], methods: [] });
    const broken = researchDetail(store, sid, 'bb-direction');
    assert.equal(broken.current, false);
    assert.match(broken.blockedReason, /baseline changed/, '方向被阻断的原因必须如实暴露');
    await assert.rejects(executeRecordedRequest(store, sid, { hypothesisId: 'bb-direction', requestId: 'bb-probe', requestRevision: 'v1' }),
      /baseline changed/, '执行被阻断时要带上真实原因');
  });
} finally {
  for (const dispose of disposers.reverse()) await dispose(); store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
