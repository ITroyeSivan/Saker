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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-knowledge-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const tools = new Map();
const ctx = {
  tools: { register: tool => tools.set(tool.name, tool), guard: () => {} },
  webServer: { register: () => () => {} },
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') dispose(); },
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
    assert.equal(read.text, DOCUMENT_TEXT);
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
} finally {
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
