// 任务上下文快照的字段容错与报错质量（用例 J2 实测：模型用 target/路径，卡在一句含糊错误上）。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext, readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-task-context-schema-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results/results.db'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); } };

try {
  test('资产用 target 别名也能保存，并归一成 url', () => {
    const saved = saveTaskContext(store, 'alias', { assets: [{ id: 'a1', target: 'http://127.0.0.1:3000', note: 'l' }] });
    assert.equal(saved.assets[0].url, 'http://127.0.0.1:3000/');
    const read = readTaskContext(store, 'alias');
    assert.equal(read.assets[0].url, 'http://127.0.0.1:3000/');
  });
  test('请求入口写成路径时，报错说清要完整 URL 并给出例子', () => {
    assert.throws(
      () => saveTaskContext(store, 'path-endpoint', { assets: [{ id: 'a1', url: 'http://127.0.0.1:3000' }],
        requests: [{ id: 'r1', endpoint: '/rest/products/search', authContext: 'anon', revision: 'v1', request: 'GET / HTTP/1.1', response: 'HTTP/1.1 200 OK' }] }),
      error => /request\.endpoint 需要完整 HTTP\(S\) URL/.test(error.message) && /http:\/\/127\.0\.0\.1:3000/.test(error.message));
  });
  test('检查项入口写成路径时同样给出可执行报错', () => {
    assert.throws(
      () => saveTaskContext(store, 'path-check', { assets: [{ id: 'a1', url: 'http://127.0.0.1:3000' }],
        checks: [{ entryId: 'e1', endpoint: '/rest/products/search' }] }),
      error => /check\.endpoint 需要完整 HTTP\(S\) URL/.test(error.message));
  });
  test('完整 URL 仍然正常保存（没有为容错放宽契约）', () => {
    const saved = saveTaskContext(store, 'full-url', { assets: [{ id: 'a1', url: 'http://127.0.0.1:3000/rest/products/search' }] });
    assert.equal(saved.assets[0].url, 'http://127.0.0.1:3000/rest/products/search');
  });
  test('资产 origin 与任务 target 一致时自动算在范围内；范围外不自动标记；显式 false 不被覆盖', () => {
    startTaskPolicy(store, 'scope-derive', { mode: 'regular', target: 'http://127.0.0.1:3000', budget: { toolCalls: 5 } });
    const saved = saveTaskContext(store, 'scope-derive', { assets: [
      { id: 'in', url: 'http://127.0.0.1:3000/rest/products/search' },
      { id: 'out', url: 'http://127.0.0.1:9999/' },
      { id: 'explicit', url: 'http://127.0.0.1:3000/', inScope: false },
    ] });
    const byId = Object.fromEntries(saved.assets.map(item => [item.id, item]));
    assert.equal(byId.in.inScope, true, '与用户 target 同 origin 的资产默认在范围内');
    assert.equal(byId.out.inScope, false, '范围外资产显式标为不在范围（不自行扩大范围）');
    assert.equal(byId.explicit.inScope, false, '显式 false 不被覆盖');
  });
  test('标了 valid 但没有真实响应时，报错点名请求并给出三步顺序；不带 valid 可以先存', () => {
    startTaskPolicy(store, 'order-hint', { mode: 'regular', target: 'http://127.0.0.1:3000', budget: { toolCalls: 8 } });
    const base = { assets: [{ id: 'a1', url: 'http://127.0.0.1:3000', reachable: true }] };
    const row = { id: 'req-1', endpoint: 'http://127.0.0.1:3000/rest/products/search', authContext: 'anon', revision: 'r1',
      request: 'GET /rest/products/search?q=apple HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n\r\n' };
    // 未执行过就先别标 valid：这次保存必须成功（顺序里的第一步）
    const saved = saveTaskContext(store, 'order-hint', { ...base, requests: [row] });
    assert.equal(saved.requests[0].valid, undefined);
    assert.throws(() => saveTaskContext(store, 'order-hint', { ...base, requests: [{ ...row, valid: true }] }),
      error => /request req-1 标了 valid:true/.test(error.message) && /先用 redteam_execution run/.test(error.message));
  });
  test('只给 method/endpoint/headers/body 也能存：保存时自动拼出完整 HTTP/1.1 报文', () => {
    startTaskPolicy(store, 'compose-packet', { mode: 'regular', target: 'http://127.0.0.1:3000', budget: { toolCalls: 8 } });
    const saved = saveTaskContext(store, 'compose-packet', {
      assets: [{ id: 'a1', url: 'http://127.0.0.1:3000', reachable: true }],
      requests: [{ id: 'req-structured', endpoint: 'http://127.0.0.1:3000/rest/products/search?q=apple', authContext: 'anon', revision: 'r1',
        method: 'GET', headers: { Accept: 'application/json' } }],
    });
    const packet = saved.requests[0].request;
    assert.equal(packet.startsWith('GET /rest/products/search?q=apple HTTP/1.1\r\n'), true, packet);
    assert.equal(packet.includes('Host: 127.0.0.1:3000\r\n'), true, packet);
    assert.equal(packet.includes('Accept: application/json\r\n'), true, packet);
    assert.equal(packet.endsWith('\r\n\r\n'), true, packet);
  });
  test('HAR 数组 headers 也能拼进报文，Cookie/Authorization 不会被静默丢掉', () => {
    startTaskPolicy(store, 'compose-har-headers', { mode: 'regular', target: 'http://127.0.0.1:3000', budget: { toolCalls: 8 } });
    const saved = saveTaskContext(store, 'compose-har-headers', {
      assets: [{ id: 'a1', url: 'http://127.0.0.1:3000', reachable: true }],
      requests: [{ id: 'req-har-headers', endpoint: 'http://127.0.0.1:3000/rest/products/search?q=juice', authContext: 'subject', revision: 'r1',
        method: 'GET', headers: [{ name: 'Cookie', value: 'session=subject-e09' }, { name: 'Accept', value: 'application/json' }] }],
    });
    const packet = saved.requests[0].request;
    assert.equal(packet.includes('Cookie: session=subject-e09\r\n'), true, packet);
    assert.equal(packet.includes('Accept: application/json\r\n'), true, packet);
  });
  test('已确认的基线不会被后续整包保存静默降级（同 revision 显式降级按不可变规则拒绝）', () => {
    startTaskPolicy(store, 'keep-valid', { mode: 'regular', target: 'http://127.0.0.1:3000', budget: { toolCalls: 8 } });
    const row = { id: 'keep-1', endpoint: 'http://127.0.0.1:3000/rest/products/search?q=apple', authContext: 'anon', revision: 'r1',
      method: 'GET', request: 'GET /rest/products/search?q=apple HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n\r\n',
      response: 'HTTP/1.1 200 OK\r\n\r\n{"data":[]}', valid: true, kind: 'api', inputs: [{ name: 'q', location: 'query', evidenceIds: ['keep-1'] }] };
    saveTaskContext(store, 'keep-valid', { assets: [{ id: 'a1', url: 'http://127.0.0.1:3000', reachable: true }], requests: [row] });
    // 模型常见的"整包重写"：只带基础字段，不得把已确认的证据抹掉
    const again = saveTaskContext(store, 'keep-valid', { assets: [{ id: 'a1', url: 'http://127.0.0.1:3000', reachable: true }, { id: 'a2', url: 'http://127.0.0.1:3000/later', note: 'later' }],
      requests: [{ id: 'keep-1', endpoint: row.endpoint, authContext: 'anon', revision: 'r1', method: 'GET', request: row.request }] });
    assert.equal(again.requests[0].valid, true, 'valid 不应被静默抹掉');
    assert.equal(again.requests[0].response, row.response, '响应原文应保留');
    assert.equal(again.requests[0].kind, 'api');
    assert.deepEqual(again.requests[0].inputs, row.inputs);
    // 显式降级（同 revision 改内容）按既有不可变规则拒绝：要降级请开新 revision，别悄悄改历史
    assert.throws(() => saveTaskContext(store, 'keep-valid', { assets: [{ id: 'a1', url: 'http://127.0.0.1:3000', reachable: true }],
      requests: [{ id: 'keep-1', endpoint: row.endpoint, authContext: 'anon', revision: 'r1', method: 'GET', request: row.request, valid: false }] }),
      /immutable requests content changed/);
  });
} finally {
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
