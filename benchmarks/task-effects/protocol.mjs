import { createHash, createHmac } from 'node:crypto';
import { CASES, CASESET_VERSION } from './cases.mjs';

export function makeProtocol({ model, toolDigest, accessDigest, baselineCommit, candidateCommit,
  seed, budget = { minutes: 30, targetRequests: 200, tokens: 150000 }, calibrated = false, includeArtex = false } = {}) {
  for (const [key, value] of Object.entries({ model, toolDigest, accessDigest, baselineCommit, candidateCommit, seed })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`explicit ${key} required`);
  }
  for (const [key, value] of Object.entries(budget)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${key} budget`);
  if (!['minutes', 'targetRequests', 'tokens'].every(key => Object.hasOwn(budget, key))) throw new Error('complete shared budget required');
  const variants = ['plain-agent', 'saker-0.4.92', 'candidate', ...(includeArtex ? ['artex-pinned'] : [])];
  const runs = CASES.flatMap(item => variants.flatMap(variant => Array.from({ length: 3 }, (_, repeat) => ({ caseId: item.id, split: item.split, variant, repeat: repeat + 1 }))));
  const rank = run => createHmac('sha256', seed).update(JSON.stringify(run)).digest('hex');
  runs.sort((a, b) => rank(a).localeCompare(rank(b)));
  const config = { version: CASESET_VERSION, model, toolDigest, accessDigest, baselineCommit, candidateCommit,
    seed, budget, calibrated, variants, runs };
  return { ...config, digest: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}

export function assessComparability(protocol, runtime = {}) {
  const mismatches = ['model', 'toolDigest', 'accessDigest'].filter(key => runtime[key] !== protocol[key]);
  if (JSON.stringify(runtime.budget) !== JSON.stringify(protocol.budget)) mismatches.push('budget');
  if (!protocol.calibrated) mismatches.push('budget-not-calibrated');
  if (!runtime.snapshotRestored) mismatches.push('snapshot-not-restored');
  return { comparable: mismatches.length === 0, mismatches };
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
    for (const [key, total, unknown] of [['falseConfirmed', 'falseConfirmedKnown', 'falseConfirmedUnknownRuns'], ['targetRequests', 'requestsKnown', 'requestsUnknownRuns']]) {
      const value = run.score?.[key];
      if (Number.isSafeInteger(value) && value >= 0) group[total] += value;
      else group[unknown]++;
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
  }
  return groups;
}
