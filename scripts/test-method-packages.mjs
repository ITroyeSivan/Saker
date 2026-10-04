import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { stageMethodPackage, readMethodPackage, methodPackageState, recordMethodReview, activateMethodPackage,
  listMethodPackages, activeMethodPackage } from '../plugins/dsh-redteam-results/lib/method-packages.js';
import { saveTaskContext, readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-method-packages-'));
process.env.DSH_HOME = home;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const db = path.join(home, 'redteam-results', 'results.db');
let store = openStore(db);
const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(req.url === '/positive' ? 'isolated-marker' : 'normal-control'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port;
const code = '// Controlled fixture replay instructions; no external target.\n';
const artifact = content => ({ content, sha256: sha(content) });
const document = version => ({ schema: 'saker.method-package/1', id: 'controlled-fixture', version, title: 'Controlled method fixture',
  products: ['isolated-local-fixture'], mechanism: 'compare two controlled responses',
  applicability: [{ name: 'local fixture deployed', requiredEvidence: 'Both controlled routes respond normally.' }],
  discovery: { fingerprints: [{ exactMarker: 'isolated-marker' }] },
  detection: { baseline: 'Normal response with valid fixture identity.', control: 'The normal control must lack the isolated marker.', criterion: 'Only the positive contains the marker.',
    requests: [{ id: 'control', method: 'GET', target: '${base}/control', variables: { base: endpoint }, encoding: 'UTF-8', matchers: [{ contains: 'normal-control', negate: false }] },
      { id: 'positive', method: 'GET', target: '${base}/positive', oob: { enabled: false }, matchers: [{ contains: 'isolated-marker', condition: 'and' }] }] },
  exploitation: { identity: 'Local fixture only; no credentials.', steps: ['Replay positive and normal control, compare recorded responses.'], parameters: ['base'],
    file: 'replay.js', successCriterion: 'Positive has isolated-marker while normal control does not.', recovery: 'Close the fixture server.' },
  dependencies: [{ name: 'node', version: process.version, source: 'https://nodejs.org/', instructions: 'Use the exact test runtime version.' }],
  evidence: { mechanism: 'Response difference', impact: 'Fixture behavior only, no real product vulnerability claim.', limitations: 'Synthetic fixture does not prove real product semantics.' },
  sources: [{ url: 'https://example.test/controlled-fixture', revision: version, sha256: sha(code), license: 'MIT', retrieval: 'Locally authored fixture source.' }],
  maintenance: { changes: ['Controlled fixture version ' + version], recheckConditions: ['Route or runtime changes.'] },
  files: [{ path: 'replay.js', content: code, sha256: sha(code), license: 'MIT', redistribute: true }] });
const responses = await Promise.all(['/positive', '/control'].map(async route => {
  const response = await fetch(endpoint + route);
  return { request: artifact('GET ' + route + ' HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'), response: artifact('HTTP/1.1 ' + response.status + ' OK\r\n\r\n' + await response.text()) };
}));
const review = digest => ({ methodDigest: digest, reviewer: 'controlled test reviewer', decision: 'approved', notes: 'Reviewed request order, baseline, distinct negative control, dependencies and source digest.' });
const receipt = digest => ({ methodDigest: digest, result: 'passed', notes: 'Actual isolated HTTP fixture replay, marker positive and normal control both checked.',
  environment: endpoint, runnerVersion: process.version, executedAt: new Date().toISOString(),
  positive: { ...JSON.parse(JSON.stringify(responses[0])), expected: 'isolated-marker', observed: 'isolated-marker', matched: true },
  negative: { ...JSON.parse(JSON.stringify(responses[1])), expected: 'normal-control without marker', observed: 'normal-control', matched: true },
  dependencies: [{ name: 'node', version: process.version, validated: true }] });
const clone = value => JSON.parse(JSON.stringify(value));
const approve = digest => { recordMethodReview(store, digest, 'verification', receipt(digest), 'model:fixture'); recordMethodReview(store, digest, 'review', review(digest), 'desktop-user'); };
let failed = 0, v1, v2;
async function test(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.stack); } }
try {
  await test('immutable offline method preserves requests, variables, encoding, controls, OOB, code and source pins', () => {
    const input = document('v1'); v1 = stageMethodPackage(store, input);
    assert.equal(v1.status, 'pending'); assert.deepEqual(readMethodPackage(store, v1.digest).document, input);
    assert.equal(stageMethodPackage(store, Object.fromEntries(Object.entries(input).reverse())).digest, v1.digest);
    const changed = clone(input); changed.detection.requests.reverse();
    assert.throws(() => stageMethodPackage(store, changed), /immutable/);
    assert.deepEqual(readMethodPackage(store, v1.digest).document.detection.requests, input.detection.requests);
  });
  await test('missing control, unsafe or duplicate files, wrong digest and nonredistributable source never enter execution library', () => {
    const before = listMethodPackages(store).total;
    const cases = [doc => delete doc.detection.control, doc => doc.files[0].path = '../escape.js', doc => doc.files[0].path = 'CON.js',
      doc => doc.files.push({ ...doc.files[0], path: 'REPLAY.JS' }), doc => doc.files[0].content += 'changed', doc => doc.files[0].redistribute = false,
      doc => delete doc.sources[0].sha256, doc => doc.exploitation.file = 'missing.js'];
    for (const mutate of cases) { const doc = document('invalid'); mutate(doc); assert.throws(() => stageMethodPackage(store, doc)); }
    assert.equal(listMethodPackages(store).total, before);
    assert.equal(activeMethodPackage(store, 'controlled-fixture'), null);
  });
  await test('model review and test receipt cannot impersonate Desktop approval or activate a pending method', () => {
    recordMethodReview(store, v1.digest, 'review', { ...review(v1.digest), actor: 'desktop-user' }, 'model:fixture');
    recordMethodReview(store, v1.digest, 'verification', receipt(v1.digest), 'model:fixture');
    assert.equal(methodPackageState(store, v1.digest).status, 'pending');
    assert.equal(methodPackageState(store, v1.digest).review.actor, 'model:fixture');
    assert.throws(() => activateMethodPackage(store, v1.digest, '', 'model:fixture'), /Desktop/);
    assert.throws(() => activateMethodPackage(store, v1.digest, '', 'desktop-user'), /needs Desktop/);
  });
  await test('generic offline methods refuse hardcoded target credentials while retaining environment placeholders', () => {
    const doc = document('credentials'); doc.files[0].content = 'const token = "target-secret";'; doc.files[0].sha256 = sha(doc.files[0].content);
    assert.throws(() => stageMethodPackage(store, doc), /literal credential/);
    doc.files[0].content = 'const token = process.env.TARGET_TOKEN;'; doc.files[0].sha256 = sha(doc.files[0].content);
    doc.detection.requests[0].headers = { Authorization: 'Bearer target-secret' };
    assert.throws(() => stageMethodPackage(store, doc), /literal credential/);
    doc.detection.requests[0].headers.Authorization = '${TARGET_AUTHORIZATION}';
    assert.equal(stageMethodPackage(store, doc).status, 'pending');
  });
  await test('verification requires exact version, actual hashed positive/control observations and validated dependency versions', () => {
    for (const mutate of [record => record.methodDigest = 'a'.repeat(64), record => record.negative.response = record.positive.response,
      record => record.positive.response.sha256 = 'b'.repeat(64), record => record.negative.matched = false, record => record.dependencies[0].version = 'wrong']) {
      const record = receipt(v1.digest); mutate(record);
      assert.throws(() => recordMethodReview(store, v1.digest, 'verification', record, 'model:fixture'));
    }
    assert.equal(methodPackageState(store, v1.digest).verification.result, 'passed');
  });
  await test('Desktop approval activates exact tested version; staging an update preserves current method and stale writes fail atomically', () => {
    recordMethodReview(store, v1.digest, 'review', review(v1.digest), 'desktop-user');
    assert.equal(activateMethodPackage(store, v1.digest, '', 'desktop-user').active, true);
    v2 = stageMethodPackage(store, document('v2'));
    assert.equal(activeMethodPackage(store, 'controlled-fixture').digest, v1.digest);
    approve(v2.digest);
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM method_package_history').get().n;
    assert.throws(() => activateMethodPackage(store, v2.digest, '', 'desktop-user'), /active method changed/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM method_package_history').get().n, before);
    assert.equal(activateMethodPackage(store, v2.digest, v1.digest, 'desktop-user').active, true);
  });
  await test('restart reads pinned offline code without network and rollback accepts only previously active trusted versions', () => {
    store.close(); store = openStore(db);
    assert.equal(activeMethodPackage(store, 'controlled-fixture').document.files[0].content, code);
    const never = stageMethodPackage(store, document('never-active')); approve(never.digest);
    assert.throws(() => activateMethodPackage(store, never.digest, v2.digest, 'desktop-user', true), /never active/);
    assert.equal(activateMethodPackage(store, v1.digest, v2.digest, 'desktop-user', true).active, true);
    assert.equal(methodPackageState(store, v2.digest).status, 'trusted');
    assert.equal(methodPackageState(store, v2.digest).active, false);
  });
  await test('shared method references use trusted active package; failed recheck withdraws it and downgrades context without rewriting evidence', () => {
    const context = { methods: [{ id: 'controlled-fixture', version: 'v1', packageDigest: v1.digest, reviewed: true }] };
    saveTaskContext(store, 'fixture-session', context);
    const before = store.db.prepare('SELECT record FROM task_context WHERE session_id=?').get('fixture-session').record;
    const testReceipt = receipt(v1.digest); testReceipt.result = 'failed'; testReceipt.positive.matched = false;
    recordMethodReview(store, v1.digest, 'verification', testReceipt, 'model:fixture');
    assert.equal(activeMethodPackage(store, 'controlled-fixture'), null);
    assert.equal(store.db.prepare('SELECT digest FROM method_package_active WHERE id=?').get('controlled-fixture'), undefined);
    const withdrawal = store.db.prepare("SELECT previous_digest,digest FROM method_package_history WHERE id=? AND action='withdraw' ORDER BY seq DESC LIMIT 1").get('controlled-fixture');
    assert.equal(withdrawal.previous_digest, v1.digest); assert.equal(withdrawal.digest, '');
    assert.equal(readTaskContext(store, 'fixture-session').methods[0].reviewed, false);
    assert.equal(store.db.prepare('SELECT record FROM task_context WHERE session_id=?').get('fixture-session').record, before);
    assert.throws(() => saveTaskContext(store, 'another', context), /active trusted/);
    assert.throws(() => activateMethodPackage(store, v1.digest, '', 'desktop-user'), /needs Desktop/);
  });
  await test('actual registered tool enforces actor and preset; Desktop endpoint persists review and active lookup', async () => {
    const tools = new Map(), disposers = [];
    const results = await import('../plugins/dsh-redteam-results/lib/index.js');
    const ctx = { sessions: { get: id => ({ id, header: { agentPreset: id === 'audit' ? 'code-audit' : 'pentest' } }) },
      tools: { register: tool => tools.set(tool.name, tool), guard: () => {} }, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); }, webServer: { register: () => () => {} } };
    results.apply(ctx);
    try {
      const tool = tools.get('redteam_method'), exec = id => ({ agent: { session: ctx.sessions.get(id) } });
      assert(tool); assert.equal((await tool.execute({ action: 'list' }, exec('audit'))).ok, false);
      let activationDenied = false;
      try { activationDenied = (await tool.execute({ action: 'activate', digest: v2.digest, expectedDigest: '' }, exec('fixture'))).ok === false; }
      catch (error) { activationDenied = error.name === 'ToolArgsError' && /action/.test(error.message); }
      assert.equal(activationDenied, true);
      await results.dispatch(ctx, store, 'methods.action', { sessionId: 'fixture', action: 'activate', digest: v2.digest, expectedDigest: '' });
      const active = await tool.execute({ action: 'active', id: 'controlled-fixture' }, exec('fixture'));
      assert.equal(active.method.digest, v2.digest); assert.equal(active.method.document.files[0].content, code);
      await assert.rejects(results.dispatch(ctx, store, 'methods.action', { sessionId: 'audit', action: 'activate', digest: v2.digest, expectedDigest: v2.digest }), /渗透/);
      assert.equal((await tool.execute({ action: 'detail', digest: v2.digest }, exec('fixture'))).ok, true);
      assert(tool.output.render({}, active)[0].text.includes(v2.digest));
    } finally { for (const dispose of disposers.reverse()) await dispose(); }
  });
  await test('stored payload tampering is detected rather than consumed as trusted code', () => {
    const original = store.db.prepare('SELECT document FROM method_packages WHERE digest=?').get(v2.digest).document;
    store.db.prepare('UPDATE method_packages SET document=? WHERE digest=?').run(original + ' ', v2.digest);
    assert.throws(() => activeMethodPackage(store, 'controlled-fixture'), /digest mismatch/);
    store.db.prepare('UPDATE method_packages SET document=? WHERE digest=?').run(original, v2.digest);
    assert.equal(activeMethodPackage(store, 'controlled-fixture').digest, v2.digest);
  });
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  store.close(); fs.rmSync(home, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
