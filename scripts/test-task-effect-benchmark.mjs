import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { CASES, caseById } from '../benchmarks/task-effects/cases.mjs';
import { createEffectLab } from '../benchmarks/task-effects/lab.mjs';
import { gradeAttempt } from '../benchmarks/task-effects/grade.mjs';
import { makeProtocol, assessComparability, assessRunQualification, summarizeRuns, deriveCalibratedBudget, assessMatrixComparability } from '../benchmarks/task-effects/protocol.mjs';
import { resolveComparisonPreset } from '../benchmarks/task-effects/runtime.mjs';

/**
 * 解析回执正文，失败时说清"是哪一步、回执什么状态"。
 * 为什么需要：空正文直接 `JSON.parse` 只会抛 `Unexpected end of JSON input`，
 * 2026-10-11 整轮回归里出现过一次这样的假红，看不出是靶场结论还是本地请求被掐断。
 */
function jsonOf(receipt, label) {
  const text = Buffer.from(receipt?.responseBodyBase64 ?? '', 'base64').toString('utf8');
  if (text.trim() === '') {
    throw new Error(`${label}: 回执没有正文（outcome=${receipt?.outcome ?? 'missing'} status=${receipt?.status ?? 'null'}）`
      + ' —— 这通常是本地回环请求被掐断/超时，不是靶场给出的结论');
  }
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label}: 回执不是 JSON（status=${receipt?.status ?? 'null'}）：${error.message}`); }
}

async function login(lab, role) {
  const spec = caseById(lab.caseId);
  if (!spec.flow) return undefined;
  const { username, password } = lab.brief().accounts[role];
  const receipt = await lab.request({ url: lab.origin + '/session', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return jsonOf(receipt, `login(${role})`).token;
}
async function collect(lab) {
  const spec = caseById(lab.caseId), evidenceIds = [];
  const sessions = {};
  for (const role of ['owner', 'subject']) sessions[role] = await login(lab, role);
  for (let repeat = 0; repeat < 2; repeat++) for (const [role, object] of [['owner','owner'],['subject','subject'],['subject','owner'],['anonymous','owner']]) {
    let ticket;
    if (spec.flow === 'ticket' && role !== 'anonymous') {
      const receipt = await lab.request({ url: lab.origin + '/ticket', method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer ' + sessions[role] }, body: JSON.stringify({ id: lab.controller.objects[object] }) });
      ticket = jsonOf(receipt, `ticket(${role}→${object})`).ticket;
    }
    const receipt = await lab.request(lab.controller.recordRequest(role, object, { session: sessions[role], ticket }));
    evidenceIds.push(receipt.id);
  }
  return evidenceIds;
}
/** 状态变化类别：三份只读对照 + 越权写入（必要时先取变更令牌）+ 所有者复核。 */
async function collectWrite(lab) {
  const spec = caseById(lab.caseId), evidenceIds = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const [role, object] of [['owner','owner'],['subject','subject'],['anonymous','owner']]) {
      evidenceIds.push((await lab.request(lab.controller.recordRequest(role, object))).id);
    }
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    let changeToken;
    if (spec.writeFlow === 'precondition') {
      const receipt = await lab.request(lab.controller.changeRequest('subject', 'owner'));
      changeToken = jsonOf(receipt, 'change-request(subject→owner)').changeToken;
    }
    evidenceIds.push((await lab.request(lab.controller.shareRequest('subject', 'owner', { changeToken }))).id);
  }
  for (let repeat = 0; repeat < 2; repeat++) evidenceIds.push((await lab.request(lab.controller.recordRequest('owner','owner'))).id);
  return evidenceIds;
}
const confirmed = (lab, ids) => ({ outcome: 'confirmed', evidenceIds: ids,
  findings: [{ caseId: lab.caseId, kind: 'private-read', status: 'confirmed', evidenceIds: ids }] });
const confirmedWrite = (lab, ids) => ({ outcome: 'confirmed', evidenceIds: ids,
  findings: [{ caseId: lab.caseId, kind: 'state-change', status: 'confirmed', evidenceIds: ids }] });
/** 文件处理类别：两份身份对照 + 匿名拒绝 + 越界读取，各两轮。 */
async function collectFile(lab) {
  const evidenceIds = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    evidenceIds.push((await lab.request(lab.controller.fileRequest('subject', 'public/notes-subject.txt'))).id);
    evidenceIds.push((await lab.request(lab.controller.fileRequest('owner', 'public/notes-owner.txt'))).id);
    evidenceIds.push((await lab.request(lab.controller.fileRequest('anonymous', 'public/notes-subject.txt'))).id);
    evidenceIds.push((await lab.request(lab.controller.fileRequest('subject', '../private/audit.log'))).id);
  }
  return evidenceIds;
}
const confirmedFile = (lab, ids) => ({ outcome: 'confirmed', evidenceIds: ids,
  findings: [{ caseId: lab.caseId, kind: 'file-read', status: 'confirmed', evidenceIds: ids }] });
/** 输出处理类别：两份良性对照 + 匿名拒绝 + 可执行载荷，各两轮。 */
async function collectEcho(lab) {
  const payload = '<script>document.title="saker-probe"</script>', evidenceIds = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    evidenceIds.push((await lab.request(lab.controller.echoRequest('subject'))).id);
    evidenceIds.push((await lab.request(lab.controller.echoRequest('owner'))).id);
    evidenceIds.push((await lab.request(lab.controller.echoRequest('anonymous'))).id);
    evidenceIds.push((await lab.request(lab.controller.echoRequest('subject', payload))).id);
  }
  return evidenceIds;
}
const confirmedEcho = (lab, ids) => ({ outcome: 'confirmed', evidenceIds: ids,
  findings: [{ caseId: lab.caseId, kind: 'output-handling', status: 'confirmed', evidenceIds: ids }] });
/** 服务端访问类别：两份文档对照 + 匿名拒绝 + 让服务端去取内部资源，各两轮。 */
async function collectFetch(lab) {
  const evidenceIds = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    evidenceIds.push((await lab.request(lab.controller.docsRequest('subject'))).id);
    evidenceIds.push((await lab.request(lab.controller.docsRequest('owner'))).id);
    evidenceIds.push((await lab.request(lab.controller.docsRequest('anonymous'))).id);
    evidenceIds.push((await lab.request(lab.controller.fetchRequest('subject', `${lab.controller.internalOrigin()}/internal/audit.log`))).id);
  }
  return evidenceIds;
}
const confirmedFetch = (lab, ids) => ({ outcome: 'confirmed', evidenceIds: ids,
  findings: [{ caseId: lab.caseId, kind: 'server-access', status: 'confirmed', evidenceIds: ids }] });
let failed = 0;
async function test(label, fn) { try { await fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }

await test('frozen cases contain 8 single positives, 6 identity chains, 7 negatives, 4 faults, 4 applicability, 4 state-change, 2 file-handling, 2 output-handling, 2 server-access and 23 holdouts', () => {
  const calibration = CASES.filter(c => c.split === 'calibration');
  assert.equal(calibration.length, 39);
  for (const [category, count] of [['single-positive',8],['multi-positive',6],['negative',7],['fault',4],['applicability',4],['state-change',4],['file-handling',2],['output-handling',2],['server-access',2]]) assert.equal(calibration.filter(c=>c.category===category).length,count);
  assert.equal(CASES.filter(c=>c.split==='holdout').length,23); assert.equal(new Set(CASES.map(c=>c.id)).size,62);
});
await test('all 62 local cases produce independent outcomes from actual HTTP and fault captures', async () => {
  for (const spec of CASES) {
    // 保留集必须显式声明分区：这条用例是唯一会遍历全部 62 例的地方。
    const lab = await createEffectLab(spec.id, { split: spec.split });
    try {
      let submission;
      if (spec.category === 'server-access') {
        const ids = await collectFetch(lab);
        submission = spec.vulnerable ? confirmedFetch(lab, ids) : { outcome:'no-finding',evidenceIds:ids,findings:[] };
      } else if (spec.category === 'output-handling') {
        const ids = await collectEcho(lab);
        submission = spec.vulnerable ? confirmedEcho(lab, ids) : { outcome:'no-finding',evidenceIds:ids,findings:[] };
      } else if (spec.category === 'file-handling') {
        const ids = await collectFile(lab);
        submission = spec.vulnerable ? confirmedFile(lab, ids) : { outcome:'no-finding',evidenceIds:ids,findings:[] };
      } else if (spec.category === 'state-change') {
        const ids = await collectWrite(lab);
        submission = spec.vulnerable ? confirmedWrite(lab, ids) : { outcome:'no-finding',evidenceIds:ids,findings:[] };
      } else if (spec.category === 'applicability') {
        const receipts = [];
        for (let repeat = 0; repeat < 2; repeat++) receipts.push((await lab.request(lab.controller.metadataRequest())).id);
        const outcome = spec.applicability === 'applicable' ? 'confirmed'
          : spec.applicability === 'not-applicable' ? 'no-finding' : 'inconclusive';
        submission = { outcome, evidenceIds: receipts, findings: outcome === 'confirmed'
          ? [{ caseId: spec.id, kind: 'applicability', status: 'confirmed', evidenceIds: receipts }] : [] };
      } else if (spec.fault || ['expired','version-unknown'].includes(spec.behavior)) {
        const receipt = await lab.request(spec.behavior === 'version-unknown' ? { url: lab.origin + '/metadata' } : lab.controller.recordRequest('subject','subject'));
        submission = { outcome: 'inconclusive', evidenceIds: [receipt.id], findings: [] };
        if (['disconnect','unavailable','timeout'].includes(spec.fault)) assert.notEqual(receipt.outcome,'response',spec.id);
      } else {
        const ids = await collect(lab);
        submission = spec.vulnerable ? confirmed(lab,ids) : { outcome:'no-finding',evidenceIds:ids,findings:[] };
      }
      const score = lab.grade(submission);
      assert.equal(score.independentSuccess,true,spec.id+': '+JSON.stringify(score)); assert.equal(score.falseConfirmed,0,spec.id);
      assert.equal(lab.origin.startsWith('http://127.0.0.1:'),true);
      assert(!JSON.stringify(lab.brief()).includes(lab.controller.markers.owner),'private proof must not be in the initial brief');
    } finally { await lab.close(); }
  }
});
await test('agent completion text, 200 error pages and reflected private markers cannot pass confirmation', async () => {
  for (const id of ['p1','n2','n3','n6']) {
    const lab=await createEffectLab(id);
    try {
      assert.equal(lab.grade({outcome:'confirmed',findings:[{status:'confirmed',summary:'Verified by agent'}]}).falseConfirmed,1);
      const ids=await collect(lab);
      if(id==='n3') {
        const request=lab.controller.recordRequest('subject','owner'); request.url+='&secret='+lab.controller.markers.owner;
        for(let i=0;i<2;i++)ids.push((await lab.request(request)).id);
      }
      if(id!=='p1') {const score=lab.grade(confirmed(lab,ids)); assert.equal(score.independentSuccess,false);assert.equal(score.falseConfirmed,1);}
      // p1：v6 第 10.1 节下"一次有效观察"就够，但缺必要对照（这里去掉匿名拒绝）仍不能确认。
      else {const score=lab.grade(confirmed(lab,[ids[1],ids[2]]));assert.equal(score.independentSuccess,false);assert.equal(score.falseConfirmed,1);}
    } finally {await lab.close();}
  }
});
await test('repeated receipt ids, foreign reset evidence and changed response bytes are rejected', async () => {
  const lab=await createEffectLab('p1'), reset=await createEffectLab('p1');
  try {
    const ids=await collect(lab); assert(lab.grade(confirmed(lab,ids)).independentSuccess);
    assert.equal(lab.grade(confirmed(lab,[...ids.slice(0,4),...ids.slice(0,4)])).independentSuccess,false);
    assert.equal(reset.grade(confirmed(reset,ids)).independentSuccess,false);
    const rows=lab.audit(); rows[0].responseBodyBase64=Buffer.from('forged effect').toString('base64');
    const authority={spec:caseById('p1'),runId:lab.runId,rows,markers:lab.controller.markers};
    assert.equal(gradeAttempt(authority,confirmed(lab,ids)).evidenceValid,false);
    assert(lab.grade(confirmed(lab,ids)).independentSuccess,'audit read must not mutate live truth');
    assert.equal(lab.grade({...confirmed(lab,ids),findings:[{...confirmed(lab,ids).findings[0],caseId:'p2'}]}).falseConfirmed,1);
  } finally {await lab.close();await reset.close();}
});
await test('loopback adapter refuses out-of-scope URLs and enforces a shared request cap before execution', async () => {
  const lab=await createEffectLab('p1',{maxRequests:8});
  try {
    await assert.rejects(lab.request({url:'https://example.invalid/'}),/outside/); assert.equal(lab.audit().length,0);
    await collect(lab);assert.equal(lab.audit().length,8);
    await assert.rejects(lab.request(lab.controller.recordRequest('subject','owner')),/budget/);assert.equal(lab.audit().length,8);
  } finally {await lab.close();}
});
await test('multi-step flows cannot use static identity or skip export-ticket preconditions', async () => {
  const lab=await createEffectLab('m5');
  try {
    assert.equal((await lab.request(lab.controller.recordRequest('subject','subject'))).status,403);
    const session=await login(lab,'subject');
    assert.equal((await lab.request(lab.controller.recordRequest('subject','subject',{session}))).status,409);
    const ids=await collect(lab);assert(lab.grade(confirmed(lab,ids)).independentSuccess);
  } finally {await lab.close();}
});
await test('timeout is an actual timed-out client request and never an invented successful receipt', async () => {
  const lab=await createEffectLab('f4');
  try {
    const start=performance.now(), receipt=await lab.request(lab.controller.recordRequest('subject','subject'));
    assert.equal(receipt.outcome,'timeout');assert.equal(receipt.status,null);assert(performance.now()-start>=900);
    assert.equal(lab.grade(confirmed(lab,[receipt.id])).falseConfirmed,1);
  } finally {await lab.close();}
});
await test('comparison protocol pins three groups and randomizes three repeats reproducibly; unknown use stays unknown', () => {
  const input={model:'fixture-model-version',toolDigest:'tools-sha',accessDigest:'access-sha',baselineCommit:'frozen-0.4.92',candidateCommit:'candidate',seed:'fixture-seed'};
  const protocol=makeProtocol(input);assert.equal(protocol.runs.length,558);assert.deepEqual(makeProtocol(input),protocol);
  assert.notDeepEqual(makeProtocol({...input,seed:'other-seed'}).runs,protocol.runs);
  for(const id of CASES.map(c=>c.id))for(const variant of protocol.variants)assert.equal(protocol.runs.filter(r=>r.caseId===id&&r.variant===variant).length,3);
  const runtime={model:protocol.model,toolDigest:protocol.toolDigest,accessDigest:protocol.accessDigest,budget:protocol.budget,snapshotRestored:true};
  assert.equal(assessComparability(protocol,runtime).comparable,false,'uncalibrated ceiling is not a fair frozen budget');
  const pilots=[{id:'pilot-candidate',tokens:168715,targetRequests:24,elapsedMs:36316},
    {id:'pilot-plain-agent',tokens:176416,targetRequests:35,elapsedMs:51314},
    {id:'pilot-saker-0.4.92',tokens:171521,targetRequests:16,elapsedMs:31400}];
  const calibration=deriveCalibratedBudget({pilots});
  assert.deepEqual(calibration.budget,{minutes:5,targetRequests:50,tokens:220000},'the nominal 150k ceiling is below every recorded pilot');
  assert.deepEqual(deriveCalibratedBudget({pilots}),calibration,'calibration is reproducible from the same evidence');
  assert.throws(()=>deriveCalibratedBudget({pilots:pilots.slice(0,2)}),/three pilot runs/);
  assert.throws(()=>deriveCalibratedBudget({pilots:[...pilots.slice(0,2),{id:'pilot-unknown',tokens:null,targetRequests:1,elapsedMs:1}]}),/token usage is unknown/);
  assert.throws(()=>deriveCalibratedBudget({pilots:[...pilots.slice(0,2),{id:'pilot-unknown',tokens:1,targetRequests:null,elapsedMs:1}]}),/target request count is unknown/);
  assert.throws(()=>makeProtocol({...input,calibrated:true}),/calibration evidence/);
  assert.throws(()=>makeProtocol({...input,calibrated:true,calibration,budget:{...calibration.budget,tokens:calibration.budget.tokens-1}}),/below the calibrated floor/);
  const calibrated=makeProtocol({...input,calibrated:true,calibration,budget:calibration.budget});
  const calibratedRuntime={...runtime,budget:calibration.budget};
  assert(assessComparability(calibrated,calibratedRuntime).comparable);
  assert(assessComparability(calibrated,runtime).mismatches.includes('budget'),'the nominal budget must not pass as the calibrated one');
  assert(assessComparability({...calibrated,calibration:null},calibratedRuntime).mismatches.includes('budget-calibration-missing'));
  assert(!assessComparability(calibrated,{...calibratedRuntime,model:'different-model'}).comparable);
  const score={independentSuccess:false,falseConfirmed:1,targetRequests:5};
  const summary=summarizeRuns([{variant:'candidate',score,usage:{tokens:null,elapsedMs:100,humanInterventions:null},comparability:{comparable:false}}]);
  assert.equal(summary.candidate.tokensUnknownRuns,1);assert.equal(summary.candidate.tokensTotal,null);
  assert.equal(summary.candidate.humanUnknownRuns,1);assert.equal(summary.candidate.humanInterventionsTotal,null);assert.equal(summary.candidate.incomparableRuns,1);
});
await test('qualified success excludes overruns, unknown budgets, incomplete runs and incomparable results without erasing raw scores', () => {
  const base = { variant: 'candidate', score: { independentSuccess: true, falseConfirmed: 0, targetRequests: 2 },
    budget: { minutes: 1, targetRequests: 2, tokens: 10 }, usage: { tokens: 10, elapsedMs: 60000, humanInterventions: 0 },
    comparability: { comparable: true }, durationFinal: true, cleanupComplete: true, isolationFailures: [] };
  assert.equal(assessRunQualification(base).qualifiedSuccess, true, 'equal to the ceiling remains within budget');
  const mutations = [
    ['tokens-budget-exceeded', r => { r.usage.tokens = 11; }],
    ['target-requests-budget-exceeded', r => { r.score.targetRequests = 3; }],
    ['elapsed-budget-exceeded', r => { r.usage.elapsedMs = 60000.01; }],
    ['tokens-unknown-or-invalid', r => { r.usage.tokens = null; }],
    ['tokens-unknown-or-invalid', r => { r.usage.tokens = 1.5; }],
    ['tokens-unknown-or-invalid', r => { r.usage.tokens = Number.MAX_SAFE_INTEGER + 1; }],
    ['target-requests-unknown-or-invalid', r => { delete r.score.targetRequests; }],
    ['elapsed-unknown-or-invalid', r => { r.usage.elapsedMs = NaN; }],
    ['budget-missing-or-invalid', r => { delete r.budget; }],
    ['budget-missing-or-invalid', r => { r.budget.minutes = Number.MAX_SAFE_INTEGER; }],
    ['runtime-not-comparable', r => { r.comparability.comparable = false; }],
    ['run-not-final', r => { r.durationFinal = false; }],
    ['cleanup-not-complete', r => { r.cleanupComplete = false; }],
    ['isolation-not-proven', r => { r.isolationFailures = ['late tool exposed']; }],
    ['isolation-not-proven', r => { delete r.isolationFailures; }],
    ['human-interventions-unknown-or-invalid', r => { r.usage.humanInterventions = null; }],
    ['score-missing-or-invalid', r => { r.score.falseConfirmed = null; }],
  ];
  const disqualified = mutations.map(([reason, mutate]) => {
    const run = structuredClone(base); mutate(run);
    // A previously saved/stale qualification cannot override current facts.
    run.qualification = { eligible: true, qualifiedSuccess: true };
    const result = assessRunQualification(run);
    assert.equal(result.qualifiedSuccess, false, reason); assert(result.reasons.includes(reason));
    return run;
  });
  const negative = structuredClone(base); negative.score = { ...negative.score, independentSuccess: false, falseConfirmed: 1 };
  assert(assessRunQualification(negative).eligible, 'a completed negative or failed case is part of the experiment');
  const before = structuredClone(disqualified);
  const summary = summarizeRuns([base, ...disqualified, negative]).candidate;
  assert.equal(summary.independentSuccess, 1, 'only budget-compliant comparable completed success qualifies');
  assert.equal(summary.rawIndependentSuccess, 18); assert.equal(summary.qualifiedRuns, 2);
  assert.equal(summary.disqualifiedRuns, 17); assert.equal(summary.overBudgetRuns, 3);
  assert.equal(summary.falseConfirmedKnown, 1); assert.equal(summary.falseConfirmed, null, 'a missing failure count must not become zero');
  assert.equal(summary.requests, null); assert.equal(summary.tokensTotal, null);
  assert.equal(summary.disqualificationReasons['runtime-not-comparable'], 1);
  assert.deepEqual(disqualified, before, 'raw run facts are retained');
});

await test('matrix comparability needs a recorded calibration and every group repeated', () => {
  const calibration = deriveCalibratedBudget({ pilots: [
    { id: 'a', tokens: 121808, targetRequests: 18, elapsedMs: 33545 },
    { id: 'b', tokens: 70487, targetRequests: 22, elapsedMs: 24186 },
    { id: 'c', tokens: 175350, targetRequests: 22, elapsedMs: 32177 }] });
  const budget = calibration.budget;
  const variants = ['plain-agent', 'saker-0.4.92', 'candidate'];
  const repeat = variant => Array.from({ length: 3 }, () => ({ variant, durationFinal: true }));
  const everyGroup = variants.flatMap(repeat);
  const pilot = assessMatrixComparability({ calibration, budget, runs: variants.map(variant => ({ variant, durationFinal: true })), requiredRepeats: 3 });
  assert.equal(pilot.comparable, false, 'one run per group is a pilot, not a comparison');
  assert(pilot.mismatches.includes('frozen-three-group-comparison-not-run'));
  assert.deepEqual(pilot.perVariant, { 'plain-agent': 1, 'saker-0.4.92': 1, candidate: 1 });
  const uncalibrated = assessMatrixComparability({ calibration: null, budget, runs: everyGroup, requiredRepeats: 3 });
  assert.equal(uncalibrated.comparable, false);
  assert(uncalibrated.mismatches.includes('budget-not-calibrated'));
  assert(assessMatrixComparability({ calibration: { budget, digest: '   ' }, budget, runs: everyGroup, requiredRepeats: 3 })
    .mismatches.includes('budget-not-calibrated'), 'a blank digest is not a calibration record');
  assert(assessMatrixComparability({ calibration, budget: { ...budget, tokens: budget.tokens - 1 }, runs: everyGroup, requiredRepeats: 3 })
    .mismatches.includes('budget-below-calibrated-floor'));
  assert(assessMatrixComparability({ calibration: { budget: { ...budget, minutes: 0 }, digest: 'x' }, budget, runs: everyGroup, requiredRepeats: 3 })
    .mismatches.includes('budget-calibration-invalid'));
  const full = assessMatrixComparability({ calibration, budget, runs: everyGroup, requiredRepeats: 3 });
  assert.equal(full.coverageComplete, true, JSON.stringify(full));
  assert.equal(full.comparable, false, 'counts alone do not prove the configuration or source');
  assert.deepEqual(full.mismatches, ['matrix-contract-missing']);
  assert.equal(full.completed, 9);
  const missingGroup = assessMatrixComparability({ calibration, budget, runs: [...variants.slice(0, 2).flatMap(repeat)], requiredRepeats: 3 });
  assert.equal(missingGroup.comparable, false);
  assert.equal(missingGroup.perVariant.candidate, 0);
  assert.equal(assessMatrixComparability({ calibration, budget, runs: [...everyGroup, { variant: 'candidate', durationFinal: false }], requiredRepeats: 3 }).completed, 9,
    'a run that never finalised its duration must not count');
  assert(assessMatrixComparability({ calibration, budget, runs: everyGroup, requiredRepeats: 0 }).mismatches.includes('required-repeats-invalid'));
});

await test('matrix comparability requires every case, not just every group, to repeat', () => {
  const calibration = deriveCalibratedBudget({ pilots: [
    { id: 'a', tokens: 121808, targetRequests: 18, elapsedMs: 33545 },
    { id: 'b', tokens: 70487, targetRequests: 22, elapsedMs: 24186 },
    { id: 'c', tokens: 175350, targetRequests: 22, elapsedMs: 32177 }] });
  const budget = calibration.budget;
  const variants = ['plain-agent', 'saker-0.4.92', 'candidate'];
  const cases = ['p1', 'p2'];
  const cell = (caseId, variant) => Array.from({ length: 3 }, () => ({ caseId, variant, durationFinal: true }));
  const everyCell = cases.flatMap(caseId => variants.flatMap(variant => cell(caseId, variant)));
  const full = assessMatrixComparability({ calibration, budget, runs: everyCell, requiredRepeats: 3, expectedCases: cases });
  assert.equal(full.coverageComplete, true, JSON.stringify(full));
  assert.equal(full.comparable, false, 'coverage is not a verified comparison');
  // 只把 p1 跑满三组 × 三次、p2 一次没跑：整组计数看起来够（3/3/3），但逐例闸必须拒绝。
  const p1Only = assessMatrixComparability({ calibration, budget,
    runs: variants.flatMap(variant => cell('p1', variant)), requiredRepeats: 3, expectedCases: cases });
  assert.equal(p1Only.comparable, false, 'one repeated case must not stand in for the whole case set');
  assert.equal(p1Only.coverageComplete, false, 'missing p2 must fail even before configuration verification');
  assert(p1Only.mismatches.includes('frozen-three-group-comparison-not-run'));
  // 一个用例只在两组里跑够、第三组只跑两次：也必须拒绝。
  const shortCell = everyCell
    .filter(row => !(row.caseId === 'p2' && row.variant === 'candidate'))
    .concat([
      { caseId: 'p2', variant: 'candidate', durationFinal: true },
      { caseId: 'p2', variant: 'candidate', durationFinal: true },
    ]);
  const shortVerdict = assessMatrixComparability({ calibration, budget, runs: shortCell, requiredRepeats: 3, expectedCases: cases });
  assert.equal(shortVerdict.comparable, false, 'a case short in any single group must fail');
  assert.equal(shortVerdict.coverageComplete, false);
  // Legacy counts remain readable, but cannot certify an experiment.
  const legacy = assessMatrixComparability({ calibration, budget,
    runs: variants.flatMap(variant => Array.from({ length: 3 }, () => ({ variant, durationFinal: true }))), requiredRepeats: 3 });
  assert.equal(legacy.coverageComplete, true);
  assert.equal(legacy.comparable, false);
});

await test('the brief states the citation contract and a missing required control still fails', async () => {
  const lab = await createEffectLab('p1');
  try {
    assert.equal(lab.version, 'task-effects/v10', 'changing the brief must bump the case-set version');
    const { instructions } = lab.brief();
    // v6 第 10.1 节：稳定事实一次有效观察即纳入；对象/角色权限仍要三类对照，但不再要求重复两轮。
    for (const needle of ['四类对照', '一次有效观察就够', '不必重复两轮', '①', '②', '③', '④', '一次给全']) {
      assert(instructions.includes(needle), `the brief must state the contract: missing ${needle}`);
    }
    const ids = await collect(lab);
    const onePerControl = [ids[0], ids[1], ids[2], ids[3]];
    const partial = lab.grade(confirmed(lab, onePerControl));
    assert.equal(partial.independentSuccess, true, 'stable facts need one valid observation, not a fixed repeat count');
    assert.equal(partial.falseConfirmed, 0);
    assert.equal(partial.effectVerified, true);
    // 缺任一必要对照仍然不成立。
    const missingControl = lab.grade(confirmed(lab, [ids[1], ids[2]]));
    assert.equal(missingControl.independentSuccess, false, 'a missing identity control must still fail');
    assert.equal(missingControl.falseConfirmed, 1);
    const full = lab.grade(confirmed(lab, ids));
    assert.equal(full.independentSuccess, true, 'repeating the same stable observation must stay valid');
    assert.equal(full.effectVerified, true);
    assert.equal(full.controlsVerified, true);
  } finally { await lab.close(); }
});

await test('applicability cases grade match, mismatch, unknown version and missing identity without guessing', async () => {
  const claim = (caseId, receipts) => ({ outcome: 'confirmed', evidenceIds: receipts,
    findings: [{ caseId, kind: 'applicability', status: 'confirmed', evidenceIds: receipts }] });
  const twice = async lab => { const ids = [];
    for (let repeat = 0; repeat < 2; repeat++) ids.push((await lab.request(lab.controller.metadataRequest())).id);
    return ids; };

  const match = await createEffectLab('a1');
  try {
    assert.equal(match.claimKind, 'applicability', 'the applicability category submits an applicability claim');
    const { instructions, advisory } = match.brief();
    for (const needle of ['至少一条', 'X-Benchmark-Receipt', '不可确认']) {
      assert(instructions.includes(needle), `applicability citation contract missing ${needle}`);
    }
    assert.equal(advisory.product, 'Local Documents');
    assert(advisory.affectedVersions.includes('fixture-v1.4') && !advisory.affectedVersions.includes('fixture-v2.1'));
    const receipts = await twice(match);
    assert.equal(match.grade(claim('a1', receipts)).independentSuccess, true);
    // v6 第 10.1 节：稳定事实一次有效观察即纳入，重复不再强制。
    assert.equal(match.grade(claim('a1', [receipts[0]])).independentSuccess, true,
      'one matching metadata receipt is enough for a stable applicability fact');
    assert.equal(match.grade(claim('a1', [])).falseConfirmed, 1,
      'a claim without any receipt must still be unsupported');
    assert.equal(match.grade({ outcome: 'no-finding', evidenceIds: receipts, findings: [] }).independentSuccess, false,
      'a matching product/version must not be reported as not applicable');
    const wrongKind = match.grade({ outcome: 'confirmed', evidenceIds: receipts,
      findings: [{ caseId: 'a1', kind: 'private-read', status: 'confirmed', evidenceIds: receipts }] });
    assert.equal(wrongKind.falseConfirmed, 1, 'the claim kind must match the case category');
  } finally { await match.close(); }

  const mismatch = await createEffectLab('a2');
  try {
    const receipts = await twice(mismatch);
    const guess = mismatch.grade(claim('a2', receipts));
    assert.equal(guess.independentSuccess, false, 'an unaffected version must not be confirmed as applicable');
    assert.equal(guess.falseConfirmed, 1);
    assert.equal(mismatch.grade({ outcome: 'no-finding', evidenceIds: receipts, findings: [] }).independentSuccess, true);
  } finally { await mismatch.close(); }

  const unknown = await createEffectLab('a3');
  try {
    const receipts = await twice(unknown);
    assert.equal(unknown.grade({ outcome: 'inconclusive', evidenceIds: receipts, findings: [] }).independentSuccess, true);
    assert.equal(unknown.grade(claim('a3', receipts)).falseConfirmed, 1, 'an unknown version must not be confirmed');
    assert.equal(unknown.grade({ outcome: 'no-finding', evidenceIds: receipts, findings: [] }).independentSuccess, false,
      'an unknown version is not the same as not applicable');
  } finally { await unknown.close(); }

  const blocked = await createEffectLab('a4');
  try {
    assert.deepEqual(blocked.brief().accounts, {}, 'the missing-identity case must not hand out usable credentials');
    const receipts = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const receipt = await blocked.request(blocked.controller.metadataRequest());
      assert.equal(receipt.status, 401, 'metadata must refuse an anonymous reader in the missing-identity case');
      receipts.push(receipt.id);
    }
    assert.equal(blocked.grade({ outcome: 'inconclusive', evidenceIds: receipts, findings: [] }).independentSuccess, true);
    assert.equal(blocked.grade({ outcome: 'no-finding', evidenceIds: receipts, findings: [] }).independentSuccess, false,
      'a blocked metadata read is not a not-applicable finding');
  } finally { await blocked.close(); }
});

await test('state-change cases require a real owner-visible mutation, not just a 200 response', async () => {
  const direct = await createEffectLab('w1');
  try {
    assert.equal(direct.claimKind, 'state-change');
    const { instructions, flow } = direct.brief();
    assert.equal(flow, 'direct');
    for (const needle of ['前提成立', '③', '一次有效观察就够', '写入被拒']) {
      assert(instructions.includes(needle), `state-change contract missing ${needle}`);
    }
    const ids = await collectWrite(direct);
    assert.equal(direct.grade(confirmedWrite(direct, ids)).independentSuccess, true);
    assert.deepEqual(direct.controller.readShareState().owner, ['owner','subject'],
      'the lab really changed the owner object instead of only answering 200');
    // 只看写入响应、不做所有者复核：不成立。
    const byOperation = operation => ids.filter(id => direct.audit().find(row => row.id === id)?.operation === operation);
    const writeOnly = direct.grade(confirmedWrite(direct, byOperation('mutate')));
    assert.equal(writeOnly.independentSuccess, false, 'a write response alone is not a state change');
    assert.equal(writeOnly.falseConfirmed, 1);
    // v6 第 10.1 节：稳定事实一次有效观察即纳入 —— 前提 + 写入 + 所有者复核各一条即可。
    // ids[1] 是"当前身份读自己的对象"（normal 对照），ids[6] 是越权写入，ids[8] 是所有者复核。
    assert.equal(direct.grade(confirmedWrite(direct, [ids[1], ids[6], ids[8]])).independentSuccess, true,
      'one valid observation per required class must be enough for a stable fact');
  } finally { await direct.close(); }

  const hardened = await createEffectLab('w2');
  try {
    const ids = await collectWrite(hardened);
    const guess = hardened.grade(confirmedWrite(hardened, ids));
    assert.equal(guess.independentSuccess, false, 'a refused write must not be confirmed');
    assert.equal(guess.falseConfirmed, 1);
    assert.equal(hardened.grade({ outcome: 'no-finding', evidenceIds: ids, findings: [] }).independentSuccess, true);
    assert.deepEqual(hardened.controller.readShareState().owner, ['owner'], 'the hardened lab must not change the owner object');
  } finally { await hardened.close(); }

  const precondition = await createEffectLab('w3');
  try {
    assert.equal(precondition.brief().flow, 'precondition');
    const skipped = await precondition.request(precondition.controller.shareRequest('subject', 'owner'));
    assert.equal(skipped.status, 403, 'the multi-step precondition is enforced even in the vulnerable variant');
    const ids = await collectWrite(precondition);
    assert.equal(precondition.grade(confirmedWrite(precondition, ids)).independentSuccess, true,
      'a token granted for the requested object still lets the flawed lab be written');
  } finally { await precondition.close(); }

  const boundToken = await createEffectLab('w4');
  try {
    const receipt = await boundToken.request(boundToken.controller.changeRequest('subject', 'owner'));
    const changeToken = jsonOf(receipt, 'change-request(subject→owner)').changeToken;
    const refused = await boundToken.request(boundToken.controller.shareRequest('subject', 'owner', { changeToken }));
    assert.equal(refused.status, 403, 'a token granted for the caller own object must not change someone else object');
    const ids = await collectWrite(boundToken);
    assert.equal(boundToken.grade({ outcome: 'no-finding', evidenceIds: ids, findings: [] }).independentSuccess, true);
  } finally { await boundToken.close(); }
});

await test('file-handling cases need out-of-root content, not a 404 or a misspelled path', async () => {
  const flawed = await createEffectLab('t1');
  try {
    assert.equal(flawed.claimKind, 'file-read');
    const { instructions } = flawed.brief();
    for (const needle of ['正常路径读取', '越界路径', '不必凑账号对照', '一次有效观察就够', '403/404']) {
      assert(instructions.includes(needle), `file-handling contract missing ${needle}`);
    }
    const ids = await collectFile(flawed);
    assert.equal(flawed.grade(confirmedFile(flawed, ids)).independentSuccess, true);
    const escapeRows = flawed.audit().filter(row => row.escapeTarget === true);
    assert.equal(escapeRows.length, 2, 'the traversal must actually target a real out-of-root file');
    for (const row of escapeRows) {
      assert.equal(row.status, 200);
      assert.equal(row.actualMarker, flawed.controller.markers.owner, 'the out-of-root body must be the owner content');
    }
    const escapeOnly = flawed.grade(confirmedFile(flawed, escapeRows.map(row => row.id)));
    assert.equal(escapeOnly.independentSuccess, false, 'the traversal alone is not the declared contract');
    assert.equal(escapeOnly.falseConfirmed, 1);
    // v6 第 9.1/10.1 节：正常路径 + 越界读取各一条即可；身份不影响该机制。
    assert.equal(flawed.grade(confirmedFile(flawed, [ids[0], ids[3]])).independentSuccess, true,
      'normal path plus one out-of-root read must be enough');
  } finally { await flawed.close(); }

  const hardened = await createEffectLab('t2');
  try {
    const ids = await collectFile(hardened);
    const guess = hardened.grade(confirmedFile(hardened, ids));
    assert.equal(guess.independentSuccess, false, 'a refused traversal must not be confirmed');
    assert.equal(guess.falseConfirmed, 1);
    assert.equal(hardened.grade({ outcome: 'no-finding', evidenceIds: ids, findings: [] }).independentSuccess, true);
    // 打错文件名得到的 404 不算"越界被拒"的证据。
    const wrongName = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      wrongName.push((await hardened.request(hardened.controller.fileRequest('subject', 'public/notes-subject.txt'))).id);
      wrongName.push((await hardened.request(hardened.controller.fileRequest('owner', 'public/notes-owner.txt'))).id);
      wrongName.push((await hardened.request(hardened.controller.fileRequest('anonymous', 'public/notes-subject.txt'))).id);
      wrongName.push((await hardened.request(hardened.controller.fileRequest('subject', '../private/nope.txt'))).id);
    }
    assert.equal(hardened.grade({ outcome: 'no-finding', evidenceIds: wrongName, findings: [] }).independentSuccess, false,
      'a 404 for a misspelled path is not evidence that the traversal was refused');
  } finally { await hardened.close(); }
});

await test('output-handling cases need raw executable output, not a benign echo', async () => {
  const probe = '<script>document.title="saker-probe"</script>';
  const flawed = await createEffectLab('u1');
  try {
    assert.equal(flawed.claimKind, 'output-handling');
    const { instructions } = flawed.brief();
    for (const needle of ['可执行载荷', '原样输出', '一次有效观察就够', '被转义']) {
      assert(instructions.includes(needle), `output-handling contract missing ${needle}`);
    }
    const ids = await collectEcho(flawed);
    assert.equal(flawed.grade(confirmedEcho(flawed, ids)).independentSuccess, true);
    const echoRows = flawed.audit().filter(row => row.executablePayload === true);
    assert.equal(echoRows.length, 2, 'the executable payload must be submitted twice');
    for (const row of echoRows) { assert.equal(row.status, 200); assert.equal(row.outputEscaped, false); }
    // 良性回显不算证据：只交良性 + 匿名拒绝
    assert.equal(flawed.grade(confirmedEcho(flawed, [ids[0], ids[1], ids[2], ids[4], ids[5], ids[6]])).independentSuccess, false,
      'a benign echo is not evidence that the page outputs raw executable markup');
    // v6 第 9.1/10.1 节：载荷在当前 origin 原样落地一条即可；阴性来源（转义/被拒）由载荷回执本身区分。
    assert.equal(flawed.grade(confirmedEcho(flawed, [ids[3]])).independentSuccess, true,
      'one raw executable payload at the current origin must be enough');
  } finally { await flawed.close(); }

  const hardened = await createEffectLab('u2');
  try {
    const ids = await collectEcho(hardened);
    const guess = hardened.grade(confirmedEcho(hardened, ids));
    assert.equal(guess.independentSuccess, false, 'an escaped payload must not be confirmed');
    assert.equal(guess.falseConfirmed, 1);
    assert.equal(hardened.grade({ outcome: 'no-finding', evidenceIds: ids, findings: [] }).independentSuccess, true);
  } finally { await hardened.close(); }

  // 真浏览器那一半拆到 `test-effect-browser-output.mjs`：本文件会被
  // `revcheck-effect-qualification.mjs` 复制到临时目录里跑 5 遍，把 Chrome 启动放进来
  // 会让反向检查变成 5×2 次浏览器启动（而且复制后的相对路径会解析到不存在的临时根）。
});

await test('cache collision looks like a leak but returns the caller own cached representation', async () => {
  const lab = await createEffectLab('n7');
  try {
    assert(lab.brief().question.includes('共享缓存'), 'the read brief must name the shared-cache false positive');
    const ids = await collect(lab);
    const probes = lab.audit().filter(row => row.operation === 'record' && row.identity === 'subject' && row.object === 'owner');
    assert.equal(probes.length, 2);
    for (const row of probes) {
      assert.equal(row.status, 200);
      assert.equal(row.cacheServed, 'shared-key-collision');
      assert.equal(row.actualMarker, lab.controller.markers.subject, 'the cached body is the caller own representation');
      assert.equal(row.readers.includes('subject'), false, 'the owner object still does not list the caller as a reader');
      const body = JSON.parse(Buffer.from(row.responseBodyBase64, 'base64'));
      assert.equal(body.id, lab.controller.objects.owner, 'the body even names the owner object');
      assert.equal(body.secret, lab.controller.markers.subject);
      assert.notEqual(body.secret, lab.controller.markers.owner, 'no owner byte may appear in the cached body');
    }
    // 看着像泄露，实际一条所有者字节都没有 —— 确认就是错误确认。
    const guess = lab.grade(confirmed(lab, ids));
    assert.equal(guess.independentSuccess, false, 'a shared-cache collision must not be confirmed');
    assert.equal(guess.falseConfirmed, 1);
    assert.equal(guess.effectVerified, false);
    assert.equal(lab.grade({ outcome: 'no-finding', evidenceIds: ids, findings: [] }).independentSuccess, true);
    // 没有真正看到那条缓存正文（这里把探测回执改成 403）时，不许报无发现。
    const rows = lab.audit();
    for (const row of rows) if (row.cacheServed !== undefined) { row.status = 403; row.cacheServed = undefined; }
    const withoutCacheBody = gradeAttempt({ spec: caseById('n7'), runId: lab.runId, rows, markers: lab.controller.markers },
      { outcome: 'no-finding', evidenceIds: ids, findings: [] });
    assert.equal(withoutCacheBody.independentSuccess, false,
      'a probe that never returned the cached body is not evidence for a no-finding verdict');
    assert(lab.grade({ outcome: 'no-finding', evidenceIds: ids, findings: [] }).independentSuccess,
      'audit read must not mutate live truth');
  } finally { await lab.close(); }
});

await test('server-access cases need a real server-side internal fetch, not a success message', async () => {
  const flawed = await createEffectLab('s1');
  try {
    assert.equal(flawed.claimKind, 'server-access');
    const { instructions } = flawed.brief();
    for (const needle of ['公开文档页回执', '服务端去取', '一次有效观察就够', '内部审计']) {
      assert(instructions.includes(needle), `server-access contract missing ${needle}`);
    }
    // 客户端自己够不到内部服务：适配器只允许本靶场 origin，而且这次尝试不该留下任何回执。
    const before = flawed.audit().length;
    await assert.rejects(flawed.request({ url: `${flawed.controller.internalOrigin()}/internal/audit.log` }), /outside/);
    assert.equal(flawed.audit().length, before, 'an out-of-scope attempt must not create a receipt');
    const ids = await collectFetch(flawed);
    assert.equal(flawed.grade(confirmedFetch(flawed, ids)).independentSuccess, true);
    const internalRows = flawed.audit().filter(row => row.internalHit === true);
    assert.equal(internalRows.length, 2, 'the server-side internal fetch must happen twice');
    for (const row of internalRows) {
      assert.equal(row.status, 200);
      assert.equal(row.actualMarker, flawed.controller.markers.owner, 'the internal body must be the owner-only content');
      assert.equal(row.targetOrigin, flawed.controller.internalOrigin());
    }
    const onlyFetch = flawed.grade(confirmedFetch(flawed, internalRows.map(row => row.id)));
    assert.equal(onlyFetch.independentSuccess, false, 'the server-side fetch alone is not the declared contract');
    assert.equal(onlyFetch.falseConfirmed, 1);
    // v6 第 9.1/10.1 节：文档对照 + 服务端取件各一条即可，不强制匿名拒绝那一层。
    assert.equal(flawed.grade(confirmedFetch(flawed, [ids[0], ids[3]])).independentSuccess, true,
      'one document control plus one real server-side fetch must be enough');
  } finally { await flawed.close(); }

  const hardened = await createEffectLab('s2');
  try {
    const ids = await collectFetch(hardened);
    const guess = hardened.grade(confirmedFetch(hardened, ids));
    assert.equal(guess.independentSuccess, false, 'a refused internal fetch must not be confirmed');
    assert.equal(guess.falseConfirmed, 1);
    assert.equal(hardened.grade({ outcome: 'no-finding', evidenceIds: ids, findings: [] }).independentSuccess, true);
    const refused = hardened.audit().filter(row => row.internalHit === true);
    assert.equal(refused.length, 2);
    for (const row of refused) assert.equal(row.status, 403);
  } finally { await hardened.close(); }
});

await test('agent-facing wording names no category, so no case is primed', async () => {
  // 源码形状断言（不是行为断言）。两处文字都会进模型上下文，两处以前都写死了"访问边界/私有读取"
  // —— 那是"所有用例都是越权读取"时代的措辞；类别扩到适用性/越权写入/越界文件读取/输出处理/
  // 服务端取件之后，它们等于在题面里加提示。真正的题面在 brief.question 里。
  const biased = ['访问边界', '越权', '私有读取', '适用性', '输出处理', '服务端', '缓存'];
  const kickoffSource = readFileSync(new URL('../benchmarks/task-effects/desktop-plugin.mjs', import.meta.url), 'utf8');
  const kickoff = /text:\s*'([^']*)'\s*\+\s*json\(bridge\.brief\)/.exec(kickoffSource);
  assert(kickoff, 'the kickoff message must still be findable in desktop-plugin.mjs');
  for (const word of biased) assert(!kickoff[1].includes(word), `the kickoff must not prime any category, found "${word}" in: ${kickoff[1]}`);
  assert(kickoff[1].includes('exercise_submit'), 'the kickoff must still say how to submit');

  const interfaceSource = readFileSync(new URL('../benchmarks/task-effects/agent-interface.mjs', import.meta.url), 'utf8');
  const outcome = /outcome:\s*\{[^}]*description:\s*'([^']*)'/.exec(interfaceSource);
  assert(outcome, 'the outcome parameter description must still be findable in agent-interface.mjs');
  assert(outcome[1].includes('未发现'), 'the outcome description must still explain the enum to the model');
  // 机械扫一遍**所有**工具参数/工具描述：题面在 brief 里，schema 里不该出现任何类别词。
  // 这样这类问题不用靠人再找一遍 —— 2026-10-11 就是先修了开场话术、过一轮才发现 schema 里也有一处。
  const descriptions = [...interfaceSource.matchAll(/description:\s*'([^']*)'/g)].map(match => match[1]);
  assert(descriptions.length >= 5, `expected the frozen tool schema descriptions, found ${descriptions.length}`);
  for (const text of descriptions) {
    for (const word of biased) {
      assert(!text.includes(word), `tool schema wording must not prime any category, found "${word}" in: ${text}`);
    }
  }
});

await test('the holdout split is isolated from calibration runs by default', async () => {
  const holdouts = CASES.filter(item => item.split === 'holdout');
  assert.equal(holdouts.length, 23);
  await assert.rejects(createEffectLab(holdouts[0].id), /holdout split/,
    'a calibration run must not silently touch a holdout case');
  await assert.rejects(createEffectLab(holdouts[0].id, { split: 'calibration' }), /holdout split/);
  await assert.rejects(createEffectLab('p1', { split: 'holdout' }), /calibration split/,
    'a holdout run must not touch calibration cases either');
  await assert.rejects(createEffectLab('p1', { split: 'dev' }), /invalid case split/);
  const lab = await createEffectLab(holdouts[0].id, { split: 'holdout' });
  try { assert.equal(lab.caseId, holdouts[0].id); assert.equal(lab.version, 'task-effects/v10'); }
  finally { await lab.close(); }
});
await test('failure diagnostics distinguish missing submission, duplicate IDs, wrong run and damaged bytes', async () => {
  const lab = await createEffectLab('p1');
  try {
    const ids = await collect(lab);
    assert.equal(lab.grade(confirmed(lab, ids)).reasonCode, 'independent-effect-matched');
    const missing = lab.grade({});
    assert.equal(missing.reasonCode, 'submission-missing-or-invalid');
    assert(missing.evidenceErrors.includes('evidence-ids-missing-or-invalid'));
    const duplicate = lab.grade(confirmed(lab, [...ids, ids[0]]));
    assert.equal(duplicate.reasonCode, 'evidence-invalid');
    assert(duplicate.evidenceErrors.includes('evidence-id-duplicate'));
    const foreign = lab.grade(confirmed(lab, ['not-a-receipt-from-this-run']));
    assert(foreign.evidenceErrors.includes('evidence-id-unknown'));
    const authority = () => ({ spec: caseById('p1'), runId: lab.runId, rows: lab.audit(), markers: lab.controller.markers });
    const wrongRun = authority(); wrongRun.rows[0].runId = 'other-run';
    assert(gradeAttempt(wrongRun, confirmed(lab, ids)).evidenceErrors.includes('evidence-run-mismatch'));
    const damaged = authority(); damaged.rows[0].responseBodyBase64 = Buffer.from('changed').toString('base64');
    assert(gradeAttempt(damaged, confirmed(lab, ids)).evidenceErrors.includes('evidence-body-hash-mismatch'));
    const partial = lab.grade(confirmed(lab, ids.slice(0, 2)));
    assert.equal(partial.confirmationClass, 'positive-unsupported-confirmation');
    assert.equal(partial.reasonCode, 'confirmation-unsupported');
  } finally { await lab.close(); }
  const hardened = await createEffectLab('n1');
  try {
    assert.equal(hardened.grade(confirmed(hardened, await collect(hardened))).confirmationClass, 'negative-false-confirmation');
  } finally { await hardened.close(); }
});

await test('preset composition digest normalizes isolated home paths', async () => {
  // 实测（probea/probeb）：pentest 文档带 <DSH_HOME>\profiles\desktop\skills\ 这类绝对路径，
  // 不归一化时不同隔离 home 的同一 preset 会得到不同摘要，跨实例契约直接失效。
  const documentFor = home => [
    "- id: skill-filesystem",
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '  config:',
    '    roots:',
    `      - ${home}\\profiles\\desktop\\skills\\`,
    `      - ${home}/shared/skills/`,
    '',
  ].join('\n');
  const registryFor = (home, content = documentFor(home)) => ({
    resolve: async id => ({ id }),
    readDocument: async () => ({ content }),
  });
  const homeA = 'E:\\work\\iso-a\\home', homeB = 'E:\\work\\iso-b\\home';
  const a = await resolveComparisonPreset(registryFor(homeA), 'candidate', { normalizePaths: [homeA] });
  const b = await resolveComparisonPreset(registryFor(homeB), 'candidate', { normalizePaths: [homeB] });
  assert.equal(a.compositionDigest, b.compositionDigest, '归一化后同一组合必须得到同一摘要');
  const rawA = await resolveComparisonPreset(registryFor(homeA), 'candidate');
  const rawB = await resolveComparisonPreset(registryFor(homeB), 'candidate');
  assert.notEqual(rawA.compositionDigest, rawB.compositionDigest, '未归一化时路径差异必须体现在摘要里（回归保护）');
  const changed = await resolveComparisonPreset(registryFor(homeA, documentFor(homeA).replace('dsh-skill-filesystem', 'dsh-other-plugin')), 'candidate', { normalizePaths: [homeA] });
  assert.notEqual(a.compositionDigest, changed.compositionDigest, '组合内容变化仍必须改变摘要');
});

console.log('Fixture verification only: modelCalls=0; no agent effectiveness or cost improvement is claimed.');
process.exitCode=failed?1:0;
