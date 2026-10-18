import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, updateTaskProgress, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { listTaskEvents, taskEvent } from '../plugins/dsh-redteam-results/lib/task-policy-record.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-task-events-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const ctx = { sessions: { get: id => id === 'ev' ? { id, header: { agentPreset: 'pentest' } } : null } };
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
try {
  startTaskPolicy(store, 'ev', { mode: 'regular', budget: { toolCalls: 5 } });
  updateTaskProgress(store, 'ev', { cancelled: true });
  test('events are delivered in cursor order with a monotonic next cursor', () => {
    const page = listTaskEvents(store, 'ev', {});
    assert(page.events.length >= 1);
    assert.equal(page.nextCursor, page.events.at(-1).cursor);
    for (let i = 1; i < page.events.length; i += 1) assert(page.events[i].cursor > page.events[i - 1].cursor, 'cursors are strictly increasing');
    assert.equal(page.currentRevision, readTaskPolicy(store, 'ev').policyRev);
  });
  test('re-reading from the returned cursor never repeats an event', () => {
    const first = listTaskEvents(store, 'ev', {});
    const second = listTaskEvents(store, 'ev', { afterCursor: first.nextCursor });
    assert.equal(second.events.length, 0);
    assert.equal(second.nextCursor, first.nextCursor);
  });
  test('an older revision is marked stale so it cannot overwrite current state', () => {
    const current = readTaskPolicy(store, 'ev').policyRev;
    taskEvent(store, 'ev', current - 1, 'late-writer', { note: 'stale result' });
    taskEvent(store, 'ev', current, 'current-writer', { note: 'current result' });
    const page = listTaskEvents(store, 'ev', {});
    const late = page.events.find(event => event.kind === 'late-writer');
    const fresh = page.events.find(event => event.kind === 'current-writer');
    assert.equal(late.stale, true, 'an older revision is stale');
    assert.equal(fresh.stale, false, 'the current revision is not stale');
  });
  // 任务/工作/执行引用（v6 第 9.3 节）：事件要能指回归属，缺省为 null 而不是编造。
  test('events carry task/work/execution references and leave unknown ones null', () => {
    const rev = readTaskPolicy(store, 'ev').policyRev;
    taskEvent(store, 'ev', rev, 'execution-recorded', { executionId: 'execution-x', workId: 'child-x' });
    taskEvent(store, 'ev', rev, 'refs-bare', {});
    const feed = listTaskEvents(store, 'ev', { limit: 200 });
    const withRefs = feed.events.find(event => event.detail.executionId === 'execution-x');
    assert.deepEqual(withRefs.refs, { task: 'ev', work: 'child-x', execution: 'execution-x' });
    const bare = feed.events.find(event => event.kind === 'refs-bare');
    assert.equal(bare.refs.task, 'ev');
    assert.equal(bare.refs.work, null);
    assert.equal(bare.refs.execution, null);
  });
  test('pagination caps the batch and reports remaining work', () => {
    const page = listTaskEvents(store, 'ev', { limit: 1 });
    assert.equal(page.events.length, 1);
    assert(page.more >= 1);
    assert.throws(() => listTaskEvents(store, 'ev', { afterCursor: -1 }), /事件游标/);
    assert.throws(() => listTaskEvents(store, 'ev', { limit: 0 }), /事件数量/);
  });
  try {
    const rpc = await results.dispatch(ctx, store, 'task.events', { sessionId: 'ev', afterCursor: 0, limit: 50 });
    assert.equal(rpc.ok, true); assert(rpc.events.length >= 1); assert.equal((await results.dispatch(ctx, store, 'task.events', { sessionId: 'ev', afterCursor: rpc.nextCursor })).events.length, 0);
    await assert.rejects(results.dispatch(ctx, store, 'task.events', { sessionId: 'nope' }), /渗透会话/);
    console.log('ok   RPC task.events delivers the same cursor feed for the current pentest session');
  } catch (error) { failed++; console.log('FAIL RPC task.events: ' + (error.stack || error.message)); }
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
