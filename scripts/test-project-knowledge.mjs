// W07：项目文档读取与知识开关独立；模型实际读取有记录；项目提示不附文档全文。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, taskPolicyStatus, taskPromptStable } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, upsertProjectSource } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { setKnowledgeEnabled, knowledgeEnabled, knowledgeSwitchView } from '../plugins/dsh-redteam-results/lib/knowledge-switch.js';
import { listMaterialReads } from '../plugins/dsh-redteam-results/lib/material-reads.js';
import { projectContinuation, markProjectContinuation } from '../plugins/dsh-redteam-results/lib/project-runtime.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-knowledge-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const tools = new Map();
const disposers = [];
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

let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const DOCUMENT_TEXT = '员工只能查看自己的资料，普通员工不能审批。';
function prepare(sid) {
  startTaskPolicy(store, sid, { scenario: 'project', question: '按文档测试人事系统', budget: { minutes: 30 } });
  const run = createProjectRun(store, sid, { question: '按文档测试人事系统' });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  defineProjectChecks(store, sid, run.runId, [{ requirement: '检查员工资料权限', sourceLocation: '表1 第2行' }]);
  upsertProjectSource(store, sid, {
    sourceId: 'doc-1', sourceRevision: 'rev-1', displayName: '测试要求.docx', kind: 'docx', parseState: 'ready',
    sections: [{ sectionId: 'p1', location: { kind: 'paragraph', index: 1 }, kind: 'paragraph', text: DOCUMENT_TEXT }],
  });
  return running;
}

try {
  await test('关闭知识库后项目文档仍可读取，读取不依赖知识开关', async () => {
    prepare('pk-read');
    setKnowledgeEnabled(store, 'pk-read', false, 'desktop-user');
    assert.equal(knowledgeEnabled(store, 'pk-read'), false);
    const tool = tools.get('project_document');
    const read = await tool.execute({ action: 'read', sourceId: 'doc-1', sectionId: 'p1' }, exec('pk-read'));
    assert.equal(read.ok, true, read.error);
    assert(read.text.includes(DOCUMENT_TEXT), '正文必须保留');
    assert(read.text.includes('来源：测试要求.docx'), '渲染文本必须让模型看见来源');
    assert(read.text.includes('范围：[0,'), '渲染文本必须让模型看见实际读取范围');
    assert(read.text.includes('后续：无'), '渲染文本必须区分是否还有内容');
    const search = await tool.execute({ action: 'search', query: '审批' }, exec('pk-read'));
    assert.equal(search.ok, true, search.error);
    assert(search.text.includes('审批'));
  });

  await test('模型实际读取项目文档后有记录，知识用量不把任务文档算成知识条目', async () => {
    const reads = listMaterialReads(store, 'pk-read');
    const keys = [...reads.keys()];
    assert(keys.some(key => key === 'project:doc-1@rev-1:p1'), '缺少 read 记录：' + keys.join(','));
    assert(keys.some(key => key.startsWith('project:doc-1@rev-1:')), '缺少 search 记录');
    const view = knowledgeSwitchView(store, 'pk-read');
    assert.equal(view.enabled, false);
    assert.equal(view.usedCount, 0, '任务文档读取不能算作知识条目已发送');
  });

  await test('项目提示只带当前要求摘要，不附文档全文', () => {
    prepare('pk-prompt');
    const prompt = taskPromptStable(taskPolicyStatus(store, 'pk-prompt'));
    assert(prompt.includes('按文档连续测试'));
    assert(prompt.includes('按文档测试人事系统'));
    assert(!prompt.includes(DOCUMENT_TEXT), '项目提示不能附文档全文');
    assert(!prompt.includes('methodId'), '项目提示不能要求旧方法字段');
    const bytes = Buffer.byteLength(prompt, 'utf8');
    assert(bytes < 1200, '项目提示必须保持精简，实际 ' + bytes + ' 字节');
    console.log('     项目提示 ' + bytes + ' UTF-8 字节');
  });

  await test('知识库关闭不会删除历史读取记录', async () => {
    setKnowledgeEnabled(store, 'pk-read', false, 'desktop-user');
    const reads = listMaterialReads(store, 'pk-read');
    assert(reads.size > 0, '关闭知识库不能删除文档读取记录');
  });

  await test('真实文档工具读取新范围计进展，重读和搜索同片段不清零', async () => {
    const sid = 'pk-progress';
    const run = prepare(sid);
    const tool = tools.get('project_document');
    const mark = value => markProjectContinuation(store, sid, run.runId, value.fingerprint, value.attempts);
    mark(projectContinuation(store, sid));
    assert.equal((await tool.execute({ action: 'read', sourceId: 'doc-1', sectionId: 'p1', cursor: 0, limit: 8 }, exec(sid))).ok, true);
    const firstRead = projectContinuation(store, sid);
    assert.equal(firstRead.attempts, 0, '首次读取真正的新原文范围算进展');
    mark(firstRead);
    await tool.execute({ action: 'read', sourceId: 'doc-1', sectionId: 'p1', cursor: 4, limit: 2 }, exec(sid));
    const repeated = projectContinuation(store, sid);
    assert.equal(repeated.attempts, 1, '已读范围里的小片段不算新进展');
    mark(repeated);
    await tool.execute({ action: 'read', sourceId: 'doc-1', sectionId: 'p1', cursor: 8, limit: 8 }, exec(sid));
    const newRange = projectContinuation(store, sid);
    assert.equal(newRange.attempts, 0, '向后续读必须允许继续');
    mark(newRange);
    await tool.execute({ action: 'search', query: '员工' }, exec(sid));
    const searched = projectContinuation(store, sid);
    assert.equal(searched.attempts, 0, '搜索实际提供尚未读到的后半段算进展');
    mark(searched);
    await tool.execute({ action: 'search', query: '员工' }, exec(sid));
    const duplicateSearch = projectContinuation(store, sid);
    assert.equal(duplicateSearch.attempts, 1, '相同搜索片段不重复提供进展');
  });
} finally {
  for (const dispose of disposers.reverse()) await dispose();
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
