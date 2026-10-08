import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { CASES, caseById } from '../benchmarks/task-effects/cases.mjs';
import { createEffectLab } from '../benchmarks/task-effects/lab.mjs';
import { gradeAttempt } from '../benchmarks/task-effects/grade.mjs';
import { makeProtocol, assessComparability, summarizeRuns } from '../benchmarks/task-effects/protocol.mjs';

async function login(lab, role) {
  const spec = caseById(lab.caseId);
  if (!spec.flow) return undefined;
  const { username, password } = lab.brief().accounts[role];
  const receipt = await lab.request({ url: lab.origin + '/session', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return JSON.parse(Buffer.from(receipt.responseBodyBase64, 'base64')).token;
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
      ticket = JSON.parse(Buffer.from(receipt.responseBodyBase64, 'base64')).ticket;
    }
    const receipt = await lab.request(lab.controller.recordRequest(role, object, { session: sessions[role], ticket }));
    evidenceIds.push(receipt.id);
  }
  return evidenceIds;
}
const confirmed = (lab, ids) => ({ outcome: 'confirmed', evidenceIds: ids,
  findings: [{ caseId: lab.caseId, kind: 'private-read', status: 'confirmed', evidenceIds: ids }] });
let failed = 0;
async function test(label, fn) { try { await fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }

await test('frozen cases contain 8 single positives, 6 identity chains, 6 negatives, 4 faults and 12 holdouts', () => {
  const calibration = CASES.filter(c => c.split === 'calibration');
  assert.equal(calibration.length, 24);
  for (const [category, count] of [['single-positive',8],['multi-positive',6],['negative',6],['fault',4]]) assert.equal(calibration.filter(c=>c.category===category).length,count);
  assert.equal(CASES.filter(c=>c.split==='holdout').length,12); assert.equal(new Set(CASES.map(c=>c.id)).size,36);
});
await test('all 36 local cases produce independent outcomes from actual HTTP and fault captures', async () => {
  for (const spec of CASES) {
    const lab = await createEffectLab(spec.id);
    try {
      let submission;
      if (spec.fault || ['expired','version-unknown'].includes(spec.behavior)) {
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
      else {const score=lab.grade(confirmed(lab,ids.slice(0,4)));assert.equal(score.independentSuccess,false);assert.equal(score.falseConfirmed,1);}
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
  const protocol=makeProtocol(input);assert.equal(protocol.runs.length,324);assert.deepEqual(makeProtocol(input),protocol);
  assert.notDeepEqual(makeProtocol({...input,seed:'other-seed'}).runs,protocol.runs);
  for(const id of CASES.map(c=>c.id))for(const variant of protocol.variants)assert.equal(protocol.runs.filter(r=>r.caseId===id&&r.variant===variant).length,3);
  const runtime={model:protocol.model,toolDigest:protocol.toolDigest,accessDigest:protocol.accessDigest,budget:protocol.budget,snapshotRestored:true};
  assert.equal(assessComparability(protocol,runtime).comparable,false,'uncalibrated ceiling is not a fair frozen budget');
  const calibrated=makeProtocol({...input,calibrated:true});assert(assessComparability(calibrated,runtime).comparable);
  assert(!assessComparability(calibrated,{...runtime,model:'different-model'}).comparable);
  const score={independentSuccess:false,falseConfirmed:1,targetRequests:5};
  const summary=summarizeRuns([{variant:'candidate',score,usage:{tokens:null,elapsedMs:100,humanInterventions:null},comparability:{comparable:false}}]);
  assert.equal(summary.candidate.tokensUnknownRuns,1);assert.equal(summary.candidate.tokensTotal,null);
  assert.equal(summary.candidate.humanUnknownRuns,1);assert.equal(summary.candidate.humanInterventionsTotal,null);assert.equal(summary.candidate.incomparableRuns,1);
});
console.log('Fixture verification only: modelCalls=0; no agent effectiveness or cost improvement is claimed.');
process.exitCode=failed?1:0;
