// W06：项目结果统计、导出与页面 RPC 使用同一事实；导出不访问目标、表格按文本。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, recordProjectCheck, upsertProjectSource, readProjectRun, listProjectChecks } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { buildProjectDeliveryFiles, zipProjectDelivery, projectCounts } from '../plugins/dsh-redteam-results/lib/project-delivery.js';
import { dispatch } from '../plugins/dsh-redteam-results/lib/index.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-delivery-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const ctx = {
  sessions: { get: id => ({ id, header: { agentPreset: 'pentest' } }) },
  agents: { get: () => ({ status: 'idle', followup: () => {} }) },
  tools: { guard: () => {} },
  get: () => null,
};

function prepare(sid) {
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试人事系统', budget: { minutes: 30 } });
  const run = createProjectRun(store, sid, { question: '按文档测试人事系统' });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  const checks = defineProjectChecks(store, sid, run.runId, [
    { requirement: '员工只能查看自己的资料', sourceLocation: '表1 第2行' },
    { requirement: '普通员工不能审批', sourceLocation: '表1 第3行' },
    { requirement: '公式列检查', sourceLocation: '工作表1 第3行' },
    { requirement: '尚未开始的项目', sourceLocation: '第5段' },
  ]);
  recordProjectCheck(store, sid, run.runId, checks[0].checkId, { executionState: 'ended', verdict: 'issue', checkedContent: '员工 B 读取到员工 A 的电话' });
  recordProjectCheck(store, sid, run.runId, checks[1].checkId, { executionState: 'ended', verdict: 'blocked', gaps: '缺少审批人账号' });
  recordProjectCheck(store, sid, run.runId, checks[2].checkId, { executionState: 'ended', verdict: 'not_found', checkedContent: '=SUM(A1:A2) 计算结果与页面一致', gaps: '只检查了只读路径' });
  upsertProjectSource(store, sid, { sourceId: 'doc-1', sourceRevision: 'rev-1', displayName: '测试要求.xlsx', kind: 'xlsx', parseState: 'ready', sections: [{ sectionId: 'sheet-1-row-1' }] });
  return { run: running, checks: listProjectChecks(store, sid, run.runId) };
}

try {
  await test('统计把已结束、发现问题、缺条件、部分完成和未开始分开', () => {
    const { run, checks } = prepare('pd-count');
    const counts = projectCounts(checks);
    assert.equal(counts.total, 4);
    assert.equal(counts.ended, 3);
    assert.equal(counts.issue, 1);
    assert.equal(counts.blocked, 1);
    assert.equal(counts.notFound, 1);
    assert.equal(counts.partial, 1, 'not_found 带缺口应计为部分完成');
    assert.equal(counts.pending, 1);
  });

  await test('导出包含要求、结果、说明与来源，未执行不写成通过', () => {
    const { run } = prepare('pd-export');
    const bundle = buildProjectDeliveryFiles(store, 'pd-export', run.runId);
    const report = bundle.files['delivery/project-report.md'];
    assert(report.includes('员工只能查看自己的资料'));
    assert(report.includes('发现问题'));
    assert(report.includes('缺少条件'));
    assert(report.includes('未开始'));
    assert(!report.includes('尚未开始的项目（来源：第5段）→ 未发现问题'), '未执行不能写成未发现问题');
    const sources = bundle.files['delivery/project-sources.md'];
    assert(sources.includes('测试要求.xlsx'));
    assert(sources.includes('rev-1'));
  });

  await test('导出表格按文本，公式前缀不会在 Excel 中执行', () => {
    const { run } = prepare('pd-tsv');
    const bundle = buildProjectDeliveryFiles(store, 'pd-tsv', run.runId);
    const tsv = bundle.files['delivery/project-checks.tsv'];
    assert(tsv.includes("'=SUM(A1:A2)"), '以 = 开头的说明必须加文本前缀');
    assert(!tsv.includes('\t=SUM(A1:A2)'), '不能让 Excel 直接当公式');
    const zip = zipProjectDelivery(store, 'pd-tsv', run.runId);
    assert.equal(zip.archive.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
  });

  await test('project.status / project.export 与导出读取同一事实', async () => {
    const { run } = prepare('pd-rpc');
    const status = await dispatch(ctx, store, 'project.status', { sessionId: 'pd-rpc' });
    assert.equal(status.ok, true);
    assert.equal(status.run.runId, run.runId);
    assert.equal(status.counts.total, 4);
    const detail = await dispatch(ctx, store, 'project.check-detail', { sessionId: 'pd-rpc', checkId: status.checks[0].checkId });
    assert.equal(detail.ok, true);
    assert.equal(detail.check.verdict, 'issue');
    const exported = await dispatch(ctx, store, 'project.export', { sessionId: 'pd-rpc' });
    assert.equal(exported.ok, true);
    assert.equal(exported.counts.total, status.counts.total);
    assert.equal(exported.counts.issue, status.counts.issue);
    assert(Buffer.from(exported.archive, 'base64').subarray(0, 4).toString('latin1') === 'PK\u0003\u0004');
    const taskStatus = await dispatch(ctx, store, 'task.status', { sessionId: 'pd-rpc' });
    assert.equal(taskStatus.ok, true, taskStatus.error);
    assert.equal(taskStatus.policy.scenario, 'project', 'task.status 必须向项目面板透传 scenario');
  });

  await test('project.start 幂等，pause / resume / stop 状态一致', async () => {
    const started = await dispatch(ctx, store, 'project.start', { sessionId: 'pd-start', policy: { question: '按文档测试', budget: { minutes: 30 } } });
    assert.equal(started.ok, true);
    assert.equal(started.existing, false);
    const again = await dispatch(ctx, store, 'project.start', { sessionId: 'pd-start', policy: { question: '另一个窗口再次开始' } });
    assert.equal(again.existing, true);
    assert.equal(again.run.runId, started.run.runId);
    const running = transitionProjectRun(store, 'pd-start', started.run.runId, 'running', started.run.controlRev);
    const paused = await dispatch(ctx, store, 'project.pause', { sessionId: 'pd-start', runId: running.runId });
    assert.equal(paused.run.state, 'paused');
    const resumed = await dispatch(ctx, store, 'project.resume', { sessionId: 'pd-start', runId: running.runId });
    assert.equal(resumed.run.state, 'preparing');
    const runningAgain = transitionProjectRun(store, 'pd-start', running.runId, 'running', resumed.run.controlRev);
    const stopped = await dispatch(ctx, store, 'project.stop', { sessionId: 'pd-start', runId: runningAgain.runId });
    assert.equal(stopped.run.state, 'cancelled');
    assert.equal(readProjectRun(store, 'pd-start', runningAgain.runId).state, 'cancelled');
    const restarted = await dispatch(ctx, store, 'project.start', { sessionId: 'pd-start', policy: { question: '第二轮按文档测试', budget: { minutes: 30 } } });
    assert.equal(restarted.ok, true, restarted.error);
    assert.equal(restarted.existing, false, '结束后的再次开始必须建立新运行');
    assert.notEqual(restarted.run.runId, stopped.run.runId);
    assert.equal(readProjectRun(store, 'pd-start', runningAgain.runId).state, 'cancelled', '旧运行必须保留');
    assert.equal(readTaskPolicy(store, 'pd-start').question, '第二轮按文档测试');
  });
} finally {
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
