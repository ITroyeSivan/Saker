import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { buildRunFacts, ledgerFacts, materialDigest, identityDigest, installedPluginVersions } from '../benchmarks/task-effects/run-facts.mjs';
import { assessRunQualification, summarizeRuns, assessMatrixComparability, deriveCalibratedBudget, assessPromotion } from '../benchmarks/task-effects/protocol.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-effect-facts-'));
const profile = path.join(home, 'profiles/desktop');
fs.mkdirSync(path.join(profile, 'node_modules/@dsh-external/dsh-redteam-results'), { recursive: true });
fs.writeFileSync(path.join(profile, 'node_modules/@dsh-external/dsh-redteam-results/package.json'), JSON.stringify({ name: '@dsh-external/dsh-redteam-results', version: '1.0.53' }));
const store = openStore(path.join(home, 'redteam-results/results.db'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); } };
const token = 'owner-token-should-never-appear';
const brief = { caseId: 'p1', runId: 'run-1', target: 'http://127.0.0.1:1', question: '本地练习',
  accounts: { owner: { token }, subject: { token: 'subject-token-should-never-appear' } },
  routes: { docs: 'http://127.0.0.1:1/docs' }, flow: 'direct', budget: { targetRequests: 50 }, instructions: '四类对照' };
const input = over => ({ sakerVersion: '0.4.103', benchmarkVersion: '0.0.6', home,
  homeIsolation: { home: path.join(home, 'iso/home'), isolated: true, isolatedRoot: path.join(home, 'iso') },
  preset: 'saker-effect-candidate', compositionDigest: 'a'.repeat(64), sourcePreset: 'pentest', sourcePresetCompositionDigest: 'b'.repeat(64),
  lab: { caseId: 'p1', runId: 'run-1' }, bridge: { version: 'saker.effect-interface/3', accessDigest: 'c'.repeat(64), brief },
  budget: { minutes: 5, targetRequests: 50, tokens: 220000 },
  payload: { variant: 'candidate', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low', trial: 2, source: 'release:dist/releases/Saker-0.4.92-desktop', desktopVersion: '0.2.0-rc.2' },
  calibration: { digest: 'd'.repeat(64) }, requiredRepeats: 3, caseSplit: 'calibration', ...over });
try {
  test('pre-run facts record source, install, host, preset, materials, identity, environment, trial and pre-registration', () => {
    const facts = buildRunFacts(input());
    assert.equal(facts.source, 'release:dist/releases/Saker-0.4.92-desktop');
    assert.equal(facts.host.desktop, '0.2.0-rc.2');
    assert.equal(facts.trial, 2);
    assert.deepEqual(facts.identity.roles, ['owner', 'subject']);
    assert.match(facts.identity.digest, /^[a-f0-9]{64}$/);
    assert.equal(facts.install.saker, '0.4.103');
    assert.equal(facts.install.benchmark, '0.0.6');
    assert.equal(facts.install.plugins['@dsh-external/dsh-redteam-results'], '1.0.53');
    assert.equal(facts.environment.runId, 'run-1');
    assert.equal(facts.environment.isolated, true);
    assert.equal(facts.environment.freshLab, false, 'a caller lab descriptor is not a controller reset receipt');
    assert.equal(facts.access.digest, 'c'.repeat(64));
    assert.equal(facts.preregistered.variant, 'candidate');
    assert.equal(facts.preregistered.reasoningEffort, 'low');
    assert.equal(facts.preregistered.calibrationDigest, 'd'.repeat(64));
    assert.equal(facts.tools.digest, null, 'the compiled tool digest is only known after the first request header');
  });
  test('facts never carry an account token, and identity/material digests change with the material', () => {
    const facts = buildRunFacts(input());
    const text = JSON.stringify(facts);
    assert(!text.includes(token), 'a raw identity token must never be recorded');
    assert(!text.includes('subject-token-should-never-appear'));
    assert.equal(materialDigest(brief), materialDigest({ ...brief, accounts: { owner: { token: 'rotated' } } }), 'material digest ignores credentials');
    assert.notEqual(materialDigest(brief), materialDigest({ ...brief, instructions: '改过的题面' }));
    assert.notEqual(identityDigest(brief).digest, identityDigest({ ...brief, accounts: { owner: { token: 'rotated' } } }).digest);
    assert.equal(identityDigest(brief).roles.join(), 'owner,subject');
  });
  test('missing driver facts stay null instead of being invented', () => {
    const facts = buildRunFacts(input({ payload: { variant: 'candidate', provider: 'deepseek-official', model: 'deepseek-flash' } }));
    assert.equal(facts.source, null);
    assert.equal(facts.host.desktop, null);
    assert.equal(facts.trial, null);
    assert.equal(facts.preregistered.reasoningEffort, null);
  });
  test('an absent product ledger is unknown, never zero', () => {
    const absent = ledgerFacts(home, 'no-such-session');
    assert.equal(absent.available, false);
    assert.equal(absent.wireAttempts, undefined, 'an unavailable ledger must not report 0 wire attempts');
    assert(absent.reason.includes('没有产品模型账本行'));
  });
  test('the product ledger separates conversation, auxiliary purposes and wire attempts', () => {
    store.db.prepare('INSERT INTO task_model_calls(id,root_session,round_at,session_id,state,record) VALUES(?,?,?,?,?,?)')
      .run('c1', 'ledger-session', 1, 'ledger-session', 'settled', JSON.stringify({ purpose: 'conversation', state: 'settled', wire: { protocol: 'messages' }, usage: { totalTokens: 100 } }));
    store.db.prepare('INSERT INTO task_model_calls(id,root_session,round_at,session_id,state,record) VALUES(?,?,?,?,?,?)')
      .run('c2', 'ledger-session', 1, 'ledger-session', 'settled', JSON.stringify({ purpose: 'session-title', state: 'settled', wire: { protocol: 'messages' }, usage: { totalTokens: 7 } }));
    store.db.prepare('INSERT INTO task_model_calls(id,root_session,round_at,session_id,state,record) VALUES(?,?,?,?,?,?)')
      .run('c3', 'ledger-session', 1, 'ledger-session', 'unknown', JSON.stringify({ purpose: 'conversation', state: 'unknown', wire: null }));
    const facts = ledgerFacts(home, 'ledger-session');
    assert.equal(facts.available, true);
    assert.equal(facts.calls, 3);
    assert.equal(facts.byPurpose.conversation, 2);
    assert.equal(facts.byPurpose['session-title'], 1);
    assert.equal(facts.wireAttempts, 2);
    assert.equal(facts.unobservedCalls, 1);
    assert.equal(facts.unknownCalls, 1);
    // 已结算部分的合计是**已知**的（107）；"还有未结算调用"由 unknownCalls 单独表达，不用 null 抹掉已知值。
    assert.equal(facts.settledTokens, 107);
    assert.equal(facts.unknownCalls, 1);
  });
  test('the added usage facts do not change qualification or the scoring contract', () => {
    const calibration = deriveCalibratedBudget({ pilots: [
      { id: 'a', tokens: 121808, targetRequests: 18, elapsedMs: 33545 },
      { id: 'b', tokens: 70487, targetRequests: 22, elapsedMs: 24186 },
      { id: 'c', tokens: 175350, targetRequests: 22, elapsedMs: 32177 }] });
    const base = { variant: 'candidate', budget: calibration.budget, durationFinal: true, cleanupComplete: true, isolationFailures: [],
      comparability: { comparable: true }, score: { independentSuccess: true, falseConfirmed: 0, targetRequests: 10 } };
    const legacy = { ...base, usage: { tokens: 1000, elapsedMs: 1000, humanInterventions: 0 } };
    const enriched = { ...base, usage: { tokens: 1000, knownTokens: 1000, unknownUsage: false, elapsedMs: 1000, humanInterventions: 0,
      tokenParts: { inputTokens: 700, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0, complete: true },
      auxiliary: { calls: 1, byPurpose: { 'session-title': 1 }, tokenUsage: null },
      ledger: { available: true, calls: 1, byPurpose: { conversation: 1 }, wireAttempts: 1, unobservedCalls: 0, unknownCalls: 0, settledTokens: 1000 } } };
    assert.deepEqual(assessRunQualification(enriched), assessRunQualification(legacy), 'extra usage facts must not change qualification');
    assert.equal(assessRunQualification(enriched).qualifiedSuccess, true, 'enriched usage must still qualify: ' + JSON.stringify(assessRunQualification(enriched)));
    const rows = [legacy, enriched].map((row, index) => ({ ...row, caseId: 'p1', repeat: index + 1 }));
    const summary = summarizeRuns(rows);
    assert.equal(summary.candidate.runs, 2);
    assert.equal(summary.candidate.independentSuccess, 2, 'both runs must count as qualified: ' + JSON.stringify(summary.candidate));
    // 协议严检（assessmentVersion 2）本来就要求三组各 ≥3 次；这里只断言**新增用量事实不改变判定**。
    const plainRows = [{ ...base, caseId: 'p1', repeat: 1 }, { ...base, caseId: 'p1', repeat: 2 }];
    const options = { calibration, budget: calibration.budget, requiredRepeats: 2, expectedCases: ['p1'], variants: ['candidate'] };
    const plainVerdict = assessMatrixComparability({ ...options, runs: plainRows });
    const richVerdict = assessMatrixComparability({ ...options, runs: rows });
    assert.deepEqual(richVerdict.mismatches, plainVerdict.mismatches, 'the added usage facts must not change the matrix verdict');
    assert.deepEqual(richVerdict.perVariant, plainVerdict.perVariant);
  });
  test('installed plugin versions are read from the isolated profile, not guessed', () => {
    const versions = installedPluginVersions(home);
    assert.equal(versions['@dsh-external/dsh-redteam-results'], '1.0.53');
    assert.equal(installedPluginVersions(path.join(home, 'missing')).constructor, Object);
    assert.deepEqual(installedPluginVersions(path.join(home, 'missing')), {});
  });
  test('promotion gate requires no blocking errors, no new high-impact false confirmation, and reliable results not below baseline', () => {
    const group = over => ({ runs: 3, qualifiedRuns: 3, independentSuccess: 2, falseConfirmed: 0, blockingErrors: 0,
      tokensTotal: 1000, humanInterventionsTotal: 10, ...over });
    const baseline = group({});
    // 达标：可靠结果持平、无阻塞错误、无新增假确认。
    assert.equal(assessPromotion({ 'plain-agent': baseline, candidate: group({ tokensTotal: 700 }) }).passed, true);
    assert.equal(assessPromotion({ 'plain-agent': baseline, candidate: group({ tokensTotal: 700 }) }).verdict, 'promoted-on-efficiency');
    // 可靠结果低于基线：不通过。
    assert.equal(assessPromotion({ 'plain-agent': baseline, candidate: group({ independentSuccess: 1 }) }).reasons.includes('reliable-results-below-baseline'), true);
    // 出现新增高影响假确认：不通过。
    assert.equal(assessPromotion({ 'plain-agent': baseline, candidate: group({ falseConfirmed: 1 }) }).passed, false);
    // 关键操作/恢复存在阻塞错误：不通过。
    assert.equal(assessPromotion({ 'plain-agent': baseline, candidate: group({ blockingErrors: 2 }) }).reasons.includes('blocking-errors-present'), true);
    // 未知不当作通过。
    assert.equal(assessPromotion({ 'plain-agent': baseline, candidate: group({ blockingErrors: null, blockingErrorsUnknownRuns: 1 }) }).passed, false);
    assert.equal(assessPromotion({ 'plain-agent': baseline, candidate: group({ qualifiedRuns: 2 }) }).reasons.includes('fewer-than-required-qualified-runs'), true);
    assert.equal(assessPromotion({}).verdict, 'insufficient-data');
  });
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
