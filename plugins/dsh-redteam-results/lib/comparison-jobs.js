// Two recorded requests and a factual observation in one model call.
// Response differences are investigation material, never automatic impact proof.
import { createHash, randomUUID } from 'node:crypto';
import { preflightRecordedRequest, executeRecordedRequest, readExecutionReceipt } from './execution-receipts.js';
import { researchDetail, researchNext, observeResearch } from './research.js';
import { taskPolicyStatus } from './task-policy.js';
import { readTaskContext } from './task-context.js';
const running = new Set();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const fail = message => { throw new Error(message); };
const steps = (store, sid, id) => store.db.prepare('SELECT step_key AS step,state,receipt_id AS receiptId FROM effect_job_steps WHERE session_id=? AND job_id=? ORDER BY rowid').all(sid, id).map(row => ({ ...row }));
function prepare(store, sid, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 8192) fail('bounded comparison document required');
  const direction = researchDetail(store, sid, input.hypothesisId);
  if (!direction.current) fail('current research baseline required');
  const selected = Object.fromEntries(['normal', 'probe'].map(role => [role, preflightRecordedRequest(store, sid,
    { ...input[role], ...(input.methodId === undefined ? {} : { methodId: input.methodId, methodVersion: input.methodVersion }) }, { requireMethod: false })]));
  if (input.methodVersion !== undefined && input.methodId === undefined) fail('method identity and version must be supplied together');
  for (const { row, parsed, method } of Object.values(selected)) {
    if (row.endpoint !== direction.binding.endpoint || row.authContext !== direction.binding.authContext
      || !['GET', 'HEAD'].includes(parsed.method) || (method && method.endpoint !== row.endpoint)) fail('comparison must stay in the current endpoint and identity; automatic comparisons accept GET/HEAD only');
  }
  const normal = selected.normal;
  if (normal.row.id !== direction.binding.requestId || normal.row.revision !== direction.binding.requestRevision
    || !normal.row.valid || !/^HTTP\/\S+\s+2\d\d\b/.test(normal.row.response || '')) fail('normal role must use this direction\'s recorded valid baseline');
  const credentials = role => hash([selected[role].parsed.headers.authorization || '', selected[role].parsed.headers.cookie || '']);
  if (credentials('normal') !== credentials('probe')) fail('comparison cannot silently switch credentials');
  const jobKey = hash(['recorded-comparison/v1', direction.boundary, direction.controlledInputs, direction.supportCriterion, direction.falsifier,
    ...['normal', 'probe'].map(role => { const row = selected[role].row; return [row.endpoint, row.authContext, row.request, row.valid,
      row.response?.replace(/^Date:[^\r\n]*\r?\n/gim, ''), row.inputs.map(field => [field.location, field.name]).sort()]; }),
    selected.normal.method ? hash(selected.normal.method) : 'no-method']);
  const timeoutMs = input.timeoutMs ?? 5000, maxBytes = input.maxBytes ?? 65536;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000 || !Number.isInteger(maxBytes) || maxBytes < 64 || maxBytes > 65536) fail('invalid comparison limits');
  return { direction, jobKey, input: { hypothesisId: direction.id,
    normal: { requestId: selected.normal.row.id, requestRevision: selected.normal.row.revision },
    probe: { requestId: selected.probe.row.id, requestRevision: selected.probe.row.revision },
    ...(input.methodId === undefined ? {} : { methodId: input.methodId, methodVersion: input.methodVersion }), timeoutMs, maxBytes } };
}
function write(store, sid, job) {
  job.updatedAt = new Date().toISOString();
  store.db.prepare('UPDATE effect_jobs SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(job), sid, job.id);
}
function summary(store, sid, job, cached = false) {
  const captured = steps(store, sid, job.id);
  let current = false;
  try { current = prepare(store, sid, job.input).jobKey === job.jobKey && captured.filter(step => step.state === 'captured').every(step => readExecutionReceipt(store, sid, step.receiptId).current); } catch { /* retain original evidence */ }
  return { id: job.id, source: 'host-recorded-comparison', state: job.state, reason: job.reason || '', cached, current,
    attemptedRequests: captured.length, capturedRequests: captured.filter(step => step.state === 'captured').length,
    steps: captured, difference: job.difference ?? null, observationId: job.observationId ?? null, impactVerified: false,
    pendingRegistration: { tool: 'redteam_finding_register', comparisonId: job.id, proofKind: 'access',
      condition: 'After support assessment and with a current reviewed method; remains pending until independent impact review. Use the pair ID, not observationId; no private-JSON verifier is needed for plain-text evidence.' },
    next: job.state === 'completed' ? 'Read the relevant response details and interpret the difference against the business question; it is not a verified vulnerability.' : 'Partial or unknown coverage; do not automatically resend an uncaptured dispatch.',
    detail: 'redteam_execution action=pair-detail id=' + job.id };
}
export function readComparisonJob(store, sid, id) {
  const row = store.db.prepare('SELECT record FROM effect_jobs WHERE session_id=? AND id=?').get(sid, id);
  const job = row && JSON.parse(row.record);
  if (job?.kind !== 'recorded-comparison/v1') fail('comparison not found in this session');
  return summary(store, sid, job, true);
}
export function comparisonFindingInput(store, sid, input) {
  if (input.proofKind !== undefined && input.proofKind !== 'access') fail('a read comparison can only register pending access evidence, never write or execution');
  const comparisonId = typeof input.comparisonId === 'string' ? input.comparisonId.replace(/\.observation$/, '') : '';
  const saved = store.db.prepare('SELECT record FROM effect_jobs WHERE session_id=? AND id=?').get(sid, comparisonId);
  if (!saved) fail('comparisonId must be the plain pair-UUID returned by run-pair, not a JSON object or hypothesis ID; keep the recorded lead and correct this argument once, without new requests or filesystem search');
  const job = JSON.parse(saved.record), view = readComparisonJob(store, sid, comparisonId);
  if (!view || view.state !== 'completed' || !view.current || view.steps.length !== 2) fail('current completed two-request comparison required');
  const direction = researchDetail(store, sid, job.input.hypothesisId);
  const observation = direction.observations.find(row => row.id === job.observationId);
  if (observation?.assessment?.outcome !== 'support') fail('interpret the comparison as support before registering a pending lead; an HTTP difference is not sufficient');
  const method = readTaskContext(store, sid)?.methods.find(row => row.id === job.input.methodId && row.version === job.input.methodVersion && row.reviewed);
  if (!method) fail('comparison registration needs its current reviewed method; retain the research lead until that condition is available');
  const receipts = Object.fromEntries(view.steps.map(step => [step.step.replace(/\.0$/, ''), readExecutionReceipt(store, sid, step.receiptId)]));
  if (!receipts.normal?.current || !receipts.probe?.current || receipts.normal.outcome !== 'response' || receipts.probe.outcome !== 'response') fail('current complete normal and probe receipts required');
  const ids = [receipts.normal.id, receipts.probe.id];
  const reproduction = { kind: 'method', mechanism: direction.boundary, methodId: method.id, methodVersion: method.version, endpoint: direction.binding.endpoint,
    prerequisites: ['Independently confirm the recorded identity, object ownership and expected permission.'], dependencies: [],
    parameters: ['Normal saved request: '+job.input.normal.requestId+'@'+job.input.normal.requestRevision, 'Probe saved request: '+job.input.probe.requestId+'@'+job.input.probe.requestRevision],
    steps: ['Inspect the captured normal receipt '+ids[0]+' and probe receipt '+ids[1]+'.', 'Compare the actual object and permission effect; replay only after a valid normal baseline and within the agreed budget.'],
    successCriterion: direction.supportCriterion, reviewSteps: 'Independently compare the actual response bodies with the recorded role and object ownership; HTTP status and frontend menus are insufficient.',
    recovery: 'Read-only GET/HEAD comparison; no business state changes were sent.',
    verification: { status: 'verified', evidenceIds: ids, controlReceiptId: ids[0], probeReceiptId: ids[1] } };
  return { ...input, status: 'pending', proofKind: 'access', target: direction.binding.endpoint, identity: direction.binding.authContext,
    evidenceLevel: 'confirmed', evidence: ids.join(','), requestPkt: receipts.probe.request.trim(),
    responsePkt: (receipts.probe.responseHead+Buffer.from(receipts.probe.responseBodyBase64,'base64').toString()).trim(), reproduction: JSON.stringify(reproduction) };
}
export async function runComparisonJob(store, sid, input, signal) {
  const setup = prepare(store, sid, input); let job;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const found = store.db.prepare('SELECT record FROM effect_jobs WHERE session_id=? AND job_key=?').get(sid, setup.jobKey);
    if (found) {
      job = JSON.parse(found.record);
      if (job.state !== 'running') { store.db.exec('COMMIT'); return summary(store, sid, job, true); }
      if (running.has(job.id) || (job.runnerPid !== process.pid && alive(job.runnerPid))) { store.db.exec('COMMIT'); return { ...summary(store, sid, job, true), busy: true }; }
      if (steps(store, sid, job.id).some(step => step.state === 'inflight')) {
        job.state = 'interrupted'; job.reason = 'uncaptured dispatch; automatic resend refused'; write(store, sid, job);
        store.db.exec('COMMIT'); return summary(store, sid, job, true);
      }
      if (steps(store, sid, job.id).some(step => { const receipt = readExecutionReceipt(store, sid, step.receiptId); return !receipt.current || Date.now() - Date.parse(receipt.completedAt) > 15 * 60000; })) {
        job.state = 'interrupted'; job.reason = 'captured comparison stale; automatic resend refused'; write(store, sid, job);
        store.db.exec('COMMIT'); return summary(store, sid, job, true);
      }
      if (job.input.hypothesisId !== setup.direction.id) fail('unfinished comparison belongs to another recorded direction');
      job.runnerPid = process.pid; write(store, sid, job);
    } else {
      const state = taskPolicyStatus(store, sid);
      if (!state.configured || state.stopped || !['active', 'supported'].includes(setup.direction.state) || researchNext(store, sid).id !== setup.direction.id) fail('current active task and direction required');
      if (store.db.prepare('SELECT COUNT(*) AS n FROM effect_jobs WHERE session_id=?').get(sid).n >= 100) fail('comparison job limit reached');
      job = { id: 'pair-' + randomUUID(), kind: 'recorded-comparison/v1', input: setup.input, jobKey: setup.jobKey,
        state: 'running', runnerPid: process.pid, createdAt: new Date().toISOString() };
      store.db.prepare('INSERT INTO effect_jobs(session_id,id,job_key,record) VALUES(?,?,?,?)').run(sid, job.id, job.jobKey, JSON.stringify(job));
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  running.add(job.id);
  try {
    const receipts = {};
    for (const role of ['normal', 'probe']) {
      signal?.throwIfAborted();
      const step = steps(store, sid, job.id).find(step => step.step === role + '.0');
      receipts[role] = step ? readExecutionReceipt(store, sid, step.receiptId) : readExecutionReceipt(store, sid,
        (await executeRecordedRequest(store, sid, { hypothesisId: job.input.hypothesisId, ...job.input[role],
          ...(job.input.methodId === undefined ? {} : { methodId: job.input.methodId, methodVersion: job.input.methodVersion }),
          timeoutMs: job.input.timeoutMs, maxBytes: job.input.maxBytes }, { jobId: job.id, stepKey: role + '.0' }, signal)).id);
      if (receipts[role].outcome !== 'response' || !receipts[role].current) fail('normal access or capture incomplete: ' + receipts[role].outcome);
      if (role === 'normal' && (receipts.normal.status < 200 || receipts.normal.status >= 300)) fail('normal control failed; probe not sent');
      if (taskPolicyStatus(store, sid).policy?.blocker) fail('access blocker recorded; further requests stopped');
    }
    const difference = { statusChanged: receipts.normal.status !== receipts.probe.status,
      bodyChanged: receipts.normal.responseBodyBase64 !== receipts.probe.responseBodyBase64,
      contentTypeChanged: /^content-type:[^\r\n]*/im.exec(receipts.normal.responseHead)?.[0]?.toLowerCase() !== /^content-type:[^\r\n]*/im.exec(receipts.probe.responseHead)?.[0]?.toLowerCase() };
    const observationId = job.id + '.observation';
    if (!researchDetail(store, sid, job.input.hypothesisId).observations.some(row => row.id === observationId)) observeResearch(store, sid, job.input.hypothesisId,
      { id: observationId, outcome: Object.values(difference).some(Boolean) ? 'difference' : 'no-information',
        endpoint: receipts.normal.endpoint, authContext: receipts.normal.authContext, controlReceiptId: receipts.normal.id, probeReceiptId: receipts.probe.id,
        expected: setup.direction.supportCriterion, observed: JSON.stringify(difference), interpretation: 'Host recorded response comparison; business impact is unconfirmed.',
        nextInformation: 'Read only relevant response details and related call sites, then assess the selected business question.' });
    job.state = 'completed'; job.difference = difference; job.observationId = observationId; write(store, sid, job);
    return summary(store, sid, job);
  } catch (error) {
    job.state = 'interrupted'; job.reason = error.message || String(error); write(store, sid, job);
    return summary(store, sid, job);
  } finally { running.delete(job.id); }
}
