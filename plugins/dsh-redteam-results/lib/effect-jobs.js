// Bounded deterministic jobs over already recorded requests. No generated scripts.
import { createHash, randomUUID } from 'node:crypto';
import { preflightRecordedRequest, executeRecordedRequest, readExecutionReceipt } from './execution-receipts.js';
import { createResearch, researchDetail, researchNext, observeResearch, closeResearch } from './research.js';
import { readTaskContext } from './task-context.js';
import { taskPolicyStatus } from './task-policy.js';
import { assessPrivateReadRound, verifyEffect, readEffectVerification } from './effect-verifications.js';

export const EFFECT_JOB_SCHEMA = `
CREATE TABLE IF NOT EXISTS effect_jobs (
 session_id TEXT NOT NULL, id TEXT NOT NULL, job_key TEXT NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(session_id,id), UNIQUE(session_id,job_key)
);
CREATE TABLE IF NOT EXISTS effect_job_steps (
 session_id TEXT NOT NULL, job_id TEXT NOT NULL, step_key TEXT NOT NULL,
 state TEXT NOT NULL, receipt_id TEXT,
 PRIMARY KEY(session_id,job_id,step_key)
);`;
const running = new Set();
const roles = ['owner', 'normal', 'probe', 'denied'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };
const credential = parsed => hash([parsed.headers.authorization || '', parsed.headers.cookie || '']);
const resource = parsed => [parsed.method, parsed.target.href, parsed.body.toString(),
  Object.entries(parsed.headers).filter(([name]) => !['authorization', 'cookie', 'connection', 'content-length'].includes(name)).sort()];
function preflight(store, sessionId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 8192) fail('bounded effect job document required');
  const options = { timeoutMs: input.timeoutMs ?? 5000, maxBytes: input.maxBytes ?? 65536 };
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 15000
    || !Number.isInteger(options.maxBytes) || options.maxBytes < 64 || options.maxBytes > 65536) fail('invalid bounded effect job limits');
  const selected = Object.fromEntries(roles.map(role => [role, preflightRecordedRequest(store, sessionId,
    { ...input.roles?.[role], methodId: input.methodId, methodVersion: input.methodVersion })]));
  const method = selected.owner.method;
  if (method.effectSpec?.kind !== 'private-json-read/v1') fail('only a reviewed private JSON read recipe can run automatically');
  for (const key of ['resourceId', 'ownerId', 'viewerId', 'visibility', 'readers', 'marker']) {
    const pointer = method.effectSpec[key + 'Path'];
    if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 200
      || /(?:^|\/)(?:__proto__|constructor|prototype)(?:\/|$)/.test(pointer)) fail('complete bounded effect field specification required');
  }
  if (roles.some(role => selected[role].row.endpoint !== method.endpoint || selected[role].parsed.method !== 'GET')) fail('effect roles must address the reviewed endpoint with recorded GET requests');
  const policy = taskPolicyStatus(store, sessionId);
  if (!policy.configured) fail('configured task policy required');
  const kinds = ['api', 'backend', 'web'];
  for (const role of ['owner', 'normal']) {
    const row = selected[role].row;
    if (!row.valid || !kinds.includes(row.kind) || !/^HTTP\/\S+\s+2\d\d\b/.test(row.response || '')
      || !row.inputs?.some(field => ['query', 'body', 'path', 'header'].includes(field.location) && field.evidenceIds?.includes(row.id))) fail('current observed normal baselines required for owner and subject roles');
  }
  const identity = role => selected[role].row.authContext;
  const owner = selected.owner.parsed, normal = selected.normal.parsed;
  if (!(owner.headers.authorization || owner.headers.cookie) || !(normal.headers.authorization || normal.headers.cookie)
    || credential(owner) === credential(normal) || credential(normal) !== credential(selected.probe.parsed)
    || selected.denied.parsed.headers.authorization || selected.denied.parsed.headers.cookie
    || identity('owner') === identity('normal') || identity('normal') !== identity('probe')
    || [identity('owner'), identity('normal')].includes(identity('denied'))) fail('distinct owner subject and anonymous execution identities required');
  if (hash(resource(owner)) !== hash(resource(selected.probe.parsed)) || hash(resource(owner)) !== hash(resource(selected.denied.parsed))) fail('owner probe and anonymous denial must address the same protected resource');
  const { reviewed, reviewedAt, reviewer, reviewNotes, id, version, ...semanticMethod } = method;
  const methodKey = hash(semanticMethod);
  // IDs, revision labels, limits and unrelated assets cannot reopen identical work.
  const jobKey = hash([methodKey, ...roles.map(role => {
    const row = selected[role].row;
    return [role, row.endpoint, row.authContext, row.request, row.valid, row.kind,
      row.response?.replace(/^Date:[^\r\n]*\r?\n/gim, ''),
      row.inputs.map(field => [field.location, field.name]).sort()];
  })]);
  return { selected, methodKey, jobKey, input: { methodId: method.id, methodVersion: method.version,
    roles: Object.fromEntries(roles.map(role => [role, { requestId: selected[role].row.id, requestRevision: selected[role].row.revision }])), ...options } };
}
function write(store, sessionId, job) {
  job.updatedAt = new Date().toISOString();
  store.db.prepare('UPDATE effect_jobs SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(job), sessionId, job.id);
}
const steps = (store, sid, id) => store.db.prepare('SELECT step_key AS step,state,receipt_id AS receiptId FROM effect_job_steps WHERE session_id=? AND job_id=? ORDER BY rowid').all(sid, id);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function current(store, sid, job) {
  try { return preflight(store, sid, job.input).jobKey === job.jobKey; } catch { return false; }
}
function summary(store, sid, job, cached = false) {
  const captured = steps(store, sid, job.id);
  let effect;
  if (job.effectId) effect = readEffectVerification(store, sid, job.effectId);
  const isCurrent = current(store, sid, job);
  return { id: job.id, source: 'host-recorded-effect-job', state: job.state, reason: job.reason || '', cached,
    current: isCurrent, coverage: job.state === 'completed' && isCurrent && effect?.current ? 'recipe-verified' : 'partial-or-unknown',
    effectId: job.effectId ?? null, impactVerified: isCurrent && effect?.current === true,
    ...(effect?.current ? { proofKind: effect.proofKind, endpoint: effect.endpoint, identity: effect.identity,
      controlReceiptId: effect.controlReceiptId, probeReceiptId: effect.probeReceiptId } : {}),
    attemptedRequests: captured.length, capturedRequests: captured.filter(step => step.state === 'captured').length,
    steps: captured, detail: 'redteam_execution action=job-detail id=' + job.id,
    evidenceLimit: 'Only the reviewed recipe is covered; a stopped or restricted branch is not proof that the asset is safe.' };
}
export function readEffectJob(store, sid, id) {
  const row = store.db.prepare('SELECT record FROM effect_jobs WHERE session_id=? AND id=?').get(sid, id);
  if (!row) fail('effect job not found in current session');
  return summary(store, sid, JSON.parse(row.record), true);
}
function stopDirections(store, sid, job, reason) {
  for (const id of Object.values(job.directions)) {
    if (!store.db.prepare('SELECT 1 FROM research_hypotheses WHERE session_id=? AND id=?').get(sid, id)) continue;
    const direction = researchDetail(store, sid, id);
    if (['active', 'supported'].includes(direction.state)) closeResearch(store, sid, id, reason);
  }
}
export async function runEffectJob(store, sid, input, signal) {
  signal?.throwIfAborted();
  const setup = preflight(store, sid, input);
  let job;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const row = store.db.prepare('SELECT record FROM effect_jobs WHERE session_id=? AND job_key=?').get(sid, setup.jobKey);
    if (row) {
      job = JSON.parse(row.record);
      if (job.state !== 'running') { store.db.exec('COMMIT'); return summary(store, sid, job, true); }
      if (running.has(job.id) || (job.runnerPid !== process.pid && alive(job.runnerPid))) {
        store.db.exec('COMMIT'); return { ...summary(store, sid, job, true), busy: true };
      }
      const captured = steps(store, sid, job.id);
      if (captured.some(step => step.state === 'inflight')) {
        job.state = 'interrupted'; job.reason = 'dispatch_without_captured_outcome; automatic resend refused';
        write(store, sid, job); store.db.exec('COMMIT');
        stopDirections(store, sid, job, job.reason); return summary(store, sid, job, true);
      }
      if (!current(store, sid, job) || captured.some(step => Date.now() - Date.parse(readExecutionReceipt(store, sid, step.receiptId).completedAt) > 15 * 60000)) {
        job.state = 'stale'; job.reason = 'context or execution freshness changed; automatic resend refused';
        write(store, sid, job); store.db.exec('COMMIT'); stopDirections(store, sid, job, job.reason); return summary(store, sid, job, true);
      }
      job.runnerPid = process.pid; write(store, sid, job);
    } else {
      const policy = taskPolicyStatus(store, sid);
      if (policy.stopped) fail(policy.reason);
      if (researchNext(store, sid).id) fail('finish or close the existing manual direction before starting an effect job');
      if (store.db.prepare('SELECT COUNT(*) AS n FROM effect_jobs WHERE session_id=?').get(sid).n >= 30) fail('effect job limit reached');
      const id = 'job-' + randomUUID();
      job = { id, jobKey: setup.jobKey, methodKey: setup.methodKey, input: setup.input, state: 'running', runnerPid: process.pid,
        directions: Object.fromEntries(['owner', 'anonymous', 'subject'].map(role => [role, id + '.' + role])), createdAt: new Date().toISOString() };
      store.db.prepare('INSERT INTO effect_jobs (session_id,id,job_key,record) VALUES (?,?,?,?)').run(sid, id, setup.jobKey, JSON.stringify(job));
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  running.add(job.id);
  const direction = (role, baselineRole) => {
    const id = job.directions[role];
    if (!store.db.prepare('SELECT 1 FROM research_hypotheses WHERE session_id=? AND id=?').get(sid, id)) {
      const row = setup.selected[baselineRole].row;
      createResearch(store, sid, { id, requestId: row.id, requestRevision: row.revision,
        controlledInputs: row.inputs.filter(field => field.evidenceIds?.includes(row.id)).map(({ name, location }) => ({ name, location })),
        title: 'Recorded private object ' + role + ' comparison', serverPath: row.endpoint,
        boundary: 'Reviewed private object ' + role + ' contract ' + setup.methodKey,
        normalBehavior: 'Recorded own-object or public baseline succeeds',
        supportCriterion: 'Excluded subject receives the owner-only response marker',
        falsifier: 'Current valid subject is denied the protected object',
        nextInformation: 'Bounded deterministic role comparison',
        knownCheck: { outcome: 'not-assessed', rationale: 'Business-contract verification; no novelty assertion', sources: [] } });
    }
    return id;
  };
  const execute = async (key, role, hypothesisId) => {
    const captured = steps(store, sid, job.id).find(step => step.step === key);
    if (captured) {
      if (captured.state !== 'captured') fail('uncaptured dispatch cannot be resent');
      return readExecutionReceipt(store, sid, captured.receiptId);
    }
    const result = await executeRecordedRequest(store, sid, { hypothesisId, ...job.input.roles[role],
      methodId: job.input.methodId, methodVersion: job.input.methodVersion,
      timeoutMs: job.input.timeoutMs, maxBytes: job.input.maxBytes }, { jobId: job.id, stepKey: key }, signal);
    return readExecutionReceipt(store, sid, result.id);
  };
  const close = (id, reason) => { if (['active', 'supported'].includes(researchDetail(store, sid, id).state)) closeResearch(store, sid, id, reason); };
  const finish = (state, reason) => {
    job.state = state; job.reason = reason; write(store, sid, job); stopDirections(store, sid, job, reason);
    return summary(store, sid, job);
  };
  const requireResponse = receipt => { if (!receipt.current || receipt.outcome !== 'response') fail('incomplete or stale captured execution: ' + receipt.outcome); };
  try {
    const rounds = [{}, {}];
    for (const [role, baselineRole, stepRole] of [['owner', 'owner', 'owner'], ['anonymous', 'owner', 'denied']]) {
      const id = direction(role, baselineRole);
      for (let i = 0; i < 2; i++) {
        const receipt = await execute(stepRole + '.' + i, stepRole, id);
        requireResponse(receipt); rounds[i][stepRole] = receipt.id;
        if (role === 'owner' && (receipt.status < 200 || receipt.status >= 300 || !/^content-type:\s*application\/(?:[\w.+-]*\+)?json\b/im.test(receipt.responseHead))) return finish('inconclusive', 'owner JSON control unavailable');
        if (role === 'anonymous' && ![401, 403, 404].includes(receipt.status)) return finish('inconclusive', 'anonymous protected-object denial unavailable');
      }
      close(id, 'Reference executions captured; no impact asserted');
    }
    const id = direction('subject', 'normal');
    for (let i = 0; i < 2; i++) {
      const normal = await execute('normal.' + i, 'normal', id);
      requireResponse(normal); rounds[i].normal = normal.id;
      if (normal.status < 200 || normal.status >= 300) return finish('inconclusive', 'valid subject normal control unavailable');
      const probe = await execute('probe.' + i, 'probe', id);
      requireResponse(probe); rounds[i].probe = probe.id;
      const assessment = assessPrivateReadRound(store, sid, { methodId: job.input.methodId, methodVersion: job.input.methodVersion, rounds: [rounds[i]] });
      const observationId = 'effect-round-' + i;
      if (!researchDetail(store, sid, id).observations.some(row => row.id === observationId)) observeResearch(store, sid, id,
        { id: observationId, outcome: assessment.supported ? 'support' : 'no-information',
          endpoint: normal.endpoint, authContext: normal.authContext, controlReceiptId: normal.id, probeReceiptId: probe.id,
          expected: 'Repeated owner exclusion under reviewed private contract', observed: assessment.supported ? 'Independent role comparison supports continuing' : 'Private effect not established',
          interpretation: assessment.reason || 'One round is not a confirmed effect', nextInformation: i ? 'Independent effect verifier' : 'One independent repeat only' });
      if (!assessment.supported) return finish('inconclusive', assessment.reason);
    }
    const effect = verifyEffect(store, sid, { methodId: job.input.methodId, methodVersion: job.input.methodVersion, rounds });
    job.effectId = effect.id;
    return finish(effect.verified ? 'completed' : 'inconclusive', effect.reason || 'Repeated private contract independently verified');
  } catch (error) {
    const uncertain = steps(store, sid, job.id).some(step => step.state === 'inflight');
    return finish(uncertain ? 'interrupted' : 'blocked', error.message);
  } finally { running.delete(job.id); }
}
