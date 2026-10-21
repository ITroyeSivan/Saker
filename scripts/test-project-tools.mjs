// W06：模型侧项目工具（project_document / project_check / project_request / saker_browser）。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore, registerFinding, updateFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, taskPolicyStatus, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, upsertProjectSource, readProjectRun, listProjectChecks, listProjectActions, recordProjectCheck } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { projectTurnDecision, completeProjectRun } from '../plugins/dsh-redteam-results/lib/project-runtime.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-tools-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const disposers = [];
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const server = http.createServer((request, response) => {
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
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

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
const exec = sid => ({ agent: { session: { id: sid, header: { agentPreset: 'pentest' } } } });
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

function prepareProject(sid) {
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试', target: origin, budget: { minutes: 30 } });
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
  const finding = registerFinding(store, sid, 'pentest', {
    title, severity: 'medium', target: origin, evidenceLevel: 'confirmed',
    evidence: 'SYNTHETIC_PROJECT_EVIDENCE', impact: 'SYNTHETIC_PROJECT_IMPACT',
  });
  return updateFinding(store, sid, 'pentest', finding.id, {
    status: 'verified', secondRating: 'medium',
    secondRatingNote: '独立复核已重新读取本地合成对象，并通过另一条受控观测通道核对证据引用；观察到的对象、权限和响应标记相互一致，结论可以追溯并重复执行。',
    verifyNote: '独立复核完成',
  });
}

try {
  await test('真实项目快照和宿主守卫接受项目场景，文档读取不套旧方向或扫描额度', async () => {
    const sid = 'pt-guarded-entry';
    const started = await dispatch(ctx, store, 'project.start', { sessionId: sid, policy: { question: '读取本地样本', target: origin, budget: { toolCalls: 1 } } });
    upsertProjectSource(store, sid, { sourceId: 'entry-doc', sourceRevision: 'r1', displayName: '入口样本', kind: 'text', parseState: 'ready',
      sections: [{ sectionId: 'p1', text: '仅检查回环服务是否能响应', kind: 'paragraph' }] });
    const snapshot = contexts.find(context => context.name === 'saker-pentest-task-state').text(exec(sid));
    assert.match(snapshot, /按文档连续测试/);
    assert.match(snapshot, /project_document/);
    assert(!snapshot.includes('状态无法读取'), snapshot);
    assert.equal(readTaskPolicy(store, sid).modules, undefined, '项目不能初始化 regular 模块');
    const listed = await invoke(sid, 'project_document', { action: 'list' });
    assert.equal(listed.ok, true, listed.error);
    const read = await invoke(sid, 'project_document', { action: 'read', sourceId: 'entry-doc', sectionId: 'p1' });
    assert.equal(read.ok, true, read.error);
    const defined = await invoke(sid, 'project_check', { action: 'define', checks: [{ requirement: '检查回环响应', sourceLocation: 'entry-doc r1 p1' }] });
    assert.equal(defined.ok, true, defined.error);
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
      sessionId: sid, policy: { question: '按文档测试', budget: { minutes: 30 } }, autoStart: false,
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
    const started = await dispatch(ctx, store, 'project.start', { sessionId: sid, policy: { question: '按修订测试', budget: { minutes: 10 } }, autoStart: false });
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
    assert.equal(steers.length, 2, '第三次无进展必须停止投递');
    assert.equal(readProjectRun(store, sid, run.runId).state, 'paused');
    assert.equal(taskPolicyStatus(store, sid).stopped, true);
    const recorded = await tools.get('project_check').execute({ action: 'record', checkId: check.checkId, verdict: 'not_found', checkedContent: '不应被写入' }, exec(sid));
    assert.equal(recorded.ok, false, '暂停状态不接受迟到结论');
    assert.match(recorded.error, /已暂停/);
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

  await test('非项目场景拒绝项目工具，不跨场景复用', async () => {
    startTaskPolicy(store, 'pt-pentest', { mode: 'regular', question: '常规测试', budget: { toolCalls: 5 } });
    const tool = tools.get('project_check');
    const result = await tool.execute({ action: 'next' }, exec('pt-pentest'));
    assert.equal(result.ok, false);
    assert.match(String(result.error), /按文档测试/);
  });

  const cft = process.env.SAKER_SKIP_CFT_TESTS !== '1' && (process.env.SAKER_CFT_PATH
    || ['E:/software/ChromeForTesting/chrome-win64/chrome.exe', 'E:/software/ChromeForTesting/chrome.exe'].find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }));
  if (cft) {
    process.env.SAKER_CFT_PATH = cft;
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
  } else {
    console.log('skip saker_browser 真实 CfT 不在本机');
  }
} finally {
  for (const dispose of disposers.reverse()) { try { await dispose(); } catch { /* 已关闭 */ } }
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
