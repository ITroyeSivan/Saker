import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createUpdateJob } from '../plugins/dsh-hunter/lib/update-job.js';
import * as pipeline from '../plugins/dsh-nday-hunter/lib/source-pipeline.js';
import { dispatch, apply, closeSharedStore } from '../plugins/dsh-hunter/lib/index.js';
import { openHunterStore } from '../plugins/dsh-hunter/lib/store.js';
import { SourceIndex } from '../plugins/dsh-nday-hunter/lib/source-index.js';

const source = fs.readFileSync(new URL('../plugins/dsh-hunter/lib/client.js', import.meta.url), 'utf8');
function ui(code = source) {
  const states = [], calls = [], effects = [], slots = []; let cursor = 0, component;
  const React = { useState(value) { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useRef(value) { const i = cursor++; if (!(i in states)) states[i] = { current: value }; return states[i]; },
    useEffect(fn) { effects.push(fn); }, createElement: (type, props, ...children) => ({ type, props: props || {}, children }) };
  const api = async (endpoint, payload) => { calls.push([endpoint, payload]); return { ok: true, job: { running: true, sources: payload?.source ? [payload.source] : payload?.collector.sources }, status: {} }; };
  const sandbox = { window: { __ModuleLoader__: { load(def) {
    // The full bundle is loaded below; this hook captures its exports.
    component = def.factory(name => { assert.equal(name, 'react'); return React; });
  } } }, fetch: () => { throw new Error('unexpected UI network'); }, setTimeout, clearTimeout };
  const instrumented = code.replace('return module.exports; } });', 'module.exports.component = NdayPolicySettings; module.exports.setApi = function (value) { api = value; }; return module.exports; } });');
  runInNewContext(instrumented, sandbox);
  component.setApi(api);
  const ctx = { effect() {}, slots: { inject(_name, fn) { fn(); }, register(def) { slots.push(def); } }, configForms: { get: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', value: {} }) }) } };
  component.apply(ctx);
  states[0] = { policy: { recentDays: 30, maxCandidates: 20, queriesPerNday: 2 }, collector: pipeline.normalizeCollectorConfig({ sources: ['nvd'] }), status: {} };
  function render() { cursor = 0; return component.component(); }
  function nodes(node) { if (!node || typeof node !== 'object') return []; return [node, ...node.children.flat(Infinity).flatMap(nodes)]; }
  return { states, calls, slots, render, nodes: () => nodes(render()), button: label => nodes(render()).find(node => node.children.includes(label) && node.props.onClick) };
}
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); passed++; console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.stack); } }
const st = openHunterStore(':memory:');
try {
  await check('repository subscription and AI review controls use real client events and preserve unsaved review limits', async () => {
    const client = ui();
    const address = client.nodes().find(node => node.props['aria-label'] === 'GitHub 仓库地址');
    address.props.onChange({ target: { value: 'https://github.com/example/research' } });
    client.nodes().find(node => node.props['aria-label'] === '仓库更新方式').props.onChange({ target: { value: 'ai' } });
    await client.button('订阅').props.onClick();
    assert.equal(client.calls[0][0], 'nday.repository.add'); assert.equal(client.calls[0][1].mode, 'ai');
    assert.equal(client.calls[0][1].url, 'https://github.com/example/research');
    const another = ui(); another.states[0].collector.reviewPerRun = 7;
    await another.button('继续整理 / 重试').props.onClick();
    assert.equal(another.calls[0][0], 'nday.reviews.start'); assert.equal(another.calls[0][1].collector.reviewPerRun, 7);
  });
  await check('actual client registers update settings without SRC settings or composer dock', () => {
    const client = ui(); assert(!client.slots.some(slot => slot.id === 'hunter-src-scope'));
    assert.equal(client.slots.find(slot => slot.id === 'hunter-nday-policy').label(), '漏洞情报更新');
    const tools = []; apply({ effect() {}, webServer: {}, tools: { register: tool => tools.push(tool) } });
    assert(!tools.some(tool => tool.name.startsWith('scope_program_')));
  });
  await check('button updates the current unsaved selection in one RPC; old unsaved path is detected', async () => {
    async function assertion(code) {
      const client = ui(code);
      client.nodes().find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === false).props.onChange();
      await client.button('更新已选源').props.onClick();
      assert.equal(client.calls[0][0], 'nday.collector.start');
      assert.deepEqual(Array.from(client.calls[0][1].collector.sources), ['nvd', 'cisa-kev']);
    }
    await assertion(source);
    const anchor = 'api("nday.collector.start", { collector: data.collector, source: source || null })';
    assert.equal(source.split(anchor).length, 2);
    await assert.rejects(assertion(source.replace(anchor, 'api("nday.collector.run", { force: true })')), /nday.collector/);
  });
  await check('single-source UI sends source identity and running update disables another start', async () => {
    const client = ui(); const button = client.nodes().find(node => node.children.includes('更新此源') && !node.props.disabled);
    await button.props.onClick(); assert.equal(client.calls[0][1].source, 'nvd');
    assert(client.button('正在更新…').props.disabled);
    assert(client.nodes().filter(node => node.children.includes('更新此源')).every(node => node.props.disabled));
  });
  await check('background job persists selection, returns before fetch completes, and rejects duplicate start', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; }); const seen = [];
    const adapter = { ...pipeline, runCollector: (options, deps) => pipeline.runCollector(options, { ...deps, fetchPage: async id => {
      seen.push(id); await gate; return { rows: [{ source: id, id: 'CVE-2026-1001', title: 'fixture' }], complete: true, coverage: 'fixture' };
    } }) };
    const job = createUpdateJob();
    const response = job.start(adapter, process.env.DSH_HOME, { sources: ['nvd', 'cisa-kev'], enabled: false }, 'cisa-kev');
    assert.equal(response.running, true);
    assert.deepEqual(pipeline.readCollectorConfig(process.env.DSH_HOME).sources, ['nvd', 'cisa-kev']);
    assert.throws(() => job.start(adapter, process.env.DSH_HOME, { sources: ['nvd'] }), /正在更新/);
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(seen, ['cisa-kev']);
    release(); while (job.status().running) await new Promise(resolve => setImmediate(resolve));
    assert.equal(pipeline.readCollectorState(process.env.DSH_HOME).recordCount, 1);
    assert.equal(job.status().summary.completeSources, 1);
  });
  await check('invalid selections make no writes and background rejection remains visible', async () => {
    const job = createUpdateJob(); const before = pipeline.readCollectorConfig(process.env.DSH_HOME);
    assert.throws(() => job.start(pipeline, process.env.DSH_HOME, { sources: [] }), /至少/);
    assert.throws(() => job.start(pipeline, process.env.DSH_HOME, { sources: ['wechat'] }), /检索词/);
    assert.throws(() => job.start(pipeline, process.env.DSH_HOME, { sources: ['nvd'] }, 'osv'), /勾选/);
    assert.deepEqual(pipeline.readCollectorConfig(process.env.DSH_HOME), before);
    job.start({ ...pipeline, runCollector: async () => { throw new Error('fixture lock conflict'); } }, process.env.DSH_HOME, { sources: ['nvd'] });
    while (job.status().running) await new Promise(resolve => setImmediate(resolve));
    assert.match(job.status().error, /fixture lock conflict/);
    job.start({ ...pipeline, runCollector: async () => ({ skipped: true, reason: 'collector already running' }) }, process.env.DSH_HOME, { sources: ['nvd'] });
    while (job.status().running) await new Promise(resolve => setImmediate(resolve));
    assert.match(job.status().error, /already running/);
  });
  await check('interrupted persisted state allows resume while a live owner blocks another UI update', () => {
    const index = new SourceIndex(pipeline.collectorPaths(process.env.DSH_HOME), {}, Date.now());
    try { index.setMetadata('state', { ...index.metadata('state'), running: true }); } finally { index.close(); }
    const status = pipeline.collectorStatus(process.env.DSH_HOME);
    assert.equal(status.running, false); assert.equal(status.interrupted, true);
    fs.writeFileSync(pipeline.collectorPaths(process.env.DSH_HOME).lock, `${process.pid}\n${Date.now()}\n`);
    try { assert.equal(pipeline.collectorStatus(process.env.DSH_HOME).running, true); }
    finally { fs.unlinkSync(pipeline.collectorPaths(process.env.DSH_HOME).lock); }
  });
  await check('real dispatch starts selected source with unsaved config and status reports completion', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ vulnerabilities: [] }), text: async () => JSON.stringify({ vulnerabilities: [] }) });
      const result = await dispatch(null, st, 'nday.collector.start', { collector: { sources: ['cisa-kev'], enabled: false } });
      assert.equal(result.job.running, true);
      let status;
      do { await new Promise(resolve => setImmediate(resolve)); status = await dispatch(null, st, 'nday.collector.status', {}); } while (status.job.running);
      assert.equal(status.job.error, '');
      assert.deepEqual(status.status.config.sources, ['cisa-kev']);
      assert.equal(status.status.sources[0].source, 'cisa-kev'); assert.equal(status.status.sources[0].ok, true);
    } finally { globalThis.fetch = originalFetch; }
  });
} finally { st.close(); closeSharedStore(); }
console.log(`${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
