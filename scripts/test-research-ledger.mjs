import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore, allFindings } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy, taskExecutionGuard, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createResearch, observeResearch, closeResearch, researchDetail, researchIndex, researchGroups, researchNext } from '../plugins/dsh-redteam-results/lib/research.js';
import { saveChecks, readChecks } from '../plugins/dsh-redteam-results/lib/checked.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-research-ledger-'));
process.env.DSH_HOME = home;
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const file = path.join(home, 'redteam-results', 'results.db');
let store = openStore(file);
const tools = new Map(), disposers = [], guards = [];
results.apply({ tools: { register: tool => tools.set(tool.name, tool), guard: fn => guards.push(fn) },
  webServer: { register: () => () => {} }, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); } });
const server = http.createServer((req, res) => {
  const query = new URL(req.url, 'http://fixture.test').searchParams;
  if (query.get('identity') === 'expired') { res.writeHead(403); res.end('expired identity'); }
  else { res.writeHead(200); res.end(query.get('object') === 'other' ? 'controlled other owner fixture marker' : 'own owner fixture marker'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/object';
let clock = Date.now() - 100000;
async function capture(query) {
  const url = new URL(endpoint + '?' + query), response = await fetch(url);
  return { request: 'GET ' + url.pathname + url.search + ' HTTP/1.1\r\nHost: ' + url.host + '\r\n\r\n',
    response: 'HTTP/1.1 ' + response.status + ' Result\r\n\r\n' + await response.text() };
}
const normal = await capture('object=own');
const context = { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [{ id: 'baseline', revision: 'v1', endpoint,
  authContext: 'fixture-user', valid: true, kind: 'api', ...normal, inputs: [{ name: 'object', location: 'query', evidenceIds: ['baseline'] }] }] };
const doc = (id, patch = {}) => ({ id, requestId: 'baseline', requestRevision: 'v1', controlledInputs: [{ name: 'object', location: 'query' }],
  title: 'Controlled object access hypothesis', serverPath: 'Fixture object handler', boundary: 'Owner identity', normalBehavior: 'Own fixture object returns own marker',
  supportCriterion: 'Other owner object returns controlled marker with valid identity', falsifier: 'Normal control works and other owner object is denied',
  nextInformation: 'Compare own and other owner fixture objects', knownCheck: { outcome: 'none-found', rationale: 'Only a synthetic fixture; this is a local search result, no novelty claim.',
    sources: [{ reference: 'local-fixture:source-v1', observation: 'No real product vulnerability is represented by the synthetic handler.' }] }, ...patch });
function start(id, mode = '0day', current = context) {
  startTaskPolicy(store, id, { mode, budget: { toolCalls: 30, discoveryCalls: 3 } });
  saveTaskContext(store, id, current);
}
async function observation(id, outcome = 'support', patch = {}) {
  clock += 1000;
  return { id, outcome, endpoint, authContext: 'fixture-user', executedAt: new Date(clock).toISOString(), runner: 'actual isolated Node HTTP fixture',
    expected: 'Own fixture normal response and a controlled difference for another owner object', observed: 'Actual fixture response bodies recorded below',
    interpretation: 'Controlled fixture only; independent verification needed for any real product claim', nextInformation: 'Repeat with a new execution and compare controls',
    control: await capture('object=own'), probe: await capture(outcome === 'support' ? 'object=other' : 'object=own'), ...patch };
}
const exec = id => ({ agent: { session: { id, header: { agentPreset: 'pentest' } } } });
const call = (id, args) => tools.get('redteam_research').execute(args, exec(id));
let failed = 0;
async function test(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.stack); } }
try {
  await test('registered research tool binds seven falsifiable fields and observed inputs to current baseline only', async () => {
    start('actual');
    assert.match(guards[0]({ ...exec('actual'), name: 'fetch' }), /research_hypothesis_missing/);
    assert.equal(readTaskPolicy(store, 'actual').used.toolCalls, 0);
    const result = await call('actual', { action: 'create', document: JSON.stringify(doc('h1')) });
    assert.equal(result.ok, true, result.error); assert.equal(result.binding.authContext, 'fixture-user'); assert.equal(result.binding.requestRevision, 'v1');
    assert.equal(result.noveltyProven, false); assert.equal(result.classification, 'unconfirmed-anomaly');
    assert.equal(guards[0]({ ...exec('actual'), name: 'fetch' }), undefined);
    assert.equal(readTaskPolicy(store, 'actual').used.toolCalls, 1);
    assert.equal((await call('other', { action: 'detail', id: 'h1' })).ok, false);
    const missingId = await call('actual', { action: 'observe', document: JSON.stringify({ id: 'observation-not-hypothesis' }) });
    assert.equal(missingId.ok, false); assert.match(missingId.error, /outer id=<hypothesis ID>/); assert(!missingId.error.includes('SQLite'));
    assert.equal((await call('actual', { action: 'create', document: JSON.stringify(doc('h1')) })).ok, false);
    for (const patch of [{ requestRevision: 'missing' }, { controlledInputs: [{ name: 'unobserved', location: 'query' }] }, { falsifier: '' },
      { knownCheck: { outcome: 'none-found', rationale: 'No CVE', sources: [] } }, { maxAttempts: 999 }]) assert.throws(() => createResearch(store, 'actual', doc('bad', patch)));
    start('regular', 'regular'); assert.equal(createResearch(store, 'regular', doc('regular-direction')).state, 'active');
  });
  await test('actual HTTP support requires distinct normal control and separate repeat; no automatic finding or global novelty', async () => {
    const noDifference = await observation('not-a-difference', 'support', { probe: await capture('object=own') });
    assert.throws(() => observeResearch(store, 'actual', 'h1', noDifference), /observed difference/);
    const once = await observation('round-1');
    const first = await call('actual', { action: 'observe', id: 'h1', document: JSON.stringify(once) });
    assert.equal(first.ok, true, first.error); assert.equal(first.state, 'active'); assert.equal(first.classification, 'unconfirmed-anomaly');
    assert.throws(() => observeResearch(store, 'actual', 'h1', { ...once, id: 'duplicate-execution' }), /separately recorded/);
    const wrongIdentity = { ...await observation('wrong-identity'), authContext: 'different-user' };
    assert.throws(() => observeResearch(store, 'actual', 'h1', wrongIdentity));
    const result = await call('actual', { action: 'observe', id: 'h1', document: JSON.stringify(await observation('round-2')) });
    assert.equal(result.state, 'supported'); assert.equal(result.classification, 'suspected-unpublished'); assert.equal(result.noveltyProven, false);
    assert.equal(result.observations.length, 2); assert.equal(result.observations[0].probe.response, once.probe.response);
    assert.equal(allFindings(store, 'actual', 'pentest').length, 0);
    assert.equal(researchNext(store, 'actual').action, 'independently-verify-impact');
    assert.equal(taskExecutionGuard(store, 'actual', 'fetch'), undefined);
    assert.equal(taskExecutionGuard(store, 'actual', 'fetch'), undefined);
    assert.match(taskExecutionGuard(store, 'actual', 'fetch'), /direction_observation_required/);
    assert.throws(() => observeResearch(store, 'actual', 'h1', { ...once, id: 'after-support' }), /closed/);
  });
  await test('normal-response counterevidence refutes direction while expired controls never masquerade as negative evidence', async () => {
    start('refute'); createResearch(store, 'refute', doc('h'));
    const input = await observation('counter', 'counterevidence');
    const expired = { ...input, control: await capture('identity=expired') };
    assert.throws(() => observeResearch(store, 'refute', 'h', expired), /blocked/);
    assert.equal(researchDetail(store, 'refute', 'h').attempts, 0);
    const result = observeResearch(store, 'refute', 'h', input);
    assert.equal(result.state, 'refuted'); assert.equal(result.reason, 'falsifier_observed');
    assert.match(taskExecutionGuard(store, 'refute', 'pwsh'), /research_hypothesis_missing/);
  });
  await test('policy interruption persists separately without fabricated executions or negative coverage', async () => {
    start('restricted', 'regular'); createResearch(store, 'restricted', doc('h'));
    assert.throws(() => closeResearch(store, 'restricted', 'h', 'Invalid code', 'unknown'), /invalid research restriction/);
    assert.equal(researchDetail(store, 'restricted', 'h').state, 'active');
    const result = await call('restricted', { action: 'close', id: 'h', document: 'Tool declined this branch before execution', restriction: 'tool-policy' });
    assert.equal(result.ok, true, result.error); assert.equal(result.state, 'restricted');
    assert.equal(result.attempts, 0); assert.equal(result.noInformation, 0); assert.equal(result.observations.length, 0);
    assert.equal(result.restriction.coverage, 'not-executed'); assert.equal(result.restriction.source, 'submitted-interruption-report');
    assert.equal(readTaskPolicy(store, 'restricted').used.toolCalls, 0);
    assert.match(taskExecutionGuard(store, 'restricted', 'fetch'), /research_hypothesis_missing/);
    assert.throws(() => createResearch(store, 'restricted', doc('retry')), /same research direction/);
    assert.throws(() => observeResearch(store, 'restricted', 'h', {}), /closed/);
    assert.equal(researchNext(store, 'restricted').restrictedDirections, 1);
    assert.equal(researchNext(store, 'restricted').requests.length, 0);
    assert.equal(allFindings(store, 'restricted', 'pentest').length, 0);
    store.close(); store = openStore(file);
    assert.equal(researchIndex(store, 'restricted').items[0].state, 'restricted');
    saveTaskContext(store, 'restricted', { ...context, requests: [] });
    const stale = researchIndex(store, 'restricted').items[0];
    assert.equal(stale.state, 'restricted'); assert.equal(stale.restriction.coverage, 'not-executed');
    start('partial-restriction'); createResearch(store, 'partial-restriction', doc('h'));
    observeResearch(store, 'partial-restriction', 'h', await observation('before-interruption'));
    const partial = closeResearch(store, 'partial-restriction', 'h', 'Model stopped the follow-up branch', 'safety-policy');
    assert.equal(partial.restriction.coverage, 'partial'); assert.equal(partial.attempts, 1); assert.equal(partial.observations.length, 1);
    assert.equal(partial.classification, 'unconfirmed-anomaly');
    const rendered = JSON.stringify(tools.get('redteam_research').output.render({ action: 'close' }, { ok: true, ...partial }));
    assert(rendered.includes('safety-policy')); assert(!rendered.includes('controlled other owner fixture marker'));
  });
  await test('repeated no-information stops and same direction cannot restart by changing ID or budgets', async () => {
    start('stalled'); createResearch(store, 'stalled', doc('h'));
    observeResearch(store, 'stalled', 'h', await observation('nothing-1', 'no-information'));
    const result = observeResearch(store, 'stalled', 'h', await observation('nothing-2', 'no-information'));
    assert.equal(result.state, 'stopped'); assert.equal(result.reason, 'no_new_information'); assert.equal(result.attempts, 2);
    assert.match(taskExecutionGuard(store, 'stalled', 'fetch'), /research_hypothesis_missing/);
    assert.throws(() => createResearch(store, 'stalled', doc('reset', { maxAttempts: 10, nextInformation: 'Try the same thing again' })), /same research direction/);
    const retry = await observation('retry', 'no-information');
    assert.throws(() => observeResearch(store, 'stalled', 'h', retry), /closed/);
    assert.equal(taskExecutionGuard(store, 'stalled', 'redteam_research'), undefined);
    assert.equal(taskExecutionGuard(store, 'stalled', 'redteam_delivery'), undefined);
  });
  await test('exact baseline validity identity origin and revision changes block further research without rewriting history', async () => {
    start('stale'); createResearch(store, 'stale', doc('h'));
    for (const changed of [{ ...context, requests: [{ ...context.requests[0], valid: false }] }, { ...context, assets: [{ ...context.assets[0], inScope: false }] },
      { ...context, requests: [{ ...context.requests[0], revision: 'v2' }] }]) {
      saveTaskContext(store, 'stale', changed); assert.equal(researchDetail(store, 'stale', 'h').current, false);
      assert.match(taskExecutionGuard(store, 'stale', 'fetch'), /research_hypothesis_missing/);
      assert.throws(() => observeResearch(store, 'stale', 'h', {}), /baseline missing/);
    }
    saveTaskContext(store, 'stale', { ...context, requests: [{ ...context.requests[0], inputs: [...context.requests[0].inputs, { name: 'other', location: 'query', evidenceIds: ['baseline'] }] }] });
    assert.equal(researchDetail(store, 'stale', 'h').current, false);
    assert.throws(() => observeResearch(store, 'stale', 'h', {}), /baseline changed/);
    assert.equal(researchDetail(store, 'stale', 'h').binding.requestRevision, 'v1');
    saveTaskContext(store, 'stale', context); assert.equal(researchDetail(store, 'stale', 'h').current, true);
    const wrongPath = await observation('wrong-boundary'); wrongPath.probe.request = 'GET /other-api HTTP/1.1';
    assert.throws(() => observeResearch(store, 'stale', 'h', wrongPath), /endpoint boundary/);
  });
  await test('functional grouping needs confirmed input and permission evidence and never transfers results across members', () => {
    startTaskPolicy(store, 'groups', { mode: '0day', budget: { toolCalls: 30, discoveryCalls: 3 } });
    const second = { ...context.requests[0], id: 'second', inputs: [{ name: 'object', location: 'query', evidenceIds: ['second'] }] };
    saveTaskContext(store, 'groups', { ...context, requests: [context.requests[0], second] }); assert.equal(researchGroups(store, 'groups').total, 2);
    const group = { verified: true, function: 'Object lookup', inputStructure: 'object=query:string', permissionBoundary: 'same fixture owner check', evidenceIds: ['handler-observation', 'permission-control'] };
    saveTaskContext(store, 'groups', { ...context, requests: [context.requests[0], second].map(row => ({ ...row, researchGroup: group })) });
    const result = researchGroups(store, 'groups'); assert.equal(result.total, 1); assert.equal(result.groups[0].members.length, 2); assert.equal(result.groups[0].sharedOutcome, false);
    saveTaskContext(store, 'groups', { ...context, requests: [{ ...context.requests[0], researchGroup: group }, { ...second, researchGroup: { ...group, permissionBoundary: 'different tenant boundary' } }] });
    assert.equal(researchGroups(store, 'groups').total, 2);
  });
  await test('regular and nday preserve two-operation observation gates across restart and continue another actual input', async () => {
    const otherEndpoint = endpoint.replace('/api/object', '/api/second');
    const second = { ...context.requests[0], id: 'second-route', endpoint: otherEndpoint,
      request: normal.request.replace('/api/object', '/api/second'), inputs: [{ name: 'object', location: 'query', evidenceIds: ['second-route'] }] };
    for (const mode of ['regular', 'nday']) {
      const sid = 'adaptive-' + mode;
      start(sid, mode, { ...context, requests: [{ ...context.requests[0], kind: 'web' }, second] });
      createResearch(store, sid, doc('first'));
      assert.equal(guards[0]({ ...exec(sid), name: 'fetch' }), undefined);
      assert.equal(guards[0]({ ...exec(sid), name: 'pwsh' }), undefined);
      store.close(); store = openStore(file);
      assert.match(guards[0]({ ...exec(sid), name: 'fetch' }), /direction_observation_required/);
      assert.equal(readTaskPolicy(store, sid).used.toolCalls, 2);
      assert.equal((await tools.get('redteam_task').execute({ action: 'next' }, exec(sid))).next.action, 'record-observation-or-close');
      observeResearch(store, sid, 'first', await observation('valid-negative', 'counterevidence'));
      const next = researchNext(store, sid);
      assert.equal(next.action, 'create-direction-on-observed-input'); assert.equal(next.requests.length, 1);
      assert.equal(next.requests[0].requestId, 'second-route');
      createResearch(store, sid, doc('second', { requestId: 'second-route' }));
      assert.equal(taskExecutionGuard(store, sid, 'fetch'), undefined);
      assert.equal(researchDetail(store, sid, 'first').state, 'refuted');
    }
    closeResearch(store, 'actual', 'h1', 'Independent impact validation unavailable; retain only an unconfirmed lead');
    assert.match(taskExecutionGuard(store, 'actual', 'fetch'), /research_hypothesis_missing/);
  });
  await test('closing one input does not discard a different actual request on the same endpoint and identity', async () => {
    const second = { ...context.requests[0], id: 'same-route-new-input', ...await capture('object=own&view=summary'),
      inputs: [{ name: 'object', location: 'query', evidenceIds: ['same-route-new-input'] },
        { name: 'view', location: 'query', evidenceIds: ['same-route-new-input'] }] };
    start('same-route', 'regular', { ...context, requests: [context.requests[0], second] });
    createResearch(store, 'same-route', doc('closed-input'));
    closeResearch(store, 'same-route', 'closed-input', 'Only this recorded request was checked');
    const next = researchNext(store, 'same-route');
    assert.equal(next.requests.length, 1); assert.equal(next.requests[0].requestId, second.id);
    assert.equal(next.requests[0].endpoint, endpoint);
    createResearch(store, 'same-route', doc('view-direction', { requestId: second.id,
      controlledInputs: [{ name: 'view', location: 'query' }], boundary: 'Observed output view boundary' }));
    assert.equal(taskExecutionGuard(store, 'same-route', 'fetch'), undefined);
  });
  await test('subagent dispatch and relabelled baseline cannot reset deterministic task limits', () => {
    const sid = 'adaptive-regular';
    const used = readTaskPolicy(store, sid).used.toolCalls;
    assert.match(guards[0]({ ...exec(sid), name: 'subagent_run' }), /managed_delegation_required/);
    assert.match(taskExecutionGuard(store, sid, 'subagent_create'), /managed_delegation_required/);
    assert.equal(readTaskPolicy(store, sid).used.toolCalls, used);
    start('relabel', 'regular'); createResearch(store, 'relabel', doc('original'));
    const renamed = { ...context.requests[0], id: 'renamed', revision: 'v2', inputs: [{ name: 'object', location: 'query', evidenceIds: ['renamed'] }] };
    saveTaskContext(store, 'relabel', { ...context, requests: [renamed] });
    assert.equal(researchNext(store, 'relabel').requests.length, 0, 'labels are not a new observed entry');
    assert.throws(() => createResearch(store, 'relabel', doc('reset', { requestId: 'renamed', requestRevision: 'v2' })), /same research direction/);
    const changed = { ...renamed, revision: 'v3', request: renamed.request.replace('object=own', 'object=new-owned-object') };
    saveTaskContext(store, 'relabel', { ...context, requests: [changed] });
    assert.equal(createResearch(store, 'relabel', doc('new-evidence', { requestId: 'renamed', requestRevision: 'v3' })).state, 'active');
  });
  await test('supplement count cannot regress and routine model render omits archived packets', async () => {
    const check = { assetId: 'a', entryId: 'e', endpoint, methodVersion: 'm1', authContext: 'fixture-user', requestRevision: 'v1',
      status: 'blocked', reason: 'Need current identity', evidenceIds: ['baseline'], supplementAttempts: 2 };
    saveChecks(store, 'monotonic', [check]);
    assert.throws(() => saveChecks(store, 'monotonic', [{ ...check, supplementAttempts: 0 }]), /cannot decrease/);
    assert.equal(readChecks(store, 'monotonic')[0].supplementAttempts, 2);
    saveChecks(store, 'monotonic', [{ ...check, requestRevision: 'v2', supplementAttempts: 0 }]);
    const detail = await call('actual', { action: 'detail', id: 'h1' });
    const tool = tools.get('redteam_research');
    const compact = JSON.stringify(tool.output.render({ action: 'observe' }, detail));
    assert(!compact.includes('controlled other owner fixture marker')); assert(compact.includes('observationCount'));
    assert(JSON.stringify(tool.output.render({ action: 'detail' }, detail)).includes('controlled other owner fixture marker'));
  });
  await test('bounded attempts classification source distinctions and reopen persist without leaking packets into index', async () => {
    for (const [id, outcome, expected] of [['known', 'known', 'known-vulnerability'], ['variant', 'variant', 'new-variant'], ['unknown', 'not-assessed', 'unconfirmed-anomaly']]) {
      start(id); createResearch(store, id, doc('h', { knownCheck: { ...doc('h').knownCheck, outcome } }));
      observeResearch(store, id, 'h', await observation('one')); assert.equal(observeResearch(store, id, 'h', await observation('two')).classification, expected);
    }
    start('bounded'); createResearch(store, 'bounded', doc('h', { maxAttempts: 1 }));
    assert.equal(observeResearch(store, 'bounded', 'h', await observation('one')).reason, 'hypothesis_budget_exhausted');
    store.close(); store = openStore(file);
    assert.equal(researchDetail(store, 'stalled', 'h').state, 'stopped'); assert.equal(researchDetail(store, 'actual', 'h1').observations.length, 2);
    const index = researchIndex(store, 'actual'); assert.equal(index.total, 1); assert(!JSON.stringify(index).includes('controlled other owner fixture marker'));
    assert.equal(researchIndex(store, 'other').total, 0); assert.throws(() => researchIndex(store, 'actual', -1));
    const detail = await results.dispatch({}, store, 'research.detail', { sessionId: 'actual', id: 'h1' }); assert.equal(detail.binding.authContext, 'fixture-user');
    await assert.rejects(results.dispatch({}, store, 'research.detail', { sessionId: 'other', id: 'h1' }), /current session/);
  });
} finally {
  for (const dispose of disposers.reverse()) await dispose(); store.close(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
