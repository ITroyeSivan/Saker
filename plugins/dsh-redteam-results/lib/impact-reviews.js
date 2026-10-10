// Explicit Desktop review is a human judgment, not an automated effect verifier.
import { deliveryMaterialDigest, parseReproduction } from './delivery.js';
import { readExecutionReceipt, requireFreshExecutions } from './execution-receipts.js';
export const IMPACT_REVIEW_SCHEMA = `CREATE TABLE IF NOT EXISTS impact_reviews (
 session_id TEXT NOT NULL, finding_id TEXT NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(session_id,finding_id));`;
function validate(store, sid, finding, review) {
  if (review.source !== 'desktop-impact-review' || review.binding !== deliveryMaterialDigest(finding)
    || review.proofKind !== finding.proofKind || !['access', 'write', 'other-impact'].includes(review.proofKind)) throw new Error('Desktop review no longer matches this finding');
  if (!Array.isArray(review.receiptIds) || new Set(review.receiptIds).size !== review.receiptIds.length
    || review.receiptIds.length < (review.proofKind === 'write' ? 4 : 2) || review.receiptIds.length > 12) throw new Error('distinct current effect receipts required');
  const receipts = review.receiptIds.map(id => readExecutionReceipt(store, sid, id));
  requireFreshExecutions(receipts);
  if (receipts.some(receipt => !receipt.current || receipt.source !== 'host-http-execution' || receipt.outcome !== 'response'
    || new URL(receipt.endpoint).origin !== new URL(parseReproduction(finding.reproduction).endpoint).origin)) throw new Error('effect review needs current complete same-site host receipts');
  if (!finding.executionEvidence?.verified || !finding.executionEvidence.receiptIds.every(id => review.receiptIds.includes(id))) throw new Error('include the finding\'s actual normal/probe executions');
  if (!review.permissionsConfirmed || !review.impactConfirmed || (review.proofKind === 'write' && !review.restorationConfirmed)) throw new Error('confirm actual permission, effect, and write restoration');
  if (typeof review.note !== 'string' || review.note.trim().length < 40 || review.note.length > 3000) throw new Error('record 40..3000 characters describing roles, objects, actual effect, and limits');
  if (review.proofKind === 'write' && receipts.filter(receipt => /^GET /i.test(receipt.request) && receipt.status >= 200 && receipt.status < 300).length < 2) throw new Error('write review needs two successful readbacks for the observed effect and restoration');
  return { receiptIds: review.receiptIds, kind: 'desktop-reviewed-' + review.proofKind, source: review.source,
    proofKind: review.proofKind, note: review.note, recordedAt: review.recordedAt,
    evidenceLimit: 'Explicit Desktop operator review of saved evidence; not an automated semantic check, credential health check or RCE proof.' };
}
export function recordImpactReview(store, sid, finding, input, source) {
  if (source !== 'desktop-action') throw new Error('impact review is available only through the Desktop result action');
  const review = { source: 'desktop-impact-review', binding: deliveryMaterialDigest(finding), proofKind: finding.proofKind,
    receiptIds: input.receiptIds, permissionsConfirmed: input.permissionsConfirmed === true, impactConfirmed: input.impactConfirmed === true,
    restorationConfirmed: input.restorationConfirmed === true, note: input.note, recordedAt: new Date().toISOString() };
  const evidence = validate(store, sid, finding, review);
  store.db.prepare('INSERT INTO impact_reviews(session_id,finding_id,record) VALUES(?,?,?) ON CONFLICT(session_id,finding_id) DO UPDATE SET record=excluded.record')
    .run(sid, finding.id, JSON.stringify(review));
  return evidence;
}
export function readImpactReview(store, sid, finding) {
  const row = store.db.prepare('SELECT record FROM impact_reviews WHERE session_id=? AND finding_id=?').get(sid, finding.id);
  if (!row) return null;
  try { return { current: true, ...validate(store, sid, finding, JSON.parse(row.record)) }; }
  catch (error) { return { current: false, reason: error.message }; }
}
