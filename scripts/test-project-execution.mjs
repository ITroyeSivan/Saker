// W04：项目 HTTP 派发、公共限制、身份绑定、回执与未知写入。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, listProjectActions, readProjectCheck, readProjectRun, beginProjectAction, markProjectActionDispatched, finishProjectAction, reconcileProjectAction } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { executeProjectHttp } from '../plugins/dsh-redteam-results/lib/project-execution.js';
import { readExecutionReceipt } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { saveAccount } from '../plugins/dsh-redteam-results/lib/accounts.js';
import { acquireTargetSlot } from '../plugins/dsh-redteam-results/lib/request-pacing.js';
import { resumeProjectRun } from '../plugins/dsh-redteam-results/lib/project-runtime.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-execution-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const seen = [];
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    seen.push({ method: request.method, url: request.url, headers: request.headers });
    if (request.url === '/slow') return;
    if (request.url === '/aborted') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100000' });
      response.write('partial-response');
      setTimeout(() => response.destroy(), 20);
      return;
    }
    if (request.url === '/truncate') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '65550' });
      response.write(Buffer.alloc(65530, 'A'));
      response.end(Buffer.alloc(20, 'B'));
      return;
    }
    if (request.url === '/secret') {
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'audit_cookie=SYNTHETIC_COOKIE; HttpOnly' });
      response.end(JSON.stringify({ password: 'SYNTHETIC_PASSWORD', access_token: 'SYNTHETIC_TOKEN', business: 'VISIBLE_BUSINESS_VALUE' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, marker: 'SAKER_PROJECT_HTTP' }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

async function prepare(sid, options = {}) {
  startTaskPolicy(store, sid, {
    scenario: 'project', question: '按文档检查接口', target: origin,
    budget: { minutes: 10 }, readOnly: options.readOnly === true,
  });
  const run = createProjectRun(store, sid, { question: '按文档检查接口' });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  const [check] = defineProjectChecks(store, sid, run.runId, [{ requirement: options.requirement || '检查接口返回' }]);
  return { run: running, check };
}

try {
  await test('项目 GET 真实派发并保存可校验回执', async () => {
    const { run, check } = await prepare('pe-ok');
    const result = await executeProjectHttp(store, 'pe-ok', run.runId, check.checkId, { method: 'GET', url: origin + '/api/ok' });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert(result.summary.includes('SAKER_PROJECT_HTTP'), '项目请求返回文本必须让模型看到正文');
    assert(result.summary.includes('executionId='), '项目请求返回文本必须带执行回执');
    const receipt = readExecutionReceipt(store, 'pe-ok', result.executionId);
    assert.equal(receipt.source, 'host-project-http-execution');
    assert.equal(receipt.current, true);
    assert.equal(receipt.integrityValid, true);
    assert.equal(receipt.projectRunId, run.runId);
    const actions = listProjectActions(store, 'pe-ok', run.runId);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].executionState, 'completed');
    const updated = readProjectCheck(store, 'pe-ok', run.runId, check.checkId);
    assert(updated.actionRefs.includes(result.actionId));
  });

  await test('只读任务拒绝写方法', async () => {
    const { run, check } = await prepare('pe-readonly', { readOnly: true });
    await assert.rejects(() => executeProjectHttp(store, 'pe-readonly', run.runId, check.checkId, {
      method: 'POST', url: origin + '/api/write', body: 'name=1',
    }), /read_only_target|不改动网站数据/);
    assert.equal(listProjectActions(store, 'pe-readonly', run.runId).length, 0, '被拒绝的请求不能建立动作');
  });

  await test('范围外 URL 被拒绝', async () => {
    const { run, check } = await prepare('pe-scope');
    await assert.rejects(() => executeProjectHttp(store, 'pe-scope', run.runId, check.checkId, {
      method: 'GET', url: 'http://127.0.0.1:1/outside',
    }), /outside the current task site/);
  });

  await test('已取消的信号不会派发请求', async () => {
    const { run, check } = await prepare('pe-cancel');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => executeProjectHttp(store, 'pe-cancel', run.runId, check.checkId, {
      method: 'GET', url: origin + '/api/ok',
    }, controller.signal), /已取消/);
    assert.equal(listProjectActions(store, 'pe-cancel', run.runId).length, 0);
  });

  await test('等待速率槽时取消会结束 queued 动作且不扣派发额度', async () => {
    startTaskPolicy(store, 'pe-queued-cancel', { scenario: 'project', question: '排队取消', target: origin,
      requestRatePerMinute: 600, requestConcurrency: 1, budget: { minutes: 10 } });
    const run = createProjectRun(store, 'pe-queued-cancel', { question: '排队取消' });
    const running = transitionProjectRun(store, 'pe-queued-cancel', run.runId, 'running', run.controlRev);
    const [check] = defineProjectChecks(store, 'pe-queued-cancel', run.runId, [{ requirement: '等待队列' }]);
    const before = seen.length;
    const first = await executeProjectHttp(store, 'pe-queued-cancel', running.runId, check.checkId, {
      method: 'GET', url: origin + '/api/ok',
    });
    assert.equal(first.ok, true);
    const controller = new AbortController();
    const pending = executeProjectHttp(store, 'pe-queued-cancel', running.runId, check.checkId, {
      method: 'GET', url: origin + '/api/queued',
    }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(() => pending, /取消|abort/i);
    const actions = listProjectActions(store, 'pe-queued-cancel', running.runId);
    assert.equal(actions.length, 2);
    assert.equal(actions.at(-1).executionState, 'failed');
    assert.equal(actions.at(-1).sideEffectUnknown, false);
    assert.equal(seen.length, before + 1, '排队取消不能到达目标');
    assert.equal(readTaskPolicy(store, 'pe-queued-cancel').used.toolCalls, 1, '排队取消不扣派发额度');
  });

  await test('旧控制版本的排队动作在暂停恢复后不派发，新版本动作仍可执行', async () => {
    const sid = 'pe-stale-control';
    startTaskPolicy(store, sid, {
      scenario: 'project', question: '旧队列控制版本', target: origin,
      requestConcurrency: 1, budget: { minutes: 10 },
    });
    const created = createProjectRun(store, sid, { question: '旧队列控制版本' });
    const run = transitionProjectRun(store, sid, created.runId, 'running', created.controlRev);
    const [check] = defineProjectChecks(store, sid, run.runId, [{ requirement: '旧队列检查' }]);
    const release = await acquireTargetSlot(sid, { requestConcurrency: 1 });
    const before = seen.length;
    const usedBefore = readTaskPolicy(store, sid).used.toolCalls;
    const pending = executeProjectHttp(store, sid, run.runId, check.checkId, {
      method: 'GET', url: origin + '/stale-control',
    });
    for (let index = 0; index < 50; index++) {
      if (listProjectActions(store, sid, run.runId).some(action => action.executionState === 'queued')) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const paused = transitionProjectRun(store, sid, run.runId, 'paused', run.controlRev, { blocker: { code: 'needs-user' } });
    const preparing = transitionProjectRun(store, sid, run.runId, 'preparing', paused.controlRev);
    const resumed = transitionProjectRun(store, sid, run.runId, 'running', preparing.controlRev);
    release();
    await assert.rejects(() => pending, /状态已变化|不可派发/);
    const stale = listProjectActions(store, sid, run.runId)[0];
    assert.equal(stale.executionState, 'failed');
    assert.equal(stale.controlRev, run.controlRev, '旧动作不能改写为恢复后的新控制版本');
    assert.equal(seen.length, before, '旧队列在版本变化后不能到达目标');
    assert.equal(readTaskPolicy(store, sid).used.toolCalls, usedBefore, '旧队列拒绝不能扣派发额度');
    const fresh = await executeProjectHttp(store, sid, run.runId, check.checkId, {
      method: 'GET', url: origin + '/fresh-control', controlRev: resumed.controlRev,
    });
    assert.equal(fresh.ok, true, fresh.error);
    assert.equal(seen.length, before + 1, '新控制版本可以建立并派出新动作');
  });

  await test('排队动作的身份引用变化后不能派发', async () => {
    const sid = 'pe-stale-identity';
    const { run, check } = await prepare(sid);
    const begun = beginProjectAction(store, sid, run.runId, check.checkId, {
      executionState: 'queued', identityRef: 'alice', controlRev: run.controlRev,
    });
    assert.throws(() => markProjectActionDispatched(store, sid, run.runId, begun.action.actionId, {
      identityRef: 'bob', controlRev: run.controlRev,
    }), /身份|identity/);
    assert.equal(readProjectActionState(sid, run.runId, begun.action.actionId), 'queued');
  });

  await test('写方法超时保留 sideEffectUnknown，不伪装未执行', async () => {
    const { run, check } = await prepare('pe-unknown');
    await assert.rejects(() => executeProjectHttp(store, 'pe-unknown', run.runId, check.checkId, {
      method: 'POST', url: origin + '/slow', body: 'name=1', timeoutMs: 300,
    }), /超时/);
    const actions = listProjectActions(store, 'pe-unknown', run.runId);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].executionState, 'unknown');
    assert.equal(actions[0].sideEffectUnknown, true);
  });

  await test('响应中途断开在期限内收尾并保留未知副作用', async () => {
    const { run, check } = await prepare('pe-aborted');
    const started = Date.now();
    const outcome = await Promise.race([
      executeProjectHttp(store, 'pe-aborted', run.runId, check.checkId, {
        method: 'POST', url: origin + '/aborted', body: 'name=1', timeoutMs: 200,
      }).then(() => 'resolved', error => 'rejected:' + error.message),
      new Promise(resolve => setTimeout(() => resolve('unsettled'), 1000)),
    ]);
    assert.match(outcome, /^rejected:.*(?:中止|关闭|aborted|error)/i);
    assert(Date.now() - started < 1200, '响应断线不能永久悬挂');
    const action = listProjectActions(store, 'pe-aborted', run.runId)[0];
    assert.equal(action.executionState, 'unknown');
    assert.equal(action.sideEffectUnknown, true);
    assert(action.receivedBytes >= 'partial-response'.length);
    assert(action.retainedBytes >= 'partial-response'.length);
    assert.equal(action.bodyUnavailable, true);
  });

  await test('跨 64KiB 截断线保留可用前缀并记录实际接收字节', async () => {
    const { run, check } = await prepare('pe-truncate');
    const result = await executeProjectHttp(store, 'pe-truncate', run.runId, check.checkId, {
      method: 'GET', url: origin + '/truncate',
    });
    assert.equal(result.ok, true, result.error);
    assert.match(result.summary, /实际接收 65550 字节，保留 65536 字节/);
    const receipt = readExecutionReceipt(store, 'pe-truncate', result.executionId);
    assert.equal(receipt.responseBytes, 65550);
    assert.equal(receipt.capturedBytes, 65536);
    assert.equal(receipt.complete, false);
    assert.equal(Buffer.from(receipt.responseBodyBase64, 'base64').length, 65536);
  });

  await test('未知写入核对后可继续，仍未知时不能恢复', async () => {
    const { run, check } = await prepare('pe-reconcile');
    const begun = beginProjectAction(store, 'pe-reconcile', run.runId, check.checkId, {});
    finishProjectAction(store, 'pe-reconcile', run.runId, begun.action.actionId, {
      executionState: 'unknown', sideEffectUnknown: true, error: '响应断线',
    });
    const paused = transitionProjectRun(store, 'pe-reconcile', run.runId, 'paused', run.controlRev, { blocker: { code: 'unknown-side-effect' } });
    assert.throws(() => resumeProjectRun(store, 'pe-reconcile', run.runId, paused.controlRev), /未知的写入动作/);
    const stillUnknown = reconcileProjectAction(store, 'pe-reconcile', run.runId, begun.action.actionId, {
      outcome: 'still_unknown', reason: '只读核对仍未取得明确业务结果',
    });
    assert.equal(stillUnknown.sideEffectUnknown, true);
    assert.throws(() => resumeProjectRun(store, 'pe-reconcile', run.runId, paused.controlRev), /未知的写入动作/);
    const occurred = reconcileProjectAction(store, 'pe-reconcile', run.runId, begun.action.actionId, {
      outcome: 'occurred', reason: '通过独立只读列表确认目标数据已经改变',
    });
    assert.equal(occurred.sideEffectUnknown, false);
    assert.equal(occurred.executionState, 'completed');
    assert.equal(occurred.reconciliation.outcome, 'occurred');
    assert.equal(resumeProjectRun(store, 'pe-reconcile', run.runId, paused.controlRev).state, 'preparing');
  });

  await test('有效账号秘密只在派发时套用，回执不写秘密', async () => {
    const { run, check } = await prepare('pe-identity');
    saveAccount(store, 'pe-identity', { name: 'alice', status: 'valid', secret: 'session=SAKER_SECRET' });
    seen.length = 0;
    const result = await executeProjectHttp(store, 'pe-identity', run.runId, check.checkId, {
      method: 'GET', url: origin + '/api/me', authContext: 'alice',
    });
    assert.equal(result.status, 200);
    assert(seen.at(-1).headers.cookie.includes('SAKER_SECRET'), '秘密必须到达目标');
    const receipt = readExecutionReceipt(store, 'pe-identity', result.executionId);
    assert(!receipt.request.includes('SAKER_SECRET'), '回执原文不能写秘密');
  });

  await test('项目工具摘要与响应头遮蔽合成凭据并保留业务正文', async () => {
    const { run, check } = await prepare('pe-redact');
    const result = await executeProjectHttp(store, 'pe-redact', run.runId, check.checkId, {
      method: 'GET', url: origin + '/secret',
    });
    assert.equal(result.ok, true, result.error);
    assert(!result.summary.includes('SYNTHETIC_PASSWORD'));
    assert(!result.summary.includes('SYNTHETIC_TOKEN'));
    assert(!JSON.stringify(result.responseHeaders).includes('SYNTHETIC_COOKIE'));
    assert(result.summary.includes('VISIBLE_BUSINESS_VALUE'), '合法业务正文仍需可分析');
  });
} finally {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

function readProjectActionState(sid, runId, actionId) {
  return store.db.prepare('SELECT state FROM project_actions WHERE session_id=? AND run_id=? AND action_id=?')
    .get(sid, runId, actionId)?.state;
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
