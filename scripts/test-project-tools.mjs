// W06：模型侧项目工具（project_document / project_check / project_request / saker_browser）。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore, registerFinding, updateFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, taskPolicyStatus, readTaskPolicy, finishTaskOnTurnEnd, setTaskActionLimits } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, upsertProjectSource, readProjectRun, readProjectCheck, listProjectChecks, listProjectActions, recordProjectCheck, reopenProjectCheck, beginProjectAction, finishProjectAction, reconcileProjectAction } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { buildProjectDeliveryFiles } from '../plugins/dsh-redteam-results/lib/project-delivery.js';
import { projectTurnDecision, completeProjectRun, captureProjectNativeEvent } from '../plugins/dsh-redteam-results/lib/project-runtime.js';
import { projectSourceProgress } from '../plugins/dsh-redteam-results/lib/project-progress.js';
import { browserProfileName } from '../plugins/dsh-redteam-results/lib/browser-session.js';
import { registerVerifiedProjectFinding } from './lib/project-test-fixtures.mjs';
import { createCompetitionChallenge, setCurrentCompetitionChallenge } from '../plugins/dsh-redteam-results/lib/competition-store.js';
import { setCompetitionPreferences, writeSceneContext } from '../plugins/dsh-redteam-results/lib/scene-context.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-tools-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const disposers = [];
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
const browserUnsafePorts = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
async function listenOnBrowserSafePort(server) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    if (!browserUnsafePorts.has(server.address().port)) return;
    await new Promise(resolve => server.close(resolve));
  }
  throw new Error('could not allocate a browser-safe fixture port');
}

const server = http.createServer((request, response) => {
  if (request.url === '/page') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Saker Takeover</title></head><body>'
      + '<h1 id="title">等待操作</h1><button id="go" onclick="document.getElementById(\'title\').textContent=\'人工已操作\';fetch(\'/human-action\').catch(function(){})">人工操作</button>'
      + '</body></html>');
    return;
  }
  if (request.url === '/human-action') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, marker: 'SAKER_HUMAN_ACTION' }));
    return;
  }
  if (request.url === '/download-page') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<a id="download" href="/download.bin">download</a>');
    return;
  }
  if (request.url === '/download.bin') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="tool-proof.bin"' });
    response.end('SAKER_TOOL_DOWNLOAD');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, marker: 'SAKER_PROJECT_TOOL' }));
});
await listenOnBrowserSafePort(server);
const origin = 'http://127.0.0.1:' + server.address().port;
const secondServer = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><head><title>Saker Second Origin</title></head><body><h1>second origin</h1></body></html>');
});
await listenOnBrowserSafePort(secondServer);
const secondOrigin = 'http://127.0.0.1:' + secondServer.address().port;

const tools = new Map();
const guards = [];
const contexts = [];
const events = new Map();
const followups = [];
const failedFollowups = new Set();
const agentFor = id => ({ status: 'idle', followup: message => {
  if (failedFollowups.has(id)) throw new Error('受控宿主投递失败');
  followups.push({ id, message });
}, cancel: () => {} });
const ctx = {
  tools: { register: tool => tools.set(tool.name, tool), guard: guard => guards.push(guard) },
  systemPrompt: { section: () => {}, context: context => contexts.push(context) },
  webServer: { register: () => () => {} },
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  sessions: { get: id => ({ id, header: { agentPreset: 'pentest' } }) },
  agents: { get: agentFor },
  on: (name, handler) => events.set(name, [...(events.get(name) || []), handler]),
  get: () => null,
};
const { apply, dispatch } = await import('../plugins/dsh-redteam-results/lib/index.js');
apply(ctx);
const exec = sid => ({ agent: { session: { id: sid, header: { agentPreset: 'pentest', cwd: home } } } });
async function invoke(sid, name, args) {
  const scope = { ...exec(sid), name, arguments: args };
  for (const guard of guards) {
    const denied = await guard(scope);
    assert.equal(denied, undefined, name + ': ' + denied);
  }
  const result = await tools.get(name).execute(args, scope);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, name + ' must return lossless JSON for the real host');
  return result;
}

async function clickInManagedBrowser(sessionId, selector) {
  const profileDir = path.join(home, 'project-browser', browserProfileName(sessionId, ''));
  const activePort = path.join(profileDir, 'DevToolsActivePort');
  const [port] = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const target = targets.find(item => item.type === 'page' && String(item.url).startsWith(origin));
  assert(target, '必须能取得当前受管浏览器页面');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    const located = await call('Runtime.evaluate', {
      expression: '(function(){var e=document.querySelector(' + JSON.stringify(selector) + ');if(!e)return null;var r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
      returnByValue: true,
    });
    const point = located.result?.value;
    assert(point, '人工操作元素必须存在');
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await call('Input.dispatchMouseEvent', {
        type, x: point.x, y: point.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
      });
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  } finally {
    socket.close();
  }
}

function prepareProject(sid, budget = { minutes: 30 }) {
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试', target: origin, budget });
  const run = createProjectRun(store, sid, { question: '按文档测试' });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  const [check] = defineProjectChecks(store, sid, run.runId, [{ requirement: '检查员工资料权限', sourceLocation: '表1 第2行' }]);
  upsertProjectSource(store, sid, {
    sourceId: 'doc-1', sourceRevision: 'rev-1', displayName: '测试要求.docx', kind: 'docx', parseState: 'ready',
    sections: [{ sectionId: 'p1', location: { kind: 'paragraph', index: 1 }, kind: 'paragraph', text: '员工只能查看自己的资料，普通员工不能审批。' }],
  });
  return { run: running, check };
}

function verifiedFinding(sid, title) {
  return registerVerifiedProjectFinding(store, sid, { title, target: origin });
}

try {
  await test('案例工具首次调用从已导入来源建立项目，不降级为自由测试', async () => {
    const sid = 'pt-auto-case-bootstrap';
    writeSceneContext(store, sid, 'cases', { presetId: 'pentest' });
    upsertProjectSource(store, sid, {
      sourceId: 'auto-case-doc', sourceRevision: 'r1', displayName: '自动案例.xlsx',
      kind: 'xlsx', parseState: 'ready', sourceRole: 'requirements',
      sections: [
        { sectionId: 'header', location: { kind: 'row', sheet: '案例', sheetIndex: 0, row: 1 }, kind: 'row',
          cells: [{ ref: 'A1', value: '编号' }, { ref: 'B1', value: '测试项' }] },
        { sectionId: 'data', location: { kind: 'row', sheet: '案例', sheetIndex: 0, row: 2 }, kind: 'row',
          cells: [{ ref: 'A2', value: 'C1' }, { ref: 'B2', value: 'GET ' + origin + '/auto-bootstrap' }] },
      ],
    });
    const response = await invoke(sid, 'project_request', { method: 'GET', url: origin + '/auto-bootstrap' });
    assert.equal(response.ok, true, response.error);
    assert(response.summary.includes('SAKER_PROJECT_TOOL'));
    const policy = readTaskPolicy(store, sid);
    assert.equal(policy.scenario, 'project');
    const run = readProjectRun(store, sid, policy.projectRunId);
    assert.equal(run.state, 'running');
    assert.equal(listProjectChecks(store, sid, run.runId).length, 1);
  });

  await test('案例缺少显式身份时保存可交付缺口并结束当前检查', async () => {
    const sid = 'pt-project-identity-gap';
    const prepared = prepareProject(sid);
    const next = await invoke(sid, 'project_check', { action: 'next' });
    assert.equal(next.ok, true, next.error);
    const denied = await invoke(sid, 'project_request', {
      method: 'GET', url: origin + '/private', identityRef: 'account-missing',
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /identity_not_found/);
    const failed = listProjectActions(store, sid, prepared.run.runId)
      .find(action => action.checkId === next.check.checkId);
    assert.equal(failed.executionState, 'failed');
    assert(failed.evidenceRef, '身份缺失也必须留下可导出的失败依据');
    const delivery = buildProjectDeliveryFiles(store, sid, prepared.run.runId);
    const exportedEvidence = delivery.files['delivery/evidence/typed/' + failed.evidenceRef + '.json'];
    assert(exportedEvidence, '失败动作引用的 typed evidence 必须随导出包提供');
    assert.match(exportedEvidence, /identity_not_found/);
    captureProjectNativeEvent(store, sid, {
      type: 'assistant/message', seq: 600, time: Date.now(),
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '缺少 account-missing 身份，记录缺口。' }] } },
    });
    const ended = readProjectCheck(store, sid, prepared.run.runId, next.check.checkId);
    assert.equal(ended.executionState, 'ended');
    assert.equal(ended.verdict, 'blocked');
    assert.match(ended.gaps, /原生工具执行失败|身份/);
  });

  await test('当前检查锁定身份与显式 URL，不能在一轮里提前执行后续项', async () => {
    const sid = 'pt-current-check-binding';
    const started = await dispatch(ctx, store, 'project.start', {
      sessionId: sid, autoStart: false,
      policy: { question: '当前项绑定', target: origin, allowTargetNetwork: true },
    });
    defineProjectChecks(store, sid, started.run.runId, [
      { checkId: 'current-m1', requirement: 'identityRef=account-missing 请求 ' + origin + '/denied' },
      { checkId: 'current-i1', requirement: '不使用身份，请求 ' + origin + '/denied' },
    ]);
    const next = await invoke(sid, 'project_check', { action: 'next' });
    assert.equal(next.ok, true, next.error);
    const anonymous = await invoke(sid, 'project_request', { method: 'GET', url: origin + '/denied' });
    assert.equal(anonymous.ok, false);
    assert.match(anonymous.error, /identityRef=account-missing/);
    const wrongUrl = await invoke(sid, 'project_request', {
      method: 'GET', url: origin + '/later', authContext: 'account-missing',
    });
    assert.equal(wrongUrl.ok, false);
    assert.match(wrongUrl.error, /不属于当前检查/);
    assert.equal(listProjectActions(store, sid, started.run.runId).length, 0);
  });

  await test('真实项目快照和宿主守卫接受项目场景，文档读取不套旧方向或扫描额度', async () => {
    const sid = 'pt-guarded-entry';
    const started = await dispatch(ctx, store, 'project.start', { sessionId: sid, policy: { question: '读取本地样本', target: origin, budget: { toolCalls: 1 } } });
    upsertProjectSource(store, sid, { sourceId: 'entry-doc', sourceRevision: 'r1', displayName: '入口样本', kind: 'text', parseState: 'ready',
      sections: [{ sectionId: 'p1', text: '仅检查回环服务是否能响应', kind: 'paragraph' }] });
    const snapshot = contexts.find(context => context.name === 'saker-pentest-task-state').text(exec(sid));
    assert.match(snapshot, /案例连续测试/);
    assert(!snapshot.includes('project_check'), 'retired registration instructions must not remain in the model prompt');
    assert(!snapshot.includes('project_evidence'), 'retired evidence bookkeeping must not remain in the model prompt');
    assert(snapshot.includes(started.run.runId), '稳定提示标明当前运行，避免新轮沿用历史检查编号');
    assert(!snapshot.includes('状态无法读取'), snapshot);
    assert.equal(readTaskPolicy(store, sid).modules, undefined, '项目不能初始化 regular 模块');
    const listed = await invoke(sid, 'project_document', { action: 'list' });
    assert.equal(listed.ok, true, listed.error);
    const read = await invoke(sid, 'project_document', { action: 'read', sourceId: 'entry-doc', sectionId: 'p1' });
    assert.equal(read.ok, true, read.error);
    const defined = await invoke(sid, 'project_check', { action: 'define', checks: [{ requirement: '检查回环响应', sourceLocation: 'entry-doc r1 p1' }] });
    assert.equal(defined.ok, true, defined.error);
    assert.match(defined.text, /action=next/);
    const stale = await invoke(sid, 'project_check', { action: 'detail', checkId: 'old-run-check' });
    assert.equal(stale.ok, false);
    assert(stale.error.includes(started.run.runId));
    assert.match(stale.error, /action=next/);
    const premature = await invoke(sid, 'project_check', { action: 'record', checkId: defined.checks[0].checkId, verdict: 'blocked', gaps: '合成缺条件' });
    assert.equal(premature.ok, false);
    assert.match(premature.error, /尚未领取.*action=next/);
    const next = await invoke(sid, 'project_check', { action: 'next' });
    assert.equal(next.ok, true, next.error);
    assert(next.text.includes(next.check.checkId), '实际渲染文本必须带后续 record 需要的 checkId');
    assert.equal(readTaskPolicy(store, sid).used.toolCalls, 0, '离线要求整理不消耗目标额度');
    const response = await invoke(sid, 'project_request', { method: 'GET', url: origin + '/guarded', checkId: next.check.checkId });
    assert.equal(response.ok, true, response.error);
    assert(response.summary.includes('SAKER_PROJECT_TOOL'), '模型渲染文本必须包含可判断的响应正文');
    assert(response.summary.includes('executionId='), '模型渲染文本必须带可续读回执引用');
    assert.equal(readTaskPolicy(store, sid).used.toolCalls, 1, '外层守卫和派发不能重复扣额度');
    const rejected = await tools.get('project_request').execute({ method: 'GET', url: origin + '/extra', checkId: next.check.checkId }, exec(sid));
    assert.equal(rejected.ok, false, '直接到工具实现也不能绕过已耗尽额度');
    assert.match(rejected.error, /tool_budget_exhausted/);
    assert.equal(readTaskPolicy(store, sid).modules, undefined);
    assert.equal(readProjectRun(store, sid, started.run.runId).state, 'running');
  });

  await test('R01 default cwd resolves before one reserved command and the last allowed call executes once', async () => {
    const sid = 'pt-command-default-cwd';
    const { check } = prepareProject(sid, { minutes: 30, toolCalls: 1 });
    await invoke(sid, 'project_check', { action: 'next' });
    const counter = path.join(home, 'default-cwd-count.txt');
    const script = path.join(home, 'default-cwd-once.mjs');
    fs.writeFileSync(script, "import fs from 'node:fs';fs.appendFileSync(process.argv[2],'once\\n');process.stdout.write('DEFAULT_CWD_OK\\n')\n");
    const args = {
      action: 'command',
      checkId: check.checkId,
      command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(script) + ' ' + JSON.stringify(counter),
      timeoutMs: 5000,
    };
    const first = await invoke(sid, 'project_evidence', args);
    assert.equal(first.ok, true, first.error);
    assert.match(first.observation.stdout, /DEFAULT_CWD_OK/);
    assert.equal(fs.readFileSync(counter, 'utf8'), 'once\n');
    assert.equal(readTaskPolicy(store, sid).used.toolCalls, 1, 'the last allowed command is reserved exactly once');
    const denied = await guards[0]({ ...exec(sid), name: 'project_evidence', arguments: args });
    assert.match(String(denied), /tool_budget_exhausted/);
    assert.equal(fs.readFileSync(counter, 'utf8'), 'once\n', 'the rejected call must not execute again');
  });

  await test('项目入口修复保留网络关闭与未知实战方向的拒绝', async () => {
    const sid = 'pt-guarded-disabled';
    const started = await dispatch(ctx, store, 'project.start', { sessionId: sid, policy: { question: '仅离线分析', target: origin, allowTargetNetwork: false } });
    const defined = await invoke(sid, 'project_check', { action: 'define', document: JSON.stringify({ checks: [{ requirement: '不访问服务' }] }) });
    assert.equal(defined.ok, true, defined.error);
    const next = await invoke(sid, 'project_check', { action: 'next' });
    assert.equal(next.ok, true, next.error);
    const response = await tools.get('project_request').execute({ method: 'GET', url: origin + '/disabled' }, exec(sid));
    assert.equal(response.ok, false);
    assert.match(response.error, /target_network_disabled/);
    const browserDenied = guards[0]({ ...exec(sid), name: 'saker_browser', arguments: { action: 'open', url: origin } });
    assert.match(browserDenied, /target_network_disabled/);
    assert.equal(readTaskPolicy(store, sid).used.toolCalls, 0);
    assert.throws(() => startTaskPolicy(store, 'pt-unknown-mode', { mode: 'project', question: '非项目字段不能伪装', budget: { toolCalls: 1 } }), /invalid task mode/);
  });
  await test('开始前在桌面保存的网络与请求限制进入真实项目策略', async () => {
    const sid = 'pt-saved-limits';
    await dispatch(ctx, store, 'task.limits', { sessionId: sid, allowTargetNetwork: false, readOnly: true, excludedPaths: '/private', requestRatePerMinute: 12, requestConcurrency: 1, allowedOrigins: ['https://api.example.test'] });
    const beforeStart = followups.filter(item => item.id === sid).length;
    await dispatch(ctx, store, 'project.start', { sessionId: sid, autoStart: false, policy: { question: '只分析现有文档', target: origin } });
    assert.equal(followups.filter(item => item.id === sid).length, beforeStart, 'autoStart=false must not enqueue a model request');
    const policy = readTaskPolicy(store, sid);
    assert.equal(policy.allowTargetNetwork, false);
    assert.equal(policy.readOnly, true);
    assert.deepEqual(policy.excludedPaths, ['/private']);
    assert.equal(policy.requestRatePerMinute, 12);
    assert.equal(policy.requestConcurrency, 1);
    assert.deepEqual(policy.allowedOrigins, ['https://api.example.test/']);
    await invoke(sid, 'project_check', { action: 'define', checks: [{ requirement: '不发请求' }] });
    await invoke(sid, 'project_check', { action: 'next' });
    const result = await tools.get('project_request').execute({ method: 'GET', url: origin + '/never-send' }, exec(sid));
    assert.equal(result.ok, false); assert.match(result.error, /target_network_disabled/);
  });
  await test('文档中的一个或多个网站都作为明确范围保留', async () => {
    await dispatch(ctx, store, 'project.import', { sessionId: 'pt-infer-target', name: '环境.md', text: '项目目标：`' + origin + '`，接口 ' + origin + '/api/items。无需登录。' });
    await dispatch(ctx, store, 'project.start', { sessionId: 'pt-infer-target', autoStart: false, policy: { question: '按文档测试' } });
    assert.equal(new URL(readTaskPolicy(store, 'pt-infer-target').target).origin, origin);
    await dispatch(ctx, store, 'project.import', { sessionId: 'pt-ambiguous-target', name: '环境.txt', text: '网站 ' + origin + ' 和 https://second.example.test' });
    await dispatch(ctx, store, 'project.start', { sessionId: 'pt-ambiguous-target', autoStart: false, policy: { question: '检查文档中的两个入口' } });
    const range = readTaskPolicy(store, 'pt-ambiguous-target');
    assert.match(range.target, new RegExp(new URL(origin).host));
    assert.match(range.target, /second\.example\.test/);
    assert.equal(range.scope.include.includes('https://second.example.test/'), true);
  });

  await test('structured spreadsheet rows become case checks without a model registration call', async () => {
    const sid = 'pt-auto-checklist';
    upsertProjectSource(store, sid, {
      sourceId: 'sheet-cases', sourceRevision: 'r1', displayName: '用例.xlsx', kind: 'xlsx', parseState: 'ready',
      sections: [
        { sectionId: 'sheet-1-row-1', location: { kind: 'row', sheet: '用例', row: 1, hidden: false }, kind: 'row',
          cells: [{ value: '编号' }, { value: '测试项' }, { value: '预期结果' }] },
        { sectionId: 'sheet-1-row-2', location: { kind: 'row', sheet: '用例', row: 2, hidden: false }, kind: 'row',
          cells: [{ value: 'C-01' }, { value: '普通用户登录' }, { value: '登录成功' }] },
        { sectionId: 'sheet-1-row-3', location: { kind: 'row', sheet: '用例', row: 3, hidden: false }, kind: 'row',
          cells: [{ value: 'C-02' }, { value: '无权限用户访问管理页' }, { value: '明确拒绝' }] },
      ],
    });
    const started = await dispatch(ctx, store, 'project.start', {
      sessionId: sid, autoStart: false, policy: { question: '按表格执行', target: origin },
    });
    assert.equal(started.autoChecks, 2);
    const checks = listProjectChecks(store, sid, started.run.runId);
    assert.equal(checks.length, 2);
    assert.match(checks[0].requirement, /测试项：普通用户登录/);
    assert.match(checks[1].sourceLocation, /第3行/);
    assert.equal(checks[0].sourceRefs.length, 1);
    assert.equal(checks[0].sourceRefs[0].sectionId, 'sheet-1-row-2');
    assert.equal(Object.values(readProjectRun(store, sid, started.run.runId).sectionDecisions)
      .find(item => item.sectionId === 'sheet-1-row-1')?.decision, 'reference');
    assert.equal(projectSourceProgress(store, sid, started.run.runId).pending, 0);
  });

  await test('spreadsheet mapping keeps workbook order, per-sheet headers, sparse columns, hidden rows and formula gaps', async () => {
    const sid = 'pt-auto-checklist-semantics';
    upsertProjectSource(store, sid, {
      sourceId: 'sheet-semantics', sourceRevision: 'r1', displayName: '评审表.xlsx', kind: 'xlsx', parseState: 'ready',
      sections: [
        { sectionId: 'z-note', location: { kind: 'worksheet', sheet: 'Z表' }, kind: 'worksheet-note',
          text: '隐藏列：2；合并区域：A1:C1' },
        { sectionId: 'z-head', location: { kind: 'row', sheet: 'Z表', sheetIndex: 0, row: 1 }, kind: 'row',
          cells: [{ ref: 'A1', value: '编号' }, { ref: 'C1', value: '测试项' }] },
        { sectionId: 'z-row', location: { kind: 'row', sheet: 'Z表', sheetIndex: 0, row: 2 }, kind: 'row',
          cells: [{ ref: 'A2', value: 'Z-1' }, { ref: 'C2', value: '稀疏列测试' }] },
        { sectionId: 'a-head', location: { kind: 'row', sheet: 'A表', sheetIndex: 1, row: 1 }, kind: 'row',
          cells: [{ ref: 'A1', value: '要求' }, { ref: 'B1', value: '预期' }] },
        { sectionId: 'a-row', location: { kind: 'row', sheet: 'A表', sheetIndex: 1, row: 2 }, kind: 'row',
          cells: [{ ref: 'A2', value: '独立要求' }, { ref: 'B2', value: '明确拒绝' }] },
        { sectionId: 'a-hidden', location: { kind: 'row', sheet: 'A表', sheetIndex: 1, row: 3, hidden: true }, kind: 'row',
          cells: [{ ref: 'A3', value: '隐藏要求' }, { ref: 'B3', value: '不应自动执行' }] },
        { sectionId: 'a-formula', location: { kind: 'row', sheet: 'A表', sheetIndex: 1, row: 4 }, kind: 'row',
          cells: [{ ref: 'C4', value: '', formulaNoResult: true }], formulasWithoutCache: ['C4'] },
      ],
    });
    const started = await dispatch(ctx, store, 'project.start', {
      sessionId: sid, autoStart: false, policy: { question: '按稀疏评审表执行', allowTargetNetwork: false },
    });
    const checks = listProjectChecks(store, sid, started.run.runId);
    assert.equal(checks.length, 3);
    assert.match(checks[0].requirement, /编号：Z-1/);
    assert.match(checks[0].requirement, /测试项：稀疏列测试/);
    assert.match(checks[1].requirement, /要求：独立要求/);
    assert.match(checks[1].requirement, /预期：明确拒绝/);
    assert.match(checks[2].requirement, /公式无缓存结果，需核对原文件/);
    assert(!checks.some(check => /隐藏要求/.test(check.requirement)));
    const hiddenDecision = Object.values(readProjectRun(store, sid, started.run.runId).sectionDecisions)
      .find(item => item.sectionId === 'a-hidden');
    const worksheetNoteDecision = Object.values(readProjectRun(store, sid, started.run.runId).sectionDecisions)
      .find(item => item.sectionId === 'z-note');
    assert.equal(hiddenDecision.decision, 'excluded');
    assert.match(hiddenDecision.rationale, /隐藏行默认不进入执行范围/);
    assert.equal(worksheetNoteDecision.decision, 'reference');
    assert.match(worksheetNoteDecision.rationale, /不作为独立测试要求/);
  });

  await test('a headerless spreadsheet keeps its first row and prepared table choices persist into the run', async () => {
    const sid = 'pt-auto-headerless';
    upsertProjectSource(store, sid, {
      sourceId: 'sheet-headerless', sourceRevision: 'r1', displayName: '无表头.xlsx', kind: 'xlsx', parseState: 'ready',
      sections: [
        { sectionId: 'h1', location: { kind: 'row', sheet: 'Sheet1', sheetIndex: 0, row: 1, hiddenColumns: [2] }, kind: 'row',
          cells: [{ ref: 'A1', value: 'A' }, { ref: 'B1', value: 'B' }] },
        { sectionId: 'h2', location: { kind: 'row', sheet: 'Sheet1', sheetIndex: 0, row: 2 }, kind: 'row',
          cells: [{ ref: 'A2', value: '普通用户只能查看自己的订单' }, { ref: 'B2', value: '页面只显示当前用户订单' }] },
        { sectionId: 'h3', location: { kind: 'row', sheet: 'Sheet1', sheetIndex: 0, row: 3, hidden: true }, kind: 'row',
          cells: [{ ref: 'A3', value: '隐藏用户必须被明确拒绝' }, { ref: 'B3', value: '返回 403' }] },
      ],
    });
    const prepared = await dispatch(ctx, store, 'project.prepare', {
      sessionId: sid, sourceId: 'sheet-headerless', sourceRevision: 'r1', sourceRole: 'requirements',
      regions: [{ sheet: 'Sheet1', sheetIndex: 0, fromRow: 1, toRow: 3, headerMode: 'none', includeHidden: true }],
    });
    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(prepared.preview.needsConfirmation, true);
    const status = await dispatch(ctx, store, 'project.status', { sessionId: sid });
    assert.equal(status.sources[0].sourceRole, 'requirements');
    assert.equal(status.sources[0].preparation.regions[0].headerMode, 'none');
    assert.equal(status.sources[0].preparation.regions[0].includeHidden, true);
    const started = await dispatch(ctx, store, 'project.start', {
      sessionId: sid, autoStart: false, policy: { question: '无表头全保留', allowTargetNetwork: false },
    });
    assert.equal(started.autoChecks, 3);
    const checks = listProjectChecks(store, sid, started.run.runId);
    assert(checks.some(check => /第1列（A列）：A/.test(check.requirement)), 'ambiguous first row must remain a check');
    assert(checks.some(check => /隐藏用户必须被明确拒绝/.test(check.requirement)), 'explicit includeHidden must include hidden rows');

    const defaultSid = 'pt-auto-headerless-default';
    upsertProjectSource(store, defaultSid, {
      sourceId: 'sheet-headerless-default', sourceRevision: 'r1', displayName: '无表头默认.xlsx', kind: 'xlsx', parseState: 'ready',
      sections: [
        { sectionId: 'd1', location: { kind: 'row', sheet: 'Sheet1', sheetIndex: 0, row: 1 }, kind: 'row',
          cells: [{ ref: 'A1', value: 'A' }, { ref: 'B1', value: 'B' }] },
        { sectionId: 'd2', location: { kind: 'row', sheet: 'Sheet1', sheetIndex: 0, row: 2 }, kind: 'row',
          cells: [{ ref: 'A2', value: '普通用户只能查看自己的订单' }, { ref: 'B2', value: '页面只显示当前用户订单' }] },
      ],
    });
    const defaultRun = await dispatch(ctx, store, 'project.start', {
      sessionId: defaultSid, autoStart: false, policy: { question: '默认保留无表头首行', allowTargetNetwork: false },
    });
    assert.equal(defaultRun.autoChecks, 2, 'ambiguous first row must default to data without explicit preparation');
  });

  await test('one worksheet can contain two independently recognized table regions', async () => {
    const sid = 'pt-two-table-regions';
    upsertProjectSource(store, sid, {
      sourceId: 'two-regions', sourceRevision: 'r1', displayName: '双表区.xlsx', kind: 'xlsx', parseState: 'ready',
      sections: [
        { sectionId: 'r1-h', location: { kind: 'row', sheet: 'Sheet1', sheetIndex: 0, row: 1 }, kind: 'row',
          cells: [{ ref: 'A1', value: '编号' }, { ref: 'B1', value: '测试项' }] },
        { sectionId: 'r1-d', location: { kind: 'row', sheet: 'Sheet1', sheetIndex: 0, row: 2 }, kind: 'row',
          cells: [{ ref: 'A2', value: 'U-1' }, { ref: 'B2', value: '第一表区要求' }] },
        { sectionId: 'r2-h', location: { kind: 'row', sheet: 'Sheet1', sheetIndex: 0, row: 4 }, kind: 'row',
          cells: [{ ref: 'C4', value: '要求' }, { ref: 'D4', value: '预期结果' }] },
        { sectionId: 'r2-d', location: { kind: 'row', sheet: 'Sheet1', sheetIndex: 0, row: 5 }, kind: 'row',
          cells: [{ ref: 'C5', value: '第二表区独立要求' }, { ref: 'D5', value: '明确拒绝' }] },
      ],
    });
    const started = await dispatch(ctx, store, 'project.start', {
      sessionId: sid, autoStart: false, policy: { question: '两个表区', allowTargetNetwork: false },
    });
    const checks = listProjectChecks(store, sid, started.run.runId);
    assert.equal(checks.length, 2);
    assert.match(checks[0].requirement, /编号：U-1/);
    assert.match(checks[1].requirement, /要求：第二表区独立要求/);
    assert.match(checks[1].requirement, /预期结果：明确拒绝/);
  });

  await test('native read/result/reply bind to the current case check without registration tools', async () => {
    const sid = 'pt-native-case-fact';
    const { run, check } = prepareProject(sid, { minutes: 30 });
    const handler = events.get('session/event')[0];
    const session = { id: sid, header: { agentPreset: 'pentest' } };
    await handler(session, {
      type: 'tool/call', seq: 1, time: Date.now(),
      data: { name: 'read', callId: 'call-native-read', arguments: { file_path: path.join(home, 'expected.txt') } },
    });
    let current = readProjectCheck(store, sid, run.runId, check.checkId);
    assert.equal(current.executionState, 'running');
    assert(current.actionRefs.includes('call-native-read'));
    assert.equal(readProjectRun(store, sid, run.runId).currentCheckId, check.checkId);
    await handler(session, {
      type: 'tool/result', seq: 2, time: Date.now(),
      data: { message: { name: 'read', toolCallId: 'call-native-read', isError: false,
        content: [{ type: 'text', text: '1: AUTO_CASE_OK' }] } },
    });
    current = readProjectCheck(store, sid, run.runId, check.checkId);
    assert.equal(current.actionRefs.length, 1);
    assert.equal(current.evidenceRefs.length, 1);
    const evidenceId = current.evidenceRefs[0];
    const material = JSON.parse(store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?')
      .get(sid, evidenceId).record);
    assert.equal(material.kind, 'tool');
    assert.equal(material.sourceType, 'host-native-tool-result');
    assert.match(material.text, /AUTO_CASE_OK/);
    await handler(session, {
      type: 'assistant/message', seq: 3, time: Date.now(),
      data: { message: { content: [
        { type: 'reasoning', text: 'HIDDEN_REASONING_MUST_NOT_BE_STORED' },
        { type: 'text', text: '检查一已读取 expected.txt，实际内容 AUTO_CASE_OK，符合预期。' },
      ] } },
    });
    current = readProjectCheck(store, sid, run.runId, check.checkId);
    assert.equal(current.executionState, 'ended');
    assert.equal(current.verdict, 'needs_check');
    assert.match(current.checkedContent, /AUTO_CASE_OK/);
    assert.doesNotMatch(current.checkedContent, /HIDDEN_REASONING_MUST_NOT_BE_STORED/);
    assert.equal(current.gaps, '');
    assert.deepEqual(listProjectActions(store, sid, run.runId).map(action => action.actionId), ['call-native-read']);
    assert.equal(projectTurnDecision(store, sid).action, 'completed', 'an executed native fact can finish without an extra registration call');
  });

  await test('two independent native case facts advance in order and then stop', async () => {
    const sid = 'pt-native-case-sequence';
    const { run, check: first } = prepareProject(sid, { minutes: 30 });
    const [second] = defineProjectChecks(store, sid, run.runId, [{ checkId: 'second', requirement: '读取第二项 expected.txt' }]);
    const handler = events.get('session/event')[0];
    const session = { id: sid, header: { agentPreset: 'pentest' } };
    for (const [turn, [callId, checkId, text]] of [
      ['call-native-first', first.checkId, '第一项读取完成，结果待核对。'],
      ['call-native-second', second.checkId, '第二项读取完成，结果待核对。'],
    ].entries()) {
      const turnNumber = turn + 1;
      await handler(session, { type: 'tool/call', seq: turnNumber * 3 + 1, time: Date.now(),
        data: { turn: turnNumber, step: 1, name: 'read', callId, arguments: { file_path: path.join(home, checkId + '.txt') } } });
      await handler(session, { type: 'tool/result', seq: turnNumber * 3 + 2, time: Date.now(),
        data: { turn: turnNumber, step: 1, message: { name: 'read', toolCallId: callId, isError: false,
          content: [{ type: 'text', text: checkId + ': AUTO_CASE_OK' }] } } });
      await handler(session, { type: 'assistant/message', seq: turnNumber * 3 + 3, time: Date.now(),
        data: { turn: turnNumber, step: 1, message: { content: [{ type: 'text', text }] } } });
      if (turn === 0) {
        assert.equal(projectTurnDecision(store, sid).action, 'continue');
        assert.equal(readProjectRun(store, sid, run.runId).currentCheckId, second.checkId,
          'program continuation must atomically select the next executable check');
      }
    }
    const checks = listProjectChecks(store, sid, run.runId);
    assert.deepEqual(checks.map(check => [check.checkId, check.executionState, check.verdict]),
      [[first.checkId, 'ended', 'needs_check'], [second.checkId, 'ended', 'needs_check']]);
    assert.equal(listProjectActions(store, sid, run.runId).length, 2);
    assert.equal(projectTurnDecision(store, sid).action, 'completed');
  });

  await test('native results finish after pause, preserve old attempts after reopen, and ignore duplicate delivery', async () => {
    const handler = events.get('session/event')[0];
    const pausedSid = 'pt-native-paused';
    const paused = prepareProject(pausedSid, { minutes: 30 });
    const pausedSession = { id: pausedSid, header: { agentPreset: 'pentest' } };
    await handler(pausedSession, { type: 'tool/call', seq: 1, time: Date.now(),
      data: { name: 'read', callId: 'pause-read', arguments: { file_path: path.join(home, 'pause.txt') } } });
    transitionProjectRun(store, pausedSid, paused.run.runId, 'paused', readProjectRun(store, pausedSid, paused.run.runId).controlRev);
    await handler(pausedSession, { type: 'tool/result', seq: 2, time: Date.now(),
      data: { message: { name: 'read', toolCallId: 'pause-read', isError: false,
        content: [{ type: 'text', text: 'PAUSE_RESULT' }] } } });
    assert.equal(readProjectRun(store, pausedSid, paused.run.runId).state, 'paused');
    assert.equal(listProjectActions(store, pausedSid, paused.run.runId)[0].executionState, 'completed');
    assert.equal(readProjectCheck(store, pausedSid, paused.run.runId, paused.check.checkId).evidenceRefs.length, 1);

    const reopenSid = 'pt-native-reopen';
    const reopened = prepareProject(reopenSid, { minutes: 30 });
    const reopenSession = { id: reopenSid, header: { agentPreset: 'pentest' } };
    await handler(reopenSession, { type: 'tool/call', seq: 3, time: Date.now(),
      data: { name: 'read', callId: 'old-read', arguments: { file_path: path.join(home, 'old.txt') } } });
    const oldAttempt = readProjectCheck(store, reopenSid, reopened.run.runId, reopened.check.checkId).activeAttempt.attemptId;
    reopenProjectCheck(store, reopenSid, reopened.run.runId, reopened.check.checkId, { force: true, reason: 'new instance', instanceRevision: 2 });
    await handler(reopenSession, { type: 'tool/result', seq: 4, time: Date.now(),
      data: { message: { name: 'read', toolCallId: 'old-read', isError: false,
        content: [{ type: 'text', text: 'OLD_RESULT' }] } } });
    await handler(reopenSession, { type: 'tool/result', seq: 5, time: Date.now(),
      data: { message: { name: 'read', toolCallId: 'old-read', isError: false,
        content: [{ type: 'text', text: 'OLD_RESULT' }] } } });
    const current = readProjectCheck(store, reopenSid, reopened.run.runId, reopened.check.checkId);
    assert.equal(current.executionState, 'pending');
    assert.deepEqual(current.actionRefs, []);
    assert.deepEqual(current.evidenceRefs, []);
    const material = JSON.parse(store.db.prepare("SELECT record FROM business_materials WHERE session_id=? AND json_extract(record,'$.callId')='old-read'").get(reopenSid).record);
    assert.equal(material.attemptId, oldAttempt);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM business_materials WHERE session_id=? AND json_extract(record,'$.callId')='old-read'").get(reopenSid).n, 1);
  });

  await test('native commentary stays in the same attempt and retry ignores previous failed actions', async () => {
    const handler = events.get('session/event')[0];
    const commentarySid = 'pt-native-commentary';
    const commentary = prepareProject(commentarySid, { minutes: 30 });
    const [later] = defineProjectChecks(store, commentarySid, commentary.run.runId,
      [{ checkId: 'later', requirement: '后续独立检查' }]);
    const commentarySession = { id: commentarySid, header: { agentPreset: 'pentest' } };
    await handler(commentarySession, { type: 'tool/call', seq: 6, time: Date.now(),
      data: { turn: 1, step: 1, name: 'read', callId: 'comment-first', arguments: { file_path: path.join(home, 'first.txt') } } });
    await handler(commentarySession, { type: 'tool/result', seq: 7, time: Date.now(),
      data: { turn: 1, step: 1, message: { name: 'read', toolCallId: 'comment-first', isError: false,
        content: [{ type: 'text', text: 'FIRST_OK' }] } } });
    await handler(commentarySession, { type: 'assistant/message', seq: 8, time: Date.now(),
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '第一份已读，接下来读取第二份。' }] } } });
    await handler(commentarySession, { type: 'tool/call', seq: 9, time: Date.now(),
      data: { turn: 1, step: 2, name: 'read', callId: 'comment-second', arguments: { file_path: path.join(home, 'second.txt') } } });
    await handler(commentarySession, { type: 'tool/result', seq: 10, time: Date.now(),
      data: { turn: 1, step: 2, message: { name: 'read', toolCallId: 'comment-second', isError: false,
        content: [{ type: 'text', text: 'SECOND_OK' }] } } });
    await handler(commentarySession, { type: 'assistant/message', seq: 11, time: Date.now(),
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '两份资料均已读取并核对。' }] } } });
    const commentaryCheck = readProjectCheck(store, commentarySid, commentary.run.runId, commentary.check.checkId);
    assert.deepEqual(commentaryCheck.actionRefs, ['comment-first', 'comment-second']);
    assert.equal(commentaryCheck.checkedContent, '两份资料均已读取并核对。');
    const laterCheck = readProjectCheck(store, commentarySid, commentary.run.runId, later.checkId);
    assert.equal(laterCheck.executionState, 'pending');
    assert.deepEqual(laterCheck.actionRefs, []);

    const retrySid = 'pt-native-failed-retry';
    const retry = prepareProject(retrySid, { minutes: 30 });
    const retrySession = { id: retrySid, header: { agentPreset: 'pentest' } };
    await handler(retrySession, { type: 'tool/call', seq: 12, time: Date.now(),
      data: { name: 'read', callId: 'failed-read', arguments: { file_path: path.join(home, 'missing.txt') } } });
    await handler(retrySession, { type: 'tool/result', seq: 13, time: Date.now(),
      data: { message: { name: 'read', toolCallId: 'failed-read', isError: true,
        content: [{ type: 'text', text: 'file missing' }] }, error: { code: 'missing' } } });
    await handler(retrySession, { type: 'assistant/message', seq: 14, time: Date.now(),
      data: { message: { content: [{ type: 'text', text: '文件不存在。' }] } } });
    reopenProjectCheck(store, retrySid, retry.run.runId, retry.check.checkId, { reason: '补齐文件后重试' });
    await handler(retrySession, { type: 'tool/call', seq: 15, time: Date.now(),
      data: { name: 'read', callId: 'successful-retry', arguments: { file_path: path.join(home, 'retry.txt') } } });
    await handler(retrySession, { type: 'tool/result', seq: 16, time: Date.now(),
      data: { message: { name: 'read', toolCallId: 'successful-retry', isError: false,
        content: [{ type: 'text', text: 'RETRY_OK' }] } } });
    await handler(retrySession, { type: 'assistant/message', seq: 17, time: Date.now(),
      data: { message: { content: [{ type: 'text', text: '补齐后读取成功，结论待核对。' }] } } });
    const retried = readProjectCheck(store, retrySid, retry.run.runId, retry.check.checkId);
    assert.equal(retried.verdict, 'needs_check');
    assert.deepEqual(retried.actionRefs, ['successful-retry']);
  });

  await test('a later successful action in the same attempt supersedes an earlier failure', async () => {
    const sid = 'pt-native-failure-then-success';
    const prepared = prepareProject(sid, { minutes: 30 });
    const handler = events.get('session/event')[0];
    const session = { id: sid, header: { agentPreset: 'pentest' } };
    await handler(session, { type: 'tool/call', seq: 31, time: Date.now(), data: {
      turn: 1, step: 1, name: 'read', callId: 'same-attempt-fail', arguments: { file_path: path.join(home, 'missing.txt') },
    } });
    await handler(session, { type: 'tool/result', seq: 32, time: Date.now(), data: {
      turn: 1, step: 1, message: { name: 'read', toolCallId: 'same-attempt-fail', isError: true,
        content: [{ type: 'text', text: 'not found' }] }, error: { code: 'ENOENT' },
    } });
    await handler(session, { type: 'assistant/message', seq: 33, time: Date.now(), data: {
      turn: 1, step: 1, message: { content: [{ type: 'text', text: '第一次读取失败，换用已保存材料。' }] },
    } });
    await handler(session, { type: 'tool/call', seq: 34, time: Date.now(), data: {
      turn: 1, step: 2, name: 'read', callId: 'same-attempt-success', arguments: { file_path: path.join(home, 'expected.txt') },
    } });
    await handler(session, { type: 'tool/result', seq: 35, time: Date.now(), data: {
      turn: 1, step: 2, message: { name: 'read', toolCallId: 'same-attempt-success', isError: false,
        content: [{ type: 'text', text: 'AUTO_CASE_OK' }] },
    } });
    await handler(session, { type: 'assistant/message', seq: 36, time: Date.now(), data: {
      turn: 1, step: 2, message: { content: [{ type: 'text', text: '改用已保存材料后读取成功，结论待核对。' }] },
    } });
    const check = readProjectCheck(store, sid, prepared.run.runId, prepared.check.checkId);
    assert.equal(check.verdict, 'needs_check');
    assert.equal(check.gaps, '');
    assert.deepEqual(check.actionRefs, ['same-attempt-fail', 'same-attempt-success']);
  });

  await test('parallel native reads route by explicit case targets and keep both actions', async () => {
    const sid = 'pt-native-parallel';
    upsertProjectSource(store, sid, {
      sourceId: 'parallel-cases', sourceRevision: 'r1', displayName: '并行用例.xlsx', kind: 'xlsx', parseState: 'ready',
      sections: [
        { sectionId: 'p-1', location: { kind: 'row', sheet: 'Cases', row: 1, hidden: false }, kind: 'row',
          cells: [{ value: '编号' }, { value: '测试项' }, { value: '预期结果' }] },
        { sectionId: 'p-2', location: { kind: 'row', sheet: 'Cases', row: 2, hidden: false }, kind: 'row',
          cells: [{ value: 'C1' }, { value: '读取 first.txt 和 second.txt' }, { value: 'FIRST_OK SECOND_OK' }] },
        { sectionId: 'p-3', location: { kind: 'row', sheet: 'Cases', row: 3, hidden: false }, kind: 'row',
          cells: [{ value: 'C2' }, { value: '读取 final.txt' }, { value: 'FINAL_OK' }] },
      ],
    });
    const started = await dispatch(ctx, store, 'project.start', {
      sessionId: sid, autoStart: false, policy: { question: '并行读取路由', allowTargetNetwork: false },
    });
    const checks = listProjectChecks(store, sid, started.run.runId);
    assert.equal(checks.length, 2);
    let seq = 20;
    const capture = (type, data) => captureProjectNativeEvent(store, sid, { type, seq: seq++, time: Date.now(), data });
    for (const [seq, callId, name] of [
      [21, 'parallel-first', 'first.txt'],
      [22, 'parallel-second', 'second.txt'],
      [23, 'parallel-final', 'final.txt'],
    ]) {
      capture('tool/call', {
        turn: 1, step: 1, name: 'read', callId, arguments: { file_path: path.join(home, name) } });
    }
    for (const [seq, callId, text] of [
      [24, 'parallel-first', 'FIRST_OK'],
      [25, 'parallel-second', 'SECOND_OK'],
      [26, 'parallel-final', 'FINAL_OK'],
    ]) {
      capture('tool/result', {
        turn: 1, step: 1, message: { name: 'read', toolCallId: callId, isError: false,
          content: [{ type: 'text', text }] } });
    }
    capture('assistant/message', {
      turn: 1, step: 1, message: { content: [{ type: 'text', text: '当前项读取完成。' }] } });
    const current = listProjectChecks(store, sid, started.run.runId);
    const routeDebug = JSON.stringify(current.map(check => ({ checkId: check.checkId,
      requirement: check.requirement, state: check.executionState, actions: check.actionRefs })));
    assert.deepEqual(current[0].actionRefs, ['parallel-first', 'parallel-second'], routeDebug);
    assert.deepEqual(current[1].actionRefs, ['parallel-final'], routeDebug);
    assert.equal(current[0].evidenceRefs.length, 2);
    assert.equal(current[1].evidenceRefs.length, 1);
    assert.equal(current[1].executionState, 'ended');
    assert.equal(listProjectActions(store, sid, started.run.runId).length, 3);
  });

  await test('项目工具定义展示结构化检查格式，错误输入不能假报定义成功', async () => {
    const sid = 'pt-check-contract';
    await dispatch(ctx, store, 'project.start', { sessionId: sid, policy: { question: '检查输入合同', target: origin } });
    const definition = tools.get('project_check');
    assert.equal(definition.parameters.checks?.type, 'array');
    assert.equal(definition.parameters.checks.items.properties.requirement.required, true);
    assert.equal(tools.get('saker_browser').parameters.identityRef?.type, 'string', '浏览器身份引用必须进入真实 schema');
    for (const args of [{ action: 'define' }, { action: 'define', document: '{}' }, { action: 'define', checks: [] }, { action: 'define', checks: [{}] }]) {
      const result = await invoke(sid, 'project_check', args);
      assert.equal(result.ok, false, JSON.stringify(args));
      assert(!String(result.text || '').includes('已定义 0'));
    }
    const legacy = await invoke(sid, 'project_check', { action: 'define', document: JSON.stringify({ checks: [{ requirement: '已有会话格式仍可读取' }] }) });
    assert.equal(legacy.ok, true, legacy.error);
  });

  await test('真实 start 到 define / next 进入运行，不靠测试手工 transition', async () => {
    const sid = 'pt-real-start';
    const started = await dispatch(ctx, store, 'project.start', { sessionId: sid, policy: { question: '读取本地样本', target: origin } });
    assert.equal(started.run.state, 'preparing');
    assert.equal(followups.filter(item => item.id === sid).length, 1);
    const defined = await tools.get('project_check').execute({ action: 'define', document: JSON.stringify({ checks: [{ requirement: '读取样本' }] }) }, exec(sid));
    assert.equal(defined.ok, true, defined.error);
    const next = await tools.get('project_check').execute({ action: 'next' }, exec(sid));
    assert.equal(next.ok, true, next.error);
    assert.equal(readProjectRun(store, sid, started.run.runId).state, 'running', '领取当前项应接通准备转运行');
    assert.equal(readProjectRun(store, sid, started.run.runId).currentCheckId, next.check.checkId, '实际保存当前检查');
    const result = await tools.get('project_request').execute({ method: 'GET', url: origin + '/entry' }, exec(sid));
    assert.equal(result.ok, true, result.error);
  });

  await test('按文档入口真实导入来源，整理完并完成检查后自动收尾', async () => {
    const sid = 'pt-project-source';
    const content = '员工只能查看自己的资料，普通员工不能审批。';
    const imported = await dispatch(ctx, store, 'project.import', {
      sessionId: sid, name: '测试要求.txt', base64: Buffer.from(content).toString('base64'),
    });
    assert.equal(imported.ok, true, imported.error);
    assert.equal(imported.source.parseState, 'ready');
    assert.equal(imported.sections, 1);
    const sourceMaterial = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(sid);
    assert(sourceMaterial);
    const sourceMaterialRecord = JSON.parse(sourceMaterial.record);
    assert.equal(sourceMaterialRecord.kind, 'project-source');
    assert(Buffer.from(sourceMaterialRecord.originalBase64, 'base64').toString().includes(content), '项目来源原文必须随任务保存');
    const started = await dispatch(ctx, store, 'project.start', {
      sessionId: sid, policy: { question: '按文档测试', target: origin, budget: { minutes: 30 } },
    });
    assert.equal(started.run.sourceSnapshot.length, 1, '开始后必须固定来源快照');
    const listed = await invoke(sid, 'project_document', { action: 'list' });
    assert(listed.text.includes('测试要求.txt'));
    const read = await invoke(sid, 'project_document', { action: 'read', sourceId: imported.source.sourceId, sourceRevision: 'r1', sectionId: 'lines-1-1' });
    assert.equal(read.ok, true, read.error);
    assert(read.text.includes('来源：测试要求.txt'));
    assert(read.text.includes('后续：无'));
    const defined = await invoke(sid, 'project_check', {
      action: 'define',
      checks: [{
        checkId: 'source-check-1', requirement: '检查员工资料权限',
        sourceRefs: [{ sourceId: imported.source.sourceId, sourceRevision: 'r1', sectionId: 'lines-1-1' }],
      }],
      sectionDecisions: [{
        sourceId: imported.source.sourceId, sourceRevision: 'r1', sectionId: 'lines-1-1',
        decision: 'requirements', checkIds: ['source-check-1'],
      }],
    });
    assert.equal(defined.ok, true, defined.error);
    assert(defined.text.includes('本次累计 1 个区域'));
    const next = await invoke(sid, 'project_check', { action: 'next' });
    assert.equal(next.check.checkId, 'source-check-1');
    const observed = await invoke(sid, 'project_request', {
      method: 'GET', url: origin + '/approval', checkId: 'source-check-1',
    });
    assert.equal(observed.ok, true, observed.error);
    const recorded = await invoke(sid, 'project_check', {
      action: 'record', checkId: 'source-check-1', verdict: 'not_found', checkedContent: '普通员工审批入口返回无权限',
    });
    assert.equal(recorded.ok, true, recorded.error);
    const decision = projectTurnDecision(store, sid);
    assert.equal(decision.action, 'completed');
    completeProjectRun(store, sid, started.run.runId);
    assert.equal(readProjectRun(store, sid, started.run.runId).state, 'completed');
  });

  await test('来源整理批次任一条无效时整批不落库', async () => {
    const sid = 'pt-project-atomic';
    const imported = await dispatch(ctx, store, 'project.import', {
      sessionId: sid, name: '原子要求.txt', text: '检查普通员工不能审批。',
    });
    await dispatch(ctx, store, 'project.start', {
      sessionId: sid, policy: { question: '按文档测试', allowTargetNetwork: false, budget: { minutes: 30 } }, autoStart: false,
    });
    const read = await invoke(sid, 'project_document', {
      action: 'read', sourceId: imported.source.sourceId, sourceRevision: 'r1', sectionId: 'lines-1-1',
    });
    assert.equal(read.ok, true, read.error);
    const rejected = await invoke(sid, 'project_check', {
      action: 'define',
      checks: [{ checkId: 'atomic-1', requirement: '检查审批限制' }],
      sectionDecisions: [{
        sourceId: imported.source.sourceId, sourceRevision: 'r1', sectionId: 'missing',
        decision: 'reference', rationale: '无效段落应拒绝整批',
      }],
    });
    assert.equal(rejected.ok, false);
    const run = readProjectRun(store, sid, (await dispatch(ctx, store, 'project.status', { sessionId: sid })).run.runId);
    assert.equal(listProjectChecks(store, sid, run.runId).length, 0, '无效整理决定不能留下半批检查');
  });

  await test('同名来源修订递增，重复内容复用，运行快照只取最新修订', async () => {
    const sid = 'pt-project-revisions';
    const first = await dispatch(ctx, store, 'project.import', { sessionId: sid, name: '要求.txt', text: '第一版要求' });
    const second = await dispatch(ctx, store, 'project.import', { sessionId: sid, name: '要求.txt', text: '第二版要求' });
    const duplicate = await dispatch(ctx, store, 'project.import', { sessionId: sid, name: '要求.txt', text: '第二版要求' });
    assert.equal(first.source.sourceId, second.source.sourceId);
    assert.equal(first.source.sourceRevision, 'r1');
    assert.equal(second.source.sourceRevision, 'r2');
    assert.equal(duplicate.source.sourceId, second.source.sourceId);
    assert.equal(duplicate.source.sourceRevision, 'r2', '相同内容重复导入不能制造新修订');
    const started = await dispatch(ctx, store, 'project.start', { sessionId: sid, policy: { question: '按修订测试', allowTargetNetwork: false, budget: { minutes: 10 } }, autoStart: false });
    assert.equal(started.run.sourceSnapshot.length, 1, '同一来源多个修订只把最新版放进本次快照');
    assert.equal(started.run.sourceSnapshot[0].sourceRevision, 'r2');
  });

  await test('项目 pause / resume 真正恢复投递并保持额度，stop 同步公共状态', async () => {
    const sid = 'pt-real-resume';
    const started = await dispatch(ctx, store, 'project.start', { sessionId: sid, policy: { question: '生命周期', target: origin } });
    const before = taskPolicyStatus(store, sid).policy.startedAt;
    await dispatch(ctx, store, 'project.pause', { sessionId: sid, runId: started.run.runId });
    assert.equal(taskPolicyStatus(store, sid).stopped, true, '暂停同步公共任务状态');
    await dispatch(ctx, store, 'project.resume', { sessionId: sid, runId: started.run.runId });
    assert.equal(followups.filter(item => item.id === sid).length, 2, '继续必须真实投递，不只是改 preparing');
    assert.equal(taskPolicyStatus(store, sid).policy.startedAt, before, '继续不重置计量轮次');
    await dispatch(ctx, store, 'project.stop', { sessionId: sid, runId: started.run.runId });
    assert.equal(taskPolicyStatus(store, sid).stopped, true, '停止后公共状态不能仍然进行中');
  });

  await test('恢复投递失败保留暂停，旧控制版本不能继续或停止', async () => {
    const sid = 'pt-resume-failure';
    const { run } = prepareProject(sid);
    const paused = await dispatch(ctx, store, 'project.pause', { sessionId: sid, runId: run.runId, expectedControlRev: run.controlRev });
    await assert.rejects(() => dispatch(ctx, store, 'project.resume', { sessionId: sid, runId: run.runId, expectedControlRev: run.controlRev }), /状态已变化/);
    assert.equal(readProjectRun(store, sid, run.runId).state, 'paused');
    failedFollowups.add(sid);
    await assert.rejects(() => dispatch(ctx, store, 'project.resume', { sessionId: sid, runId: run.runId, expectedControlRev: paused.run.controlRev }), /投递失败/);
    assert.equal(readProjectRun(store, sid, run.runId).state, 'paused');
    assert.equal(taskPolicyStatus(store, sid).stopped, true);
    await assert.rejects(() => dispatch(ctx, store, 'project.stop', { sessionId: sid, runId: run.runId, expectedControlRev: paused.run.controlRev }), /状态已变化/);
  });

  await test('生产 turn-stopping 钩子有界接续，暂停后不能被旧消息唤醒', async () => {
    const sid = 'pt-host-continuation';
    const { run, check } = prepareProject(sid);
    const steers = [];
    const agent = { ...exec(sid).agent, steer: text => steers.push(text) };
    const handlers = events.get('agent/turn-stopping');
    assert(handlers?.length);
    for (let index = 0; index < 4; index++) for (const handler of handlers) await handler({ agent });
    assert.equal(steers.length, 1, '同一无进展指纹只允许一次接续');
    for (const message of steers) {
      assert.equal(typeof message, 'object', '宿主 inbox 持久化要求消息对象，字符串会导致重启后历史损坏');
      assert(message.id.startsWith('saker-project-continue-'));
      assert.equal(message.role, 'user');
      assert.equal(message.source.kind, 'user');
      assert.match(message.content[0].text, /继续案例测试/);
      assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
    }
    assert.equal(readProjectRun(store, sid, run.runId).state, 'paused');
    assert.equal(taskPolicyStatus(store, sid).stopped, true);
    const recorded = await tools.get('project_check').execute({ action: 'record', checkId: check.checkId, verdict: 'not_found', checkedContent: '不应被写入' }, exec(sid));
    assert.equal(recorded.ok, false, '暂停状态不接受迟到结论');
    assert.match(recorded.error, /已暂停/);
  });

  await test('“只回复收到”不触发程序续接或额外模型请求', async () => {
    const sid = 'pt-temporary-reply';
    const { run } = prepareProject(sid);
    const steers = [];
    const agent = {
      ...exec(sid).agent,
      steer: message => steers.push(message),
      session: {
        ...exec(sid).agent.session,
        events: [{
          type: 'user/message',
          data: { source: { kind: 'user', form: 'message' }, content: [{ type: 'text', text: '只回复收到，不要执行任务' }] },
        }],
      },
    };
    let mainModelRequests = 1;
    for (const handler of events.get('agent/turn-stopping') || []) await handler({ agent });
    mainModelRequests += steers.length;
    assert.equal(mainModelRequests, 1);
    assert.equal(steers.length, 0);
    const current = readProjectRun(store, sid, run.runId);
    assert.equal(current.state, 'running', 'a temporary reply must not cancel the active run');
    assert.equal(current.continuationPaused, true, 'only automatic continuation is paused');
  });

  await test('project_document list / read / search 可用', async () => {
    const { run } = prepareProject('pt-doc');
    const tool = tools.get('project_document');
    assert(tool, 'project_document 已注册');
    const listed = await tool.execute({ action: 'list' }, exec('pt-doc'));
    assert.equal(listed.ok, true, listed.error);
    assert(listed.text.includes('测试要求.docx'));
    const read = await tool.execute({ action: 'read', sourceId: 'doc-1', sectionId: 'p1' }, exec('pt-doc'));
    assert.equal(read.ok, true, read.error);
    assert(read.text.includes('员工只能查看自己的资料'));
    const search = await tool.execute({ action: 'search', query: '审批' }, exec('pt-doc'));
    assert.equal(search.ok, true, search.error);
    assert(search.text.includes('审批'));
    upsertProjectSource(store, 'pt-doc', {
      sourceId: 'doc-many', sourceRevision: 'r1', displayName: '长目录.txt', parseState: 'ready',
      sections: Array.from({ length: 45 }, (_, index) => ({ sectionId: 's' + (index + 1), text: '段落 ' + (index + 1) })),
    });
    const page1 = await tool.execute({ action: 'list', limit: 10 }, exec('pt-doc'));
    assert.equal(page1.more, true);
    assert.equal(page1.nextCursor, 10);
    const page2 = await tool.execute({ action: 'list', cursor: page1.nextCursor, limit: 20 }, exec('pt-doc'));
    assert(page2.entries.some(entry => entry.sectionId === 's11'), '目录分页必须覆盖后续段落');
    const batch = await invoke('pt-doc', 'project_document', {action:'read',sourceId:'doc-many',sectionIds:['s1','s2','s45'],limit:16});
    assert(batch.ok, batch.error);
    assert.equal(batch.entries.length,2);
    assert.deepEqual(batch.unreadSectionIds,['s45']);
    const mixed = await invoke('pt-doc','project_document',{action:'read',sourceId:'doc-many',sectionIds:['s1'],cursor:1});
    assert.equal(mixed.ok,false);
  });

  await test('批量读取只为真正返回的范围登记覆盖，截断和未返回段不能声明已整理', async () => {
    const sid='pt-batch-read';
    upsertProjectSource(store,sid,{sourceId:'batch-doc',sourceRevision:'r1',displayName:'批量样本',kind:'text',parseState:'ready',sections:[
      {sectionId:'a',text:'abcd'},{sectionId:'b',text:'0123456789'},{sectionId:'tail',text:'末尾要求'},
    ]});
    await dispatch(ctx,store,'project.start',{sessionId:sid,autoStart:false,policy:{question:'批量覆盖',target:origin}});
    const read=await invoke(sid,'project_document',{action:'read',sourceId:'batch-doc',sectionIds:['a','b','tail'],limit:8});
    assert(read.ok,read.error);assert.deepEqual(read.unreadSectionIds,['tail']);
    const decide=sectionId=>invoke(sid,'project_check',{action:'define',sectionDecisions:[{sourceId:'batch-doc',sourceRevision:'r1',sectionId,decision:'reference',rationale:'合成参考资料'}]});
    const a=await decide('a');assert(a.ok,a.error);
    for(const id of ['b','tail']){const rejected=await decide(id);assert.equal(rejected.ok,false);assert.match(rejected.error,/尚未完整读取/);}
    const rest=await invoke(sid,'project_document',{action:'read',sourceId:'batch-doc',sectionId:'b',cursor:4});assert(rest.ok,rest.error);
    const b=await decide('b');assert(b.ok,b.error);
    const invalid=await invoke(sid,'project_document',{action:'read',sourceId:'batch-doc',sectionIds:['tail','missing']});assert.equal(invalid.ok,false);
    const stillUnread=await decide('tail');assert.equal(stillUnread.ok,false);assert.match(stillUnread.error,/尚未完整读取/);
    const tail=await invoke(sid,'project_document',{action:'read',sourceId:'batch-doc',sectionIds:['tail']});assert(tail.ok,tail.error);
    const accepted=await decide('tail');assert(accepted.ok,accepted.error);
  });

  await test('competition task attachments remain readable with knowledge disabled and UTF-8 prompt paging advances', async () => {
    const sid = 'pt-competition-material';
    writeSceneContext(store, sid, 'competition', { presetId: 'ctf-solver' });
    const prompt = 'HEAD-' + '中文🙂'.repeat(2400) + '-TAIL';
    const challenge = createCompetitionChallenge(store, sid, {
      title: '附件与长题面', prompt, environment: { kind: 'host' },
    });
    setCurrentCompetitionChallenge(store, sid, challenge.challengeId);
    const attachmentFile = path.join(home, 'competition-input.txt');
    fs.writeFileSync(attachmentFile, '附件中的关键说明 COMPETITION_INPUT_OK');
    const attachmentId = 'competition-attachment-fixture';
    store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
      .run(sid, attachmentId, attachmentFile, 'fixture-digest', JSON.stringify({
        id: attachmentId, name: 'competition-input.txt', path: attachmentFile, digest: 'fixture-digest',
        bytes: fs.statSync(attachmentFile).size, source: 'competition-attachment',
      }));
    store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
      .run(sid, 'knowledge-hidden', '', 'knowledge-digest', JSON.stringify({
        id: 'knowledge-hidden', name: 'knowledge.txt', file: attachmentFile, digest: 'knowledge-digest',
        bytes: fs.statSync(attachmentFile).size, source: 'local-knowledge-snapshot',
      }));
    const material = tools.get('saker_material');
    const ctfExec = { agent: { session: { id: sid, header: { agentPreset: 'ctf-solver', cwd: home } } } };
    const first = await material.execute({ action: 'current' }, ctfExec);
    assert.equal(first.ok, true, first.error);
    assert(Buffer.byteLength(first.prompt) <= 8192);
    assert.doesNotMatch(first.prompt, /\uFFFD/);
    assert(first.nextOffset > 0);
    const second = await material.execute({ action: 'current', offset: first.nextOffset }, ctfExec);
    assert.equal(second.ok, true, second.error);
    assert.equal(second.range.start, first.nextOffset);
    assert.notEqual(second.prompt, first.prompt);
    assert(second.nextOffset === null || second.nextOffset > first.nextOffset);
    assert.doesNotMatch(second.prompt, /\uFFFD/);
    const read = await material.execute({ action: 'read', id: attachmentId }, ctfExec);
    assert.equal(read.ok, true, read.error);
    assert.match(read.content, /COMPETITION_INPUT_OK/);
    const listed = await material.execute({ action: 'list', limit: 20 }, ctfExec);
    assert.equal(listed.ok, true, listed.error);
    assert(listed.rows.some(row => row.id === attachmentId));
    assert(!listed.rows.some(row => row.id === 'knowledge-hidden'), 'knowledge snapshots belong to the optional knowledge tool, not task materials');
  });

  await test('比赛题面读取优先使用会话实际 preset，不因旧 header 或组合缓存误报场景冲突', async () => {
    const sid = 'ctf-composed-preset-current';
    writeSceneContext(store, sid, 'competition', { presetId: 'ctf-solver' });
    const challenge = createCompetitionChallenge(store, sid, {
      title: '组合 preset 题面', prompt: 'COMPOSED_PRESET_MARKER',
    });
    setCurrentCompetitionChallenge(store, sid, challenge.challengeId);
    const previous = ctx.agentPresets;
    ctx.agentPresets = { composedPreset: () => 'pentest' };
    try {
      const result = await tools.get('saker_material').execute({ action: 'current' }, {
        agent: { session: { id: sid, mode: 'ctf-solver', header: { agentPreset: 'pentest' } } },
      });
      assert.equal(result.ok, true, result.error);
      assert.match(result.prompt, /COMPOSED_PRESET_MARKER/);
    } finally {
      if (previous === undefined) delete ctx.agentPresets;
      else ctx.agentPresets = previous;
    }
  });

  await test('场景 RPC 与比赛控制使用实际组合 preset，不读取过期的 header', async () => {
    const sid = 'ctf-composed-preset-rpc';
    const previousSessions = ctx.sessions;
    ctx.sessions = {
      get: id => id === sid
        ? { id, mode: 'ctf-solver', header: { agentPreset: 'pentest' } }
        : { id, mode: 'pentest', header: { agentPreset: 'pentest' } },
    };
    try {
      const bound = await dispatch(ctx, store, 'scene.bind', {
        sessionId: sid, scene: 'competition', expectedRevision: 0, requestId: 'composed-preset-rpc-bind',
      });
      assert.equal(bound.sceneId, 'competition');
      const challenge = createCompetitionChallenge(store, sid, {
        title: '组合 preset 控制题', prompt: 'COMPOSED_RPC_MARKER',
      });
      setCurrentCompetitionChallenge(store, sid, challenge.challengeId);
      const paused = await dispatch(ctx, store, 'scene.task-control', { sessionId: sid, action: 'pause' });
      assert.equal(paused.ok, true);
      const current = await dispatch(ctx, store, 'scene.get', { sessionId: sid });
      assert.equal(current.sceneId, 'competition');
      assert.equal(current.continuationPaused, true);
    } finally {
      ctx.sessions = previousSessions;
    }
  });

  await test('disabled competition collaboration is rejected before creating a task policy', async () => {
    const sid = 'pt-competition-no-workers';
    writeSceneContext(store, sid, 'competition', { presetId: 'ctf-solver' });
    setCompetitionPreferences(store, sid, { workers: 0 });
    const ctfExec = { agent: { session: { id: sid, header: { agentPreset: 'ctf-solver', cwd: home } } } };
    const result = await tools.get('saker_assist').execute({ goal: '并行检查一个独立问题' }, ctfExec);
    assert.equal(result.ok, false);
    assert.match(result.error, /协作人数为0/);
    assert.equal(readTaskPolicy(store, sid), null, 'a refused collaboration must not create or advance the parent task policy');
  });

  await test('project_check next / record / detail 可用', async () => {
    const { run, check } = prepareProject('pt-check');
    const tool = tools.get('project_check');
    assert(tool, 'project_check 已注册');
    const next = await tool.execute({ action: 'next' }, exec('pt-check'));
    assert.equal(next.ok, true, next.error);
    assert.equal(next.check.checkId, check.checkId);
    const finding = verifiedFinding('pt-check', '项目证据关联样本');
    const invalid = await tool.execute({ action: 'record', checkId: check.checkId, verdict: 'issue', checkedContent: '无引用样本', findingRefs: ['missing'] }, exec('pt-check'));
    assert.equal(invalid.ok, false);
    const recorded = await tool.execute({ action: 'record', checkId: check.checkId, verdict: 'issue', checkedContent: '员工 B 读到员工 A 的电话', findingRefs: [finding.id] }, exec('pt-check'));
    assert.equal(recorded.ok, true, recorded.error);
    assert.equal(recorded.check.verdict, 'issue');
    const detail = await tool.execute({ action: 'detail', checkId: check.checkId }, exec('pt-check'));
    assert.equal(detail.ok, true, detail.error);
    assert.equal(detail.check.checkedContent, '员工 B 读到员工 A 的电话');
  });

  await test('project_check next / detail 对可选动作字段保持无损 JSON', async () => {
    const sid = 'pt-check-lossless';
    const { run, check } = prepareProject(sid);

    await invoke(sid, 'project_check', { action: 'next' });
    const observed = await invoke(sid, 'project_request', {
      method: 'GET', url: origin + '/lossless-http', checkId: check.checkId,
    });
    assert.equal(observed.ok, true, observed.error);
    const httpAction = listProjectActions(store, sid, run.runId).find(action => action.checkId === check.checkId);
    assert(httpAction, 'project_request 必须留下实际动作');

    const next = await invoke(sid, 'project_check', { action: 'next' });
    assert.equal(next.ok, true, next.error);
    const nextHttpAction = next.actions.find(action => action.actionId === httpAction.actionId);
    assert(nextHttpAction, 'next 必须返回当前检查已有动作');
    assert.equal(nextHttpAction.requestRef, httpAction.requestRef);
    assert.equal(nextHttpAction.pageRef, null);
    assert.equal(nextHttpAction.reconciliation, null);

    const detail = await invoke(sid, 'project_check', { action: 'detail', checkId: check.checkId });
    assert.equal(detail.ok, true, detail.error);
    assert.equal(detail.actions.find(action => action.actionId === httpAction.actionId)?.pageRef, null);

    const [browserCheck] = defineProjectChecks(store, sid, run.runId, [{
      checkId: 'lossless-browser', requirement: '浏览器观察动作没有 requestRef',
    }]);
    const browserBegun = beginProjectAction(store, sid, run.runId, browserCheck.checkId, { method: 'GET', targetUrl: origin + '/page' });
    finishProjectAction(store, sid, run.runId, browserBegun.action.actionId, {
      executionState: 'completed', pageRef: 'project-observation-lossless-browser',
    });
    const browserDetail = await invoke(sid, 'project_check', { action: 'detail', checkId: browserCheck.checkId });
    assert.equal(browserDetail.ok, true, browserDetail.error);
    assert.equal(browserDetail.actions[0].requestRef, null);
    assert.equal(browserDetail.actions[0].pageRef, 'project-observation-lossless-browser');
    assert.equal(browserDetail.actions[0].reconciliation, null);

    const [reconciledCheck] = defineProjectChecks(store, sid, run.runId, [{
      checkId: 'lossless-reconciled', requirement: '核对结果也必须保持无损 JSON',
    }]);
    const reconciledBegun = beginProjectAction(store, sid, run.runId, reconciledCheck.checkId, { method: 'POST', targetUrl: origin + '/write' });
    finishProjectAction(store, sid, run.runId, reconciledBegun.action.actionId, {
      executionState: 'unknown', sideEffectUnknown: true, error: '合成断流',
    });
    reconcileProjectAction(store, sid, run.runId, reconciledBegun.action.actionId, {
      outcome: 'occurred', reason: '独立只读记录确认合成写入已经发生', evidenceRefs: [],
    });
    const reconciledDetail = await invoke(sid, 'project_check', { action: 'detail', checkId: reconciledCheck.checkId });
    assert.equal(reconciledDetail.ok, true, reconciledDetail.error);
    assert.equal(reconciledDetail.actions[0].requestRef, null);
    assert.equal(reconciledDetail.actions[0].pageRef, null);
    assert.deepEqual(reconciledDetail.actions[0].reconciliation, {
      outcome: 'occurred',
      reason: '独立只读记录确认合成写入已经发生',
      evidenceRefs: [],
      at: reconciledDetail.actions[0].reconciliation.at,
    });
    assert.match(reconciledDetail.actions[0].reconciliation.at, /^\d{4}-\d{2}-\d{2}T/);
  });

  await test('完整结论必须引用本次动作、复用观测或已复核 finding', async () => {
    const sid = 'pt-check-evidence';
    const { run, check } = prepareProject(sid);
    const tool = tools.get('project_check');
    await tool.execute({ action: 'next' }, exec(sid));
    const emptyNegative = await tool.execute({
      action: 'record', checkId: check.checkId, verdict: 'not_found', checkedContent: '尚未执行任何动作',
    }, exec(sid));
    assert.equal(emptyNegative.ok, false, '空动作不能保存完整 not_found');

    const observed = await tools.get('project_request').execute({
      method: 'GET', url: origin + '/evidence', checkId: check.checkId,
    }, exec(sid));
    assert.equal(observed.ok, true, observed.error);
    const directNegative = await tool.execute({
      action: 'record', checkId: check.checkId, verdict: 'not_found', checkedContent: '受控接口实际返回 200 和标记',
    }, exec(sid));
    assert.equal(directNegative.ok, true, directNegative.error);
    const actionId = listProjectActions(store, sid, run.runId)[0].actionId;

    const [second] = defineProjectChecks(store, sid, run.runId, [{ checkId: 'reuse-check', requirement: '复用同一观测判断另一条要求' }]);
    const next = await tool.execute({ action: 'next' }, exec(sid));
    assert.equal(next.check.checkId, second.checkId);
    const missingReuse = await tool.execute({
      action: 'record', checkId: second.checkId, verdict: 'not_found', checkedContent: '只说复用但没有引用',
    }, exec(sid));
    assert.equal(missingReuse.ok, false, '模型文字不能代替具体复用引用');
    const reused = await tool.execute({
      action: 'record', checkId: second.checkId, verdict: 'not_found', checkedContent: '同一页面内容覆盖第二条要求',
      reusedObservations: [{ actionId, reason: '同一受控页面的实际响应同时包含第二条要求所需标记' }],
    }, exec(sid));
    assert.equal(reused.ok, true, reused.error);

    const [third] = defineProjectChecks(store, sid, run.runId, [{ checkId: 'issue-check', requirement: '确认受控问题' }]);
    await tool.execute({ action: 'next' }, exec(sid));
    const emptyIssue = await tool.execute({
      action: 'record', checkId: third.checkId, verdict: 'issue', checkedContent: '没有 finding 引用',
    }, exec(sid));
    assert.equal(emptyIssue.ok, false);
    const pending = registerFinding(store, sid, 'pentest', { title: '尚未复核', severity: 'medium', target: origin });
    const pendingIssue = await tool.execute({
      action: 'record', checkId: third.checkId, verdict: 'issue', checkedContent: '引用尚未复核问题', findingRefs: [pending.id],
    }, exec(sid));
    assert.equal(pendingIssue.ok, false, '未复核 finding 不能支撑完整 issue');
    const verified = verifiedFinding(sid, '已复核项目问题');
    const issue = await tool.execute({
      action: 'record', checkId: third.checkId, verdict: 'issue', checkedContent: '已复核对象存在越权读取',
      findingRefs: [verified.id],
    }, exec(sid));
    assert.equal(issue.ok, true, issue.error);

    const paused = prepareProject('pt-store-paused');
    transitionProjectRun(store, 'pt-store-paused', paused.run.runId, 'paused', paused.run.controlRev, { blocker: { code: 'needs-user' } });
    assert.throws(() => recordProjectCheck(store, 'pt-store-paused', paused.run.runId, paused.check.checkId, {
      executionState: 'ended', verdict: 'not_found', checkedContent: '暂停后的迟到结论',
      controlRev: paused.run.controlRev + 1,
    }), /暂停|状态已变化/);
  });

  await test('project_request 自动绑定当前检查并保存回执', async () => {
    const { run, check } = prepareProject('pt-request');
    const tool = tools.get('project_request');
    assert(tool, 'project_request 已注册');
    const result = await tool.execute({ method: 'GET', url: origin + '/api/ok', checkId: check.checkId }, exec('pt-request'));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.status, 200);
    assert(result.executionId.startsWith('execution-'));
  });

  await test('项目问题登记自动关联当前回执，复核后才能用于当前检查', async () => {
    const sid = 'pt-finding-auto-evidence';
    const { check } = prepareProject(sid);
    await invoke(sid, 'project_check', { action: 'next' });
    const observed = await invoke(sid, 'project_request', { url: origin + '/api/ok' });
    assert(observed.ok, observed.error);
    const registered = await invoke(sid, 'redteam_finding_register', {
      title: '合成权限问题', summary: '本地受控样本', target: origin + '/api/ok', severity: 'medium', evidenceLevel: 'confirmed',
      evidence: 'SAKER_PROJECT_TOOL', impact: '仅验证项目证据归属', fix: '这是合成用例',
    });
    assert(registered.ok, registered.error);
    const row = store.get.get(sid, registered.id);
    assert(JSON.parse(row.evidence_refs).some(ref => ref.id === observed.executionId));
    const updated = await invoke(sid, 'redteam_finding_update', {
      id: registered.id, status: 'verified', secondRating: 'medium',
      secondRatingNote: '本地合成复核重新读取已保存的项目回执，核对当前运行、检查项、实际响应标记和对象说明，本测试仅证明证据归属机制，不证明真实业务漏洞。',
    });
    assert(updated.ok, updated.error);
    const recorded = await invoke(sid, 'project_check', {
      action: 'record', checkId: check.checkId, verdict: 'issue', findingRefs: [registered.id], checkedContent: '实际回执与已复核合成问题已关联',
    });
    assert(recorded.ok, recorded.error);
  });

  await test('非项目场景拒绝项目工具，不跨场景复用', async () => {
    startTaskPolicy(store, 'pt-pentest', { mode: 'regular', question: '常规测试', budget: { toolCalls: 5 } });
    const tool = tools.get('project_check');
    const result = await tool.execute({ action: 'next' }, exec('pt-pentest'));
    assert.equal(result.ok, false);
    assert.match(String(result.error), /案例测试/);
  });

  await test('project_evidence records actual file and command evidence for case results', async () => {
    const sid = 'pt-evidence-tools';
    const { run, check } = prepareProject(sid);
    await tools.get('project_check').execute({ action: 'next' }, exec(sid));
    const file = path.join(home, 'case-evidence.txt');
    fs.writeFileSync(file, 'expected export fields: id,name\nobserved: id,name\n');
    const fileResult = await tools.get('project_evidence').execute({ action: 'file', checkId: check.checkId, path: file, limit: 200 }, exec(sid));
    assert.equal(fileResult.ok, true, fileResult.error);
    assert(fileResult.evidenceId.startsWith('project-evidence-'));
    const counter = path.join(home, 'case-command-count.txt');
    const script = path.join(home, 'case-command-once.mjs');
    fs.writeFileSync(script, "import fs from 'node:fs';fs.appendFileSync(process.argv[2],'once\\n');process.stdout.write('CASE_EVIDENCE\\n')\n");
    const commandResult = await tools.get('project_evidence').execute({
      action: 'command', checkId: check.checkId, command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(script) + ' ' + JSON.stringify(counter),
      cwd: home, timeoutMs: 5000,
    }, exec(sid));
    assert.equal(commandResult.ok, true, commandResult.error);
    assert.match(commandResult.observation.stdout, /CASE_EVIDENCE/)
    assert.equal(fs.readFileSync(counter, 'utf8'), 'once\n')
    assert.match(commandResult.note, /同一 operationId/)
    const recorded = await tools.get('project_check').execute({
      action: 'record', checkId: check.checkId, verdict: 'expectation_met',
      checkedContent: 'The export and local check produced the expected observed fields',
      evidenceRefs: [fileResult.evidenceId, commandResult.evidenceId],
    }, exec(sid));
    assert.equal(recorded.ok, true, recorded.error);
    assert.equal(recorded.check.findingRefs.length, 0);
    assert.equal(recorded.check.evidenceRefs.length, 2);
    assert.equal(listProjectActions(store, sid, run.runId).every(action => action.checkId === check.checkId), true);

    const large = path.join(home, 'case-large.bin');
    const largeBytes = Buffer.alloc(2 * 1024 * 1024 + 37, 0x61);
    largeBytes.write('TAIL-EVIDENCE', largeBytes.length - 13, 'utf8');
    fs.writeFileSync(large, largeBytes);
    const rangeResult = await tools.get('project_evidence').execute({
      action: 'file', checkId: check.checkId, path: large, offset: largeBytes.length - 13, limit: 13,
    }, exec(sid));
    assert.equal(rangeResult.ok, true, rangeResult.error);
    const rangeRow = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?')
      .get(sid, rangeResult.evidenceId);
    const rangeRecord = JSON.parse(rangeRow.record);
    assert.equal(rangeRecord.text, 'TAIL-EVIDENCE');
    assert.equal(rangeRecord.complete, true);
    assert.equal(rangeRecord.sha256, crypto.createHash('sha256').update(largeBytes).digest('hex'));
  });

  await test('project_evidence source must belong to the run snapshot and have been read', async () => {
    const sid = 'pt-evidence-source';
    const imported = await dispatch(ctx, store, 'project.import', {
      sessionId: sid, name: 'source-evidence.txt', text: 'unused seed',
    });
    upsertProjectSource(store, sid, {
      sourceId: imported.source.sourceId,
      sourceRevision: imported.source.sourceRevision,
      displayName: 'source-evidence.txt',
      kind: 'text',
      parseState: 'ready',
      sections: [
        { sectionId: 'p1', kind: 'paragraph', text: 'READ-ME evidence' },
        { sectionId: 'p2', kind: 'paragraph', text: 'NOT-READ evidence' },
      ],
    });
    await dispatch(ctx, store, 'project.start', {
      sessionId: sid, autoStart: false, policy: { question: 'source evidence', allowTargetNetwork: false },
    });
    const defined = await invoke(sid, 'project_check', {
      action: 'define', checks: [{ requirement: 'verify source range' }],
    });
    const read = await invoke(sid, 'project_document', {
      action: 'read', sourceId: imported.source.sourceId, sourceRevision: imported.source.sourceRevision, sectionId: 'p1',
    });
    assert.equal(read.ok, true, read.error);
    const next = await invoke(sid, 'project_check', { action: 'next' });
    assert.equal(next.ok, true, next.error);
    const accepted = await invoke(sid, 'project_evidence', {
      action: 'source', checkId: next.check.checkId, sourceId: imported.source.sourceId,
      sourceRevision: imported.source.sourceRevision, sectionId: 'p1', text: 'READ-ME evidence',
    });
    assert.equal(accepted.ok, true, accepted.error);
    const unread = await invoke(sid, 'project_evidence', {
      action: 'source', checkId: next.check.checkId, sourceId: imported.source.sourceId,
      sourceRevision: imported.source.sourceRevision, sectionId: 'p2', text: 'NOT-READ evidence',
    });
    assert.equal(unread.ok, false);
    assert.match(unread.error, /has not been read/);
    upsertProjectSource(store, sid, {
      sourceId: 'outside-snapshot', sourceRevision: 'r1', displayName: 'outside.txt',
      kind: 'text', parseState: 'ready', sections: [{ sectionId: 'p1', text: 'OUTSIDE evidence' }],
    });
    const outside = await invoke(sid, 'project_evidence', {
      action: 'source', checkId: next.check.checkId, sourceId: 'outside-snapshot',
      sourceRevision: 'r1', sectionId: 'p1', text: 'OUTSIDE evidence',
    });
    assert.equal(outside.ok, false);
    assert.match(outside.error, /not part of the current project run/);
  });

  const cft = process.env.SAKER_SKIP_CFT_TESTS !== '1' && (process.env.SAKER_CFT_PATH
    || ['E:/software/ChromeForTesting/chrome-win64/chrome.exe', 'E:/software/ChromeForTesting/chrome.exe'].find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }));
  if (cft) {
    process.env.SAKER_CFT_PATH = cft;
    await test('自由测试可直接使用受管浏览器，不要求项目检查', async () => {
      startTaskPolicy(store, 'pt-free-browser', { mode: 'regular', target: origin, question: '直接打开授权页面做观察', budget: { toolCalls: 5 } });
      const tool = tools.get('saker_browser');
      const opened = await tool.execute({ action: 'open', url: origin + '/page' }, exec('pt-free-browser'));
      assert.equal(opened.ok, true, opened.error);
      assert.equal(String(opened.observationRef).startsWith('free-browser-observation-'), true);
      assert(store.db.prepare('SELECT 1 FROM business_materials WHERE session_id=? AND id=?').get('pt-free-browser', opened.observationRef));
      const observed = await tool.execute({ action: 'observe' }, exec('pt-free-browser'));
      assert.equal(observed.ok, true, observed.error);
      assert(store.db.prepare('SELECT 1 FROM business_materials WHERE session_id=? AND id=?').get('pt-free-browser', observed.observationRef));
      assert.equal(listProjectActions(store, 'pt-free-browser', 'not-a-project').length, 0);
      const closed = await tool.execute({ action: 'close' }, exec('pt-free-browser'));
      assert.equal(closed.ok, true, closed.error);
    });
    await test('saker_browser open / observe / close 可用', async () => {
      const { run } = prepareProject('pt-browser');
      const tool = tools.get('saker_browser');
      assert(tool, 'saker_browser 已注册');
      const opened = await tool.execute({ action: 'open', url: origin + '/page' }, exec('pt-browser'));
      assert.equal(opened.ok, true, opened.error);
      const actions = listProjectActions(store, 'pt-browser', run.runId);
      assert.equal(actions.length, 1, '浏览器目标动作必须留下项目动作记录');
      assert.equal(actions[0].executionState, 'completed');
      const observed = await tool.execute({ action: 'observe' }, exec('pt-browser'));
      assert.equal(observed.ok, true, observed.error);
      assert.equal(readTaskPolicy(store, 'pt-browser').used.toolCalls, 1, '观察不额外扣目标额度');
      const browserCheck = listProjectChecks(store, 'pt-browser', run.runId)[0];
      const missing = await tool.execute({
        action: 'act', actType: 'click', selector: '#missing', checkId: browserCheck.checkId,
      }, exec('pt-browser'));
      assert.equal(missing.ok, false);
      assert.match(missing.error, /element-not-found|找不到|failed/i);
      assert.equal(listProjectActions(store, 'pt-browser', run.runId).at(-1).executionState, 'failed');
      await tool.execute({ action: 'open', url: origin + '/download-page', checkId: browserCheck.checkId }, exec('pt-browser'));
      const downloaded = await tool.execute({
        action: 'act', actType: 'download', selector: '#download', checkId: browserCheck.checkId,
        directory: path.join(home, 'tool-downloads'),
      }, exec('pt-browser'));
      assert.equal(downloaded.ok, true, downloaded.error);
      assert.equal(downloaded.result.completed, true, JSON.stringify(downloaded.result));
      assert(downloaded.result.attachmentRef.startsWith('project-attachment-'));
      const material = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get('pt-browser', downloaded.result.attachmentRef);
      assert(material);
      await dispatch(ctx, store, 'project.pause', { sessionId: 'pt-browser', runId: run.runId });
      const pausedOpen = await tool.execute({ action: 'open', url: origin + '/paused' }, exec('pt-browser'));
      assert.equal(pausedOpen.ok, false);
      assert.match(pausedOpen.error, /不可派发|已暂停/);
      const closed = await tool.execute({ action: 'close' }, exec('pt-browser'));
      assert.equal(closed.ok, true, closed.error);
    });
    await test('项目浏览器使用同一任务范围访问第二个 origin', async () => {
      const sid = 'pt-browser-second-origin';
      const { run } = prepareProject(sid);
      setTaskActionLimits(store, sid, { allowedOrigins: [secondOrigin] }, 'desktop-user');
      const tool = tools.get('saker_browser');
      const opened = await tool.execute({ action: 'open', url: secondOrigin + '/page' }, exec(sid));
      assert.equal(opened.ok, true, opened.error);
      assert.equal(opened.page?.url, secondOrigin + '/page');
      assert.equal(listProjectActions(store, sid, run.runId).at(-1).executionState, 'completed');
      const closed = await tool.execute({ action: 'close' }, exec(sid));
      assert.equal(closed.ok, true, closed.error);
    });
    await test('人工接管保留同一浏览器，人工流量归属清楚，继续前先观察且预算不变', async () => {
      const tool = tools.get('saker_browser');

      const freeId = 'pt-manual-free';
      startTaskPolicy(store, freeId, {
        mode: 'regular', target: origin, question: '人工接管自由测试',
        budget: { toolCalls: 8, modelCalls: 4 },
      });
      const freeOpen = await tool.execute({ action: 'open', url: origin + '/page' }, exec(freeId));
      assert.equal(freeOpen.ok, true, freeOpen.error);
      const freeSettings = await dispatch(ctx, store, 'chat.settings', { sessionId: freeId });
      assert.equal(freeSettings.browserTakeover?.open, true, '聊天状态栏必须拿到真实浏览器接管状态');
      assert.equal(freeSettings.browserTakeover?.headless, process.env.SAKER_CFT_HEADLESS === '1');
      finishTaskOnTurnEnd(store, freeId);
      assert.equal(taskPolicyStatus(store, freeId).reason, 'turn_ended', '人工接管必须能接住已结束模型回合但浏览器仍开着的场景');
      const freeBefore = readTaskPolicy(store, freeId);
      const freeTaken = await dispatch(ctx, store, 'task.takeover', {
        sessionId: freeId, expectedPolicyRev: freeBefore.policyRev,
      });
      assert.equal(freeTaken.ok, true, freeTaken.error);
      assert.equal(freeTaken.manualTakeover.active, true);
      assert.equal(freeTaken.browser.open, true);
      assert.equal(freeTaken.browser.identityRef, '');
      const freeBlocked = await tool.execute({ action: 'open', url: origin + '/blocked' }, exec(freeId));
      assert.equal(freeBlocked.ok, false, '人工接管期间模型不能继续派发浏览器动作');
      await clickInManagedBrowser(freeId, '#go');
      const freeRequests = await tool.execute({ action: 'requests', limit: 50 }, exec(freeId));
      assert.equal(freeRequests.ok, true, freeRequests.error);
      const humanRequest = freeRequests.requests.entries.find(item => item.url.endsWith('/human-action'));
      assert(humanRequest, '人工点击产生的请求必须进入同一浏览器请求记录');
      assert.equal(humanRequest.source, 'human-takeover');
      const freeResumeResults = await Promise.allSettled([
        dispatch(ctx, store, 'task.takeover-resume', {
          sessionId: freeId, expectedPolicyRev: freeTaken.policyRev,
        }),
        dispatch(ctx, store, 'task.takeover-resume', {
          sessionId: freeId, expectedPolicyRev: freeTaken.policyRev,
        }),
      ]);
      assert.equal(freeResumeResults.filter(item => item.status === 'fulfilled').length, 1, '两个窗口同时继续时只能有一个执行者');
      assert.equal(freeResumeResults.filter(item => item.status === 'rejected').length, 1);
      const freeResumed = freeResumeResults.find(item => item.status === 'fulfilled').value;
      assert.equal(freeResumed.ok, true, freeResumed.error);
      assert(freeResumed.observationRef);
      assert.equal(freeResumed.browser.open, true);
      const freeAfter = readTaskPolicy(store, freeId);
      assert.equal(freeAfter.used.toolCalls, freeBefore.used.toolCalls, '人工操作不消耗模型目标动作预算');
      assert.equal(freeAfter.budget.modelCalls, freeBefore.budget.modelCalls);
      assert.equal(freeAfter.manualTakeover, undefined);
      assert.equal(taskPolicyStatus(store, freeId).stopped, false, '接管继续后必须真正回到可执行状态');
      const freeClose = await tool.execute({ action: 'close' }, exec(freeId));
      assert.equal(freeClose.ok, true, freeClose.error);

      const projectId = 'pt-manual-project';
      const { run } = prepareProject(projectId);
      const projectOpen = await tool.execute({ action: 'open', url: origin + '/page' }, exec(projectId));
      assert.equal(projectOpen.ok, true, projectOpen.error);
      const projectBefore = readTaskPolicy(store, projectId);
      const projectTaken = await dispatch(ctx, store, 'task.takeover', {
        sessionId: projectId, expectedPolicyRev: projectBefore.policyRev, runId: run.runId,
      });
      assert.equal(projectTaken.ok, true, projectTaken.error);
      assert.equal(projectTaken.run.state, 'paused');
      assert.equal(projectTaken.browser.open, true);
      const projectBlocked = await tool.execute({ action: 'open', url: origin + '/blocked' }, exec(projectId));
      assert.equal(projectBlocked.ok, false, '项目人工接管期间模型不能继续派发');
      await clickInManagedBrowser(projectId, '#go');
      const projectResumed = await dispatch(ctx, store, 'task.takeover-resume', {
        sessionId: projectId, expectedPolicyRev: projectTaken.policyRev,
        runId: run.runId, expectedControlRev: projectTaken.run.controlRev,
      });
      assert.equal(projectResumed.ok, true, projectResumed.error);
      assert(projectResumed.observationRef);
      assert.equal(projectResumed.run.state, 'preparing');
      assert.equal(readTaskPolicy(store, projectId).used.toolCalls, projectBefore.used.toolCalls);
      assert.equal(readTaskPolicy(store, projectId).manualTakeover, undefined);
      const projectClose = await tool.execute({ action: 'close' }, exec(projectId));
      assert.equal(projectClose.ok, true, projectClose.error);
    });
  } else {
    console.log('skip saker_browser 真实 CfT 不在本机');
  }
} finally {
  for (const dispose of disposers.reverse()) { try { await dispose(); } catch { /* 已关闭 */ } }
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  secondServer.closeAllConnections?.();
  await new Promise(resolve => secondServer.close(resolve));
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
