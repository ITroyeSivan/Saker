// R01: the visible case-status line must refresh a live run without a page switch.
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { writeTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy-record.js';
import { createProjectRun, defineProjectChecks, recordProjectCheck } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { setProjectRunState } from '../plugins/dsh-redteam-results/lib/project-runtime.js';

const store = openStore(':memory:');
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const ctx = {
  sessions: { get: id => ({ id, header: { agentPreset: 'pentest' } }) },
  agents: { get: () => ({ status: 'idle', followup: () => {} }) },
  tools: { register: () => {}, guard: () => {} },
  webServer: { register: () => () => {} },
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') dispose(); },
  get: () => null,
};
results.apply(ctx);

const sid = 'live-refresh';
startTaskPolicy(store, sid, { scenario: 'project', question: '动态进度', budget: { minutes: 30 } });
const run = createProjectRun(store, sid, { question: '动态进度' });
setProjectRunState(store, sid, run.runId, 'running', run.controlRev);
writeTaskPolicy(store, sid, { ...readTaskPolicy(store, sid), projectRunId: run.runId, projectRunState: 'running' }, 'test-live-bind');
const [check] = defineProjectChecks(store, sid, run.runId, [{ requirement: '长中文要求：普通用户只能读取自己的订单与资料。' }]);
recordProjectCheck(store, sid, run.runId, check.checkId, { executionState: 'running', checkedContent: '' });

const source = fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('function ProjectChatStatus('), end = source.indexOf('function ProjectUnknownActions(', start);
assert(start > 0 && end > start);

const hooks = [], timers = new Map();
let cursor = 0, tree = null, dirty = false, pendingEffects = [];
let intervalId = 0;
const props = { sessionId: sid, status: { configured: true, policy: { scenario: 'project', projectRunId: run.runId } } };
const schedule = () => { dirty = true; };
const render = () => {
  cursor = 0;
  pendingEffects = [];
  const sandbox = {
    api: async (endpoint, payload) => {
      try { return await results.dispatch(ctx, store, endpoint, payload); }
      catch (error) { return { ok: false, error: error.message }; }
    },
    Btn: 'button',
    ProjectUnknownActions: 'unknown-actions',
    downloadArchive: () => {},
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    useState: initial => {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { value: initial };
      return [hooks[index].value, next => {
        const value = typeof next === 'function' ? next(hooks[index].value) : next;
        if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; schedule(); }
      }];
    },
    useRef: initial => {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { value: { current: initial } };
      return hooks[index].value;
    },
    useEffect: (fn, deps) => {
      const index = cursor++;
      const prev = hooks[index];
      const changed = !prev || !deps || deps.some((value, item) => !Object.is(value, prev.deps?.[item]));
      if (!changed) return;
      if (typeof prev?.cleanup === 'function') prev.cleanup();
      const hook = { deps: deps || null, cleanup: null, effect: fn };
      hooks[index] = hook;
      pendingEffects.push(hook);
    },
    setInterval: (fn, ms) => { const id = ++intervalId; timers.set(id, fn); return id; },
    clearInterval: id => { timers.delete(id); },
    document: { visibilityState: 'visible' },
  };
  runInNewContext(source.slice(start, end) + ';this.component=ProjectChatStatus;', sandbox);
  tree = sandbox.component(props);
  for (const hook of pendingEffects) hook.cleanup = hook.effect();
  pendingEffects = [];
};
const settle = async () => {
  for (let index = 0; index < 30; index++) {
    if (dirty || !tree) { dirty = false; render(); }
    await new Promise(setImmediate);
  }
};
const nodes = node => node && typeof node === 'object' ? [node, ...node.children.flat(Infinity).flatMap(nodes)] : [];
const text = () => JSON.stringify(tree, (_key, value) => typeof value === 'function' ? undefined : value);

render();
await settle();
assert(timers.size > 0, 'live project status must start a progress refresh timer');
assert(text().includes('已执行 0/1'), text().slice(0, 600));

recordProjectCheck(store, sid, run.runId, check.checkId, { executionState: 'ended', verdict: 'needs_check', checkedContent: '已执行。' });
setProjectRunState(store, sid, run.runId, 'completed', 2, { completedSummary: { ended: 1, executed: 1, needsCheck: 1 } });
for (const fn of timers.values()) await fn();
await settle();
assert(text().includes('已执行 1/1'), 'progress must refresh from 0/1 to 1/1 without page switch');
assert(!text().includes('正在测试'), 'completed run must stop showing the old running state');

store.close();
console.log('ok   live case progress refreshes without a page switch or model call');
