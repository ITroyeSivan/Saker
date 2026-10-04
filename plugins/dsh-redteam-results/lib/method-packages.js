// Immutable offline method material. Importing it never executes code or installs dependencies.
import crypto from 'node:crypto';
import { assertNoLiteralCredentials } from './bundle.js';

export const METHOD_PACKAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS method_packages (
 id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
 document TEXT NOT NULL, imported_at TEXT NOT NULL, PRIMARY KEY(id,version)
);
CREATE TABLE IF NOT EXISTS method_package_reviews (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, digest TEXT NOT NULL, kind TEXT NOT NULL,
 actor TEXT NOT NULL, record TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS method_package_active (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS method_package_history (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, previous_digest TEXT NOT NULL,
 digest TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, recorded_at TEXT NOT NULL
);`;
const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const HASH = /^[a-f0-9]{64}$/;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function text(value, label, limit = 16000) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit || value.includes('\0')) throw new Error(label + ' requires bounded nonempty text');
  return value;
}
function array(value, label, min = 1, max = 100) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(label + ' requires ' + min + '..' + max + ' items');
  return value;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' requires an object');
  return value;
}
export function canonicalMethod(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalMethod).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalMethod(value[key])).join(',') + '}';
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('method document must be lossless JSON');
  return JSON.stringify(value);
}
function sourceUrl(value) {
  const url = new URL(text(value, 'source.url', 2000));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid source URL');
}
function filePath(value) {
  text(value, 'file.path', 240);
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('/') || value.includes('//') || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('unsafe method file path');
}
export function normalizeMethodPackage(input) {
  // Round-trip first: prototypes and references cannot become part of an offline package.
  const raw = typeof input === 'string' ? input : canonicalMethod(input);
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('method package exceeds 2MB');
  const doc = object(JSON.parse(raw), 'method package');
  if (doc.schema !== 'saker.method-package/1' || typeof doc.id !== 'string' || typeof doc.version !== 'string' || !ID.test(doc.id) || !ID.test(doc.version)) throw new Error('invalid method schema/id/version');
  text(doc.title, 'title', 300);
  array(doc.products, 'products').forEach(value => text(value, 'product', 300));
  text(doc.mechanism, 'mechanism');
  array(doc.applicability, 'applicability').forEach(condition => {
    object(condition, 'condition'); text(condition.name, 'condition.name', 300); text(condition.requiredEvidence, 'condition.requiredEvidence');
  });
  object(doc.discovery, 'discovery'); array(doc.discovery.fingerprints, 'fingerprints');
  object(doc.detection, 'detection');
  for (const field of ['baseline', 'control', 'criterion']) text(doc.detection[field], 'detection.' + field);
  array(doc.detection.requests, 'detection.requests').forEach(request => {
    object(request, 'request'); text(request.id, 'request.id', 100); text(request.method, 'request.method', 30); text(request.target, 'request.target', 2000);
    // Preserve request order, variables, encoding, OOB and matcher semantics verbatim.
    array(request.matchers, 'request.matchers');
  });
  object(doc.exploitation, 'exploitation');
  for (const field of ['identity', 'successCriterion', 'recovery']) text(doc.exploitation[field], 'exploitation.' + field);
  array(doc.exploitation.steps, 'exploitation.steps').forEach(value => text(value, 'step'));
  array(doc.exploitation.parameters, 'parameters', 0);
  array(doc.dependencies, 'dependencies', 0).forEach(dependency => {
    object(dependency, 'dependency'); for (const field of ['name', 'version', 'instructions']) text(dependency[field], 'dependency.' + field);
    sourceUrl(dependency.source);
  });
  object(doc.evidence, 'evidence');
  for (const field of ['mechanism', 'impact', 'limitations']) text(doc.evidence[field], 'evidence.' + field);
  array(doc.sources, 'sources').forEach(source => {
    object(source, 'source'); sourceUrl(source.url);
    for (const field of ['revision', 'license', 'retrieval']) text(source[field], 'source.' + field);
    if (!HASH.test(source.sha256)) throw new Error('source must pin a SHA256 content digest');
  });
  object(doc.maintenance, 'maintenance');
  array(doc.maintenance.changes, 'changes').forEach(value => text(value, 'change'));
  array(doc.maintenance.recheckConditions, 'recheckConditions').forEach(value => text(value, 'recheck condition'));
  const paths = new Set();
  array(doc.files, 'files', 0, 40).forEach(file => {
    object(file, 'file'); filePath(file.path);
    const key = file.path.toLowerCase(); if (paths.has(key)) throw new Error('duplicate method file path'); paths.add(key);
    text(file.content, 'file.content', 262144); text(file.license, 'file.license');
    if (file.redistribute !== true) throw new Error('nonredistributable code must remain a pinned source reference');
    if (file.sha256 !== sha(file.content)) throw new Error('method file digest mismatch');
    assertNoLiteralCredentials({ kind: 'script', code: file.content, runCommand: '' });
  });
  if (doc.exploitation.file && !doc.files.some(file => file.path === doc.exploitation.file)) throw new Error('exploitation file missing from package');
  assertNoLiteralCredentials({ kind: 'script', code: JSON.stringify(doc.detection.requests) + '\n' + doc.exploitation.steps.join('\n'), runCommand: '' });
  return doc;
}
function transaction(store, fn) {
  store.db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); store.db.exec('COMMIT'); return value; }
  catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
export function stageMethodPackage(store, input) {
  const document = normalizeMethodPackage(input), encoded = canonicalMethod(document), digest = sha(encoded);
  return transaction(store, () => {
    const old = store.db.prepare('SELECT digest FROM method_packages WHERE id=? AND version=?').get(document.id, document.version);
    if (old && old.digest !== digest) throw new Error('immutable method version changed; use a new version');
    store.db.prepare('INSERT OR IGNORE INTO method_packages VALUES (?,?,?,?,?)').run(document.id, document.version, digest, encoded, new Date().toISOString());
    return { id: document.id, version: document.version, digest, status: methodPackageState(store, digest).status };
  });
}
export function readMethodPackage(store, digest) {
  if (!HASH.test(digest)) throw new Error('exact method digest required');
  const row = store.db.prepare('SELECT * FROM method_packages WHERE digest=?').get(digest);
  if (!row) throw new Error('method package not found');
  if (sha(row.document) !== row.digest) throw new Error('stored method digest mismatch');
  const document = normalizeMethodPackage(row.document);
  return { id: row.id, version: row.version, digest: row.digest, document };
}
function latest(store, digest, kind) {
  const row = store.db.prepare('SELECT actor,record FROM method_package_reviews WHERE digest=? AND kind=? ORDER BY seq DESC LIMIT 1').get(digest, kind);
  // Actor comes from the execution channel, never from user-supplied receipt JSON.
  return row ? { ...JSON.parse(row.record), actor: row.actor } : null;
}
export function methodPackageState(store, digest) {
  const record = readMethodPackage(store, digest);
  const review = latest(store, digest, 'review') || latest(store, digest, 'review-proposal'), verification = latest(store, digest, 'verification');
  const trusted = review?.decision === 'approved' && review.actor === 'desktop-user' && verification?.result === 'passed';
  const activeDigest = store.db.prepare('SELECT digest FROM method_package_active WHERE id=?').get(record.id)?.digest || '';
  const active = activeDigest === digest;
  return { id: record.id, version: record.version, digest, status: review?.decision === 'rejected' && review.actor === 'desktop-user' ? 'rejected' : trusted ? 'trusted' : 'pending',
    active: active && trusted, activeDigest, review, verification };
}
function artifact(input, label) {
  object(input, label); text(input.content, label + '.content', 131072);
  if (input.sha256 !== sha(input.content)) throw new Error(label + ' evidence digest mismatch');
}
export function recordMethodReview(store, digest, kind, input, actor) {
  text(actor, 'actor', 200); object(input, 'review record');
  const pkg = readMethodPackage(store, digest);
  if (input.methodDigest !== digest) throw new Error('review must reference exact method digest');
  text(input.notes, 'review notes');
  if (kind === 'review') {
    if (!['approved', 'rejected'].includes(input.decision)) throw new Error('invalid review decision');
    text(input.reviewer, 'reviewer', 200);
  } else if (kind === 'verification') {
    if (!['passed', 'failed'].includes(input.result)) throw new Error('invalid test result');
    for (const field of ['environment', 'runnerVersion', 'executedAt']) text(input[field], field, 2000);
    if (!Number.isFinite(Date.parse(input.executedAt))) throw new Error('invalid execution timestamp');
    for (const field of ['positive', 'negative']) {
      object(input[field], field);
      text(input[field].expected, field + '.expected'); text(input[field].observed, field + '.observed');
      artifact(input[field].request, field + '.request'); artifact(input[field].response, field + '.response');
      if (input.result === 'passed' && input[field].matched !== true) throw new Error('passing test requires both positive and control judgments');
    }
    if (input.positive.response.sha256 === input.negative.response.sha256) throw new Error('positive and control require distinct observations');
    array(input.dependencies, 'tested dependencies', 0).forEach(item => object(item, 'tested dependency'));
    for (const dependency of pkg.document.dependencies) {
      if (!input.dependencies.some(item => item.name === dependency.name && item.version === dependency.version && item.validated === true)) throw new Error('dependency version not validated');
    }
  } else throw new Error('invalid review kind');
  const encoded = canonicalMethod(input);
  if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('review receipt exceeds 1MB');
  return transaction(store, () => {
    const storedKind = kind === 'review' && actor !== 'desktop-user' ? 'review-proposal' : kind;
    store.db.prepare('INSERT INTO method_package_reviews(digest,kind,actor,record,recorded_at) VALUES (?,?,?,?,?)').run(digest, storedKind, actor, encoded, new Date().toISOString());
    const state = methodPackageState(store, digest);
    if (state.status !== 'trusted' && store.db.prepare('SELECT digest FROM method_package_active WHERE id=?').get(pkg.id)?.digest === digest) {
      store.db.prepare('DELETE FROM method_package_active WHERE id=?').run(pkg.id);
      history(store, pkg.id, digest, '', 'withdraw', actor);
    }
    return state;
  });
}
function history(store, id, previous, digest, action, actor) {
  store.db.prepare('INSERT INTO method_package_history(id,previous_digest,digest,action,actor,recorded_at) VALUES (?,?,?,?,?,?)').run(id, previous, digest, action, actor, new Date().toISOString());
}
export function activateMethodPackage(store, digest, expectedDigest, actor, rollback = false) {
  if (actor !== 'desktop-user') throw new Error('activation requires an explicit Desktop review action');
  if (typeof expectedDigest !== 'string' || expectedDigest && !HASH.test(expectedDigest)) throw new Error('expected current digest required (empty for first activation)');
  return transaction(store, () => {
    const state = methodPackageState(store, digest);
    if (state.status !== 'trusted') throw new Error('method needs Desktop static approval and positive/control test evidence');
    const current = store.db.prepare('SELECT digest FROM method_package_active WHERE id=?').get(state.id)?.digest || '';
    if (current !== expectedDigest) throw new Error('active method changed; refresh before activation');
    if (rollback && !store.db.prepare("SELECT seq FROM method_package_history WHERE id=? AND digest=? AND action IN ('activate','rollback') LIMIT 1").get(state.id, digest)) throw new Error('rollback target was never active');
    store.db.prepare('INSERT INTO method_package_active VALUES (?,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest').run(state.id, digest);
    history(store, state.id, current, digest, rollback ? 'rollback' : 'activate', actor);
    return methodPackageState(store, digest);
  });
}
export function listMethodPackages(store, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('invalid method offset');
  const rows = store.db.prepare('SELECT digest FROM method_packages ORDER BY imported_at DESC,id,version LIMIT 20 OFFSET ?').all(offset);
  return { offset, total: store.db.prepare('SELECT COUNT(*) AS n FROM method_packages').get().n,
    items: rows.map(row => { const { review, verification, ...state } = methodPackageState(store, row.digest); const pkg = readMethodPackage(store, row.digest);
      return { ...state, title: pkg.document.title, products: pkg.document.products, staticReview: review?.decision || 'not-reviewed', test: verification?.result || 'not-tested' }; }) };
}
export function activeMethodPackage(store, id) {
  const digest = store.db.prepare('SELECT digest FROM method_package_active WHERE id=?').get(id)?.digest;
  if (!digest) return null;
  const state = methodPackageState(store, digest);
  if (state.status !== 'trusted') return null;
  return { ...state, document: readMethodPackage(store, digest).document };
}
