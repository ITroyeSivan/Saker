import assert from 'node:assert/strict';
import { createEffectLab } from '../benchmarks/task-effects/lab.mjs';
import { createAgentInterface, mountRestrictedAgent, assertRestrictedSurface, TOOL_NAMES, countUsage } from '../benchmarks/task-effects/agent-interface.mjs';

let failures = 0;
async function test(label, body) { try { await body(); console.log('ok ' + label); } catch (error) { failures++; console.error('FAIL ' + label + ': ' + error.stack); } }
const submit = (bridge, value) => bridge.definitions[1].execute({ outcome: value.outcome, evidenceIds: JSON.stringify(value.evidenceIds) });
await test('agent brief has an opaque case identity and no truth, grader or filesystem capability', async () => {
  const lab = await createEffectLab('n3');
  try {
    const bridge = createAgentInterface(lab);
    assert.equal(bridge.brief.caseId, lab.runId); assert.notEqual(bridge.brief.caseId, lab.caseId);
    const sent = JSON.stringify({ brief: bridge.brief, tools: bridge.definitions });
    assert(!sent.includes(lab.controller.markers.owner)); assert(!sent.includes('"vulnerable"')); assert(!sent.includes('"category"'));
    assert.deepEqual(bridge.definitions.map(tool => tool.name), TOOL_NAMES);
    assert(!bridge.definitions.some(tool => /read_file|shell|grade/.test(tool.name)));
  } finally { await lab.close(); }
});
await test('shared interface returns real raw receipts, denies escapes and preserves request budget under concurrency', async () => {
  const lab = await createEffectLab('p1', { maxRequests: 2 });
  try {
    const bridge = createAgentInterface(lab), request = bridge.definitions[0];
    const outside = await request.execute({ url: lab.origin.replace('127.0.0.1', 'localhost') + '/metadata' });
    assert.equal(outside.ok, false); assert.equal(lab.audit().length, 0);
    const badHeaders = await request.execute({ url: lab.origin + '/metadata', headers: '[]' }); assert.equal(badHeaders.ok, false);
    const results = await Promise.all(Array.from({ length: 4 }, () => request.execute({ url: lab.origin + '/metadata' })));
    assert.equal(results.filter(result => result.ok).length, 2); assert.equal(lab.audit().length, 2);
    assert.equal(JSON.parse(results.find(result => result.ok).receipt.responseBody).product, 'Local Documents');
    assert(!Object.hasOwn(results.find(result => result.ok).receipt, 'responseBodyBase64'), 'do not duplicate model-visible response bytes');
    assert.equal(bridge.controller.snapshot().receipts.length, 2);
  } finally { await lab.close(); }
});
await test('submit seals once without revealing a score; fabricated confirmation stays false in controller grading', async () => {
  const lab = await createEffectLab('p1');
  try {
    const bridge = createAgentInterface(lab);
    assert.equal((await submit(bridge, { outcome: 'yes', evidenceIds: [], findings: [] })).ok, false);
    const receipt = await bridge.definitions[0].execute({ url: lab.origin + '/metadata' });
    const value = { outcome: 'confirmed', evidenceIds: [receipt.receipt.id], findings: [{ caseId: bridge.brief.caseId, kind: 'private-read', status: 'confirmed', evidenceIds: [receipt.receipt.id] }] };
    const reply = await submit(bridge, value);
    assert.deepEqual(reply, { ok: true, accepted: true, runId: lab.runId });
    assert(!JSON.stringify(reply).includes('score')); assert(!JSON.stringify(reply).includes('expected'));
    assert.equal((await submit(bridge, value)).ok, false);
    assert.equal((await bridge.definitions[0].execute({ url: lab.origin + '/metadata' })).ok, false);
    assert.equal(lab.audit().length, 1); assert.equal(bridge.controller.grade().falseConfirmed, 1);
  } finally { await lab.close(); }
});
await test('genuine effect is independently scored using only this opaque run id and observed receipts', async () => {
  const lab = await createEffectLab('p1');
  try {
    const bridge = createAgentInterface(lab), ids = [];
    for (let round = 0; round < 2; round++) for (const [role, object] of [['owner','owner'], ['subject','subject'], ['subject','owner'], ['anonymous','owner']]) {
      const input = lab.controller.recordRequest(role, object);
      const result = await bridge.definitions[0].execute({ ...input, headers: JSON.stringify(input.headers) });
      assert(result.ok); ids.push(result.receipt.id);
    }
    await submit(bridge, { outcome: 'confirmed', evidenceIds: ids, findings: [{ caseId: bridge.brief.caseId, kind: 'private-read', status: 'confirmed', evidenceIds: ids }] });
    assert(bridge.controller.grade().independentSuccess);
    const snapshot = bridge.controller.snapshot(); snapshot.submission.findings[0].caseId = 'invented';
    assert(bridge.controller.grade().independentSuccess, 'controller snapshots must not mutate accepted submission');
    assert.equal(bridge.controller.snapshot().submission.findings[0].caseId, lab.runId);
  } finally { await lab.close(); }
});
await test('submission cannot race a request still awaiting a real response', async () => {
  const lab = await createEffectLab('f4');
  try {
    const bridge = createAgentInterface(lab);
    const pending = bridge.definitions[0].execute({ url: lab.origin + '/metadata' });
    assert.equal((await submit(bridge, { outcome: 'inconclusive', evidenceIds: [], findings: [] })).ok, false);
    const result = await pending; assert.equal(result.receipt.outcome, 'timeout');
    assert((await submit(bridge, { outcome: 'inconclusive', evidenceIds: [result.receipt.id], findings: [] })).ok);
    assert(bridge.controller.grade().independentSuccess);
  } finally { await lab.close(); }
});
await test('usage includes cached input and unknown or corrupt fields never become zero', () => {
  assert.equal(countUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 700, cacheWriteTokens: 30 }), 850);
  assert.equal(countUsage({ inputTokens: 0, outputTokens: 0 }), 0);
  assert.equal(countUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 700, cacheWriteTokens: 30, totalTokens: 850 }), 850);
  assert.equal(countUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 119 }), null, 'contradictory authoritative total is unknown');
  assert.equal(countUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }), null, 'overflow cannot be reported as reliable usage');
  for (const usage of [undefined, {}, { inputTokens: 1 }, { inputTokens: -1, outputTokens: 2 }, { inputTokens: 1, outputTokens: 2, cacheReadTokens: null }]) assert.equal(countUsage(usage), null);
});
await test('execution guard denies later local shell tools and rollback releases only owned registrations', async () => {
  const lab = await createEffectLab('p1');
  try {
    const local = new Map(), inherited = ['shell', 'read_file'], guards = [], lifts = [];
    let restricted = false;
    const agent = { id: 'synthetic-agent', ctx: { tools: {
      restrict(filter) { assert.deepEqual(filter, { allow: [] }); restricted = true; return () => { restricted = false; lifts.push('restriction'); }; },
      guard(fn) { guards.push(fn); return () => { guards.splice(guards.indexOf(fn), 1); lifts.push('guard'); }; },
      register(tool) { local.set(tool.name, tool); return () => { local.delete(tool.name); lifts.push(tool.name); }; },
      schemas() { return [...(restricted ? [] : inherited), ...local.keys()].map(name => ({ name })); },
    } } };
    const release = mountRestrictedAgent(agent, createAgentInterface(lab), tool => tool);
    assert.deepEqual(assertRestrictedSurface(agent), [...TOOL_NAMES].sort());
    local.set('late_shell', {});
    assert.throws(() => assertRestrictedSurface(agent), /differ/);
    assert.match(guards[0]({ agent, name: 'late_shell' }), /outside/);
    assert.match(guards[0]({ agent: { id: 'other' }, name: TOOL_NAMES[0] }), /outside/);
    assert.equal(guards[0]({ agent, name: TOOL_NAMES[0] }), undefined);
    release(); assert.equal(restricted, false); assert.equal(guards.length, 0); assert(local.has('late_shell'));
    assert.equal(lifts.length, 4);
  } finally { await lab.close(); }
});
console.log('Interface behavior only: modelCalls=0; Desktop enforcement is verified separately.');
process.exitCode = failures ? 1 : 0;
