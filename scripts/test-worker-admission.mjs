import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { reserveWorkerSlot, releaseWorkerSlot, reservedWorkerCount } from '../plugins/dsh-redteam-results/lib/worker-admission.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-worker-admission-'));
const dbPath = path.join(home, 'redteam-results', 'results.db');
const store = openStore(dbPath);
const workerScript = fileURLToPath(new URL('./lib/worker-admission-worker.mjs', import.meta.url));
const deadPid = 999999;
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
const spawnReservation = (parentId, token, holdMs) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [workerScript, dbPath, parentId, token, '1', String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(JSON.parse(stdout.trim().split('\n').pop())) : reject(new Error(stderr || 'worker exit ' + code)));
});

try {
  await test('a fresh reservation blocks a second token in the same root', () => {
    assert.equal(reserveWorkerSlot(store, 'root-a', 1, 0, 'token-a', { ownerRuntime: 'test' }), true);
    assert.equal(reserveWorkerSlot(store, 'root-a', 1, 0, 'token-b', { ownerRuntime: 'test' }), false);
    assert.equal(reservedWorkerCount(store, 'root-a'), 1);
    assert.equal(releaseWorkerSlot(store, 'root-a', 'token-a'), true);
    assert.equal(reserveWorkerSlot(store, 'root-a', 1, 0, 'token-b', { ownerRuntime: 'test' }), true);
    releaseWorkerSlot(store, 'root-a', 'token-b');
  });

  await test('a live owner keeps its expired reservation counted', () => {
    assert.equal(reserveWorkerSlot(store, 'root-live', 1, 0, 'live-a', { ownerPid: process.pid, ttlMs: 10, now: 1000, ownerRuntime: 'test' }), true);
    assert.equal(reservedWorkerCount(store, 'root-live', { now: 2000 }), 1);
    assert.equal(reserveWorkerSlot(store, 'root-live', 1, 0, 'live-b', { ownerPid: process.pid, ttlMs: 10, now: 2000, ownerRuntime: 'test' }), false);
    assert.equal(releaseWorkerSlot(store, 'root-live', 'live-a'), true);
    assert.equal(reserveWorkerSlot(store, 'root-live', 1, 0, 'live-b', { ownerPid: process.pid, ttlMs: 10, now: 2000, ownerRuntime: 'test' }), true);
    releaseWorkerSlot(store, 'root-live', 'live-b');
  });

  await test('a dead owner reservation is pruned without waiting for TTL', () => {
    assert.equal(reserveWorkerSlot(store, 'root-dead', 1, 0, 'dead-a', { ownerPid: deadPid, ttlMs: 60000, now: 1000, ownerRuntime: 'test' }), true);
    assert.equal(reserveWorkerSlot(store, 'root-dead', 1, 0, 'dead-b', { ownerPid: process.pid, ttlMs: 60000, now: 1001, ownerRuntime: 'test' }), true);
    releaseWorkerSlot(store, 'root-dead', 'dead-b');
  });

  await test('different roots keep independent per-root reservations', () => {
    assert.equal(reserveWorkerSlot(store, 'root-x', 1, 0, 'x-a', { ownerRuntime: 'test' }), true);
    assert.equal(reserveWorkerSlot(store, 'root-y', 1, 0, 'y-a', { ownerRuntime: 'test' }), true);
    releaseWorkerSlot(store, 'root-x', 'x-a');
    releaseWorkerSlot(store, 'root-y', 'y-a');
  });

  await test('two processes cannot both reserve the last slot', async () => {
    const [first, second] = await Promise.all([
      spawnReservation('root-race', 'race-a', 700),
      spawnReservation('root-race', 'race-b', 700),
    ]);
    assert.equal([first.ok, second.ok].filter(Boolean).length, 1, 'exactly one process gets the last slot');
  });
} finally {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
