// W05：项目连续推进、阻碍、取消、无进展暂停与恢复。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, pauseTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import {
  createProjectRun, transitionProjectRun, defineProjectChecks, recordProjectCheck,
  beginProjectAction, finishProjectAction, readProjectRun,
} from '../plugins/dsh-redteam-results/lib/project-store.js';
import { projectContinuation, markProjectContinuation, resumeProjectRun, completeProjectRun, projectExecutableChecks } from '../plugins/dsh-redteam-results/lib/project-runtime.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-runtime-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

function prepare(sid, requirements = [{ requirement: '检查员工资料' }, { requirement: '检查文件下载' }]) {
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试', budget: { minutes: 30 } });
  const run = createProjectRun(store, sid, { question: '按文档测试' });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  const checks = defineProjectChecks(store, sid, run.runId, requirements);
  return { run: running, checks };
}

test('多项要求仍可执行时给出简短接续消息', () => {
  const { run, checks } = prepare('pr-continue');
  const continuation = projectContinuation(store, 'pr-continue');
  assert(continuation, '应返回接续消息');
  assert.equal(continuation.runId, run.runId);
  assert(continuation.text.includes(checks[0].requirement));
  assert(continuation.text.includes('project_check record'));
  assert(!continuation.text.includes('完整工具手册'));
});

test('取消、暂停和在途动作都不会被旧消息唤醒', () => {
  const { run: pausedRun } = prepare('pr-paused-run');
  transitionProjectRun(store, 'pr-paused-run', pausedRun.runId, 'paused', pausedRun.controlRev, { blocker: { code: 'needs-user' } });
  assert.equal(projectContinuation(store, 'pr-paused-run'), null, '已暂停运行不能被旧消息唤醒');
  const { checks } = prepare('pr-cancel');
  pauseTaskPolicy(store, 'pr-cancel', { code: 'needs-user', reason: '用户停止', evidence: 'test-stop' }, 'test');
  assert.equal(projectContinuation(store, 'pr-cancel'), null);
  const { run: run2, checks: checks2 } = prepare('pr-inflight');
  beginProjectAction(store, 'pr-inflight', run2.runId, checks2[0].checkId, { identityRef: 'alice' });
  assert.equal(projectContinuation(store, 'pr-inflight'), null);
  const { run: run3, checks: checks3 } = prepare('pr-unknown');
  const begun = beginProjectAction(store, 'pr-unknown', run3.runId, checks3[0].checkId, {});
  finishProjectAction(store, 'pr-unknown', run3.runId, begun.action.actionId, { executionState: 'unknown', sideEffectUnknown: true });
  assert.equal(projectContinuation(store, 'pr-unknown'), null);
});

test('同一进度重复接续达到阈值后暂停，不再反复发继续', () => {
  const { run } = prepare('pr-noprogress');
  const first = projectContinuation(store, 'pr-noprogress');
  assert.equal(first.attempts, 0);
  markProjectContinuation(store, 'pr-noprogress', first.runId, first.fingerprint, first.attempts);
  const second = projectContinuation(store, 'pr-noprogress');
  assert.equal(second.attempts, 1);
  markProjectContinuation(store, 'pr-noprogress', second.runId, second.fingerprint, second.attempts);
  const third = projectContinuation(store, 'pr-noprogress');
  assert.equal(third, null, '重复同一进度不应继续唤醒');
  const paused = readProjectRun(store, 'pr-noprogress', run.runId);
  assert.equal(paused.state, 'paused');
  assert.match(paused.blocker.reason, /自动继续未能推进/);
});

test('有新的检查状态变化时重新允许接续', () => {
  const { run, checks } = prepare('pr-progress');
  const first = projectContinuation(store, 'pr-progress');
  markProjectContinuation(store, 'pr-progress', first.runId, first.fingerprint, first.attempts);
  recordProjectCheck(store, 'pr-progress', run.runId, checks[0].checkId, { executionState: 'ended', verdict: 'not_found', checkedContent: '已检查正常权限' });
  const next = projectContinuation(store, 'pr-progress');
  assert(next, '检查状态变化后应重新接续');
  assert.equal(next.attempts, 0);
  assert(next.text.includes(checks[1].requirement));
});

test('依赖受阻的检查不阻塞独立项', () => {
  const { run, checks } = prepare('pr-dependency', [
    { requirement: '依赖项：需要审批账号', checkId: 'dep' },
    { requirement: '依赖审批结果', checkId: 'child', dependencies: ['dep'] },
    { requirement: '独立检查文件下载', checkId: 'independent' },
  ]);
  recordProjectCheck(store, 'pr-dependency', run.runId, 'dep', { executionState: 'ended', verdict: 'blocked', gaps: '缺少审批人账号' });
  const executable = projectExecutableChecks(store, 'pr-dependency', run.runId).map(check => check.checkId);
  assert(!executable.includes('child'), '依赖受阻项不能继续');
  assert(executable.includes('independent'), '独立项必须继续');
  const continuation = projectContinuation(store, 'pr-dependency');
  assert(continuation.text.includes('独立检查文件下载'));
});

test('全部检查结束后不再自动接续；complete 只在无未结束项时允许', () => {
  const { run, checks } = prepare('pr-complete', [{ requirement: '检查一' }, { requirement: '检查二' }]);
  recordProjectCheck(store, 'pr-complete', run.runId, checks[0].checkId, { executionState: 'ended', verdict: 'not_found' });
  assert.throws(() => completeProjectRun(store, 'pr-complete', run.runId), /未结束的检查/);
  assert(projectContinuation(store, 'pr-complete'), '还有未结束项时应继续');
  recordProjectCheck(store, 'pr-complete', run.runId, checks[1].checkId, { executionState: 'ended', verdict: 'issue' });
  assert.equal(projectContinuation(store, 'pr-complete'), null);
  const completed = completeProjectRun(store, 'pr-complete', run.runId);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.completedSummary.ended, 2);
});

test('恢复前拒绝未知写入；无未知写入时 paused 回到 preparing', () => {
  const { run, checks } = prepare('pr-resume-unknown');
  const begun = beginProjectAction(store, 'pr-resume-unknown', run.runId, checks[0].checkId, {});
  finishProjectAction(store, 'pr-resume-unknown', run.runId, begun.action.actionId, { executionState: 'unknown', sideEffectUnknown: true });
  transitionProjectRun(store, 'pr-resume-unknown', run.runId, 'paused', run.controlRev, { blocker: { code: 'needs-user' } });
  assert.throws(() => resumeProjectRun(store, 'pr-resume-unknown', run.runId), /未知的写入动作/);
  const { run: run2 } = prepare('pr-resume-ok');
  transitionProjectRun(store, 'pr-resume-ok', run2.runId, 'paused', run2.controlRev, { blocker: { code: 'needs-user' } });
  const resumed = resumeProjectRun(store, 'pr-resume-ok', run2.runId);
  assert.equal(resumed.state, 'preparing');
});

store.close();
fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
