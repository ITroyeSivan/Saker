// W06：项目面板渲染验证（统计、检查表、来源、暂停/停止/导出按钮）。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, recordProjectCheck, upsertProjectSource } from '../plugins/dsh-redteam-results/lib/project-store.js';

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
  ]);
  recordProjectCheck(store, sid, run.runId, checks[0].checkId, { executionState: 'ended', verdict: 'issue', checkedContent: '员工 B 读取到员工 A 的电话' });
  recordProjectCheck(store, sid, run.runId, checks[1].checkId, { executionState: 'ended', verdict: 'blocked', gaps: '缺少审批人账号' });
  upsertProjectSource(store, sid, { sourceId: 'doc-1', sourceRevision: 'rev-1', displayName: '测试要求.xlsx', kind: 'xlsx', parseState: 'ready', sections: [] });
  return { run: running, checks };
}

const source = fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('function ProjectPanel('), end = source.indexOf('function TaskPanel(', start);
assert(start > 0 && end > start, 'ProjectPanel source located');

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

function nodes(node) { if (!node || typeof node !== 'object') return []; return [node, ...node.children.flat(Infinity).flatMap(nodes)]; }
function allValues(node) { if (node === null || node === undefined) return []; if (typeof node !== 'object') return [node]; return [node, ...node.children.flat(Infinity).flatMap(allValues)]; }
const textOf = node => allValues(node).filter(item => typeof item === 'string').join(' ');

try {
  await test('项目面板显示统计、检查表与来源', async () => {
    prepareProject('ui-project');
    const ui = mount('ui-project');
    await new Promise(setImmediate);
    const view = ui.render();
    const text = textOf(view);
    assert(text.includes('已检查 2 项'), '统计行必须显示已检查数量：' + JSON.stringify(view).slice(0, 800));
    assert(text.includes('发现问题 1'));
    assert(text.includes('缺少条件 1'));
    assert(text.includes('员工只能查看自己的资料'));
    assert(text.includes('员工 B 读取到员工 A 的电话'));
    assert(text.includes('测试要求.xlsx'));
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
  });
} finally {
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
