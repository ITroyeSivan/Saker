// 写入期失败（磁盘写不进去）必须**整段回滚**，不留半写状态（v6 第 10.5 节「磁盘失败」故障注入）。
//
// 用两种真实注入：
//   1) `PRAGMA query_only = ON` —— SQLite 真的报 "attempt to write a readonly database"；
//   2) 在**中途那张表**上挂一个会 ABORT 的触发器 —— 模拟写到一半失败。
// 关键断言不是"抛错"，而是"抛错之后库里没有半条记录，而且恢复后同样的写入还能成功"。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, registerFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, readTaskPolicy, updateTaskProgress } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { saveTaskContext, readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { recordRetest, listRetests } from '../plugins/dsh-redteam-results/lib/retest.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-write-fail-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
const rows = (table, sessionId) => store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id=?`).get(sessionId).n;
const readonly = (work) => { store.db.exec('PRAGMA query_only = ON'); try { return { threw: false, error: null, value: work() }; } catch (error) { return { threw: true, error: error.message, value: null }; } finally { store.db.exec('PRAGMA query_only = OFF'); } };

try {
  test('只读/写不进去时，开始任务整段回滚：不留下半条 policy 或事件', () => {
    const result = readonly(() => startTaskPolicy(store, 'readonly-start', { mode: 'regular', budget: { toolCalls: 5 } }));
    assert.equal(result.threw, true, '写入必须失败');
    assert.match(result.error, /readonly|read-only|disk is full|unable to open/i);
    assert.equal(rows('task_policy', 'readonly-start'), 0, 'policy 行不能留半条');
    assert.equal(rows('task_policy_events', 'readonly-start'), 0, '事件也不能留半条');
    // 恢复后同样的写入必须成功——证明失败来自注入的写条件，而不是库坏了。
    const policy = startTaskPolicy(store, 'readonly-start', { mode: 'regular', budget: { toolCalls: 5 } });
    assert.equal(policy.mode, 'regular');
    assert.equal(rows('task_policy', 'readonly-start'), 1);
    assert(rows('task_policy_events', 'readonly-start') >= 1, '成功后事件照常写入');
  });

  test('只读时保存任务上下文整段回滚，已有上下文不被改坏', () => {
    saveTaskContext(store, 'ctx', { assets: [{ id: 'a1', url: 'https://app.example.test', inScope: true, reachable: true }], requests: [], checks: [] });
    const before = readTaskContext(store, 'ctx');
    const result = readonly(() => saveTaskContext(store, 'ctx', { assets: [{ id: 'a2', url: 'https://new.example.test', inScope: true, reachable: true }], requests: [], checks: [] }));
    assert.equal(result.threw, true);
    const after = readTaskContext(store, 'ctx');
    assert.equal(after.assets.length, before.assets.length, '失败后仍是原来那份上下文');
    assert.equal(after.assets[0].id, 'a1');
    assert.equal(rows('task_context_records', 'ctx'), 0, '失败不该留下原文记录');
  });

  test('只读时复测记录不落库，原发现不受影响', () => {
    const finding = registerFinding(store, 'retest', 'pentest', { title: '写入失败用例', severity: 'high', target: 'https://app.example.test', summary: 'fixture' });
    const result = readonly(() => recordRetest(store, 'retest', { findingId: finding.id, verdict: 'inconclusive', note: '写入失败注入' }));
    assert.equal(result.threw, true);
    assert.equal(listRetests(store, 'retest', finding.id).length, 0, '不能留下半条复测记录');
    const recorded = recordRetest(store, 'retest', { findingId: finding.id, verdict: 'inconclusive', note: '恢复后写入成功' });
    assert.equal(recorded.verdict, 'inconclusive');
    assert.equal(listRetests(store, 'retest', finding.id).length, 1);
  });

  test('写到中途失败（事件表触发器 ABORT）也不能留下已写的 policy 行', () => {
    store.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON task_policy_events WHEN NEW.session_id='mid-fail' BEGIN SELECT RAISE(ABORT,'injected mid-write failure'); END");
    try {
      assert.throws(() => startTaskPolicy(store, 'mid-fail', { mode: 'regular', budget: { toolCalls: 5 } }), /injected mid-write failure/);
    } finally { store.db.exec('DROP TRIGGER reject_event'); }
    assert.equal(rows('task_policy', 'mid-fail'), 0, '中途失败要连前面写好的 policy 行一起回滚');
    assert.equal(rows('task_policy_events', 'mid-fail'), 0);
    // 事件之前的模块选择也是同一笔写入：不回滚就会留下"有选择、没任务"的半写状态。
    assert.equal(rows('task_module_choices', 'mid-fail'), 0, '中途失败要连模块选择一起回滚');
    // 去掉触发器后同一会话还能正常开始。
    assert.equal(startTaskPolicy(store, 'mid-fail', { mode: 'regular', budget: { toolCalls: 5 } }).mode, 'regular');
    assert.equal(rows('task_policy', 'mid-fail'), 1);
  });

  test('已存在任务的进度更新在写入失败时保持原值', () => {
    startTaskPolicy(store, 'progress', { mode: 'regular', budget: { toolCalls: 5 } });
    const before = readTaskPolicy(store, 'progress').policyRev;
    const result = readonly(() => updateTaskProgress(store, 'progress', { planComplete: true }));
    assert.equal(result.threw, true);
    const after = readTaskPolicy(store, 'progress');
    assert.equal(after.policyRev, before, '修订号不能前进');
    assert.equal(after.planComplete, false, '进度不能被写成完成');
  });
} finally {
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
