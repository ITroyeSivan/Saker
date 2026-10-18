// 版本冲突的 HTTP 语义（v6 第 9.3 节「版本冲突 409 语义」）：
// 模板/任务策略的 CAS 冲突必须回 409 + 可分支的 code，而不是和参数错误一样回 400。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-http-conflict-'));
process.env.DSH_HOME = home;
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

// 捕获插件自己注册的 web 路由，用假 req/res 直接打它——测的是真实路由的 HTTP 语义。
let handler;
const disposers = [];
const ctx = { sessions: { get: () => null }, effect: fn => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
  tools: { register: () => {}, guard: () => {} }, webRuntime: { trustedHosts: [] },
  webServer: { register: route => { handler = route.handler; return () => {}; } } };
results.apply(ctx);

const HOST = '127.0.0.1:3080';
function request(url, payload, csrf) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const req = { method: payload === undefined ? 'GET' : 'POST', url, headers: { host: HOST, origin: 'http://' + HOST, 'x-dsh-csrf': csrf || '' },
    on(event, cb) { if (event === 'data') cb(Buffer.from(body)); if (event === 'end') cb(); return this; }, destroy() {} };
  const res = { status: 0, headers: null, text: '', writeHead(code, headers) { this.status = code; this.headers = headers; }, end(text) { this.text = String(text || ''); } };
  return handler(req, res).then(() => res);
}

try {
  const csrfResponse = await request('/dsh-redteam-results/csrf');
  const token = JSON.parse(csrfResponse.text).token;
  assert(token, 'csrf 可获取');

  await test('新建模板后，用过期 revision 更新回 409 且带可分支的 code 与服务端版本', async () => {
    const created = await request('/dsh-redteam-results/prompt.library', { sessionId: 'sid', action: 'upsert', template: { id: 'tpl-1', title: '冲突用例', text: '第一版' } }, token);
    assert.equal(created.status, 200, created.text);
    assert.equal(JSON.parse(created.text).template.revision, 1);

    const stale = await request('/dsh-redteam-results/prompt.library', { sessionId: 'sid', action: 'upsert', template: { id: 'tpl-1', title: '第二版', text: '改一下', expectedRevision: 99 } }, token);
    const body = JSON.parse(stale.text);
    assert.equal(stale.status, 409, '版本冲突必须是 409，实际 ' + stale.status + '：' + stale.text);
    assert.equal(body.code, 'prompt-template-conflict');
    assert.equal(body.ok, false);
    assert.equal(body.details.server.revision, 1, '要把服务端当前版本带回去，客户端才能合并');
    // 用正确 revision 就能改成功——409 不是"永久拒绝"。
    const ok = await request('/dsh-redteam-results/prompt.library', { sessionId: 'sid', action: 'upsert', template: { id: 'tpl-1', title: '第二版', text: '改一下', expectedRevision: 1 } }, token);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(JSON.parse(ok.text).template.revision, 2);
  });

  await test('删除也走同一套 CAS：过期 revision 回 409', async () => {
    const stale = await request('/dsh-redteam-results/prompt.library', { sessionId: 'sid', action: 'delete', id: 'tpl-1', expectedRevision: 1 }, token);
    assert.equal(stale.status, 409, stale.text);
    assert.equal(JSON.parse(stale.text).code, 'prompt-template-conflict');
    const ok = await request('/dsh-redteam-results/prompt.library', { sessionId: 'sid', action: 'delete', id: 'tpl-1', expectedRevision: 2 }, token);
    assert.equal(ok.status, 200, ok.text);
  });

  await test('普通参数/业务错误仍然是 400，不会被误当成冲突', async () => {
    const bad = await request('/dsh-redteam-results/prompt.library', { sessionId: 'sid', action: '不存在动作' }, token);
    assert.equal(bad.status, 400, bad.text);
    const body = JSON.parse(bad.text);
    assert.equal(body.ok, false); assert.equal(body.code, undefined, '非冲突错误不该带冲突 code');
    const noSession = await request('/dsh-redteam-results/materials.list', { sessionId: '' }, token);
    assert.equal(noSession.status, 400, noSession.text);
  });

  await test('租约被别人持有也回 409（同一类"现状对不上"）', async () => {
    const { claimWork } = await import('../plugins/dsh-redteam-results/lib/work-lease.js');
    claimWork(store, 'task-1', { endpoint: 'https://app.example.test', question: 'q', identity: 'i', materialRevision: 'v1', worker: 'w1', ttlMs: 60000 });
    assert.throws(
      () => claimWork(store, 'task-1', { endpoint: 'https://app.example.test', question: 'q', identity: 'i', materialRevision: 'v1', worker: 'w2', ttlMs: 60000 }),
      error => error.code === 'work-lease-held');
  });

  // 统一返回（v6 第 9.3 节）：ok / error / requestId；错误含 code、具体 message、可恢复操作。
  await test('统一返回：成功也带 requestId，错误带 code/message/可恢复操作', async () => {
    const failed = await request('/dsh-redteam-results/knowledge.status', { sessionId: '' }, token);
    const failedBody = JSON.parse(failed.text);
    assert.equal(failedBody.ok, false, failed.text);
    assert(failedBody.error, '错误要有具体 message');
    assert(failedBody.hint, '错误要有可恢复操作');
    assert(/^rtr-/.test(failedBody.requestId || ''), '错误也带 requestId，实际 ' + failedBody.requestId);

    const created = await request('/dsh-redteam-results/prompt.library', { sessionId: 'sid2', action: 'upsert', template: { id: 'tpl-reqid', title: '带 requestId', text: '第一版' } }, token);
    const createdBody = JSON.parse(created.text);
    assert.equal(created.status, 200, created.text);
    assert(/^rtr-/.test(createdBody.requestId || ''), '成功也带 requestId');

    const stale = await request('/dsh-redteam-results/prompt.library', { sessionId: 'sid2', action: 'upsert', template: { id: 'tpl-reqid', title: '改', text: '第二版', expectedRevision: 99 } }, token);
    const staleBody = JSON.parse(stale.text);
    assert.equal(stale.status, 409, stale.text);
    assert(/刷新后重试/.test(staleBody.hint || ''), '冲突 hint 要指路，实际 ' + staleBody.hint);
    assert.notEqual(createdBody.requestId, staleBody.requestId, '每次请求的 requestId 唯一');
  });
} finally {
  for (const dispose of disposers.reverse()) { try { await dispose(); } catch { /* 已关或句柄失效 */ } }
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
