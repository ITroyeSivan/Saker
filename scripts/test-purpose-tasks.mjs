import assert from 'node:assert/strict';
import { openStore, registerFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { chooseTaskMode, startTaskPolicy, readTaskPolicy, updateTaskProgress } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createPurposeTasks } from '../plugins/dsh-redteam-results/lib/purpose-tasks.js';
import { modelBudgetOwner } from '../plugins/dsh-redteam-results/lib/model-budget.js';
import { purposeReadSessionId, findingReadView } from '../plugins/dsh-redteam-results/lib/index.js';
import { writeTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy-record.js';

let passed = 0;
const test = async (name, work) => { try { await work(); passed++; console.log('ok   ' + name); } catch (error) { console.log('FAIL ' + name + ': ' + (error.stack || error.message)); process.exitCode = 1; } };

const parent = id => ({ session: { id } });

await test('review uses the explicitly selected model, bounded child policy and caller delivery', async () => {
  const store = openStore(':memory:');
  try {
    chooseTaskMode(store, 'parent', 'regular', { workers: 2, reviewModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, reportModel: null });
    startTaskPolicy(store, 'parent', { mode: 'regular', target: 'http://fixture.test', budget: { toolCalls: 10, workers: 2, minutes: 10 } });
    const starts = [];
    let disposed = 0;
    const ctx = { subagents: { async startActivation(spec) {
      starts.push(spec);
      return { childId: spec.childId, dispose: async () => { disposed += 1; }, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'review ok' }] }) };
    } } };
    const tasks = createPurposeTasks(ctx, () => store);
    const result = await tasks.run(parent('parent'), 'review');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].delivery, 'caller');
    assert.deepEqual(starts[0].request.agentOptions, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
    assert.equal(readTaskPolicy(store, starts[0].childId).parentSession, 'parent');
    assert.equal(result.output, 'review ok');
    assert.equal(result.model.provider, 'opencode-go');
    assert.equal(disposed, 1);
  } finally { store.close(); }
});

await test('empty report model inherits the current session model and report prompt forbids new target requests', async () => {
  const store = openStore(':memory:');
  try {
    chooseTaskMode(store, 'parent2', 'regular', { workers: 2, reviewModel: null, reportModel: null });
    startTaskPolicy(store, 'parent2', { mode: 'regular', target: 'http://fixture.test', budget: { toolCalls: 10, workers: 2, minutes: 10 } });
    const starts = [];
    const ctx = { subagents: { async startActivation(spec) {
      starts.push(spec);
      return { childId: spec.childId, dispose: async () => {}, result: Promise.resolve({ stopReason: 'completed', output: [] }) };
    } } };
    const tasks = createPurposeTasks(ctx, () => store);
    await tasks.run(parent('parent2'), 'report');
    assert.equal(starts[0].request.agentOptions, undefined, 'empty selection must inherit');
    assert.match(starts[0].request.prompt[0].text, /禁止新发任何目标请求/);
  } finally { store.close(); }
});

await test('explicit purpose model keeps its reasoning effort alongside provider and model', async () => {
  const store = openStore(':memory:');
  try {
    chooseTaskMode(store, 'parent-reasoning', 'regular', { workers: 2,
      reviewModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }, reportModel: null });
    startTaskPolicy(store, 'parent-reasoning', { mode: 'regular', target: 'http://fixture.test', budget: { toolCalls: 10, workers: 2, minutes: 10 } });
    const starts = [];
    const ctx = { subagents: { async startActivation(spec) {
      starts.push(spec);
      return { childId: spec.childId, dispose: async () => {}, result: Promise.resolve({ stopReason: 'completed', output: [] }) };
    } } };
    await createPurposeTasks(ctx, () => store).run(parent('parent-reasoning'), 'review');
    assert.equal(starts[0].request.agentOptions.provider, 'opencode-go');
    assert.equal(starts[0].request.agentOptions.model, 'deepseek-v4.1-flash');
    assert.equal(starts[0].request.agentOptions.reasoningEffort, 'low');
  } finally { store.close(); }
});

await test('worker limit and stopped parent block new purpose tasks', async () => {
  const store = openStore(':memory:');
  try {
    chooseTaskMode(store, 'limited', 'regular', { workers: 0 });
    startTaskPolicy(store, 'limited', { mode: 'regular', target: 'http://fixture.test', budget: { toolCalls: 5, workers: 0, minutes: 5 } });
    const ctx = { subagents: { async startActivation() { throw Error('must not start'); } } };
    const tasks = createPurposeTasks(ctx, () => store);
    await assert.rejects(tasks.run(parent('limited'), 'review'), /worker limit/);
    chooseTaskMode(store, 'stopped', 'regular', { workers: 2 });
    startTaskPolicy(store, 'stopped', { mode: 'regular', target: 'http://fixture.test', budget: { toolCalls: 5, workers: 2, minutes: 5 } });
    updateTaskProgress(store, 'stopped', { cancelled: true });
    await assert.rejects(tasks.run(parent('stopped'), 'review'), /active bounded task/);
  } finally { store.close(); }
});

// 回归：按需子任务不登记 site_workers，模型准入钩子必须仍能识别它的归属，
// 否则子会话的第一次模型调用会在进入预算钩子前就抛错（真实 0.2.1 复现过）。
await test('purpose child policy is admitted by the shared model budget without a site_workers row', async () => {
  const store = openStore(':memory:');
  try {
    chooseTaskMode(store, 'parent3', 'regular', { workers: 2 });
    startTaskPolicy(store, 'parent3', { mode: 'regular', target: 'http://fixture.test', budget: { toolCalls: 10, workers: 2, minutes: 10 } });
    const ctx = { subagents: { async startActivation(spec) {
      return { childId: spec.childId, dispose: async () => {}, result: Promise.resolve({ stopReason: 'completed', output: [] }) };
    } } };
    const tasks = createPurposeTasks(ctx, () => store);
    const started = [];
    const original = ctx.subagents.startActivation;
    ctx.subagents.startActivation = async spec => { started.push(spec.childId); return original(spec); };
    await tasks.run(parent('parent3'), 'review');
    const childId = started[0];
    const child = readTaskPolicy(store, childId);
    assert.equal(child.purposeTask, true, 'child policy must record purposeTask');
    assert.equal(child.parentRound, readTaskPolicy(store, 'parent3').startedAt);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM site_workers WHERE child_id=?').get(childId).n, 0, 'purpose child must not occupy a site worker slot');
    const owner = modelBudgetOwner(store, childId);
    assert.equal(owner.root, 'parent3');
    assert.equal(child.cancelled, true, 'settled purpose child is marked finished');
  } finally { store.close(); }
});

await test('purpose read scope follows the admitted parent round and refuses a stale round', async () => {
  const store = openStore(':memory:');
  try {
    chooseTaskMode(store, 'parent-read', 'regular', { workers: 2 });
    startTaskPolicy(store, 'parent-read', { mode: 'regular', target: 'http://fixture.test', budget: { toolCalls: 10, workers: 2, minutes: 10 } });
    const parent = readTaskPolicy(store, 'parent-read');
    startTaskPolicy(store, 'child-read', { mode: 'regular', question: 'review', target: 'http://fixture.test', stop: 'budget', parentSession: 'parent-read', purposeTask: true,
      budget: { toolCalls: 3, minutes: 5, workers: 0 } });
    assert.equal(purposeReadSessionId(store, { id: 'child-read' }), 'parent-read');
    const child = readTaskPolicy(store, 'child-read');
    assert.equal(child.parentRound, parent.startedAt);
    const next = { ...parent, startedAt: parent.startedAt + 1 };
    writeTaskPolicy(store, 'parent-read', next, 'test-round-change', {});
    assert.throws(() => purposeReadSessionId(store, { id: 'child-read' }), /父任务轮次已变化/);
  } finally { store.close(); }
});

await test('concurrent purpose tasks share the root worker reservation', async () => {
  const store = openStore(':memory:');
  try {
    chooseTaskMode(store, 'parent-concurrent', 'regular', { workers: 1 });
    startTaskPolicy(store, 'parent-concurrent', { mode: 'regular', target: 'http://fixture.test', budget: { toolCalls: 10, workers: 1, minutes: 10 } });
    let starts = 0;
    const ctx = { subagents: { async startActivation(spec) {
      starts += 1;
      await new Promise(resolve => setTimeout(resolve, 30));
      return { childId: spec.childId, dispose: async () => {}, result: Promise.resolve({ stopReason: 'completed', output: [] }) };
    } } };
    const tasks = createPurposeTasks(ctx, () => store);
    const results = await Promise.allSettled([
      tasks.run(parent('parent-concurrent'), 'review'),
      tasks.run(parent('parent-concurrent'), 'report'),
    ]);
    assert.equal(starts, 1, 'limit 1 must admit only one concurrent purpose task');
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(String(results.find(result => result.status === 'rejected')?.reason), /worker limit/);
  } finally { store.close(); }
});

await test('purpose input states actual empty counts so empty work needs no speculative lookup', async () => {
  const store = openStore(':memory:');
  const starts = [];
  const tasks = createPurposeTasks({ subagents: { async startActivation(spec) {
    starts.push(spec); return { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} };
  } } }, () => store);
  try {
    chooseTaskMode(store, 'empty-parent', 'regular', { workers: 1 });
    startTaskPolicy(store, 'empty-parent', { mode: 'regular', budget: { toolCalls: 12, workers: 1 } });
    await tasks.run(parent('empty-parent'), 'report');
    const prompt = starts[0].request.prompt[0].text;
    assert(prompt.includes('"findings":0,"requests":0,"assets":0,"checks":0,"materials":0,"receipts":0'));
    assert(prompt.includes('全为0表示没有可整理的记录'));
    assert(prompt.includes('kind=finding')); assert(prompt.includes('不调用redteam_delivery'));
    registerFinding(store, 'empty-parent', 'pentest', { title: '父任务中的本地示例', severity: 'low', summary: '只作读取验证' });
    await tasks.run(parent('empty-parent'), 'review');
    assert(starts[1].request.prompt[0].text.includes('"findings":1'), '统计来自当前父记录而不是固定空值');
  } finally { await tasks.dispose(); store.close(); }
});
await test('finding reads stay scoped, paginate indexes, and return bounded lossless UTF-8 detail chunks', () => {
  const store = openStore(':memory:');
  try {
    const expected = registerFinding(store, 'read-findings', 'pentest', { title: '本地示例', severity: 'low', summary: '中文。'.repeat(4000) });
    registerFinding(store, 'unrelated', 'pentest', { title: '其他会话', severity: 'low', summary: '不属于当前任务' });
    const index = findingReadView(store, 'read-findings');
    assert.equal(index.total, 1); assert.equal(index.rows[0].id, expected.id);
    assert.equal(JSON.parse(findingReadView(store, 'unrelated', { id: expected.id }).text.split('\n').slice(1).join('\n')).title, '其他会话', '相同本地ID仍只能读本会话记录');
    const second = registerFinding(store, 'read-findings', 'pentest', { title: '只存在父任务', severity: 'low', summary: '当前父任务记录' });
    assert.throws(() => findingReadView(store, 'unrelated', { id: second.id }), /不存在/);
    let offset = 0, parts = [];
    do {
      const result = findingReadView(store, 'read-findings', { id: expected.id, read: offset });
      const body = result.text.slice(result.text.indexOf('\n') + 1);
      assert(Buffer.byteLength(body) <= 6000); assert(!body.includes('\ufffd'));
      parts.push(body); offset = result.nextOffset;
    } while (offset !== null);
    assert.equal(JSON.parse(parts.join('')).summary, expected.summary);
    assert.throws(() => findingReadView(store, 'read-findings', { id: expected.id, read: -1 }), /偏移/);
  } finally { store.close(); }
});
console.log(`${passed} purpose-task tests passed${process.exitCode ? '; failures present above' : ''}`);
