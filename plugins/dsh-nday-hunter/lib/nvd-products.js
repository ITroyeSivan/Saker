// Native NVD affectedData: identities are source-authored names, never guessed
// aliases for CPE vendor/product strings. Inputs are conditional observations.
const status = value => value === 'affected' ? true : value === 'unaffected' ? false : null;
const validStatus = value => ['affected', 'unaffected', 'unknown'].includes(value);
const all = values => values.includes(false) ? false : values.includes(null) ? null : true;
const any = values => values.includes(true) ? true : values.includes(null) || !values.length ? null : false;
const string = (value, maximum = 2048) => typeof value === 'string' && !!value && value.length <= maximum;
const contextKeys = ['platforms', 'modules', 'programFiles', 'programRoutines'];
function upperCompare(version, bound, compare) {
  if (bound === '*') return -1;
  const branch = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?\.\*$/.exec(bound);
  if (branch) {
    const next = branch[2] === undefined ? `${BigInt(branch[1]) + 1n}.0.0-0` : `${branch[1]}.${BigInt(branch[2]) + 1n}.0-0`;
    return compare(version, next);
  }
  return compare(version, bound);
}
export function nativeVersionStatus(product, version, compare) {
  if (product.defaultStatus !== undefined && !validStatus(product.defaultStatus)) return null;
  if (product.versions === undefined) return status(product.defaultStatus);
  if (!Array.isArray(product.versions) || !product.versions.length) return null;
  if (!string(version, 1024)) return null;
  for (const entry of product.versions) {
    if (!entry || !string(entry.version, 1024) || !validStatus(entry.status)
      || entry.versionType !== undefined && !string(entry.versionType, 128)) return null;
    const exclusive = entry.lessThan !== undefined, inclusive = entry.lessThanOrEqual !== undefined;
    if (exclusive && inclusive) return null;
    if (!exclusive && !inclusive) {
      if (entry.changes !== undefined) return null;
      const equal = entry.versionType === 'semver' ? compare(version, entry.version) : version === entry.version ? 0 : entry.versionType === undefined ? 1 : null;
      if (equal === null) return null;
      if (equal === 0) return status(entry.status);
      continue;
    }
    if (entry.versionType !== 'semver' || compare(version, version) !== 0) return null;
    const bound = exclusive ? entry.lessThan : entry.lessThanOrEqual;
    if (!string(bound, 1024)) return null;
    const lower = entry.version === '0' ? 1 : compare(version, entry.version), upper = upperCompare(version, bound, compare);
    const order = entry.version === '0' ? -1 : upperCompare(entry.version, bound, compare);
    if (lower === null || upper === null || order === null || order > 0 || order === 0 && exclusive) return null;
    if (lower < 0 || (exclusive ? upper >= 0 : upper > 0)) continue;
    let value = status(entry.status);
    if (entry.changes !== undefined) {
      if (!Array.isArray(entry.changes) || !entry.changes.length) return null;
      const changes = entry.changes.slice();
      if (changes.some(change => !change || !validStatus(change.status) || compare(change.at, change.at) !== 0)) return null;
      changes.sort((a, b) => compare(a.at, b.at));
      for (let i = 0; i < changes.length; i++) {
        if (i && compare(changes[i - 1].at, changes[i].at) === 0 && changes[i - 1].status !== changes[i].status) return null;
        if (compare(changes[i].at, version) <= 0) value = status(changes[i].status);
      }
    }
    return value;
  }
  return status(product.defaultStatus);
}
function identity(product, fact) {
  // A registry identity is meaningful only inside its declared collection.
  if (product.packageURL !== undefined) return string(product.packageURL) && /^pkg:[a-z][a-z0-9.+-]*\/[^?#@]+(?:\?[^#]*)?(?:#.*)?$/.test(product.packageURL)
    ? fact.packageURL === undefined ? null : product.packageURL === fact.packageURL : null;
  if (product.collectionURL !== undefined || product.packageName !== undefined) {
    if (!string(product.collectionURL) || !string(product.packageName)) return null;
    return fact.collectionURL === undefined || fact.packageName === undefined ? null
      : product.collectionURL === fact.collectionURL && product.packageName === fact.packageName;
  }
  if (!string(product.vendor, 512) || !string(product.product)) return null;
  return fact.vendor === undefined || fact.product === undefined ? null : product.vendor === fact.vendor && product.product === fact.product;
}
function context(product, fact, evidence) {
  const values = [];
  for (const key of contextKeys) {
    if (product[key] === undefined || Array.isArray(product[key]) && !product[key].length) continue;
    const names = Array.isArray(product[key]) ? product[key].map(item => key === 'programRoutines' ? item?.name : item) : null;
    if (!names || names.some(name => !string(name, 4096))) { values.push(null); continue; }
    const observations = fact[key];
    if (!Array.isArray(observations) || !fact[key + 'EvidenceIds']?.length) { values.push(null); continue; }
    for (const id of fact[key + 'EvidenceIds']) evidence.add(id);
    if (names.some(name => observations.includes(name))) values.push(true);
    else if (fact[key + 'InventoryComplete'] === true && fact[key + 'InventoryEvidenceIds']?.length) {
      for (const id of fact[key + 'InventoryEvidenceIds']) evidence.add(id);
      values.push(false);
    } else values.push(null);
  }
  // CPE links in this format can name affected and unaffected products.
  // They do not replace the native version/status rules or prove presence.
  if (product.cpes !== undefined && (!Array.isArray(product.cpes) || product.cpes.length)) values.push(null);
  return all(values);
}
export function assessNativeProducts(providers, environment, compare) {
  const result = { state: 'unknown', reason: 'native-product-conditions-unknown', evaluatedConditions: 0, matches: [], evidenceIds: [] };
  if (!Array.isArray(providers) || !providers.length) return result;
  const facts = environment.products ?? [], evidence = new Set(), decisions = [], observations = new Map();
  const complete = environment.productInventoryComplete === true && environment.productInventoryEvidenceIds?.length;
  for (const provider of providers) {
    if (!string(provider?.source) || !Array.isArray(provider.affectedData) || !provider.affectedData.length) { decisions.push(null); continue; }
    for (const product of provider.affectedData) {
      result.evaluatedConditions++;
      if (!product || typeof product !== 'object') { decisions.push(null); continue; }
      // Validate the source identity even when the observed list is empty.
      if (identity(product, product) !== true) { decisions.push(null); continue; }
      const productDecisions = [];
      for (let i = 0; i < facts.length; i++) {
        const fact = facts[i], same = identity(product, fact);
        if (same === false) continue;
        if (same === null || !fact.evidenceIds?.length) { productDecisions.push(null); continue; }
        for (const id of fact.evidenceIds) evidence.add(id);
        const included = all([nativeVersionStatus(product, fact.version, compare), context(product, fact, evidence)]);
        productDecisions.push(included);
        const prior = observations.get(i) ?? []; prior.push(included); observations.set(i, prior);
        if (result.matches.length < 20) result.matches.push({ source: provider.source, vendor: product.vendor ?? '', product: product.product ?? product.packageName ?? product.packageURL ?? '',
          version: fact.version ?? '', state: included === true ? 'satisfied' : included === false ? 'not-applicable' : 'unknown' });
      }
      if (!productDecisions.length) {
        productDecisions.push(complete ? false : null);
        if (complete) for (const id of environment.productInventoryEvidenceIds) evidence.add(id);
      }
      decisions.push(any(productDecisions));
    }
  }
  const conflict = [...observations.values()].some(values => values.includes(true) && values.includes(false));
  const value = conflict ? null : any(decisions);
  result.state = value === true ? 'satisfied' : value === false ? 'not-applicable' : 'unknown';
  result.reason = conflict ? 'native-product-provider-conflict' : result.state === 'satisfied' ? 'observed-native-product-conditions-satisfied'
    : result.state === 'not-applicable' ? 'observed-native-product-conditions-excluded' : 'native-product-identity-version-context-or-inventory-unknown';
  result.evidenceIds = [...evidence].slice(0, 20); result.evidenceCount = evidence.size;
  Object.defineProperty(result, 'allEvidence', { value: [...evidence] });
  return result;
}
