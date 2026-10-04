// Evidence references and immutable packet/method bytes bind cache reuse.
// This proves equality of recorded evidence, not the truth of its interpretation.
import { createHash } from 'node:crypto';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
const ids = values => [...new Set(values || [])].sort();
const url = value => { const parsed = new URL(value); parsed.hash = ''; return parsed.href; };
export function verificationBasis(check, context) {
  const asset = context?.assets?.find(row => row.id === check.assetId);
  if (!asset) return null;
  const requests = (context.requests || []).filter(row => url(row.endpoint) === url(check.endpoint)
    && row.authContext === check.authContext && row.revision === check.requestRevision
    && check.baselineEvidenceIds?.includes(row.id)).map(row => ({ id: row.id, revision: row.revision,
      endpoint: url(row.endpoint), authContext: row.authContext, valid: row.valid,
      request: row.request, response: row.response, inputs: row.inputs }));
  const methods = (context.methods || []).filter(row => row.id === (check.methodId || check.entryId)
    && row.version === check.methodVersion).map(({ reviewedAt, reviewer, reviewNotes, ...row }) => row);
  const basis = { asset: { id: asset.id, url: url(asset.url), inScope: asset.inScope, reachable: asset.reachable,
    hostHeader: asset.hostHeader, product: asset.product, version: asset.version, title: asset.title, tech: asset.tech },
    check: { assetId: check.assetId, entryId: check.entryId, endpoint: url(check.endpoint), methodVersion: check.methodVersion,
      methodId: check.methodId || check.entryId, authContext: check.authContext, requestRevision: check.requestRevision,
      productConfirmed: check.productConfirmed, productEvidenceIds: ids(check.productEvidenceIds),
      requestValid: check.requestValid, baselineEvidenceIds: ids(check.baselineEvidenceIds), methodReviewed: check.methodReviewed,
      conditions: (check.conditions || []).map(row => ({ ...row, evidenceIds: ids(row.evidenceIds) }))
        .sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b)))) },
    requests: requests.sort((a, b) => a.id.localeCompare(b.id)), methods };
  return 'saker-verification-basis/1:' + createHash('sha256').update(JSON.stringify(canonical(basis))).digest('hex');
}
