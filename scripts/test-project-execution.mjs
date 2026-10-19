// W04：项目 HTTP 派发、公共限制、身份绑定、回执与未知写入。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, listProjectActions, readProjectCheck } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { executeProjectHttp } from '../plugins/dsh-redteam-results/lib/project-execution.js';
import { readExecutionReceipt } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { saveAccount } from '../plugins/dsh-redteam-results/lib/accounts.js';

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
} finally {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
