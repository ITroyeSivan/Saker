// W06：项目面板渲染验证（统计、检查表、来源、暂停/停止/导出按钮）。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, readTaskPolicy, archiveTaskRound } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { writeTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy-record.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, recordProjectCheck, upsertProjectSource } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { setProjectRunState } from '../plugins/dsh-redteam-results/lib/project-runtime.js';
import { registerVerifiedProjectFinding } from './lib/project-test-fixtures.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-ui-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const ctx = {
  sessions: { get: id => ({ id, header: { agentPreset: 'pentest' } }) },
  agents: { get: () => ({ status: 'idle', followup: () => {} }) },
  tools: { register: () => {}, guard: () => {} },
  webServer: { register: () => () => {} },
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') dispose(); },
  get: () => null,
};
results.apply(ctx);

let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

function prepareProject(sid, tag = '') {
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试人事系统', budget: { minutes: 30 } });
  const run = createProjectRun(store, sid, { question: '按文档测试人事系统' });
  writeTaskPolicy(store, sid, { ...readTaskPolicy(store, sid), projectRunId: run.runId, projectRunState: 'running' }, 'test-project-run-bound');
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  const checks = defineProjectChecks(store, sid, run.runId, [
    { requirement: '员工只能查看自己的资料' + tag, sourceLocation: '表1 第2行' },
    { requirement: '普通员工不能审批' + tag, sourceLocation: '表1 第3行' },
    { requirement: '文件下载权限' + tag, sourceLocation: '表1 第4行' },
  ]);
  const finding = registerVerifiedProjectFinding(store, sid);
  recordProjectCheck(store, sid, run.runId, checks[0].checkId, { executionState: 'ended', verdict: 'issue', checkedContent: '员工 B 读取到员工 A 的电话', findingRefs: [finding.id] });
  recordProjectCheck(store, sid, run.runId, checks[1].checkId, { executionState: 'ended', verdict: 'blocked', gaps: '缺少审批人账号' });
  recordProjectCheck(store, sid, run.runId, checks[2].checkId, { executionState: 'ended', verdict: 'not_found', checkedContent: '已检查自己的文件', gaps: '尚缺另一位员工的文件' });
  const source = upsertProjectSource(store, sid, { sourceId: 'doc-1', sourceRevision: 'rev-1', displayName: '测试要求.xlsx', kind: 'xlsx', parseState: 'ready', sections: [] });
  const frozen = { ...running, sourceSnapshot: [{ sourceId: source.sourceId, sourceRevision: source.sourceRevision, displayName: source.displayName }] };
  store.db.prepare('UPDATE project_runs SET record=? WHERE session_id=? AND run_id=?').run(JSON.stringify(frozen), sid, run.runId);
  return { run: running, checks };
}

const source = fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('function ProjectPanel('), end = source.indexOf('function TaskPanel(', start);
assert(start > 0 && end > start, 'ProjectPanel source located');
const chatStart = source.indexOf('function ProjectChatStatus('), chatEnd = source.indexOf('function TaskPanel(', chatStart);
assert(chatStart > 0 && chatEnd > chatStart, 'ProjectChatStatus source located');
const taskStart = source.indexOf('function TaskPanel('), taskEnd = source.indexOf('function ContextPanel(', taskStart);
assert(taskStart > 0 && taskEnd > taskStart, 'TaskPanel source located');
assert(source.slice(taskStart, taskEnd).includes("status[1](null);error[1]('');records[1]({rows:[],stats:null,loading:true,error:''})"),
  '切换到新会话时必须先清空上一会话的项目状态，不能显示旧检查');
assert(source.includes("key:props.sessionId+'-budget-'+String(!!props.blank)"),
  '空白新会话必须使用独立任务面板实例，不能复用旧会话项目状态');
assert(source.includes("String(run.sessionId)!==String(props.sessionId)"),
  '项目状态必须拒绝显示其他会话的运行');
assert(source.includes('var live=props.session') && source.includes('var blank=props.blank===true||live?.blank===true'),
  '聊天入口必须使用宿主槽传入的当前 session 识别空白会话');
assert(source.includes("workScenario[1](previous);throw failure"),
  '场景切换被宿主拒绝时必须回退，不能显示错误场景');

function mount(sessionId) {
  const state = [];
  let cursor = 0;
  const effects = [];
  const sandbox = {
    useState: initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; },
    useEffect: effect => effects.push(effect),
    useRef: initial => { const index = cursor++; if (!(index in state)) state[index] = { current: initial }; return state[index]; },
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    Btn: 'button',
    downloadArchive: () => {},
    api: async (endpoint, payload) => { try { return await results.dispatch(ctx, store, endpoint, payload); } catch (error) { return { ok: false, error: error.message }; } },
  };
  runInNewContext(source.slice(start, end) + ';this.component=ProjectPanel;', sandbox);
  const render = () => { cursor = 0; return sandbox.component({ sessionId }); };
  render();
  for (const effect of effects.slice()) effect();
  return { render, state };
}

function mountChatStatus(sessionId, status = null, options = {}) {
  const state = [], effects = [], calls = [];
  let cursor = 0;
  const sandbox = {
    useState: initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; },
    useEffect: effect => effects.push(effect),
    useRef: initial => { const index = cursor++; if (!(index in state)) state[index] = { current: initial }; return state[index]; },
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    Btn: 'button',
    downloadArchive: () => {},
    api: async (endpoint, payload) => {
      calls.push({ endpoint, payload: payload || {} });
      const call = async () => { try { return await results.dispatch(ctx, store, endpoint, payload); } catch (error) { return { ok: false, error: error.message }; } };
      return options.api ? options.api(call, endpoint, payload || {}) : call();
    },
  };
  runInNewContext(source.slice(chatStart, chatEnd) + ';this.component=ProjectChatStatus;', sandbox);
  const render = (nextStatus = status) => { cursor = 0; return sandbox.component({ sessionId, status: nextStatus }); };
  render();
  for (const effect of effects.slice()) effect();
  return { render, state, calls };
}

function nodes(node) { if (!node || typeof node !== 'object') return []; return [node, ...node.children.flat(Infinity).flatMap(nodes)]; }
function allValues(node) { if (node === null || node === undefined) return []; if (typeof node !== 'object') return [node]; return [node, ...node.children.flat(Infinity).flatMap(allValues)]; }
const textOf = node => allValues(node).filter(item => typeof item === 'string').join(' ');

try {
  await test('未开始的项目方向在宿主读取和其他设置变更后保留', async () => {
    await results.dispatch(ctx, store, 'task.scenario', { sessionId: 'ui-scenario', scenario: 'project' });
    const first = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-scenario' });
    assert.equal(first.options.scenario, 'project');
    await results.dispatch(ctx, store, 'task.choose', { sessionId: 'ui-scenario', mode: 'regular', workers: 0 });
    const second = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-scenario' });
    assert.equal(second.options.scenario, 'project');
    await results.dispatch(ctx, store, 'task.scenario', { sessionId: 'ui-scenario', scenario: 'pentest' });
    assert.equal((await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-scenario' })).options.scenario, 'pentest');
  });
  await test('项目面板显示统计、检查表与来源', async () => {
    prepareProject('ui-project');
    const ui = mount('ui-project');
    await new Promise(setImmediate);
    const view = ui.render();
    const text = textOf(view);
    assert(text.includes('已执行 3/3'), 'execution completion must be separate from business confirmation：' + JSON.stringify(view).slice(0, 800));
    assert(text.includes('待核对 0'));
    assert(text.includes('缺口 2'));
    assert(text.includes('发现问题 1'));
    assert(text.includes('员工只能查看自己的资料'));
    assert(text.includes('员工 B 读取到员工 A 的电话'));
    assert(text.includes('测试要求.xlsx'));
    assert(text.includes('部分完成 1'));
    const row = nodes(view).find(node => node.type === 'tr' && textOf(node).includes('文件下载权限'));
    assert(row && textOf(row).includes('部分完成'), '部分完成不能显示成未发现问题');
    assert(textOf(row).includes('已检查自己的文件'));
    assert(textOf(row).includes('尚缺另一位员工的文件'), '已检查内容和缺口都须可见');
    assert(text.includes('文档要求') && text.includes('执行') && text.includes('结论／确认') && text.includes('说明'));
  });

  await test('项目面板提供暂停、继续、停止与导出入口', async () => {
    const ui = mount('ui-project');
    await new Promise(setImmediate);
    const view = ui.render();
    const buttons = nodes(view).filter(node => node.type === 'button');
    const labels = buttons.map(node => node.children.flat(Infinity).join(''));
    for (const label of ['暂停', '继续', '停止', '导出结果']) assert(labels.includes(label), '缺少按钮：' + label + '，实际：' + labels.join(','));
  });

  await test('聊天上方项目状态行直接显示进度、当前检查和查看表入口', async () => {
    const status = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-project' });
    const ui = mountChatStatus('ui-project', status);
    await new Promise(setImmediate);
    const view = ui.render();
    const text = textOf(view);
    assert(text.includes('已执行 3/3'), text.slice(0, 500));
    assert(text.includes('当前：') || text.includes('当前没有待执行检查'));
    const buttons = nodes(view).filter(node => node.type === 'button');
    const viewChecks = buttons.find(node => node.children.flat(Infinity).join('') === '查看检查表');
    assert(viewChecks, '聊天状态行必须有查看检查表入口');
    viewChecks.props.onClick();
    const expandedView = ui.render();
    const expanded = textOf(expandedView);
    assert(expanded.includes('测试要求') && expanded.includes('执行情况') && expanded.includes('结论') && expanded.includes('结果说明') && expanded.includes('操作'));
    assert(expanded.includes('员工只能查看自己的资料'));
    const modal = nodes(expandedView).find(node => node.type === 'section' && node.props && node.props.className === 'dsh-project-modal');
    assert(modal, '查看检查表必须打开弹窗而不是撑高聊天区');
    assert.deepEqual(nodes(modal).filter(node => node.type === 'th').map(textOf), ['测试要求','执行情况','结论','结果说明','操作']);
    assert.deepEqual(nodes(modal).filter(node => node.type === 'col').map(node => node.props.style.width), ['30%','12%','16%','34%','8%']);
    const detailButton = nodes(modal).find(node => node.type === 'button' && node.children.flat(Infinity).join('') === '详情');
    assert(detailButton, '每项必须提供完整详情入口');
    detailButton.props.onClick();
    assert(textOf(ui.render()).includes('检查详情') && textOf(ui.render()).includes('检查 ID：'), '详情必须显示完整原文区域');
    const closeModal = nodes(ui.render()).find(node => node.type === 'button' && node.children.flat(Infinity).join('') === '关闭检查表');
    assert(closeModal, '弹窗必须有明确关闭按钮');
    closeModal.props.onClick();
    assert(!nodes(ui.render()).some(node => node.props && node.props.className === 'dsh-project-modal'), '关闭后弹窗必须消失');
    assert(source.includes("React.createElement(ProjectChatStatus,{sessionId:props.sessionId,status:current})"), '项目状态行必须真正挂到聊天设置上方');
    assert(source.includes("||activeScenario==='cases')?React.createElement(ProjectChatStatus"),
      '没有当前任务但场景仍是案例测试时，历史结果入口也必须挂载');
assert(source.includes("policy&&(current.stopped||current.idle)&&!policy.blocker&&!policy.awaitingConfirmation&&!policy.parentSession?React.createElement('button'")
  && source.indexOf("policy&&(current.stopped||current.idle)&&!policy.blocker&&!policy.awaitingConfirmation&&!policy.parentSession?") < source.indexOf("policy&&policy.scenario!=='project'&&!policy.awaitingConfirmation?"),
  '案例任务正常停止后必须保留“新建测试”入口，不能只在自由测试中提供');
    assert(source.includes('检查结果、历史和导出入口在对话上方的项目状态行'), '设置区不能继续复制完整检查表');
    assert(source.includes('用量口径：会话事件调用'), '调用统计必须解释会话事件与准入记账的差异');
    assert.equal(readTaskPolicy(store, 'ui-project').used.toolCalls, 0, '查看与刷新项目状态不能产生目标工具调用');
  });

  await test('人工接管状态只显示“继续测试”，不并列普通继续入口', async () => {
    const before = readTaskPolicy(store, 'ui-project');
    writeTaskPolicy(store, 'ui-project', {
      ...before,
      manualTakeover: {
        active: true, startedAt: Date.now(), source: 'desktop-user', scenario: 'project',
        runId: 'ui-run', controlRev: 1, identityRef: '',
      },
    }, 'manual-takeover-start');
    const panel = mount('ui-project');
    await new Promise(setImmediate);
    const panelLabels = nodes(panel.render()).filter(node => node.type === 'button')
      .map(node => node.children.flat(Infinity).join(''));
    assert(panelLabels.includes('继续测试'));
    assert(!panelLabels.includes('继续'), '人工接管时不能同时显示会绕开观察的普通继续按钮');
    const chat = mountChatStatus('ui-project', await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-project' }));
    await new Promise(setImmediate);
    const chatLabels = nodes(chat.render()).filter(node => node.type === 'button')
      .map(node => node.children.flat(Infinity).join(''));
    assert(chatLabels.includes('继续测试'));
    assert(!chatLabels.includes('继续'));
    const current = readTaskPolicy(store, 'ui-project');
    const restored = { ...current };
    delete restored.manualTakeover;
    writeTaskPolicy(store, 'ui-project', restored, 'manual-takeover-resume');
  });

  await test('归档后仍能打开上次检查表并导出同一次运行', async () => {
    const { run } = prepareProject('ui-history-a');
    setProjectRunState(store, 'ui-history-a', run.runId, 'completed', run.controlRev, { completedSummary: { ended: 3, executed: 3, needsCheck: 3 } });
    archiveTaskRound(store, 'ui-history-a', 'desktop-user');
    const status = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-history-a' });
    assert.equal(status.configured, false, '归档后当前任务策略应已清空');
    assert.equal(status.scene.sceneId, 'cases', '归档后场景仍应是案例测试');
    const ui = mountChatStatus('ui-history-a', status);
    await new Promise(setImmediate);
    const view = ui.render(), text = textOf(view);
    assert(text.includes('上次测试'), text.slice(0, 500));
    assert(text.includes('已执行 3/3'));
    assert(!text.includes('当前没有待执行检查'));
    const labels = nodes(view).filter(node => node.type === 'button').map(node => node.children.flat(Infinity).join(''));
    assert(labels.includes('查看检查表') && labels.includes('导出结果'), labels.join(','));
    assert(!labels.includes('暂停') && !labels.includes('结束本次'), '历史运行不能出现控制当前测试的按钮');
    const viewChecks = nodes(view).find(node => node.type === 'button' && node.children.flat(Infinity).join('') === '查看检查表');
    viewChecks.props.onClick();
    const expanded = textOf(ui.render());
    assert(expanded.includes('员工只能查看自己的资料'), expanded.slice(0, 600));
    assert(!expanded.includes('仅重测此项'), '历史运行只能读取和导出，不能从这里重新测试');
    assert(!nodes(ui.render()).some(node => node.type === 'th' && textOf(node) === '操作'), '历史检查表不应保留空的操作列');
    const exportButton = nodes(ui.render()).find(node => node.type === 'button' && node.children.flat(Infinity).join('') === '导出结果');
    exportButton.props.onClick();
    await new Promise(setImmediate);
    const exported = ui.calls.filter(call => call.endpoint === 'project.export').at(-1);
    assert.equal(exported.payload.runId, run.runId, '导出必须明确使用选中的 runId');
  });

  await test('新建 B 后可分别读取、导出 A 和 B，历史证据不串', async () => {
    const a = prepareProject('ui-history-b', ' A');
    setProjectRunState(store, 'ui-history-b', a.run.runId, 'completed', a.run.controlRev, { completedSummary: { ended: 3, executed: 3, needsCheck: 3 } });
    archiveTaskRound(store, 'ui-history-b', 'desktop-user');
    const b = prepareProject('ui-history-b', ' B');
    setProjectRunState(store, 'ui-history-b', b.run.runId, 'completed', b.run.controlRev, { completedSummary: { ended: 3, executed: 3, needsCheck: 3 } });
    const status = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-history-b' });
    assert.equal(status.policy.projectRunId, b.run.runId);
    const ui = mountChatStatus('ui-history-b', status);
    await new Promise(setImmediate);
    let view = ui.render();
    const openButton = nodes(view).find(node => node.type === 'button' && node.children.flat(Infinity).join('') === '查看检查表');
    openButton.props.onClick();
    view = ui.render();
    assert(textOf(view).includes('普通员工不能审批 B'), textOf(view).slice(0, 700));
    const select = nodes(view).find(node => node.props && node.props['aria-label'] === '项目历史运行');
    assert(select, '两次运行必须提供简短历史选择');
    select.props.onChange({ target: { value: a.run.runId } });
    await new Promise(setImmediate);
    const aText = textOf(ui.render());
    assert(aText.includes('员工只能查看自己的资料 A'), aText.slice(0, 700));
    assert(!aText.includes('员工只能查看自己的资料 B'), 'A 的检查表不能被 B 覆盖');
    assert(!aText.includes('仅重测此项'), '选中历史 A 后不能启动重测');
    const exportA = nodes(ui.render()).find(node => node.type === 'button' && node.children.flat(Infinity).join('') === '导出结果');
    exportA.props.onClick();
    await new Promise(setImmediate);
    assert.equal(ui.calls.filter(call => call.endpoint === 'project.export').at(-1).payload.runId, a.run.runId);
    const selectAgain = nodes(ui.render()).find(node => node.props && node.props['aria-label'] === '项目历史运行');
    selectAgain.props.onChange({ target: { value: b.run.runId } });
    await new Promise(setImmediate);
    const bText = textOf(ui.render());
    assert(bText.includes('员工只能查看自己的资料 B'), bText.slice(0, 700));
    assert(!bText.includes('员工只能查看自己的资料 A'), '切回 B 不能继续显示 A 的检查表');
  });

  await test('迟到的历史响应不覆盖后选择的运行', async () => {
    const a = prepareProject('ui-history-race', ' A');
    setProjectRunState(store, 'ui-history-race', a.run.runId, 'completed', a.run.controlRev, { completedSummary: { ended: 3, executed: 3, needsCheck: 3 } });
    archiveTaskRound(store, 'ui-history-race', 'desktop-user');
    const b = prepareProject('ui-history-race', ' B');
    setProjectRunState(store, 'ui-history-race', b.run.runId, 'completed', b.run.controlRev, { completedSummary: { ended: 3, executed: 3, needsCheck: 3 } });
    const status = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-history-race' });
    let releaseA;
    const gate = new Promise(resolve => { releaseA = resolve; });
    const ui = mountChatStatus('ui-history-race', status, { api: async (call, endpoint, payload) => {
      if (endpoint === 'project.status' && payload.runId === a.run.runId) await gate;
      return call();
    } });
    await new Promise(setImmediate);
    let view = ui.render();
    const openButton = nodes(view).find(node => node.type === 'button' && node.children.flat(Infinity).join('') === '查看检查表');
    openButton.props.onClick();
    view = ui.render();
    let select = nodes(view).find(node => node.props && node.props['aria-label'] === '项目历史运行');
    select.props.onChange({ target: { value: a.run.runId } });
    select.props.onChange({ target: { value: b.run.runId } });
    const pending = textOf(ui.render());
    assert(pending.includes('正在读取测试结果'), '切换期间必须显示明确 loading');
    assert(!pending.includes('员工只能查看自己的资料 B'), '切换期间不能继续显示旧运行内容');
    assert(!pending.includes('仅重测此项'), '切换期间不能保留旧运行的写按钮');
    releaseA();
    await new Promise(resolve => setTimeout(resolve, 10));
    const text = textOf(ui.render());
    assert(text.includes('员工只能查看自己的资料 B'), text.slice(0, 700));
    assert(!text.includes('员工只能查看自己的资料 A'), '迟到的 A 响应不能覆盖已选择的 B');
  });

  await test('切换历史后立即导出仍使用选中的 runId', async () => {
    const a = prepareProject('ui-history-export-race', ' A');
    setProjectRunState(store, 'ui-history-export-race', a.run.runId, 'completed', a.run.controlRev, { completedSummary: { ended: 3, executed: 3, needsCheck: 3 } });
    archiveTaskRound(store, 'ui-history-export-race', 'desktop-user');
    const b = prepareProject('ui-history-export-race', ' B');
    setProjectRunState(store, 'ui-history-export-race', b.run.runId, 'completed', b.run.controlRev, { completedSummary: { ended: 3, executed: 3, needsCheck: 3 } });
    const status = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-history-export-race' });
    let releaseA;
    const gate = new Promise(resolve => { releaseA = resolve; });
    const ui = mountChatStatus('ui-history-export-race', status, { api: async (call, endpoint, payload) => {
      if (endpoint === 'project.status' && payload.runId === a.run.runId) await gate;
      return call();
    } });
    await new Promise(setImmediate);
    let view = ui.render();
    const openButton = nodes(view).find(node => node.type === 'button' && node.children.flat(Infinity).join('') === '查看检查表');
    openButton.props.onClick();
    view = ui.render();
    const select = nodes(view).find(node => node.props && node.props['aria-label'] === '项目历史运行');
    select.props.onChange({ target: { value: a.run.runId } });
    const pendingView = ui.render();
    assert(!nodes(pendingView).some(node => node.type === 'button' && node.children.flat(Infinity).join('') === '导出结果'),
      '切换尚未返回时不能操作旧记录的导出');
    assert.equal(ui.calls.filter(call => call.endpoint === 'project.export').length, 0);
    releaseA();
    await new Promise(resolve => setTimeout(resolve, 10));
    const loadedView = ui.render();
    const exportButton = nodes(loadedView).find(node => node.type === 'button' && node.children.flat(Infinity).join('') === '导出结果');
    exportButton.props.onClick();
    await new Promise(setImmediate);
    assert.equal(ui.calls.filter(call => call.endpoint === 'project.export').at(-1).payload.runId, a.run.runId,
      '加载完成后导出的必须是选中的 A');
  });

  await test('切换历史期间旧运行的暂停、结束和重测按钮全部锁定', async () => {
    const a = prepareProject('ui-history-write-lock', ' A');
    setProjectRunState(store, 'ui-history-write-lock', a.run.runId, 'completed', a.run.controlRev, { completedSummary: { ended: 3, executed: 3, needsCheck: 3 } });
    archiveTaskRound(store, 'ui-history-write-lock', 'desktop-user');
    const b = prepareProject('ui-history-write-lock', ' B');
    const status = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-history-write-lock' });
    let releaseA;
    const gate = new Promise(resolve => { releaseA = resolve; });
    const ui = mountChatStatus('ui-history-write-lock', status, { api: async (call, endpoint, payload) => {
      if (endpoint === 'project.status' && payload.runId === a.run.runId) await gate;
      return call();
    } });
    await new Promise(setImmediate);
    let view = ui.render();
    const openButton = nodes(view).find(node => node.type === 'button' && node.children.flat(Infinity).join('') === '查看检查表');
    openButton.props.onClick();
    view = ui.render();
    const select = nodes(view).find(node => node.props && node.props['aria-label'] === '项目历史运行');
    select.props.onChange({ target: { value: a.run.runId } });
    const pending = textOf(ui.render());
    for (const label of ['暂停','结束本次','仅重测此项','导出结果']) assert(!pending.includes(label), 'loading 期间不能保留旧按钮：' + label);
    assert(pending.includes('正在读取测试结果'));
    releaseA();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert(textOf(ui.render()).includes('员工只能查看自己的资料 A'));
    assert.equal(b.run.runId, status.policy.projectRunId);
  });

  await test('历史读取失败显示错误和重试入口', async () => {
    const { run } = prepareProject('ui-history-error');
    setProjectRunState(store, 'ui-history-error', run.runId, 'completed', run.controlRev, { completedSummary: { ended: 3, executed: 3, needsCheck: 3 } });
    archiveTaskRound(store, 'ui-history-error', 'desktop-user');
    const status = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-history-error' });
    let failed = false;
    const ui = mountChatStatus('ui-history-error', status, { api: async (call, endpoint) => {
      if (endpoint === 'project.status' && !failed) { failed = true; return { ok: false, error: 'fixture read failure' }; }
      return call();
    } });
    await new Promise(setImmediate);
    let view = ui.render(), text = textOf(view);
    assert(text.includes('读取测试结果失败') && text.includes('fixture read failure'), text.slice(0, 500));
    const retry = nodes(view).find(node => node.type === 'button' && node.children.flat(Infinity).join('') === '重试');
    assert(retry, '读取失败必须提供重试入口');
    retry.props.onClick();
    await new Promise(setImmediate);
    text = textOf(ui.render());
    assert(text.includes('上次测试') && text.includes('已执行 3/3'), text.slice(0, 500));
  });

  await test('没有历史运行的案例会话不显示空零指标', async () => {
    await results.dispatch(ctx, store, 'task.scenario', { sessionId: 'ui-history-empty', scenario: 'project' });
    const status = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-history-empty' });
    assert.equal(status.configured, false);
    assert.equal(status.scene.sceneId, 'cases');
    const ui = mountChatStatus('ui-history-empty', status);
    await new Promise(setImmediate);
    assert.equal(ui.render(), null, '没有历史数据时不能渲染 0/0 指标');
  });

  await test('停止且没有检查项的运行不显示空零指标', async () => {
    startTaskPolicy(store, 'ui-empty-run', { scenario: 'project', question: '未整理出检查项' });
    const run = createProjectRun(store, 'ui-empty-run', { question: '未整理出检查项' });
    writeTaskPolicy(store, 'ui-empty-run', { ...readTaskPolicy(store, 'ui-empty-run'), projectRunId: run.runId, projectRunState: 'running' }, 'test-project-run-bound');
    setProjectRunState(store, 'ui-empty-run', run.runId, 'cancelled', run.controlRev, { blocker: null });
    const status = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'ui-empty-run' });
    const ui = mountChatStatus('ui-empty-run', status);
    await new Promise(setImmediate);
    const view = ui.render(), text = textOf(view);
    assert(text.includes('没有保存的检查项'), text.slice(0, 400));
    assert(!text.includes('已执行 0/0'), '空运行不能显示 0/0');
    const labels = nodes(view).filter(node => node.type === 'button').map(node => node.children.flat(Infinity).join(''));
    assert(!labels.includes('查看检查表'), '没有检查项时不提供空表入口');
    assert(labels.includes('导出结果'));
  });

  await test('项目面板拒绝读取非项目会话时不渲染旧任务视图', async () => {
    startTaskPolicy(store, 'ui-pentest', { mode: 'regular', question: '常规测试', budget: { toolCalls: 5 } });
    const ui = mount('ui-pentest');
    await new Promise(setImmediate);
    const text = textOf(ui.render());
    assert(text.includes('还没有开始案例测试') || text.includes('案例测试'), text.slice(0, 200));
  });

  await test('A20 项目表格在窄窗下可横向滚动且文本换行', () => {
    assert(source.includes('.dsh-project-modal{width:min(1100px,calc(100vw - 48px));max-height:70vh'), '检查表必须是限宽限高弹窗');
    assert(source.includes('.dsh-project-modal-body{overflow:auto'), '检查表正文必须独立滚动');
    assert(source.includes('.dsh-project-table{width:100%;min-width:900px;border-collapse:collapse;table-layout:fixed'), '检查表必须是真正的 table 布局并保留最小宽度');
    assert(source.includes('.dsh-project-table th,.dsh-project-table td'), '检查表单元格样式存在');
    assert(source.includes('white-space:normal') && source.includes('word-break:break-word'), '长要求、URL 和说明必须允许换行');
    assert(source.includes('-webkit-line-clamp:3'), '列表说明最多显示三行');
    assert(source.includes('.dsh-project-detail-body{'), '详情必须使用有高度限制的原文区');
  });

  await test('聊天入口提供案例测试并接入项目来源导入', () => {
    assert(source.includes("projectMode?'案例测试':'自由测试'"), '测试场景必须显示案例测试');
    assert(source.includes("['execution', '执行记录'], ['findings', '发现的问题'], ['materials', '测试资料']"), '结果页必须有单一内部的执行、发现和资料分类');
    assert(source.includes("api('project.import'"), '项目文档必须走真实导入接口');
    assert(source.includes("scenario:activeScenario"), '资料入口必须知道当前是项目场景');
    assert(source.includes("projectMode?'开始案例测试':'开始测试'"), '项目开始按钮必须有明确动作');
  });
} finally {
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
