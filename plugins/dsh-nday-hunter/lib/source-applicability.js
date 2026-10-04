// Conditional static applicability, never execution or vulnerability proof.
// Ecosystem/GIT ranges require their native comparator/commit graph; treating
// those version strings as SemVer would create false exclusions.
import { assessNvdDocument, parseCpe } from './nvd-applicability.js';
function semver(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}
export function compareSemver(left, right) {
  const a = semver(left), b = semver(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] === undefined ? -1 : 1;
    if (a.pre[i] === b.pre[i]) continue;
    const x = /^\d+$/.test(a.pre[i]), y = /^\d+$/.test(b.pre[i]);
    if (x && y) return BigInt(a.pre[i]) < BigInt(b.pre[i]) ? -1 : 1;
    if (x !== y) return x ? -1 : 1;
    return a.pre[i] < b.pre[i] ? -1 : 1;
  }
  return 0;
}
function rangeContains(range, version) {
  if (range.type !== 'SEMVER' || !semver(version) || !Array.isArray(range.events) || !range.events.length) return null;
  const events = [];
  for (const event of range.events) {
    const keys = Object.keys(event);
    if (keys.length !== 1 || !['introduced', 'fixed', 'last_affected', 'limit'].includes(keys[0])) return null;
    const kind = keys[0], value = event[kind];
    if (!(kind === 'introduced' && value === '0') && !(kind === 'limit' && value === '*') && !semver(value)) return null;
    events.push({ kind, value });
  }
  if (!events.some(event => event.kind === 'introduced') || (events.some(event => event.kind === 'fixed') && events.some(event => event.kind === 'last_affected'))) return null;
  const limits = events.filter(event => event.kind === 'limit');
  if (limits.length && !limits.some(event => event.value === '*' || compareSemver(version, event.value) < 0)) return false;
  const timeline = events.filter(event => event.kind !== 'limit').sort((a, b) =>
    a.value === b.value ? 0 : a.kind === 'introduced' && a.value === '0' ? -1 : b.kind === 'introduced' && b.value === '0' ? 1 : compareSemver(a.value, b.value));
  // Contradictory transitions at identical precedence cannot establish a result.
  for (let i = 1; i < timeline.length; i++) if (timeline[i].kind !== timeline[i - 1].kind
    && timeline[i].value !== '0' && timeline[i - 1].value !== '0' && compareSemver(timeline[i].value, timeline[i - 1].value) === 0) return null;
  let affected = false;
  for (const event of timeline) {
    const comparison = event.kind === 'introduced' && event.value === '0' ? 1 : compareSemver(version, event.value);
    if (event.kind === 'introduced' && comparison >= 0) affected = true;
    else if (event.kind === 'fixed' && comparison >= 0) affected = false;
    else if (event.kind === 'last_affected' && comparison > 0) affected = false;
  }
  return affected;
}
function versionContains(affected, version) {
  if (typeof version !== 'string' || !version) return null;
  if (Array.isArray(affected.versions) && affected.versions.includes(version)) return true;
  const results = (affected.ranges ?? []).map(range => rangeContains(range, version));
  if (results.includes(true)) return true;
  if (results.includes(null)) return null;
  if (results.length || Array.isArray(affected.versions) && affected.versions.length) return false;
  return null;
}
export function assessSourceDocument(document, format, input) {
  if (Buffer.byteLength(typeof input === 'string' ? input : JSON.stringify(input) ?? '', 'utf8') > 256 * 1024) throw new Error('Environment exceeds 256 KiB');
  const supplied = typeof input === 'string' ? JSON.parse(input) : input;
  if (!supplied || typeof supplied !== 'object' || !Array.isArray(supplied.packages) && !Array.isArray(supplied.cpes) && !Array.isArray(supplied.products))
    throw new Error('environment needs packages, cpes or products arrays');
  const environment = { ...supplied, packages: supplied.packages ?? [], cpes: supplied.cpes ?? [], products: supplied.products ?? [] };
  if ([environment.packages, environment.cpes, environment.products].some(items => !Array.isArray(items) || items.length > 1000))
    throw new Error('environment inventory arrays support at most 1000 observed items');
  const validateEvidence = ids => { if (ids !== undefined && (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 200))) throw new Error('Invalid inventory evidence IDs'); };
  validateEvidence(environment.inventoryEvidenceIds);
  validateEvidence(environment.cpeInventoryEvidenceIds);
  validateEvidence(environment.productInventoryEvidenceIds);
  validateEvidence(environment.assetEvidenceIds);
  if (environment.assetId !== undefined && (typeof environment.assetId !== 'string' || !environment.assetId.trim() || environment.assetId.length > 160)) throw new Error('Invalid inventory assetId');
  for (const fact of environment.cpes) {
    if (!fact || !parseCpe(fact.cpe)) throw new Error('Invalid observed CPE 2.3 formatted name');
    if (fact.versionScheme !== undefined && !['semver'].includes(fact.versionScheme)) throw new Error('Unsupported observed CPE version scheme');
    validateEvidence(fact.evidenceIds); validateEvidence(fact.versionSchemeEvidenceIds);
    if (fact.assetId !== undefined && fact.assetId !== environment.assetId) throw new Error('Observed CPE belongs to a different asset');
  }
  for (const fact of environment.packages) {
    if (!fact || typeof fact.name !== 'string' || !fact.name || fact.name.length > 300 || typeof fact.ecosystem !== 'string' || !fact.ecosystem || fact.ecosystem.length > 100
      || fact.version !== undefined && (typeof fact.version !== 'string' || fact.version.length > 300)) throw new Error('Invalid observed package identity or version');
    validateEvidence(fact.evidenceIds);
  }
  for (const fact of environment.products) {
    if (!fact || typeof fact !== 'object') throw new Error('Invalid observed product identity');
    const identifiers = ['vendor', 'product', 'packageURL', 'collectionURL', 'packageName'];
    if (!identifiers.some(key => fact[key] !== undefined) || identifiers.some(key => fact[key] !== undefined && (typeof fact[key] !== 'string' || !fact[key] || fact[key].length > 2048))
      || fact.version !== undefined && (typeof fact.version !== 'string' || fact.version.length > 1024)) throw new Error('Invalid observed product identity or version');
    validateEvidence(fact.evidenceIds);
    if (fact.assetId !== undefined && fact.assetId !== environment.assetId) throw new Error('Observed product belongs to a different asset');
    for (const key of ['platforms', 'modules', 'programFiles', 'programRoutines']) {
      if (fact[key] !== undefined && (!Array.isArray(fact[key]) || fact[key].length > 1000 || fact[key].some(item => typeof item !== 'string' || !item || item.length > 4096))) throw new Error('Invalid observed product context');
      validateEvidence(fact[key + 'EvidenceIds']); validateEvidence(fact[key + 'InventoryEvidenceIds']);
    }
  }
  const result = { state: 'unknown', reason: 'native-format-pending', findingConfirmed: false, conditionalOnObservedInventory: true,
    format, packageCount: environment.packages.length, matches: [], evidenceIds: [] };
  if (format === 'nvd-cve-2.0') return assessNvdDocument(document, environment, compareSemver);
  if (format !== 'osv') return result;
  if (document.withdrawn) return { ...result, reason: 'source-withdrawn' };
  if (!Array.isArray(document.affected) || !document.affected.length) return { ...result, reason: 'source-conditions-missing' };
  const decisions = [], evidence = new Set();
  for (const affected of document.affected) {
    const pkg = affected.package;
    if (!pkg?.name || !pkg.ecosystem) { decisions.push(null); continue; }
    const facts = environment.packages.filter(fact => fact?.name === pkg.name && fact?.ecosystem === pkg.ecosystem);
    if (!facts.length) {
      const complete = environment.inventoryComplete === true && Array.isArray(environment.inventoryEvidenceIds) && environment.inventoryEvidenceIds.length;
      decisions.push(complete ? false : null);
      if (complete) for (const id of environment.inventoryEvidenceIds) evidence.add(id);
      continue;
    }
    for (const fact of facts) {
      const supported = Array.isArray(fact.evidenceIds) && fact.evidenceIds.length;
      const included = supported ? versionContains(affected, fact.version) : null;
      decisions.push(included);
      if (supported) for (const id of fact.evidenceIds) evidence.add(id);
      if (result.matches.length < 20) result.matches.push({ name: pkg.name, ecosystem: pkg.ecosystem, version: fact.version ?? '',
        state: included === true ? 'satisfied' : included === false ? 'not-applicable' : 'unknown' });
    }
  }
  result.state = decisions.includes(true) ? 'satisfied' : decisions.includes(null) ? 'unknown' : 'not-applicable';
  result.reason = result.state === 'satisfied' ? 'observed-version-in-source-range' : result.state === 'unknown' ? 'inventory-version-or-native-comparator-missing' : 'observed-inventory-outside-source-conditions';
  result.evidenceIds = [...evidence].slice(0, 20); result.evidenceCount = evidence.size; result.evaluatedConditions = decisions.length;
  return result;
}
