// 先注册共享测试桩：本套件经过 task-context → checked 这条链会碰到宿主的裸包
// （`dsh-saker`），不装桩在仓库里根本 import 不进来。
import './test-stub-register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { archiveTaskRound, chosenTaskOptions, hasUnreleasedWorker, readTaskPolicy, setTaskWorkers, startTaskPolicy,
  workerReportedFinished } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { CorruptRecordError } from '../plugins/dsh-redteam-results/lib/row-record.js';

// 与 site-workers.js 的 SITE_WORKER_SCHEMA 等价。内联是为了不把整条插件依赖链
// （site-workers → business-materials → checked → dsh-saker）拉进这个测试进程。
const SITE_WORKER_SCHEMA = `CREATE TABLE IF NOT EXISTS site_workers (
 parent_session TEXT NOT NULL, child_id TEXT PRIMARY KEY, site TEXT NOT NULL,
 record TEXT NOT NULL, UNIQUE(parent_session,site));`;

// 坏行必须让当前操作**明确失败**并指出是哪张表哪条会话；不允许静默当成"没有这一行"。
const home = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'saker-corrupt-row-'));
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
function test(label, fn) { try { fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }
const capture = fn => { try { fn(); return null } catch (error) { return error } };

try {
  await test('a healthy task policy still reads normally', () => {
    startTaskPolicy(store, 'good-session', { mode: 'regular', budget: { toolCalls: 10 } });
    assert.equal(readTaskPolicy(store, 'good-session').mode, 'regular');
  });

  await test('a corrupt task_policy row fails with the table and session named', () => {
    store.db.prepare('INSERT OR REPLACE INTO task_policy (session_id, record, updated_at) VALUES (?,?,?)')
      .run('bad-policy', '{not json', new Date().toISOString());
    const error = capture(() => readTaskPolicy(store, 'bad-policy'));
    assert(error instanceof CorruptRecordError, 'expected the typed error, got ' + error);
    assert.equal(error.table, 'task_policy');
    assert.equal(error.rowId, 'bad-policy');
    assert.match(error.message, /bad-policy/);
  });

  await test('a corrupt task_flow_choice row is reported the same way', () => {
    store.db.prepare('INSERT OR REPLACE INTO task_flow_choice (session_id, record) VALUES (?,?)').run('bad-flow', 'oops');
    const error = capture(() => chosenTaskOptions(store, 'bad-flow'));
    assert(error instanceof CorruptRecordError, 'expected the typed error, got ' + error);
    assert.equal(error.table, 'task_flow_choice');
    assert.match(error.message, /bad-flow/);
  });

  await test('a corrupt worker row blocks the quota change instead of being skipped', () => {
    startTaskPolicy(store, 'worker-parent', { mode: 'regular', budget: { toolCalls: 10 } });
    store.db.exec(SITE_WORKER_SCHEMA);
    store.db.prepare('INSERT OR REPLACE INTO site_workers (parent_session, child_id, site, record) VALUES (?,?,?,?)')
      .run('worker-parent', 'child-1', 'https://fixture.test', '{"broken"');
    const error = capture(() => setTaskWorkers(store, 'worker-parent', 0, 'desktop-user'));
    assert(error instanceof CorruptRecordError, 'expected the typed error, got ' + error);
    assert.equal(error.table, 'site_workers');
    assert.equal(error.rowKey, 'parent_session');
    assert.equal(error.rowId, 'worker-parent');
  });

  await test('the shared worker predicate and round archiving surface a corrupt row', () => {
    store.db.exec(SITE_WORKER_SCHEMA);
    startTaskPolicy(store, 'archive-parent', { mode: 'regular', budget: { toolCalls: 10 } });
    store.db.prepare('INSERT OR REPLACE INTO site_workers (parent_session, child_id, site, record) VALUES (?,?,?,?)')
      .run('archive-parent', 'child-bad', 'https://fixture.test', '{"broken"');
    const listed = capture(() => hasUnreleasedWorker(store, 'archive-parent'));
    assert(listed instanceof CorruptRecordError, 'expected the typed error, got ' + listed);
    assert.equal(listed.table, 'site_workers');
    assert.equal(listed.rowId, 'archive-parent');
    // 只有 desktop-user / parent-round-continuation 能开新一轮；用后者绕过"必须用户点确认"的前置检查，
    // 直接验证子代理判定那一步（这里正是坏行必须挡住的地方）。
    const archived = capture(() => archiveTaskRound(store, 'archive-parent', 'parent-round-continuation'));
    assert(archived instanceof CorruptRecordError,
      'archiving must not treat a corrupt worker row as released; got: ' + String(archived && archived.message));
    assert.equal(archived.rowKey, 'parent_session');
  });

  await test('a missing child row means "not finished" while a corrupt one is reported', () => {
    assert.equal(workerReportedFinished(store, 'child-absent'), false);
    store.db.prepare('INSERT OR REPLACE INTO site_workers (parent_session, child_id, site, record) VALUES (?,?,?,?)')
      .run('some-parent', 'child-corrupt', 'https://fixture.test', 'nope');
    const error = capture(() => workerReportedFinished(store, 'child-corrupt'));
    assert(error instanceof CorruptRecordError, 'expected the typed error, got ' + error);
    assert.equal(error.rowKey, 'child_id');
    assert.equal(error.rowId, 'child-corrupt');
  });
} finally {
  try { store.close?.() } catch { /* store may already be closed */ }
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('Fixture verification only: an isolated SQLite fixture, no host or model.');
process.exitCode = failed ? 1 : 0;
