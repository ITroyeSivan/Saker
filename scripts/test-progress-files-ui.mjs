import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('function ProjectFilesPanel('), source.indexOf('function ResultsView('));
const stage = readFileSync(new URL('../plugins/dsh-stage-gate/lib/client.js', import.meta.url), 'utf8');
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...value.children.flat(Infinity).flatMap(nodes)];
function harness(reply) {
  let cursor = 0;
  const state = [], effects = [], calls = [], copies = [];
  const props = { sessionId: 'local-session', sessionsStore: { list: { getSnapshot: () => ({ byId: { 'local-session': { cwd: 'C:/synthetic-workspace' } } }) } },
    connection: { rpc: { call: async (...args) => { calls.push(args); return typeof reply === 'function' ? reply() : reply; } } } };
  const sandbox = { useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
    useRef: initial => { const i = cursor++; if (!(i in state)) state[i] = { current: initial }; return state[i]; }, useEffect: effect => effects.push(effect),
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }, Btn: 'button', fmtTime: value => value,
    navigator: { clipboard: { writeText: async value => copies.push(value) } } };
  runInNewContext(component + ';this.component=ProjectFilesPanel;', sandbox);
  const render = () => { cursor = 0; return sandbox.component(props); };
  return { calls, copies, render, nodes: () => nodes(render()), mount: async () => { render(); effects[0](); await new Promise(setImmediate); }, unmount: () => effects[0]() };
}
const snapshot = { goal: 'Inspect the local fixture', criteria: { total: 0 }, tasks: [], flow: { buckets: [] }, artifacts: { reportGroups: [] } };
const empty = harness({ ok: true, value: { ok: true, snapshot } });
await empty.mount();
assert.equal(empty.calls.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(empty.calls[0])), ['/dsh-stage-gate-project', 'status', { workspace: 'C:/synthetic-workspace' }]);
assert(JSON.stringify(empty.render()).includes('所有会话共享'));
assert(JSON.stringify(empty.render()).includes('还没有报告或复现文件'));
assert(!JSON.stringify(empty.render()).includes('全部满足'));
assert(empty.nodes().find(n => n.type === 'details' && n.children[0]?.children.includes('工作区执行记录'))?.props.open === undefined);
console.log('ok   empty workspace states scope and unknown completion without inventing success');

const file = { absPath: 'C:/synthetic-workspace/reports/local.md', relPath: 'reports/local.md', name: 'local.md', title: 'Local report', kind: 'report', bytes: 1024 };
const populated = harness({ ok: true, value: { ok: true, snapshot: { ...snapshot, artifacts: { reportGroups: [{ files: [file] }] }, flow: { buckets: [{ bucketId: 'local-candidate', product: 'Local product', verificationStatus: 'pending', assetIds: ['local-asset'] }] } } } });
await populated.mount();
await populated.nodes().find(n => n.type === 'button' && n.children.includes('复制路径')).props.onClick();
assert.deepEqual(populated.copies, [file.absPath]);
assert(JSON.stringify(populated.render()).includes('尚未验证，不能认定适用'));
assert(!populated.calls.some(args => args[1] !== 'status'));
console.log('ok   report copy uses actual saved path and Nday unknown stays unconfirmed');

const failure = harness({ ok: false, error: { message: 'fixture unavailable' } });
await failure.mount();
assert(failure.nodes().find(n => n.props.role === 'alert' && n.children.includes('fixture unavailable')));
assert(!JSON.stringify(failure.render()).includes('还没有报告或复现文件'));
console.log('ok   read failure shows an error rather than a successful empty workspace');

const slots = [];
const scope = { sessions: {}, slots: { inject: (_name, fn) => fn(), register: (options, render) => { slots.push(options); return () => {}; } } };
const applySource = stage.slice(stage.lastIndexOf('function apply(ctx)'), stage.indexOf('module.exports =', stage.lastIndexOf('function apply(ctx)')));
const sandbox = { React: { createElement() {} }, ProgressDocumentTitle() {} };
runInNewContext(applySource + ';this.apply=apply;', sandbox);
sandbox.apply({ ...scope, inject: (_keys, fn) => fn(scope) });
assert.deepEqual(slots.map(slot => slot.id), ['stage-gate.progress-title']);
console.log('ok   stage plugin keeps progress title without registering a duplicate conversation page');
