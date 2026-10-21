import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { createProjectRun, defineProjectChecks, transitionProjectRun, beginProjectAction, finishProjectAction, recordProjectCheck, saveProjectBrowserObservation } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { BrowserSession } from '../plugins/dsh-redteam-results/lib/browser-session.js';
import { acquireTargetSlot } from '../plugins/dsh-redteam-results/lib/request-pacing.js';
import { parseDocumentIsolated } from '../plugins/dsh-redteam-results/lib/project-document-parser.js';
import { observeProjectCheck } from './lib/project-test-fixtures.mjs';
import { buildProjectDeliveryFiles } from '../plugins/dsh-redteam-results/lib/project-delivery.js';

let failed = 0;
async function test(name, work) {
  try { await work(); console.log('ok   ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
}
function fakeBrowser(options = {}) {
  const handlers = new Map(), calls = [];
  const client = {
    on(method, handler) { const list = handlers.get(method) || []; list.push(handler); handlers.set(method, list); return () => {}; },
    async call(method, params) { calls.push({ method, params }); return {}; },
  };
  return { browser: new BrowserSession({ child: { exitCode: null }, client, ...options }), handlers, calls };
}

await test('shared dependencies form a valid diamond, not a cycle', () => {
  const store = openStore(':memory:');
  try {
    const run = createProjectRun(store, 'diamond');
    const checks = defineProjectChecks(store, 'diamond', run.runId, [
      { checkId: 'a', requirement: 'Login' },
      { checkId: 'b', requirement: 'Read account', dependencies: ['a'] },
      { checkId: 'c', requirement: 'Read order', dependencies: ['a'] },
      { checkId: 'd', requirement: 'Compare order', dependencies: ['b', 'c'] },
    ]);
    assert.equal(checks.length, 4);
    assert.throws(() => defineProjectChecks(store, 'diamond', run.runId, [
      { checkId: 'x', requirement: 'X', dependencies: ['y'] },
      { checkId: 'y', requirement: 'Y', dependencies: ['x'] },
    ]), /循环/);
  } finally { store.close(); }
});

await test('browser rechecks pause and control revision AFTER a pacing wait', async () => {
  let paused = false, inspected;
  const checked = new Promise(resolve => { inspected = resolve; });
  const policy = { requestConcurrency: 1 };
  const held = await acquireTargetSlot('readiness-queued', policy);
  const { browser, handlers, calls } = fakeBrowser({ pacingSessionId: 'readiness-queued', requestGuard: async () => {
    inspected();
    return paused ? { denial: 'paused' } : { policy, revision: 'run-2' };
  } });
  try {
    await browser.watchPolicy();
    const operation = handlers.get('Fetch.requestPaused')[0]({ requestId: 'fetch-1', networkId: 'network-1', request: { url: 'http://127.0.0.1/example', method: 'GET' } });
    await checked;
    paused = true;
    held();
    await operation;
    assert.equal(calls.filter(call => call.method === 'Fetch.continueRequest').length, 0, 'paused request was continued');
    assert.equal(calls.filter(call => call.method === 'Fetch.failRequest').length, 1);
    const release = await acquireTargetSlot('readiness-queued', policy, AbortSignal.timeout(500));
    release();
  } finally { held(); browser.guardAbort.abort(); }
});

await test('request overrides never add a second unguarded Fetch listener or disable the guard', async () => {
  const { browser, handlers, calls } = fakeBrowser({ requestGuard: async () => ({ denial: 'outside' }) });
  await browser.watchPolicy();
  await browser.setRequestOverride({ headers: { 'X-Test': 'one' } });
  for (const listener of handlers.get('Fetch.requestPaused')) await listener({ requestId: 'f1', request: { url: 'http://127.0.0.1/outside', method: 'GET' } });
  await browser.clearRequestOverride();
  assert.equal(calls.filter(call => call.method === 'Fetch.continueRequest').length, 0, 'override bypassed the denial');
  assert.equal(calls.filter(call => call.method === 'Fetch.disable').length, 0, 'clearing an override disabled the guard');
});

await test('redirect hops release their previous concurrency slot before following the next hop', async () => {
  const { browser, handlers, calls } = fakeBrowser({ pacingSessionId: 'redirect-hop', requestGuard: async () => ({ policy: { requestConcurrency: 1 } }) });
  browser.watchNetwork();
  await browser.watchPolicy();
  const fetch = handlers.get('Fetch.requestPaused')[0];
  await fetch({ requestId: 'f1', networkId: 'n1', request: { url: 'http://127.0.0.1/login', method: 'GET' } });
  handlers.get('Network.requestWillBeSent')[0]({ requestId: 'n1', redirectResponse: { status: 302 }, request: { url: 'http://127.0.0.1/home', method: 'GET' } });
  const timer = setTimeout(() => browser.guardAbort.abort(new Error('redirect-slot-stuck')), 500);
  try {
    await fetch({ requestId: 'f2', networkId: 'n1', request: { url: 'http://127.0.0.1/home', method: 'GET' } });
    assert.equal(calls.filter(call => call.method === 'Fetch.continueRequest').length, 2, 'redirect waited on its own previous request');
  } finally {
    clearTimeout(timer);
    for (const release of browser.pacingReleases.values()) release();
  }
});

await test('document parsing has a terminable deadline and recovers after timeout or cancel', async () => {
  const input = Buffer.from('Environment\nCheck account permissions');
  const parsed = await parseDocumentIsolated(input, { displayName: 'requirements.txt' });
  assert(parsed.sections.some(section => section.text.includes('permissions')));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    await assert.rejects(parseDocumentIsolated(input, { timeoutMs: 1 }), /超时/);
    assert(ticks > 0, 'parser blocked the main event loop');
    const controller = new AbortController();
    const pending = parseDocumentIsolated(input, { signal: controller.signal });
    controller.abort(new Error('cancel-parser'));
    await assert.rejects(pending, /cancel-parser/);
    const after = await parseDocumentIsolated(input);
    assert.equal(after.parseState, 'ready');
    await assert.rejects(parseDocumentIsolated(Buffer.alloc(20 * 1024 * 1024 + 1)), /20MiB/);
  } finally { clearInterval(timer); }
});

await test('truncated or unavailable HTTP observations cannot support a complete negative', () => {
  const store = openStore(':memory:');
  try {
    const run = createProjectRun(store, 'incomplete-body');
    transitionProjectRun(store, 'incomplete-body', run.runId, 'running', run.controlRev);
    defineProjectChecks(store, 'incomplete-body', run.runId, [{ checkId: 'c1', requirement: 'Check account data' }]);
    const observed = observeProjectCheck(store, 'incomplete-body', run.runId, 'c1');
    const row = store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?').get('incomplete-body', observed.executionId);
    const receipt = { ...JSON.parse(row.record), complete: false, bodyUnavailable: 'evicted' };
    store.db.prepare('UPDATE execution_receipts SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(receipt), 'incomplete-body', observed.executionId);
    assert.throws(() => recordProjectCheck(store, 'incomplete-body', run.runId, 'c1', {
      executionState: 'ended', verdict: 'not_found', checkedContent: 'Account data appears safe',
    }), /usable-observation-missing/);
    const partial = recordProjectCheck(store, 'incomplete-body', run.runId, 'c1', {
      executionState: 'ended', verdict: 'not_found', checkedContent: 'Only response headers were read', gaps: 'Response body was unavailable',
    });
    assert(partial.gaps);
  } finally { store.close(); }
});

await test('a browser URL without a saved observation is not reusable evidence', () => {
  const store = openStore(':memory:');
  try {
    const run = createProjectRun(store, 'page-url');
    transitionProjectRun(store, 'page-url', run.runId, 'running', run.controlRev);
    defineProjectChecks(store, 'page-url', run.runId, [{ checkId: 'c1', requirement: 'Check page' }]);
    const begun = beginProjectAction(store, 'page-url', run.runId, 'c1');
    finishProjectAction(store, 'page-url', run.runId, begun.action.actionId, { executionState: 'completed', pageRef: 'http://127.0.0.1/page' });
    assert.throws(() => recordProjectCheck(store, 'page-url', run.runId, 'c1', {
      executionState: 'ended', verdict: 'not_found', checkedContent: 'Page appears safe',
    }), /usable-observation-missing/);
    const page = { title: 'Account', url: 'http://127.0.0.1/page', text: 'VISIBLE_ACCOUNT_OBSERVATION', observedAt: new Date().toISOString() };
    const observationRef = saveProjectBrowserObservation(store, 'page-url', run.runId, begun.action.actionId, page);
    assert(observationRef.startsWith('project-observation-'));
    const ended = recordProjectCheck(store, 'page-url', run.runId, 'c1', {
      executionState: 'ended', verdict: 'not_found', checkedContent: 'Account data was checked',
    });
    assert.equal(ended.verdict, 'not_found');
    const delivery = buildProjectDeliveryFiles(store, 'page-url', run.runId);
    assert(Object.values(delivery.files).some(text => String(text).includes('VISIBLE_ACCOUNT_OBSERVATION')), 'offline delivery omitted the actual page observation');
    assert.equal(delivery.missing.length, 0);
  } finally { store.close(); }
});

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
