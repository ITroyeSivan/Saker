import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { chooseTaskMode, startTaskPolicy, updateTaskProgress, readTaskPolicy, archiveTaskRound } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { webSelection, saveWebSelection } from '../plugins/dsh-method-stack/lib/web-selection.js';
import { TEST_CONTENT_KEYS } from '../plugins/dsh-redteam-results/lib/test-catalog.js';
import { writeTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy-record.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-task-modules-'));
const store = openStore(path.join(home, 'redteam-results/results.db'));
const catalog = [{ group: 'recon', methods: [{ id: 'port-scan' }, { id: 'subdomain-enum' }] },
  { group: 'exploit', methods: [{ id: 'sqli' }, { id: 'xss' }] }];
const keys = TEST_CONTENT_KEYS;
const select = (id, defaults) => webSelection(home, id, catalog, defaults);
const save = (id, active, snapshot = select(id)) => saveWebSelection(home, id, snapshot.mode, active, snapshot.rev, catalog, undefined, snapshot.policyRev);
const start = (id, mode = 'regular', workflow = 'single') => { select(id); return startTaskPolicy(store, id,
  { mode, workflow, budget: { toolCalls: 20, workers: 0 }, question: '核对当前模块约束' }); };
let passed = 0, failed = 0;
const test = (name, work) => { try { work(); passed++; console.log('ok ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } };
try {
  test('one task keeps explicit empty selection across regular, 0day and nday', () => {
    save('shared', []);
    for (const mode of ['0day', 'nday', 'regular']) {
      chooseTaskMode(store, 'shared', mode);
      const state = select('shared');
      assert.deepEqual(state.active, [], 'switching mode must not restore defaults');
      assert.equal(state.available, true, 'Nday must retain the same module control');
    }
  });
  test('starting a task adopts its prepared selection without a method-plugin read', () => {
    save('start', ['sqli']); start('start');
    assert.deepEqual(readTaskPolicy(store, 'start').modules, ['sqli']);
  });
  test('mode transition preserves selection and invalidates stale task revision', () => {
    chooseTaskMode(store, 'flow', 'regular', { workflow: 'regular-to-nday', workers: 0 });
    save('flow', ['sqli']); start('flow', 'regular', 'regular-to-nday');
    const before = select('flow');
    updateTaskProgress(store, 'flow', { regularComplete: true });
    const next = select('flow');
    assert.equal(next.mode, 'nday'); assert.deepEqual(next.active, ['sqli']);
    assert(next.policyRev > before.policyRev);
    assert.throws(() => saveWebSelection(home, 'flow', 'nday', keys, next.rev, catalog, undefined, before.policyRev), /任务.*变化|冲突/);
  });
  test('child follows current root mode and module revision and cannot edit', () => {
    save('root', ['sqli']); start('root');
    store.db.prepare('INSERT INTO task_policy(session_id,record,updated_at) VALUES(?,?,?)').run('child', JSON.stringify({ mode: '0day', parentSession: 'root' }), new Date().toISOString());
    assert.equal(select('child').mode, 'regular');
    const changed = save('root', ['port-service']);
    assert.deepEqual(select('child').active, changed.active);
    assert.equal(select('child').policyRev, changed.policyRev);
    assert.throws(() => save('child', keys), /主任务/);
  });
  test('atomic changes record policy revision, audit event and update timestamp', () => {
    start('atomic'); const before = select('atomic');
    const next = save('atomic', ['subdomain'], before);
    assert.equal(next.rev, before.rev + 1); assert(next.policyRev > before.policyRev);
    const record = readTaskPolicy(store, 'atomic'); assert.equal(record.policyRev, next.policyRev);
    assert.deepEqual(record.modules, next.active);
    const events = store.db.prepare("SELECT record FROM task_policy_events WHERE session_id=? AND kind='modules-changed'").all('atomic');
    assert.equal(events.length, 1);
    const event = JSON.parse(events[0].record);
    assert.deepEqual(event.removed, keys.filter(key => key !== 'subdomain'));
    assert.deepEqual(event.added, []);
    assert.throws(() => save('atomic', keys, before), /其他窗口|任务.*变化|冲突/);
    assert.throws(() => saveWebSelection(home, 'atomic', next.mode, keys, before.rev, catalog, undefined, next.policyRev), /其他窗口/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM task_policy_events WHERE session_id=? AND kind='modules-changed'").get('atomic').n, 1);
  });
  test('cold read, new defaults and archived rounds preserve task-local choice', () => {
    assert.deepEqual(select('old-defaults', []).active, []);
    assert.deepEqual(select('old-defaults', keys).active, []);
    assert.deepEqual(select('new-defaults', keys).active, keys);
    save('rounds', ['xss']); start('rounds'); updateTaskProgress(store, 'rounds', { cancelled: true });
    const old = select('rounds'); archiveTaskRound(store, 'rounds', 'desktop-user');
    assert.deepEqual(select('rounds', keys).active, ['xss']);
    assert.throws(() => save('rounds', keys, old), /任务.*变化|冲突/);
  });
  test('legacy files migrate once and are never overwritten after database commit', () => {
    const file = path.join(home, 'method-stack/sessions', crypto.createHash('sha256').update('legacy').digest('hex') + '.regular.json');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ active: ['recon/port-scan'], rev: 4 }));
    const bytes = fs.readFileSync(file, 'utf8');
    assert.deepEqual(select('legacy').active, ['port-service']);
    save('legacy', []); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    fs.writeFileSync(file, JSON.stringify({ active: keys, rev: 999 }));
    assert.deepEqual(select('legacy').active, [], 'legacy file must not overwrite the authoritative database');
  });
  test('invalid modules and corrupt root policy fail closed', () => {
    assert.throws(() => save('invalid', ['not-a-real-check']), /测试内容/);
    store.db.prepare('INSERT INTO task_policy(session_id,record,updated_at) VALUES(?,?,?)').run('broken', '{', 'now');
    assert.throws(() => select('broken'), /task_policy|任务|JSON/);
    for (const bad of ['null', '[]', '42']) {
      store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(bad, 'broken');
      assert.throws(() => select('broken'), /task_policy/);
    }
    store.db.prepare('INSERT INTO task_module_choices(session_id,record,updated_at) VALUES(?,?,?)').run('broken-choice', 'null', 'now');
    assert.throws(() => select('broken-choice'), /task_module_choices/);
  });
  test('a stale policy writer cannot overwrite a concurrent module update', () => {
    start('lost-update'); const stale = readTaskPolicy(store, 'lost-update');
    const latest = save('lost-update', ['exploit/xss']);
    assert.throws(() => writeTaskPolicy(store, 'lost-update', { ...stale, cancelled: true }), /任务状态已变化/);
    assert.deepEqual(select('lost-update').active, latest.active);
    assert.equal(readTaskPolicy(store, 'lost-update').cancelled, false);
  });
  test('audit failure rolls back modules and revision together', () => {
    start('rollback'); const before = select('rollback');
    store.db.exec("CREATE TRIGGER reject_module_event BEFORE INSERT ON task_policy_events WHEN NEW.session_id='rollback' AND NEW.kind='modules-changed' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END");
    assert.throws(() => save('rollback', [], before), /injected audit failure/);
    assert.deepEqual(select('rollback'), before);
    store.db.exec('DROP TRIGGER reject_module_event');
  });
  test('headless task initialization uses all Web modules and settings defaults', () => {
    const first = startTaskPolicy(store, 'without-panel', { mode: 'nday', budget: { toolCalls: 3, workers: 0 } });
    assert.equal(first.modules.length, 17); assert(first.modules.includes('port-service')); assert(first.modules.includes('subdomain'));
    const dir = path.join(home, 'method-stack/profiles'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pentest.json'), JSON.stringify({ webDefaults: [] }));
    const second = startTaskPolicy(store, 'without-panel-empty', { mode: 'regular', budget: { toolCalls: 3, workers: 0 } });
    assert.deepEqual(second.modules, []); assert.equal(first.modules.length, 17);
  });
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1;
