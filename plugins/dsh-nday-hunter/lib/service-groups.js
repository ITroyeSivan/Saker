import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const bounded = value => typeof value === 'string' && value.trim() && value.length <= 300 && !/[\u0000-\u001f]/.test(value);
function applicationKey(asset) {
  const identity = asset.applicationIdentity;
  if (!identity || identity.verified !== true) return null;
  const fields = ['id', 'deploymentRevision', 'routingContext', 'authBoundary', 'configDigest'];
  if (!fields.every(field => bounded(identity[field])) || !/^[a-f0-9]{64}$/.test(identity.configDigest)) return null;
  if (!Array.isArray(identity.evidenceIds) || new Set(identity.evidenceIds.filter(bounded)).size < 2) return null;
  return JSON.stringify(fields.map(field => identity[field]));
}
export function groupServices(assets) {
  const groups = new Map(), ids = new Set();
  for (const asset of assets) {
    if (!bounded(asset.id) || ids.has(asset.id)) throw new Error('service grouping needs unique asset IDs');
    ids.add(asset.id);
    const identity = applicationKey(asset);
    const key = identity ? 'verified:' + identity : 'independent:' + asset.id;
    if (!groups.has(key)) groups.set(key, { key, identityConfirmed: !!identity, assets: [], evidenceIds: new Set() });
    const group = groups.get(key); group.assets.push(asset);
    for (const id of identity ? asset.applicationIdentity.evidenceIds : []) if (bounded(id)) group.evidenceIds.add(id);
  }
  return [...groups.values()].map(group => {
    group.assets.sort((a, b) => a.id.localeCompare(b.id));
    const membership = group.assets.map(asset => [asset.id, asset.target || asset.url || asset.host]);
    const signature = hash(JSON.stringify([group.key, membership]));
    return { id: 'service-' + signature.slice(0, 16), signature, assets: group.assets,
      representativeAssetId: group.assets[0].id, identityConfirmed: group.identityConfirmed,
      evidenceIds: [...group.evidenceIds], shareable: ['deployment-identity', 'reviewed-method-material'],
      independentChecks: ['current-identity', 'normal-request', 'applicability', 'target-impact'] };
  }).sort((a, b) => a.representativeAssetId.localeCompare(b.representativeAssetId));
}
