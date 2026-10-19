// W01 / RR01 + RR02：证明归属必须绑定本次待提交的最终事实；fixed 不能与最新矛盾复测共存。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore, registerFinding, updateFinding, getFinding, listFindings, computeStats } from '../plugins/dsh-redteam-results/lib/store.js';
import { readTaskContext, saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { executeRecordedRequest } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { listRetests } from '../plugins/dsh-redteam-results/lib/retest.js';
import { buildDeliveryFiles } from '../plugins/dsh-redteam-results/lib/bundle.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-finding-consistency-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const disposers = [];
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('fixture-ok');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const endpointA = origin + '/api/object';
const endpointB = origin + '/api/other';
const host = new URL(endpointA).host;
const packet = (pathname, mode) => 'GET ' + pathname + '?mode=' + mode + ' HTTP/1.1\r\nHost: ' + host + '\r\n\r\n';
const fixtureMethod = { id: 'fixture-method', version: 'v1', reviewed: true, definition: 'Fixture comparison only' };
const review = { secondRating: 'high', secondRatingNote: '复核方式：独立读取实际响应核对当前身份与目标，本地受控示例的返回已确认，与保存的记录相符。' };

async function pair(sid, { pathname = '/api/object', authContext = 'fixture-user' } = {}) {
  const endpoint = origin + pathname;
  const rows = ['target', 'control'].map(rowId => ({
    id: rowId, revision: 'v1', endpoint, authContext, kind: 'api', valid: true,
    request: packet(pathname, rowId), response: 'HTTP/1.1 200 OK\r\n\r\nold baseline',
    inputs: [{ name: 'mode', location: 'query', evidenceIds: [rowId] }],
  }));
  startTaskPolicy(store, sid, { mode: 'regular', budget: { toolCalls: 40 } });
  saveTaskContext(store, sid, { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: rows, methods: [fixtureMethod] });
  createResearch(store, sid, {
    id: 'direction', requestId: 'target', requestRevision: 'v1', controlledInputs: [{ name: 'mode', location: 'query' }],
    title: 'Fixture', serverPath: 'Local fixture', boundary: 'Synthetic', normalBehavior: 'Fixture response',
    supportCriterion: 'Fixture', falsifier: 'Fixture', nextInformation: 'Fixture',
    knownCheck: { outcome: 'not-assessed', rationale: 'fixture', sources: [] },
  });
  const run = async rowId => (await executeRecordedRequest(store, sid, {
    hypothesisId: 'direction', requestId: rowId, requestRevision: 'v1',
    methodId: fixtureMethod.id, methodVersion: fixtureMethod.version, timeoutMs: 500,
  })).id;
  return { executionId: await run('target'), controlId: await run('control') };
}

const tools = new Map();
const { apply } = await import('../plugins/dsh-redteam-results/lib/index.js');
apply({
  tools: { register: tool => tools.set(tool.name, tool), guard: () => {} },
  webServer: { register: () => () => {} },
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
});
const tool = tools.get('redteam_finding_update');
assert(tool, 'redteam_finding_update registered');
const exec = sid => ({ agent: { session: { id: sid, header: { agentPreset: 'pentest' } } } });

function verifiedFinding(sid, { target = endpointA, identity = 'fixture-user', title = 'fixture' } = {}) {
  const finding = registerFinding(store, sid, 'pentest', { title, severity: 'high', target, identity, summary: 'fixture' });
  updateFinding(store, sid, 'pentest', finding.id, { status: 'verified', ...review });
  return finding;
}

const seedRetest = (sid, finding, executionId, controlId, note = 'A 目标本次未复现，正常功能对照可用') => tool.execute({
  id: finding.id, retestVerdict: 'not-reproduced', retestNote: note,
  retestExecutionId: executionId, retestControlExecutionId: controlId,
}, exec(sid));

const reproductionAt = (endpoint, executionId, controlId) => JSON.stringify({
  kind: 'method', methodId: fixtureMethod.id, methodVersion: 'v1', endpoint,
  mechanism: 'fixture', prerequisites: [], dependencies: [], parameters: [],
  steps: ['Open the fixture object'], successCriterion: 'Fixture response',
  reviewSteps: 'Read the fixture response', recovery: 'Read-only fixture',
  verification: { status: 'verified', evidenceIds: [executionId, controlId], controlReceiptId: controlId, probeReceiptId: executionId },
});

try {
  await test('RR01 同次改目标并标记 fixed 被拒绝，目标/状态/复测留档整次回滚', async () => {
    const sid = 'rr01-target';
    const { executionId, controlId } = await pair(sid);
    const finding = verifiedFinding(sid);
    const seeded = await seedRetest(sid, finding, executionId, controlId);
    assert.equal(seeded.ok, true, seeded.error);
    const before = listRetests(store, sid, finding.id).length;
    const bad = await tool.execute({
      id: finding.id, status: 'fixed', target: endpointB,
      retestVerdict: 'not-reproduced', retestNote: 'B 目标本次未复现',
      retestExecutionId: executionId, retestControlExecutionId: controlId,
    }, exec(sid));
    assert.equal(bad.ok, false, '同次换目标不能沿用 A 的证明');
    assert.match(String(bad.error), /目标实例|均未生效/);
    const after = getFinding(store, sid, finding.id);
    assert.equal(after.status, 'verified');
    assert.equal(after.target, endpointA);
    assert.equal(listRetests(store, sid, finding.id).length, before, '失败调用不能留下新复测记录');
  });

  await test('RR01 同次改复现路径并标记 fixed 被拒绝', async () => {
    const sid = 'rr01-path';
    const { executionId, controlId } = await pair(sid);
    const finding = verifiedFinding(sid);
    const seeded = await seedRetest(sid, finding, executionId, controlId);
    assert.equal(seeded.ok, true, seeded.error);
    const before = listRetests(store, sid, finding.id).length;
    const bad = await tool.execute({
      id: finding.id, status: 'fixed', reproduction: reproductionAt(endpointB, executionId, controlId),
      retestVerdict: 'not-reproduced', retestNote: '换了路径但沿用旧回执',
      retestExecutionId: executionId, retestControlExecutionId: controlId,
    }, exec(sid));
    assert.equal(bad.ok, false, '路径变化不能沿用旧路径证明');
    assert.match(String(bad.error), /路径|均未生效/);
    assert.equal(listRetests(store, sid, finding.id).length, before);
  });

  await test('RR01 同次改身份并标记 fixed 被拒绝', async () => {
    const sid = 'rr01-identity';
    const { executionId, controlId } = await pair(sid);
    const finding = verifiedFinding(sid);
    const seeded = await seedRetest(sid, finding, executionId, controlId);
    assert.equal(seeded.ok, true, seeded.error);
    const before = listRetests(store, sid, finding.id).length;
    const bad = await tool.execute({
      id: finding.id, status: 'fixed', identity: 'other-user',
      retestVerdict: 'not-reproduced', retestNote: '换了身份但沿用旧回执',
      retestExecutionId: executionId, retestControlExecutionId: controlId,
    }, exec(sid));
    assert.equal(bad.ok, false, '身份变化不能沿用旧身份证明');
    assert.match(String(bad.error), /身份|均未生效/);
    assert.equal(listRetests(store, sid, finding.id).length, before);
  });

  await test('RR01 请求修订变化后旧回执不能支撑 fixed', async () => {
    const sid = 'rr01-revision';
    const { executionId, controlId } = await pair(sid);
    const finding = verifiedFinding(sid);
    const seeded = await seedRetest(sid, finding, executionId, controlId);
    assert.equal(seeded.ok, true, seeded.error);
    const context = readTaskContext(store, sid);
    context.requests = context.requests.map(row => row.id === 'target' ? { ...row, revision: 'v2' } : row);
    saveTaskContext(store, sid, context);
    const before = listRetests(store, sid, finding.id).length;
    const bad = await tool.execute({
      id: finding.id, status: 'fixed',
      retestVerdict: 'not-reproduced', retestNote: '请求修订已变化',
      retestExecutionId: executionId, retestControlExecutionId: controlId,
    }, exec(sid));
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /不匹配|失效|均未生效/);
    assert.equal(getFinding(store, sid, finding.id).status, 'verified');
    assert.equal(listRetests(store, sid, finding.id).length, before);
  });

  await test('RR01 纯标题/描述编辑不无故作废既有结果', async () => {
    const sid = 'rr01-edit';
    const { executionId, controlId } = await pair(sid);
    const finding = verifiedFinding(sid);
    const seeded = await seedRetest(sid, finding, executionId, controlId);
    assert.equal(seeded.ok, true, seeded.error);
    const edited = await tool.execute({ id: finding.id, title: '新标题', description: '补充描述' }, exec(sid));
    assert.equal(edited.ok, true, edited.error);
    const after = getFinding(store, sid, finding.id);
    assert.equal(after.title, '新标题');
    assert.equal(after.target, endpointA);
    assert.equal(after.status, 'verified');
    assert.equal(listRetests(store, sid, finding.id).length, 1);
  });

  await test('RR02 fixed 后追加 inconclusive 被拒绝，历史 not-reproduced 不被覆盖', async () => {
    const sid = 'rr02-inconclusive';
    const { executionId, controlId } = await pair(sid);
    const finding = verifiedFinding(sid);
    const fixed = await tool.execute({
      id: finding.id, status: 'fixed',
      retestVerdict: 'not-reproduced', retestNote: '正常功能有效，目标未复现',
      retestExecutionId: executionId, retestControlExecutionId: controlId,
    }, exec(sid));
    assert.equal(fixed.ok, true, fixed.error);
    assert.equal(getFinding(store, sid, finding.id).status, 'fixed');
    const before = listRetests(store, sid, finding.id);
    const bad = await tool.execute({ id: finding.id, status: 'fixed', retestVerdict: 'inconclusive', retestNote: '接口迁移，无法确认' }, exec(sid));
    assert.equal(bad.ok, false, '最新无法确认不能与当前 fixed 共存');
    assert.match(String(bad.error), /本次未复现|均未生效/);
    assert.equal(getFinding(store, sid, finding.id).status, 'fixed');
    const after = listRetests(store, sid, finding.id);
    assert.equal(after.length, before.length, '矛盾复测不能留下记录');
    assert.equal(after[0].verdict, 'not-reproduced', '最新仍是原 not-reproduced');
  });

  await test('RR02 verified 状态下 still-reproducible / inconclusive 不能标 fixed，not-reproduced 可以', async () => {
    const cases = [
      { sid: 'rr02-verified-still', verdict: 'still-reproducible', ok: false, execution: true },
      { sid: 'rr02-verified-inconclusive', verdict: 'inconclusive', ok: false, execution: false },
      { sid: 'rr02-verified-notrepro', verdict: 'not-reproduced', ok: true, execution: true },
    ];
    for (const item of cases) {
      const { executionId, controlId } = await pair(item.sid);
      const finding = verifiedFinding(item.sid);
      const out = await tool.execute({
        id: finding.id, status: 'fixed', retestVerdict: item.verdict, retestNote: '组合检查：' + item.verdict,
        ...(item.execution ? { retestExecutionId: executionId, retestControlExecutionId: controlId } : {}),
      }, exec(item.sid));
      assert.equal(out.ok, item.ok, item.sid + ': ' + (out.error || 'unexpected success'));
      const after = getFinding(store, item.sid, finding.id);
      assert.equal(after.status, item.ok ? 'fixed' : 'verified', item.sid + ' status');
      assert.equal(listRetests(store, item.sid, finding.id).length, item.ok ? 1 : 0, item.sid + ' history');
    }
  });

  await test('拒绝后工具、列表、详情、统计与导出读取同一事实', async () => {
    const sid = 'rr02-consistency';
    const { executionId, controlId } = await pair(sid);
    const finding = verifiedFinding(sid);
    const fixed = await tool.execute({
      id: finding.id, status: 'fixed', retestVerdict: 'not-reproduced', retestNote: '正常功能有效，目标未复现',
      retestExecutionId: executionId, retestControlExecutionId: controlId,
    }, exec(sid));
    assert.equal(fixed.ok, true, fixed.error);
    const bad = await tool.execute({ id: finding.id, status: 'fixed', retestVerdict: 'inconclusive', retestNote: '无法确认' }, exec(sid));
    assert.equal(bad.ok, false);
    const detail = getFinding(store, sid, finding.id);
    const list = listFindings(store, sid, 'pentest', { pageSize: 50 });
    const row = list.rows.find(item => item.id === finding.id);
    const stats = computeStats(store, sid, 'pentest');
    const delivery = buildDeliveryFiles([detail], []);
    assert.equal(detail.status, 'fixed');
    assert.equal(row.status, 'fixed');
    assert.equal(listRetests(store, sid, finding.id)[0].verdict, 'not-reproduced');
    assert.equal(delivery.confirmedFindings, 0, 'fixed 不是可交付确认漏洞');
    assert(stats && typeof stats === 'object');
  });
} finally {
  for (const dispose of disposers.reverse()) { try { await dispose(); } catch { /* 已关闭 */ } }
  await new Promise(resolve => server.close(resolve));
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
