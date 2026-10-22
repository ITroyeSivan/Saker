// W05：项目连续推进、阻碍、取消、无进展暂停与恢复。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, pauseTaskPolicy, updateTaskProgress, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { writeTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy-record.js';
import {
  createProjectRun, transitionProjectRun, defineProjectChecks, recordProjectCheck,
  beginProjectAction, finishProjectAction, readProjectRun,
  upsertProjectSource,
} from '../plugins/dsh-redteam-results/lib/project-store.js';
import { recordProjectDocumentRead } from '../plugins/dsh-redteam-results/lib/project-progress.js';
import { projectContinuation, projectTurnDecision, markProjectContinuation, resumeProjectRun, completeProjectRun, projectExecutableChecks, setProjectRunState, synchronizeStoppedProjectRun } from '../plugins/dsh-redteam-results/lib/project-runtime.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-runtime-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

function prepare(sid, requirements = [{ requirement: '检查员工资料' }, { requirement: '检查文件下载' }]) {
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试', budget: { minutes: 30 } });
  const run = createProjectRun(store, sid, { question: '按文档测试' });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  const checks = requirements.length ? defineProjectChecks(store, sid, run.runId, requirements) : [];
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
  observation('pr-progress', run, checks[0], { body: '权限检查实际返回正常内容' });
  recordProjectCheck(store, 'pr-progress', run.runId, checks[0].checkId, { executionState: 'ended', verdict: 'not_found', checkedContent: '已检查正常权限' });
  const next = projectContinuation(store, 'pr-progress');
  assert(next, '检查状态变化后应重新接续');
  assert.equal(next.attempts, 0);
  assert(next.text.includes(checks[1].requirement));
});

test('相同失败动作换新 ID 仍会无进展暂停', () => {
  const sid = 'pr-repeat-failure';
  const { run, checks } = prepare(sid);
  const attempts = [];
  for (let index = 0; index < 5; index++) {
    const continuation = projectContinuation(store, sid);
    if (!continuation) break;
    attempts.push(continuation.attempts);
    markProjectContinuation(store, sid, run.runId, continuation.fingerprint, continuation.attempts);
    const begun = beginProjectAction(store, sid, run.runId, checks[0].checkId, {});
    finishProjectAction(store, sid, run.runId, begun.action.actionId, {
      executionState: 'failed', error: '同一连接错误',
    });
  }
  assert.equal(readProjectRun(store, sid, run.runId).state, 'paused', '失败记录增加不能被当作新进展');
  assert.deepEqual(attempts, [0, 1]);
});

function observation(sid, run, check, { body = 'same observation', request = 'same request', date = 'now' } = {}) {
  const begun = beginProjectAction(store, sid, run.runId, check.checkId, {});
  const id = 'execution-' + begun.action.actionId;
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(sid, id, JSON.stringify({
    id, projectRunId: run.runId, projectCheckId: check.checkId, actionId: begun.action.actionId,
    method: 'GET', url: 'http://127.0.0.1/item', authContext: 'employee-a', outcome: 'response', status: 200,
    requestSha256: request, responseHead: 'HTTP/1.1 200 OK\r\nDate: ' + date,
    responseBodyBase64: Buffer.from(body).toString('base64'), complete: true,
  }));
  finishProjectAction(store, sid, run.runId, begun.action.actionId, { executionState: 'completed', requestRef: id });
  return { actionId: begun.action.actionId, requestRef: id };
}

test('相同成功观测换回执 ID 和响应时间不重复算进展', () => {
  const sid = 'pr-repeat-observation';
  const { run, checks } = prepare(sid);
  for (let index = 0; index < 3; index++) {
    observation(sid, run, checks[0], { date: String(index) });
    const continuation = projectContinuation(store, sid);
    if (index === 2) { assert.equal(continuation, null, '重复同一观测不能无限接续'); break; }
    assert.equal(continuation.attempts, index, '只有首次实际观测算新进展');
    markProjectContinuation(store, sid, run.runId, continuation.fingerprint, continuation.attempts);
  }
  assert.equal(readProjectRun(store, sid, run.runId).state, 'paused');
});

test('真实新响应内容仍允许继续，不因移除动作数量丢掉进展', () => {
  const sid = 'pr-new-observation';
  const { run, checks } = prepare(sid);
  observation(sid, run, checks[0]);
  const first = projectContinuation(store, sid);
  markProjectContinuation(store, sid, run.runId, first.fingerprint, first.attempts);
  observation(sid, run, checks[0], { body: 'new actual response' });
  const next = projectContinuation(store, sid);
  assert.equal(next.attempts, 0, '实际响应改变应计为进展');
});

test('没有真实回执的动作完成标记不制造进展', () => {
  const sid = 'pr-empty-action';
  const { run, checks } = prepare(sid);
  const first = projectContinuation(store, sid);
  markProjectContinuation(store, sid, run.runId, first.fingerprint, first.attempts);
  const begun = beginProjectAction(store, sid, run.runId, checks[0].checkId, {});
  finishProjectAction(store, sid, run.runId, begun.action.actionId, { executionState: 'completed' });
  assert.equal(projectContinuation(store, sid).attempts, 1, '只写 completed 不等于取得实际观测');
});

test('增加未读取来源不算进展，检查状态往返不反复清零', () => {
  const sid = 'pr-monotonic';
  const { run, checks } = prepare(sid);
  const observed = observation(sid, run, checks[0], { body: '已观察正常内容' });
  recordProjectCheck(store, sid, run.runId, checks[0].checkId, { executionState: 'ended', verdict: 'not_found', checkedContent: '已观察正常内容' });
  const first = projectContinuation(store, sid);
  markProjectContinuation(store, sid, run.runId, first.fingerprint, first.attempts);
  upsertProjectSource(store, sid, { displayName: '尚未读取', sections: [] });
  recordProjectCheck(store, sid, run.runId, checks[0].checkId, { executionState: 'pending' });
  const second = projectContinuation(store, sid);
  assert.equal(second.attempts, 1, '空来源和退回 pending 不提供新事实');
  markProjectContinuation(store, sid, run.runId, second.fingerprint, second.attempts);
  recordProjectCheck(store, sid, run.runId, checks[0].checkId, {
    executionState: 'ended', verdict: 'not_found', checkedContent: '已观察正常内容',
  });
  const third = projectContinuation(store, sid);
  assert(third === null || third.attempts >= 1, '重新保存已有结论不能把无进展计数重置为 0');
});

test('迟到的接续标记不能修改已停止运行', () => {
  const sid = 'pr-late-mark';
  const { run } = prepare(sid);
  const continuation = projectContinuation(store, sid);
  transitionProjectRun(store, sid, run.runId, 'cancelled', run.controlRev);
  const stopped = readProjectRun(store, sid, run.runId);
  markProjectContinuation(store, sid, run.runId, continuation.fingerprint, continuation.attempts);
  assert.deepEqual(readProjectRun(store, sid, run.runId), stopped, '停止后不接受迟到接续元数据');
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
  observation('pr-complete', run, checks[0], { body: '检查一实际响应' });
  recordProjectCheck(store, 'pr-complete', run.runId, checks[0].checkId, { executionState: 'ended', verdict: 'not_found', checkedContent: '检查一实际响应正常' });
  assert.throws(() => completeProjectRun(store, 'pr-complete', run.runId), /未结束的检查/);
  assert(projectContinuation(store, 'pr-complete'), '还有未结束项时应继续');
  observation('pr-complete', run, checks[1], { body: '检查二实际响应' });
  recordProjectCheck(store, 'pr-complete', run.runId, checks[1].checkId, { executionState: 'ended', verdict: 'not_found', checkedContent: '检查二实际响应正常' });
  assert.equal(projectContinuation(store, 'pr-complete'), null);
  const completed = completeProjectRun(store, 'pr-complete', run.runId);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.completedSummary.ended, 2);
});

test('完成判断独立拒绝历史遗留的无动作完整阴性', () => {
  const sid = 'pr-legacy-empty-negative';
  const { run, checks } = prepare(sid, [{ requirement: '历史空结论' }]);
  const legacy = {
    ...checks[0], executionState: 'ended', verdict: 'not_found',
    checkedContent: '旧版本没有保存任何动作', updatedAt: new Date().toISOString(),
  };
  store.db.prepare('UPDATE project_checks SET record=?,updated_at=? WHERE session_id=? AND run_id=? AND check_id=?')
    .run(JSON.stringify(legacy), legacy.updatedAt, sid, run.runId, checks[0].checkId);
  const decision = projectTurnDecision(store, sid);
  assert.equal(decision.action, 'waiting');
  assert.equal(decision.blocker.code, 'evidence-required');
  assert.throws(() => completeProjectRun(store, sid, run.runId), /动作|证据|观测/);
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

test('一项检查结束后由项目判定收尾，并同步公共 policy', () => {
  const sid = 'pr-auto-complete';
  const { run, checks } = prepare(sid, [{ requirement: '检查唯一要求' }]);
  observation(sid, run, checks[0], { body: '已核对正常页面' });
  recordProjectCheck(store, sid, run.runId, checks[0].checkId, {
    executionState: 'ended', verdict: 'not_found', checkedContent: '已核对正常页面',
  });
  const decision = projectTurnDecision(store, sid);
  assert.equal(decision.action, 'completed');
  const completed = completeProjectRun(store, sid, run.runId);
  assert.equal(completed.state, 'completed');
  assert.equal(readTaskPolicy(store, sid).planComplete, true, '项目完成必须同步公共任务状态');
});

test('只有缺条件项时进入 waiting，不伪装成 completed', () => {
  const sid = 'pr-waiting-blocked';
  const { run, checks } = prepare(sid, [{ requirement: '需要审批账号' }]);
  recordProjectCheck(store, sid, run.runId, checks[0].checkId, {
    executionState: 'ended', verdict: 'blocked', gaps: '缺少审批账号',
  });
  const decision = projectTurnDecision(store, sid);
  assert.equal(decision.action, 'waiting');
  assert.equal(decision.blocker.code, 'waiting-conditions');
});

test('零要求进入 waiting，空计划不能自动完成', () => {
  const sid = 'pr-no-requirements';
  const { run } = prepare(sid, []);
  const decision = projectTurnDecision(store, sid);
  assert.equal(decision.action, 'waiting');
  assert.equal(decision.blocker.code, 'no-requirements');
  assert.equal(readProjectRun(store, sid, run.runId).state, 'running');
});

test('preparing 阶段仍有未读来源时有界接续，不会提前结束', () => {
  const sid = 'pr-preparing-source';
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试', budget: { minutes: 30 } });
  upsertProjectSource(store, sid, {
    sourceId: 'source-a', sourceRevision: 'r1', displayName: '要求.txt', kind: 'text', parseState: 'ready',
    sections: [{ sectionId: 'p1', text: '员工只能查看自己的资料。' }],
  });
  const run = createProjectRun(store, sid, {
    question: '按文档测试', sourceSnapshot: [{ sourceId: 'source-a', sourceRevision: 'r1' }],
  });
  const decision = projectTurnDecision(store, sid);
  assert.equal(decision.action, 'continue');
  assert.match(decision.continuation.text, /先读取来源/);
});

test('检查全部结束但来源尚未整理时不能自动完成', () => {
  const sid = 'pr-source-pending';
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试', budget: { minutes: 30 } });
  upsertProjectSource(store, sid, {
    sourceId: 'source-b', sourceRevision: 'r1', displayName: '要求.txt', kind: 'text', parseState: 'ready',
    sections: [{ sectionId: 'p1', text: '普通员工不能审批。' }],
  });
  const run = createProjectRun(store, sid, {
    question: '按文档测试', sourceSnapshot: [{ sourceId: 'source-b', sourceRevision: 'r1' }],
  });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  const checks = defineProjectChecks(store, sid, running.runId, [{ requirement: '检查审批限制' }]);
  observation(sid, running, checks[0], { body: '普通员工入口实际响应' });
  recordProjectCheck(store, sid, running.runId, checks[0].checkId, {
    executionState: 'ended', verdict: 'not_found', checkedContent: '已检查普通员工入口',
  });
  const decision = projectTurnDecision(store, sid);
  assert.equal(decision.action, 'continue', '来源未整理不能被 checks.every(ended) 抢先判定完成');
  assert.throws(() => completeProjectRun(store, sid, running.runId), /未整理/);
});

test('来源完整读取并保存决定后，检查结束才 completed', () => {
  const sid = 'pr-source-complete';
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试', budget: { minutes: 30 } });
  upsertProjectSource(store, sid, {
    sourceId: 'source-c', sourceRevision: 'r1', displayName: '要求.txt', kind: 'text', parseState: 'ready',
    sections: [{ sectionId: 'p1', text: '普通员工不能审批。' }],
  });
  const run = createProjectRun(store, sid, {
    question: '按文档测试', sourceSnapshot: [{ sourceId: 'source-c', sourceRevision: 'r1' }],
  });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  assert.equal(recordProjectDocumentRead(store, sid, running.runId, {
    sourceId: 'source-c', sourceRevision: 'r1', sectionId: 'p1', cursor: 0, text: '普通员工不能审批。',
  }), true);
  const checks = defineProjectChecks(store, sid, running.runId, [{
    checkId: 'check-c1', requirement: '检查审批限制',
    sourceRefs: [{ sourceId: 'source-c', sourceRevision: 'r1', sectionId: 'p1' }],
  }], [{
    sourceId: 'source-c', sourceRevision: 'r1', sectionId: 'p1',
    decision: 'requirements', checkIds: ['check-c1'],
  }]);
  observation(sid, running, checks[0], { body: '普通员工审批入口返回无权限' });
  recordProjectCheck(store, sid, running.runId, checks[0].checkId, {
    executionState: 'ended', verdict: 'not_found', checkedContent: '普通员工审批入口返回无权限',
  });
  const decision = projectTurnDecision(store, sid);
  assert.equal(decision.action, 'completed');
});

test('来源级无法读取决定清除该区域，但不会把空计划当完成', () => {
  const sid = 'pr-source-unreadable';
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试', budget: { minutes: 30 } });
  upsertProjectSource(store, sid, {
    sourceId: 'source-d', sourceRevision: 'r1', displayName: '损坏的文档.docx', kind: 'docx', parseState: 'unreadable',
    sections: [], unread: [{ location: { kind: 'file' }, reason: '文档无法解析' }],
  });
  const run = createProjectRun(store, sid, {
    question: '按文档测试', sourceSnapshot: [{ sourceId: 'source-d', sourceRevision: 'r1' }],
  });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  defineProjectChecks(store, sid, running.runId, [], [{
    sourceId: 'source-d', sourceRevision: 'r1', sectionId: '#source',
    decision: 'unreadable', rationale: '解析器明确报告文档损坏',
  }]);
  const decision = projectTurnDecision(store, sid);
  assert.equal(decision.action, 'waiting');
  assert.equal(decision.blocker.code, 'no-requirements');
});

test('无正文的来源可以作为来源级 reference 整理，不触发段落读取错误', () => {
  const sid = 'pr-source-reference';
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试', budget: { minutes: 30 } });
  upsertProjectSource(store, sid, {
    sourceId: 'source-empty', sourceRevision: 'r1', displayName: '说明.txt', kind: 'text', parseState: 'ready', sections: [],
  });
  const run = createProjectRun(store, sid, {
    question: '按文档测试', sourceSnapshot: [{ sourceId: 'source-empty', sourceRevision: 'r1' }],
  });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  defineProjectChecks(store, sid, running.runId, [], [{
    sourceId: 'source-empty', sourceRevision: 'r1', sectionId: '#source',
    decision: 'reference', rationale: '用户只提供了背景说明，没有测试要求',
  }]);
  const decision = projectTurnDecision(store, sid);
  assert.equal(decision.action, 'waiting');
  assert.equal(decision.blocker.code, 'no-requirements');
});

test('模型提前标记 planComplete 不能绕过项目检查收尾', () => {
  const sid = 'pr-premature-plan';
  const { run } = prepare(sid, [{ requirement: '尚未执行的检查' }]);
  const policy = readTaskPolicy(store, sid);
  writeTaskPolicy(store, sid, { ...policy, planComplete: true, finishedAt: Date.now() }, 'legacy-early-complete');
  const decision = projectTurnDecision(store, sid);
  assert.equal(decision.action, 'waiting');
  assert.equal(decision.blocker.code, 'plan-complete-early');
  assert.throws(() => updateTaskProgress(store, sid, { planComplete: true }), /项目收尾由来源整理和检查状态判定/);
  assert.equal(readProjectRun(store, sid, run.runId).state, 'running');
});

test('模型准入失败未产生停止钩子时，项目仍能同步暂停且不重置额度', () => {
  const sid = 'pr-native-limit';
  const { run } = prepare(sid);
  const policy = readTaskPolicy(store, sid);
  writeTaskPolicy(store, sid, { ...policy, used: { ...policy.used, toolCalls: 5 }, modelBudgetBlock: { code: 'model_calls_exhausted', message: '模型调用次数已用完' } }, 'fixture-native-model-denial');
  const paused = synchronizeStoppedProjectRun(store, sid);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.controlRev, run.controlRev + 1);
  assert.match(paused.blocker.reason, /模型调用次数/);
  assert.equal(readTaskPolicy(store, sid).used.toolCalls, 5);
  assert.equal(readTaskPolicy(store, sid).modelBudgetBlock.code, 'model_calls_exhausted');
  assert.equal(synchronizeStoppedProjectRun(store, sid).controlRev, paused.controlRev, '轮询不重复改变控制版本');
});
store.close();
fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
