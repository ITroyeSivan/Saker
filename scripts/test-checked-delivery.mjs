import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveChecks, readChecks, renderCheckedTsv } from '../plugins/dsh-redteam-results/lib/checked.js';
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); }
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-checked-'));
process.env.DSH_HOME = home;
process.env.DSH_ATLAS_DB = path.join(home, 'unused-atlas.db');
const { apply, dispatch } = await import('../plugins/dsh-redteam-results/lib/index.js');
let store = openStore(path.join(home, 'redteam-results', 'results.db'));
const disposers = [];
const base = { assetId: 'a', asset: 'api.example.test', entryId: 'CVE-fixture', check: '受控检查',
  endpoint: 'https://api.example.test/input', methodVersion: 'v1', authContext: 'test-account-a', requestRevision: 'request-v1',
  status: 'not-hit', executed: true, requestValid: true, observationValid: true, evidenceIds: ['request', 'negative-control-response'] };
try {
  await test('checked records persist without becoming findings or crossing sessions', () => {
    saveChecks(store, 's1', [base]);
    assert.equal(readChecks(store, 's1').length, 1);
    assert.equal(readChecks(store, 's2').length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM findings').get().n, 0);
    store.close(); store = openStore(path.join(home, 'redteam-results', 'results.db'));
    assert.equal(readChecks(store, 's1')[0].authContext, base.authContext);
  });
  await test('not-hit refuses unexecuted invalid-request unavailable-observation or absent evidence', () => {
    for (const patch of [{ executed: false }, { requestValid: false }, { observationValid: false }, { evidenceIds: [] }]) {
      assert.throws(() => saveChecks(store, 'bad', [{ ...base, ...patch }]), /not-hit requires/);
    }
    assert.equal(readChecks(store, 'bad').length, 0);
  });
  await test('four statuses preserve untested blocked and contradicted conditions', () => {
    saveChecks(store, 'states', [base,
      { ...base, entryId: 'b', status: 'blocked', reason: '登录失效', requestValid: false },
      { ...base, entryId: 'c', status: 'not-applicable', executed: false, evidenceIds: ['module-disabled'] },
      { ...base, entryId: 'd', status: 'not-tested', executed: false, evidenceIds: [] }]);
    assert.throws(() => saveChecks(store, 'bad', [{ ...base, status: 'not-tested' }]), /executed check/);
    assert.throws(() => saveChecks(store, 'bad', [{ ...base, status: 'blocked' }]), /local reason/);
    assert.throws(() => saveChecks(store, 'bad', [{ ...base, status: 'not-applicable', evidenceIds: [] }]), /condition evidence/);
  });
  await test('same-context updates while identity method entry or baseline changes remain distinct', () => {
    saveChecks(store, 'contexts', [base]);
    saveChecks(store, 'contexts', [{ ...base, status: 'blocked', reason: '复核时账户失效' }]);
    assert.equal(readChecks(store, 'contexts').length, 1);
    for (const field of ['assetId', 'entryId', 'endpoint', 'methodVersion', 'authContext', 'requestRevision']) {
      saveChecks(store, 'contexts', [{ ...base, [field]: field === 'endpoint' ? base.endpoint + '/other' : base[field] + '-new' }]);
    }
    assert.equal(readChecks(store, 'contexts').length, 7);
  });
  await test('batch rejects partial invalid duplicate or oversized writes atomically', () => {
    assert.throws(() => saveChecks(store, 'atomic', [base, { ...base, entryId: 'b', status: 'unknown' }]));
    assert.throws(() => saveChecks(store, 'atomic', [base, base]), /duplicate/);
    assert.throws(() => saveChecks(store, 'atomic', Array(201).fill(base)), /1..200/);
    assert.equal(readChecks(store, 'atomic').length, 0);
  });
  await test('compact exports contain exactly three columns and never leak internal details', async () => {
    const result = await dispatch({}, store, 'checks.export', { sessionId: 'states' });
    assert.equal(result.filename, 'checked.tsv');
    assert.equal(result.text.trim().split('\n').length, 5);
    for (const line of result.text.trim().split('\n')) assert.equal(line.split('\t').length, 3);
    for (const value of [base.authContext, base.methodVersion, '登录失效', 'negative-control-response', 'requestRevision']) assert(!result.text.includes(value));
    for (const label of ['已测未命中', '受阻', '不适用', '未测']) assert(result.text.includes(label));
    const other = await dispatch({}, store, 'checks.list', { sessionId: 'empty' });
    assert.deepEqual(other.rows, []);
    await assert.rejects(dispatch({}, store, 'checks.export', {}), /sessionId/);
  });
  await test('unsafe endpoints TSV injection and malformed evidence are refused', () => {
    for (const patch of [{ endpoint: 'file:///secret' }, { endpoint: 'https://user:pass@example.test/' }, { check: 'a\tb' }, { evidenceIds: 'proof' }]) {
      assert.throws(() => saveChecks(store, 'bad', [{ ...base, ...patch }]));
    }
    assert(renderCheckedTsv([{ ...base, asset: '=SUM(1)' }]).includes("'=SUM(1)"));
  });
  await test('registered checked tool uses actual current pentest session and supports readback', async () => {
    const tools = new Map();
    apply({ tools: { register: tool => tools.set(tool.name, tool) }, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); }, webServer: { register: () => () => {} } });
    const tool = tools.get('redteam_checks');
    const exec = { agent: { session: { id: 'tool', header: { agentPreset: 'pentest' } } } };
    const result = await tool.execute({ records: JSON.stringify([{ ...base, sessionId: 'attacker-supplied' }]) }, exec);
    assert.equal(result.ok, true);
    assert.equal(readChecks(store, 'attacker-supplied').length, 0);
    assert.equal((await tool.execute({}, exec)).rows.length, 1);
    assert.equal((await tool.execute({ records: '{' }, exec)).ok, false);
    assert.equal((await tool.execute({}, { agent: { session: { id: 'tool', header: { agentPreset: 'code-audit' } } } })).ok, false);
  });
  await test('checked UI actions read current session and download the server TSV, surfacing failures', async () => {
    const source = fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
    const component = source.slice(source.indexOf('function CheckedList('), source.indexOf('function ModePage('));
    const state = [], downloads = [], archives = [], calls = [];
    let failing = false;
    const context = { useState: value => { const slot = [value]; state.push(slot); return [value, next => { slot[0] = next; }]; },
      React: { createElement: (type, props, ...children) => ({ type, props, children }) }, Btn: 'button',
      api: async (endpoint, payload) => { calls.push([endpoint, payload]); if (failing) return { ok: false, error: 'Fixture denied' }; return dispatch({}, store, endpoint, payload); },
      download: (...args) => downloads.push(args), downloadArchive: (...args) => archives.push(args) };
    runInNewContext(component + '; this.component = CheckedList;', context);
    const tree = context.component({ sessionId: 'states' });
    await tree.children[0].props.onClick();
    assert.equal(state[0][0].length, 4);
    await tree.children[1].props.onClick();
    assert.equal(downloads[0][0], 'checked.tsv');
    assert.equal(downloads[0][1], renderCheckedTsv(readChecks(store, 'states')));
    assert.equal(calls[1][1].sessionId, 'states');
    await tree.children[2].props.onClick();
    assert.equal(archives[0][0], 'saker-delivery.zip');
    assert.equal(Buffer.from(archives[0][1], 'base64').readUInt32LE(0), 0x04034b50);
    failing = true;
    await tree.children[1].props.onClick();
    assert.equal(state[1][0], 'Fixture denied');
    assert.equal(downloads.length, 1);
  });
} finally {
  for (const dispose of disposers.reverse()) await dispose();
   store.close(); fs.rmSync(home, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
