import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-context-parameters-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const tools = new Map(), disposers = [];
let failures = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.stack); } };
try {
  const { apply } = await import('../plugins/dsh-redteam-results/lib/index.js');
  apply({ tools: { register: tool => tools.set(tool.name, tool), guard() {} },
    webServer: { register: () => () => {} }, effect: work => { const dispose = work(); if (typeof dispose === 'function') disposers.push(dispose); } });
  const tool = tools.get('redteam_context');
  const exec = { agent: { session: { id: 'typed-context', header: { agentPreset: 'pentest' } } } };
  const endpoint = 'http://127.0.0.1:39871/document?id=2';
  await test('structured assets and requests preserve identity, headers and the recorded wire request', async () => {
    const result = await tool.execute({ assets: [{ id: 'a', url: endpoint, inScope: true, reachable: true }],
      requests: [{ id: 'r', revision: 'v1', endpoint, authContext: 'alice', method: 'GET', headers: { 'X-Account': 'alice' } }] }, exec);
    assert.equal(result.ok, true, result.error);
    const saved = readTaskContext(store, 'typed-context');
    assert.equal(saved.requests.length, 1);
    assert.equal(saved.requests[0].authContext, 'alice');
    assert.match(saved.requests[0].request, /X-Account: alice/i);
    assert.match(saved.requests[0].request, /^GET \/document\?id=2 HTTP\/1.1/);
    assert.notEqual(saved.requests[0].valid, true, 'saving input is not a successful execution');
  });
  await test('structured updates retain existing data and legacy context remains supported', async () => {
    const result = await tool.execute({ requests: [{ id: 'r2', revision: 'v1', endpoint, authContext: 'bob', method: 'GET' }] }, exec);
    assert.equal(result.ok, true, result.error);
    const prior = readTaskContext(store, 'typed-context');
    assert.equal(prior.assets[0].id, 'a');
    assert.equal(prior.requests.length, 2);
    const old = await tool.execute({ context: JSON.stringify({ ...prior, requests: [...prior.requests, { id: 'r3', revision: 'v1', endpoint, authContext: 'anonymous', method: 'GET' }] }) }, exec);
    assert.equal(old.ok, true, old.error);
    assert.equal(readTaskContext(store, 'typed-context').assets[0].id, 'a');
    assert.equal(readTaskContext(store, 'typed-context').requests.length, 3);
  });
  await test('structured writes cannot be combined with legacy, search or finding reads', async () => {
    for (const query of [{ context: '{}' }, { search: 'alice' }, { kind: 'finding' }, { kind: 'material' }]) {
      const result = await tool.execute({ assets: [], ...query }, exec);
      assert.equal(result.ok, false, JSON.stringify(query));
    }
    assert.equal(readTaskContext(store, 'typed-context').requests.length, 3);
  });
  await test('structured input still enforces the production request contract', async () => {
    const result = await tool.execute({ requests: [{ id: 'bad', endpoint, method: 'GET' }] }, exec);
    assert.equal(result.ok, false);
    assert.match(result.error, /authContext|revision/);
    assert.equal(readTaskContext(store, 'typed-context').requests.length, 3);
  });
} finally {
  for (const dispose of disposers.reverse()) await dispose();
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
