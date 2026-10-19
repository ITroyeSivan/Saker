// A09/A10/A11：多轮接续、停止竞争与断线后的未知写入。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import {
  createProjectRun, transitionProjectRun, defineProjectChecks, recordProjectCheck,
  listProjectActions, readProjectRun,
} from '../plugins/dsh-redteam-results/lib/project-store.js';
import { projectContinuation, markProjectContinuation, resumeProjectRun } from '../plugins/dsh-redteam-results/lib/project-runtime.js';
import { executeProjectHttp } from '../plugins/dsh-redteam-results/lib/project-execution.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-lifecycle-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const server = http.createServer((request, response) => {
  if (request.url === '/drop') { request.socket.destroy(); return; }
  if (request.url === '/hang') return;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

function prepare(sid, requirements = [{ requirement: '检查一' }, { requirement: '检查二' }]) {
  startTaskPolicy(store, sid, { scenario: 'project', question: '生命周期验收', target: origin, budget: { minutes: 30 } });
  const run = createProjectRun(store, sid, { question: '生命周期验收' });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  const checks = defineProjectChecks(store, sid, run.runId, requirements);
  return { run: running, checks };
}

try {
  await test('A09 多轮接续：完成一项后产生新进度，再继续下一项', async () => {
    const { run, checks } = prepare('pl-multi');
    const first = projectContinuation(store, 'pl-multi');
    assert(first && first.text.includes('检查一'));
    markProjectContinuation(store, 'pl-multi', first.runId, first.fingerprint, first.attempts);
    recordProjectCheck(store, 'pl-multi', run.runId, checks[0].checkId, { executionState: 'ended', verdict: 'not_found', checkedContent: '已检查正常' });
    const second = projectContinuation(store, 'pl-multi');
    assert(second, '完成一项后必须继续下一项');
    assert.equal(second.attempts, 0, '新进度应重置无进展计数');
    assert(second.text.includes('检查二'));
    assert.equal(readProjectRun(store, 'pl-multi', run.runId).state, 'running');
  });

  await test('A10 接续与停止竞争：停止后旧接续不再唤醒，也不会改回运行状态', async () => {
    const { run, checks } = prepare('pl-race');
    const continuation = projectContinuation(store, 'pl-race');
    assert(continuation);
    transitionProjectRun(store, 'pl-race', run.runId, 'cancelled', run.controlRev, { blocker: { code: 'cancelled', reason: '用户停止' } });
    assert.equal(projectContinuation(store, 'pl-race'), null, '停止后不能继续唤醒');
    markProjectContinuation(store, 'pl-race', continuation.runId, continuation.fingerprint, continuation.attempts);
    const after = readProjectRun(store, 'pl-race', run.runId);
    assert.equal(after.state, 'cancelled', '迟到的接续记录不能把运行改回 running');
    assert.equal(listProjectActions(store, 'pl-race', run.runId).length, 0);
    assert.equal(checks.length, 2);
  });

  await test('A11 断线：写方法结果未知，恢复前必须拒绝', async () => {
    const { run, checks } = prepare('pl-drop', [{ requirement: '写操作' }]);
    await assert.rejects(() => executeProjectHttp(store, 'pl-drop', run.runId, checks[0].checkId, {
      method: 'POST', url: origin + '/drop', body: 'name=1', timeoutMs: 1000,
    }), /./);
    const actions = listProjectActions(store, 'pl-drop', run.runId);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].executionState, 'unknown');
    assert.equal(actions[0].sideEffectUnknown, true, '断线的写方法必须标记结果未知');
    transitionProjectRun(store, 'pl-drop', run.runId, 'paused', readProjectRun(store, 'pl-drop', run.runId).controlRev, { blocker: { code: 'needs-user' } });
    assert.throws(() => resumeProjectRun(store, 'pl-drop', run.runId), /未知的写入动作/);
  });

  await test('A11 断线的只读请求不冒充未知写入', async () => {
    const { run, checks } = prepare('pl-drop-read', [{ requirement: '读操作' }]);
    await assert.rejects(() => executeProjectHttp(store, 'pl-drop-read', run.runId, checks[0].checkId, {
      method: 'GET', url: origin + '/drop', timeoutMs: 1000,
    }), /./);
    const actions = listProjectActions(store, 'pl-drop-read', run.runId);
    assert.equal(actions[0].sideEffectUnknown, false, '只读请求断线不应标成未知写入');
    transitionProjectRun(store, 'pl-drop-read', run.runId, 'paused', readProjectRun(store, 'pl-drop-read', run.runId).controlRev, { blocker: { code: 'needs-user' } });
    const resumed = resumeProjectRun(store, 'pl-drop-read', run.runId);
    assert.equal(resumed.state, 'preparing');
  });
} finally {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
