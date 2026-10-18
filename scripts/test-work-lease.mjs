import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { workKey, claimWork, heartbeatWork, completeWork, releaseWork, expireWorkLeases, listWorkLeases, listWorkDependingOnMaterial } from '../plugins/dsh-redteam-results/lib/work-lease.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-work-lease-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
const base = { endpoint: 'https://app.example.test/api/orders', question: ' 检查订单越权 ', identity: 'user-a', materialRevision: 'v1' };
// 跨进程工作者：真的起一个独立 node 进程打开同一个结果库，验证领取唯一性不是同进程假象。
const dbPath = path.join(home, 'redteam-results', 'results.db');
const workerScript = fileURLToPath(new URL('./lib/work-lease-worker.mjs', import.meta.url));
// --import 是模块说明符，Windows 绝对路径必须给 file URL，裸 `E:\...` 会被当成 e: 协议。
const stubUrl = pathToFileURL(fileURLToPath(new URL('./test-stub-register.mjs', import.meta.url))).href;
const worker = (action, args) => {
  let out;
  try {
    out = execFileSync(process.execPath, ['--import', stubUrl, workerScript, dbPath, action, JSON.stringify(args)], { encoding: 'utf8' });
  } catch (error) {
    throw new Error('worker ' + action + ' failed: ' + String(error.stderr || error.message));
  }
  return JSON.parse(out.trim().split('\n').pop());
};
try {
  test('the work key normalizes endpoint, question, identity and material revision', () => {
    assert.equal(workKey(base), workKey({ ...base, question: '检查订单越权' }), 'whitespace is normalized');
    assert.equal(workKey(base), workKey({ ...base, endpoint: 'https://app.example.test/api/orders' }), 'same endpoint matches');
    assert.notEqual(workKey(base), workKey({ ...base, identity: 'user-b' }), 'different identities are different work');
    assert.notEqual(workKey(base), workKey({ ...base, materialRevision: 'v2' }), 'different material revisions are different work');
  });
  test('one worker holds a fresh lease and a second worker is refused while it is live', () => {
    const first = claimWork(store, 'task-1', { ...base, worker: 'w1', ttlMs: 1000, now: 100 });
    const key = first.workKey;
    assert.equal(first.generation, 1); assert.equal(first.state, 'claimed'); assert.equal(first.expiresAt, 1100);
    const renewed = claimWork(store, 'task-1', { workKey: key, worker: 'w1', ttlMs: 1000, now: 200 });
    assert.equal(renewed.generation, 1, 'the same worker renews without bumping generation');
    assert.throws(() => claimWork(store, 'task-1', { workKey: key, worker: 'w2', ttlMs: 1000, now: 300 }), /已被其他工作者领取/);
    // 同一目标+问题在另一个任务里是另一份工作，不撞键。
    const other = claimWork(store, 'task-2', { ...base, worker: 'w9', ttlMs: 1000, now: 300 });
    assert.notEqual(other.workKey, key, 'leases are scoped per parent task');
    assert.equal(other.generation, 1);
  });
  test('an expired or released lease is taken over with generation +1 and the old holder loses heartbeat', () => {
    const key = listWorkLeases(store, 'task-1').find(row => row.worker === 'w1').workKey;
    const taken = claimWork(store, 'task-1', { workKey: key, worker: 'w2', ttlMs: 1000, now: 2000 });
    assert.equal(taken.generation, 2, 'takeover bumps generation');
    assert.equal(taken.worker, 'w2');
    assert.throws(() => heartbeatWork(store, key, { worker: 'w1', generation: 1, now: 2100 }), /租约已转移/);
    assert.equal(heartbeatWork(store, key, { worker: 'w2', generation: 2, ttlMs: 1000, now: 2100 }).expiresAt, 3100);
    releaseWork(store, key, { worker: 'w2', generation: 2, now: 2200 });
    const third = claimWork(store, 'task-1', { workKey: key, worker: 'w3', ttlMs: 1000, now: 2300 });
    assert.equal(third.generation, 3, 'a released lease can be re-claimed');
  });
  test('a late result from an older generation is kept as history and never overwrites the current result', () => {
    const key = listWorkLeases(store, 'task-1').find(row => row.worker === 'w3').workKey;
    const done = completeWork(store, key, { worker: 'w3', generation: 3, result: { summary: 'current' }, now: 2400 });
    assert.equal(done.superseded, false); assert.equal(done.state, 'done'); assert.equal(done.result.summary, 'current');
    const late = completeWork(store, key, { worker: 'w1', generation: 1, result: { summary: 'stale' }, now: 2500 });
    assert.equal(late.superseded, true, 'an older generation is superseded');
    assert.equal(late.result.summary, 'current', 'the current result is preserved');
    assert.equal(late.history.at(-1).superseded, true);
    const staleRelease = releaseWork(store, key, { worker: 'w1', generation: 1, now: 2600 });
    assert.equal(staleRelease.superseded, true);
    assert.equal(listWorkLeases(store, 'task-1')[0].state, 'done');
  });
  test('expiry marks abandoned claims for takeover without replaying side effects', () => {
    const key = claimWork(store, 'task-1', { ...base, question: '另一个问题', worker: 'w4', ttlMs: 100, now: 1000 }).workKey;
    assert.deepEqual(expireWorkLeases(store, 'task-1', 2000), [key]);
    assert.equal(listWorkLeases(store, 'task-1').find(row => row.workKey === key).state, 'expired');
    assert.equal(claimWork(store, 'task-1', { workKey: key, worker: 'w5', ttlMs: 100, now: 2100 }).generation, 2);
  });
  // —— 跨进程：另一个进程持有租约时不能领取；过期/释放后接手 generation+1 ——
  test('a separate process cannot claim a live lease and only takes over after it expires', () => {
    const held = claimWork(store, 'xproc', { ...base, worker: 'proc-a', ttlMs: 1000, now: 10000 });
    const key = held.workKey;
    const refused = worker('claim', { parentSession: 'xproc', workKey: key, worker: 'proc-b', ttlMs: 1000, now: 10500 });
    assert.equal(refused.ok, false, 'a live lease held by another process is refused');
    assert.equal(refused.code, 'work-lease-held');
    // 同一 worker 在租约内跨进程续租，不涨 generation。
    const renewed = worker('claim', { parentSession: 'xproc', workKey: key, worker: 'proc-a', ttlMs: 1000, now: 10600 });
    assert.equal(renewed.ok, true); assert.equal(renewed.out.generation, 1);
    // 过期后由另一个进程接手。
    const expired = worker('expire', { parentSession: 'xproc', now: 20000 });
    assert.equal(expired.ok, true); assert.deepEqual(expired.out, [key]);
    const taken = worker('claim', { parentSession: 'xproc', workKey: key, worker: 'proc-b', ttlMs: 1000, now: 20100 });
    assert.equal(taken.ok, true); assert.equal(taken.out.generation, 2); assert.equal(taken.out.worker, 'proc-b');
    const listed = worker('list', { parentSession: 'xproc' });
    assert.equal(listed.out.find(row => row.workKey === key).generation, 2);
  });
  test('heartbeat and late results written from another process respect generation ownership', () => {
    const key = listWorkLeases(store, 'xproc').find(row => row.worker === 'proc-b').workKey;
    const live = worker('heartbeat', { key, worker: 'proc-b', generation: 2, ttlMs: 1000, now: 20200 });
    assert.equal(live.ok, true); assert.equal(live.out.expiresAt, 21200);
    const stale = worker('heartbeat', { key, worker: 'proc-a', generation: 1, now: 20300 });
    assert.equal(stale.ok, false, 'a stale generation cannot renew from another process');
    assert.equal(stale.code, 'work-lease-lost');
    const done = worker('complete', { key, worker: 'proc-b', generation: 2, result: { summary: 'current' }, now: 20400 });
    assert.equal(done.ok, true); assert.equal(done.out.superseded, false); assert.equal(done.out.result.summary, 'current');
    const late = worker('complete', { key, worker: 'proc-a', generation: 1, result: { summary: 'stale' }, now: 20500 });
    assert.equal(late.ok, true); assert.equal(late.out.superseded, true, 'the older generation is kept as history');
    assert.equal(late.out.result.summary, 'current', 'the current result is not overwritten by the late process');
  });
  test('依赖某条资料的工作可单独查出，不广播给无关工作（v6 第 8.3 节）', () => {
    claimWork(store, 'materials', { worker: 'w-1', workKey: 'dep-1', materialIds: ['material-1', 'material-1', ''] });
    claimWork(store, 'materials', { worker: 'w-2', workKey: 'dep-2', materialIds: ['material-2'] });
    claimWork(store, 'materials', { worker: 'w-3', workKey: 'dep-3' });
    const hit = listWorkDependingOnMaterial(store, 'materials', 'material-1');
    assert.equal(hit.length, 1, '只返回声明了该资料的工作');
    assert.equal(hit[0].worker, 'w-1');
    assert.equal(listWorkDependingOnMaterial(store, 'materials', 'material-2')[0].worker, 'w-2');
    assert.equal(listWorkDependingOnMaterial(store, 'materials', 'material-9').length, 0);
    assert.equal(listWorkDependingOnMaterial(store, 'other-session', 'material-1').length, 0, '跨任务不串');
    const stored = listWorkLeases(store, 'materials').find(row => row.worker === 'w-1');
    assert.deepEqual(stored.materialIds, ['material-1'], '重复与空值被归一');
  });
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
