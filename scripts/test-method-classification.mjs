import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, SCHEMA_VERSION } from '../plugins/dsh-redteam-results/lib/store.js';
import { methodFingerprint, normalizeMethodClassification, stageMethodClassification, readMethodClassification,
  listMethodClassifications, methodModuleRequirement, builtinMethodClassification } from '../plugins/dsh-redteam-results/lib/method-classification.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-method-classification-'));
const dbPath = path.join(home, 'redteam-results/results.db');
let store = openStore(dbPath);
const entry = (group, id, prompt, extra = {}) => ({ group, id, prompt, manifest: { description: extra.description ?? '本地方法', order: extra.order ?? 10, origin: extra.origin ?? 'official' } });
const builtin = builtinMethodClassification(entry('exploit', 'sqli', '正文 A'));
const explicit = (over = {}) => ({ schema: 'saker.method-classification/1', ...builtin, ...over });
let passed = 0, failed = 0;
const test = (name, work) => { try { work(); passed++; console.log('ok ' + name); } catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); } };
try {
  test('builtin mapping is deterministic: directory key is the module and version follows content', () => {
    assert.deepEqual(builtin.modules, ['exploit/sqli']);
    assert.equal(builtin.status, 'verified');
    assert.equal(builtin.source.kind, 'builtin');
    assert.equal(builtin.source.position, 'methods/exploit/sqli/manifest.yml');
    assert.equal(builtin.revision, 1);
    assert.deepEqual(builtinMethodClassification(entry('exploit', 'sqli', '正文 A')), builtin, 'same content must map to the same classification');
    const changed = builtinMethodClassification(entry('exploit', 'sqli', '正文 B'));
    assert.notEqual(changed.version, builtin.version, 'changed body must change the derived version');
    assert.notEqual(changed.digest, builtin.digest);
    assert.deepEqual(methodFingerprint(entry('recon', 'port-scan', 'x')).modules ?? [], [], 'fingerprint alone carries no module list');
  });
  test('staging persists across restart and the same revision cannot be silently rewritten', () => {
    const stored = stageMethodClassification(store, builtin);
    assert.deepEqual(readMethodClassification(store, stored.id, stored.version, stored.digest), stored);
    assert.throws(() => stageMethodClassification(store, { ...builtin, modules: [] }), /不可更改/);
    assert.throws(() => stageMethodClassification(store, { ...builtin, status: 'conflict', reason: '悄悄改状态' }), /不可更改/);
    store.close(); store = openStore(dbPath);
    assert.deepEqual(readMethodClassification(store, stored.id, stored.version, stored.digest), stored);
    assert.equal(store.schemaVersion, SCHEMA_VERSION, 'classification writes must preserve the current store format');
  });
  test('a classification revision is a new row and reads default to the latest revision', () => {
    const first = readMethodClassification(store, builtin.id, builtin.version, builtin.digest);
    assert.equal(first.revision, 1);
    const next = stageMethodClassification(store, { ...builtin, revision: 2, modules: ['exploit/sqli', 'exploit/xss'], notes: '补充共享前置模块' });
    assert.equal(next.revision, 2);
    assert.equal(readMethodClassification(store, builtin.id, builtin.version, builtin.digest).revision, 2, 'reads default to the latest revision');
    assert.equal(readMethodClassification(store, builtin.id, builtin.version, builtin.digest, 1).revision, 1, 'an explicit old revision is still readable');
    const listed = listMethodClassifications(store).items.find(item => item.id === builtin.id);
    assert.deepEqual(listed.modules, ['exploit/sqli', 'exploit/xss']);
    assert.equal(listed.revision, 2);
  });
  test('verified needs a traceable source; unknown and conflict need a reason; illegal shapes are refused', () => {
    assert.throws(() => normalizeMethodClassification(explicit({ source: { kind: 'manual', version: '', position: '' } })), /来源/);
    assert.throws(() => normalizeMethodClassification(explicit({ source: { kind: 'manual', version: 'v1', position: '' } })), /来源/);
    assert.throws(() => normalizeMethodClassification(explicit({ status: 'unknown', reason: '' })), /原因/);
    assert.throws(() => normalizeMethodClassification(explicit({ status: 'conflict', reason: '' })), /原因/);
    assert.throws(() => normalizeMethodClassification(explicit({ status: 'assumed' })), /status/);
    assert.throws(() => normalizeMethodClassification(explicit({ modules: ['intranet/segment-map'] })), /模块键/);
    assert.throws(() => normalizeMethodClassification(explicit({ digest: 'nope' })), /digest/);
    assert.throws(() => normalizeMethodClassification(explicit({ revision: 0 })), /revision/);
    const conflict = normalizeMethodClassification(explicit({ status: 'conflict', reason: '两处来源写法不一致' }));
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.modules.length, 1, 'a conflict still keeps what was known');
  });
  test('an explicit empty module list stays empty and is never replaced by defaults', () => {
    const fingerprint = methodFingerprint(entry('exploit', 'xss', '空模块正文'));
    stageMethodClassification(store, normalizeMethodClassification({ schema: 'saker.method-classification/1', ...fingerprint, revision: 1,
      modules: [], status: 'verified', source: { kind: 'manual', version: fingerprint.version, position: '本地确认：该方法不主动发请求' } }));
    const requirement = methodModuleRequirement(store, fingerprint, { knownModules: ['exploit/sqli', 'exploit/xss'] });
    assert.deepEqual(requirement.modules, [], 'an empty list must not fall back to every module');
    assert.equal(requirement.status, 'verified');
  });
  test('unclassified, unknown, conflict, module-missing and corrupt records each return a concrete reason', () => {
    const absent = methodFingerprint(entry('recon', 'dir-enum', '没有分类'));
    const unclassified = methodModuleRequirement(store, absent, { knownModules: ['recon/dir-enum'] });
    assert.equal(unclassified.status, 'unclassified');
    assert.match(unclassified.reason, /尚未分类/);
    const unknownFp = methodFingerprint(entry('recon', 'js-api', '未知分类'));
    stageMethodClassification(store, { schema: 'saker.method-classification/1', ...unknownFp, revision: 1, modules: [], status: 'unknown', source: { kind: 'manual', version: unknownFp.version, position: '待核对' }, reason: '来源未给出适用版本' });
    assert.equal(methodModuleRequirement(store, unknownFp, { knownModules: ['recon/js-api'] }).status, 'unknown');
    const conflictFp = methodFingerprint(entry('recon', 'fingerprint', '冲突分类'));
    stageMethodClassification(store, { schema: 'saker.method-classification/1', ...conflictFp, revision: 1, modules: ['recon/fingerprint'], status: 'conflict', source: { kind: 'manual', version: conflictFp.version, position: '两处来源' }, reason: '两处来源给出的类别不一致' });
    const conflict = methodModuleRequirement(store, conflictFp, { knownModules: ['recon/fingerprint'] });
    assert.equal(conflict.status, 'conflict');
    assert.match(conflict.reason, /不一致/);
    const removed = methodModuleRequirement(store, builtin, { knownModules: ['exploit/sqli'] });
    assert.equal(removed.status, 'module-missing', 'a module removed from the catalog must be reported, not ignored');
    assert.match(removed.reason, /exploit\/xss/);
    store.db.prepare('INSERT INTO method_classifications(id,version,digest,revision,record,recorded_at) VALUES(?,?,?,?,?,?)')
      .run('exploit/broken', 'v1', 'f'.repeat(64), 1, '{ not json', new Date().toISOString());
    const corrupt = methodModuleRequirement(store, { id: 'exploit/broken', version: 'v1', digest: 'f'.repeat(64) });
    assert.equal(corrupt.status, 'corrupt');
    assert.match(corrupt.reason, /损坏/);
  });
  test('a method without any classification stays readable: the catalog is untouched and nothing is auto-selected', () => {
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM method_classifications').get().n;
    const absent = methodFingerprint(entry('exploit', 'ssrf', '未分类正文仍然可读'));
    assert.equal(readMethodClassification(store, absent.id, absent.version, absent.digest), null);
    const requirement = methodModuleRequirement(store, absent, { knownModules: ['exploit/ssrf'] });
    assert.equal(requirement.status, 'unclassified');
    assert.deepEqual(requirement.modules, [], 'an unclassified method must not silently grant modules');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM method_classifications').get().n, before, 'reading must not write a classification');
  });
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1;
