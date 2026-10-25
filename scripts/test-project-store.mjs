// W02：项目场景的最小存储、旧库迁移、幂等开始与旧实战回归。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, registerFinding, getFinding, SCHEMA_VERSION } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, taskPolicyStatus } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import {
  createProjectRun, activeProjectRun, listProjectRuns, transitionProjectRun,
  defineProjectChecks, listProjectChecks, recordProjectCheck, readProjectCheck,
  beginProjectAction, finishProjectAction, listProjectActions,
  upsertProjectSource, listProjectSources, readProjectSource,
} from '../plugins/dsh-redteam-results/lib/project-store.js';
import { recordObservedProjectCheck, registerVerifiedProjectFinding } from './lib/project-test-fixtures.mjs';
import { projectExecutableChecks } from '../plugins/dsh-redteam-results/lib/project-runtime.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-store-'));
process.env.DSH_HOME = home;
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

test('旧库迁移到当前 schema 后旧 finding 仍可读，项目表自动补齐', () => {
  const dbPath = path.join(home, 'legacy', 'results.db');
  const legacy = openStore(dbPath);
  const finding = registerFinding(legacy, 'legacy-session', 'pentest', { title: '旧记录', severity: 'high', target: 'http://127.0.0.1/' });
  legacy.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA user_version = 4');
  raw.exec('DROP TABLE IF EXISTS project_actions; DROP TABLE IF EXISTS project_checks; DROP TABLE IF EXISTS project_sources; DROP TABLE IF EXISTS project_runs;');
  raw.close();
  const migrated = openStore(dbPath);
  try {
    assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
    assert.equal(Number(migrated.db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
    assert.equal(getFinding(migrated, 'legacy-session', finding.id).title, '旧记录');
    for (const table of ['project_runs', 'project_sources', 'project_checks', 'project_actions'])
      assert(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), table + ' missing');
  } finally { migrated.close(); }
});

test('项目开始幂等：同一会话只保留一个活动运行，数据库级互斥生效', () => {
  const store = openStore(':memory:');
  try {
    const first = createProjectRun(store, 's-idem', { question: '检查员工管理系统' });
    const second = createProjectRun(store, 's-idem', { question: '另一个窗口再次开始' });
    assert.equal(first.existing, false);
    assert.equal(second.existing, true);
    assert.equal(second.runId, first.runId);
    assert.equal(listProjectRuns(store, 's-idem').length, 1);
    assert.equal(activeProjectRun(store, 's-idem').runId, first.runId);
    assert.throws(() => store.db.prepare('INSERT INTO project_runs(session_id,run_id,state,control_rev,record,updated_at) VALUES(?,?,?,?,?,?)')
      .run('s-idem', 'project-run-other', 'running', 1, '{}', new Date().toISOString()), /UNIQUE|constraint/i,
    '数据库必须拒绝第二个活动运行');
  } finally { store.close(); }
});

test('项目运行状态转移受词表和 controlRev 约束', () => {
  const store = openStore(':memory:');
  try {
    const run = createProjectRun(store, 's-state');
    const running = transitionProjectRun(store, 's-state', run.runId, 'running', run.controlRev);
    assert.equal(running.state, 'running');
    assert.equal(running.controlRev, run.controlRev + 1);
    assert.throws(() => transitionProjectRun(store, 's-state', run.runId, 'completed', run.controlRev), /已变化/);
    const paused = transitionProjectRun(store, 's-state', run.runId, 'paused', running.controlRev);
    const preparing = transitionProjectRun(store, 's-state', run.runId, 'preparing', paused.controlRev);
    const resumed = transitionProjectRun(store, 's-state', run.runId, 'running', preparing.controlRev);
    const completed = transitionProjectRun(store, 's-state', run.runId, 'completed', resumed.controlRev);
    assert.equal(completed.state, 'completed');
    assert.throws(() => transitionProjectRun(store, 's-state', run.runId, 'running', completed.controlRev), /invalid project run transition/);
  } finally { store.close(); }
});

test('检查记录未执行时不要求 endpoint、身份或方法版本；判断词表显式校验', () => {
  const store = openStore(':memory:');
  try {
    const run = createProjectRun(store, 's-check');
    transitionProjectRun(store, 's-check', run.runId, 'running', run.controlRev);
    const checks = defineProjectChecks(store, 's-check', run.runId, [
      { requirement: '员工只能查看自己的资料', sourceLocation: '表1 第2行' },
      { requirement: '普通员工不能审批', sourceLocation: '表1 第3行' },
    ]);
    assert.equal(checks.length, 2);
    assert.equal(checks[0].executionState, 'pending');
    assert.equal(checks[0].verdict, '');
    assert.equal(checks[0].requirement, '员工只能查看自己的资料');
    const finding = registerVerifiedProjectFinding(store, 's-check');
    const recorded = recordProjectCheck(store, 's-check', run.runId, checks[0].checkId, {
      executionState: 'ended', verdict: 'issue', checkedContent: '员工 B 读取到员工 A 的电话', findingRefs: [finding.id],
    });
    assert.equal(recorded.verdict, 'issue');
    assert.equal(recorded.checkedContent, '员工 B 读取到员工 A 的电话');
    assert.throws(() => recordProjectCheck(store, 's-check', run.runId, checks[0].checkId, { verdict: 'confirmed' }), /invalid project verdict/);
    assert.equal(listProjectChecks(store, 's-check', run.runId).length, 2);
  } finally { store.close(); }
});

test('同一运行同时最多一个派发中的动作；未知写入保留 sideEffectUnknown', () => {
  const store = openStore(':memory:');
  try {
    const run = createProjectRun(store, 's-action');
    transitionProjectRun(store, 's-action', run.runId, 'running', run.controlRev);
    const [check] = defineProjectChecks(store, 's-action', run.runId, [{ requirement: '检查文件下载权限' }]);
    const begun = beginProjectAction(store, 's-action', run.runId, check.checkId, { identityRef: 'account-a' });
    assert.equal(begun.action.executionState, 'dispatched');
    assert.equal(begun.action.identityRef, 'account-a');
    assert.throws(() => beginProjectAction(store, 's-action', run.runId, check.checkId), /同时只能有一个派发中的动作/);
    const finished = finishProjectAction(store, 's-action', run.runId, begun.action.actionId, {
      executionState: 'unknown', sideEffectUnknown: true, requestRef: 'execution-x',
    });
    assert.equal(finished.sideEffectUnknown, true);
    assert.equal(finished.requestRef, 'execution-x');
    assert.equal(listProjectActions(store, 's-action', run.runId).length, 1);
  } finally { store.close(); }
});

test('项目启动不要求 mode 或 toolCalls；null 上限不会被当成已耗尽', () => {
  const store = openStore(':memory:');
  try {
    const policy = startTaskPolicy(store, 's-project', { scenario: 'project', question: '按文档检查员工系统', budget: { minutes: 30 } });
    assert.equal(policy.scenario, 'project');
    assert.equal(policy.mode, 'project');
    assert.equal(policy.budget.toolCalls, null);
    assert.equal(policy.flow.kind, 'project');
    const status = taskPolicyStatus(store, 's-project');
    assert.equal(status.configured, true);
    assert.notEqual(status.reason, 'tool_budget_exhausted');
  } finally { store.close(); }
});

test('旧实战启动仍要求 mode，但 toolCalls 可留空', () => {
  const store = openStore(':memory:');
  try {
    assert.throws(() => startTaskPolicy(store, 's-legacy-missing', { question: 'x', budget: { toolCalls: 5 } }), /invalid task mode/);
    assert.equal(startTaskPolicy(store, 's-legacy-budget', { mode: 'regular', question: 'x' }).budget.toolCalls, null);
    const policy = startTaskPolicy(store, 's-legacy', { mode: 'regular', question: 'x', budget: { toolCalls: 5 } });
    assert.equal(policy.scenario, 'pentest');
    assert.equal(policy.mode, 'regular');
    assert.equal(policy.budget.toolCalls, 5);
    assert.throws(() => startTaskPolicy(store, 's-legacy', { scenario: 'unknown', mode: 'regular', budget: { toolCalls: 5 } }), /invalid task scenario/);
  } finally { store.close(); }
});

test('A17 来源修订各自留档，旧结果不被新修订覆盖', () => {
  const revisionStore = openStore(':memory:');
  try {
    startTaskPolicy(revisionStore, 's-rev', { scenario: 'project', question: '修订验收', budget: { minutes: 10 } });
    const run = createProjectRun(revisionStore, 's-rev', { question: '修订验收' });
    transitionProjectRun(revisionStore, 's-rev', run.runId, 'running', run.controlRev);
    const [check] = defineProjectChecks(revisionStore, 's-rev', run.runId, [{ requirement: '检查权限', sourceLocation: '表1 第2行' }]);
    upsertProjectSource(revisionStore, 's-rev', { sourceId: 'doc', sourceRevision: 'rev-1', displayName: '旧要求.docx', parseState: 'ready', sections: [{ sectionId: 'p1', text: '旧要求' }] });
    recordObservedProjectCheck(revisionStore, 's-rev', run.runId, check.checkId, {
      executionState: 'ended', verdict: 'not_found', checkedContent: '按旧要求检查通过',
    });
    upsertProjectSource(revisionStore, 's-rev', { sourceId: 'doc', sourceRevision: 'rev-2', displayName: '新要求.docx', parseState: 'ready', sections: [{ sectionId: 'p1', text: '新要求' }] });
    const revisions = listProjectSources(revisionStore, 's-rev').filter(source => source.sourceId === 'doc');
    assert.equal(revisions.length, 2, '同一来源的两个修订各自留档');
    assert.equal(readProjectSource(revisionStore, 's-rev', 'doc', 'rev-1').displayName, '旧要求.docx');
    assert.equal(readProjectSource(revisionStore, 's-rev', 'doc', 'rev-2').displayName, '新要求.docx');
    const saved = readProjectCheck(revisionStore, 's-rev', run.runId, check.checkId);
    assert.equal(saved.checkedContent, '按旧要求检查通过', '新修订不能覆盖旧结果');
    assert.equal(saved.sourceLocation, '表1 第2行', '旧来源位置必须保留');
  } finally { revisionStore.close(); }
});

test('define batch 重试幂等，内容冲突、循环依赖和缺失事实被拒绝', () => {
  const store = openStore(':memory:');
  try {
    const run = createProjectRun(store, 's-idempotent');
    transitionProjectRun(store, 's-idempotent', run.runId, 'running', run.controlRev);
    const input = [
      { checkId: 'provider', requirement: '提供审批对象', provides: ['approval-object'] },
      { checkId: 'consumer', requirement: '使用审批对象', dependencies: ['provider'], requiresFacts: ['approval-object'] },
      { checkId: 'independent', requirement: '独立检查' },
    ];
    const first = defineProjectChecks(store, 's-idempotent', run.runId, input, [], { batchId: 'batch-stable' });
    const retry = defineProjectChecks(store, 's-idempotent', run.runId, input, [], { batchId: 'batch-stable' });
    assert.equal(first.length, 3);
    assert.deepEqual(retry.map(check => check.checkId), first.map(check => check.checkId));
    assert.equal(listProjectChecks(store, 's-idempotent', run.runId).length, 3);
    assert.throws(() => defineProjectChecks(store, 's-idempotent', run.runId, [
      { checkId: 'provider', requirement: '同键但内容已改', provides: ['approval-object'] },
    ], [], { batchId: 'batch-stable' }), /内容已变化/);
    assert.throws(() => defineProjectChecks(store, 's-idempotent', run.runId, [
      { checkId: 'cycle-a', requirement: '环 A', dependencies: ['cycle-b'] },
      { checkId: 'cycle-b', requirement: '环 B', dependencies: ['cycle-a'] },
    ], [], { batchId: 'batch-cycle' }), /循环/);
    assert.throws(() => defineProjectChecks(store, 's-idempotent', run.runId, [
      { checkId: 'missing-fact', requirement: '缺少事实', dependencies: ['provider'], requiresFacts: ['not-provided'] },
    ], [], { batchId: 'batch-missing-fact' }), /没有声明提供/);
    const before = projectExecutableChecks(store, 's-idempotent', run.runId).map(check => check.checkId);
    assert(!before.includes('consumer'));
    assert(before.includes('independent'));
    recordObservedProjectCheck(store, 's-idempotent', run.runId, 'provider', {
      executionState: 'ended', verdict: 'not_found', checkedContent: '对象和身份已实际核对',
    });
    const after = projectExecutableChecks(store, 's-idempotent', run.runId).map(check => check.checkId);
    assert(after.includes('consumer'), 'requiresFacts 只有前项实际结束并提供事实后放行');
  } finally { store.close(); }
});

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
