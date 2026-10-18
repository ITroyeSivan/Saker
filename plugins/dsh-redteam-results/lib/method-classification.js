// Versioned, immutable method -> module classification.
//
// 为什么单独一层：模块选择（task-modules.js）只知道"哪些方向被允许"，没有任何东西把
// **某个方法**绑定到它**必须**的模块键上。于是模型可以在调用时随手写一个类别名就通过，
// 用户关掉的模块形同虚设。这一层只负责把"方法 → 需要的全部模块"记成可追查、不可静默改写的
// 版本化记录；它**不执行**任何请求，也不读远端正文，执行接线在后续卡。
//
// 设计边界：
//   · 记录以 (id, version, digest, revision) 为主键；同一主键不允许改内容（要用新 revision）。
//   · `verified` 必须带来源（版本 + 原文位置）；缺来源只能记 `unknown`/`conflict` 并给理由。
//   · 模块列表可以为空（用户有意全关）；空数组**不会**被默认值替换。
//   · 内置目录的映射是**确定**的：目录键即模块键，不看 Nday 的产品 category，也不把
//     任意 `vulnClass` 文本当成可执行授权。
import crypto from 'node:crypto';

export const METHOD_CLASSIFICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS method_classifications (
 id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, revision INTEGER NOT NULL,
 record TEXT NOT NULL, recorded_at TEXT NOT NULL,
 PRIMARY KEY (id, version, digest, revision)
);
CREATE INDEX IF NOT EXISTS idx_method_classifications_key ON method_classifications(id, version, digest);
`;

// 方法 id 允许可选的 group 前缀：内置目录用 `exploit/sqli`，方法包用 `controlled-fixture`。
const ID = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})?$/;
const MODULE = /^(recon|exploit)\/[a-z0-9][a-z0-9._-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['verified', 'unknown', 'conflict']);
const KINDS = new Set(['builtin', 'package', 'manual']);

function text(value, label, limit = 4000) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit || value.includes('\0')) throw new Error(label + ' 需要非空且有界的文本');
  return value.trim();
}
function optionalText(value, label, limit = 4000) {
  if (value === undefined || value === null || value === '') return '';
  return text(value, label, limit);
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' 需要对象');
  return value;
}
/** 稳定序列化：同一份记录必须得到同一个字符串，主键冲突才能被可靠识别。 */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('分类记录必须是可无损 JSON 化的数据');
  return JSON.stringify(value);
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

/** 内置方法指纹：版本由正文摘要派生，所以"同版本 ⇒ 同内容"。 */
export function methodFingerprint({ group, id, prompt, manifest }) {
  if (!['recon', 'exploit'].includes(group)) throw new Error('只有 recon/exploit 目录参与 Web 模块分类');
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error('方法 id 格式错误');
  const digest = sha(canonical({ group, id, prompt: String(prompt ?? ''), manifest: manifest ?? null }));
  return { id: group + '/' + id, version: 'builtin.' + digest.slice(0, 16), digest };
}

export function normalizeMethodClassification(input) {
  const doc = object(input, 'method classification');
  if (doc.schema !== 'saker.method-classification/1') throw new Error('分类记录 schema 必须为 saker.method-classification/1');
  if (typeof doc.id !== 'string' || !ID.test(doc.id)) throw new Error('分类记录 id 格式错误');
  if (typeof doc.version !== 'string' || !ID.test(doc.version)) throw new Error('分类记录 version 格式错误');
  if (typeof doc.digest !== 'string' || !HASH.test(doc.digest)) throw new Error('分类记录 digest 必须是 64 位小写十六进制');
  const revision = doc.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('分类记录 revision 无效');
  if (!Array.isArray(doc.modules) || doc.modules.length > 64) throw new Error('分类记录 modules 必须是不超过 64 项的数组');
  const modules = [];
  for (const key of doc.modules) {
    if (typeof key !== 'string' || !MODULE.test(key)) throw new Error('分类记录包含非法的模块键：' + String(key));
    if (!modules.includes(key)) modules.push(key);
  }
  if (!STATUSES.has(doc.status)) throw new Error('分类记录 status 必须是 verified/unknown/conflict');
  const source = object(doc.source, '分类记录 source');
  if (!KINDS.has(source.kind)) throw new Error('分类记录 source.kind 必须是 builtin/package/manual');
  const sourceVersion = optionalText(source.version, 'source.version', 300);
  const position = optionalText(source.position, 'source.position', 500);
  const reason = optionalText(doc.reason, 'reason', 2000);
  // 缺来源不能假装已核实：verified 必须能追到"哪个版本、原文哪一段"。
  if (doc.status === 'verified' && (!sourceVersion || !position)) throw new Error('verified 分类必须带来源版本与原文位置');
  if (doc.status !== 'verified' && !reason) throw new Error(doc.status + ' 分类必须写明原因');
  return { schema: 'saker.method-classification/1', id: doc.id, version: doc.version, digest: doc.digest, revision,
    modules, status: doc.status, source: { kind: source.kind, version: sourceVersion, position },
    reason, notes: optionalText(doc.notes, 'notes', 2000) };
}

function row(store, id, version, digest, revision) {
  return store.db.prepare('SELECT revision,record FROM method_classifications WHERE id=? AND version=? AND digest=? AND revision=?')
    .get(id, version, digest, revision);
}

export function stageMethodClassification(store, input) {
  const record = normalizeMethodClassification(input), encoded = canonical(record);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const existing = row(store, record.id, record.version, record.digest, record.revision);
    // 同一主键不允许改内容：改类别必须递增 revision（或换新 digest），否则旧结论会被静默覆写。
    if (existing && existing.record !== encoded) throw new Error('同一分类修订的内容不可更改；请递增 revision 或使用新的方法摘要');
    if (!existing) {
      store.db.prepare('INSERT INTO method_classifications(id,version,digest,revision,record,recorded_at) VALUES(?,?,?,?,?,?)')
        .run(record.id, record.version, record.digest, record.revision, encoded, new Date().toISOString());
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return record;
}

export function readMethodClassification(store, id, version, digest, revision) {
  for (const [value, label] of [[id, 'id'], [version, 'version'], [digest, 'digest']]) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('分类查询需要 ' + label);
  }
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('分类查询 revision 无效');
  const selected = revision === undefined
    ? store.db.prepare('SELECT revision,record FROM method_classifications WHERE id=? AND version=? AND digest=? ORDER BY revision DESC LIMIT 1').get(id, version, digest)
    : row(store, id, version, digest, revision);
  if (!selected) return null;
  let parsed;
  try { parsed = JSON.parse(selected.record); } catch { throw Object.assign(new Error('分类记录损坏，无法解析：' + id), { code: 'method-classification-corrupt' }); }
  return normalizeMethodClassification(parsed);
}

/**
 * 按 (id, version) 解析分类：只在**恰好一个摘要**时可用。
 * 同一 id/version 出现多个摘要说明方法内容被换过而没换版本 —— 按冲突处理，
 * 绝不"取最新"静默换掉调用方引用的方法。
 */
export function readMethodClassificationForVersion(store, id, version) {
  const rows = store.db.prepare('SELECT DISTINCT digest FROM method_classifications WHERE id=? AND version=?').all(id, version);
  if (!rows.length) return { status: 'absent' };
  if (rows.length > 1) return { status: 'conflict', reason: '同一 id/version 存在多个方法摘要，无法确定分类；请改用新的方法版本' };
  return { status: 'found', record: readMethodClassification(store, id, version, rows[0].digest) };
}

export function listMethodClassifications(store, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error('分类列表 offset 无效');
  const rows = store.db.prepare(`SELECT id,version,digest,MAX(revision) AS revision FROM method_classifications
    GROUP BY id,version,digest ORDER BY id,version,digest LIMIT 50 OFFSET ?`).all(offset);
  return { offset, total: store.db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM method_classifications GROUP BY id,version,digest)').get().n,
    items: rows.map(entry => { const record = readMethodClassification(store, entry.id, entry.version, entry.digest, entry.revision);
      return { id: record.id, version: record.version, digest: record.digest, revision: record.revision, modules: record.modules,
        status: record.status, source: record.source, reason: record.reason }; }) };
}

/**
 * 把一条方法引用解析成"它需要哪些模块"。
 * 未分类/未知/冲突/模块已被移除/记录损坏都给具体原因，绝不默认放行。
 * @param reference {{id:string,version:string,digest:string}}
 * @param options {{knownModules?: string[]}}
 */
export function methodModuleRequirement(store, reference, { knownModules } = {}) {
  const { id, version, digest } = object(reference, 'method reference');
  for (const [value, label] of [[id, 'id'], [version, 'version'], [digest, 'digest']]) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('方法引用缺少 ' + label);
  }
  let record;
  try { record = readMethodClassification(store, id, version, digest); }
  catch (error) { return { status: 'corrupt', modules: [], reason: String(error.message ?? error), revision: null }; }
  if (!record) return { status: 'unclassified', modules: [], reason: '方法尚未分类，主动执行需先完成分类', revision: null };
  const base = { revision: record.revision, source: record.source, digest: record.digest, version: record.version, id: record.id };
  if (record.status === 'unknown') return { ...base, status: 'unknown', modules: [], reason: record.reason };
  if (record.status === 'conflict') return { ...base, status: 'conflict', modules: [], reason: record.reason };
  if (!Array.isArray(knownModules)) return { ...base, status: 'verified', modules: record.modules, reason: '' };
  const known = new Set(knownModules);
  const missing = record.modules.filter(key => !known.has(key));
  if (missing.length) return { ...base, status: 'module-missing', modules: record.modules,
    reason: '分类引用的模块已不在当前目录：' + missing.join('、') };
  return { ...base, status: 'verified', modules: record.modules, reason: '' };
}

/** 内置目录的确定映射：目录键即模块键，status 一律 verified，来源指向该方法的 manifest。 */
export function builtinMethodClassification(entry) {
  const fingerprint = methodFingerprint(entry);
  return normalizeMethodClassification({ schema: 'saker.method-classification/1', ...fingerprint, revision: 1,
    modules: [fingerprint.id], status: 'verified',
    source: { kind: 'builtin', version: fingerprint.version, position: 'methods/' + fingerprint.id + '/manifest.yml' },
    reason: '', notes: '内置目录映射：模块键与目录键一致，不采用任何文本类别。' });
}
