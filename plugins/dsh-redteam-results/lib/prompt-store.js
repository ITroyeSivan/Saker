// 提示词模板库的持久层：用户模板与按会话草稿，带 revision 比较（CAS）。
//
// 与旧 chat-setup 的区别：
//   · 用户模板不再绑定执行方向（regular/nday/0day），不再有 30 条硬上限；
//     每页 30 条只是加载数量。
//   · 草稿按 (会话, 模板) 保存，切模板恢复各自的稿；expectedRevision 冲突时返回
//     服务器版本与本地草稿，由界面提供“用本地另存 / 载入另一窗口版本”，不按时间覆盖。
import { randomUUID } from 'node:crypto';
import { validateTemplate } from './prompt-templates.js';

export const PROMPT_LIBRARY_SCHEMA = `
CREATE TABLE IF NOT EXISTS prompt_user_templates (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prompt_drafts (
 session_id TEXT NOT NULL, template_id TEXT NOT NULL, revision INTEGER NOT NULL,
 record TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(session_id, template_id));
`;

const PAGE = 30;
const bounded = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + '格式错误');
  return value;
};

function row(store, id) {
  const found = store.db.prepare('SELECT revision,record FROM prompt_user_templates WHERE id=?').get(id);
  return found ? { revision: found.revision, ...JSON.parse(found.record) } : null;
}

/** 分页列出用户模板；PAGE=30 只是加载数量，没有总数上限。 */
export function listUserTemplates(store, { offset = 0, limit = PAGE } = {}) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset 无效');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit 无效');
  const total = store.db.prepare('SELECT count(*) AS n FROM prompt_user_templates').get().n;
  const rows = store.db.prepare('SELECT revision,record,updated_at FROM prompt_user_templates ORDER BY updated_at DESC, id LIMIT ? OFFSET ?').all(limit, offset);
  return { total, offset, limit, more: Math.max(0, total - offset - rows.length),
    // 同名允许并存，所以列表要给出更新时间来区分（v6 第 3.3 节第 10 条）。
    templates: rows.map(r => ({ ...JSON.parse(r.record), revision: r.revision, updatedAt: r.updated_at, builtin: false, readOnly: false })) };
}

/** 新建或更新用户模板。同名允许并存；按 ID + expectedRevision 做 CAS。 */
export function upsertUserTemplate(store, input) {
  const record = validateTemplate(input);
  const current = row(store, record.id);
  const expected = input.expectedRevision;
  if (current) {
    if (!Number.isInteger(expected) || expected !== current.revision) {
      throw Object.assign(new Error('其他窗口已修改该模板，请刷新后重试'), { code: 'prompt-template-conflict', details: { server: current } });
    }
    const revision = current.revision + 1;
    const next = { ...record, builtin: false, readOnly: false };
    store.db.prepare('UPDATE prompt_user_templates SET revision=?,record=?,updated_at=? WHERE id=?')
      .run(revision, JSON.stringify(next), new Date().toISOString(), record.id);
    return { ...next, revision };
  }
  const revision = 1;
  const next = { ...record, builtin: false, readOnly: false };
  store.db.prepare('INSERT INTO prompt_user_templates(id,revision,record,updated_at) VALUES(?,?,?,?)')
    .run(record.id, revision, JSON.stringify(next), new Date().toISOString());
  return { ...next, revision };
}

export function deleteUserTemplate(store, id, expectedRevision) {
  const current = row(store, id);
  if (!current) throw new Error('模板不存在');
  if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
    throw Object.assign(new Error('其他窗口已修改该模板，请刷新后重试'), { code: 'prompt-template-conflict', details: { server: current } });
  }
  store.db.prepare('DELETE FROM prompt_user_templates WHERE id=?').run(id);
  return { id, deleted: true };
}

/** 另存为新的用户模板 ID（不改动原模板）。 */
export function saveAsTemplate(store, source, id) {
  const nextId = id || (source.id ? source.id + '-' + randomUUID().slice(0, 8) : randomUUID());
  return upsertUserTemplate(store, { ...source, id: nextId, expectedRevision: undefined });
}

export function readDraft(store, sessionId, templateId) {
  const found = store.db.prepare('SELECT revision,record,updated_at FROM prompt_drafts WHERE session_id=? AND template_id=?').get(sessionId, templateId);
  return found ? { revision: found.revision, updatedAt: found.updated_at, ...JSON.parse(found.record) } : null;
}

export function listDrafts(store, sessionId) {
  // 带 updatedAt：草稿的 revision 是**每个模板各自**的计数器，跨模板比大小没有意义 ——
  // 「恢复最近一条」必须按更新时间排（2026-10-17 真机：重启后恢复的是改过次数最多的模板，
  // 不是用户最后编辑的那条）。
  return store.db.prepare('SELECT template_id,revision,record,updated_at FROM prompt_drafts WHERE session_id=?').all(sessionId)
    .map(r => ({ templateId: r.template_id, revision: r.revision, updatedAt: r.updated_at, ...JSON.parse(r.record) }));
}

/**
 * 保存草稿。expectedRevision 不匹配时返回冲突且同时给出服务器版本与本地草稿，
 * 界面据此让用户选择，不按电脑时间自动覆盖。
 */
export function saveDraft(store, sessionId, input) {
  const templateId = bounded(String(input.templateId ?? ''), '模板 ID', 100);
  const text = typeof input.text === 'string' ? input.text : '';
  if (Buffer.byteLength(text) > 16000) throw new Error('草稿正文超过上限');
  const current = readDraft(store, sessionId, templateId);
  if (current && input.expectedRevision !== current.revision) {
    return { conflict: true, server: current, local: { ...input, templateId } };
  }
  const revision = (current?.revision ?? 0) + 1;
  const record = { templateId, mode: input.mode ?? 'regular', editMode: input.editMode === 'manual' ? 'manual' : 'fields',
    fields: input.fields && typeof input.fields === 'object' ? input.fields : {}, text, scrollTop: Number.isFinite(input.scrollTop) ? input.scrollTop : 0 };
  store.db.prepare('INSERT INTO prompt_drafts(session_id,template_id,revision,record,updated_at) VALUES(?,?,?,?,?) '
    + 'ON CONFLICT(session_id,template_id) DO UPDATE SET revision=excluded.revision,record=excluded.record,updated_at=excluded.updated_at')
    .run(sessionId, templateId, revision, JSON.stringify(record), new Date().toISOString());
  return { revision, ...record };
}
