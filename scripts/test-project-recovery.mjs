import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, beginProjectAction, finishProjectAction, readProjectRun } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { recoverInterruptedProjectRuns } from '../plugins/dsh-redteam-results/lib/project-runtime.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-recovery-'));
process.env.DSH_HOME = home;
const root = fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = name => pathToFileURL(path.join(root, 'plugins/dsh-redteam-results/lib', name)).href;
const childSource = `
  import {openStore} from ${JSON.stringify(moduleUrl('store.js'))};
  import {startTaskPolicy} from ${JSON.stringify(moduleUrl('task-policy.js'))};
  import {createProjectRun,transitionProjectRun,defineProjectChecks,beginProjectAction} from ${JSON.stringify(moduleUrl('project-store.js'))};
  process.env.DSH_HOME=process.argv[1];
  const store=openStore(process.env.DSH_HOME+'/redteam-results/results.db');
  const runs=[];
  for(const [sid,state] of [['orphan-write','dispatched'],['orphan-queued','queued']]){
    startTaskPolicy(store,sid,{scenario:'project',question:'Recovery fixture',target:'http://127.0.0.1:1',budget:{minutes:30}});
    const initial=createProjectRun(store,sid);const run=transitionProjectRun(store,sid,initial.runId,'running',initial.controlRev);
    run.ownerPid=process.pid; run.ownerRuntimeId='stopped-fixture-runtime';
    store.db.prepare('UPDATE project_runs SET record=? WHERE session_id=? AND run_id=?').run(JSON.stringify(run),sid,run.runId);
    defineProjectChecks(store,sid,run.runId,[{checkId:'check',requirement:'Synthetic write'}]);
    beginProjectAction(store,sid,run.runId,'check',{executionState:state,method:'POST'});
    runs.push({sid,runId:run.runId,controlRev:run.controlRev});
  }
  store.close(); console.log(JSON.stringify({pid:process.pid,runs}));
`;
const disposers = [];
let db;
try {
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'scripts/test-stub-register.mjs')).href,
    '--input-type=module', '-e', childSource, home], { cwd: root, encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, timeout: 15000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const seeded = JSON.parse(child.stdout.trim());
  assert.throws(() => process.kill(seeded.pid, 0), error => error.code === 'ESRCH', 'fixture owner must really have exited');
  const tools = new Map();
  const ctx = { tools: { register: tool => tools.set(tool.name, tool), guard() {} },
    systemPrompt: { section() {}, context() {} }, webServer: { register: () => () => {} },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    sessions: { get: id => ({ id, header: { agentPreset: 'pentest' } }) },
    agents: { get: () => ({ status: 'idle', followup() {}, cancel() {} }) }, on() {}, get() { return null; } };
  const { apply } = await import(moduleUrl('index.js'));
  apply(ctx);
  const status = await tools.get('redteam_task').execute({ action: 'status' },
    { agent: { session: { id: 'orphan-write', header: { agentPreset: 'pentest' } } } });
  assert.equal(status.ok, true, status.error);
  db = new DatabaseSync(path.join(home, 'redteam-results/results.db'), { readOnly: true });
  for (const seededRun of seeded.runs) {
    const run = JSON.parse(db.prepare('SELECT record FROM project_runs WHERE session_id=? AND run_id=?').get(seededRun.sid, seededRun.runId).record);
    assert.equal(run.state, 'paused', 'host startup must pause orphan project runs');
    assert.equal(run.controlRev, seededRun.controlRev + 1);
    const action = JSON.parse(db.prepare('SELECT record FROM project_actions WHERE session_id=?').get(seededRun.sid).record);
    assert.equal(action.executionState, seededRun.sid === 'orphan-write' ? 'unknown' : 'failed');
    assert.equal(action.sideEffectUnknown, seededRun.sid === 'orphan-write');
    const policy = JSON.parse(db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(seededRun.sid).record);
    assert.equal(policy.projectRunState, 'paused');
    assert.equal(policy.used.toolCalls, 0);
    const check = JSON.parse(db.prepare('SELECT record FROM project_checks WHERE session_id=?').get(seededRun.sid).record);
    assert.equal(check.executionState, 'paused');
  }
  console.log('ok host startup pauses dead-owner runs, cancels queued work and preserves unknown dispatched writes');
  const before = db.prepare('SELECT record FROM project_runs ORDER BY run_id').all();
  await tools.get('redteam_task').execute({ action: 'status' }, { agent: { session: { id: 'orphan-write', header: { agentPreset: 'pentest' } } } });
  assert.deepEqual(db.prepare('SELECT record FROM project_runs ORDER BY run_id').all(), before);
  console.log('ok repeated status reads do not recover twice, reset budgets or dispatch requests');
  const activeStore = openStore(':memory:');
  try {
    const initial = createProjectRun(activeStore, 'live-owner', { runtimeId: 'live-fixture-runtime' });
    const run = transitionProjectRun(activeStore, 'live-owner', initial.runId, 'running', initial.controlRev);
    defineProjectChecks(activeStore, 'live-owner', run.runId, [{ checkId: 'c1', requirement: 'Synthetic check' }]);
    assert.deepEqual(recoverInterruptedProjectRuns(activeStore), [], 'a live process is not an orphan');
    assert.deepEqual(recoverInterruptedProjectRuns(activeStore, { shutdown: true, runtimeId: 'someone-else' }), []);
    const action = beginProjectAction(activeStore, 'live-owner', run.runId, 'c1', { method: 'POST' });
    finishProjectAction(activeStore, 'live-owner', run.runId, action.action.actionId, { executionState: 'unknown', sideEffectUnknown: true });
    assert.throws(() => beginProjectAction(activeStore, 'live-owner', run.runId, 'c1', { method: 'POST' }), /未知的写入动作/);
    const stopped = recoverInterruptedProjectRuns(activeStore, { shutdown: true, runtimeId: 'live-fixture-runtime' });
    assert.equal(stopped.length, 1);
    assert.equal(readProjectRun(activeStore, 'live-owner', run.runId).state, 'paused');
    console.log('ok live ownership is preserved, explicit shutdown pauses only its owner, and unknown writes cannot be blindly retried');
  } finally { activeStore.close(); }
} finally {
  db?.close();
  for (const dispose of disposers.reverse()) await dispose();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
