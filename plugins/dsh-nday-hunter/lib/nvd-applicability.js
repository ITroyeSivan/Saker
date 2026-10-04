// NVD configuration logic with evidence-backed CPE observations. Every result
// is conditional on supplied inventory, not exploitation or execution proof.
import { assessNativeProducts } from './nvd-products.js';
const and = values => !values.length ? null : values.includes(false) ? false : values.includes(null) ? null : true;
const or = values => !values.length ? null : values.includes(true) ? true : values.includes(null) ? null : false;
const not = value => value === null ? null : !value;
const boundaries = ['versionStartIncluding', 'versionStartExcluding', 'versionEndIncluding', 'versionEndExcluding'];
export function parseCpe(value) {
  if (typeof value !== 'string' || value.length > 3000 || !value.startsWith('cpe:2.3:')) return null;
  const parts = [], units = []; let component = units;
  for (let i = 8; i < value.length; i++) {
    const character = value[i];
    if (character === ':') { parts.push(component); component = []; continue; }
    if (character === '\\') {
      if (++i === value.length) return null;
      if (!/^[\x21-\x7e]$/.test(value[i])) return null;
      component.push({ value: value[i], escaped: true });
    } else {
      if (!/^[A-Za-z0-9._*?-]$/.test(character)) return null;
      component.push({ value: character, escaped: false });
    }
  }
  parts.push(component);
  if (parts.length !== 11 || parts.some(part => !part.length)) return null;
  const result = parts.map(part => {
    const text = part.map(unit => unit.value).join('');
    if (part.length === 1 && !part[0].escaped && text === '*') return { kind: 'any', text };
    if (part.length === 1 && !part[0].escaped && text === '-') return { kind: 'na', text };
    const wildcard = part.some(unit => !unit.escaped && ['*', '?'].includes(unit.value));
    let pattern = null;
    if (wildcard) {
      const literal = unit => unit.escaped || !['*', '?'].includes(unit.value);
      const first = part.findIndex(literal), last = part.findLastIndex(literal);
      if (first < 0) return null;
      const validEdge = edge => !edge.length || edge.length === 1 && edge[0].value === '*' || edge.every(unit => unit.value === '?');
      if (!validEdge(part.slice(0, first)) || !validEdge(part.slice(last + 1))) return null;
      if (part.slice(first, last + 1).some(unit => !unit.escaped && ['*', '?'].includes(unit.value))) return null;
      const width = edge => edge.some(unit => unit.value === '*') ? Infinity : edge.length;
      pattern = { body: part.slice(first, last + 1).map(unit => unit.value).join('').toLowerCase(),
        prefix: width(part.slice(0, first)), suffix: width(part.slice(last + 1)) };
    }
    return { kind: wildcard ? 'pattern' : 'literal', text, pattern };
  });
  if (result.some(part => !part) || !['a', 'h', 'o', '*', '-'].includes(result[0].text.toLowerCase())) return null;
  return result;
}
function attribute(source, observed) {
  if (observed.kind === 'pattern') return null;
  if (source.kind === 'any') return true;
  if (observed.kind === 'any' || observed.kind === 'pattern') return null;
  if (source.kind === 'na') return observed.kind === 'na';
  if (observed.kind === 'na') return false;
  if (source.kind === 'pattern') {
    const target = observed.text.toLowerCase(), { body, prefix, suffix } = source.pattern;
    const minimum = Math.max(0, target.length - body.length - suffix), maximum = Math.min(prefix, target.length - body.length);
    const index = target.indexOf(body, minimum);
    return index >= minimum && index <= maximum;
  }
  return source.text.toLowerCase() === observed.text.toLowerCase();
}
function versionRange(match, observed, fact, compare) {
  if (!boundaries.some(key => match[key] !== undefined)) return true;
  if (observed.kind !== 'literal' || (match.versionStartIncluding !== undefined && match.versionStartExcluding !== undefined)
    || (match.versionEndIncluding !== undefined && match.versionEndExcluding !== undefined)) return null;
  const results = [];
  for (const key of boundaries) {
    const bound = match[key]; if (bound === undefined) continue;
    if (typeof bound !== 'string' || !bound || bound.length > 300) return null;
    const typed = fact.versionScheme === 'semver' && fact.versionSchemeEvidenceIds?.length;
    const equal = observed.text.toLowerCase() === bound.toLowerCase();
    const comparison = typed ? compare(observed.text, bound) : equal ? 0 : null;
    results.push(comparison === null ? null : key === 'versionStartIncluding' ? comparison >= 0
      : key === 'versionStartExcluding' ? comparison > 0 : key === 'versionEndIncluding' ? comparison <= 0 : comparison < 0);
  }
  return and(results);
}
function assessCpeConfigurations(document, environment, compare) {
  const result = { state: 'unknown', reason: 'source-conditions-missing', matches: [], evidenceIds: [], findingConfirmed: false,
    conditionalOnObservedInventory: true, format: 'nvd-cve-2.0', cpeCount: environment.cpes?.length ?? 0, assetId: environment.assetId ?? null };
  if (/rejected|withdrawn/i.test(document.vulnStatus ?? '')) return { ...result, reason: 'source-withdrawn' };
  if (!Array.isArray(document.configurations) || !document.configurations.length) return result;
  const evidence = new Set(), facts = (environment.cpes ?? []).map(fact => ({ ...fact, parsed: parseCpe(fact.cpe) }));
  const complete = environment.cpeInventoryComplete === true && environment.cpeInventoryEvidenceIds?.length;
  let evaluated = 0, positiveVulnerable = 0;
  function leaf(match, negative) {
    evaluated++;
    if (!match || typeof match.vulnerable !== 'boolean') return { value: null, witness: null };
    if (match.vulnerable && !negative) positiveVulnerable++;
    const criteria = parseCpe(match.criteria);
    const decisions = [];
    if (criteria) for (const fact of facts) {
      if (!fact.evidenceIds?.length) { decisions.push(null); continue; }
      const cpe = fact.parsed;
      if (!cpe) { decisions.push(null); continue; }
      const values = criteria.map((part, i) => attribute(part, cpe[i]));
      const identity = and(values);
      const included = identity === false ? false : and([identity, versionRange(match, cpe[3], fact, compare)]);
      decisions.push(included);
      if (identity !== false) {
        for (const id of fact.evidenceIds) evidence.add(id);
        for (const id of fact.versionSchemeEvidenceIds ?? []) evidence.add(id);
      }
    }
    // A matching observation proves presence. Absence needs a complete CPE
    // inventory; a partial list of nonmatches never proves absence.
    const value = !criteria ? null : decisions.includes(true) ? true : decisions.includes(null) ? null : complete ? false : null;
    if (complete) for (const id of environment.cpeInventoryEvidenceIds) evidence.add(id);
    const truth = negative ? not(value) : value;
    if (result.matches.length < 20) result.matches.push({ criteria: String(match.criteria ?? '').slice(0, 500), vulnerable: match.vulnerable,
      negated: negative, state: truth === true ? 'satisfied' : truth === false ? 'not-applicable' : 'unknown' });
    return { value: truth, witness: !negative && match.vulnerable ? truth : false };
  }
  function combine(children, operator) {
    const values = children.map(child => child.value), witnesses = children.map(child => child.witness);
    if (operator === 'OR') return { value: or(values), witness: or(witnesses) };
    if (operator === 'AND') { const value = and(values); return { value, witness: and([value, or(witnesses)]) }; }
    return { value: null, witness: null };
  }
  function node(node, inheritedNegative = false) {
    if (!node || typeof node !== 'object' || node.negate !== undefined && typeof node.negate !== 'boolean'
      || !['AND', 'OR'].includes(node.operator) || !Array.isArray(node.cpeMatch) || node.nodes !== undefined || node.children !== undefined)
      return { value: null, witness: null };
    const negative = inheritedNegative !== (node.negate === true);
    const operator = negative ? node.operator === 'AND' ? 'OR' : 'AND' : node.operator;
    return combine(node.cpeMatch.map(match => leaf(match, negative)), operator);
  }
  const configurations = document.configurations.map(configuration => {
    if (!Array.isArray(configuration.nodes) || !configuration.nodes.length || configuration.negate !== undefined && typeof configuration.negate !== 'boolean')
      return { value: null, witness: null };
    // The API permits an omitted configuration operator. With one child its
    // meaning is unambiguous; with several children do not invent a default.
    const authored = configuration.operator ?? (configuration.nodes.length === 1 ? 'OR' : null);
    const operator = configuration.negate === true ? authored === 'AND' ? 'OR' : authored === 'OR' ? 'AND' : null : authored;
    return combine(configuration.nodes.map(item => node(item, configuration.negate === true)), operator);
  });
  const value = or(configurations.map(configuration => configuration.witness));
  result.state = !positiveVulnerable ? 'unknown' : value === true ? 'satisfied' : value === false ? 'not-applicable' : 'unknown';
  result.reason = !positiveVulnerable ? 'no-positive-vulnerable-condition' : result.state === 'satisfied' ? 'observed-cpe-configuration-satisfied'
    : result.state === 'not-applicable' ? 'observed-cpe-configuration-excluded' : 'cpe-identity-version-inventory-or-operator-unknown';
  result.evaluatedConditions = evaluated; result.evidenceCount = evidence.size; result.evidenceIds = [...evidence].slice(0, 20);
  Object.defineProperty(result, 'allEvidence', { value: [...evidence] });
  return result;
}
export function assessNvdDocument(document, environment, compare) {
  const result = assessCpeConfigurations(document, environment, compare);
  if (/rejected|withdrawn/i.test(document.vulnStatus ?? '')) return result;
  const hasCpe = document.configurations !== undefined && (!Array.isArray(document.configurations) || !!document.configurations.length);
  const hasNative = document.affected !== undefined && (!Array.isArray(document.affected) || !!document.affected.length);
  const evidence = new Set(result.allEvidence ?? []);
  if (hasNative) {
    const native = assessNativeProducts(document.affected, environment, compare);
    result.channels = { cpe: hasCpe ? result.state : null, nativeProduct: native.state };
    result.productMatches = native.matches; result.productCount = environment.products?.length ?? 0;
    result.evaluatedConditions = (result.evaluatedConditions ?? 0) + native.evaluatedConditions;
    for (const id of native.allEvidence ?? native.evidenceIds) evidence.add(id);
    // The representations may carry complementary constraints. A native
    // product hit cannot bypass an unsatisfied CPE environment requirement.
    const disagreement = hasCpe && result.state !== native.state;
    result.state = !hasCpe ? native.state : disagreement ? 'unknown' : result.state;
    result.reason = !hasCpe ? native.reason : disagreement ? 'nvd-condition-channels-disagree-or-incomplete' : 'nvd-condition-channels-agree';
    result.nativeProductReason = native.reason;
  }
  if (!environment.assetId || !environment.assetEvidenceIds?.length) {
    result.state = 'unknown'; result.reason = 'assetId-and-assetEvidenceIds-required';
  } else {
    for (const id of environment.assetEvidenceIds) evidence.add(id);
  }
  result.evidenceCount = evidence.size; result.evidenceIds = [...evidence].slice(0, 20);
  return result;
}
