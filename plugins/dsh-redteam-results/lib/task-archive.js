// Versioned task archive with strict section/column validation and safe restore.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { SCHEMA_VERSION } from './store.js';

export const TASK_ARCHIVE_SCHEMA = 'saker.task-archive/3';
export const LEGACY_TASK_ARCHIVE_SCHEMA = 'saker.task-archive/2';

const TABLES = Object.freeze([
  'task_policy', 'task_flow_choice', 'task_choice', 'task_context', 'task_context_records',
  'findings', 'counters', 'execution_receipts', 'business_materials', 'task_policy_events',
  'task_rounds',
  'project_runs', 'project_sources', 'project_checks', 'project_actions',
]);
const LEGACY_TABLES = Object.freeze([
  'task_policy', 'task_flow_choice', 'task_choice', 'task_context', 'task_context_records',
  'findings', 'counters', 'execution_receipts', 'business_materials', 'task_policy_events',
  'task_rounds', 'knowledge_usage', 'task_knowledge',
  'project_runs', 'project_sources', 'project_checks', 'project_actions',
]);
const PROJECT_ACTIVE_STATES = new Set(['preparing', 'running', 'waiting', 'paused']);
const sha = value => createHash('sha256').update(value).digest('hex');
const scalar = value => value === null || ['string', 'number'].includes(typeof value);
const hasColumn = (store, table, column) => store.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
const archiveTables = store => TABLES.filter(table => hasColumn(store, table, 'session_id'));
const rowsOf = (store, table, sessionId) => store.db.prepare(`SELECT * FROM ${table} WHERE session_id=?`).all(sessionId);

function hydrateMaterialFiles(sections) {
  const files = [];
  const missingFiles = [];
  for (const row of sections.business_materials || []) {
    let record;
    try { record = JSON.parse(row.record); } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    if (typeof record.originalBase64 === 'string' && record.originalBase64) {
      const bytes = Buffer.from(record.originalBase64, 'base64');
      const digest = createHash('sha256').update(bytes).digest('hex');
      record.originalBase64 = bytes.toString('base64');
      record.digest = digest;
      record.bytes = bytes.length;
      record.relativeRef = 'materials/' + String(row.id);
      row.digest = digest;
      row.record = JSON.stringify(record);
    } else if (typeof record.file === 'string' && record.file) {
      try {
        const bytes = fs.readFileSync(record.file);
        record.originalBase64 = bytes.toString('base64');
        record.digest = createHash('sha256').update(bytes).digest('hex');
        record.bytes = bytes.length;
        record.relativeRef = 'materials/' + String(row.id);
        record.originalPath = record.file;
        row.digest = record.digest;
        row.record = JSON.stringify(record);
      } catch {
        missingFiles.push({ id: String(row.id), name: String(record.file || row.id), reason: 'source-file-missing' });
      }
    }
    if (record.originalBase64) files.push({
      id: String(row.id), digest: record.digest, bytes: record.bytes,
      name: record.displayName || record.file || row.id, kind: record.kind || 'material',
      relativeRef: record.relativeRef,
    });
  }
  return { files, missingFiles };
}

export function exportTaskArchive(store, sessionId, { now = Date.now() } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('需要有效任务');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const sections = {};
    const columns = {};
    for (const table of archiveTables(store)) {
      sections[table] = rowsOf(store, table, sessionId);
      columns[table] = store.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name).sort();
    }
    store.db.exec('COMMIT');
    const attachments = hydrateMaterialFiles(sections);
    const digests = {};
    const counts = {};
    for (const [table, rows] of Object.entries(sections)) {
      digests[table] = sha(JSON.stringify(rows));
      counts[table] = rows.length;
    }
    return {
      manifest: {
        schema: TASK_ARCHIVE_SCHEMA, schemaVersion: SCHEMA_VERSION,
        sourceSession: sessionId, exportedAt: new Date(now).toISOString(),
        secretsExcluded: true, restoredState: 'unconfirmed',
        tables: Object.keys(sections), sections: counts, digests, columns,
        files: attachments.files, missingFiles: attachments.missingFiles,
        note: '完整备份含导入原文，原文可能带凭据；单独保存的账号秘密不导出，恢复后需重新绑定。',
      },
      sections,
    };
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

export function verifyTaskArchive(archive) {
  const problems = [];
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) return { ok: false, problems: ['归档不是对象'] };
  const { manifest, sections } = archive;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, problems: ['缺少 manifest'] };
  if (![TASK_ARCHIVE_SCHEMA, LEGACY_TASK_ARCHIVE_SCHEMA].includes(manifest.schema))
    problems.push('归档 schema 不匹配或版本不受支持');
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1 || manifest.schemaVersion > SCHEMA_VERSION)
    problems.push('schemaVersion 缺失、过旧或高于当前支持版本');
  if (typeof manifest.sourceSession !== 'string' || !manifest.sourceSession.trim()) problems.push('缺少 sourceSession');
  if (manifest.secretsExcluded !== true) problems.push('secretsExcluded 不是 true');
  if (manifest.restoredState !== 'unconfirmed') problems.push('restoredState 不是 unconfirmed');
  if (!Number.isFinite(Date.parse(manifest.exportedAt))) problems.push('exportedAt 无效');
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) problems.push('缺少分节数据');
  if (!manifest.sections || typeof manifest.sections !== 'object') problems.push('缺少 sections 清单');
  if (!manifest.digests || typeof manifest.digests !== 'object') problems.push('缺少 digests 清单');
  if (!manifest.columns || typeof manifest.columns !== 'object') problems.push('缺少 columns 清单');
  if (!Array.isArray(manifest.files)) problems.push('缺少 files 清单');
  if (!Array.isArray(manifest.missingFiles)) problems.push('缺少 missingFiles 清单');

  const sectionKeys = sections && typeof sections === 'object' && !Array.isArray(sections) ? Object.keys(sections).sort() : [];
  const countKeys = manifest.sections && typeof manifest.sections === 'object' ? Object.keys(manifest.sections).sort() : [];
  const digestKeys = manifest.digests && typeof manifest.digests === 'object' ? Object.keys(manifest.digests).sort() : [];
  const expectedTables = manifest.schema === LEGACY_TASK_ARCHIVE_SCHEMA ? LEGACY_TABLES : TABLES;
  if (JSON.stringify(sectionKeys) !== JSON.stringify([...expectedTables].sort()))
    problems.push('归档分节与 schema 固定表清单不一致');
  if (JSON.stringify(sectionKeys) !== JSON.stringify(countKeys)) problems.push('sections 与 counts 分节不一致');
  if (JSON.stringify(sectionKeys) !== JSON.stringify(digestKeys)) problems.push('sections 与 digests 分节不一致');
  for (const table of sectionKeys) {
    if (!expectedTables.includes(table)) { problems.push('归档包含未知表：' + table); continue; }
    const rows = sections[table];
    if (!Array.isArray(rows)) { problems.push(table + ' 不是行数组'); continue; }
    if (!Number.isInteger(manifest.sections[table]) || manifest.sections[table] !== rows.length)
      problems.push(table + ' 行数不一致');
    const expectedDigest = manifest.digests?.[table];
    if (typeof expectedDigest !== 'string' || sha(JSON.stringify(rows)) !== expectedDigest)
      problems.push(table + ' 摘要不一致');
    let keys = null;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) { problems.push(table + ' 含非对象行'); break; }
      const rowKeys = Object.keys(row).sort();
      if (keys === null) keys = rowKeys;
      else if (JSON.stringify(rowKeys) !== JSON.stringify(keys)) { problems.push(table + ' 同行结构不一致'); break; }
      if (row.session_id !== manifest.sourceSession) { problems.push(table + ' 含跨来源行'); break; }
      if (rowKeys.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !scalar(row[key]))) {
        problems.push(table + ' 含未知列或非标量值'); break;
      }
    }
    if (keys && manifest.columns?.[table] && JSON.stringify(keys) !== JSON.stringify([...manifest.columns[table]].sort()))
      problems.push(table + ' 列清单不一致');
  }
  for (const key of Object.keys(manifest.sections || {})) if (!sectionKeys.includes(key)) problems.push('sections 有多余分节：' + key);
  for (const key of Object.keys(manifest.digests || {})) if (!sectionKeys.includes(key)) problems.push('digests 有多余分节：' + key);

  if (Array.isArray(manifest.files)) {
    const ids = new Set();
    const materials = new Map();
    for (const row of Array.isArray(sections?.business_materials) ? sections.business_materials : []) {
      try { materials.set(row.id, { row, record: JSON.parse(row.record) }); } catch { /* 检查时报告缺失 */ }
    }
    for (const file of manifest.files) {
      if (!file || typeof file.id !== 'string' || !file.id || typeof file.digest !== 'string'
        || !Number.isInteger(file.bytes) || file.bytes < 0 || typeof file.relativeRef !== 'string')
        problems.push('files 条目结构无效');
      else if (ids.has(file.id)) problems.push('files 条目重复：' + file.id);
      else {
        ids.add(file.id);
        const material = materials.get(file.id);
        try {
          if (!material || typeof material.record.originalBase64 !== 'string') throw new Error('缺少附件正文');
          const { row, record } = material;
          const bytes = Buffer.from(record.originalBase64, 'base64');
          if (bytes.toString('base64') !== record.originalBase64 || sha(bytes) !== file.digest
            || row.digest !== file.digest || record.digest !== file.digest || bytes.length !== file.bytes || record.bytes !== file.bytes)
            throw new Error('附件摘要或长度不一致');
          if (file.relativeRef !== record.relativeRef || file.relativeRef !== 'materials/' + file.id
            || /[\\\u0000-\u001f:]/.test(file.relativeRef) || file.relativeRef.split('/').some(part => !part || part === '.' || part === '..'))
            throw new Error('附件引用无效');
        } catch (error) { problems.push('files ' + file.id + '：' + error.message); }
      }
    }
    for (const [id, { record }] of materials) if (record.originalBase64 && !ids.has(id)) problems.push('files 遗漏附件：' + id);
  }
  return { ok: problems.length === 0, problems };
}

function restoreProjectSafety(store, sourceSession, targetSession, now) {
  const interruptedAt = new Date(now).toISOString();
  const updatedRunIds = [];
  const runs = store.db.prepare('SELECT run_id,state,record FROM project_runs WHERE session_id=?').all(targetSession);
  for (const row of runs) {
    let record;
    try { record = JSON.parse(row.record); } catch { continue; }
    if (!PROJECT_ACTIVE_STATES.has(record.state || row.state)) continue;
    record.state = 'paused';
    record.controlRev = (Number(record.controlRev) || 0) + 1;
    record.blocker = { code: 'restored-interrupted', reason: '任务从归档恢复，未完成运行已安全暂停', restoredAt: interruptedAt };
    record.restoredFrom = sourceSession;
    record.updatedAt = interruptedAt;
    store.db.prepare('UPDATE project_runs SET state=?,control_rev=?,record=?,updated_at=? WHERE session_id=? AND run_id=?')
      .run('paused', record.controlRev, JSON.stringify(record), interruptedAt, targetSession, row.run_id);
    updatedRunIds.push(row.run_id);
  }
  const actions = store.db.prepare('SELECT run_id,action_id,state,record FROM project_actions WHERE session_id=?').all(targetSession);
  for (const row of actions) {
    let record;
    try { record = JSON.parse(row.record); } catch { continue; }
    if (record.executionState === 'queued') {
      record.executionState = 'cancelled';
      record.error = '任务恢复时取消尚未派发的动作';
    } else if (record.executionState === 'dispatched') {
      record.executionState = 'unknown';
      record.sideEffectUnknown = true;
      record.bodyUnavailable = true;
      record.error = '任务恢复时原动作未收尾，副作用仍需核对';
    } else continue;
    record.restoredAt = interruptedAt;
    store.db.prepare('UPDATE project_actions SET state=?,record=?,updated_at=? WHERE session_id=? AND run_id=? AND action_id=?')
      .run(record.executionState, JSON.stringify(record), interruptedAt, targetSession, row.run_id, row.action_id);
  }
  const checks = store.db.prepare('SELECT run_id,check_id,record FROM project_checks WHERE session_id=?').all(targetSession);
  for (const row of checks) {
    let record;
    try { record = JSON.parse(row.record); } catch { continue; }
    if (!['running', 'paused'].includes(record.executionState)) continue;
    record.executionState = 'paused';
    record.updatedAt = interruptedAt;
    store.db.prepare('UPDATE project_checks SET record=?,updated_at=? WHERE session_id=? AND run_id=? AND check_id=?')
      .run(JSON.stringify(record), interruptedAt, targetSession, row.run_id, row.check_id);
  }
  return updatedRunIds;
}

function restorePolicyAndAttachmentState(store, archive, targetSession, now) {
  const policyRow = store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(targetSession);
  let projectRunState = null;
  if (policyRow) {
    const policy = JSON.parse(policyRow.record);
    const runRow = store.db.prepare('SELECT state FROM project_runs WHERE session_id=? ORDER BY updated_at DESC LIMIT 1').get(targetSession);
    projectRunState = runRow?.state || null;
    policy.restored = {
      at: new Date(now).toISOString(), fromSession: archive.manifest.sourceSession,
      state: 'unconfirmed', secretsNeedRebind: true,
    };
    if (projectRunState) {
      policy.projectRunState = projectRunState;
      policy.planComplete = projectRunState === 'completed';
      policy.cancelled = projectRunState === 'cancelled';
      if (projectRunState === 'paused') policy.blocker = {
        code: 'restored-interrupted', reason: '任务从归档恢复，需重新核对环境和身份', source: 'project-run',
      };
    }
    store.db.prepare('UPDATE task_policy SET record=?,updated_at=? WHERE session_id=?')
      .run(JSON.stringify(policy), new Date().toISOString(), targetSession);
  }
  const missingAttachments = [];
  const sources = store.db.prepare('SELECT source_id,source_revision,record FROM project_sources WHERE session_id=?').all(targetSession);
  for (const row of sources) {
    let source;
    try { source = JSON.parse(row.record); } catch { continue; }
    if (!source.snapshotMaterialId) continue;
    const material = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?')
      .get(targetSession, source.snapshotMaterialId);
    let ok = false;
    if (material) {
      try {
        const record = JSON.parse(material.record);
        const bytes = Buffer.from(String(record.originalBase64 || ''), 'base64');
        ok = bytes.length > 0 && (!record.digest || sha(bytes) === record.digest);
      } catch { ok = false; }
    }
    source.snapshotState = ok ? 'present' : 'missing';
    if (!ok) {
      source.missingReason = '附件内容缺失或摘要不一致';
      missingAttachments.push({ id: source.snapshotMaterialId, sourceId: source.sourceId, sourceRevision: source.sourceRevision });
    }
    store.db.prepare('UPDATE project_sources SET record=?,updated_at=? WHERE session_id=? AND source_id=? AND source_revision=?')
      .run(JSON.stringify(source), new Date().toISOString(), targetSession, row.source_id, row.source_revision);
  }
  return { projectRunState, missingAttachments };
}

export function importTaskArchive(store, archive, { sessionId = 'restored-' + randomUUID(), now = Date.now() } = {}) {
  const verdict = verifyTaskArchive(archive);
  if (!verdict.ok) throw Object.assign(new Error('归档校验失败：' + verdict.problems.join('；')), { code: 'task-archive-invalid', details: verdict });
  const available = archiveTables(store);
  const activeSections = available.filter(table => TABLES.includes(table));
  const retiredSections = archive.manifest.schema === LEGACY_TASK_ARCHIVE_SCHEMA
    ? LEGACY_TABLES.filter(table => !TABLES.includes(table))
    : [];
  if (archive.manifest.schema === TASK_ARCHIVE_SCHEMA
    && JSON.stringify(Object.keys(archive.sections).sort()) !== JSON.stringify([...activeSections].sort()))
    throw new Error('归档分节与当前支持表不一致');
  const schema = {};
  for (const table of activeSections) {
    const info = store.db.prepare(`PRAGMA table_info(${table})`).all();
    const allowed = new Set(info.map(row => row.name));
    schema[table] = { info, allowed };
    let keys = null;
    for (const row of archive.sections[table]) {
      const rowKeys = Object.keys(row);
      if (rowKeys.some(key => !allowed.has(key))) throw new Error(table + ' 包含当前 schema 不存在的列');
      if (keys === null) keys = rowKeys;
      else if (JSON.stringify([...rowKeys].sort()) !== JSON.stringify([...keys].sort())) throw new Error(table + ' 同一分节行结构不一致');
    }
  }
  for (const table of activeSections) {
    if (store.db.prepare(`SELECT 1 FROM ${table} WHERE session_id=? LIMIT 1`).get(sessionId))
      throw new Error('恢复目标已在 ' + table + ' 中存在数据，请换一个新任务 id，不要在已有数据上覆盖');
  }

  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of activeSections) {
      const rows = archive.sections[table] || [];
      if (!rows.length) continue;
      const auto = new Set(schema[table].info
        .filter(column => column.pk === 1 && /INT/i.test(String(column.type))).map(column => column.name));
      const columns = Object.keys(rows[0]).filter(column => !auto.has(column));
      const statement = store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
      for (const row of rows) {
        const values = columns.map(column => {
          const value = column === 'session_id' ? sessionId : row[column];
          if (column !== 'record' || typeof value !== 'string') return value;
          try {
            const record = JSON.parse(value);
            if (record && typeof record === 'object' && record.sessionId === archive.manifest.sourceSession)
              record.sessionId = sessionId;
            return JSON.stringify(record);
          } catch { return value; }
        });
        statement.run(...values);
      }
    }
    restoreProjectSafety(store, archive.manifest.sourceSession, sessionId, now);
    const state = restorePolicyAndAttachmentState(store, archive, sessionId, now);
    store.db.exec('COMMIT');
    return {
      sessionId, restoredFrom: archive.manifest.sourceSession, state: 'unconfirmed', secretsNeedRebind: true,
      projectRunState: state.projectRunState, missingAttachments: state.missingAttachments,
      files: archive.manifest.files || [], missingFiles: archive.manifest.missingFiles || [],
      sections: Object.fromEntries(activeSections.map(table => [table, archive.manifest.sections[table]])),
      retiredSectionsIgnored: retiredSections,
      note: '已写入新任务；未完成运行已暂停，未收尾动作标未知，账号密钥需重新绑定后再继续。',
    };
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
