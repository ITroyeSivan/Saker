import assert from 'node:assert/strict';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import {
  listWorkflowDefinitions,
  readWorkflowDefinition,
  saveWorkflowDefinition,
  selectWorkflow,
  selectedWorkflow,
  selectedWorkflowPrompt,
} from '../plugins/dsh-redteam-results/lib/workflow/store.js';
import { compileWorkflow } from '../plugins/dsh-redteam-results/lib/workflow/compiler.js';
import { registerWorkflowTools } from '../plugins/dsh-redteam-results/lib/workflow/tools.js';
const results = await import('../plugins/dsh-redteam-results/lib/index.js');

const sessionId = 'workflow-editor-session';
const store = openStore(':memory:');
let registered = null;
const ctx = { tools: { register(tool) { registered = tool; } } };
const defineTool = value => value;
registerWorkflowTools(ctx, {
  sessionOf: () => ({ id: sessionId, mode: 'pentest' }),
  store: () => store,
  defineTool,
  liveTools: () => ['saker_browser', 'redteam_execution', 'saker_material'],
});
assert(registered?.name === 'saker_workflow', 'workflow tool must register');

const definition = {
  title: '登录链路验证',
  description: '从登录入口到正常/异常对照。',
  mode: 'pentest',
  nodes: [
    { id: 'entry', title: '找登录入口', instruction: '从页面和已有请求定位登录入口。', tools: ['saker_browser'], output: '登录入口' },
    { id: 'baseline', title: '正常登录', instruction: '用正常凭据走一次登录并保存回执。', tools: ['redteam_execution'], output: '正常回执' },
    { id: 'probe', title: '异常对照', instruction: '用不存在的凭据再走一次并保存回执。', tools: ['redteam_execution'], output: '异常回执' },
  ],
};
const saved = saveWorkflowDefinition(store, definition, { scope: 'session', sessionId });
assert.match(saved.id, /^custom-/);
assert.equal(saved.source, 'session');
const selected = selectWorkflow(store, sessionId, saved.id);
assert.equal(selected.id, saved.id);
assert.match(selectedWorkflowPrompt(store, sessionId), /登录链路验证.*3步.*自定义/);
assert.equal(readWorkflowDefinition(store, saved.id, sessionId).nodes.length, 3);
assert.ok(listWorkflowDefinitions(store, sessionId).some(item => item.id === saved.id && item.source === 'session'));
for (const id of ['web-default', 'nday-default', 'code-default', 'code-review', 'ctf-single', 'ctf-multi', 'requirements-verify', 'retest'])
  assert.ok(listWorkflowDefinitions(store, sessionId).some(item => item.id === id), 'missing default workflow ' + id);
for (const id of ['web-default', 'nday-default', 'code-default', 'code-review', 'ctf-single', 'ctf-multi', 'requirements-verify', 'retest']) {
  const builtin = readWorkflowDefinition(store, id, sessionId);
  assert(builtin && builtin.nodes.length >= 4, 'default workflow must have at least four steps: ' + id);
  assert(compileWorkflow(builtin, { liveTools: [] }).prompt.length > 80, 'default workflow must compile: ' + id);
}
assert.equal(selectedWorkflow(store, 'ctf-no-selection', 'ctf-solver').id, 'ctf-single');
assert.equal(selectedWorkflow(store, 'code-no-selection', 'code-audit').id, 'code-review');
const codeReview = readWorkflowDefinition(store, 'code-review', sessionId);
assert.match(codeReview.title, /代码/);
assert.ok(codeReview.nodes.some(node => (node.tools || []).includes('redteam_finding_register')), 'code review must end in a finding');
selectWorkflow(store, 'mode-session', 'code-review');
assert.equal(results.findingModeOf(store, { id: 'mode-session', mode: 'pentest' }), 'code-audit',
  'code-review findings must be recorded as code-audit even on the pentest preset');
selectWorkflow(store, 'mode-session', 'web-default');
assert.equal(results.findingModeOf(store, { id: 'mode-session', mode: 'pentest' }), 'pentest');

const aliases = {
  '找登录入口': 'entry',
  '正常登录': 'baseline',
  '异常对照': 'probe',
};
assert.equal(aliases[selected.nodes[0].title], 'entry');
const compiled = compileWorkflow(selected, { liveTools: ['saker_browser', 'redteam_execution'] });
assert.match(compiled.prompt, /找登录入口/);
assert.match(compiled.prompt, /异常对照/);

const call = (args) => registered.execute(args, { agent: { session: { id: sessionId, mode: 'pentest' } } });
const listed = await call({ action: 'list' });
assert.equal(listed.ok, true);
assert.equal(listed.selected.id, saved.id);
assert.ok(listed.workflows.some(item => item.id === saved.id && item.source === 'session'));

const started = await call({ action: 'start', target: 'http://127.0.0.1:9/login', goal: '按自定义方法检查登录' });
assert.equal(started.ok, true);
assert.equal(started.run.workflow_id, saved.id);
assert.match(started.prompt, /找登录入口/);
assert.equal(started.stepId, 'entry');
assert.match(started.prompt, /当前步骤 ID：entry/);
assert.match(started.prompt, /action=advance runId=.*stepId=entry/);
assert.equal(started.run.data.nodes.length, 3);

const status = await call({ action: 'status', runId: started.runId });
assert.equal(status.ok, true);
assert.equal(status.runId, started.runId);
assert.equal(status.stepId, 'entry');

const rpcCtx = {
  sessions: { get: id => id === sessionId ? { id: sessionId, header: { agentPreset: 'pentest' } } : undefined },
  tools: {},
};
const rpcSaved = await results.dispatch(rpcCtx, store, 'workflow.save', {
  sessionId, scope: 'personal', select: true,
  workflow: { ...definition, title: 'RPC 登录检查' },
});
assert.equal(rpcSaved.ok, true);
assert.equal(rpcSaved.selected.title, 'RPC 登录检查');
const rpcCatalog = await results.dispatch(rpcCtx, store, 'workflow.catalog', { sessionId });
assert.equal(rpcCatalog.ok, true);
assert.ok(rpcCatalog.workflows.some(item => item.id === rpcSaved.workflow.id && item.source === 'personal'));
const rpcDeleted = await results.dispatch(rpcCtx, store, 'workflow.delete', {
  sessionId, scope: 'personal', id: rpcSaved.workflow.id,
});
assert.equal(rpcDeleted.ok, true);
assert.equal(rpcDeleted.selected.id, 'web-default');

console.log('ok   custom workflow save/select/compile/tool start all use the same definition');
console.log('ok   workflow RPC save/catalog/delete keep selection and source explicit');
console.log('\n2 workflow editor checks passed');
