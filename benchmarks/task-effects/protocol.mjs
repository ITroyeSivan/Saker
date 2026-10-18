import { createHash, createHmac } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CASES, CASESET_VERSION } from './cases.mjs';

export function makeProtocol({ model, toolDigest, accessDigest, baselineCommit, candidateCommit,
  seed, budget = { minutes: 30, targetRequests: 200, tokens: 150000 }, calibrated = false,
  calibration, includeArtex = false } = {}) {
  for (const [key, value] of Object.entries({ model, toolDigest, accessDigest, baselineCommit, candidateCommit, seed })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`explicit ${key} required`);
  }
  for (const [key, value] of Object.entries(budget)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${key} budget`);
  if (!['minutes', 'targetRequests', 'tokens'].every(key => Object.hasOwn(budget, key))) throw new Error('complete shared budget required');
  // 标记为已校准必须带着**记录下来的三组 pilot 证据**，并且冻结预算不能低于该证据推出的下限 ——
  // 否则任何调用方手写 calibrated:true 就能把未校准的 150k 名义额度当成公平预算。
  if (calibrated) {
    if (!calibration || typeof calibration !== 'object' || !calibration.budget || typeof calibration.digest !== 'string' || !calibration.digest.trim()) {
      throw new Error('calibrated protocols require recorded calibration evidence');
    }
    for (const key of ['minutes', 'targetRequests', 'tokens']) {
      if (!Number.isSafeInteger(calibration.budget[key]) || calibration.budget[key] < 1) throw new Error(`calibration ${key} is invalid`);
      if (budget[key] < calibration.budget[key]) throw new Error(`budget ${key} is below the calibrated floor ${calibration.budget[key]}`);
    }
  }
  const variants = ['plain-agent', 'saker-0.4.92', 'candidate', ...(includeArtex ? ['artex-pinned'] : [])];
  const runs = CASES.flatMap(item => variants.flatMap(variant => Array.from({ length: 3 }, (_, repeat) => ({ caseId: item.id, split: item.split, variant, repeat: repeat + 1 }))));
  const rank = run => createHmac('sha256', seed).update(JSON.stringify(run)).digest('hex');
  runs.sort((a, b) => rank(a).localeCompare(rank(b)));
  const config = { version: CASESET_VERSION, model, toolDigest, accessDigest, baselineCommit, candidateCommit,
    seed, budget, calibrated, calibration: calibration ?? null, variants, runs };
  return { ...config, digest: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}

export function assessComparability(protocol, runtime = {}) {
  const mismatches = ['model', 'toolDigest', 'accessDigest'].filter(key => runtime[key] !== protocol[key]);
  if (JSON.stringify(runtime.budget) !== JSON.stringify(protocol.budget)) mismatches.push('budget');
  if (!protocol.calibrated) mismatches.push('budget-not-calibrated');
  else if (typeof protocol.calibration?.digest !== 'string' || !protocol.calibration.digest.trim()) mismatches.push('budget-calibration-missing');
  if (!runtime.snapshotRestored) mismatches.push('snapshot-not-restored');
  return { comparable: mismatches.length === 0, mismatches };
}

/** 冻结对照的三组；顺序固定，便于比对。 */
export const MATRIX_VARIANTS = ['plain-agent', 'saker-0.4.92', 'candidate'];

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sameValue = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const digestValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function matrixContractDigest(contract) {
  const { digest: _digest, ...content } = contract;
  return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
}

// Counting completed rows proves coverage only. Configuration and provenance are
// checked against a contract frozen before the run, never inferred from its score.
export function assessMatrixRunFacts({ calibration, budget, runs, variants, expectedCases, requiredRepeats, contract }) {
  const mismatches = new Set(), issues = [];
  const add = reason => mismatches.add(reason);
  if (!Array.isArray(variants) || new Set(variants).size !== variants.length
    || MATRIX_VARIANTS.some(variant => !variants.includes(variant))
    || variants.some(variant => ![...MATRIX_VARIANTS, 'artex-pinned'].includes(variant))) add('matrix-variants-invalid');
  if (!Number.isSafeInteger(requiredRepeats) || requiredRepeats < 3) add('matrix-repeats-below-three');
  try {
    const basis = calibration?.basis;
    if (!basis) add('budget-calibration-basis-missing');
    else {
      const derived = deriveCalibratedBudget({ pilots: basis.pilots, headroom: basis.headroom, steps: basis.steps });
      if (derived.digest !== calibration.digest || !sameValue(derived.budget, calibration.budget)
        || !sameValue(derived.basis, basis)) add('budget-calibration-digest-mismatch');
    }
  } catch { add('budget-calibration-invalid'); }
  if (!contract || typeof contract !== 'object') {
    add('matrix-contract-missing');
    return { mismatches: [...mismatches], issues };
  }
  if (!['task-effects-matrix/2', 'task-effects-matrix/3'].includes(contract.version)) add('matrix-contract-version');
  if (contract.version === 'task-effects-matrix/2') add('historical-protocol-missing-reset-provenance');
  if (!digestValue(contract.digest) || matrixContractDigest(contract) !== contract.digest) add('matrix-contract-digest-mismatch');
  if (contract.calibrationDigest !== calibration?.digest) add('matrix-contract-calibrationDigest');
  if (!sameValue(contract.budget, budget)) add('matrix-contract-budget');
  if (contract.requiredRepeats !== requiredRepeats) add('matrix-contract-requiredRepeats');
  const cases = Array.isArray(contract.cases) ? contract.cases : [];
  if (!cases.length || cases.some(id => !nonempty(id)) || new Set(cases).size !== cases.length) add('matrix-contract-cases');
  if (expectedCases && !sameValue([...new Set(expectedCases)].sort(), [...cases].sort())) add('matrix-contract-case-set');
  const sharedFields = ['model', 'provider', 'reasoningEffort', 'toolDigest', 'accessDigest', 'interfaceVersion',
    'caseSetVersion', 'graderDigest', 'hostVersion', 'caseSplit'];
  const variantFields = ['sourceDigest', 'installedDigest', 'presetCompositionDigest'];
  // 启动路径不是摘要而是枚举，单独按"非空且逐轮一致"核对。
  const variantExactFields = ['setupPath'];
  for (const field of sharedFields) {
    const value = contract.shared?.[field];
    if (!nonempty(value) || (field.endsWith('Digest') && !digestValue(value))) add('matrix-contract-' + field);
  }
  for (const variant of variants) for (const field of variantFields) {
    if (!digestValue(contract.variants?.[variant]?.[field])) add('matrix-contract-' + field);
  }
  for (const variant of variants) for (const field of variantExactFields) {
    // 只有契约确实冻结了该字段才要求逐轮一致；旧契约没有这一项时保持向后兼容。
    const frozen = contract.variants?.[variant]?.[field];
    if (frozen !== undefined && frozen !== null && !nonempty(frozen)) add('matrix-contract-' + field);
  }
  for (const caseId of cases) if (!digestValue(contract.materials?.[caseId])) add('matrix-contract-initialMaterialsDigest');
  const ids = new Set(), trials = new Set();
  for (const run of runs) {
    const reasons = [];
    if (!nonempty(run?.runId)) reasons.push('runId-missing');
    else if (ids.has(run.runId)) reasons.push('runId-duplicate');
    else ids.add(run.runId);
    if (!cases.includes(run?.caseId)) reasons.push('caseId-not-in-contract');
    if (!variants.includes(run?.variant)) reasons.push('variant-not-in-contract');
    if (!Number.isSafeInteger(run?.repeat) || run.repeat < 1 || run.repeat > requiredRepeats) reasons.push('repeat-missing-or-invalid');
    else {
      const trial = JSON.stringify([run.caseId, run.variant, run.repeat]);
      if (trials.has(trial)) reasons.push('repeat-duplicate');
      else trials.add(trial);
    }
    for (const field of sharedFields) if (!nonempty(run?.[field]) || run[field] !== contract.shared?.[field]) reasons.push('runtime-' + field);
    for (const field of variantFields) if (!digestValue(run?.[field]) || run[field] !== contract.variants?.[run.variant]?.[field]) reasons.push('runtime-' + field);
    for (const field of variantExactFields) {
      const frozen = contract.variants?.[run?.variant]?.[field];
      if (frozen === undefined || frozen === null) continue;
      if (!nonempty(run?.[field]) || run[field] !== frozen) reasons.push('runtime-' + field);
    }
    for (const [field, expected] of [['contractDigest', contract.digest], ['calibrationDigest', calibration?.digest],
      ['initialMaterialsDigest', contract.materials?.[run?.caseId]]]) {
      if (!digestValue(run?.[field]) || run[field] !== expected) reasons.push('runtime-' + field);
    }
    if (!sameValue(run?.budget, contract.budget)) reasons.push('runtime-budget');
    if (run?.snapshotRestored !== true) reasons.push('snapshot-not-restored');
    const receipt = run?.resetReceipt;
    if (!receipt || receipt.version !== 'effect-reset/1' || receipt.ok !== true || receipt.requests !== 0
      || receipt.runId !== run?.runId || receipt.caseId !== run?.caseId || receipt.briefDigest !== run?.materialsDigest
      || receipt.caseSetVersion !== run?.caseSetVersion || !digestValue(receipt.stateDigest)) reasons.push('reset-receipt-invalid');
    if (run?.homeIsolation?.isolated !== true) reasons.push('home-isolation-not-proven');
    // Cross-instance merging may discharge missing peers, never a real local fault.
    const local = run?.comparability?.mismatches;
    if (Array.isArray(local)) reasons.push(...local.filter(reason => reason !== 'frozen-three-group-comparison-not-run'));
    else if (run?.comparability?.comparable === false) reasons.push('local-verdict-unexplained');
    if (reasons.length) {
      reasons.forEach(add);
      issues.push({ runId: run?.runId ?? null, caseId: run?.caseId ?? null, variant: run?.variant ?? null, reasons: [...new Set(reasons)] });
    }
  }
  return { mismatches: [...mismatches], issues };
}

/**
 * 一次运行是否属于"可比实验"由**可核对的事实**决定，不由调用方自报：
 *   · 必须带校准记录，且本次预算不低于该记录推出的下限；
 *   · 三组必须各自有 requiredRepeats 次已收口（durationFinal）运行。
 * 单次 pilot 因此永远是 `frozen-three-group-comparison-not-run` —— 这是设计意图，
 * 不是缺陷：一次运行不构成三组对照。
 */
export function assessMatrixComparability({ calibration, budget, runs = [], variants = MATRIX_VARIANTS, requiredRepeats = 3, expectedCases = null, contract = null } = {}) {
  const mismatches = []
  const floor = calibration?.budget
  if (!calibration || typeof calibration.digest !== 'string' || !calibration.digest.trim() || !floor
    || typeof floor !== 'object') {
    mismatches.push('budget-not-calibrated')
  } else {
    for (const key of ['minutes', 'targetRequests', 'tokens']) {
      if (!Number.isSafeInteger(floor[key]) || floor[key] < 1) mismatches.push('budget-calibration-invalid')
      else if (!Number.isSafeInteger(budget?.[key]) || budget[key] < floor[key]) mismatches.push('budget-below-calibrated-floor')
    }
  }
  if (!Number.isSafeInteger(requiredRepeats) || requiredRepeats < 1) mismatches.push('required-repeats-invalid')
  const completed = runs.filter(run => run?.durationFinal === true)
  const perVariant = Object.fromEntries(variants.map(variant => [variant, completed.filter(run => run.variant === variant).length]))
  // 逐例闸：运行记录一旦带上 caseId（或调用方显式给出 expectedCases），就要求**每一例 × 每一组**
  // 都达到 requiredRepeats —— 这是文档里"每例随机至少三次"的直接落地，而不是"整组凑够次数"。
  // 旧调用（不带 caseId）继续按整组计数，保持既有单例 pilot 语义。
  const caseIds = new Set()
  for (const run of completed) if (typeof run.caseId === 'string' && run.caseId) caseIds.add(run.caseId)
  const requestedCases = expectedCases ?? contract?.cases;
  if (Array.isArray(requestedCases)) for (const id of requestedCases) if (typeof id === 'string' && id) caseIds.add(id)
  if (caseIds.size) {
    const short = []
    for (const caseId of caseIds) for (const variant of variants) {
      const count = completed.filter(run => run.variant === variant && run.caseId === caseId).length
      if (count < requiredRepeats) short.push(`${caseId}:${variant}`)
    }
    if (short.length) mismatches.push('frozen-three-group-comparison-not-run')
  } else if (variants.some(variant => perVariant[variant] < requiredRepeats)) mismatches.push('frozen-three-group-comparison-not-run')
  const coverageComplete = Number.isSafeInteger(requiredRepeats) && requiredRepeats > 0
    && !mismatches.includes('frozen-three-group-comparison-not-run');
  const facts = assessMatrixRunFacts({ calibration, budget, runs, variants, expectedCases, requiredRepeats, contract });
  mismatches.push(...facts.mismatches);
  return { comparable: mismatches.length === 0, mismatches: [...new Set(mismatches)], completed: completed.length,
    perVariant, coverageComplete, assessmentVersion: 2, issues: facts.issues };
}

/**
 * 从三组 pilot 的实际用量推出三组共用的固定预算：取每个维度的最大值加 headroom，
 * 再向上取整到稳定步长。任一维度未知即拒绝 —— 未校准的名义额度不能被当成公平上限。
 */
export function deriveCalibratedBudget({ pilots, headroom = 1.2, steps = { minutes: 5, targetRequests: 10, tokens: 10000 } } = {}) {
  if (!Array.isArray(pilots) || pilots.length < 3) throw new Error('at least three pilot runs are required to calibrate a shared budget');
  for (const [key, value] of Object.entries({ headroom, ...steps })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid ${key}`);
  }
  const measurements = pilots.map(pilot => {
    const id = pilot?.id;
    if (typeof id !== 'string' || !id.trim()) throw new Error('every pilot needs an id');
    const { tokens, targetRequests, elapsedMs } = pilot;
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error(`pilot ${id} token usage is unknown`);
    if (!Number.isSafeInteger(targetRequests) || targetRequests < 0) throw new Error(`pilot ${id} target request count is unknown`);
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error(`pilot ${id} elapsed time is unknown`);
    return { id, tokens, targetRequests, elapsedMs };
  });
  const ceiling = (value, step) => Math.max(step, Math.ceil((value * headroom) / step) * step);
  const maximums = {
    tokens: Math.max(...measurements.map(m => m.tokens)),
    targetRequests: Math.max(...measurements.map(m => m.targetRequests)),
    elapsedMs: Math.max(...measurements.map(m => m.elapsedMs)),
  };
  const budget = {
    minutes: ceiling(maximums.elapsedMs / 60000, steps.minutes),
    targetRequests: ceiling(maximums.targetRequests, steps.targetRequests),
    tokens: ceiling(maximums.tokens, steps.tokens),
  };
  const basis = { headroom, steps, maximums, pilots: measurements };
  return { budget, basis, digest: createHash('sha256').update(JSON.stringify({ budget, basis })).digest('hex') };
}

export function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isStrictlyInside(root, target) {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 校准运行绝不能写进用户的真实 DSH_HOME：会话、projcache、workspace.json 与
 * redteam-results/results.db 全部跟随 DSH_HOME。日常桌面启动器把 DSH_HOME 指向
 * 真实 home，所以基准插件要求运行方显式声明隔离根，否则拒绝开始 —— 失败即停，
 * 不靠"跑完再清理"。
 */
export function assessHomeIsolation({ home, userHome = join(homedir(), '.dsh'), declaredRoot } = {}) {
  const clean = value => (typeof value === 'string' && value.trim() ? resolve(value) : null);
  const actual = clean(home), real = clean(userHome), root = clean(declaredRoot);
  const faults = [];
  if (!actual) faults.push('home-not-declared');
  if (!root) faults.push('isolated-root-not-declared');
  if (actual && real && samePath(actual, real)) faults.push('home-is-real-user-home');
  if (root && real && (samePath(root, real) || isStrictlyInside(root, real))) faults.push('isolated-root-covers-real-home');
  if (actual && root && !isStrictlyInside(root, actual)) faults.push('home-outside-isolated-root');
  return { isolated: faults.length === 0, home: actual, userHome: real, isolatedRoot: root, reasons: faults };
}

// Independent effect and experiment eligibility are separate facts. The raw
// grader result is never rewritten to hide an overrun or a failed experiment.
export function assessRunQualification(run) {
  const reasons = [];
  const budget = run?.budget;
  const validBudget = budget && ['minutes', 'targetRequests', 'tokens']
    .every(key => Number.isSafeInteger(budget[key]) && budget[key] > 0)
    && Number.isSafeInteger(budget.minutes * 60000);
  if (!validBudget) reasons.push('budget-missing-or-invalid');
  const counts = [
    ['tokens', run?.usage?.tokens, budget?.tokens, true],
    ['target-requests', run?.score?.targetRequests, budget?.targetRequests, true],
    ['elapsed', run?.usage?.elapsedMs, validBudget ? budget.minutes * 60000 : undefined, false],
  ];
  for (const [name, value, limit, integer] of counts) {
    if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) reasons.push(name + '-unknown-or-invalid');
    else if (validBudget && value > limit) reasons.push(name + '-budget-exceeded');
  }
  if (run?.comparability?.comparable !== true) reasons.push('runtime-not-comparable');
  if (run?.durationFinal !== true) reasons.push('run-not-final');
  if (run?.cleanupComplete !== true) reasons.push('cleanup-not-complete');
  if (!Array.isArray(run?.isolationFailures) || run.isolationFailures.length) reasons.push('isolation-not-proven');
  if (!Number.isSafeInteger(run?.usage?.humanInterventions) || run.usage.humanInterventions < 0) reasons.push('human-interventions-unknown-or-invalid');
  if (typeof run?.score?.independentSuccess !== 'boolean'
    || !Number.isSafeInteger(run?.score?.falseConfirmed) || run.score.falseConfirmed < 0) reasons.push('score-missing-or-invalid');
  const overBudget = reasons.some(reason => reason.endsWith('-budget-exceeded'));
  const budgetUnknown = reasons.some(reason => reason === 'budget-missing-or-invalid'
    || ['tokens', 'target-requests', 'elapsed'].some(name => reason === name + '-unknown-or-invalid'));
  return { eligible: reasons.length === 0, qualifiedSuccess: reasons.length === 0 && run.score.independentSuccess,
    budgetStatus: overBudget ? 'exceeded' : budgetUnknown ? 'unknown' : 'within', reasons };
}

export function summarizeRuns(runs) {
  const groups = {};
  for (const run of runs) {
    const group = groups[run.variant] ||= { runs: 0, independentSuccess: 0, rawIndependentSuccess: 0,
      qualifiedRuns: 0, disqualifiedRuns: 0, overBudgetRuns: 0, unknownBudgetRuns: 0, disqualificationReasons: {},
      falseConfirmedKnown: 0, falseConfirmedUnknownRuns: 0, requestsKnown: 0, requestsUnknownRuns: 0,
      blockingErrorsKnown: 0, blockingErrorsUnknownRuns: 0, conditionIdentifiedKnown: 0, conditionIdentifiedUnknownRuns: 0,
      correctNegativeKnown: 0, correctNegativeUnknownRuns: 0, incompleteKnown: 0, incompleteUnknownRuns: 0,
      firstValuableMsKnown: 0, firstValuableUnknownRuns: 0,
      tokensKnown: 0, tokensUnknownRuns: 0, elapsedMsKnown: 0, elapsedUnknownRuns: 0,
      humanInterventionsKnown: 0, humanUnknownRuns: 0, incomparableRuns: 0 };
    const qualification = assessRunQualification(run);
    group.runs++; group.rawIndependentSuccess += Number(run.score?.independentSuccess === true);
    group.independentSuccess += Number(qualification.qualifiedSuccess);
    group.qualifiedRuns += Number(qualification.eligible); group.disqualifiedRuns += Number(!qualification.eligible);
    group.overBudgetRuns += Number(qualification.budgetStatus === 'exceeded');
    group.unknownBudgetRuns += Number(qualification.reasons.some(reason => reason === 'budget-missing-or-invalid'
      || ['tokens', 'target-requests', 'elapsed'].some(name => reason === name + '-unknown-or-invalid')));
    for (const reason of qualification.reasons) group.disqualificationReasons[reason] = (group.disqualificationReasons[reason] ?? 0) + 1;
    for (const [key, total, unknown] of [['falseConfirmed', 'falseConfirmedKnown', 'falseConfirmedUnknownRuns'],
      ['targetRequests', 'requestsKnown', 'requestsUnknownRuns'],
      ['blockingErrors', 'blockingErrorsKnown', 'blockingErrorsUnknownRuns'],
      ['conditionIdentified', 'conditionIdentifiedKnown', 'conditionIdentifiedUnknownRuns'],
      ['correctNegative', 'correctNegativeKnown', 'correctNegativeUnknownRuns'],
      ['incomplete', 'incompleteKnown', 'incompleteUnknownRuns']]) {
      const raw = run.score?.[key];
      const value = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw;
      if (Number.isSafeInteger(value) && value >= 0) group[total] += value;
      else group[unknown]++;
    }
    {
      // 首个有价值结果时间只在明确记录时计入；未知不按 0 处理。
      const value = run.usage?.firstValuableMs;
      if (Number.isFinite(value) && value >= 0) group.firstValuableMsKnown += value;
      else group.firstValuableUnknownRuns++;
    }
    for (const [key, total, unknown] of [['tokens', 'tokensKnown', 'tokensUnknownRuns'], ['elapsedMs', 'elapsedMsKnown', 'elapsedUnknownRuns'],
      ['humanInterventions', 'humanInterventionsKnown', 'humanUnknownRuns']]) {
      const value = run.usage?.[key];
      if (Number.isFinite(value) && value >= 0 && (key === 'elapsedMs' || Number.isSafeInteger(value))) group[total] += value;
      else group[unknown]++;
    }
    if (run.comparability?.comparable !== true) group.incomparableRuns++;
  }
  for (const group of Object.values(groups)) {
    group.falseConfirmed = group.falseConfirmedUnknownRuns ? null : group.falseConfirmedKnown;
    group.requests = group.requestsUnknownRuns ? null : group.requestsKnown;
    group.tokensTotal = group.tokensUnknownRuns ? null : group.tokensKnown;
    group.elapsedMsTotal = group.elapsedUnknownRuns ? null : group.elapsedMsKnown;
    group.humanInterventionsTotal = group.humanUnknownRuns ? null : group.humanInterventionsKnown;
    group.blockingErrors = group.blockingErrorsUnknownRuns ? null : group.blockingErrorsKnown;
    group.conditionIdentified = group.conditionIdentifiedUnknownRuns ? null : group.conditionIdentifiedKnown;
    group.correctNegative = group.correctNegativeUnknownRuns ? null : group.correctNegativeKnown;
    group.incomplete = group.incompleteUnknownRuns ? null : group.incompleteKnown;
    group.firstValuableMsAverage = group.firstValuableUnknownRuns ? null : Math.round(group.firstValuableMsKnown / Math.max(1, group.runs - group.firstValuableUnknownRuns));
  }
  return groups;
}

/**
 * 推广门槛（v6 第 10.4 节）：关键操作与恢复无阻塞错误；同预算下可靠结果不低于基线；
 * 阴性不出现新增高影响假确认。任何未知一律视为未达成——不把缺数据当成通过。
 * @param groups summarizeRuns 的返回值
 */
export function assessPromotion(groups, { baselineVariant = 'plain-agent', candidateVariant = 'candidate', requiredRepeats = 3, allowance = { tokens: 0.2, humanInterventions: 0.25 } } = {}) {
  const baseline = groups?.[baselineVariant], candidate = groups?.[candidateVariant];
  if (!baseline || !candidate) return { passed: false, verdict: 'insufficient-data', reasons: ['baseline-or-candidate-missing'], deltas: null };
  const reasons = [];
  if (baseline.qualifiedRuns < requiredRepeats || candidate.qualifiedRuns < requiredRepeats) reasons.push('fewer-than-required-qualified-runs');
  if (candidate.blockingErrors == null) reasons.push('blocking-errors-unknown');
  else if (candidate.blockingErrors > 0) reasons.push('blocking-errors-present');
  if (candidate.falseConfirmed == null || baseline.falseConfirmed == null) reasons.push('false-confirmed-unknown');
  else if (candidate.falseConfirmed > baseline.falseConfirmed) reasons.push('new-high-impact-false-confirmation');
  const baselineRate = baseline.qualifiedRuns ? baseline.independentSuccess / baseline.qualifiedRuns : null;
  const candidateRate = candidate.qualifiedRuns ? candidate.independentSuccess / candidate.qualifiedRuns : null;
  if (baselineRate == null || candidateRate == null) reasons.push('reliable-result-rate-unknown');
  else if (candidateRate < baselineRate) reasons.push('reliable-results-below-baseline');
  const deltas = { reliableRate: candidateRate != null && baselineRate != null ? candidateRate - baselineRate : null,
    falseConfirmed: candidate.falseConfirmed != null && baseline.falseConfirmed != null ? candidate.falseConfirmed - baseline.falseConfirmed : null,
    tokens: candidate.tokensTotal != null && baseline.tokensTotal != null ? candidate.tokensTotal - baseline.tokensTotal : null,
    humanInterventions: candidate.humanInterventionsTotal != null && baseline.humanInterventionsTotal != null ? candidate.humanInterventionsTotal - baseline.humanInterventionsTotal : null };
  const efficiency = { tokensSaved: baseline.tokensTotal != null && candidate.tokensTotal != null && baseline.tokensTotal > 0 ? 1 - candidate.tokensTotal / baseline.tokensTotal : null,
    humanSaved: baseline.humanInterventionsTotal != null && candidate.humanInterventionsTotal != null && baseline.humanInterventionsTotal > 0 ? 1 - candidate.humanInterventionsTotal / baseline.humanInterventionsTotal : null,
    targets: allowance };
  const verdict = reasons.length ? 'not-promoted' : (deltas.reliableRate > 0 ? 'promoted-with-more-reliable-results'
    : (efficiency.tokensSaved != null && efficiency.tokensSaved >= allowance.tokens) || (efficiency.humanSaved != null && efficiency.humanSaved >= allowance.humanInterventions) ? 'promoted-on-efficiency' : 'promoted-without-measured-advantage');
  return { passed: reasons.length === 0, verdict, reasons, deltas, efficiency,
    note: '通过条件是可靠结果不低于基线、阴性无新增高影响假确认、关键操作与恢复无阻塞错误；用量下降是报告项，不替代这些条件。' };
}
