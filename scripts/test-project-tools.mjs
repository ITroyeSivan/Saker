// W06：模型侧项目工具（project_document / project_check / project_request / saker_browser）。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, upsertProjectSource, readProjectRun } from '../plugins/dsh-redteam-results/lib/project-store.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-tools-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const disposers = [];
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, marker: 'SAKER_PROJECT_TOOL' }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

const tools = new Map();
const ctx = {
  tools: { register: tool => tools.set(tool.name, tool), guard: () => {} },
  webServer: { register: () => () => {} },
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  sessions: { get: id => ({ id, header: { agentPreset: 'pentest' } }) },
  agents: { get: () => ({ status: 'idle', followup: () => {} }) },
  get: () => null,
};
const { apply } = await import('../plugins/dsh-redteam-results/lib/index.js');
apply(ctx);
const exec = sid => ({ agent: { session: { id: sid, header: { agentPreset: 'pentest' } } } });

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

try {
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
  });

  await test('project_check next / record / detail 可用', async () => {
    const { run, check } = prepareProject('pt-check');
    const tool = tools.get('project_check');
    assert(tool, 'project_check 已注册');
    const next = await tool.execute({ action: 'next' }, exec('pt-check'));
    assert.equal(next.ok, true, next.error);
    assert.equal(next.check.checkId, check.checkId);
    const recorded = await tool.execute({ action: 'record', checkId: check.checkId, verdict: 'issue', checkedContent: '员工 B 读到员工 A 的电话' }, exec('pt-check'));
    assert.equal(recorded.ok, true, recorded.error);
    assert.equal(recorded.check.verdict, 'issue');
    const detail = await tool.execute({ action: 'detail', checkId: check.checkId }, exec('pt-check'));
    assert.equal(detail.ok, true, detail.error);
    assert.equal(detail.check.checkedContent, '员工 B 读到员工 A 的电话');
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

  const cft = process.env.SAKER_CFT_PATH
    || ['E:/software/ChromeForTesting/chrome-win64/chrome.exe', 'E:/software/ChromeForTesting/chrome.exe'].find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
  if (cft) {
    process.env.SAKER_CFT_PATH = cft;
    await test('saker_browser open / observe / close 可用', async () => {
      const { run } = prepareProject('pt-browser');
      const tool = tools.get('saker_browser');
      assert(tool, 'saker_browser 已注册');
      const opened = await tool.execute({ action: 'open', url: origin + '/page' }, exec('pt-browser'));
      assert.equal(opened.ok, true, opened.error);
      const observed = await tool.execute({ action: 'observe' }, exec('pt-browser'));
      assert.equal(observed.ok, true, observed.error);
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
