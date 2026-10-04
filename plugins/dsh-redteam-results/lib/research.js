// Session-local falsifiable research ledger. Submitted observations are evidence
// records, not an execution engine or proof of global vulnerability novelty.
import { createHash } from 'node:crypto';
import { readTaskContext } from './task-context.js';
import { readExecutionReceipt } from './execution-receipts.js';

export const RESEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_hypotheses (
 session_id TEXT NOT NULL, id TEXT NOT NULL, direction_key TEXT NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(session_id,id), UNIQUE(session_id,direction_key)
);
CREATE TABLE IF NOT EXISTS research_observations (
 session_id TEXT NOT NULL, hypothesis_id TEXT NOT NULL, id TEXT NOT NULL,
 record TEXT NOT NULL, PRIMARY KEY(session_id,hypothesis_id,id)
);`;
const text = (value, label, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(label + ' must be bounded nonempty text');
  return value.trim();
};
const key = (value, label) => {
  const result = text(value, label, 96);
  if (!/^[A-Za-z0-9_.-]+$/.test(result)) throw new Error(label + ' must be a safe ID');
  return result;
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const baselineHash = row => hash([row.id, row.revision, row.endpoint, row.authContext, row.request, row.response, row.inputs]);
const entryKey = row => hash([row.endpoint, row.authContext, row.request,
  row.response?.replace(/^Date:[^\r\n]*\r?\n/gim, ''),
  row.inputs.map(input => [input.location, input.name]).sort()]);
function eligible(context, mode = '0day') {
  const kinds = ['backend', 'api', 'web']
  return (context?.requests || []).filter(row => row.valid === true && kinds.includes(row.kind)
    && row.request?.trim() && /^HTTP\/\S+\s+2\d\d\b/i.test(row.response || '')
    && row.inputs?.some(input => ['query', 'body', 'path', 'header'].includes(input.location) && input.name?.trim() && input.evidenceIds?.includes(row.id))
    && context.assets.some(asset => asset.inScope === true && asset.reachable === true && new URL(asset.url).origin === new URL(row.endpoint).origin));
}
function baseline(store, sessionId, binding) {
  const matches = eligible(readTaskContext(store, sessionId), policy(store, sessionId)).filter(row => row.id === binding.requestId && row.revision === binding.requestRevision);
  if (matches.length !== 1) throw new Error('current valid research baseline missing');
  const row = matches[0];
  if (binding.digest && baselineHash(row) !== binding.digest) throw new Error('research baseline changed; create a new hypothesis');
  return row;
}
function policy(store, sessionId) {
  const row = store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(sessionId);
  const mode = row && JSON.parse(row.record).mode;
  if (!['nday', 'regular', '0day'].includes(mode)) throw new Error('validation direction requires a configured pentest task');
  return mode;
}
function knownCheck(input) {
  if (!input || !['known', 'variant', 'none-found', 'not-assessed'].includes(input.outcome)) throw new Error('invalid known-vulnerability check');
  const rationale = text(input.rationale, 'knownCheck.rationale');
  if (!Array.isArray(input.sources) || input.sources.length > 20) throw new Error('knownCheck.sources must be bounded');
  const sources = input.sources.map(source => ({ reference: text(source.reference, 'source.reference'), observation: text(source.observation, 'source.observation') }));
  if (input.outcome !== 'not-assessed' && sources.length === 0) throw new Error('assessed known-vulnerability check needs recorded sources');
  return { outcome: input.outcome, rationale, sources };
}
function raw(store, sessionId, id) {
  key(id, 'hypothesis.id');
  const row = store.db.prepare('SELECT record FROM research_hypotheses WHERE session_id=? AND id=?').get(sessionId, id);
  if (!row) throw new Error('research hypothesis not found in current session');
  return JSON.parse(row.record);
}
function write(store, sessionId, record) {
  store.db.prepare('UPDATE research_hypotheses SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(record), sessionId, record.id);
}
export function researchDetail(store, sessionId, id) {
  const record = raw(store, sessionId, id);
  let current = true, blockedReason = '';
  try { baseline(store, sessionId, record.binding); } catch (error) { current = false; blockedReason = error.message; }
  const observations = store.db.prepare('SELECT record FROM research_observations WHERE session_id=? AND hypothesis_id=? ORDER BY rowid').all(sessionId, id).map(row => JSON.parse(row.record));
  return { ...record, current, blockedReason, observations, noveltyProven: false,
    evidenceLimit: 'Submitted observations require independent verification; no CVE match is not evidence of global novelty.' };
}
export function researchIndex(store, sessionId, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 100) throw new Error('invalid research offset');
  const total = store.db.prepare('SELECT count(*) AS n FROM research_hypotheses WHERE session_id=?').get(sessionId).n;
  const rows = store.db.prepare('SELECT id FROM research_hypotheses WHERE session_id=? ORDER BY rowid LIMIT 20 OFFSET ?').all(sessionId, offset);
  return { total, offset, items: rows.map(({ id }) => {
    const row = researchDetail(store, sessionId, id);
    return { id, title: row.title, state: row.state === 'restricted' || row.current ? row.state : 'blocked', classification: row.classification,
      endpoint: row.binding.endpoint, authContext: row.binding.authContext, requestRevision: row.binding.requestRevision,
      attempts: row.attempts, maxAttempts: row.maxAttempts, noInformation: row.noInformation, restriction: row.restriction,
      reason: row.reason || row.blockedReason };
  }) };
}
export function researchGroups(store, sessionId) {
  const context = readTaskContext(store, sessionId);
  const groups = new Map();
  for (const row of eligible(context, policy(store, sessionId))) {
    const evidence = row.researchGroup;
    const complete = evidence?.verified === true && ['function', 'inputStructure', 'permissionBoundary'].every(field => typeof evidence[field] === 'string' && evidence[field].trim() && evidence[field].length <= 500)
      && Array.isArray(evidence.evidenceIds) && new Set(evidence.evidenceIds).size >= 2 && evidence.evidenceIds.every(id => typeof id === 'string' && id.trim());
    const structure = row.inputs.map(input => [input.location, input.name]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const method = row.request.split(/\s+/)[0].toUpperCase();
    const groupKey = complete ? hash([new URL(row.endpoint).origin, row.authContext, method, structure, evidence.function, evidence.inputStructure, evidence.permissionBoundary]) : hash([row.id, row.revision]);
    if (!groups.has(groupKey)) groups.set(groupKey, { id: 'research-' + groupKey.slice(0, 16), confirmedGrouping: complete, members: [] });
    groups.get(groupKey).members.push({ requestId: row.id, requestRevision: row.revision, endpoint: row.endpoint, authContext: row.authContext });
  }
  const all = [...groups.values()].map(group => ({ ...group, representative: group.members[0], sharedOutcome: false }));
  return { total: all.length, groups: all.slice(0, 20), more: Math.max(0, all.length - 20),
    text: '按功能、输入结构和权限边界选择代表请求；分组只安排研究，不把一个入口的结果推给其他成员。未确认边界的请求保持独立。' };
}
export function createResearch(store, sessionId, input) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
  policy(store, sessionId);
  const id = key(input?.id, 'id');
  if (store.db.prepare('SELECT 1 FROM research_hypotheses WHERE session_id=? AND id=?').get(sessionId, id)) throw new Error('immutable hypothesis ID already exists; use a new ID');
  if (store.db.prepare('SELECT count(*) AS n FROM research_hypotheses WHERE session_id=?').get(sessionId).n >= 100) throw new Error('research hypothesis limit reached');
  const selected = { requestId: text(input.requestId, 'requestId'), requestRevision: text(input.requestRevision, 'requestRevision') };
  const row = baseline(store, sessionId, selected);
  if (input.question !== undefined) {
    const question = text(input.question, 'question', 600);
    input = { ...input, title: input.title || question,
      serverPath: input.serverPath || (row.request.split('\r\n')[0] + '; server implementation not yet established'),
      boundary: input.boundary || question,
      normalBehavior: input.normalBehavior || ('Recorded normal response: ' + row.response.split('\r\n')[0]),
      supportCriterion: input.supportCriterion || input.expectedEffect,
      falsifier: input.falsifier || input.negativeResult,
      nextInformation: input.nextInformation || input.nextStep,
      controlledInputs: input.controlledInputs || row.inputs.filter(field => field.evidenceIds?.includes(row.id)).map(({ name, location }) => ({ name, location })),
      knownCheck: input.knownCheck || { outcome: 'not-assessed', rationale: 'Business question; public-vulnerability novelty has not been assessed', sources: [] } };
  }
  if (!Array.isArray(input.controlledInputs) || !input.controlledInputs.length || input.controlledInputs.length > 20) throw new Error('controlled inputs required');
  const controlledInputs = input.controlledInputs.map(item => {
    if (!row.inputs.some(observed => observed.name === item.name && observed.location === item.location && observed.evidenceIds?.includes(row.id))) throw new Error('controlled input must be observed in selected baseline');
    return { name: text(item.name, 'input.name'), location: item.location };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (new Set(controlledInputs.map(item => JSON.stringify(item))).size !== controlledInputs.length) throw new Error('duplicate controlled input');
  const fields = Object.fromEntries(['title', 'serverPath', 'boundary', 'normalBehavior', 'supportCriterion', 'falsifier', 'nextInformation'].map(field => [field, text(input[field], field)]));
  const maxAttempts = input.maxAttempts ?? 4, noInformationLimit = input.noInformationLimit ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 || !Number.isInteger(noInformationLimit) || noInformationLimit < 1 || noInformationLimit > 3) throw new Error('invalid bounded hypothesis budget');
  const record = { id, ...fields, entryKey: entryKey(row), controlledInputs, knownCheck: knownCheck(input.knownCheck), maxAttempts, noInformationLimit,
    binding: { ...selected, endpoint: row.endpoint, authContext: row.authContext, digest: baselineHash(row) },
    attempts: 0, noInformation: 0, state: 'active', classification: 'unconfirmed-anomaly', reason: '', createdAt: new Date().toISOString() };
  // Relabelling the same baseline or revision is not new target evidence.
  const directionKey = hash([row.endpoint, row.authContext, row.request, row.response, controlledInputs,
    fields.serverPath, fields.boundary, fields.normalBehavior, fields.supportCriterion, fields.falsifier]);
  if (store.db.prepare('SELECT 1 FROM research_hypotheses WHERE session_id=? AND direction_key=?').get(sessionId, directionKey)) throw new Error('same research direction already recorded; changing ID cannot reset attempts');
  store.db.prepare('INSERT INTO research_hypotheses (session_id,id,direction_key,record) VALUES (?,?,?,?)').run(sessionId, id, directionKey, JSON.stringify(record));
  store.db.exec('COMMIT');
  return researchDetail(store, sessionId, id);
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
function capture(input, label) {
  if (!input || typeof input !== 'object') throw new Error(label + ' request/response required');
  const request = text(input.request, label + '.request', 65536), response = text(input.response, label + '.response', 65536);
  if (!/^[A-Z]+\s+\S+\s+HTTP\/\S+/i.test(request) || !/^HTTP\/\S+\s+\d{3}\b/i.test(response)) throw new Error(label + ' needs HTTP request and response');
  return { request, response, sha256: hash([request, response]) };
}
function sameRequestBoundary(captured, binding) {
  const line = captured.request.split(/\r?\n/)[0].split(/\s+/);
  const url = new URL(binding.endpoint), target = new URL(line[1], url);
  const host = captured.request.match(/^Host:\s*([^\r\n]+)/im)?.[1]?.trim();
  if (target.origin !== url.origin || target.pathname !== url.pathname || (host && host.toLowerCase() !== url.host.toLowerCase())) throw new Error('captured request crosses selected endpoint boundary');
}
export function observeResearch(store, sessionId, id, input) {
  policy(store, sessionId);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const record = raw(store, sessionId, id);
    baseline(store, sessionId, record.binding);
    if (record.state !== 'active') throw new Error('research direction closed; cannot reopen or reset attempts');
    const observationId = key(input?.id, 'observation.id');
    if (store.db.prepare('SELECT 1 FROM research_observations WHERE session_id=? AND hypothesis_id=? AND id=?').get(sessionId, id, observationId)) throw new Error('duplicate observation ID');
    if (!['support', 'counterevidence', 'difference', 'no-information', 'blocked'].includes(input.outcome)) throw new Error('invalid research observation outcome');
    if (input.outcome === 'difference' && !input.controlReceiptId) throw new Error('automatic difference needs host execution receipts');
    if (input.authContext !== record.binding.authContext || input.endpoint !== record.binding.endpoint) throw new Error('observation must bind the selected endpoint and identity');
    let receiptPair;
    if (input.controlReceiptId !== undefined || input.probeReceiptId !== undefined) {
      if (!input.controlReceiptId || !input.probeReceiptId || input.controlReceiptId === input.probeReceiptId) throw new Error('two distinct host execution receipts required');
      receiptPair = [input.controlReceiptId, input.probeReceiptId].map(receiptId => readExecutionReceipt(store, sessionId, receiptId));
      if (receiptPair.some(receipt => !receipt.current || receipt.hypothesisId !== id || receipt.endpoint !== record.binding.endpoint
        || receipt.authContext !== record.binding.authContext || receipt.outcome !== 'response')) throw new Error('current complete host responses bound to this direction required');
    }
    const executedAt = receiptPair ? receiptPair.map(receipt => receipt.completedAt).sort().at(-1) : text(input.executedAt, 'executedAt');
    if (!Number.isFinite(Date.parse(executedAt)) || Date.parse(executedAt) > Date.now() + 60000) throw new Error('invalid executedAt');
    const packet = receipt => ({ request: receipt.request, response: receipt.responseHead + Buffer.from(receipt.responseBodyBase64, 'base64').toString() });
    const control = capture(receiptPair ? packet(receiptPair[0]) : input.control, 'control'), probe = capture(receiptPair ? packet(receiptPair[1]) : input.probe, 'probe');
    sameRequestBoundary(control, record.binding); sameRequestBoundary(probe, record.binding);
    const normalControl = /^HTTP\/\S+\s+2\d\d\b/i.test(control.response);
    if (input.outcome !== 'blocked' && !normalControl) throw new Error('failed identity or control is blocked, not support or counterevidence');
    if (input.outcome === 'support' && (control.response === probe.response || (receiptPair
      && receiptPair[0].status === receiptPair[1].status && receiptPair[0].responseBodyBase64 === receiptPair[1].responseBodyBase64))) throw new Error('support needs an observed difference from normal control');
    const observation = { id: observationId, outcome: input.outcome, endpoint: input.endpoint, authContext: input.authContext, executedAt,
      noInformationBefore: record.noInformation,
      runner: receiptPair ? 'host-http-execution' : text(input.runner, 'runner'), expected: text(input.expected, 'expected'), observed: text(input.observed, 'observed'),
      evidenceOrigin: receiptPair ? 'host-http-execution' : 'submitted-packets',
      ...(receiptPair ? { controlReceiptId: receiptPair[0].id, probeReceiptId: receiptPair[1].id } : {}),
      ...(receiptPair ? { informationSignature: hash([input.outcome, ...receiptPair.map(receipt => [receipt.status, receipt.responseBodyBase64])]) } : {}),
      interpretation: text(input.interpretation, 'interpretation'), nextInformation: text(input.nextInformation, 'nextInformation'), control, probe };
    const previous = store.db.prepare('SELECT record FROM research_observations WHERE session_id=? AND hypothesis_id=? ORDER BY rowid').all(sessionId, id).map(row => JSON.parse(row.record));
    if (receiptPair && previous.some(row => receiptPair.some(receipt => [row.controlReceiptId, row.probeReceiptId].includes(receipt.id)))) throw new Error('host execution receipts already used in an observation');
    if (previous.some(row => receiptPair ? Date.parse(row.executedAt) > Date.parse(executedAt) : Date.parse(row.executedAt) >= Date.parse(executedAt))) throw new Error('repeat must be a separately recorded execution');
    const signature = value => value.informationSignature || hash([value.outcome, value.control.sha256, value.probe.sha256]);
    const newInformation = !previous.some(row => signature(row) === signature(observation)) && !['no-information', 'blocked'].includes(observation.outcome);
    record.attempts++;
    record.operationCalls = 0;
    record.noInformation = newInformation ? 0 : record.noInformation + 1;
    if (observation.outcome === 'counterevidence') { record.state = 'refuted'; record.reason = 'falsifier_observed'; }
    else if (observation.outcome === 'support' && previous.at(-1)?.outcome === 'support') {
      record.state = 'supported'; record.reason = 'repeat_with_normal_control';
      record.classification = ({ known: 'known-vulnerability', variant: 'new-variant', 'none-found': 'suspected-unpublished' })[record.knownCheck.outcome] || 'unconfirmed-anomaly';
    } else if (record.noInformation >= record.noInformationLimit) { record.state = 'stopped'; record.reason = 'no_new_information'; }
    else if (record.attempts >= record.maxAttempts) { record.state = 'stopped'; record.reason = 'hypothesis_budget_exhausted'; }
    store.db.prepare('INSERT INTO research_observations (session_id,hypothesis_id,id,record) VALUES (?,?,?,?)').run(sessionId, id, observationId, JSON.stringify(observation));
    write(store, sessionId, record);
    store.db.exec('COMMIT');
    return researchDetail(store, sessionId, id);
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
export function closeResearch(store, sessionId, id, reason, restriction) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
  const record = raw(store, sessionId, id);
  if (!['active', 'supported'].includes(record.state)) throw new Error('research direction already closed');
  if (restriction !== undefined && !['safety-policy', 'tool-policy'].includes(restriction)) throw new Error('invalid research restriction');
  record.state = restriction ? 'restricted' : 'stopped'; record.reason = text(reason, 'reason');
  if (restriction) record.restriction = { code: restriction, recordedAt: new Date().toISOString(),
    coverage: record.attempts ? 'partial' : 'not-executed', source: 'submitted-interruption-report',
    conclusion: 'unknown; restriction is neither counterevidence nor successful validation' };
  write(store, sessionId, record);
  store.db.exec('COMMIT');
  return researchDetail(store, sessionId, id);
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
export function assessResearch(store, sessionId, id, input) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const record = raw(store, sessionId, id); baseline(store, sessionId, record.binding);
    const observations = researchDetail(store, sessionId, id).observations, last = observations.at(-1);
    if (!last || last.id !== input.observationId || last.outcome !== 'difference' || last.evidenceOrigin !== 'host-http-execution'
      || last.assessment || !['active', 'supported'].includes(record.state)) throw new Error('assess the latest unassessed host comparison once; use observationId=' + (last?.id || '(no comparison captured)') + ', not document.id; an already assessed comparison cannot be assessed again');
    if (!['support', 'counterevidence', 'no-information'].includes(input.outcome)) throw new Error('invalid comparison assessment: outcome must be support, counterevidence or no-information; difference describes the raw observation only. Use observationId=' + last.id + ' and provide interpretation and nextInformation. No filesystem search or repeated request is needed.');
    for (const receiptId of [last.controlReceiptId, last.probeReceiptId]) if (!readExecutionReceipt(store, sessionId, receiptId).current) throw new Error('comparison evidence changed');
    last.assessment = { outcome: input.outcome, interpretation: text(input.interpretation, 'interpretation'),
      nextInformation: text(input.nextInformation, 'nextInformation'), at: new Date().toISOString(), source: 'submitted-business-interpretation, not verified impact' };
    record.nextInformation = last.assessment.nextInformation;
    if (input.outcome === 'counterevidence') { record.state = 'refuted'; record.reason = 'falsifier_observed'; }
    else if (input.outcome === 'no-information') {
      record.noInformation = Math.max(record.noInformation, (last.noInformationBefore || 0) + 1);
      if (record.noInformation >= record.noInformationLimit) { record.state = 'stopped'; record.reason = 'no_new_information'; }
    } else if (observations.at(-2)?.assessment?.outcome === 'support' || observations.at(-2)?.outcome === 'support') {
      record.state = 'supported'; record.reason = 'repeat_with_normal_control';
      record.classification = ({ known: 'known-vulnerability', variant: 'new-variant', 'none-found': 'suspected-unpublished' })[record.knownCheck.outcome] || 'unconfirmed-anomaly';
    }
    store.db.prepare('UPDATE research_observations SET record=? WHERE session_id=? AND hypothesis_id=? AND id=?').run(JSON.stringify(last), sessionId, id, last.id);
    write(store, sessionId, record); store.db.exec('COMMIT'); return researchDetail(store, sessionId, id);
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
export function researchOperationBlock(store, sessionId, { reserve = false } = {}) {
  const rows = store.db.prepare('SELECT id FROM research_hypotheses WHERE session_id=? ORDER BY rowid').all(sessionId);
  for (const { id } of rows) {
    const row = researchDetail(store, sessionId, id);
    if (!['active', 'supported'].includes(row.state) || !row.current) continue;
    if (row.observations.at(-1)?.outcome === 'difference' && !row.observations.at(-1).assessment) return 'comparison_interpretation_required：已有实际对照差异；先用redteam_research assess说明其业务含义，再继续原问题，不重复发包。';
    if ((row.operationCalls || 0) >= 2) return 'direction_observation_required：当前方向已执行两次目标工具操作；先记录实际正常对照与观察，或停止该方向，不能继续盲试。';
    if (reserve) { const record = raw(store, sessionId, id); record.operationCalls = (record.operationCalls || 0) + 1; write(store, sessionId, record); }
    return '';
  }
  return 'research_hypothesis_missing：用redteam_research登记当前请求的可证伪假设；已停止、被反证或基线失效的方向不能继续操作。';
}
export function researchNext(store, sessionId) {
  const rows = store.db.prepare('SELECT id FROM research_hypotheses WHERE session_id=? ORDER BY rowid').all(sessionId)
  const records = rows.map(({ id }) => researchDetail(store, sessionId, id))
  const active = records.find(row => row.current && ['active', 'supported'].includes(row.state))
  if (active) return { id: active.id, endpoint: active.binding.endpoint, authContext: active.binding.authContext,
    restrictedDirections: records.filter(row => row.state === 'restricted').length,
    action: active.observations.at(-1)?.outcome === 'difference' && !active.observations.at(-1).assessment ? 'interpret-recorded-comparison' : (active.operationCalls || 0) >= 2 ? 'record-observation-or-close' : active.state === 'supported' ? 'independently-verify-impact' : 'minimal-check-with-control',
    ...(active.observations.at(-1)?.outcome === 'difference' && !active.observations.at(-1).assessment ? { observationId: active.observations.at(-1).id } : {}),
    attempts: active.attempts, remaining: Math.max(0, active.maxAttempts - active.attempts), nextInformation: active.nextInformation }
  const context = readTaskContext(store, sessionId)
  const observed = eligible(context, policy(store, sessionId))
  const remaining = observed.filter(row => !records.some(record => record.entryKey
    ? record.entryKey === entryKey(row)
    : record.current && record.binding.requestId === row.id && record.binding.requestRevision === row.revision))
  return { action: remaining.length ? 'create-direction-on-observed-input' : 'collect-new-entry-or-record-gap',
    requests: remaining.slice(0, 8).map(row => ({ requestId: row.id, requestRevision: row.revision, endpoint: row.endpoint,
      authContext: row.authContext, inputs: row.inputs.map(input => ({ name: input.name, location: input.location })) })),
    moreRequests: Math.max(0, remaining.length - 8), closedDirections: records.filter(row => row.state !== 'active').length,
    restrictedDirections: records.filter(row => row.state === 'restricted').length,
    note: '当前方向结束不代表目标安全；新方向必须绑定实际正常请求与不同输入或边界。仅提交过的观察不能自行成为有效漏洞。' }
}
export function compactResearchResult(result) {
  if (!result.binding) return result;
  return { id: result.id, state: result.state, current: result.current, blockedReason: result.blockedReason,
    endpoint: result.binding.endpoint, authContext: result.binding.authContext, requestRevision: result.binding.requestRevision,
    attempts: result.attempts, maxAttempts: result.maxAttempts, noInformation: result.noInformation,
    observationCount: result.observations?.length || 0, lastOutcome: result.observations?.at(-1)?.assessment?.outcome || result.observations?.at(-1)?.outcome || '',
    lastEvidenceOrigin: result.observations?.at(-1)?.evidenceOrigin || '',
    classification: result.classification, noveltyProven: false, nextInformation: result.nextInformation,
    reason: result.reason, restriction: result.restriction, detail: 'redteam_research action=detail id=' + result.id };
}
export function hasResearch(store, sessionId) {
  return !!store.db.prepare('SELECT 1 FROM research_hypotheses WHERE session_id=? LIMIT 1').get(sessionId);
}
