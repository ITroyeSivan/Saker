import assert from 'node:assert/strict';
import { createEffectLab, verifyLabResetReceipt } from '../benchmarks/task-effects/lab.mjs';
import { createAgentInterface } from '../benchmarks/task-effects/agent-interface.mjs';
import { buildRunFacts, materialDigest } from '../benchmarks/task-effects/run-facts.mjs';
import { sourceDigestOf, installedDigestOf } from '../benchmarks/task-effects/matrix-contract.mjs';

const lab = await createEffectLab('p1');
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error.stack || error)); } };
try {
  const bridge = createAgentInterface(lab), resetReceipt = lab.captureInitialState();
  const expected = { runId: lab.runId, caseId: lab.caseId, briefDigest: materialDigest(bridge.brief) };
  const facts = input => buildRunFacts({ lab, bridge, home: process.env.DSH_HOME,
    homeIsolation: { home: process.env.DSH_HOME, isolated: true }, payload: {}, budget: {}, ...input });
  await test('fresh live controller receipt validates actual instance material without exposing the oracle', () => {
    assert.equal(verifyLabResetReceipt(resetReceipt, expected), true);
    assert.equal(facts({ resetReceipt }).environment.snapshotRestored, true);
    assert.equal(facts({ resetReceipt }).materials.briefDigest, resetReceipt.briefDigest);
    assert(!JSON.stringify(bridge.brief).includes('stateDigest'));
  });
  await test('caller booleans, forged receipts, copied objects and wrong runs cannot claim reset', () => {
    assert.equal(facts({ snapshotRestored: true }).environment.snapshotRestored, false);
    assert.equal(facts({ resetReceipt: structuredClone(resetReceipt) }).environment.snapshotRestored, false);
    assert.equal(verifyLabResetReceipt(resetReceipt, { ...expected, runId: 'other-run' }), false);
    assert.equal(verifyLabResetReceipt(resetReceipt, { ...expected, briefDigest: 'changed' }), false);
  });
  await test('a lab that already handled a request cannot mint an initial-state receipt', async () => {
    await fetch(lab.origin + '/');
    assert.throws(() => lab.captureInitialState(), /untouched live lab/);
  });
  await test('source labels and package versions cannot substitute for file contents', () => {
    assert.throws(() => sourceDigestOf({ source: 'worktree' }), /actual source file contents/);
    assert.throws(() => installedDigestOf({ install: { version: '1.0' } }), /actual installed file contents/);
    assert.throws(() => sourceDigestOf({ sourceFiles: { files: 0, digest: 'a'.repeat(64) } }), /actual source file contents/);
  });
} finally { await lab.close(); }
process.exitCode = failed ? 1 : 0;
