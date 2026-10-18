import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { summarizeMatrix, mapMatrixResults } from './summarize-effect-matrix.mjs';
import { deriveCalibratedBudget, assessMatrixComparability, matrixContractDigest } from '../benchmarks/task-effects/protocol.mjs';
import { buildMatrixContract, freezeFactsFromResult, graderDigestOf, materialsSpecDigest } from '../benchmarks/task-effects/matrix-contract.mjs';
import { CASESET_VERSION } from '../benchmarks/task-effects/cases.mjs';

let failed = 0;
function test(label, fn) { try { fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }

const calibration = deriveCalibratedBudget({ pilots: [
  { id: 'plain', tokens: 176416, targetRequests: 35, elapsedMs: 51314 },
  { id: 'frozen', tokens: 171521, targetRequests: 16, elapsedMs: 31400 },
  { id: 'candidate', tokens: 168715, targetRequests: 24, elapsedMs: 36316 },
] });
const sha = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const contract = {
  version: 'task-effects-matrix/3', calibrationDigest: calibration.digest,
  budget: { ...calibration.budget }, requiredRepeats: 3, cases: ['p1'],
  shared: { model: 'fixture-model', provider: 'fixture-provider', reasoningEffort: 'low',
    toolDigest: sha('tools'), accessDigest: sha('access'), interfaceVersion: 'fixture-interface/3',
    caseSetVersion: 'fixture-cases/8', graderDigest: sha('grader'), hostVersion: 'fixture-host/2', caseSplit: 'calibration' },
  variants: Object.fromEntries(['candidate', 'plain-agent', 'saker-0.4.92'].map(variant => [variant,
    { sourceDigest: sha(variant + '-source'), installedDigest: sha(variant + '-installed'), presetCompositionDigest: sha(variant + '-preset') }])),
  materials: { p1: sha('p1-materials') },
};
contract.digest = sha(JSON.stringify(canonical(contract)));
let serial = 0;
const run = (variant, tokens, requests, elapsedMs, extra = {}) => ({
  variant, caseId: 'p1', runId: 'run-' + (++serial), repeat: ((serial - 1) % 3) + 1,
  ...contract.shared, ...contract.variants[variant],
  contractDigest: contract.digest, calibrationDigest: calibration.digest,
  initialMaterialsDigest: contract.materials.p1, snapshotRestored: true, homeIsolation: { isolated: true },
  materialsDigest: sha('observed-' + serial),
  resetReceipt: { version: 'effect-reset/1', ok: true, requests: 0, runId: 'run-' + serial, caseId: 'p1',
    caseSetVersion: contract.shared.caseSetVersion, briefDigest: sha('observed-' + serial), stateDigest: sha('controller-state-' + serial) },
  score: { independentSuccess: true, falseConfirmed: 0, targetRequests: requests, ...(extra.score ?? {}) },
  usage: { tokens, elapsedMs, humanInterventions: 0, ...(extra.usage ?? {}) },
  budget: { ...calibration.budget },
  comparability: { comparable: false, mismatches: ['frozen-three-group-comparison-not-run'] },
  durationFinal: true, cleanupComplete: true, isolationFailures: [], ...(extra.run ?? {}),
});
const full = [
  run('candidate', 80000, 14, 24000), run('candidate', 90000, 16, 26000), run('candidate', 100000, 18, 36000),
  run('plain-agent', 50000, 15, 20000), run('plain-agent', 55000, 16, 21000), run('plain-agent', 60000, 17, 22000),
  run('saker-0.4.92', 90000, 19, 30000), run('saker-0.4.92', 100000, 20, 32000), run('saker-0.4.92', 110000, 21, 34000),
];
const group = (summary, variant) => summary.groups.find(row => row.variant === variant);
const summarize = options => summarizeMatrix({ contract, ...options });

await test('a full three-by-three matrix is comparable and the totals add up', () => {
  const summary = summarize({ calibration, repeats: 3, runs: full });
  assert.equal(summary.comparability.comparable, true, JSON.stringify(summary.comparability));
  assert.deepEqual(summary.comparability.perVariant, { 'plain-agent': 3, 'saker-0.4.92': 3, candidate: 3 });
  const candidate = group(summary, 'candidate');
  assert.equal(candidate.runs, 3);
  assert.equal(candidate.qualifiedSuccess, 3);
  assert.equal(candidate.tokensTotal, 270000);
  assert.equal(candidate.tokensMedian, 90000);
  assert.equal(candidate.requestsTotal, 48);
  assert.equal(candidate.requestsMedian, 16);
  assert.equal(candidate.overBudgetRuns, 0);
});

await test('one run per group is a pilot and cannot be comparable', () => {
  const summary = summarize({ calibration, repeats: 3, runs: [full[0], full[3], full[6]] });
  assert.equal(summary.comparability.comparable, false);
  assert(summary.comparability.mismatches.includes('frozen-three-group-comparison-not-run'));
  assert.equal(group(summary, 'candidate').qualifiedSuccess, 0, 'a pilot must not be counted as a qualified success');
});

await test('a contract cannot reduce the three-group three-repeat requirement or use out-of-range trials', () => {
  const once=structuredClone(contract);once.requiredRepeats=1;once.digest=matrixContractDigest(once);
  const rows=[full[0],full[3],full[6]].map(row=>({...row,repeat:1,contractDigest:once.digest}));
  const single=assessMatrixComparability({calibration,budget:calibration.budget,contract:once,requiredRepeats:1,runs:rows});
  assert.equal(single.comparable,false);assert(single.mismatches.includes('matrix-repeats-below-three'));
  const omitted=assessMatrixComparability({calibration,budget:calibration.budget,contract,variants:['candidate'],runs:full.slice(0,3)});
  assert.equal(omitted.comparable,false);assert(omitted.mismatches.includes('matrix-variants-invalid'));
  const runs=structuredClone(full);runs[0].repeat=4;
  assert(summarize({calibration,runs}).comparability.mismatches.includes('repeat-missing-or-invalid'));
});

await test('unknown usage stays unknown instead of becoming zero', () => {
  const runs = structuredClone(full); runs[1].usage.tokens = null;
  const summary = summarize({ calibration, repeats: 3, runs });
  const candidate = group(summary, 'candidate');
  assert.equal(candidate.tokensTotal, null, 'a missing token count must not be summed as zero');
  assert.equal(candidate.tokensMedian, null);
  assert.equal(candidate.unknownBudgetRuns, 1);
  assert.equal(candidate.qualifiedSuccess, 2, 'the unknown-usage run is not eligible');
});

await test('an over-budget run is reported, never silently qualified', () => {
  const runs = structuredClone(full); runs[2].usage.tokens = 300000;
  const summary = summarize({ calibration, repeats: 3, runs });
  const candidate = group(summary, 'candidate');
  assert.equal(candidate.overBudgetRuns, 1);
  assert.equal(candidate.qualifiedSuccess, 2);
  assert.equal(candidate.disqualificationReasons['tokens-budget-exceeded'], 1);
});

await test('missing inputs are rejected instead of producing an empty table', () => {
  assert.throws(() => summarizeMatrix({ calibration, repeats: 3, runs: [] }), /at least one run record/);
  assert.throws(() => summarizeMatrix({ runs: full }), /calibration record/);
});

await test('matrix rejects changed runtime facts even when all groups are complete', () => {
  for (const field of [...Object.keys(contract.shared), ...Object.keys(contract.variants.candidate), 'contractDigest', 'calibrationDigest', 'initialMaterialsDigest']) {
    const runs = structuredClone(full); runs[0][field] = 'different';
    const summary = summarize({ calibration, repeats: 3, runs });
    assert.equal(summary.comparability.comparable, false, `changed ${field} must not qualify`);
    assert.equal(group(summary, 'candidate').qualifiedSuccess, 0, field);
    assert(summary.comparability.mismatches.some(reason => reason.includes(field)), field);
  }
});

// 启动路径（工具 / 路由 / 无）会改变模型看到的第一条消息，属于口径而不是实现细节：
// 冻结了就必须逐轮核对，否则"某组悄悄换了启动方式"会被当成同口径比较。
// 2026-10-18 实测：只换启动路径就能让同一候选从"预算内成功"变成"全部超预算"。
await test('a frozen setup path catches a variant silently changing how the task starts', () => {
  const variants = ['candidate', 'plain-agent', 'saker-0.4.92'];
  const freezeFacts = Object.fromEntries(variants.map(variant => [variant, {
    source: 'worktree', install: { saker: '0.4.105' },
    sourceFiles: { files: 1, digest: sha('source-' + variant) }, installFiles: { files: 1, digest: sha('installed-' + variant) },
    model: 'fixture-model', provider: 'fixture-provider', reasoningEffort: 'low',
    toolDigest: contract.shared.toolDigest, accessDigest: contract.shared.accessDigest,
    interfaceVersion: contract.shared.interfaceVersion,
    presetCompositionDigest: contract.variants[variant].presetCompositionDigest,
    hostVersion: contract.shared.hostVersion, caseSplit: 'calibration',
    setupPath: variant === 'plain-agent' ? 'none' : 'tool:ctx.tools.get',
  }]))
  const frozenContract = buildMatrixContract({ calibration, cases: ['p1'], variants, requiredRepeats: 3, freezeFacts,
    model: 'fixture-model', provider: 'fixture-provider', reasoningEffort: 'low', caseSplit: 'calibration' });
  assert.equal(frozenContract.variants.candidate.setupPath, 'tool:ctx.tools.get');
  assert.equal(frozenContract.variants['plain-agent'].setupPath, 'none');
  const mapped = full.map(row => ({ ...row, contractDigest: frozenContract.digest,
    caseSetVersion: frozenContract.shared.caseSetVersion, graderDigest: frozenContract.shared.graderDigest,
    initialMaterialsDigest: frozenContract.materials.p1, resetReceipt: { ...row.resetReceipt, caseSetVersion: frozenContract.shared.caseSetVersion },
    sourceDigest: frozenContract.variants[row.variant].sourceDigest,
    installedDigest: frozenContract.variants[row.variant].installedDigest,
    presetCompositionDigest: frozenContract.variants[row.variant].presetCompositionDigest,
    setupPath: frozenContract.variants[row.variant].setupPath }));
  assert.equal(summarizeMatrix({ contract: frozenContract, calibration, repeats: 3, runs: mapped }).comparability.comparable, true);
  const drifted = structuredClone(mapped); drifted[0].setupPath = 'route';
  const summary = summarizeMatrix({ contract: frozenContract, calibration, repeats: 3, runs: drifted });
  assert.equal(summary.comparability.comparable, false);
  assert(summary.comparability.mismatches.includes('runtime-setupPath'));
  assert.equal(group(summary, 'candidate').qualifiedSuccess, 0);
});

await test('matrix rejects duplicate run IDs and duplicate trial numbers', () => {
  for (const field of ['runId', 'repeat']) {
    const runs = structuredClone(full); runs[1][field] = runs[0][field];
    const summary = summarize({ calibration, repeats: 3, runs });
    assert.equal(summary.comparability.comparable, false, `duplicate ${field} must not count as another trial`);
  }
});

await test('matrix merge preserves a real local mismatch', () => {
  const runs = structuredClone(full);
  runs[0].comparability.mismatches.push('compiled-tool-interface-changed');
  const summary = summarize({ calibration, repeats: 3, runs });
  assert.equal(summary.comparability.comparable, false, 'merging must only discharge missing-group diagnostics');
  assert.equal(group(summary, 'candidate').qualifiedSuccess, 0);
  assert(summary.comparability.mismatches.includes('compiled-tool-interface-changed'));
});

await test('matrix verifies calibration and contract hashes and reset evidence', () => {
  const changed = structuredClone(calibration); changed.basis.pilots[0].tokens++;
  assert.equal(summarize({ calibration: changed, runs: full }).comparability.comparable, false, 'a copied digest must not validate edited calibration');
  const changedContract = structuredClone(contract); changedContract.shared.model = 'other';
  assert.equal(summarize({ calibration, runs: full, contract: changedContract }).comparability.comparable, false);
  const runs = structuredClone(full); runs[0].snapshotRestored = false;
  assert.equal(summarize({ calibration, runs }).comparability.comparable, false);
});

await test('legacy records remain descriptive and cannot gain verified qualification', () => {
  const runs = structuredClone(full); delete runs[0].sourceDigest;
  const summary = summarize({ calibration, runs });
  assert.equal(summary.comparability.comparable, false);
  assert.equal(group(summary, 'candidate').rawSuccess, 3, 'retain the raw score');
  assert.equal(group(summary, 'candidate').qualifiedSuccess, 0);
  assert.equal(summarizeMatrix({ calibration, runs: full }).comparability.comparable, false, 'no frozen contract means no verified experiment');
});

await test('summary separates negative false confirmations from unsupported positive claims', () => {
  const runs = structuredClone(full);
  for (const [index, expected] of [[0, 'confirmed'], [1, 'no-finding'], [2, 'inconclusive']]) {
    runs[index].score = { ...runs[index].score, expected, independentSuccess: false, falseConfirmed: 1,
      reasonCode: 'confirmation-unsupported', evidenceErrors: [] };
  }
  const candidate = group(summarize({ calibration, runs }), 'candidate');
  for (const expected of ['confirmed', 'no-finding', 'inconclusive']) {
    assert.equal(candidate.byExpected[expected].runs, 1);
    assert.equal(candidate.byExpected[expected].unsupportedConfirmations, 1);
  }
  assert.equal(candidate.failureCodes['confirmation-unsupported'], 3);
});

await test('frozen contract maps raw result records into a comparable matrix and catches tampering', () => {
  // 原始 result.json 只有原料（facts.*）；契约与映射层用同一套摘要规则把它变成协议口径。
  const rawRun = (variant, trial, extra = {}) => ({
    runId: `${variant}-trial-${trial}`, caseId: 'p1', variant,
    model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'low',
    toolDigest: sha('tools'), accessDigest: sha('access'), interfaceVersion: 'saker.effect-interface/3',
    caseSplit: 'calibration', presetCompositionDigest: sha(variant + '-preset'),
    budget: { ...calibration.budget }, homeIsolation: { isolated: true },
    durationFinal: true, cleanupComplete: true, isolationFailures: [],
    facts: {
      source: `worktree:${variant}`, trial,
      sourceFiles: { files: 1, digest: sha('source-' + variant) }, installFiles: { files: 1, digest: sha('installed-' + variant) },
      install: { saker: variant === 'saker-0.4.92' ? '0.4.92' : '0.4.103', benchmark: '0.0.6', plugins: {} },
      host: { desktop: '0.2.0-rc.2' },
      preset: { compositionDigest: sha(variant + '-preset') },
      environment: { freshLab: true, snapshotRestored: true, resetReceipt: { version: 'effect-reset/1', ok: true,
        requests: 0, runId: `${variant}-trial-${trial}`, caseId: 'p1', caseSetVersion: CASESET_VERSION, briefDigest: sha(`brief-${variant}-${trial}`), stateDigest: sha('state') } },
      materials: { caseSetVersion: CASESET_VERSION, briefDigest: sha(`brief-${variant}-${trial}`), specDigest: materialsSpecDigest({ caseId: 'p1', interfaceVersion: 'saker.effect-interface/3' }) },
    },
    score: { independentSuccess: true, falseConfirmed: 0, targetRequests: 10 },
    usage: { tokens: 1000, elapsedMs: 1000, humanInterventions: 0 },
    submission: { outcome: 'confirmed', evidenceIds: ['x'] },
    // 实例级判定：单组单实例时本来就没有契约、也凑不齐三组；这两个理由由批次层消解。
    comparability: { comparable: false, mismatches: ['matrix-contract-missing', 'frozen-three-group-comparison-not-run'] },
    ...extra,
  });
  const variants = ['plain-agent', 'saker-0.4.92', 'candidate'];
  const raws = variants.flatMap(variant => [1, 2, 3].map(trial => rawRun(variant, trial)));
  const freezeFacts = Object.fromEntries(variants.map(variant => [variant, freezeFactsFromResult(rawRun(variant, 1))]));
  const contract = buildMatrixContract({ calibration, cases: ['p1'], variants, requiredRepeats: 3, freezeFacts,
    model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'low', caseSplit: 'calibration' });
  assert.equal(matrixContractDigest(contract), contract.digest, '契约摘要必须可复算');
  assert.equal(contract.materials.p1, contract.materials.p1.toLowerCase());
  const mapped = mapMatrixResults({ runs: raws, contract, calibration, graderDigest: graderDigestOf() });
  assert.equal(mapped[0].repeat, 1);
  assert.equal(mapped[3].repeat, 1);
  assert.equal(mapped[8].repeat, 3);
  assert.equal(mapped[0].contractDigest, contract.digest);
  assert.equal(mapped[0].initialMaterialsDigest, contract.materials.p1);
  assert.equal(mapped[0].snapshotRestored, true);
  assert.equal(mapped[0].score.blockingErrors, 0, '干净运行必须派生 0 阻塞错误');
  // 阻塞错误只从已记录事实推：隔离失败 + 未提交 + 未收口 = 3。
  const dirty = mapMatrixResults({ runs: [{ ...rawRun('candidate', 1), isolationFailures: ['tool surface changed'],
    submission: undefined, durationFinal: false }], contract, calibration });
  assert.equal(dirty[0].score.blockingErrors, 3);
  const good = summarizeMatrix({ calibration, repeats: 3, runs: mapped, contract });
  assert.equal(good.comparability.comparable, true, JSON.stringify(good.comparability.mismatches));
  assert.deepEqual(mapped[0].comparability.mismatches, [], '实例级"缺契约/缺三组"由批次层消解');
  const tamperedTool = structuredClone(mapped); tamperedTool[4].toolDigest = sha('changed-tools');
  assert(tamperedTool && summarizeMatrix({ calibration, repeats: 3, runs: tamperedTool, contract }).comparability.mismatches.includes('runtime-toolDigest'));
  const tamperedSnapshot = structuredClone(mapped); tamperedSnapshot[2].snapshotRestored = false;
  assert(summarizeMatrix({ calibration, repeats: 3, runs: tamperedSnapshot, contract }).comparability.mismatches.includes('snapshot-not-restored'));
  // 真实的本地故障必须原样保留（不能被"批次层消解"的名单误伤）。
  const localFault = mapMatrixResults({ runs: [{ ...rawRun('candidate', 1), comparability: { comparable: false, mismatches: ['runtime-toolDigest', 'matrix-contract-missing'] } }], contract, calibration });
  assert.deepEqual(localFault[0].comparability.mismatches, ['runtime-toolDigest']);
  assert.throws(() => mapMatrixResults({ runs: [{ ...rawRun('candidate', 1), facts: { ...rawRun('candidate', 1).facts, trial: null } }], contract, calibration }), /trial/);
});

console.log('Fixture verification only: synthetic records, no host and no model call.');
process.exitCode = failed ? 1 : 0;
