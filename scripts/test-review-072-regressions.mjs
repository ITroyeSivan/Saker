import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { settingsView, saveTaskSettings } from '../plugins/dsh-redteam-results/lib/task-settings.js';
import { indexKnowledgeEntry, knowledgeHome, migrateKnowledgeProject, readKnowledgeSource, searchKnowledgeIndex } from '../plugins/dsh-redteam-results/lib/knowledge-index.js';
import { boundedJson } from '../plugins/dsh-redteam-results/lib/knowledge-retrieval.js';
import { searchLegacyKnowledge, readLegacyKnowledgeRef } from '../plugins/dsh-redteam-results/lib/legacy-knowledge.js';
import { referenceReadForSession, referenceSearchForSession, dispatch } from '../plugins/dsh-redteam-results/lib/index.js';
import { createManualKnowledgeCuration, getKnowledgeCuration, saveKnowledgeCuration, updateKnowledgeCuration } from '../plugins/dsh-redteam-results/lib/knowledge-curation.js';
import { chooseTaskMode, startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { writeSceneContext, startCompetitionBudget } from '../plugins/dsh-redteam-results/lib/scene-context.js';
import { reserveModelCall } from '../plugins/dsh-redteam-results/lib/model-budget.js';
import { taskCostOverview } from '../plugins/dsh-redteam-results/lib/task-cost.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-review-072-'));
process.env.DSH_HOME = home;
const host = { maxWorkers: 8, modelAdmission: true, tokens: true };
let checks = 0;
const ok = label => { checks += 1; console.log('ok ' + label); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => createHash('sha256').update(String(value)).digest('hex');
function enable(store, id, strategy = 'knowledge-only') {
  const view = settingsView(store, id, { host });
  return saveTaskSettings(store, id, { requestId: 'enable-' + id + '-' + Math.random().toString(36).slice(2),
    expected: { settingsRevision: view.settingsRevision, sceneRevision: view.sceneRevision, roundId: view.roundId },
    patch: { knowledge: { enabled: true, strategy } } }, host);
}
function context(store, sessions) {
  return { sessions: { get: id => sessions.get(id) }, tools: { guard() {} }, web: {} };
}

{
  const store = openStore(':memory:');
  const sessions = new Map(['project-a', 'project-b'].map(id => [id, { id, header: { agentPreset: 'pentest' } }]));
  const ctx = context(store, sessions);
  enable(store, 'project-a'); enable(store, 'project-b');
  indexKnowledgeEntry({ projectKey: 'project-a', sourceId: 'private-a', title: 'A private', text: 'PRIVATE_A_MARKER' });
  const hit = searchKnowledgeIndex('project-a', { query: 'PRIVATE_A_MARKER' }).rows[0];
  await assert.rejects(referenceReadForSession(ctx, store, 'project-b', { ref: hit.ref }), /another project|ref_forbidden|belongs/);
  const source = await dispatch(ctx, store, 'knowledge.read', { sessionId: 'project-a', sourceId: 'private-a' });
  assert.match(source.text, /PRIVATE_A_MARKER/);
  indexKnowledgeEntry({ projectKey: 'project-a', sourceId: 'multi-section', title: 'Multi',
    text: ['# One', 'ONE_MARKER '.repeat(220), '# Two', 'TWO_MARKER '.repeat(220)].join('\n') });
  let cursor, all = '', firstPage;
  do {
    const page = await dispatch(ctx, store, 'knowledge.read', { sessionId: 'project-a', sourceId: 'multi-section', cursor, maxBytes: 4096 });
    firstPage ||= page; all += page.text; cursor = page.nextCursor;
  } while (cursor);
  assert.match(all, /ONE_MARKER/); assert.match(all, /TWO_MARKER/);
  assert(firstPage.sectionCount >= 2);
  ok('F02/F06 references and sourceId reads are scoped to the trusted project');
  store.close();
}

{
  const store = openStore(':memory:');
  const sessions = new Map([['only-session', { id: 'only-session', header: { agentPreset: 'pentest' } }]]);
  enable(store, 'only-session', 'knowledge-only');
  let calls = 0;
  const ctx = { sessions: { get: id => sessions.get(id) }, tools: { guard() {} },
    web: { fetch: async () => { calls += 1; return { statusCode: 200, body: { kind: 'text', content: 'WEB_BODY' } }; } } };
  const ref = 'web:' + Buffer.from(JSON.stringify({ url: 'https://example.invalid/', queryHash: 'x', at: Date.now() })).toString('base64url');
  const value = await referenceReadForSession(ctx, store, 'only-session', { ref });
  assert.equal(value.code, 'knowledge_only_web_read_denied');
  assert.equal(calls, 0);
  ok('F04 knowledge-only rejects web reads before touching fetch/cache');
  store.close();
}

{
  const store = openStore(':memory:');
  const sessions = new Map([['web-scope', { id: 'web-scope', header: { agentPreset: 'pentest' } }]]);
  enable(store, 'web-scope', 'web-first');
  let fetches = 0;
  const ctx = { sessions: { get: id => sessions.get(id) }, tools: { guard() {} }, web: {
    search: async () => ({ sources: [{ url: 'https://scope.example/page', title: 'Scoped page', snippet: 'scope marker' }] }),
    fetch: async () => { fetches += 1; return { statusCode: 200, body: { kind: 'text', content: 'SIGNED_WEB_BODY' } }; },
  } };
  const found = await referenceSearchForSession(ctx, store, 'web-scope', { query: 'scope marker' });
  const web = found.rows.find(row => row.sourceKind === 'web');
  assert(web);
  const opened = await referenceReadForSession(ctx, store, 'web-scope', { ref: web.ref });
  assert.match(opened.text, /SIGNED_WEB_BODY/);
  const forged = 'web:' + Buffer.from(JSON.stringify({ url: 'https://attacker.invalid/', queryHash: 'x', at: Date.now() })).toString('base64url');
  await assert.rejects(referenceReadForSession(ctx, store, 'web-scope', { ref: forged }), /authorized|signature|ref_forbidden/);
  assert.equal(fetches, 1);
  ok('F04 web refs are bound to the issuing project/strategy and cannot be forged into arbitrary URLs');
  store.close();
}

{
  const store = openStore(':memory:');
  const sessions = new Map([['scope-a', { id: 'scope-a', header: { agentPreset: 'pentest' } }], ['scope-b', { id: 'scope-b', header: { agentPreset: 'pentest' } }]]);
  const ctx = context(store, sessions);
  createManualKnowledgeCuration(store, { requestId: 'scope-curation', sessionId: 'scope-a', selectedText: 'PRIVATE_CURATION', sourceRef: 'a', projectKey: 'scope-a' });
  await assert.rejects(dispatch(ctx, store, 'curation.get', { sessionId: 'scope-b', requestId: 'scope-curation' }), /不存在/);
  await assert.rejects(dispatch(ctx, store, 'curation.update', { sessionId: 'scope-b', requestId: 'scope-curation', draft: { body: 'B changed A' } }), /不存在/);
  const own = await dispatch(ctx, store, 'curation.update', { sessionId: 'scope-a', requestId: 'scope-curation', expectedEditRevision: 0, draft: { body: 'A edited' } });
  assert.equal(own.curation.editRevision, 1);
  await assert.rejects(dispatch(ctx, store, 'curation.update', { sessionId: 'scope-a', requestId: 'scope-curation', expectedEditRevision: 0, draft: { body: 'stale overwrite' } }), /其他窗口/);
  ok('F03 curation reads/writes are scoped and stale edit revisions cannot overwrite');
  store.close();
}

{
  const store = openStore(':memory:');
  chooseTaskMode(store, 'budget-free', 'regular', {});
  const view = settingsView(store, 'budget-free', { host });
  saveTaskSettings(store, 'budget-free', { requestId: 'unmetered-save',
    expected: { settingsRevision: view.settingsRevision, sceneRevision: view.sceneRevision, roundId: view.roundId },
    patch: { budget: { unmeteredToolCalls: 0 } } }, host);
  assert.throws(() => startTaskPolicy(store, 'budget-free', { mode: 'regular', question: 'fixture', budget: { unmeteredToolCalls: 5 } }), /不能高于/);
  ok('F05 startup input cannot raise the saved unmetered-channel cap');
  store.close();
}

{
  const store = openStore(':memory:');
  const shared = 'C:/fixture/curation-workspace';
  const projectKey = 'workspace:' + sha(shared).slice(0, 32);
  const sessions = new Map([['draft-a', { id: 'draft-a', header: { agentPreset: 'pentest' }, cwd: shared }],
    ['draft-b', { id: 'draft-b', header: { agentPreset: 'pentest' }, cwd: shared }]]);
  const ctx = context(store, sessions);
  createManualKnowledgeCuration(store, { requestId: 'same-workspace-draft', sessionId: 'draft-a', selectedText: 'DRAFT_A_PRIVATE', sourceRef: 'a', projectKey });
  await assert.rejects(dispatch(ctx, store, 'curation.get', { sessionId: 'draft-b', requestId: 'same-workspace-draft' }), /不存在/);
  await assert.rejects(dispatch(ctx, store, 'curation.update', { sessionId: 'draft-b', requestId: 'same-workspace-draft', draft: { body: 'B overwrite' } }), /不存在/);
  const own = await dispatch(ctx, store, 'curation.get', { sessionId: 'draft-a', requestId: 'same-workspace-draft' });
  assert.equal(own.curation.draft.body, 'DRAFT_A_PRIVATE');
  ok('G01 unsaved curation drafts stay owned by their root session inside the same workspace');
  store.close();
}

{
  const store = openStore(':memory:');
  const shared = 'C:/fixture/migrate-workspace';
  const root = 'legacy-root-session';
  const projectKey = 'workspace:' + sha(shared).slice(0, 32);
  const sessions = new Map([[root, { id: root, header: { agentPreset: 'pentest' }, cwd: shared }]]);
  const ctx = context(store, sessions);
  enable(store, root);
  indexKnowledgeEntry({ projectKey: root, sourceId: 'old-index-entry', title: 'Old index', text: 'OLD_INDEX_MARKER' });
  store.db.prepare(`INSERT INTO competition_knowledge(session_id,source_id,revision,record,updated_at)
    VALUES(?,?,?,?,?)`).run(root, 'old-competition-entry', 1, JSON.stringify({ sourceId: 'old-competition-entry', revision: 1,
      title: 'Old competition', text: 'OLD_COMPETITION_MARKER', hidden: false, createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z' }), '2026-01-01T00:00:00.000Z');
  createManualKnowledgeCuration(store, { requestId: 'old-root-draft', sessionId: root, selectedText: 'OLD_DRAFT_MARKER', sourceRef: 'old', projectKey: root });
  const oldIndex = await referenceSearchForSession(ctx, store, root, { query: 'OLD_INDEX_MARKER' });
  assert(oldIndex.rows.some(row => row.title === 'Old index'));
  const oldCompetition = await referenceSearchForSession(ctx, store, root, { query: 'OLD_COMPETITION_MARKER' });
  assert(oldCompetition.rows.some(row => row.title === 'Old competition'));
  const oldDraft = await dispatch(ctx, store, 'curation.get', { sessionId: root, requestId: 'old-root-draft' });
  assert.equal(oldDraft.curation.draft.body, 'OLD_DRAFT_MARKER');
  assert.notEqual(projectKey, root);
  ok('G02 old session-key knowledge, competition rows and drafts remain readable after upgrade');
  store.close();
}

{
  const store = openStore(':memory:');
  writeSceneContext(store, 'competition-model', 'competition', { presetId: 'ctf-solver' });
  const view = settingsView(store, 'competition-model', { host });
  saveTaskSettings(store, 'competition-model', { requestId: 'competition-cap',
    expected: { settingsRevision: view.settingsRevision, sceneRevision: view.sceneRevision, roundId: view.roundId },
    patch: { budget: { minutes: 1, modelCalls: 3 } } }, host);
  reserveModelCall(store, 'competition-model', { provider: 'fixture', model: 'fixture' }, {});
  reserveModelCall(store, 'competition-model', { provider: 'fixture', model: 'fixture' }, {});
  const after = settingsView(store, 'competition-model', { host });
  assert.equal(after.effective.budget.used.modelCalls, 2);
  assert.throws(() => saveTaskSettings(store, 'competition-model', { requestId: 'competition-lower',
    expected: { settingsRevision: after.settingsRevision, sceneRevision: after.sceneRevision, roundId: after.roundId },
    patch: { budget: { modelCalls: 1 } } }, host), /不能低于/);
  writeSceneContext(store, 'competition-expired', 'competition', { presetId: 'ctf-solver' });
  const beforeExpired = settingsView(store, 'competition-expired', { host });
  saveTaskSettings(store, 'competition-expired', { requestId: 'competition-expired-save',
    expected: { settingsRevision: beforeExpired.settingsRevision, sceneRevision: beforeExpired.sceneRevision, roundId: beforeExpired.roundId },
    patch: { budget: { minutes: 1 } } }, host);
  startCompetitionBudget(store, 'competition-expired', Date.now() - 3 * 60000);
  const expired = settingsView(store, 'competition-expired', { host });
  assert.throws(() => saveTaskSettings(store, 'competition-expired', { requestId: 'competition-expired',
    expected: { settingsRevision: expired.settingsRevision, sceneRevision: expired.sceneRevision, roundId: expired.roundId },
    patch: { budget: { minutes: 1 } } }, host), /早于当前/);
  ok('F07 competition settings use the real model ledger and reject expired deadlines');
  store.close();
}

{
  const store = openStore(':memory:');
  const baseline = taskCostOverview({ agents: { get: () => undefined } }, store, 'manual-cost');
  createManualKnowledgeCuration(store, { requestId: 'manual-cost', sessionId: 'manual-cost', selectedText: 'manual body', sourceRef: 'manual' });
  const cost = taskCostOverview({ agents: { get: () => undefined } }, store, 'manual-cost');
  assert.equal(cost.modelCalls, baseline.modelCalls);
  assert.equal(cost.unknownUsageCalls, baseline.unknownUsageCalls);
  assert.equal(cost.auxiliaryCalls, baseline.auxiliaryCalls);
  ok('F08 manual curation drafts do not count as model calls');
  store.close();
}

{
  const payload = boundedJson({ ok: true, query: '中'.repeat(512), rows: [], nextCursor: 'x'.repeat(2300) }, 3072);
  assert(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 3072);
  const query = '盲注'.repeat(256);
  for (let index = 0; index < 7; index += 1) indexKnowledgeEntry({ projectKey: 'long-query', sourceId: 'long-' + index,
    title: 'Long ' + index, text: '# 长查询\n' + query + ' 命中', sourceLabel: 'fixture' });
  const result = searchKnowledgeIndex('long-query', { query, limit: 5 });
  assert(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 3072);
  assert(result.rows.length > 0, 'long query must not return hits with zero rows');
  assert.equal(result.status, 'hits');
  const store = openStore(':memory:');
  const sessions = new Map([['long-session', { id: 'long-session', header: { agentPreset: 'pentest' } }]]);
  for (let index = 0; index < 7; index += 1) indexKnowledgeEntry({ projectKey: 'long-session', sourceId: 'session-long-' + index,
    title: 'Session long ' + index, text: '# 长查询\n' + query + ' 命中', sourceLabel: 'fixture' });
  enable(store, 'long-session');
  const sessionResult = await referenceSearchForSession(context(store, sessions), store, 'long-session', { query, limit: 5 });
  assert(Buffer.byteLength(sessionResult.text, 'utf8') <= 3072);
  assert(sessionResult.rows.length > 0);
  store.close();
  ok('F09 bounded JSON includes the final envelope and keeps real rows for long queries');
}

{
  const value = boundedJson({ ok: true, status: 'hits', query: 'Q'.repeat(512),
    rows: [{ ref: 'r'.repeat(180), title: 'T'.repeat(240), section: 'S'.repeat(240), sourceLabel: 'L'.repeat(160),
      excerpt: 'E'.repeat(600) }], nextCursor: 'c'.repeat(512) }, 3072);
  assert(Buffer.byteLength(JSON.stringify(value), 'utf8') <= 3072);
  assert.equal(value.status, 'hits');
  assert.equal(value.rows.length, 1);
  ok('G04 long display metadata is shortened instead of deleting the only true hit');
}

{
  const store = openStore(':memory:');
  const sessions = new Map([['version-session', { id: 'version-session', header: { agentPreset: 'pentest' } }]]);
  const ctx = context(store, sessions);
  indexKnowledgeEntry({ projectKey: 'version-session', sourceId: 'versioned-source', title: 'Versioned',
    text: '# One\nOLD_VERSION\n' + ('old body '.repeat(800)) });
  const first = await dispatch(ctx, store, 'knowledge.read', { sessionId: 'version-session', sourceId: 'versioned-source', maxBytes: 2048 });
  assert(first.nextCursor);
  indexKnowledgeEntry({ projectKey: 'version-session', sourceId: 'versioned-source', title: 'Versioned',
    text: '# One\nNEW_VERSION\n' + ('new body '.repeat(800)) });
  await assert.rejects(dispatch(ctx, store, 'knowledge.read', { sessionId: 'version-session', sourceId: 'versioned-source', cursor: first.nextCursor, maxBytes: 2048 }), /expired|changed/);
  ok('G03 source cursors are bound to the exact document revision');
  store.close();
}

{
  const legacy = path.join(home, 'legacy-version', 'knowledge.sqlite');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  let db = new DatabaseSync(legacy);
  db.exec(`CREATE TABLE knowledge_docs(source_id TEXT,path TEXT,mtime_ms REAL,size INTEGER,sha1 TEXT,chunk_count INTEGER,indexed_at TEXT,doc_date TEXT DEFAULT '',version_conditions TEXT DEFAULT '',product_aliases TEXT DEFAULT '',PRIMARY KEY(source_id,path));
    CREATE VIRTUAL TABLE knowledge_chunks USING fts5(source_id UNINDEXED,kind UNINDEXED,scope UNINDEXED,pack_id UNINDEXED,license UNINDEXED,priority UNINDEXED,path,path_search,title,title_search,heading,heading_search,body,body_search,start_line UNINDEXED,end_line UNINDEXED,tokenize='unicode61');
    INSERT INTO knowledge_docs VALUES('bundle:versioned','versioned.md',0,10,'old-sha',1,'2026-01-01','','','');`);
  db.prepare(`INSERT INTO knowledge_chunks(source_id,kind,scope,pack_id,license,priority,path,path_search,title,title_search,heading,heading_search,body,body_search,start_line,end_line)
    VALUES('bundle:versioned','bundle','pentest','','',1,'versioned.md','','Versioned legacy','','Section','','LEGACY_VERSION_MARKER','',1,2)`).run();
  db.close();
  const hit = searchLegacyKnowledge('LEGACY_VERSION_MARKER', {}, { legacyDbPath: legacy });
  db = new DatabaseSync(legacy);
  db.prepare("UPDATE knowledge_docs SET sha1='new-sha' WHERE source_id='bundle:versioned'").run();
  db.prepare("UPDATE knowledge_chunks SET body='NEW_LEGACY_BODY' WHERE source_id='bundle:versioned'").run();
  db.close();
  assert.throws(() => readLegacyKnowledgeRef(hit.rows[0].ref, {}, { legacyDbPath: legacy }), /changed|expired/);
  ok('G03 legacy refs verify the current document sha1 before returning content');
}

{
  const file = path.join(home, 'worker-failure', 'results.db');
  const store = openStore(file);
  const sessions = new Map([['worker-failure', { id: 'worker-failure', header: { agentPreset: 'pentest' } }]]);
  const ctx = context(store, sessions);
  enable(store, 'worker-failure');
  store.dbPath = path.join(home, 'missing-parent', 'results.db');
  const result = await referenceSearchForSession(ctx, store, 'worker-failure', { query: 'anything' });
  assert.equal(result.code, 'index_unavailable');
  assert.equal(result.workerFallback, undefined);
  store.close();
  ok('G05 worker failure returns a bounded error instead of falling back to a synchronous scan');
}

{
  const store = openStore(':memory:');
  const sessions = new Map([['cancel-web', { id: 'cancel-web', header: { agentPreset: 'pentest' } }]]);
  enable(store, 'cancel-web', 'knowledge-first');
  const ctx = { sessions: { get: id => sessions.get(id) }, tools: { guard() {} },
    web: { search: () => new Promise(() => {}), fetch: () => new Promise(() => {}) } };
  const controller = new AbortController();
  const started = Date.now();
  const pending = referenceSearchForSession(ctx, store, 'cancel-web', { query: 'JWT algorithm confusion' }, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancel now'));
  const value = await Promise.race([pending, wait(300).then(() => ({ timeout: true }))]);
  assert(!value.timeout, 'abort must not wait for the 10s adapter timeout');
  assert(Date.now() - started < 300);
  ok('F10 cancellation returns without waiting for a non-cooperative adapter');
  store.close();
}

{
  const legacy = path.join(home, 'refs', '.index', 'knowledge.sqlite');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const db = new DatabaseSync(legacy);
  db.exec(`CREATE TABLE knowledge_docs(source_id TEXT,path TEXT,mtime_ms REAL,size INTEGER,sha1 TEXT,chunk_count INTEGER,indexed_at TEXT,doc_date TEXT DEFAULT '',version_conditions TEXT DEFAULT '',product_aliases TEXT DEFAULT '',PRIMARY KEY(source_id,path));
    CREATE VIRTUAL TABLE knowledge_chunks USING fts5(source_id UNINDEXED,kind UNINDEXED,scope UNINDEXED,pack_id UNINDEXED,license UNINDEXED,priority UNINDEXED,path,path_search,title,title_search,heading,heading_search,body,body_search,start_line UNINDEXED,end_line UNINDEXED,tokenize='unicode61');
    INSERT INTO knowledge_docs VALUES('bundle:legacy','legacy.md',0,10,'legacy-sha',1,'2026-01-01','','','');`);
  db.prepare(`INSERT INTO knowledge_chunks(source_id,kind,scope,pack_id,license,priority,path,path_search,title,title_search,heading,heading_search,body,body_search,start_line,end_line)
    VALUES('bundle:legacy','bundle','pentest','','',1,'legacy.md','','Legacy manual','','Legacy section','','LEGACY_LIBRARY_MARKER','',1,2)`).run();
  db.close();
  const legacyHit = searchLegacyKnowledge('LEGACY_LIBRARY_MARKER');
  assert.equal(legacyHit.rows.length, 1);
  const page = readLegacyKnowledgeRef(legacyHit.rows[0].ref);
  assert.match(page.text, /LEGACY_LIBRARY_MARKER/);
  const store = openStore(':memory:');
  const sessions = new Map([['legacy-session', { id: 'legacy-session', header: { agentPreset: 'pentest' } }]]);
  const ctx = context(store, sessions);
  enable(store, 'legacy-session');
  const found = await referenceSearchForSession(ctx, store, 'legacy-session', { query: 'LEGACY_LIBRARY_MARKER' });
  assert(found.rows.some(row => row.title === 'Legacy manual'));
  const opened = await referenceReadForSession(ctx, store, 'legacy-session', { ref: found.rows[0].ref });
  assert.match(opened.text, /LEGACY_LIBRARY_MARKER/);
  const managed = await dispatch(ctx, store, 'knowledge.search', { sessionId: 'legacy-session', query: 'LEGACY_LIBRARY_MARKER' });
  assert(managed.rows.some(row => String(row.ref || '').startsWith('legacy:')));
  const managedRead = await dispatch(ctx, store, 'knowledge.read', { sessionId: 'legacy-session', ref: managed.rows[0].ref });
  assert.match(managedRead.text, /LEGACY_LIBRARY_MARKER/);
  const imported = await dispatch(ctx, store, 'knowledge.import-text', { sessionId: 'legacy-session', title: 'Imported UI fixture', text: 'IMPORTED_UI_MARKER' });
  assert.equal(imported.source.indexState, 'ready');
  const listed = await dispatch(ctx, store, 'knowledge.list', { sessionId: 'legacy-session' });
  assert(listed.rows.some(row => row.sourceId === imported.source.sourceId));
  const importedRead = await dispatch(ctx, store, 'knowledge.read', { sessionId: 'legacy-session', sourceId: imported.source.sourceId });
  assert.match(importedRead.text, /IMPORTED_UI_MARKER/);
  store.close();
  ok('F01 legacy full library remains queryable/readable without rewriting it');
}

{
  const file = path.join(home, 'worker-results', 'results.db');
  const store = openStore(file);
  const sessions = new Map([['worker-session', { id: 'worker-session', header: { agentPreset: 'pentest' } }]]);
  const ctx = context(store, sessions);
  indexKnowledgeEntry({ projectKey: 'worker-session', sourceId: 'worker-note', title: 'Worker note', text: 'WORKER_SEARCH_MARKER' });
  enable(store, 'worker-session');
  const result = await referenceSearchForSession(ctx, store, 'worker-session', { query: 'WORKER_SEARCH_MARKER' });
  assert(result.rows.some(row => row.title === 'Worker note'));
  assert.equal(result.workerSearch, true, JSON.stringify({ workerFallback: result.workerFallback, workerError: result.workerError }));
  store.close();
  ok('F10 file-backed local search runs in a cancellable worker');
}

{
  const store = openStore(':memory:');
  const shared = 'C:/fixture/shared-workspace';
  const projectKey = 'workspace:' + sha(shared).slice(0, 32);
  const sessions = new Map([['same-a', { id: 'same-a', header: { agentPreset: 'pentest' }, cwd: shared }],
    ['same-b', { id: 'same-b', header: { agentPreset: 'pentest' }, cwd: shared }]]);
  const ctx = context(store, sessions);
  indexKnowledgeEntry({ projectKey, sourceId: 'shared-note', title: 'Shared', text: 'SAME_WORKSPACE_MARKER' });
  enable(store, 'same-a'); enable(store, 'same-b');
  for (const id of ['same-a', 'same-b']) {
    const hit = await referenceSearchForSession(ctx, store, id, { query: 'SAME_WORKSPACE_MARKER' });
    assert(hit.rows.some(row => row.title === 'Shared'));
  }
  const manual = createManualKnowledgeCuration(store, { requestId: 'global-save', sessionId: 'same-a', selectedText: 'GLOBAL_MARKER', sourceRef: 'g', projectKey });
  saveKnowledgeCuration(store, manual.requestId, { userConfirmed: true, visibility: 'global', title: 'Global note', body: 'GLOBAL_MARKER', sources: 'fixture' }, { projectKey });
  const globalHit = searchKnowledgeIndex('other-project', { query: 'GLOBAL_MARKER' });
  assert(globalHit.rows.some(row => row.title === 'Global note'));
  ok('F01 workspace sharing and explicit personal-global saves follow the project scope');
  store.close();
}

{
  const client = fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
  const component = client.slice(client.indexOf('function CurationAction('), client.indexOf('function ChatKnowledgeLibrary('));
  let cursor = 0;
  const states = [];
  const calls = [];
  const effects = [];
  const sandbox = {
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index]; },
    useEffect(fn) { effects.push(fn); }, React: { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    api: async (endpoint, payload) => {
      calls.push(endpoint);
      if (endpoint === 'curation.available') return { ok: true, available: true, model: { provider: 'fixture', model: 'fixture-model' }, route: 'local', routeLabel: '本地模型' };
      if (endpoint === 'curation.start') return { ok: true, curation: { requestId: payload.requestId, state: 'queued', editRevision: 0, model: payload.model, draft: {} } };
      return { ok: true };
    },
    messageTextBlocks() { return ''; }, chatError: value => value.error || 'error', curationSessionBridge: { sessionId: '' },
    setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, console,
  };
  vm.runInNewContext(component + '; this.CurationAction=CurationAction;', sandbox);
  const render = () => { cursor = 0; effects.length = 0; return sandbox.CurationAction({ sessionId: 'ui-session', selectedText: 'selected body', sourceRef: 'a' }); };
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children || []).flat(Infinity).flatMap(nodes)];
  render(); for (const effect of effects.slice()) effect(); await wait(0);
  const prefetched = JSON.stringify(render());
  assert.match(prefetched, /本地模型/, 'model/route must be visible before the click');
  assert(!calls.includes('curation.start'), 'mount-time prefetch must not send');
  const trigger = () => nodes(render()).find(node => node.type === 'button' && node.props.className === 'dsh-curation-trigger');
  await trigger().props.onClick();
  await wait(0);
  assert.equal(calls.filter(call => call === 'curation.start').length, 1, 'one trigger click must start exactly one curation');
  ok('F11 curation exposes model/route before the click and still starts with one action');
}

{
  const source = 'h01-old-root';
  const destination = 'workspace:' + sha('C:/fixture/h01-workspace').slice(0, 32);
  const first = indexKnowledgeEntry({ projectKey: source, sourceId: 'stable-note', title: 'Stable source', text: 'H01_SOURCE_VERSION_A' });
  indexKnowledgeEntry({ projectKey: destination, sourceId: 'stable-note', title: 'Stable source', text: 'H01_DEST_VERSION_B' });
  const oldFile = path.join(knowledgeHome(), 'entries', first.docId + '-' + first.digest.slice(0, 16) + '.txt');
  assert.equal(fs.existsSync(oldFile), true);
  const migration = migrateKnowledgeProject(source, destination);
  assert.equal(migration.conflicts, 1);
  assert.equal(migration.merged, 0);
  assert.equal(searchKnowledgeIndex(source, { query: 'H01_SOURCE_VERSION_A' }).rows.length, 0);
  assert.equal(searchKnowledgeIndex(destination, { query: 'H01_SOURCE_VERSION_A' }).rows.length, 1);
  assert.equal(searchKnowledgeIndex(destination, { query: 'H01_DEST_VERSION_B' }).rows.length, 1);
  const db = new DatabaseSync(path.join(knowledgeHome(), 'index-v1.db'), { readOnly: true });
  try {
    const migrated = db.prepare('SELECT source_id,metadata FROM knowledge_documents WHERE project_key=? AND digest=?').get(destination, first.digest);
    assert(migrated);
    assert.match(migrated.source_id, /::legacy-/);
    assert.equal(JSON.parse(migrated.metadata).migrationConflict.originalSourceId, 'stable-note');
  } finally { db.close(); }
  const duplicateSource = 'h01-duplicate-old';
  const duplicateDestination = 'workspace:' + sha('C:/fixture/h01-duplicate-workspace').slice(0, 32);
  const duplicateInput = { sourceId: 'same-content', title: 'Same content', text: 'H01_EXACT_SAME_CONTENT' };
  indexKnowledgeEntry({ ...duplicateInput, projectKey: duplicateSource });
  indexKnowledgeEntry({ ...duplicateInput, projectKey: duplicateDestination });
  const exact = migrateKnowledgeProject(duplicateSource, duplicateDestination);
  assert.equal(exact.merged, 1);
  assert.equal(exact.updated, 0);
  assert.equal(exact.conflicts, 0);
  assert.equal(searchKnowledgeIndex(duplicateDestination, { query: 'H01_EXACT_SAME_CONTENT' }).rows.length, 1);
  ok('H01 same sourceId with different content preserves both indexed versions and records the conflict');
}

{
  const file = path.join(home, 'h02-worker', 'results.db');
  const store = openStore(file);
  const cwd = 'C:/fixture/h02-multiple-roots';
  const roots = ['h02-root-a', 'h02-root-b'];
  const sessions = new Map(roots.map(id => [id, { id, header: { agentPreset: 'ctf-solver' }, cwd }]));
  const ctx = context(store, sessions);
  for (const [index, id] of roots.entries()) {
    writeSceneContext(store, id, 'competition', { presetId: 'ctf-solver' });
    enable(store, id);
    store.db.prepare(`INSERT INTO competition_knowledge(session_id,source_id,revision,record,updated_at)
      VALUES(?,?,?,?,?)`).run(id, 'h02-note-' + id, 1, JSON.stringify({
      sourceId: 'h02-note-' + id, revision: 1, title: 'H02 note ' + id,
      text: 'H02_ROOT_MARKER_' + (index + 1),
    }), '2026-11-08');
  }
  const first = await referenceSearchForSession(ctx, store, roots[0], { query: 'H02_ROOT_MARKER_1' });
  const second = await referenceSearchForSession(ctx, store, roots[1], { query: 'H02_ROOT_MARKER_2' });
  assert.equal(first.rows.length, 1);
  assert.equal(second.rows.length, 1);
  assert.equal(first.workerSearch, true);
  assert.equal(second.workerSearch, true);
  store.db.prepare(`INSERT INTO competition_knowledge(session_id,source_id,revision,record,updated_at)
    VALUES(?,?,?,?,?)`).run(roots[1], 'h02-note-' + roots[1], 2, JSON.stringify({
    sourceId: 'h02-note-' + roots[1], revision: 2, title: 'H02 note updated',
    text: 'H02_ROOT_MARKER_2_UPDATED',
  }), '2026-11-08T00:00:01.000Z');
  const refreshed = await referenceSearchForSession(ctx, store, roots[1], { query: 'H02_ROOT_MARKER_2_UPDATED' });
  assert.equal(refreshed.rows.length, 1);
  store.close();
  ok('H02 legacy migration state is isolated per root session and refreshes when the source revision changes');
}

{
  const store = openStore(':memory:');
  const root = 'h03-reimport-root';
  const cwd = 'C:/fixture/h03-reimport';
  const ctx = context(store, new Map([[root, { id: root, header: { agentPreset: 'pentest' }, cwd }]]));
  enable(store, root);
  const text = 'H03_REIMPORT_SAME_CONTENT';
  const sourceId = 'knowledge-' + sha(text).slice(0, 16);
  indexKnowledgeEntry({ projectKey: root, sourceId, title: 'H03 note', text });
  const listed = await dispatch(ctx, store, 'knowledge.list', { sessionId: root });
  assert(listed.rows.some(row => row.sourceId === sourceId));
  const imported = await dispatch(ctx, store, 'knowledge.import-text', { sessionId: root, title: 'H03 note', text });
  assert.equal(imported.source.indexState, 'ready');
  assert.equal(imported.source.indexError, undefined);
  assert.equal(searchKnowledgeIndex('workspace:' + sha(cwd).slice(0, 32), { query: text }).rows.length, 1);
  store.close();
  ok('H03 migrated document rekeys its stable identity so normal re-import is idempotent');
}

{
  const store = openStore(':memory:');
  const legacyRoot = 'h03b-legacy-root';
  const cwd = 'C:/fixture/h03b-existing-migration';
  const destination = 'workspace:' + sha(cwd).slice(0, 32);
  const ctx = context(store, new Map([[legacyRoot, { id: legacyRoot, header: { agentPreset: 'pentest' }, cwd }]]));
  enable(store, legacyRoot);
  const text = 'H03B_REPAIR_ALREADY_MIGRATED_IDENTITY';
  const sourceId = 'knowledge-' + sha(text).slice(0, 16);
  const created = indexKnowledgeEntry({ projectKey: legacyRoot, sourceId, title: 'H03B note', text });
  const expectedDocId = 'k-' + sha([destination, 'project', sourceId].join('\0')).slice(0, 32);
  assert.notEqual(created.docId, expectedDocId);
  const indexDbFile = path.join(knowledgeHome(), 'index-v1.db');
  const indexDb = new DatabaseSync(indexDbFile);
  try { indexDb.prepare('UPDATE knowledge_documents SET project_key=? WHERE doc_id=?').run(destination, created.docId); }
  finally { indexDb.close(); }
  const imported = await dispatch(ctx, store, 'knowledge.import-text', { sessionId: legacyRoot, title: 'H03B note', text });
  assert.equal(imported.source.indexState, 'ready');
  const checkDb = new DatabaseSync(indexDbFile, { readOnly: true });
  try {
    assert.equal(checkDb.prepare('SELECT COUNT(*) AS n FROM knowledge_documents WHERE doc_id=?').get(created.docId).n, 0);
    assert.equal(checkDb.prepare('SELECT COUNT(*) AS n FROM knowledge_documents WHERE doc_id=?').get(expectedDocId).n, 1);
    assert.equal(checkDb.prepare('SELECT COUNT(*) AS n FROM knowledge_sections WHERE doc_id=?').get(expectedDocId).n > 0, true);
  } finally { checkDb.close(); }
  store.close();
  ok('H03 existing 0.7.4 records with an old docId self-repair before re-import');
}

{
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(home, 'h04-clean-home');
  try {
    const store = openStore(':memory:');
    const id = 'h04-disabled-prefetch';
    const ctx = context(store, new Map([[id, { id, header: { agentPreset: 'pentest' }, cwd: 'C:/fixture/h04' }]]));
    const indexFile = path.join(knowledgeHome(), 'index-v1.db');
    assert.equal(fs.existsSync(indexFile), false);
    const available = await dispatch(ctx, store, 'curation.available', { sessionId: id });
    assert.equal(available.available, false);
    assert.equal(fs.existsSync(indexFile), false);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM knowledge_curations').get().n, 0);
    store.close();
  } finally { process.env.DSH_HOME = previousHome; }
  ok('H04 disabled metadata prefetch does not open, migrate or write the knowledge index');
}

{
  const source = 'j01-metadata-old';
  const destination = 'workspace:' + sha('C:/fixture/j01-semantic-workspace').slice(0, 32);
  const common = { sourceId: 'stable-method', title: 'Reusable method', text: 'J01_SAME_METHOD_BODY',
    product: 'Fixture', version: '1.0' };
  indexKnowledgeEntry({ ...common, projectKey: source, sourceDate: '2026-01-01', metadata: {
    conditions: 'Only when FLAG_A is enabled', sources: 'SOURCE_A_EVIDENCE', verification: '待验证经验',
    importedAt: '2026-01-01T00:00:00Z',
  } });
  indexKnowledgeEntry({ ...common, projectKey: destination, sourceDate: '2026-02-01', metadata: {
    conditions: 'Only when FLAG_B is enabled', sources: 'SOURCE_B_EVIDENCE', verification: '用户已检查',
    importedAt: '2026-02-01T00:00:00Z',
  } });
  const conflict = migrateKnowledgeProject(source, destination);
  assert.equal(conflict.conflicts, 1);
  assert.equal(conflict.merged, 0);
  const indexDb = new DatabaseSync(path.join(knowledgeHome(), 'index-v1.db'), { readOnly: true });
  try {
    const rows = indexDb.prepare('SELECT metadata FROM knowledge_documents WHERE project_key=?').all(destination);
    assert.equal(rows.length, 2);
    assert(rows.some(row => row.metadata.includes('SOURCE_A_EVIDENCE') && row.metadata.includes('FLAG_A')));
    assert(rows.some(row => row.metadata.includes('SOURCE_B_EVIDENCE') && row.metadata.includes('FLAG_B')));
  } finally { indexDb.close(); }

  const technicalSource = 'j01-technical-old';
  const technicalDestination = 'workspace:' + sha('C:/fixture/j01-technical-workspace').slice(0, 32);
  const technical = { projectKey: technicalSource, sourceId: 'technical-only', title: 'Technical only',
    text: 'J01_TECHNICAL_ONLY', sourceDate: '2026-03-01',
    metadata: { conditions: 'same', sources: 'same-source', verification: '用户已检查', importedAt: 'old-import' } };
  indexKnowledgeEntry(technical);
  indexKnowledgeEntry({ ...technical, projectKey: technicalDestination, metadata: {
    conditions: 'same', sources: 'same-source', verification: '用户已检查', importedAt: 'new-import',
  } });
  const technicalMigration = migrateKnowledgeProject(technicalSource, technicalDestination);
  assert.equal(technicalMigration.merged, 1);
  assert.equal(technicalMigration.conflicts, 0);
  assert.equal(searchKnowledgeIndex(technicalDestination, { query: 'J01_TECHNICAL_ONLY' }).rows.length, 1);
  ok('J01 semantic metadata differences preserve both records while technical-only time noise still deduplicates');
}

{
  const store = openStore(path.join(home, 'j02-worker', 'results.db'));
  const cwd = 'C:/fixture/j02-two-legacy-roots';
  const roots = ['j02-root-a', 'j02-root-b'];
  const sessions = new Map(roots.map(id => [id, { id, header: { agentPreset: 'ctf-solver' }, cwd }]));
  const ctx = context(store, sessions);
  for (const [index, id] of roots.entries()) {
    writeSceneContext(store, id, 'competition', { presetId: 'ctf-solver' });
    enable(store, id);
    store.db.prepare(`INSERT INTO competition_knowledge(session_id,source_id,revision,record,updated_at)
      VALUES(?,?,?,?,?)`).run(id, 'shared-stable-j02', 1, JSON.stringify({
      sourceId: 'shared-stable-j02', revision: 1, title: 'Same logical ID',
      text: index === 0 ? 'J02_LEGACY_ALPHA' : 'J02_LEGACY_BETA',
    }), '2026-11-08');
  }
  const first = await referenceSearchForSession(ctx, store, roots[0], { query: 'J02_LEGACY_ALPHA' });
  const second = await referenceSearchForSession(ctx, store, roots[1], { query: 'J02_LEGACY_BETA' });
  const firstAgain = await referenceSearchForSession(ctx, store, roots[0], { query: 'J02_LEGACY_ALPHA' });
  assert.equal(first.rows.length, 1);
  assert.equal(second.rows.length, 1);
  assert.equal(firstAgain.rows.length, 1);
  assert([first, second, firstAgain].every(result => result.workerSearch === true));
  const destination = 'workspace:' + sha(cwd).slice(0, 32);
  const indexDb = new DatabaseSync(path.join(knowledgeHome(), 'index-v1.db'), { readOnly: true });
  let projectedRows = [];
  try {
    projectedRows = indexDb.prepare(`SELECT source_id,metadata FROM knowledge_documents
      WHERE project_key=? AND source_id LIKE 'shared-stable-j02::legacy-root-%'`).all(destination);
    assert.equal(projectedRows.length, 2);
    assert(projectedRows.some(row => JSON.parse(row.metadata).legacyRootSessionId === roots[0]));
    assert(projectedRows.some(row => JSON.parse(row.metadata).legacyRootSessionId === roots[1]));
  } finally { indexDb.close(); }
  store.db.prepare(`INSERT INTO competition_knowledge(session_id,source_id,revision,record,updated_at)
    VALUES(?,?,?,?,?)`).run(roots[0], 'shared-stable-j02', 2, JSON.stringify({
    sourceId: 'shared-stable-j02', revision: 2, title: 'Same logical ID updated',
    text: 'J02_LEGACY_ALPHA_UPDATED',
  }), '2026-11-08T00:00:01.000Z');
  const updated = await referenceSearchForSession(ctx, store, roots[0], { query: 'J02_LEGACY_ALPHA_UPDATED' });
  const betaStill = await referenceSearchForSession(ctx, store, roots[1], { query: 'J02_LEGACY_BETA' });
  const updatedAgain = await referenceSearchForSession(ctx, store, roots[0], { query: 'J02_LEGACY_ALPHA_UPDATED' });
  assert.equal(updated.rows.length, 1);
  assert.equal(betaStill.rows.length, 1);
  assert.equal(updatedAgain.rows.length, 1);
  const betaProjection = projectedRows.find(row => JSON.parse(row.metadata).legacyRootSessionId === roots[1]);
  const removed = await dispatch(ctx, store, 'knowledge.delete', { sessionId: roots[1], sourceId: betaProjection.source_id });
  assert.equal(removed.hidden, true);
  const legacyRows = store.db.prepare(`SELECT session_id,record FROM competition_knowledge
    WHERE source_id='shared-stable-j02' ORDER BY session_id,revision`).all();
  assert.equal(JSON.parse(legacyRows.find(row => row.session_id === roots[1]).record).hidden, true);
  assert.notEqual(JSON.parse(legacyRows.find(row => row.session_id === roots[0]).record).hidden, true);
  store.close();
  ok('J02 legacy projection identity keeps root+source revisions separate and idempotent');
}

{
  const client = fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
  const source = client.slice(client.indexOf('function installCurationStyles('), client.indexOf('function installChatSetupStyles('));
  let appended = 0, removed = 0;
  let installedStyle = null;
  const sandbox = { document: { createElement: () => {
    const style = { id: '', textContent: '', remove() { removed += 1; } };
    installedStyle = style;
    return style;
  }, getElementById: () => null, head: { appendChild: () => { appended += 1; } } } };
  vm.runInNewContext(source + ';this.install=installCurationStyles;', sandbox);
  const dispose = sandbox.install();
  assert.equal(appended, 1, 'curation stylesheet must be attached to the document');
  assert.match(installedStyle.textContent, /\.dsh-curation-actions\{[^}]*position:sticky/, 'curation actions must stay reachable while the form scrolls');
  assert.match(installedStyle.textContent, /\.dsh-curation-actions\{[^}]*bottom:-16px/, 'curation actions must pin to the body edge');
  assert.match(client, /'可复用做法或结论'.*rows:5/, 'curation form must leave room for its actions at the default desktop size');
  dispose();
  assert.equal(removed, 1, 'dispose must remove the attached stylesheet');
  ok('G06 curation dialog CSS is actually installed in the host document');
}

console.log(`\n${checks} review regressions passed`);
