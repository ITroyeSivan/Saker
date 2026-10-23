// W06：项目面板渲染验证（统计、检查表、来源、暂停/停止/导出按钮）。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { writeTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy-record.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, recordProjectCheck, upsertProjectSource } from '../plugins/dsh-redteam-results/lib/project-store.js';
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

function prepareProject(sid) {
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试人事系统', budget: { minutes: 30 } });
  const run = createProjectRun(store, sid, { question: '按文档测试人事系统' });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  const checks = defineProjectChecks(store, sid, run.runId, [
    { requirement: '员工只能查看自己的资料', sourceLocation: '表1 第2行' },
    { requirement: '普通员工不能审批', sourceLocation: '表1 第3行' },
    { requirement: '文件下载权限', sourceLocation: '表1 第4行' },
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

function mountChatStatus(sessionId) {
  const state = [], effects = [];
  let cursor = 0;
  const sandbox = {
    useState: initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; },
    useEffect: effect => effects.push(effect),
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    Btn: 'button',
    downloadArchive: () => {},
    api: async (endpoint, payload) => { try { return await results.dispatch(ctx, store, endpoint, payload); } catch (error) { return { ok: false, error: error.message }; } },
  };
  runInNewContext(source.slice(chatStart, chatEnd) + ';this.component=ProjectChatStatus;', sandbox);
  const render = () => { cursor = 0; return sandbox.component({ sessionId, status: null }); };
  render();
  for (const effect of effects.slice()) effect();
  return { render, state };
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
    assert(text.includes('已检查 1 项'), '缺条件和部分完成不能计入已检查数量：' + JSON.stringify(view).slice(0, 800));
    assert(text.includes('发现问题 1'));
    assert(text.includes('缺少条件 1'));
    assert(text.includes('员工只能查看自己的资料'));
    assert(text.includes('员工 B 读取到员工 A 的电话'));
    assert(text.includes('测试要求.xlsx'));
    assert(text.includes('部分完成 1'));
    const row = nodes(view).find(node => node.type === 'tr' && textOf(node).includes('文件下载权限'));
    assert(row && textOf(row).includes('部分完成'), '部分完成不能显示成未发现问题');
    assert(textOf(row).includes('已检查自己的文件'));
    assert(textOf(row).includes('尚缺另一位员工的文件'), '已检查内容和缺口都须可见');
    assert(text.includes('文档要求') && text.includes('结果') && text.includes('说明'));
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
    const ui = mountChatStatus('ui-project');
    await new Promise(setImmediate);
    const view = ui.render();
    const text = textOf(view);
    assert(text.includes('已检查 1/3') || text.includes('已检查 1/3'), text.slice(0, 500));
    assert(text.includes('当前：') || text.includes('当前没有待执行检查'));
    const buttons = nodes(view).filter(node => node.type === 'button');
    const viewChecks = buttons.find(node => node.children.flat(Infinity).join('') === '查看检查表');
    assert(viewChecks, '聊天状态行必须有查看检查表入口');
    viewChecks.props.onClick();
    const expanded = textOf(ui.render());
    assert(expanded.includes('文档要求') && expanded.includes('员工只能查看自己的资料'));
    assert(source.includes("React.createElement(ProjectChatStatus,{sessionId:props.sessionId,status:current})"), '项目状态行必须真正挂到聊天设置上方');
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
    const chat = mountChatStatus('ui-project');
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

  await test('项目面板拒绝读取非项目会话时不渲染旧任务视图', async () => {
    startTaskPolicy(store, 'ui-pentest', { mode: 'regular', question: '常规测试', budget: { toolCalls: 5 } });
    const ui = mount('ui-pentest');
    await new Promise(setImmediate);
    const text = textOf(ui.render());
    assert(text.includes('还没有开始按文档测试') || text.includes('按文档测试'), text.slice(0, 200));
  });

  await test('A20 项目表格在窄窗下可横向滚动且文本换行', () => {
    assert(source.includes('.dsh-task-project-table{width:100%;display:block;overflow-x:auto'), '项目表格必须可横向滚动');
    assert(source.includes('.dsh-task-project-table th,.dsh-task-project-table td'), '项目表格单元格样式存在');
    assert(source.includes('white-space:normal'), '单元格文本必须允许换行');
    assert(source.includes('word-break:break-word'), '长地址必须可断行');
    assert(source.includes('.dsh-chat-project-table .dsh-task-project-table{min-width:720px;table-layout:fixed}'), '聊天检查表必须有稳定最小宽度和固定列布局');
    assert(source.includes('.dsh-chat-project-table th:nth-child(2),.dsh-chat-project-table td:nth-child(2){width:15%}'), '聊天检查表结果列至少保留 15% 宽度');
    assert(source.includes('.dsh-chat-project-table th:nth-child(3),.dsh-chat-project-table td:nth-child(3){width:50%}'), '聊天检查表说明列保留主要可读宽度');
  });

  await test('聊天入口提供按文档测试并接入项目来源导入', () => {
    assert(source.includes("value==='project'?'按文档测试':'自由测试'"), '测试场景必须能选择按文档测试');
    assert(source.includes("['pentest','project']"), '项目场景入口必须出现在测试场景选择器');
    assert(source.includes("api('project.import'"), '项目文档必须走真实导入接口');
    assert(source.includes("scenario:activeScenario"), '资料入口必须知道当前是项目场景');
    assert(source.includes("projectMode?'开始按文档测试':'开始测试'"), '项目开始按钮必须有明确动作');
  });
} finally {
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
