// 工作项归属与孤儿回收：G3 要求"原子领取/租约 + 事件去重 + 结果未知也要正确处理"。
//
// 当前实现**没有**时间型租约（没有 expires_at / heartbeat），它用的是**归属 + 清单**：
//   · 行里记着 runnerPid（哪个进程起的）与 state；
//   · 回收时先问宿主子代理清单（listDescendants），只有"本进程刚 admit、清单还没出现"才等一等；
//   · 启动回滚不确定时**拒绝释放**，要求重启 Desktop 而不是盲目重发。
// 这套语义此前只有零散覆盖，本套件把它**显式钉住** —— 否则"没有租约"就等于"没人验证过"。
//
// 只读地使用真实 store 与真实 createSiteWorkers；不启 Desktop、不发网络请求。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { testTempRoot } from './lib/test-temp-root.mjs';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createSiteWorkers, siteWorkerRows } from '../plugins/dsh-redteam-results/lib/site-workers.js';

const boundary = testTempRoot(import.meta.url);
const scratch = mkdtempSync(join(boundary, 'worker-orphan-'));
const store = openStore(join(scratch, 'results.db'));
const live = new Map();
let descendantsOverride = null;
const ctx = {
  agents: { get: id => live.get(id) },
  logger: { warn() {} },
  subagents: {
    async listDescendants(id) {
      if (descendantsOverride !== null) return descendantsOverride;
      return [...live.values()].filter(agent => agent.session.header.parentSession === id)
        .map(agent => ({ kind: 'child', id: agent.session.id }));
    },
    async startActivation(spec) {
      const agent = { session: { id: spec.childId, header: { parentSession: spec.request.parent.session.id, agentPreset: 'pentest', cwd: scratch }, events: [] }, inbox: { hasPending: false } };
      live.set(spec.childId, agent);
      return { childId: spec.childId, messageId: 'accepted' };
    },
    async sendMessage() { return 'message-1'; },
    async drainChildren(parent, ids) { for (const id of ids) live.delete(id); },
  },
};
const workers = createSiteWorkers(ctx, () => store);

const SITE = 'https://orphan-fixture.test';
const parent = id => ({ session: { id, header: { agentPreset: 'pentest', cwd: scratch } },
  ctx: { tools: { schemas: () => ['read', 'subagent_spawn'].map(name => ({ name })) } } });
const insertRow = (parentId, row) => store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)')
  .run(parentId, row.childId, row.site, JSON.stringify(row));
const rowOf = (parentId, childId) => siteWorkerRows(store, parentId).find(row => row.childId === childId);
const seedParent = id => {
  live.set(id, parent(id));
  startTaskPolicy(store, id, { mode: 'regular', workflow: 'single', question: 'Orphan ownership fixture', budget: { toolCalls: 20, workers: 1, minutes: 10 } });
  saveTaskContext(store, id, { assets: [{ id: 'a', url: SITE, inScope: true, reachable: true }] });
  return parent(id);
};

let failed = 0;
async function test(label, fn) {
  try { await fn(); console.log('ok ' + label); }
  catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); }
}

try {
  await test('a row owned by another process is reclaimed on the next status instead of holding the slot forever', async () => {
    const id = 'p-restart', agent = seedParent(id);
    insertRow(id, { parentId: id, childId: 'child-from-old-process', site: SITE, focus: 'web', question: 'q', reason: 'r',
      state: 'starting', createdAt: Date.now() - 60_000, runnerPid: process.pid + 1 });
    assert.equal(siteWorkerRows(store, id).length, 1);
    const view = await workers.status(agent);
    assert.equal(view.active, 0, `a row from a dead process must not stay active: ${JSON.stringify(view)}`);
    assert.equal(rowOf(id, 'child-from-old-process').state, 'released');
  });

  await test('a row this process just admitted is not reclaimed before the native inventory catches up', async () => {
    const id = 'p-fresh', agent = seedParent(id);
    insertRow(id, { parentId: id, childId: 'child-just-admitted', site: SITE, focus: 'web', question: 'q', reason: 'r',
      state: 'starting', createdAt: Date.now(), runnerPid: process.pid });
    const view = await workers.status(agent);
    assert.equal(view.active, 1, 'a fresh admission must keep its slot until the inventory can confirm settlement');
    assert.equal(rowOf(id, 'child-just-admitted').state, 'starting');
  });

  await test('a running row with no live native child is reclaimed', async () => {
    const id = 'p-running', agent = seedParent(id);
    insertRow(id, { parentId: id, childId: 'child-gone', site: SITE, focus: 'web', question: 'q', reason: 'r',
      state: 'running', createdAt: Date.now() - 5000, runnerPid: process.pid });
    const view = await workers.status(agent);
    assert.equal(view.active, 0, 'a running row without a live child is an orphan');
    assert.equal(rowOf(id, 'child-gone').state, 'released');
  });

  await test('an uncertain worker inventory refuses new delegation instead of guessing', async () => {
    const id = 'p-diagnostic', agent = seedParent(id);
    descendantsOverride = [{ kind: 'diagnostic', id: 'uncertain' }];
    try {
      await assert.rejects(workers.delegate(agent, { site: SITE, question: 'Inspect the controlled fixture document', need: 'large-site-materials', reason: 'Separate a substantial selected bundle' }, new AbortController().signal),
        /worker inventory uncertain/);
    } finally { descendantsOverride = null; }
  });

  await test('an uncertain startup rollback refuses release and asks for a Desktop restart instead of resending', async () => {
    const id = 'p-rollback', agent = seedParent(id);
    insertRow(id, { parentId: id, childId: 'child-uncertain', site: SITE, focus: 'web', question: 'q', reason: 'r',
      state: 'starting', createdAt: Date.now() - 5000, runnerPid: process.pid, startupRollbackUncertain: true });
    await workers.cleanup(agent, 'child-uncertain', 'test release');
    const row = rowOf(id, 'child-uncertain');
    assert.equal(row.state, 'cleanup-failed', `an uncertain rollback must not be released: ${JSON.stringify(row)}`);
    assert.match(String(row.error), /restart Desktop before releasing this reservation/);
  });

  await test('the database itself refuses a second row for the same site, so a cross-process claim cannot duplicate', () => {
    const id = 'p-unique', agent = seedParent(id);
    insertRow(id, { parentId: id, childId: 'first', site: SITE, focus: 'web', question: 'q', reason: 'r', state: 'running', createdAt: Date.now(), runnerPid: process.pid });
    assert.throws(() => insertRow(id, { parentId: id, childId: 'second', site: SITE, focus: 'web', question: 'q', reason: 'r', state: 'running', createdAt: Date.now(), runnerPid: process.pid + 1 }),
      /UNIQUE|constraint/i, 'the (parent_session, site) uniqueness must reject a duplicate claim');
    assert.equal(siteWorkerRows(store, id).length, 1);
  });
} finally {
  await workers.dispose();
  store.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

process.exitCode = failed ? 1 : 0;
