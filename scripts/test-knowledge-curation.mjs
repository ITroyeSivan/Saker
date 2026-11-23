import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { chooseTaskMode, startTaskPolicy, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import {
  cancelKnowledgeCuration,
  createManualKnowledgeCuration,
  getKnowledgeCuration,
  recoverKnowledgeCurations,
  saveKnowledgeCuration,
  startKnowledgeCuration,
  updateKnowledgeCuration,
} from '../plugins/dsh-redteam-results/lib/knowledge-curation.js';
import { registerModelAdmission } from '../plugins/dsh-redteam-results/lib/model-budget.js';
import { listKnowledgeEntries } from '../plugins/dsh-redteam-results/lib/knowledge-index.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-curation-'));
process.env.DSH_HOME = home;
const model = { provider: 'fixture', model: 'fixture-model' };
const valid = JSON.stringify({
  title: '固定条件的对象权限检查', body: '用两个租户的同名对象 ID 做对照，确认响应只返回当前租户对象。',
  conditions: '服务端按租户过滤，且测试账号已授权。', sources: '用户提供的回答第 3 段',
  product: '', version: '', applicability: 'unknown',
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
function ok(label) { checks += 1; console.log('ok ' + label); }

{
  const store = openStore(':memory:');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM knowledge_curations').get().n, 0);
  recoverKnowledgeCurations(store);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM knowledge_curations').get().n, 0);
  ok('A30 no answer, restart or recovery path starts curation without an explicit click');
  store.close();
}

{
  const store = openStore(':memory:');
  let wires = 0;
  const request = startKnowledgeCuration(store, {
    requestId: 'curation-1', sessionId: 'session-1',
    selectedText: '正文 password=hunter2\nAuthorization: Bearer abc.def.ghi\n对象权限检查步骤',
    evidenceText: 'token=secret-value', sourceRef: 'answer-1', model,
  }, async input => {
    wires += 1;
    input.onWire();
    assert(!input.text.includes('hunter2'));
    assert(!input.text.includes('abc.def.ghi'));
    assert(!input.evidence.includes('secret-value'));
    return { text: valid, usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 } };
  });
  assert.equal(request.state, 'queued');
  const duplicate = startKnowledgeCuration(store, {
    requestId: 'curation-2', sessionId: 'session-1',
    selectedText: '正文 password=hunter2\nAuthorization: Bearer abc.def.ghi\n对象权限检查步骤',
    evidenceText: 'token=secret-value', sourceRef: 'answer-1', model,
  }, async () => { wires += 1; return { text: valid }; });
  assert.equal(duplicate.requestId, request.requestId, 'a second click on the same active source reuses the request');
  await wait(50);
  const editing = getKnowledgeCuration(store, request.requestId);
  assert.equal(editing.state, 'editing');
  assert.equal(editing.wireAttempts, 1);
  assert.equal(wires, 1);
  assert.equal(editing.usage.totalTokens, 50);
  ok('A31/A32 one click produces one wire; duplicate clicks reuse it and only redacted selected input is sent');
}

{
  const store = openStore(':memory:');
  assert.throws(() => startKnowledgeCuration(store, {
    requestId: 'too-big', sessionId: 'session-big', selectedText: 'x'.repeat(16385),
    sourceRef: 'big', model,
  }, async () => ({ text: valid })), /16KiB/);
  assert.throws(() => startKnowledgeCuration(store, {
    requestId: 'evidence-big', sessionId: 'session-big', selectedText: 'selected',
    evidenceText: 'e'.repeat(4097), sourceRef: 'evidence-big', model,
  }, async () => ({ text: valid })), /4KiB/);
  ok('A32 oversized selected text or evidence is rejected before any generation request');
  store.close();
}

{
  const store = openStore(':memory:');
  chooseTaskMode(store, 'task-live', 'regular', {});
  startTaskPolicy(store, 'task-live', {
    mode: 'regular', question: 'fixture', target: 'https://fixture.test', budget: { toolCalls: 3, modelCalls: 2 },
  });
  const beforePolicy = readTaskPolicy(store, 'task-live');
  const beforeCalls = store.db.prepare('SELECT count(*) AS n FROM task_model_calls').get().n;
  startKnowledgeCuration(store, {
    requestId: 'curation-independent', sessionId: 'task-live',
    selectedText: '独立的回答整理正文', sourceRef: 'answer-independent', model,
  }, async input => {
    input.onWire();
    return { text: valid, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
  });
  await wait(40);
  assert.deepEqual(readTaskPolicy(store, 'task-live').used, beforePolicy.used);
  assert.equal(readTaskPolicy(store, 'task-live').startedAt, beforePolicy.startedAt);
  assert.equal(readTaskPolicy(store, 'task-live').budget.deadline, beforePolicy.budget.deadline);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_model_calls').get().n, beforeCalls);
  ok('A33 independent curation leaves test status, start time, test budget and task model ledger untouched');
}

{
  const store = openStore(':memory:');
  let release;
  const started = startKnowledgeCuration(store, {
    requestId: 'curation-late', sessionId: 'late-session',
    selectedText: '迟到的生成结果不能覆盖用户手动编辑。', sourceRef: 'late-answer', model,
  }, () => new Promise(resolve => { release = () => resolve({ text: valid, usage: { unknown: true } }); }));
  await wait(10);
  assert.equal(getKnowledgeCuration(store, started.requestId).state, 'generating');
  cancelKnowledgeCuration(store, started.requestId);
  updateKnowledgeCuration(store, started.requestId, { title: '用户手动标题', body: '用户手动正文' });
  release();
  await wait(30);
  const late = getKnowledgeCuration(store, started.requestId);
  assert.equal(late.state, 'editing');
  assert.equal(late.draft.title, '用户手动标题');
  assert.equal(late.draft.body, '用户手动正文');
  assert.equal(late.usage.unknown, true);
  ok('A34 cancellation and late results cannot overwrite manual edits or claim a fake zero usage');
}

{
  const store = openStore(':memory:')
  let firstWire = 0
  let releaseFirst
  const first = startKnowledgeCuration(store, {
    requestId: 'retry-source', sessionId: 'retry-session',
    selectedText: '取消后重新打开不能自动再次调用模型。', sourceRef: 'retry-answer', model,
  }, () => new Promise(resolve => {
    firstWire += 1
    releaseFirst = () => resolve({ text: valid, usage: { unknown: true } })
  }))
  await wait(10)
  cancelKnowledgeCuration(store, first.requestId)
  const reopened = getKnowledgeCuration(store, first.requestId)
  assert.equal(reopened.state, 'cancelled')
  assert.equal(firstWire, 1, 'reopening must not call the model')
  releaseFirst()
  await wait(10)
  let retryWire = 0
  const retry = startKnowledgeCuration(store, {
    requestId: 'retry-explicit', sessionId: 'retry-session',
    selectedText: '取消后重新打开不能自动再次调用模型。', sourceRef: 'retry-answer', model,
  }, async input => {
    retryWire += 1
    input.onWire()
    return { text: valid, usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } }
  })
  await wait(30)
  const completed = getKnowledgeCuration(store, retry.requestId)
  assert.equal(retryWire, 1, 'only an explicit retry starts another wire')
  assert.equal(completed.retryOf, first.requestId)
  assert.equal(completed.intentKey, reopened.intentKey)
  assert.equal(getKnowledgeCuration(store, first.requestId).state, 'cancelled', 'the original attempt remains auditable')
  ok('G09 reopening a cancelled draft is model-free; explicit retry links to the original intent and keeps both attempts')
  store.close()
}

{
  const store = openStore(':memory:');
  const now = Date.now();
  store.db.prepare(`INSERT INTO knowledge_curations
    (request_id,root_session,project_key,source_key,source_digest,model_snapshot,state,edit_revision,
     selected_text,evidence_text,draft_title,draft_body,draft_sources,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'restart-queued', 'restart', 'restart', 'q', 'd1', JSON.stringify(model), 'queued', 0,
    'queued source', '', '', '', '', now, now);
  store.db.prepare(`INSERT INTO knowledge_curations
    (request_id,root_session,project_key,source_key,source_digest,model_snapshot,state,edit_revision,
     selected_text,evidence_text,draft_title,draft_body,draft_sources,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'restart-generating', 'restart', 'restart', 'g', 'd2', JSON.stringify(model), 'generating', 0,
    'generating source', '', '', '', '', now, now);
  store.db.prepare(`INSERT INTO knowledge_curations
    (request_id,root_session,project_key,source_key,source_digest,model_snapshot,state,edit_revision,
     selected_text,evidence_text,draft_title,draft_body,draft_sources,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'restart-editing', 'restart', 'restart', 'e', 'd3', JSON.stringify(model), 'editing', 2,
    'editing source', '', 'Editor', 'Draft', 'Source', now, now);
  const recovered = recoverKnowledgeCurations(store);
  assert.equal(recovered.unknown, 1);
  assert.equal(getKnowledgeCuration(store, 'restart-queued').state, 'failed');
  assert.match(getKnowledgeCuration(store, 'restart-queued').error, /尚未发送|不会自动重发/);
  assert.equal(getKnowledgeCuration(store, 'restart-generating').state, 'failed');
  assert.equal(getKnowledgeCuration(store, 'restart-generating').usage.unknown, true);
  assert.equal(getKnowledgeCuration(store, 'restart-editing').state, 'editing');
  assert.equal(getKnowledgeCuration(store, 'restart-editing').draft.title, 'Editor');
  ok('A35 restart marks unsent/unknown work interrupted, preserves editing drafts and never resends');
}

{
  const store = openStore(':memory:');
  const manual = createManualKnowledgeCuration(store, {
    requestId: 'manual-offline', sessionId: 'offline-session',
    selectedText: '本地模型离线时仍可手动整理并保存的正文', sourceRef: 'offline',
  });
  assert.equal(manual.state, 'editing');
  const updated = updateKnowledgeCuration(store, manual.requestId, {
    title: '离线手动条目', body: '本地模型不可用时，由用户自己整理正文。', sources: '原回答',
    applicability: 'unknown',
  });
  assert.equal(updated.editRevision, 1);
  const saved = saveKnowledgeCuration(store, manual.requestId, { userConfirmed: true });
  assert.equal(saved.state, 'saved');
  assert(saved.entry);
  ok('A36/A37 local model unavailable still supports manual editing; unknown applicability is preserved');
}

{
  const store = openStore(':memory:');
  const first = startKnowledgeCuration(store, {
    requestId: 'dedupe-1', sessionId: 'dedupe-session',
    selectedText: '去重正文', sourceRef: 'dedupe', model,
  }, async () => ({ text: valid, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } }));
  await wait(30);
  saveKnowledgeCuration(store, first.requestId, { userConfirmed: true });
  const second = startKnowledgeCuration(store, {
    requestId: 'dedupe-2', sessionId: 'dedupe-session',
    selectedText: '另一个来源', sourceRef: 'dedupe-other', model,
  }, async () => ({ text: valid, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } }));
  await wait(30);
  const duplicate = saveKnowledgeCuration(store, second.requestId, { userConfirmed: true });
  assert.equal(duplicate.duplicate, 'exact');
  const entries = listKnowledgeEntries('dedupe-session').rows;
  assert.equal(entries.length, 1);
  assert.equal(typeof entries[0].review.verification, 'string');
  assert.equal(typeof entries[0].review.sourceStateLabel, 'string');
  assert.equal(['source-missing', 'source-unverified', 'source-reference'].includes(entries[0].review.sourceState), true);
  ok('A37 exact duplicate content reuses the existing entry instead of creating a second row');
}

{
  const store = openStore(':memory:');
  const started = startKnowledgeCuration(store, {
    requestId: 'partial-index', sessionId: 'partial-session',
    selectedText: '索引失败时仍保留草稿', sourceRef: 'partial', model,
  }, async () => ({ text: valid, usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 } }));
  await wait(30);
  const normalHome = process.env.DSH_HOME;
  const blocked = path.join(home, 'blocked-home');
  fs.writeFileSync(blocked, 'not a directory');
  process.env.DSH_HOME = blocked;
  assert.throws(() => saveKnowledgeCuration(store, started.requestId, { userConfirmed: true }));
  assert.equal(getKnowledgeCuration(store, started.requestId).state, 'editing');
  process.env.DSH_HOME = normalHome;
  const saved = saveKnowledgeCuration(store, started.requestId, { userConfirmed: true });
  assert.equal(saved.state, 'saved');
  assert.equal(listKnowledgeEntries('partial-session').rows.length, 1);
  ok('A38 index write failure keeps one editable draft; retry saves one searchable entry');
}

{
  const store = openStore(':memory:');
  const originalFetch = globalThis.fetch;
  let nativeFetches = 0;
  let sentTools = null;
  globalThis.fetch = async (input, init) => {
    nativeFetches += 1;
    const request = input instanceof Request ? input : new Request(input, init);
    const body = JSON.parse(await request.clone().text());
    sentTools = body.tools;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const handlers = new Map();
  const ctx = {
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    agents: { get: () => undefined },
  };
  const admission = registerModelAdmission(ctx, () => store);
  try {
    const hook = handlers.get('llm/stream');
    let wires = 0;
    const stream = hook({
      provider: 'fixture', model: 'fixture-model', purpose: 'knowledge-curation',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'curation' }] }],
      tools: [{ name: 'must_not_escape', parameters: {} }],
      curationOnWire() { wires += 1; },
    }, async function* () {
      const first = await fetch('https://fixture.invalid/messages', {
        method: 'POST', body: JSON.stringify({ model: 'fixture-model', messages: [], tools: [{ name: 'must_not_escape' }] }),
      });
      assert.equal(first.status, 200);
      await fetch('https://fixture.invalid/messages', {
        method: 'POST', body: JSON.stringify({ model: 'fixture-model', messages: [], tools: [{ name: 'must_not_escape' }] }),
      });
      yield { type: 'text-delta', text: 'unreachable' };
    });
    await assert.rejects(async () => { for await (const _chunk of stream) { /* consume */ } },
      /exactly one provider wire attempt/);
    assert.equal(nativeFetches, 1, 'provider retry cannot reach a second wire');
    assert.equal(wires, 1);
    assert.deepEqual(sentTools, [], 'curation removes every provider tool');
  } finally {
    await admission.dispose();
    globalThis.fetch = originalFetch;
  }
  ok('A31/G0 curation wire adapter permits one fetch, removes all tools and rejects hidden provider retries');
  store.close();
}

console.log(`\n${checks} curation checks passed`);
