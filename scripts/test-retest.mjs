// 复测记录（v6 第 9.2 节）：新建版本记录、引用原发现与本次 execution、三结论；
// 登录失败/不可达/服务端错误只能记「无法确认」，不能拿"没打中"冒充"已修复"。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore, registerFinding, updateFinding, getFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { readTaskContext, saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { executeRecordedRequest } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { stageMethodClassification } from '../plugins/dsh-redteam-results/lib/method-classification.js';
import { recordRetest, listRetests, RETEST_LABELS, markVerifyStarted } from '../plugins/dsh-redteam-results/lib/retest.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-retest-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const disposers = [];
let failed = 0, updateTool, updateExec;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const server = http.createServer((req, res) => {
  const mode = new URL(req.url, 'http://fixture.test').searchParams.get('mode');
  if (mode === 'hang') return; // 永不响应 → timeout
  if (mode === 'error') { res.writeHead(500); res.end('server error'); return; }
  if (['401', '403', '404', '407', '429'].includes(mode)) { res.writeHead(Number(mode)); res.end('not checked'); return; }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/object';
const host = new URL(endpoint).host;
const packet = (mode) => 'GET /api/object?mode=' + mode + ' HTTP/1.1\r\nHost: ' + host + '\r\n\r\n';
const fixtureMethod = { id: 'fixture-method', version: 'v1', reviewed: true, definition: 'Normal fixture response comparison only' };

const preparedSessions = new Set();
async function receipt(sid, mode, rowId = 'probe') {
  const request = { id: rowId, revision: 'v1', endpoint, authContext: 'fixture-user', kind: 'api', valid: true,
    request: packet(mode), response: 'HTTP/1.1 200 OK\r\n\r\nold baseline', inputs: [{ name: 'mode', location: 'query', evidenceIds: [rowId] }] };
  if (!preparedSessions.has(sid)) {
    startTaskPolicy(store, sid, { mode: 'regular', target: endpoint, budget: { toolCalls: 20 } });
    saveTaskContext(store, sid, { assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }], requests: [request], methods: [fixtureMethod] });
    createResearch(store, sid, { id: 'direction', requestId: rowId, requestRevision: 'v1', controlledInputs: [{ name: 'mode', location: 'query' }],
      title: 'Fixture retest', serverPath: 'Local fixture', boundary: 'Synthetic', normalBehavior: 'Fixture own response',
      supportCriterion: 'Fixture', falsifier: 'Fixture', nextInformation: 'Fixture',
      knownCheck: { outcome: 'not-assessed', rationale: 'fixture', sources: [] } });
    preparedSessions.add(sid);
  } else {
    const context = readTaskContext(store, sid) || {};
    context.requests = [...(context.requests || []).filter(row => row.id !== rowId), request];
    saveTaskContext(store, sid, context);
  }
  return (await executeRecordedRequest(store, sid, { hypothesisId: 'direction', requestId: rowId, requestRevision: 'v1',
    methodId: fixtureMethod.id, methodVersion: fixtureMethod.version, timeoutMs: 300 })).id;
}

try {
  stageMethodClassification(store, { schema: 'saker.method-classification/1', id: fixtureMethod.id, version: fixtureMethod.version,
    digest: 'e'.repeat(64), revision: 1, modules: ['exploit/access-control'], status: 'verified',
    source: { kind: 'manual', version: fixtureMethod.version, position: 'test-retest fixture' } });
  const finding = registerFinding(store, 'ok-session', 'pentest', { title: '复测用例', severity: 'high', target: endpoint, summary: 'fixture' });
  const okReceipt = await receipt('ok-session', 'ok');
  const okControl = await receipt('ok-session', 'control', 'control');
  const errorReceipt = await receipt('error-session', 'error');
  const errorControl = await receipt('error-session', 'control', 'control');
  const hangReceipt = await receipt('hang-session', 'hang');
  const hangControl = await receipt('hang-session', 'control', 'control');
  registerFinding(store, 'error-session', 'pentest', { title: '服务端错误用例', severity: 'high', target: endpoint, summary: 'fixture' });
  registerFinding(store, 'hang-session', 'pentest', { title: '不可达用例', severity: 'high', target: endpoint, summary: 'fixture' });

  await test('三结论词表固定，未知结论被拒', () => {
    assert.deepEqual(Object.keys(RETEST_LABELS), ['still-reproducible', 'not-reproduced', 'inconclusive']);
    assert.throws(() => recordRetest(store, 'ok-session', { findingId: finding.id, verdict: 'fixed', note: 'x' }), /只能/);
  });

  await test('仍可复现必须引用本次执行回执', () => {
    assert.throws(() => recordRetest(store, 'ok-session', { findingId: finding.id, verdict: 'still-reproducible', note: '没有回执' }), /必须引用/);
    const recorded = recordRetest(store, 'ok-session', { findingId: finding.id, verdict: 'still-reproducible', note: '同样的请求仍然复现', executionId: okReceipt });
    assert.equal(recorded.verdict, 'still-reproducible'); assert.equal(recorded.verdictLabel, '仍可复现');
    assert.equal(recorded.executionId, okReceipt); assert.equal(recorded.executionOutcome, 'response');
  });

  await test('本次未复现要求真实响应；超时/服务端错误只能记无法确认', () => {
    assert.throws(() => recordRetest(store, 'ok-session', { findingId: finding.id, verdict: 'not-reproduced', note: '没有正常功能对照', executionId: okReceipt }), /正常功能对照/);
    const recorded = recordRetest(store, 'ok-session', { findingId: finding.id, verdict: 'not-reproduced', note: '同样的请求这次没有复现，正常功能对照仍然可用', executionId: okReceipt, controlExecutionId: okControl });
    assert.equal(recorded.verdictLabel, '本次未复现');
    assert.equal(recorded.controlExecutionId, okControl);
    assert.throws(() => recordRetest(store, 'hang-session', { findingId: 'pentest-1', verdict: 'not-reproduced', note: '超时了', executionId: hangReceipt, controlExecutionId: hangControl }), /只能记无法确认/);
    assert.throws(() => recordRetest(store, 'error-session', { findingId: 'pentest-1', verdict: 'not-reproduced', note: '500', executionId: errorReceipt, controlExecutionId: errorControl }), /服务端错误|只能记无法确认/);
  });

  await test('无法确认不需要执行回执，但要写明原因；历史按新→旧累积，不覆盖原发现', () => {
    recordRetest(store, 'ok-session', { findingId: finding.id, verdict: 'inconclusive', note: '登录失败，无法确认是否已修复' });
    const history = listRetests(store, 'ok-session', finding.id);
    assert.equal(history.length, 3, '三次复测各自留档');
    assert.equal(history[0].verdict, 'inconclusive', '最新在前');
    assert.equal(history.at(-1).verdict, 'still-reproducible', '最旧在后');
    // 原发现本身没有被改写。
    const row = store.db.prepare('SELECT status, retest_note FROM findings WHERE session_id=? AND id=?').get('ok-session', finding.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.retest_note, '', '结构化复测不往自由文本里写');
  });

  await test('复测只能针对本会话已有的发现，也不能引用别的会话的回执', () => {
    assert.throws(() => recordRetest(store, 'ok-session', { findingId: 'nope', verdict: 'inconclusive', note: 'x' }), /本会话已有/);
    assert.throws(() => recordRetest(store, 'ok-session', { findingId: finding.id, verdict: 'still-reproducible', note: 'x', executionId: errorReceipt }), /不属于本会话/);
  });

  // 第 9.2 节：可达且正常功能有效、修复条件明确并完成相应检查才提出"已修复"建议。
  await test('标记已修复必须有「本次未复现」的复测记录，不能只凭 verified', () => {
    const review = { secondRating: 'high', secondRatingNote: '复核方式：换观测通道重新触发一次，结果与原始观察一致；入口、身份与影响链都闭环，未见替代解释。' };
    assert.equal(updateFinding(store, 'ok-session', 'pentest', finding.id, { status: 'verified', ...review }).status, 'verified');
    // 较早未复现不能覆盖最新无法确认；重新完成复测才能标记。
    assert.throws(() => updateFinding(store, 'ok-session', 'pentest', finding.id, { status: 'fixed' }), /fixed 需要最新/);
    recordRetest(store, 'ok-session', { findingId: finding.id, verdict: 'not-reproduced', note: '重新验证：正常功能有效，当前请求没有复现', executionId: okReceipt, controlExecutionId: okControl });
    assert.equal(updateFinding(store, 'ok-session', 'pentest', finding.id, { status: 'fixed' }).status, 'fixed');
    // 另一个只有 verified、没有任何复测记录的发现 → 拒绝
    const bare = registerFinding(store, 'bare-session', 'pentest', { title: '没有复测记录', severity: 'high', target: endpoint, summary: 'fixture' });
    updateFinding(store, 'bare-session', 'pentest', bare.id, { status: 'verified', ...review });
    assert.throws(() => updateFinding(store, 'bare-session', 'pentest', bare.id, { status: 'fixed' }), /本次未复现/);
    assert.throws(() => updateFinding(store, 'bare-session', 'pentest', bare.id, { status: 'fixed' }), /无法确认/);
  });

  await test('RPC 记录/读取复测，列表行带复测摘要', async () => {
    const { dispatch } = await import('../plugins/dsh-redteam-results/lib/index.js');
    const recorded = await dispatch(null, store, 'finding.retest', { sessionId: 'ok-session', action: 'record', findingId: finding.id, verdict: 'inconclusive', note: 'RPC 记录一次' });
    assert.equal(recorded.ok, true); assert.equal(recorded.retest.verdict, 'inconclusive');
    const listed = await dispatch(null, store, 'finding.retest', { sessionId: 'ok-session', action: 'list', id: finding.id });
    assert.equal(listed.ok, true); assert.equal(listed.retests.length, 5);
    const list = await dispatch(null, store, 'findings.list', { sessionId: 'ok-session', mode: 'pentest' });
    const row = list.list.rows.find(r => r.id === finding.id);
    assert.equal(row.retest.count, 5);
    assert.equal(row.retest.latest.verdictLabel, '无法确认');
  });

  await test('redteam_finding_update 带 retestVerdict 时同时留一条复测版本记录', async () => {
    const tools = new Map();
    const { apply } = await import('../plugins/dsh-redteam-results/lib/index.js');
    apply({ tools: { register: tool => tools.set(tool.name, tool), guard: () => {} },
      webServer: { register: () => () => {} }, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); } });
    const exec = { agent: { session: { id: 'ok-session', header: { agentPreset: 'pentest' } } } };
    const tool = tools.get('redteam_finding_update');
    assert(tool, '更新工具已注册');
    updateTool = tool; updateExec = exec;
    const out = await tool.execute({ id: finding.id, retestVerdict: 'inconclusive', retestNote: '接口已迁移，无法确认是否仍存在' }, exec);
    assert.equal(out.ok, true, out.error);
    assert.equal(out.retest.verdict, 'inconclusive');
    assert.equal(listRetests(store, 'ok-session', finding.id)[0].verdict, 'inconclusive');
    // 缺依据时不写复测记录，且给出可操作的说明。
    const bad = await tool.execute({ id: finding.id, retestVerdict: 'still-reproducible' }, exec);
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /均未生效/);
  });

  await test('复测拒绝旧轮次、不完整及已改变请求的回执，但时间经过不单独作废', async () => {
    const sid = 'freshness-session';
    const f = registerFinding(store, sid, 'pentest', { title: '回执时效', severity: 'high', target: endpoint, summary: 'fixture' });
    const executionId = await receipt(sid, 'ok');
    const saved = store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?').get(sid, executionId);
    const original = JSON.parse(saved.record);
    const record = () => recordRetest(store, sid, { findingId: f.id, verdict: 'still-reproducible', note: '本次复测', executionId });
    const replace = value => store.db.prepare('UPDATE execution_receipts SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(value), sid, executionId);
    replace({ ...original, completedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() });
    assert.equal(record().verdict, 'still-reproducible', '时间经过不单独作废未变化的正常回执');
    store.db.prepare('DELETE FROM finding_retests WHERE session_id=?').run(sid);
    replace(original);
    replace({ ...original, complete: false });
    assert.throws(record, /不完整/);
    replace(original);
    const policy = JSON.parse(store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(sid).record);
    store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify({ ...policy, startedAt: Date.parse(original.startedAt) + 1 }), sid);
    assert.throws(record, /本轮|本次/);
    store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify(policy), sid);
    saveTaskContext(store, sid, { requests: [{ id: 'probe', revision: 'v2', endpoint, authContext: 'different-account', method: 'GET' }] });
    assert.throws(record, /当前|匹配|失效/);
    assert.equal(listRetests(store, sid, f.id).length, 0);
  });

  await test('登录失效和限流不能登记为本次未复现；有正常功能对照的 403/404 可以', async () => {
    for (const status of ['401', '407', '429']) {
      const sid = 'status-' + status;
      const f = registerFinding(store, sid, 'pentest', { title: '状态 ' + status, severity: 'high', target: endpoint, summary: 'fixture' });
      const controlId = await receipt(sid, 'control', 'control');
      const executionId = await receipt(sid, status);
      assert.throws(() => recordRetest(store, sid, { findingId: f.id, verdict: 'not-reproduced', note: '未复现', executionId, controlExecutionId: controlId }), /只能记无法确认/);
      assert.equal(listRetests(store, sid, f.id).length, 0);
    }
    for (const status of ['403', '404']) {
      const sid = 'status-' + status;
      const f = registerFinding(store, sid, 'pentest', { title: '状态 ' + status, severity: 'high', target: endpoint, summary: 'fixture' });
      const controlId = await receipt(sid, 'control', 'control');
      const executionId = await receipt(sid, status);
      assert.throws(() => recordRetest(store, sid, { findingId: f.id, verdict: 'not-reproduced', note: '缺少对照', executionId }), /正常功能对照/);
      const recorded = recordRetest(store, sid, { findingId: f.id, verdict: 'not-reproduced', note: '正常功能可用，目标边界按修复要求拒绝', executionId, controlExecutionId: controlId });
      assert.equal(recorded.verdict, 'not-reproduced');
      assert.equal(recorded.controlExecutionId, controlId);
    }
  });

  await test('标记已修复时时间经过不单独作废，但本次复测起点仍校验', async () => {
    const sid = 'fixed-freshness';
    const f = registerFinding(store, sid, 'pentest', { title: '修复时效', severity: 'high', target: endpoint, summary: 'fixture' });
    const executionId = await receipt(sid, 'ok');
    const controlId = await receipt(sid, 'control', 'control');
    const review = { secondRating: 'high', secondRatingNote: '复核方式：独立读取实际响应核对当前身份与目标，本地受控示例的返回已确认，与保存的记录相符。' };
    updateFinding(store, sid, 'pentest', f.id, { status: 'verified', ...review });
    recordRetest(store, sid, { findingId: f.id, verdict: 'not-reproduced', note: '本次正常功能有效，未复现', executionId, controlExecutionId: controlId });
    const saved = JSON.parse(store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?').get(sid, executionId).record);
    store.db.prepare('UPDATE execution_receipts SET record=? WHERE session_id=? AND id=?')
      .run(JSON.stringify({ ...saved, completedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() }), sid, executionId);
    assert.doesNotThrow(() => updateFinding(store, sid, 'pentest', f.id, { status: 'fixed' }), '时间经过不单独撤销未变化的本次未复现');
    const f2 = registerFinding(store, sid, 'pentest', { title: '修复起点', severity: 'high', target: endpoint, summary: 'fixture-2' });
    updateFinding(store, sid, 'pentest', f2.id, { status: 'verified', ...review });
    recordRetest(store, sid, { findingId: f2.id, verdict: 'not-reproduced', note: '本次正常功能有效，未复现', executionId, controlExecutionId: controlId });
    const saved2 = JSON.parse(store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?').get(sid, executionId).record);
    markVerifyStarted(store, sid, f2.id, Date.parse(saved2.startedAt) + 1);
    assert.throws(() => updateFinding(store, sid, 'pentest', f2.id, { status: 'fixed' }), /本次复测/);
    assert.throws(() => recordRetest(store, sid, { findingId: f2.id, verdict: 'still-reproducible', note: '重复使用旧请求', executionId }), /本次复测/);
  });

  await test('finding_update 的字段更新与复测留档同生共死，fixed 依据本次新结论', async () => {
    const sid = 'atomic-session';
    const exec = { agent: { session: { id: sid, header: { agentPreset: 'pentest' } } } };
    const review = { secondRating: 'high', secondRatingNote: '复核方式：独立读取实际响应核对当前身份与目标，本地受控示例的返回已确认，与保存的记录相符。' };
    const f = registerFinding(store, sid, 'pentest', { title: '事务原子性', severity: 'high', target: endpoint, summary: 'fixture' });
    updateFinding(store, sid, 'pentest', f.id, { status: 'verified', ...review });
    // 有效复测（inconclusive 无需回执）+ 非法 fixed：复测留档必须随字段更新失败一起回滚。
    const failed = await updateTool.execute({ id: f.id, status: 'fixed', retestVerdict: 'inconclusive', retestNote: '接口迁移，无法确认' }, exec);
    assert.equal(failed.ok, false, JSON.stringify(failed));
    assert.match(String(failed.error), /均未生效/);
    assert.equal(getFinding(store, sid, f.id).status, 'verified');
    assert.equal(listRetests(store, sid, f.id).length, 0, '复测留档不能先于失败的字段更新留下半状态');
    // 本次 not-reproduced + fixed 同一次提交：fixed 必须依据本次新结论，而不是旧记录。
    const executionId = await receipt(sid, 'ok');
    const controlId = await receipt(sid, 'control', 'control');
    const done = await updateTool.execute({ id: f.id, status: 'fixed', retestVerdict: 'not-reproduced',
      retestNote: '本次正常功能有效，目标请求未复现', retestExecutionId: executionId, retestControlExecutionId: controlId }, exec);
    assert.equal(done.ok, true, done.error);
    assert.equal(getFinding(store, sid, f.id).status, 'fixed');
    const history = listRetests(store, sid, f.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].verdict, 'not-reproduced');
    assert.equal(history[0].controlExecutionId, controlId);
  });

  await test('复测留档时间由服务器决定，请求体不能伪造最新顺序', () => {
    const sid = 'time-authority';
    const f = registerFinding(store, sid, 'pentest', { title: '时间权威', severity: 'high', target: endpoint, summary: 'fixture' });
    const before = Date.now();
    const forged = recordRetest(store, sid, { findingId: f.id, verdict: 'inconclusive', note: '请求体试图把时间改到 1970', now: 0 });
    assert(Date.parse(forged.at) >= before - 1000, '留档时间不能被请求体覆盖');
    assert.equal(listRetests(store, sid, f.id)[0].at, forged.at);
  });
} finally {
  for (const dispose of disposers.reverse()) { try { await dispose(); } catch { /* 已关或句柄失效 */ } }
  await new Promise(resolve => server.close(resolve));
  store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
