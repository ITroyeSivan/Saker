import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mergeAssets, normalizeAsset } from '../lib/asset-inventory.mjs';
import { groupServices } from '../plugins/dsh-nday-hunter/lib/service-groups.js';
import { buildAttackPlan } from '../plugins/dsh-nday-hunter/lib/plan.js';
import { recordGate, bucketGates } from '../plugins/dsh-nday-hunter/lib/gate.js';
const entry = { id: 'fixture', product: 'Fixture', aliases: ['fixture'], vulnClass: 'RCE', fingerprint: { probes: [{ weight: 'strong' }] } };
const identity = () => ({ id: 'deployment-1', deploymentRevision: 'r1', routingContext: 'tenant-1', authBoundary: 'realm-1',
  configDigest: 'a'.repeat(64), verified: true, evidenceIds: ['deployment-observation', 'independent-routing-observation'] });
const asset = (id, extra = {}) => ({ id, target: 'https://' + id + '.fixture.test', tech: ['fixture'], ...extra });
let failed = 0;
async function test(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.stack); } }
await test('shared IP Host path case protocol and query tenant boundaries remain independent in inventory', () => {
  const values = [asset('a', { target: 'http://a.test/App', ip: '127.0.0.1' }), asset('b', { target: 'http://b.test/App', ip: '127.0.0.1' }),
    asset('c', { target: 'http://a.test/app' }), asset('d', { target: 'https://a.test/App' }), asset('e', { target: 'http://a.test/App?tenant=2' }),
    asset('f', { target: 'http://127.0.0.1/App', host: 'alpha.test' }), asset('g', { target: 'http://127.0.0.1/App', host: 'beta.test' })];
  const merged = mergeAssets(null, values).inventory;
  assert.equal(merged.assets.length, 7);
  assert.equal(mergeAssets(merged, [values[0]]).inventory.assets.length, 7);
});
await test('product titles IP or incomplete claimed identity do not group independent applications', () => {
  const assets = [asset('a'), asset('b'), asset('c', { applicationIdentity: { id: 'same', verified: true } })];
  assert.equal(groupServices(assets).length, 3);
  const plan = buildAttackPlan([entry], assets);
  assert.equal(plan.buckets.length, 3); assert(plan.buckets.every(bucket => bucket.assetIds.length === 1));
});
await test('proven deployment identity groups aliases while config routing identity and revision changes split them', () => {
  const base = identity(), assets = [asset('a', { applicationIdentity: base }), asset('b', { applicationIdentity: base })];
  assert.equal(groupServices(assets).length, 1);
  assert.deepEqual(normalizeAsset(assets[0]).applicationIdentity, base);
  for (const field of ['id', 'deploymentRevision', 'routingContext', 'authBoundary', 'configDigest']) {
    const changed = { ...base, [field]: field === 'configDigest' ? 'b'.repeat(64) : 'other' };
    assert.equal(groupServices([assets[0], asset('b', { applicationIdentity: changed })]).length, 2);
  }
  assert.equal(groupServices([assets[0], asset('b', { applicationIdentity: { ...base, evidenceIds: ['same', 'same'] } })]).length, 2);
});
await test('representative calibration binds exact membership and deployment; old progress never unlocks a changed group', () => {
  const values = [asset('a', { applicationIdentity: identity() }), asset('b', { applicationIdentity: identity() })];
  const plan = buildAttackPlan([entry], values), bucket = plan.buckets[0];
  const saved = recordGate(plan, {}, { bucketId: bucket.bucketId, assetId: 'a', outcome: 'confirmed', evidence: 'actual-calibration-observation' });
  assert.equal(bucketGates(plan, saved.progress)[0].spreadAllowed, true);
  assert.equal(recordGate(plan, {}, { bucketId: bucket.bucketId, assetId: 'b', outcome: 'confirmed', evidence: 'not-representative' }).ok, false);
  const changed = buildAttackPlan([entry], [...values, asset('c', { applicationIdentity: identity() })]);
  assert.equal(bucketGates(changed, saved.progress)[0].spreadAllowed, false);
  const methodChanged = buildAttackPlan([{ ...entry, fingerprint: { probes: [{ path: '/new-check', weight: 'strong' }] } }], values);
  assert.equal(bucketGates(methodChanged, saved.progress)[0].spreadAllowed, false);
  const legacy = { buckets: [{ ...bucket, serviceSignature: undefined }] };
  assert.equal(bucketGates(legacy, saved.progress)[0].spreadAllowed, false);
  assert.deepEqual(bucket.independentChecks, ['current-identity', 'normal-request', 'applicability', 'target-impact']);
});
await test('real local virtual hosts with distinct response behavior survive inventory and need independent representatives', async () => {
  const server = http.createServer((req, res) => res.end(req.headers.host === 'alpha.fixture.test' ? 'fixture-alpha' : 'fixture-beta'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = 'http://127.0.0.1:' + server.address().port;
  try {
    const body = host => new Promise((resolve, reject) => http.get(target, { headers: { Host: host } }, res => { let text = ''; res.on('data', data => text += data); res.on('end', () => resolve(text)); }).on('error', reject));
    assert.notEqual(await body('alpha.fixture.test'), await body('beta.fixture.test'));
    const rows = ['alpha', 'beta'].map(id => asset(id, { target, host: id + '.fixture.test', ip: '127.0.0.1' }));
    const inventory = mergeAssets(null, rows).inventory;
    assert.equal(inventory.assets.length, 2); assert.equal(buildAttackPlan([entry], inventory.assets).buckets.length, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
process.exitCode = failed ? 1 : 0;
