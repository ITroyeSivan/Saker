import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, registerFinding, updateFinding, getFinding, listFindings, groupByTarget, computeStats } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy, taskPolicyStatus } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createResearch, closeResearch, observeResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { executeRecordedRequest, readExecutionReceipt } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { verifyEffect, readEffectVerification, assessPrivateReadRound } from '../plugins/dsh-redteam-results/lib/effect-verifications.js';
import { runEffectJob, readEffectJob } from '../plugins/dsh-redteam-results/lib/effect-jobs.js';
import { summarizeMetrics } from '../plugins/dsh-nday-hunter/lib/metrics.js';
import { buildDeliveryFiles } from '../plugins/dsh-redteam-results/lib/bundle.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-verification-'));
process.env.DSH_HOME = home;
process.env.DSH_ATLAS_DB = path.join(home, 'unused-atlas.db');
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const file = path.join(home, 'redteam-results/results.db');
let store = openStore(file), failed = 0, requests = 0;
const tools = new Map(), disposers = [];
results.apply({ tools: { register: tool => tools.set(tool.name, tool), guard: () => {} }, webServer: { register: () => () => {} },
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); } });
const secrets = { owner: randomUUID(), subject: randomUUID() };
let heldRequest;
const server = http.createServer((req, res) => {
  requests++;
  const url = new URL(req.url, 'http://fixture.test'), mode = url.searchParams.get('mode'), object = url.searchParams.get('id');
  const credential = req.headers.authorization, identity = credential === 'Fixture owner' ? 'owner' : credential === 'Fixture subject' ? 'subject' : '';
  if (mode === 'hang' && object === 'owner' && !identity) { heldRequest?.(); return; }
  if (object === 'public') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'public', note: 'Anonymous normal business baseline' })); return; }
  if (!identity || (mode === 'fixed' && object === 'owner' && identity !== 'owner')) { res.writeHead(403); res.end('denied'); return; }
  if (mode === 'expired' && identity === 'subject') { res.writeHead(401); res.end('expired session'); return; }
  if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('generic application page'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  const owner = object === 'owner' ? 'owner' : 'subject';
  const value = { id: 'private-' + owner, ownerId: owner, viewerId: mode === 'wrong-viewer' ? 'owner' : identity, visibility: mode === 'public' ? 'public' : 'private',
    readers: mode === 'shared' ? [owner, 'subject'] : [owner], secret: mode === 'echo' && object === 'owner' ? (url.searchParams.get('marker') || secrets[owner]) : secrets[owner] };
  res.end(JSON.stringify(value));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/object', host = new URL(endpoint).host;
const method = { id: 'private-read', version: 'v1', reviewed: true, endpoint,
  effectSpec: { kind: 'private-json-read/v1', resourceIdPath: '/id', ownerIdPath: '/ownerId', viewerIdPath: '/viewerId', visibilityPath: '/visibility', readersPath: '/readers', markerPath: '/secret' } };
const packet = (identity, object, mode) => 'GET /api/object?id=' + object + '&mode=' + mode + (mode === 'echo' ? '&marker=' + secrets.owner : '')
  + ' HTTP/1.1\r\nHost: ' + host + (identity ? '\r\nAuthorization: Fixture ' + identity : '') + '\r\n\r\n';
const row = (id, identity, object, mode, valid = true) => ({ id, revision: 'v1', endpoint, authContext: identity || 'anonymous', kind: 'api', valid,
  request: packet(identity, object, mode), response: 'HTTP/1.1 200 OK\r\n\r\nnormal fixture baseline', inputs: [{ name: 'id', location: 'query', evidenceIds: [id] }] });
const context = (mode = 'vulnerable') => ({ assets: [{ id: 'asset', url: endpoint, inScope: true, reachable: true }], methods: [method], requests: [
  row('owner', 'owner', 'owner', mode), row('anonymous-normal', '', 'public', mode), row('denied', '', 'owner', mode, false),
  row('normal', 'subject', 'subject', mode), row('probe', 'subject', 'owner', mode, false) ] });
const jobInput = { methodId: method.id, methodVersion: method.version, roles: Object.fromEntries(
  ['owner', 'normal', 'probe', 'denied'].map(role => [role, { requestId: role, requestRevision: 'v1' }])) };
function prepareJob(sid, mode = 'vulnerable', budget = 20) {
  startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: budget } });
  saveTaskContext(store, sid, context(mode));
}
function direction(sid, id, requestId) {
  createResearch(store, sid, { id, requestId, requestRevision: 'v1', controlledInputs: [{ name: 'id', location: 'query' }], title: 'Controlled private read comparison',
    serverPath: 'Local object fixture', boundary: 'Reviewed private-owner/readers contract', normalBehavior: 'Own object or public baseline works',
    supportCriterion: 'Owner-only private marker disclosed to another authenticated subject', falsifier: 'Other private object is denied',
    nextInformation: 'Deterministic comparison only', knownCheck: { outcome: 'not-assessed', rationale: 'Synthetic fixture, no product claim', sources: [] } });
}
const execute = (sid, hypothesisId, requestId) => executeRecordedRequest(store, sid, { hypothesisId, requestId, requestRevision: 'v1', methodId: method.id, methodVersion: method.version });
async function collect(sid, mode = 'vulnerable', stop = 'budget') {
  startTaskPolicy(store, sid, { mode: 'regular', stop, budget: { toolCalls: 20 } }); saveTaskContext(store, sid, context(mode));
  const rounds = [{}, {}];
  direction(sid, 'owner-direction', 'owner');
  for (const round of rounds) round.owner = (await execute(sid, 'owner-direction', 'owner')).id;
  closeResearch(store, sid, 'owner-direction', 'Owner references recorded, no finding asserted');
  direction(sid, 'anonymous-direction', 'anonymous-normal');
  for (const round of rounds) round.denied = (await execute(sid, 'anonymous-direction', 'denied')).id;
  closeResearch(store, sid, 'anonymous-direction', 'Denial references recorded');
  direction(sid, 'subject-direction', 'normal');
  for (const [index, round] of rounds.entries()) {
    round.normal = (await execute(sid, 'subject-direction', 'normal')).id;
    round.probe = (await execute(sid, 'subject-direction', 'probe')).id;
    if (index === 0) {
      const normal = readExecutionReceipt(store, sid, round.normal);
      if (normal.status >= 200 && normal.status < 300) observeResearch(store, sid, 'subject-direction', { id: 'first-round', outcome: 'no-information', endpoint,
        authContext: 'subject', controlReceiptId: round.normal, probeReceiptId: round.probe,
        expected: 'No effect verdict from status alone', observed: 'Responses saved for deterministic verifier', interpretation: 'Effect evaluation pending', nextInformation: 'Independent repeat' });
      else {
        // A failed normal control is a block; it must not be recorded as a falsifier.
        observeResearch(store, sid, 'subject-direction', { id: 'blocked-round', outcome: 'blocked', endpoint, authContext: 'subject',
          controlReceiptId: round.normal, probeReceiptId: round.probe, expected: 'Valid normal identity', observed: 'Fixture identity expired',
          interpretation: 'Blocked identity is unknown coverage', nextInformation: 'Stop after recorded comparison' });
      }
    }
  }
  return { methodId: method.id, methodVersion: method.version, rounds };
}
async function test(label, fn) { try { await fn(); console.log('ok   ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }
let validInput, effect, finding;
try {
  await test('one registered effect-job call executes eight actual requests while identical work and label-only changes do not resend', async () => {
    prepareJob('automatic-positive', 'vulnerable', 8);
    const before = requests, tool = tools.get('redteam_execution');
    const exec = { agent: { session: { id: 'automatic-positive', header: { agentPreset: 'pentest' } } } };
    const result = await tool.execute({ action: 'run-effect', document: JSON.stringify(jobInput) }, exec);
    assert.equal(result.ok, true, result.error); assert.equal(result.state, 'completed', result.reason);
    assert.equal(result.impactVerified, true); assert.equal(result.proofKind, 'access');
    assert.equal(result.capturedRequests, 8); assert.equal(requests, before + 8);
    assert.equal(taskPolicyStatus(store, 'automatic-positive').policy.used.toolCalls, 8);
    const cached = await runEffectJob(store, 'automatic-positive', { ...jobInput, timeoutMs: 1000 });
    assert.equal(cached.cached, true); assert.equal(cached.id, result.id); assert.equal(requests, before + 8);
    assert(!JSON.stringify(tool.output.render({ action: 'run-effect' }, result)).includes(secrets.owner));
    assert.throws(() => readEffectJob(store, 'other', result.id), /current session/);
    const relabelled = context(); relabelled.requests = relabelled.requests.map(item => ({ ...item, id: item.id + '-renamed', revision: 'label-v2',
      inputs: item.inputs.map(field => ({ ...field, evidenceIds: [item.id + '-renamed'] })) }));
    saveTaskContext(store, 'automatic-positive', relabelled);
    const labels = { ...jobInput, roles: Object.fromEntries(Object.entries(jobInput.roles).map(([role, value]) => [role,
      { requestId: value.requestId + '-renamed', requestRevision: 'label-v2' }])) };
    const stale = await runEffectJob(store, 'automatic-positive', labels);
    assert.equal(stale.id, result.id); assert.equal(stale.current, false); assert.equal(stale.impactVerified, false);
    assert.equal(requests, before + 8, 'new names cannot reset actual work');
  });
  await test('automatic effect jobs stop failed controls early and cache inconclusive results without declaring the asset safe', async () => {
    for (const [mode, count] of [['fixed', 6], ['public', 6], ['shared', 6], ['html', 1], ['expired', 5], ['echo', 6], ['wrong-viewer', 6]]) {
      const sid = 'job-negative-' + mode; prepareJob(sid, mode); const before = requests;
      const result = await runEffectJob(store, sid, jobInput);
      assert.equal(result.state, 'inconclusive', mode + ': ' + result.reason); assert.equal(result.impactVerified, false);
      assert.equal(result.coverage, 'partial-or-unknown'); assert.equal(requests, before + count, mode);
      assert.equal(taskPolicyStatus(store, sid).policy.used.toolCalls, count);
      assert.equal((await runEffectJob(store, sid, jobInput)).cached, true); assert.equal(requests, before + count);
    }
  });
  await test('automatic jobs reject bad roles before traffic and preserve exhausted budgets and captured steps', async () => {
    prepareJob('job-preflight'); const before = requests;
    await assert.rejects(runEffectJob(store, 'job-preflight', { ...jobInput, roles: { ...jobInput.roles, normal: jobInput.roles.owner } }), /identities/);
    await assert.rejects(runEffectJob(store, 'job-preflight', { ...jobInput, methodVersion: 'absent' }), /reviewed method/);
    assert.equal(requests, before); assert.equal(taskPolicyStatus(store, 'job-preflight').policy.used.toolCalls, 0);
    prepareJob('job-budget', 'vulnerable', 5);
    const stopped = await runEffectJob(store, 'job-budget', jobInput);
    assert.equal(stopped.state, 'blocked'); assert.match(stopped.reason, /tool_budget_exhausted/);
    assert.deepEqual({...stopped,steps:stopped.steps.map(row=>({...row}))},JSON.parse(JSON.stringify(stopped)),'a stopped effect job must also cross the native lossless JSON boundary');
    assert.equal(stopped.capturedRequests, 5); assert.equal(requests, before + 5);
    assert.equal((await runEffectJob(store, 'job-budget', jobInput)).id, stopped.id);
    assert.equal(requests, before + 5); assert.equal(taskPolicyStatus(store, 'job-budget').policy.used.toolCalls, 5);
  });
  await test('private endpoints need no public 200 baseline and anonymous job controls cannot authorize arbitrary identity switching', async () => {
    prepareJob('private-only');
    const privateOnly = context(); privateOnly.requests = privateOnly.requests.filter(row => row.id !== 'anonymous-normal');
    saveTaskContext(store, 'private-only', privateOnly); const before = requests;
    const result = await runEffectJob(store, 'private-only', jobInput);
    assert.equal(result.impactVerified, true, result.reason); assert.equal(requests, before + 8);
    prepareJob('identity-boundary'); direction('identity-boundary', 'manual-owner', 'owner');
    const input = { hypothesisId: 'manual-owner', ...jobInput.roles.denied, methodId: method.id, methodVersion: method.version };
    await assert.rejects(executeRecordedRequest(store, 'identity-boundary', input), /identity/);
    await assert.rejects(executeRecordedRequest(store, 'identity-boundary', input, { jobId: result.id, stepKey: 'denied.0' }), /identity/);
    assert.equal(requests, before + 8); assert.equal(taskPolicyStatus(store, 'identity-boundary').policy.used.toolCalls, 0);
  });
  await test('simultaneous automatic calls share one job and a lost completion marker reuses durable captures after database reopen', async () => {
    prepareJob('job-concurrent'); const before = requests;
    const pending = runEffectJob(store, 'job-concurrent', jobInput);
    const concurrent = await runEffectJob(store, 'job-concurrent', jobInput);
    assert.equal(concurrent.busy, true);
    const result = await pending; assert.equal(result.impactVerified, true, result.reason); assert.equal(requests, before + 8);
    const record = JSON.parse(store.db.prepare('SELECT record FROM effect_jobs WHERE session_id=? AND id=?').get('job-concurrent', result.id).record);
    record.state = 'running'; delete record.effectId;
    store.db.prepare('UPDATE effect_jobs SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(record), 'job-concurrent', result.id);
    store.close(); store = openStore(file);
    const resumed = await runEffectJob(store, 'job-concurrent', jobInput);
    assert.equal(resumed.impactVerified, true, resumed.reason); assert.equal(resumed.id, result.id);
    assert.equal(requests, before + 8, 'all captured steps survive reopen without resend');
    assert.equal(taskPolicyStatus(store, 'job-concurrent').policy.used.toolCalls, 8);
  });
  await test('actual worker death after dispatch preserves the charged in-flight step and refuses automatic resend', async () => {
    prepareJob('job-worker-crash', 'hang'); const before = requests;
    const config = path.join(home, 'owned-job-worker.json');
    fs.writeFileSync(config, JSON.stringify({ database: file, sessionId: 'job-worker-crash', input: { ...jobInput, timeoutMs: 15000 } }));
    const child = spawn(process.execPath, ['--import', new URL('./test-stub-register.mjs', import.meta.url).href,
      fileURLToPath(new URL('./fixture-effect-job-worker.mjs', import.meta.url)), config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let errorText = ''; child.stderr.on('data', chunk => { errorText += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let timer;
    try {
      await Promise.race([new Promise(resolve => { heldRequest = resolve; }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned worker did not reach third request: ' + errorText)), 10000); })]);
      assert.equal(requests, before + 3);
      child.kill(); await exited;
      const result = await runEffectJob(store, 'job-worker-crash', jobInput);
      assert.equal(result.state, 'interrupted', result.reason); assert.equal(result.capturedRequests, 2);
      assert.equal(result.attemptedRequests, 3); assert.equal(result.impactVerified, false);
      assert.match(result.reason, /automatic resend refused/); assert.equal(requests, before + 3);
      assert.equal(taskPolicyStatus(store, 'job-worker-crash').policy.used.toolCalls, 3);
    } finally {
      clearTimeout(timer); heldRequest = undefined;
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      server.closeAllConnections(); fs.unlinkSync(config);
    }
  });
  await test('actual private-object positive requires eight independent host executions and records an access effect without claiming RCE', async () => {
    const before = requests; validInput = await collect('positive'); assert.equal(requests, before + 8);
    const tool = tools.get('redteam_execution'), exec = { agent: { session: { id: 'positive', header: { agentPreset: 'pentest' } } } };
    effect = await tool.execute({ action: 'verify-effect', document: JSON.stringify(validInput) }, exec);
    assert.equal(effect.ok, true, effect.error); assert.equal(effect.verified, true, effect.reason); assert.equal(effect.proofKind, 'access');
    assert.equal(effect.receiptIds.length, 8); assert.equal(effect.controlReceiptId, validInput.rounds[1].normal);
    assert(!JSON.stringify(tool.output.render({ action: 'verify-effect' }, effect)).includes(secrets.owner));
    assert.equal(readEffectVerification(store, 'positive', effect.id).current, true);
    assert.throws(() => readEffectVerification(store, 'other', effect.id), /current session/);
  });
  await test('one real comparison can support continuing but cannot create a confirmed effect or persist a verdict', () => {
    const single = { ...validInput, rounds: [validInput.rounds[0]] };
    const before = requests, count = store.db.prepare('SELECT COUNT(*) AS n FROM effect_verifications').get().n;
    assert.deepEqual(assessPrivateReadRound(store, 'positive', single), { supported: true });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM effect_verifications').get().n, count);
    assert.equal(requests, before, 'assessment reuses captured executions');
    assert.equal(verifyEffect(store, 'positive', single).verified, false, 'one round cannot be delivered as confirmed');
    const duplicated = { ...single, rounds: [{ ...single.rounds[0], probe: single.rounds[0].normal }] };
    assert.equal(assessPrivateReadRound(store, 'positive', duplicated).supported, false);
    assert.equal(assessPrivateReadRound(store, 'other', single).supported, false);
  });
  await test('real positive promotes through production stats dedup filters export and high-impact stopping while access cannot masquerade as RCE', () => {
    const probe = readExecutionReceipt(store, 'positive', effect.probeReceiptId);
    const reproduction = { kind: 'method', methodId: method.id, methodVersion: method.version, endpoint, mechanism: 'private-json-read/v1',
      prerequisites: ['Reviewed private-owner/readers JSON contract'], dependencies: [], parameters: ['Two distinct test accounts'],
      steps: ['Compare own private object, owner reference and anonymous denial in two rounds'], successCriterion: 'Excluded subject receives owner-only private marker',
      reviewSteps: 'Use deterministic private read effect verifier', recovery: 'Read-only fixture; no persistent changes',
      verification: { status: 'verified', evidenceIds: effect.receiptIds, controlReceiptId: effect.controlReceiptId, probeReceiptId: effect.probeReceiptId, effectReceiptId: effect.id } };
    const input = { title: 'Private fixture object disclosed', severity: 'high', proofKind: 'access', evidenceLevel: 'impact', identity: 'subject', target: endpoint,
      impact: 'Owner-only private marker read by another subject under reviewed fixture ACL contract', evidence: effect.id,
      requestPkt: probe.request, responsePkt: probe.responseHead + Buffer.from(probe.responseBodyBase64, 'base64').toString(), reproduction: JSON.stringify(reproduction) };
    const register = () => { const pending = registerFinding(store, 'positive', 'pentest', input); return updateFinding(store, 'positive', 'pentest', pending.id,
      { status: 'verified', secondRating: 'high', secondRatingNote: 'Deterministic repeated private object read verified owner ACL, valid subject baseline and anonymous denial.' }); };
    finding = register(); assert.equal(finding.delivery.ready, true, JSON.stringify(finding.delivery.gaps)); assert.equal(finding.delivery.rce, false);
    register(); assert.equal(listFindings(store, 'positive', 'pentest', { delivery: 'ready', pageSize: 1 }).total, 1);
    assert.equal(groupByTarget(store, 'positive', 'pentest', { delivery: 'ready' })[0].count, 1);
    assert.equal(computeStats(store, 'positive', 'pentest').delivery.ready, 1);
    assert.equal(summarizeMetrics(home, { sessionId: 'positive' }).confirmedFindings, 1);
    assert.equal(summarizeMetrics(home, { sessionId: 'positive' }).confirmedRce, 0);
    const delivery = buildDeliveryFiles([finding], []);
    assert.equal(delivery.confirmedFindings, 1);
    const evidence = JSON.parse(delivery.files['delivery/evidence/finding-1-effect.json']);
    assert.equal(evidence.comparisons.length, 2);
    for (const comparison of evidence.comparisons) {
      assert.equal(comparison.ownerMarkerSha256, comparison.probeMarkerSha256);
      assert.notEqual(comparison.normalMarkerSha256, comparison.probeMarkerSha256);
      assert.equal(comparison.normalViewerSha256, comparison.probeViewerSha256);
      assert.notEqual(comparison.ownerViewerSha256, comparison.probeViewerSha256);
    }
    assert(!delivery.files['delivery/evidence/finding-1-effect.json'].includes(secrets.owner));
    assert.equal(taskPolicyStatus(store, 'positive').stopped, false, 'regular task continues its plan');
    const changed = updateFinding(store, 'positive', 'pentest', finding.id, { proofKind: 'execution' });
    assert.equal(changed.delivery.ready, false); assert.equal(changed.delivery.rce, false);
    updateFinding(store, 'positive', 'pentest', finding.id, { proofKind: 'access' });
  });
  await test('fixed ACL public/shared objects HTML pages invalid identities and request-reflected markers never produce private-read effects', async () => {
    for (const mode of ['fixed', 'public', 'shared', 'html', 'expired', 'echo', 'wrong-viewer']) {
      const input = await collect('negative-' + mode, mode);
      assert.equal(assessPrivateReadRound(store, 'negative-' + mode, { ...input, rounds: [input.rounds[0]] }).supported, false, mode);
      const result = verifyEffect(store, 'negative-' + mode, input);
      assert.equal(result.verified, false, mode); assert.equal(result.outcome, 'inconclusive');
      assert(!JSON.stringify(result).includes(secrets.owner));
    }
  });
  await test('production first-high stops on verified private read but first-RCE ignores access and relabelled execution claims', async () => {
    for (const stop of ['first-high', 'first-rce']) {
      const sid = 'stop-' + stop, collected = await collect(sid, 'vulnerable', stop), verified = verifyEffect(store, sid, collected);
      assert.equal(verified.verified, true, verified.reason);
      const original = getFinding(store, 'positive', finding.id), probe = readExecutionReceipt(store, sid, verified.probeReceiptId);
      const reproduction = JSON.parse(original.reproduction);
      reproduction.verification = { status: 'verified', evidenceIds: verified.receiptIds,
        controlReceiptId: verified.controlReceiptId, probeReceiptId: verified.probeReceiptId, effectReceiptId: verified.id };
      const pending = registerFinding(store, sid, 'pentest', { ...original, status: 'pending', evidence: verified.id,
        requestPkt: probe.request, responsePkt: probe.responseHead + Buffer.from(probe.responseBodyBase64, 'base64').toString(), reproduction: JSON.stringify(reproduction) });
      const reviewed = updateFinding(store, sid, 'pentest', pending.id, { status: 'verified', secondRating: 'high', secondRatingNote: original.secondRatingNote });
      assert.equal(reviewed.delivery.ready, true);
      if (stop === 'first-high') {
        assert.equal(taskPolicyStatus(store, sid).reason, 'first_verified_high');
        const before = requests;
        await assert.rejects(execute(sid, 'subject-direction', 'probe'), /first_verified_high/);
        assert.equal(requests, before);
      } else {
        assert.equal(taskPolicyStatus(store, sid).stopped, false);
        updateFinding(store, sid, 'pentest', reviewed.id, { proofKind: 'execution' });
        assert.equal(taskPolicyStatus(store, sid).stopped, false);
      }
    }
  });
  await test('damaged captured bytes and metadata revoke independent effects and delivery without deleting historical records or sending HTTP', () => {
    const sid = 'positive', id = validInput.rounds[0].owner;
    const saved = store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?').get(sid, id).record;
    const original = JSON.parse(saved), before = requests;
    const mutations = [
      row => { row.request += 'damaged'; },
      row => { row.responseHead += 'damaged'; },
      row => { row.responseBodyBase64 = Buffer.from('damaged').toString('base64'); },
      row => { row.responseBodyBase64 += '!'; },
      row => { row.status = 403; },
      row => { row.capturedBytes++; },
      row => { row.responseBytes = -1; },
      row => { delete row.requestSha256; },
      row => { delete row.responseSha256; },
    ];
    try {
      for (const mutate of mutations) {
        const changed = structuredClone(original); mutate(changed);
        store.db.prepare('UPDATE execution_receipts SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(changed), sid, id);
        const receipt = readExecutionReceipt(store, sid, id);
        assert.equal(receipt.integrityValid, false); assert.equal(receipt.current, false); assert(receipt.currentReason);
        assert.equal(receipt.id, id, 'damaged history remains available for inspection');
        assert.equal(readEffectVerification(store, sid, effect.id).current, false);
        assert.equal(verifyEffect(store, sid, validInput).verified, false);
        assert.equal(getFinding(store, sid, finding.id).delivery.ready, false);
        assert.equal(requests, before);
      }
    } finally { store.db.prepare('UPDATE execution_receipts SET record=? WHERE session_id=? AND id=?').run(saved, sid, id); }
    assert.equal(readExecutionReceipt(store, sid, id).integrityValid, true);
    assert.equal(readEffectVerification(store, sid, effect.id).current, true);
    assert.equal(getFinding(store, sid, finding.id).delivery.ready, true);
  });
  await test('aged executions cannot create a fresh effect while timestamped historical proof remains readable without repeat HTTP', () => {
    const clock = Date.now, before = requests;
    try {
      Date.now = () => clock() + 16 * 60 * 1000;
      assert.equal(verifyEffect(store, 'positive', validInput).verified, false);
      assert.equal(readEffectVerification(store, 'positive', effect.id).current, true);
      assert.equal(getFinding(store, 'positive', finding.id).delivery.ready, true);
      assert.equal(requests, before);
    } finally { Date.now = clock; }
  });
  await test('duplicate or borrowed receipts cannot replace independent execution and method changes revoke persisted effects and ready views', () => {
    const duplicate = { ...validInput, rounds: [validInput.rounds[0], validInput.rounds[0]] };
    assert.equal(verifyEffect(store, 'positive', duplicate).verified, false);
    assert.equal(verifyEffect(store, 'other', validInput).verified, false);
    store.close(); store = openStore(file);
    assert.equal(getFinding(store, 'positive', finding.id).delivery.ready, true);
    saveTaskContext(store, 'positive', { ...context(), methods: [{ ...method, version: 'v2' }] });
    assert.equal(readEffectVerification(store, 'positive', effect.id).current, false);
    assert.equal(getFinding(store, 'positive', finding.id).delivery.ready, false);
    assert.equal(summarizeMetrics(home, { sessionId: 'positive' }).confirmedFindings, 0);
  });
} finally {
  for (const dispose of disposers.reverse()) await dispose(); store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
