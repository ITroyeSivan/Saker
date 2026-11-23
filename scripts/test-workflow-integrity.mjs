import assert from 'node:assert/strict';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { recordBrowserReceipt } from '../plugins/dsh-redteam-results/lib/browser-execution.js';
import { compileWorkflow, stepPrompt } from '../plugins/dsh-redteam-results/lib/workflow/compiler.js';
import { resolveCapabilities } from '../plugins/dsh-redteam-results/lib/workflow/capabilities.js';
import { validateDefinition } from '../plugins/dsh-redteam-results/lib/workflow/schema.js';
import {
  advanceWorkflowRun,
  createWorkflowRun,
  readWorkflowRun,
  saveWorkflowDefinition,
  selectWorkflow,
  stopWorkflowRun,
} from '../plugins/dsh-redteam-results/lib/workflow/store.js';
import { registerWorkflowTools } from '../plugins/dsh-redteam-results/lib/workflow/tools.js';

const sessionId = 'workflow-integrity';
const target = 'http://127.0.0.1:9';
const store = openStore(':memory:');

const definition = {
  title: '回执完整性',
  description: '分析、真实执行、再次执行',
  mode: 'pentest',
  nodes: [
    { id: 'inspect', title: '分析入口', instruction: '读取目标入口。', tools: [], output: '入口材料', completion: 'artifact' },
    { id: 'verify', title: '真实执行', instruction: '发送一次真实请求。', tools: ['redteam_execution'], output: '执行回执', completion: 'receipt' },
    { id: 'control', title: '再次执行', instruction: '完成第二个真实动作。', tools: ['redteam_execution'], output: '另一个执行回执', completion: 'receipt' },
  ],
};
const workflow = saveWorkflowDefinition(store, definition, { scope: 'session', sessionId });
const compiled = compileWorkflow(workflow, { liveTools: ['redteam_execution'] });
const run = createWorkflowRun(store, sessionId, { workflow, compiled, target, goal: '校验完成证据' });

assert.throws(
  () => advanceWorkflowRun(store, run, { stepId: 'inspect', status: 'done' }),
  /需要至少一条结构化材料/,
  'empty artifact must not complete an analysis step',
);
assert.throws(
  () => advanceWorkflowRun(store, run, { stepId: 'inspect', status: 'done', evidenceRefs: ['receipt-1'] }),
  /arbitrary strings are not receipts/,
  'an arbitrary string must not be accepted as evidence',
);
const afterAnalysis = advanceWorkflowRun(store, run, {
  stepId: 'inspect',
  status: 'done',
  artifacts: [{ kind: 'observation', title: '入口', detail: '首页返回 200，已记录入口和原始 URL。' }],
});
assert.equal(afterAnalysis.current_index, 1);
assert.equal(afterAnalysis.data.nodes[0].artifacts[0].kind, 'observation');
console.log('ok   analysis steps require typed artifacts');

assert.throws(
  () => advanceWorkflowRun(store, afterAnalysis, { stepId: 'verify', status: 'done', note: '做过了' }),
  /要求本次新执行回执/,
  'receipt steps must reject prose-only completion',
);
const otherReceipt = recordBrowserReceipt(store, 'other-session', {
  source: 'host-browser-execution',
  url: target,
  executed: true,
  completedAt: new Date().toISOString(),
});
assert.throws(
  () => advanceWorkflowRun(store, afterAnalysis, {
    stepId: 'verify',
    status: 'done',
    evidenceRefs: [{ kind: 'browser', id: otherReceipt.id }],
  }),
  /不存在|not found/,
  'a real receipt from another session must be rejected',
);
const wrongTarget = recordBrowserReceipt(store, sessionId, {
  source: 'host-browser-execution',
  url: 'http://127.0.0.1:10',
  executed: true,
  completedAt: new Date().toISOString(),
});
assert.throws(
  () => advanceWorkflowRun(store, afterAnalysis, {
    stepId: 'verify',
    status: 'done',
    evidenceRefs: [{ kind: 'browser', id: wrongTarget.id }],
  }),
  /不属于当前目标/,
  'a receipt from another target must be rejected',
);
const validReceipt = recordBrowserReceipt(store, sessionId, {
  source: 'host-browser-execution',
  url: target + '/login',
  executed: true,
  completedAt: new Date().toISOString(),
});
const afterVerify = advanceWorkflowRun(store, afterAnalysis, {
  stepId: 'verify',
  status: 'done',
  evidenceRefs: [{ kind: 'browser', id: validReceipt.id }],
});
assert.equal(afterVerify.current_index, 2);
assert.equal(afterVerify.data.nodes[1].completionBindings[0].id, validReceipt.id);
console.log('ok   receipt steps bind current-session, target-matched evidence');

assert.throws(
  () => advanceWorkflowRun(store, afterVerify, {
    stepId: 'control',
    status: 'done',
    evidenceRefs: [{ kind: 'browser', id: validReceipt.id }],
  }),
  /占用|重复绑定/,
  'one receipt must not silently satisfy two workflow steps',
);
const inconclusive = advanceWorkflowRun(store, afterVerify, {
  stepId: 'control',
  status: 'unknown',
  note: '第二个动作缺少身份前提，未执行。',
});
assert.equal(inconclusive.state, 'done');
assert.equal(inconclusive.data.outcome, 'inconclusive');
assert.match(stepPrompt(inconclusive), /不等于目标已经验证成功/);
console.log('ok   method completion and target verification are separate outcomes');

const stoppedRun = createWorkflowRun(store, sessionId, {
  workflow,
  compiled,
  target,
  goal: '停止后不允许复活',
});
const stopped = stopWorkflowRun(store, stoppedRun, '用户停止');
assert.equal(stopped.state, 'stopped');
assert.throws(
  () => advanceWorkflowRun(store, stoppedRun, {
    stepId: 'inspect',
    status: 'done',
    artifacts: [{ kind: 'gap', title: '迟到', detail: '停止后才到达的材料。' }],
  }),
  /stopped|no longer active|已停止/,
  'a stale advancement must not revive a stopped run',
);
assert.equal(readWorkflowRun(store, sessionId, stoppedRun.run_id).state, 'stopped');
assert.equal(stopWorkflowRun(store, stoppedRun, '重复停止').state, 'stopped');
console.log('ok   stopped runs are terminal and stale advances are rejected');

const controlValidation = validateDefinition({ ...definition, id: 'control-test',
  edges: [{ from: 'inspect', to: 'control' }] });
assert.equal(controlValidation.ok, false,
  'edges must be rejected rather than ignored');
assert.match(controlValidation.errors.join('\n'), /edges: non-linear control fields are not supported/);
const jumpValidation = validateDefinition({ ...definition, id: 'control-test', nodes: [
  { ...definition.nodes[0], next: 'control' },
  definition.nodes[1],
  definition.nodes[2],
] });
assert.equal(jumpValidation.ok, false, 'non-linear next must be rejected rather than rewritten');
assert.match(jumpValidation.errors.join('\n'), /only the immediate next step is supported/);
const linearValidation = validateDefinition({ ...definition, id: 'control-test',
  nodes: definition.nodes.map(node => ({ ...node, next: undefined })) });
assert.equal(linearValidation.ok, true,
  'an omitted next field must normalize to the linear sequence');
console.log('ok   non-linear control semantics are rejected at save/import');

const unverified = resolveCapabilities(['semgrep_scan'], ['pwsh']);
assert.equal(unverified[0].status, 'adapter-unverified');
assert.equal(unverified[0].available.length, 0);
const verified = resolveCapabilities(['semgrep_scan'], ['pwsh'], {
  verifiedAdapters: {
    semgrep_scan: { available: true, version: '1.100.0', contract: 'semgrep --json with stable path/line/rule output mapping' },
  },
});
assert.equal(verified[0].status, 'available');
assert.equal(verified[0].source, 'verified-shell-adapter');
console.log('ok   shell presence is not promoted to a verified scanner capability');

const freshDefinition = {
  title: '本次复测',
  description: '只接受本次运行后采集的回执',
  mode: 'pentest',
  nodes: [
    { id: 'fresh', title: '本次新执行', instruction: '重新执行。', tools: ['saker_browser'],
      output: '本次回执', completion: 'receipt', evidencePolicy: 'fresh', identityRef: 'alice' },
    { id: 'report', title: '记录', instruction: '记录结果。', tools: [], output: '结果',
      completion: 'artifact', evidencePolicy: 'none' },
  ],
};
const freshWorkflow = saveWorkflowDefinition(store, freshDefinition, { scope: 'session', sessionId: 'freshness' });
const freshRun = createWorkflowRun(store, 'freshness', {
  workflow: freshWorkflow,
  compiled: compileWorkflow(freshWorkflow, { liveTools: ['saker_browser'] }),
  target,
  goal: '本次复测只能使用新证据',
});
const historical = recordBrowserReceipt(store, 'freshness', {
  source: 'host-browser-execution',
  url: target + '/feature',
  executed: true,
  identityRef: 'alice',
  completedAt: '2000-01-01T00:00:00.000Z',
});
assert.throws(
  () => advanceWorkflowRun(store, freshRun, {
    stepId: 'fresh',
    status: 'done',
    evidenceRefs: [{ kind: 'browser', id: historical.id }],
  }),
  /早于本次运行创建时间/,
  'a historical receipt must not satisfy a fresh-execution step',
);
const wrongIdentity = recordBrowserReceipt(store, 'freshness', {
  source: 'host-browser-execution',
  url: target + '/feature',
  executed: true,
  identityRef: 'bob',
  completedAt: new Date(Date.now() + 1000).toISOString(),
});
assert.throws(
  () => advanceWorkflowRun(store, freshRun, {
    stepId: 'fresh',
    status: 'done',
    evidenceRefs: [{ kind: 'browser', id: wrongIdentity.id }],
  }),
  /身份是 bob/,
  'a fresh receipt from another identity must be rejected',
);
const currentIdentity = recordBrowserReceipt(store, 'freshness', {
  source: 'host-browser-execution',
  url: target + '/feature',
  executed: true,
  identityRef: 'alice',
  completedAt: new Date(Date.now() + 1000).toISOString(),
});
const freshDone = advanceWorkflowRun(store, freshRun, {
  stepId: 'fresh',
  status: 'done',
  evidenceRefs: [{ kind: 'browser', id: currentIdentity.id }],
});
assert.equal(freshDone.data.nodes[0].completionBindings[0].generation, 'fresh');
console.log('ok   fresh execution rejects historical evidence and mismatched identity');

const reuseDefinition = {
  title: '历史复用',
  description: '允许分析步骤复用同一历史回执',
  mode: 'pentest',
  nodes: [
    { id: 'first', title: '读历史一', instruction: '读取历史回执。', tools: [], output: '材料',
      completion: 'receipt', evidencePolicy: 'reuse' },
    { id: 'second', title: '读历史二', instruction: '同一历史回执再做分析。', tools: [], output: '材料',
      completion: 'receipt', evidencePolicy: 'reuse' },
    { id: 'report', title: '报告', instruction: '整理结果。', tools: [], output: '结论',
      completion: 'artifact', evidencePolicy: 'none' },
  ],
};
const reuseWorkflow = saveWorkflowDefinition(store, reuseDefinition, { scope: 'session', sessionId: 'reuse' });
const reuseRun = createWorkflowRun(store, 'reuse', {
  workflow: reuseWorkflow,
  compiled: compileWorkflow(reuseWorkflow, { liveTools: [] }),
  target,
  goal: '历史材料可多次分析',
});
const reuseHistorical = recordBrowserReceipt(store, 'reuse', {
  source: 'host-browser-execution',
  url: target + '/feature',
  executed: true,
  identityRef: 'previous-login',
  completedAt: '2000-01-01T00:00:00.000Z',
});
const reuseOne = advanceWorkflowRun(store, reuseRun, {
  stepId: 'first',
  status: 'done',
  evidenceRefs: [{ kind: 'browser', id: reuseHistorical.id }],
});
const reuseTwo = advanceWorkflowRun(store, reuseOne, {
  stepId: 'second',
  status: 'done',
  evidenceRefs: [{ kind: 'browser', id: reuseHistorical.id }],
});
assert.equal(reuseTwo.data.nodes[0].completionBindings[0].generation, 'reuse');
assert.equal(reuseTwo.data.nodes[1].completionBindings[0].generation, 'reuse');
assert.equal(reuseTwo.current_index, 2);
console.log('ok   reused historical evidence remains available to multiple analysis steps');

let registered = null;
registerWorkflowTools({ tools: { register(tool) { registered = tool; } } }, {
  sessionOf: () => ({ id: sessionId, mode: 'pentest' }),
  store: () => store,
  liveTools: () => ['redteam_execution'],
  defineTool: value => value,
});
selectWorkflow(store, sessionId, workflow.id);
const call = args => registered.execute(args, { agent: { session: { id: sessionId, mode: 'pentest' } } });
const toolStarted = await call({ action: 'start', workflowId: workflow.id, target, goal: '工具处理器完整性' });
assert.equal(toolStarted.ok, true);
assert.equal(toolStarted.stepId, 'inspect');
assert.match(toolStarted.prompt, /当前步骤 ID：inspect/);
assert.match(toolStarted.prompt, /revision：0/);
const toolEmpty = await call({ action: 'advance', runId: toolStarted.runId,
  stepId: 'inspect', status: 'done' });
assert.equal(toolEmpty.ok, false);
assert.match(toolEmpty.error, /结构化材料/);
const toolDefaultStep = await call({ action: 'advance', runId: toolStarted.runId, status: 'done',
  artifacts: [{ kind: 'observation', title: '入口', detail: '默认使用当前稳定 stepId 推进成功。' }] });
assert.equal(toolDefaultStep.ok, true);
assert.equal(toolDefaultStep.stepId, 'verify');
assert.equal(toolDefaultStep.revision, 1);
const staleStep = await call({ action: 'advance', runId: toolStarted.runId,
  stepId: 'inspect', status: 'done', note: '迟到推进' });
assert.equal(staleStep.ok, false);
assert.equal(staleStep.code, 'workflow_step_not_current');
assert.equal(staleStep.currentStepId, 'verify');
assert.match(staleStep.recovery, /stepId=verify/);
const toolStopped = await call({ action: 'stop', runId: toolStarted.runId, note: '停止' });
assert.equal(toolStopped.ok, true);
const toolLate = await call({ action: 'advance', runId: toolStarted.runId,
  stepId: 'inspect', status: 'done',
  artifacts: [{ kind: 'gap', title: '迟到', detail: '停止后的迟到材料。' }] });
assert.equal(toolLate.ok, false);
assert.match(toolLate.error, /stopped|no longer active|已停止/);
console.log('ok   registered Host tool exposes stable stepId/revision and recovers wrong-step calls');

store.db.close();
console.log('\n9 workflow integrity checks passed');
