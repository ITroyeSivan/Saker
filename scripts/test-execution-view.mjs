import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { executionLedger } from '../plugins/dsh-redteam-results/lib/execution-view.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-execution-view-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
try {
  const receipt = (id, outcome, patch = {}) => store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)')
    .run('ex', id, JSON.stringify({ id, source: 'host-http-execution', endpoint: 'https://ex.test/api/' + id, hypothesisId: 'd1',
      requestId: 'r-' + id, requestRevision: 'v1', outcome, status: outcome === 'response' ? 200 : null,
      startedAt: '2026-10-12T00:00:00.000Z', completedAt: '2026-10-12T00:00:01.000Z', elapsedMs: 30, requestAttempts: 1, impactVerified: false, ...patch }));
  receipt('ok', 'response');
  receipt('timeout', 'timeout');
  receipt('abort', 'interrupted');
  receipt('redirect', 'redirect-not-followed');
  // 坏行隔离
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run('ex', 'bad', '{');
  store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?)').run('ex', 1, 1, 'tool/call', '{}');
  store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?)').run('ex', 2, 2, 'assistant/message', JSON.stringify({ totalTokens: 100 }));
  store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?)').run('ex', 3, 3, 'assistant/message', JSON.stringify({ totalTokens: null }));

  test('executions are classified into returned/failed/unknown and exclude the corrupt row', () => {
    const ledger = executionLedger(store, 'ex', {});
    assert.deepEqual(ledger.counts, { all: 6, returned: 4, failed: 1, unknown: 1 });
    assert.equal(ledger.total, 6);
  });
  test('result filter narrows rows while counts stay authoritative', () => {
    assert.deepEqual(executionLedger(store, 'ex', { result: 'failed' }).rows.map(r => r.id), ['timeout']);
    assert.deepEqual(executionLedger(store, 'ex', { result: 'unknown' }).rows.map(r => r.id), ['abort']);
    assert.equal(executionLedger(store, 'ex', { result: 'returned' }).counts.all, 6);
    assert.throws(() => executionLedger(store, 'ex', { result: 'bogus' }), /执行结果筛选/);
  });
  test('rows expose time, host, path, status and a request reference without copying the original', () => {
    const row = executionLedger(store, 'ex', {}).rows.find(r => r.id === 'ok');
    assert.equal(row.host, 'ex.test'); assert.equal(row.path, '/api/ok'); assert.equal(row.status, 200);
    assert.equal(row.requestRef, 'r-ok:v1'); assert.equal(row.result, 'returned');
    assert(!('request' in row) && !('responseHead' in row), 'the ledger keeps references, not originals');
  });
  test('usage summarises tool and model calls and flags unknown usage', () => {
    const usage = executionLedger(store, 'ex', {}).usage;
    assert.deepEqual(usage, { toolCalls: 1, modelCalls: 2, attemptCalls: 0, unknownUsageCalls: 1 });
  });
  test('pagination slices server-side and reports more', () => {
    const page = executionLedger(store, 'ex', { page: 2, pageSize: 3 });
    assert.equal(page.rows.length, 3); assert.equal(page.more, 0);
    assert.equal(executionLedger(store, 'ex', { page: 1, pageSize: 3 }).more, 3);
  });
  test('execution ledger includes session tool calls and model attempts alongside HTTP receipts', () => {
    store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run('ex2', 'http-1',
      JSON.stringify({ id: 'http-1', source: 'host-http-execution', endpoint: 'https://ex.test/api/x', requestId: 'r-x', requestRevision: 'v1',
        outcome: 'response', status: 200, startedAt: '2026-10-12T00:00:00.000Z', completedAt: '2026-10-12T00:00:01.000Z', elapsedMs: 10 }));
    store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?)')
      .run('ex2', 1, Date.parse('2026-10-12T00:00:02.000Z'), 'tool/call', JSON.stringify({ toolName: 'read', callId: 'c1' }));
    store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?)')
      .run('ex2', 2, Date.parse('2026-10-12T00:00:03.000Z'), 'tool/result', JSON.stringify({ callId: 'c1', ok: true, error: '' }));
    store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?)')
      .run('ex2', 3, Date.parse('2026-10-12T00:00:04.000Z'), 'assistant/attempt', JSON.stringify({ totalTokens: 50 }));
    store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?)')
      .run('ex2', 4, Date.parse('2026-10-12T00:00:05.000Z'), 'assistant/message', JSON.stringify({ totalTokens: 80 }));
    const ledger = executionLedger(store, 'ex2', {});
    assert.equal(ledger.total, 4);
    assert(ledger.rows.some(row => row.id === 'tool-c1' && row.kind === 'tool' && row.toolName === 'read'));
    assert(ledger.rows.some(row => row.kind === 'model'));
    assert(ledger.rows.some(row => row.kind === 'model-attempt' && row.callState === 'unknown'));
    assert(ledger.rows.some(row => row.kind === 'http'));
  });
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
