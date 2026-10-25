import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext, readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { chooseTaskMode, chosenTaskOptions, startTaskPolicy, readTaskPolicy, updateTaskProgress,
  taskPolicyStatus, taskExecutionGuard, pauseTaskPolicy, takeTaskContinuation, finishTaskOnTurnEnd,
  taskPrompt, checkpointTask, confirmTaskCheckpoint, archiveTaskRound } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { hostWorkerLimit } from '../plugins/dsh-redteam-results/lib/site-workers.js';

const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const store = openStore(path.join(process.env.DSH_HOME, 'redteam-results', 'results.db'));
const hooks = new Map(), disposers = [], tools = new Map();
const ctx = {
  tools: { guard() {}, register: tool => tools.set(tool.name, tool) },
  webServer: { register: () => () => {} },
  on(name, fn) { const list = hooks.get(name) || []; list.push(fn); hooks.set(name, list); },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
};
results.apply(ctx);

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error)); }
}

try {
  await test('interaction preferences persist before start, enter prompts, and desktop confirmation preserves budget', () => {
    for (const [input, expected] of [
      ['continuous', 'auto'], ['milestone', 'auto'], ['confirm', 'confirm-step'], ['guided', 'confirm-step'],
      ['auto', 'auto'], ['confirm-data-change', 'confirm-data-change'], ['confirm-step', 'confirm-step'],
    ]) {
      const id = 'interaction-' + input;
      chooseTaskMode(store, id, 'regular', { interaction: input, workers: 0 });
      const selected = taskPolicyStatus(store, id);
      assert.equal(selected.options.interaction, expected);
      assert.match(taskPrompt(selected), /询问时机/);

      const other = expected === 'auto' ? 'confirm-step' : 'auto';
      assert.throws(() => startTaskPolicy(store, id, { mode: 'regular', interaction: other, budget: { toolCalls: 5 } }),
        /interaction differs/);
      const policy = startTaskPolicy(store, id, { mode: 'regular', target: 'https://fixture.test', budget: { toolCalls: 5, minutes: 10 } });
      assert.equal(policy.interaction, expected);
      assert.equal(taskExecutionGuard(store, id, 'recorded-http-execution'), undefined);
      if (expected !== 'auto') {
        checkpointTask(store, id, 'Synthetic checkpoint');
        assert.equal(taskPolicyStatus(store, id).reason, 'interaction_confirmation_required');
        const before = readTaskPolicy(store, id);
        confirmTaskCheckpoint(store, id, 'desktop-user');
        const after = readTaskPolicy(store, id);
        for (const key of ['budget', 'used', 'startedAt']) assert.deepEqual(after[key], before[key]);
      }
    }
    assert.throws(() => chooseTaskMode(store, 'invalid-interaction', 'regular', { interaction: 'never-stop' }),
      /invalid interaction/);
  });

  await test('legacy start mode remains readable but cannot create stages, prompts or extra allowances', () => {
    chooseTaskMode(store, 'start-mode', 'regular', { startMode: 'auto-recon', workers: 0 });
    const policy = startTaskPolicy(store, 'start-mode', {
      mode: 'regular', target: 'https://fixture.test', startMode: 'auto-recon', budget: { toolCalls: 5, minutes: 10, discoveryCalls: 4 },
    });
    assert.equal(policy.startMode, 'direct-test');
    assert.equal(policy.flow.kind, 'single');
    assert.equal(policy.budget.discoveryCalls, 0);
    assert.equal(policy.budget.unmeteredToolCalls, null);
    const prompt = taskPrompt(taskPolicyStatus(store, 'start-mode'));
    assert.doesNotMatch(prompt, /起步方式|初步观察|资料优先|自动信息收集/);
    assert.throws(() => chooseTaskMode(store, 'invalid-start', 'regular', { startMode: 'invented' }),
      /invalid task start mode/);
  });

  await test('checkpoint confirmation blocks operations and completion until a Desktop action without resetting budget', () => {
    chooseTaskMode(store, 'checkpoint', 'regular', { interaction: 'confirm-step', workers: 0 });
    startTaskPolicy(store, 'checkpoint', { mode: 'regular', budget: { toolCalls: 5, minutes: 10 } });
    const before = readTaskPolicy(store, 'checkpoint');
    checkpointTask(store, 'checkpoint', 'Synthetic checkpoint');
    assert.match(taskExecutionGuard(store, 'checkpoint', 'recorded-http-execution'), /interaction_confirmation_required/);
    assert.throws(() => updateTaskProgress(store, 'checkpoint', { planComplete: true }), /桌面确认/);
    assert.throws(() => archiveTaskRound(store, 'checkpoint', 'desktop-user'), /先确认继续或停止/);
    assert.throws(() => confirmTaskCheckpoint(store, 'checkpoint', 'model'), /Desktop user confirmation/);
    confirmTaskCheckpoint(store, 'checkpoint', 'desktop-user');
    const after = readTaskPolicy(store, 'checkpoint');
    for (const key of ['budget', 'used', 'startedAt', 'question', 'target', 'flow']) assert.deepEqual(after[key], before[key]);
    updateTaskProgress(store, 'checkpoint', { planComplete: true });
    assert.equal(taskPolicyStatus(store, 'checkpoint').reason, 'plan_complete');
  });

  await test('a stopped model turn closes only a single task and does not claim completion', () => {
    chooseTaskMode(store, 'turn-ended', 'regular', { workers: 0 });
    startTaskPolicy(store, 'turn-ended', { mode: 'regular', budget: { toolCalls: 5, minutes: 10 } });
    const stopped = finishTaskOnTurnEnd(store, 'turn-ended');
    assert.equal(stopped.reason, 'turn_ended');
    assert.equal(taskPolicyStatus(store, 'turn-ended').reason, 'turn_ended');
    assert.match(taskExecutionGuard(store, 'turn-ended', 'recorded-http-execution'), /turn_ended/);
    assert.equal(readTaskPolicy(store, 'turn-ended').planComplete, false);
    assert.equal(finishTaskOnTurnEnd(store, 'turn-ended'), null);

    chooseTaskMode(store, 'turn-blocked', 'regular', { interaction: 'confirm-step', workers: 0 });
    startTaskPolicy(store, 'turn-blocked', { mode: 'regular', budget: { toolCalls: 5 } });
    checkpointTask(store, 'turn-blocked', 'Waiting for the user');
    assert.equal(finishTaskOnTurnEnd(store, 'turn-blocked'), null);
  });

  await test('host worker capacity is bounded and a started task cannot raise its selected ceiling', () => {
    assert.equal(hostWorkerLimit({ get: name => name === 'subagents' ? { config: { maxActiveSubagents: { get: () => 8 } } } : undefined }), 8);
    assert.equal(hostWorkerLimit({ get: name => name === 'subagents' ? { config: { maxActiveSubagents: { get: () => 99 } } } : undefined }), 16);
    assert.equal(hostWorkerLimit({}), 16);

    chooseTaskMode(store, 'selected', 'regular', { workers: 0 });
    assert.equal(chosenTaskOptions(store, 'selected').workers, 0);
    assert.throws(() => startTaskPolicy(store, 'selected', { mode: 'regular', budget: { toolCalls: 5, workers: 1 } }),
      /不能提高/);
    const policy = startTaskPolicy(store, 'selected', { mode: 'regular', budget: { toolCalls: 5 } });
    assert.equal(policy.workerLimit, 0);
    assert.throws(() => chooseTaskMode(store, 'selected', 'nday'), /不能切换/);
    assert.equal(startTaskPolicy(store, 'higher-limit', { mode: 'regular', budget: { toolCalls: 5, workers: 16 } }).workerLimit, 16);
    assert.throws(() => startTaskPolicy(store, 'over-limit', { mode: 'regular', budget: { toolCalls: 5, workers: 17 } }), /0 and 16/);
  });

  await test('default worker ceiling is the plan value 2', () => {
    chooseTaskMode(store, 'default-workers', 'regular');
    assert.equal(chosenTaskOptions(store, 'default-workers').workers, 2);
    const policy = startTaskPolicy(store, 'default-workers-direct', { mode: 'regular', budget: { toolCalls: 5 } });
    assert.equal(policy.workerLimit, 2);
  });

  await test('one task keeps one operation budget and does not reset time, question, target or materials', () => {
    const policy = startTaskPolicy(store, 'shared-budget', {
      mode: 'regular', question: 'Read only supplied synthetic fixture metadata', target: 'https://fixture.test',
      budget: { toolCalls: 5, minutes: 10 },
    });
    saveTaskContext(store, 'shared-budget', {
      assets: [{ id: 'fixture', url: 'https://fixture.test', inScope: true, reachable: true, product: 'Synthetic Fixture' }],
    });
    for (let index = 0; index < 5; index += 1) {
      assert.equal(taskExecutionGuard(store, 'shared-budget', 'recorded-http-execution'), undefined);
    }
    assert.match(taskExecutionGuard(store, 'shared-budget', 'recorded-http-execution'), /tool_budget_exhausted/);
    const current = readTaskPolicy(store, 'shared-budget');
    assert.equal(current.used.toolCalls, 5);
    for (const field of ['budget', 'startedAt', 'target', 'question', 'workerLimit']) assert.deepEqual(current[field], policy[field]);
    assert.equal(readTaskContext(store, 'shared-budget').assets[0].product, 'Synthetic Fixture');
  });

  await test('parent and child share one operation budget and a stopped parent closes child target work', () => {
    startTaskPolicy(store, 'budget-parent', {
      mode: 'regular', target: 'https://fixture.test', budget: { toolCalls: 5, workers: 1 },
    });
    store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)')
      .run('budget-parent', 'budget-child', 'https://fixture.test', JSON.stringify({
        state: 'running', parentId: 'budget-parent', childId: 'budget-child', site: 'https://fixture.test',
        allowedTools: ['redteam_execution'],
      }));
    startTaskPolicy(store, 'budget-child', {
      mode: 'nday', parentSession: 'budget-parent', budget: { toolCalls: 5, workers: 0 },
    });
    for (let index = 0; index < 5; index += 1) {
      assert.equal(taskExecutionGuard(store, index % 2 ? 'budget-parent' : 'budget-child', 'recorded-http-execution'), undefined);
    }
    assert.equal(readTaskPolicy(store, 'budget-parent').used.toolCalls, 5);
    assert.match(taskExecutionGuard(store, 'budget-child', 'recorded-http-execution'), /parent_task_stopped/);
  });

  await test('cancellation and elapsed deadlines stop target work without creating a continuation', () => {
    startTaskPolicy(store, 'cancelled-flow', { mode: 'regular', budget: { toolCalls: 5, minutes: 10 } });
    updateTaskProgress(store, 'cancelled-flow', { cancelled: true });
    assert.match(taskExecutionGuard(store, 'cancelled-flow', 'recorded-http-execution'), /已停止/);
    assert.equal(takeTaskContinuation(store, 'cancelled-flow'), null);

    startTaskPolicy(store, 'paused-flow', { mode: 'regular', budget: { toolCalls: 5, minutes: 10 } });
    pauseTaskPolicy(store, 'paused-flow', { code: 'ip-blocked', reason: 'Synthetic deny', evidence: 'offline fixture' });
    assert.match(taskExecutionGuard(store, 'paused-flow', 'recorded-http-execution'), /ip-blocked|已停止/);
    assert.equal(takeTaskContinuation(store, 'paused-flow'), null);

    startTaskPolicy(store, 'expired', { mode: 'regular', budget: { toolCalls: 5, minutes: 1 } }, Date.now() - 120000);
    assert.equal(taskPolicyStatus(store, 'expired').reason, 'time_budget_exhausted');
    assert.match(taskExecutionGuard(store, 'expired', 'recorded-http-execution'), /time_budget_exhausted/);
    assert.equal(takeTaskContinuation(store, 'expired'), null);
  });

  await test('a new round waits for every worker to be released while preserving archived history', () => {
    startTaskPolicy(store, 'archive-round', { mode: 'regular', budget: { toolCalls: 5, minutes: 10 } });
    updateTaskProgress(store, 'archive-round', { cancelled: true });
    store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)')
      .run('archive-round', 'archive-child', 'https://fixture.test', JSON.stringify({
        state: 'cleanup-failed', parentId: 'archive-round', childId: 'archive-child', site: 'https://fixture.test',
      }));
    assert.throws(() => archiveTaskRound(store, 'archive-round', 'desktop-user'), /子代理/);
    store.db.prepare('UPDATE site_workers SET record=? WHERE child_id=?')
      .run(JSON.stringify({ state: 'released', parentId: 'archive-round', childId: 'archive-child', site: 'https://fixture.test' }), 'archive-child');
    assert.equal(archiveTaskRound(store, 'archive-round', 'desktop-user').archived, true);
    assert.equal(readTaskPolicy(store, 'archive-round'), null);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_rounds WHERE session_id=?').get('archive-round').n, 1);
  });

  await test('all modes share one 36-template library; copying uses final text without starting a task', async () => {
    const source = fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
    const { builtinTemplates, promptFields } = await import('../plugins/dsh-redteam-results/lib/prompt-templates.js');
    const catalog = builtinTemplates();
    assert.equal(catalog.length, 36);
    const snippet = source.slice(source.indexOf('function promptSubstitute('), source.indexOf('function ChatSetup('));
    const clipboard = [], values = [];
    let cursor = 0, fail = false;
    const library = { ok: true, builtin: catalog, fields: promptFields(), user: { templates: [], total: 0, more: 0 } };
    const sandbox = {
      useState: initial => { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => values[index] = value]; },
      useRef: initial => { const index = cursor++; if (!(index in values)) values[index] = { current: initial }; return values[index]; },
      useEffect(fn) { const index = cursor++; if (!(index in values)) { values[index] = true; fn(); } },
      React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
      navigator: { clipboard: { writeText: text => { if (fail) throw Error('offline clipboard denial'); clipboard.push(text); } } },
      api: async endpoint => endpoint === 'prompt.library' ? library : { ok: true, drafts: [], draft: { revision: 1 } },
    };
    runInNewContext(snippet + ';this.component=ChatPromptEditor;', sandbox);
    const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flat(Infinity).flatMap(nodes)];
    const tree = async mode => {
      cursor = 0; sandbox.component({ mode, open: true }); await new Promise(setImmediate);
      cursor = 0; return nodes(sandbox.component({ mode, open: true }));
    };
    for (const mode of ['regular', 'nday', '0day']) {
      const pick = (await tree(mode)).find(node => node.type === 'button' && JSON.stringify(node).includes('从一个网站开始'));
      assert(pick, mode + ' must expose the shared template library');
      pick.props.onClick();
      const selected = await tree(mode);
      selected.find(node => node.props['aria-label'] === '目标地址').props.onChange({ target: { value: 'https://example.test' } });
      const full = (await tree(mode)).find(node => node.props['aria-label'] === '提示词全文').props.value;
      assert(full.includes('https://example.test'));
      await (await tree(mode)).find(node => node.type === 'button' && node.children.includes('复制')).props.onClick();
      assert.equal(clipboard.at(-1), full);
      assert.equal(readTaskPolicy(store, 'copy-only'), null);
    }
    fail = true;
    (await tree('regular')).find(node => node.type === 'button' && JSON.stringify(node).includes('从一个网站开始')).props.onClick();
    await (await tree('regular')).find(node => node.type === 'button' && node.children.includes('复制')).props.onClick();
    cursor = 0;
    assert(JSON.stringify(sandbox.component({ mode: 'regular', open: true })).includes('复制失败'));
    assert.equal(clipboard.length, 3);
  });
} finally {
  for (const dispose of disposers.reverse()) await dispose();
  store.close();
}
process.exitCode = failed ? 1 : 0;
