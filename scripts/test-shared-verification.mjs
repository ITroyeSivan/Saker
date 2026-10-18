import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveChecks } from '../plugins/dsh-redteam-results/lib/checked.js';
import { saveTaskContext, readTaskContext, readTaskRecord, readSavedVerification, taskContextView } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { mergeSavedVerification } from '../plugins/dsh-nday-hunter/lib/verification-queue.js';
import { importPastedMaterial } from '../plugins/dsh-redteam-results/lib/materials-import.js';
import { verificationBasis } from '../lib/verification-basis.mjs';
let failed = 0;
async function test(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); } }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-shared-'));
process.env.DSH_HOME = home; process.env.DSH_ATLAS_DB = path.join(home, 'unused-atlas.db');
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const nday = await import('../plugins/dsh-nday-hunter/lib/index.js');
const store = openStore(path.join(home, 'redteam-results', 'results.db')), disposers = [];
const catalog = JSON.parse(fs.readFileSync(new URL('../preset/pentest/refs/nday/catalog.json', import.meta.url), 'utf8'));
const check = { assetId: 'a', entryId: catalog.entries[0].id, endpoint: 'https://fixture.test/input', methodVersion: 'v1', authContext: 'account-a', requestRevision: 'baseline-v1',
  conditions: [{ name: 'affected-component', state: 'satisfied', evidenceIds: ['component'] }],
  productConfirmed: true, productEvidenceIds: ['product'], requestValid: true, baselineEvidenceIds: ['baseline'], methodReviewed: true };
const context = { assets: [{ id: 'a', url: 'https://fixture.test', inScope: true, reachable: true }], checks: [check],
  requests: [{ id: 'baseline', endpoint: check.endpoint, authContext: check.authContext, revision: check.requestRevision, valid: true, request: 'GET /input HTTP/1.1', response: 'HTTP/1.1 200 OK' }],
  methods: [{ id: check.entryId, version: 'v1', reviewed: true }], maxSupplementAttempts: 2 };
const history = { ...check, status: 'not-hit', executed: true, observationValid: true, evidenceIds: ['negative-control-response'] };
try {
  await test('shared assets requests methods and conditions persist under the exact session', () => {
    saveTaskContext(store, 's1', context); saveChecks(store, 's1', [history]);
    assert.deepEqual(readTaskContext(store, 's1'), { ...context, assets: [{ ...context.assets[0], url: 'https://fixture.test/' }] });
    assert.equal(readTaskContext(store, 's2'), null);
    const saved = readSavedVerification(home, 's1');
    assert.equal(saved.available, true); assert.equal(saved.history.length, 1); assert.equal(saved.context.requests[0].id, 'baseline');
  });
  await test('history auto-merges while explicit current contexts can change identity without reviving old checks', () => {
    const saved = readSavedVerification(home, 's1');
    assert.equal(mergeSavedVerification(undefined, saved).checks[0].authContext, 'account-a');
    const fresh = mergeSavedVerification({ ...context, checks: [{ ...check, authContext: 'account-b' }], history: [{ ...history, status: 'not-tested' }] }, saved);
    assert.equal(fresh.checks[0].authContext, 'account-b'); assert.equal(fresh.history[0].status, 'not-hit');
    assert.throws(() => mergeSavedVerification({ history: [history, history] }, saved), /duplicate history/);
  });
  await test('missing damaged or old stores remain unknown and are never created or healed', () => {
    const missing = path.join(home, 'missing');
    assert.equal(readSavedVerification(missing, 's1').reason, 'task-store-missing'); assert.equal(fs.existsSync(missing), false);
    const bad = path.join(home, 'bad', 'redteam-results'); fs.mkdirSync(bad, { recursive: true }); fs.writeFileSync(path.join(bad, 'results.db'), 'broken');
    assert.equal(readSavedVerification(path.join(home, 'bad'), 's1').available, false);
    assert.equal(fs.readFileSync(path.join(bad, 'results.db'), 'utf8'), 'broken');
    assert.equal(readSavedVerification(home, '').reason, 'session-unavailable');
  });
  await test('malformed context updates preserve the previous complete snapshot', () => {
    for (const patch of [{ checks: [{ ...check, endpoint: 'https://other.test/' }] }, { assets: [context.assets[0], context.assets[0]] }, { maxSupplementAttempts: -1 }]) {
      assert.throws(() => saveTaskContext(store, 's1', { ...context, ...patch }));
    }
    assert.equal(readTaskContext(store, 's1').checks[0].endpoint, check.endpoint);
  });
  await test('actual shared-context tool and Nday planner reuse persisted current-session evidence automatically', async () => {
    const tools = new Map();
    const ctx = { tools: { register: tool => tools.set(tool.name, tool) }, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); }, webServer: { register: () => () => {} } };
    results.apply(ctx); nday.apply(ctx, { exposedTools: ['nday_priority_plan'] });
    const exec = { agent: { session: { id: 's1', header: { agentPreset: 'pentest' } } } };
    const saved = await tools.get('redteam_context').execute({ context: JSON.stringify(context) }, exec); assert.equal(saved.ok, true, saved.error);
    const detail = await tools.get('redteam_context').execute({ kind: 'request', id: 'baseline', version: 'baseline-v1' }, exec);
    assert.equal(detail.ok, true, detail.error);
    assert.match(tools.get('redteam_context').output.render({}, detail)[0].text, /GET \/input/);
    assert.match(tools.get('redteam_context').output.render({}, detail)[0].text, /HTTP\/1.1 200 OK/);
    // 模型侧资料搜索（v6 第 5.4.1 节）：5 条短结果 + 3000 字节封顶，且不能和快照混调。
    const found = await tools.get('redteam_context').execute({ search: 'input' }, exec);
    assert.equal(found.ok, true, found.error);
    assert.equal(found.pageSize, 5, '搜索每页 5 条');
    assert(found.results.length >= 1, '能搜到已保存的请求');
    assert(Buffer.byteLength(found.text) <= 3000, '搜索输出按 3000 字节封顶');
    assert.match(found.text, /input/);
    const mixed = await tools.get('redteam_context').execute({ search: 'input', context: '{}' }, exec);
    assert.equal(mixed.ok, false); assert.match(mixed.error, /只传search/);
    // 模型读原文（v6 第 5.4.1 节）：kind=material + id + read 走真实注册表返回分段，默认 ≤6000 字节。
    const material = importPastedMaterial(store, 's1', { name: 'big.js', text: Array.from({ length: 200 }, (_, i) => 'const v' + i + ' = ' + i + ';').join('\n') }, { home });
    const excerpt = await tools.get('redteam_context').execute({ kind: 'material', id: material.id, read: 0 }, exec);
    assert.equal(excerpt.ok, true, excerpt.error);
    assert.equal(excerpt.kind, 'code'); assert(excerpt.lines <= 80); assert(excerpt.nextOffset > 0);
    // 模型真的读了原文才记「已读过」（v6 第 5.4 节）；本地浏览与引用到输入框都不算。
    const readRow = store.db.prepare('SELECT material_id,bytes FROM material_reads WHERE session_id=?').get('s1');
    assert(readRow, '模型读原文要记一条已读');
    assert.equal(readRow.material_id, 'file:' + material.id);
    assert(readRow.bytes > 0, '记下实际读了多少字节');
    const badRead = await tools.get('redteam_context').execute({ read: 0 }, exec);
    assert.equal(badRead.ok, false); assert.match(badRead.error, /kind=material/);
    const first = await tools.get('nday_priority_plan').execute({ entryIds: check.entryId }, exec);
    assert.equal(first.ok, true, first.error); assert.equal(first.plan.verificationQueue.items[0].action, 'reuse-record');
    assert.equal(first.plan.sharedHistory.storedChecks, 1);
    const other = await tools.get('nday_priority_plan').execute({ entryIds: check.entryId }, { agent: { session: { id: 's2' } } });
    assert.equal(other.plan.verificationQueue.items.length, 0);
    for (const field of ['methodVersion', 'authContext', 'requestRevision']) {
      const changed = { ...context, checks: [{ ...check, [field]: 'changed', ...(field === 'authContext' ? { requestRevision: 'account-b-baseline' } : {}) }],
        requests: [{ ...context.requests[0], ...(field === 'authContext' ? { authContext: 'changed', revision: 'account-b-baseline' } : {}), ...(field === 'requestRevision' ? { revision: 'changed' } : {}) }],
        methods: [{ ...context.methods[0], ...(field === 'methodVersion' ? { version: 'changed' } : {}) }] };
      const written = await tools.get('redteam_context').execute({ context: JSON.stringify(changed) }, exec);
      assert.equal(written.ok, true, written.error);
      const fresh = await tools.get('nday_priority_plan').execute({ entryIds: check.entryId }, exec);
      assert.equal(fresh.ok, true, fresh.error); assert.equal(fresh.plan.verificationQueue.items[0].reuse, false, field);
    }
    const historical = await tools.get('redteam_context').execute({ kind: 'request', id: 'baseline', version: 'baseline-v1' }, exec);
    assert.equal(historical.ok, true, historical.error);
    assert.equal(historical.historical, true);
    assert.match(historical.text, /GET \/input/);
    const crossSession = await tools.get('redteam_context').execute({ kind: 'request', id: 'baseline', version: 'baseline-v1' }, { agent: { session: { id: 's2', header: { agentPreset: 'pentest' } } } });
    assert.equal(crossSession.ok, false);
    const denied = await tools.get('redteam_context').execute({}, { agent: { session: { id: 's1', header: { agentPreset: 'code-audit' } } } });
    assert.equal(denied.ok, false);
  });
  await test('valid checks cannot point to missing mismatched unreviewed or invalid baseline records', () => {
    for (const patch of [
      { requests: [] }, { requests: [{ ...context.requests[0], authContext: 'other' }] },
      { requests: [{ ...context.requests[0], revision: 'other' }] },
      { requests: [{ ...context.requests[0], endpoint: 'https://fixture.test/other' }] },
      { requests: [{ ...context.requests[0], valid: false }] },
      { methods: [] }, { methods: [{ ...context.methods[0], reviewed: false }] },
      { methods: [{ ...context.methods[0], version: 'other' }] },
      { requests: [context.requests[0], context.requests[0]] },
      { methods: [context.methods[0], context.methods[0]] },
    ]) assert.throws(() => saveTaskContext(store, 's1', { ...context, ...patch }));
  });
  await test('request bytes and method content cannot silently change under an existing revision', () => {
    saveTaskContext(store, 'immutable', context);
    assert.throws(() => saveTaskContext(store, 'immutable', { ...context, requests: [{ ...context.requests[0], request: 'POST /different HTTP/1.1' }] }), /immutable requests/);
    assert.throws(() => saveTaskContext(store, 'immutable', { ...context, methods: [{ ...context.methods[0], code: 'changed implementation' }] }), /immutable methods/);
    assert.equal(readTaskContext(store, 'immutable').requests[0].request, context.requests[0].request);
    const changed = { ...context, checks: [{ ...check, requestRevision: 'baseline-v2' }], requests: [{ ...context.requests[0], revision: 'baseline-v2', request: 'POST /input HTTP/1.1' }] };
    saveTaskContext(store, 'immutable', changed);
    assert.equal(readTaskContext(store, 'immutable').requests[0].request, 'POST /input HTTP/1.1');
    assert.equal(readTaskRecord(store, 'immutable', 'request', 'baseline', 'baseline-v1').request, context.requests[0].request);
    assert.equal(readTaskRecord(store, 'other', 'request', 'baseline', 'baseline-v1'), null);
    assert.throws(() => saveTaskContext(store, 'immutable', { ...context, requests: [{ ...context.requests[0], request: 'changed old revision' }] }), /immutable requests/);
    assert.equal(readTaskContext(store, 'immutable').requests[0].revision, 'baseline-v2');
  });
  await test('model-visible summary omits packets while exact detail renders request response and method', () => {
    const summary = taskContextView(context).text;
    assert.match(summary, /baseline/); assert.doesNotMatch(summary, /GET \/input/);
    const request = taskContextView(context, { kind: 'request', id: 'baseline', version: 'baseline-v1' });
    assert.match(request.text, /GET \/input/); assert.match(request.text, /HTTP\/1.1 200 OK/);
    assert.equal(taskContextView(context, { kind: 'method', id: check.entryId, version: 'v1' }).item.reviewed, true);
    assert.throws(() => taskContextView(context, { kind: 'request', id: 'absent' }), /not found/);
    const revisions = { ...context, requests: [...context.requests, { ...context.requests[0], revision: 'baseline-v2' }] };
    assert.throws(() => taskContextView(revisions, { kind: 'request', id: 'baseline' }), /multiple revisions/);
    const many = { ...context, requests: Array.from({ length: 25 }, (_, i) => ({ ...context.requests[0], id: `request-${i}` })) };
    assert.doesNotMatch(taskContextView(many).text, /request-24/);
    assert.match(taskContextView(many, { offset: 20 }).text, /request-24/);
  });
  await test('legacy snapshots remain readable without rewriting or trusting unlinked validity claims', () => {
    const old = { ...context, requests: context.requests.map(({ valid, ...request }) => request), methods: [] };
    const bytes = JSON.stringify(old);
    store.db.prepare('INSERT INTO task_context (session_id,record,updated_at) VALUES (?,?,?)').run('legacy', bytes, 'old');
    const result = readTaskContext(store, 'legacy');
    assert.equal(result.checks[0].requestValid, false);
    assert.equal(result.checks[0].methodReviewed, false);
    assert.equal(result.requests[0].request, context.requests[0].request);
    assert.equal(store.db.prepare('SELECT record FROM task_context WHERE session_id=?').get('legacy').record, bytes);
    saveTaskContext(store, 'legacy', context);
    assert.equal(readTaskContext(store, 'legacy').checks[0].requestValid, true);
  });
  await test('current invalid baseline unreviewed method or contradictory evidence prevents historical negative reuse', async () => {
    const tools = new Map();
    const ctx = { tools: { register: tool => tools.set(tool.name, tool) }, effect: () => {}, webServer: { register: () => () => {} } };
    nday.apply(ctx, { exposedTools: ['nday_priority_plan'] });
    for (const patch of [{ requestValid: false }, { methodReviewed: false }, { productConfirmed: false },
      { conditions: [{ name: 'affected-component', state: 'not-applicable', evidenceIds: ['new-counter-evidence'] }] }]) {
      const result = await tools.get('nday_priority_plan').execute({ entryIds: check.entryId,
        verificationContext: JSON.stringify({ ...context, checks: [{ ...check, ...patch }], history: [history] }) }, { agent: { session: { id: 'fresh' } } });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.plan.verificationQueue.items[0].reuse, false);
    }
  });
  await test('production planner invalidates cached negatives on changed product conditions and packets while unchanged saved evidence reuses', async () => {
    const tools = new Map();
    nday.apply({ tools: { register: tool => tools.set(tool.name, tool) }, effect: () => {}, webServer: { register: () => () => {} } }, { exposedTools: ['nday_priority_plan'] });
    const sid = 'basis-freshness', exec = { agent: { session: { id: sid, header: { agentPreset: 'pentest' } } } };
    saveTaskContext(store, sid, context);
    const saved = saveChecks(store, sid, [{ ...history, verificationBasis: 'saker-verification-basis/1:' + '0'.repeat(64) }])[0];
    assert.equal(saved.verificationBasis, verificationBasis(check, context), 'caller cannot choose a cache stamp');
    const plan = async input => {
      const result = await tools.get('nday_priority_plan').execute({ entryIds: check.entryId,
        ...(input ? { verificationContext: JSON.stringify(input) } : {}) }, exec);
      assert.equal(result.ok, true, result.error); return result.plan.verificationQueue.items[0];
    };
    assert.equal((await plan()).reuse, true);
    for (const patch of [
      { productEvidenceIds: ['new-product-observation'] },
      { conditions: [{ name: 'affected-component', state: 'satisfied', evidenceIds: ['new-component-observation'] }] },
      { conditions: [{ ...check.conditions[0], observedVersion: 'newly observed version' }] },
    ]) {
      const item = await plan({ ...context, checks: [{ ...check, ...patch }] });
      assert.equal(item.reuse, false); assert.equal(item.action, 'minimal-check-with-control');
      assert.equal(item.historyBasis, 'missing-or-changed');
    }
    const packetChanged = { ...context, requests: [{ ...context.requests[0], response: 'HTTP/1.1 200 OK\r\n\r\nnew response' }] };
    assert.equal((await plan(packetChanged)).reuse, false);
    assert.equal((await plan({ ...context, methods: [{ ...context.methods[0], code: 'different actual method' }] })).reuse, false);
    assert.equal((await plan({ ...context, assets: [{ ...context.assets[0], hostHeader: 'another.fixture.test' }] })).reuse, false);
    assert.equal((await plan({ ...context, history: [history] })).reuse, true, 'persisted unchanged stamp dominates caller history');
    assert.equal(verificationBasis({ ...check, productEvidenceIds: ['a', 'b'] }, context),
      verificationBasis({ ...check, productEvidenceIds: ['b', 'a', 'a'] }, context), 'reference reordering is not new evidence');
  });
  await test('blocked and legacy unstamped history never suppress a now-valid production check', async () => {
    const tools = new Map();
    nday.apply({ tools: { register: tool => tools.set(tool.name, tool) }, effect: () => {}, webServer: { register: () => () => {} } }, { exposedTools: ['nday_priority_plan'] });
    const sid = 'unblock', exec = { agent: { session: { id: sid, header: { agentPreset: 'pentest' } } } };
    saveTaskContext(store, sid, context); saveChecks(store, sid, [{ ...history, status: 'blocked', reason: 'Previous account expired', supplementAttempts: 2 }]);
    const current = await tools.get('nday_priority_plan').execute({ entryIds: check.entryId }, exec);
    assert.equal(current.ok, true, current.error);
    assert.equal(current.plan.verificationQueue.items[0].action, 'minimal-check-with-control');
    assert.equal(current.plan.verificationQueue.items[0].reuse, false);
    assert.equal(current.plan.verificationQueue.items[0].supplement.used, 2, 'new evidence does not reset cumulative attempts');
    const legacy = await tools.get('nday_priority_plan').execute({ entryIds: check.entryId,
      verificationContext: JSON.stringify({ ...context, history: [history] }) }, { agent: { session: { id: 'unstamped' } } });
    assert.equal(legacy.ok, true, legacy.error); assert.equal(legacy.plan.verificationQueue.items[0].reuse, false);
  });
} finally { for (const dispose of disposers.reverse()) await dispose();  store.close(); fs.rmSync(home, { recursive: true, force: true }); }
process.exitCode = failed ? 1 : 0;
