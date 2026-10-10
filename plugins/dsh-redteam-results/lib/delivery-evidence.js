import { readExecutionReceipt, executionMethodBasis, requireFreshExecutions } from './execution-receipts.js';
import { readTaskContext } from './task-context.js';
import { parseReproduction, deliveryMaterialDigest } from './delivery.js';
import { readEffectVerification } from './effect-verifications.js';
import { readImpactReview } from './impact-reviews.js';

// This derived DTO is never accepted by finding register/update parameters.
// Existing claimed verification remains history; current host evidence is read separately.
export function attachDeliveryEvidence(store, sessionId, finding) {
  const row = { ...finding, sessionId };
  let verified = false, reason = '', receiptIds = [], impactVerified = false, impactReason = 'Independent effect verification missing', effectId = '', effectEvidence;
  try {
    const method = parseReproduction(row.reproduction);
    if (method.kind !== 'method') throw new Error('HTTP receipts cannot verify execution of a generated script');
    const { controlReceiptId, probeReceiptId } = method.verification;
    if (!controlReceiptId || !probeReceiptId || controlReceiptId === probeReceiptId) throw new Error('two distinct host receipts required');
    const currentMethod = readTaskContext(store, sessionId)?.methods.find(item => item.id === method.methodId && item.version === method.methodVersion && item.reviewed === true);
    if (!currentMethod) throw new Error('current reviewed reproduction method required');
    const [control, probe] = [controlReceiptId, probeReceiptId].map(id => readExecutionReceipt(store, sessionId, id));
    requireFreshExecutions([control, probe]);
    if ([control, probe].some(receipt => receipt.source !== 'host-http-execution' || receipt.current !== true || receipt.outcome !== 'response'
      || receipt.endpoint !== method.endpoint || receipt.authContext !== row.identity) || control.hypothesisId !== probe.hypothesisId) throw new Error('current complete execution pair does not match finding endpoint and identity');
    if ([control, probe].some(receipt => receipt.methodId !== method.methodId || receipt.methodVersion !== method.methodVersion
      || receipt.methodBasis !== executionMethodBasis(currentMethod))) throw new Error('execution receipts do not match current reproduction method');
    if (control.status < 200 || control.status >= 300) throw new Error('normal execution control failed');
    const response = probe.responseHead + Buffer.from(probe.responseBodyBase64, 'base64').toString();
    // Findings retain a trimmed display packet; originals stay in the receipt.
    if (row.requestPkt !== probe.request.trim() || row.responsePkt !== response.trim()) throw new Error('finding packets differ from host execution');
    verified = true; receiptIds = [control.id, probe.id];
    if (method.verification.effectReceiptId) {
      const effect = readEffectVerification(store, sessionId, method.verification.effectReceiptId);
      if (!effect.verified || !effect.current || effect.source !== 'host-effect-verifier' || effect.proofKind !== row.proofKind
        || effect.endpoint !== method.endpoint || effect.identity !== row.identity || effect.methodId !== method.methodId
        || effect.methodVersion !== method.methodVersion || effect.controlReceiptId !== control.id || effect.probeReceiptId !== probe.id) {
        impactReason = effect.currentReason || 'Effect verification does not match finding';
      } else { impactVerified = true; effectId = effect.id; impactReason = '';
        effectEvidence = { source: effect.source, id: effect.id, kind: effect.kind, proofKind: effect.proofKind,
          methodId: effect.methodId, methodVersion: effect.methodVersion, receiptIds: effect.receiptIds, comparisons: effect.comparisons, evidenceLimit: effect.evidenceLimit };
      }
    }
  } catch (error) { reason = error.message; }
  row.executionEvidence = { source: 'host-derived-delivery-evidence', verified, reason, receiptIds,
    binding: deliveryMaterialDigest(row), impactVerified, effectId, effectEvidence, impactReason };
  if (verified && !impactVerified) {
    const review = readImpactReview(store, sessionId, row);
    if (review?.current) { row.executionEvidence.impactVerified = true; row.executionEvidence.impactReason = ''; row.executionEvidence.effectEvidence = review; }
    else if (review) row.executionEvidence.impactReason = review.reason;
  }
  row.delivery = undefined;
  return row;
}
