// Deterministic effect recipes operate on host executions, never model verdicts.
import { createHash, randomUUID } from 'node:crypto';
import { readExecutionReceipt, executionMethodBasis, requireFreshExecutions } from './execution-receipts.js';
import { readTaskContext } from './task-context.js';
export const EFFECT_VERIFICATION_SCHEMA = `CREATE TABLE IF NOT EXISTS effect_verifications (
 session_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(session_id,id)
);`;
const fail = message => { throw new Error(message); };
function pointer(value, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 200) fail('bounded JSON pointer required in reviewed effect specification');
  for (const segment of path.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, segment) || ['__proto__', 'constructor', 'prototype'].includes(segment)) fail('required effect field missing');
    value = value[segment];
  }
  return value;
}
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
function transportIdentity(receipt) {
  const values = [...receipt.request.matchAll(/^(authorization|cookie):\s*([^\r\n]+)$/gim)].map(match => [match[1].toLowerCase(), match[2].trim()]).sort();
  return values.length ? createHash('sha256').update(JSON.stringify(values)).digest('hex') : '';
}
function resourceRequest(receipt) {
  const [head, ...body] = receipt.request.split('\r\n\r\n');
  const [line, ...headers] = head.split('\r\n');
  if (!line.startsWith('GET ')) fail('protected read recipe requires GET executions');
  return JSON.stringify([line, headers.filter(header => !/^(authorization|cookie|connection|content-length):/i.test(header)).sort(), body.join('\r\n\r\n')]);
}
function fields(receipt, spec) {
  if (receipt.status < 200 || receipt.status >= 300) fail('normal owner or subject execution failed');
  if (!/^content-type:\s*application\/(?:[\w.+-]*\+)?json\b/im.test(receipt.responseHead)) fail('effect recipe requires JSON responses, not an HTML status page');
  let value;
  try { value = JSON.parse(Buffer.from(receipt.responseBodyBase64, 'base64').toString()); } catch { fail('invalid JSON effect response'); }
  const result = Object.fromEntries(['resourceId', 'ownerId', 'viewerId', 'visibility', 'readers', 'marker'].map(key => [key, pointer(value, spec[key + 'Path'])]));
  if (!identifier(result.resourceId) || !identifier(result.ownerId) || !identifier(result.viewerId) || result.visibility !== 'private'
    || !Array.isArray(result.readers) || result.readers.length > 100 || !result.readers.every(identifier)
    || !result.readers.includes(result.ownerId)) fail('observed object does not satisfy the reviewed private-owner ACL contract');
  if (typeof result.marker !== 'string' || !/^[A-Za-z0-9_-]{24,256}$/.test(result.marker)) fail('opaque owner response marker required');
  if ([result.resourceId, result.ownerId].includes(result.marker)) fail('public identifiers cannot be the private marker');
  return result;
}
function evaluate(store, sessionId, input, referenceTime = Date.now(), singleRound = false) {
  if (!Number.isFinite(referenceTime)) fail('invalid verification timestamp');
  const method = readTaskContext(store, sessionId)?.methods.find(row => row.id === input.methodId && row.version === input.methodVersion && row.reviewed === true);
  if (!method || method.effectSpec?.kind !== 'private-json-read/v1') fail('current reviewed private JSON read specification required');
  if (!Array.isArray(input.rounds) || input.rounds.length !== (singleRound ? 1 : 2)) fail('independently executed effect rounds required');
  const keys = ['owner', 'normal', 'probe', 'denied'];
  const ids = input.rounds.flatMap(round => keys.map(key => round[key]));
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== (singleRound ? 4 : 8)) fail('distinct host execution receipts required');
  const rounds = input.rounds.map(round => Object.fromEntries(keys.map(key => [key, readExecutionReceipt(store, sessionId, round[key])])));
  const methodBasis = executionMethodBasis(method);
  const comparisons = [], valueDigest = value => createHash('sha256').update(String(value)).digest('hex');
  let identity, ownerIdentity, protectedObject, subjectObject, credential, ownerCredential;
  for (const round of rounds) {
    requireFreshExecutions(Object.values(round), referenceTime);
    for (const receipt of Object.values(round)) {
      if (!receipt.current || receipt.source !== 'host-http-execution' || receipt.outcome !== 'response'
        || receipt.endpoint !== method.endpoint || receipt.methodId !== method.id || receipt.methodVersion !== method.version
        || receipt.methodBasis !== methodBasis) fail('current fresh complete executions of the reviewed method required');
    }
    const owner = fields(round.owner, method.effectSpec), normal = fields(round.normal, method.effectSpec), probe = fields(round.probe, method.effectSpec);
    const subjectAuth = transportIdentity(round.normal), probeAuth = transportIdentity(round.probe), ownerAuth = transportIdentity(round.owner);
    if (!subjectAuth || !ownerAuth || subjectAuth !== probeAuth || subjectAuth === ownerAuth || transportIdentity(round.denied)) fail('distinct owner/subject credentials and an anonymous denial control required');
    if (round.normal.authContext !== round.probe.authContext || round.owner.authContext === round.normal.authContext
      || round.normal.hypothesisId !== round.probe.hypothesisId) fail('effect identities and direction bindings differ');
    if (owner.viewerId !== owner.ownerId || normal.viewerId !== normal.ownerId || probe.viewerId !== normal.viewerId
      || owner.ownerId === normal.ownerId || owner.resourceId === normal.resourceId || owner.readers.includes(normal.ownerId)
      || probe.ownerId !== owner.ownerId || probe.resourceId !== owner.resourceId || probe.marker !== owner.marker
      || JSON.stringify([...probe.readers].sort()) !== JSON.stringify([...owner.readers].sort()) || normal.marker === owner.marker) fail('protected owner object was not independently disclosed to an excluded subject');
    if (![401, 403, 404].includes(round.denied.status) || Buffer.from(round.denied.responseBodyBase64, 'base64').toString().includes(owner.marker)) fail('anonymous control did not deny the protected object');
    if (resourceRequest(round.owner) !== resourceRequest(round.probe) || resourceRequest(round.owner) !== resourceRequest(round.denied)) fail('owner probe and denial must address the same protected resource');
    if (Object.values(round).some(receipt => receipt.request.includes(owner.marker) || receipt.request.includes(encodeURIComponent(owner.marker)))) fail('request reflection cannot prove a private object disclosure');
    if (identity !== undefined && (identity !== round.normal.authContext || ownerIdentity !== round.owner.authContext
      || protectedObject !== owner.resourceId || subjectObject !== normal.resourceId || credential !== subjectAuth || ownerCredential !== ownerAuth)) fail('repeat changed identities credentials or protected resource');
    identity = round.normal.authContext; ownerIdentity = round.owner.authContext;
    protectedObject = owner.resourceId; subjectObject = normal.resourceId; credential = subjectAuth; ownerCredential = ownerAuth;
    comparisons.push({ ownerStatus: round.owner.status, normalStatus: round.normal.status, probeStatus: round.probe.status, deniedStatus: round.denied.status,
      ownerMarkerSha256: valueDigest(owner.marker), probeMarkerSha256: valueDigest(probe.marker), normalMarkerSha256: valueDigest(normal.marker),
      ownerViewerSha256: valueDigest(owner.viewerId), normalViewerSha256: valueDigest(normal.viewerId), probeViewerSha256: valueDigest(probe.viewerId),
      protectedResourceSha256: valueDigest(owner.resourceId), normalResourceSha256: valueDigest(normal.resourceId),
      privateAclExcludesSubject: true, requestReflectionExcluded: true });
  }
  return { verified: true, kind: 'private-json-read/v1', proofKind: 'access', endpoint: method.endpoint, identity,
    methodId: method.id, methodVersion: method.version, methodBasis, receiptIds: ids,
    controlReceiptId: input.rounds.at(-1).normal, probeReceiptId: input.rounds.at(-1).probe, comparisons,
    evidenceLimit: 'Validates the reviewed private-owner/readers JSON contract at the recorded execution time; does not infer unknown ACL semantics, live credential health or RCE.' };
}
export function assessPrivateReadRound(store, sessionId, input) {
  try { evaluate(store, sessionId, input, Date.now(), true); return { supported: true }; }
  catch (error) { return { supported: false, reason: error.message }; }
}
export function verifyEffect(store, sessionId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 8192) fail('bounded effect verification document required');
  input = { methodId: input.methodId, methodVersion: input.methodVersion, rounds: input.rounds };
  let verdict;
  try { verdict = evaluate(store, sessionId, input); }
  catch (error) { verdict = { verified: false, kind: 'private-json-read/v1', reason: error.message, outcome: 'inconclusive' }; }
  const record = { id: 'effect-' + randomUUID(), source: 'host-effect-verifier', recordedAt: new Date().toISOString(), input, ...verdict };
  store.db.prepare('INSERT INTO effect_verifications (session_id,id,record) VALUES (?,?,?)').run(sessionId, record.id, JSON.stringify(record));
  return effectSummary(record);
}
export function readEffectVerification(store, sessionId, id) {
  const row = store.db.prepare('SELECT record FROM effect_verifications WHERE session_id=? AND id=?').get(sessionId, id);
  if (!row) fail('effect verification not found in current session');
  const record = JSON.parse(row.record);
  let currentVerdict;
  try { currentVerdict = evaluate(store, sessionId, record.input); }
  catch (error) { currentVerdict = { verified: false, reason: error.message }; }
  return { ...record, current: record.verified === true && currentVerdict.verified === true, currentReason: currentVerdict.reason || record.reason || '' };
}
export function effectSummary(record) {
  const { input, comparisons, ...summary } = record;
  return { ...summary, detail: 'redteam_execution action=effect-detail id=' + record.id };
}
