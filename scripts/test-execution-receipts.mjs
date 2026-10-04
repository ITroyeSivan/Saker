import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore, registerFinding, updateFinding, getFinding, computeStats, listFindings } from '../plugins/dsh-redteam-results/lib/store.js';
import { summarizeMetrics } from '../plugins/dsh-nday-hunter/lib/metrics.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { createResearch, closeResearch, observeResearch, researchDetail } from '../plugins/dsh-redteam-results/lib/research.js';
import { startTaskPolicy, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { executeRecordedRequest, readExecutionReceipt } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
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
const context = request => ({ assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [normal, ...(request ? [request] : [])], methods: [fixtureMethod] });
function setup(sid, request, budget = 20) {
  startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: budget, discoveryCalls: 3 } });
  saveTaskContext(store, sid, context(request));
  createResearch(store, sid, { id: 'direction', requestId: 'normal', requestRevision: 'v1', controlledInputs: [{ name: 'mode', location: 'query' }],
    title: 'Fixture response comparison', serverPath: 'Local fixture', boundary: 'Synthetic comparison', normalBehavior: 'Fixture own response',
    supportCriterion: 'A separately assessed controlled effect', falsifier: 'No controlled effect', nextInformation: 'Read the actual response',
    knownCheck: { outcome: 'not-assessed', rationale: 'No product claim', sources: [] } });
}
const input = (requestId = 'normal', patch = {}) => ({ hypothesisId: 'direction', requestId, requestRevision: 'v1', ...patch });
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
  await test('HTTP body bytes are sent with exact bounded length and stored separately from submitted response', async () => {
    const body = 'normal business fixture 参数';
    const request = 'POST /api/object HTTP/1.1\r\nHost: ' + host + '\r\nContent-Type: text/plain\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body;
    setup('body', { ...normal, id: 'post', request });
    const result = await executeRecordedRequest(store, 'body', input('post'));
    assert.equal(received.at(-1).body, body); assert.equal(received.at(-1).headers['content-length'], String(Buffer.byteLength(body)));
    assert.equal(readExecutionReceipt(store, 'body', result.id).request.split('\r\n\r\n')[1], body);
  });
  await test('direction and task budgets stop real HTTP execution; restricted directions cannot dispatch', async () => {
    setup('gate'); await executeRecordedRequest(store, 'gate', input()); await executeRecordedRequest(store, 'gate', input());
    let before = received.length;
    await assert.rejects(executeRecordedRequest(store, 'gate', input()), /direction_observation_required/); assert.equal(received.length, before);
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
} finally {
  for (const dispose of disposers.reverse()) await dispose(); store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
