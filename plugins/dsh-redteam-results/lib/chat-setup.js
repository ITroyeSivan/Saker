// Desktop-only preferences and prompt drafts. Drafts never enter model context
// until the user places one in the native composer and sends it.
import { normalizeInteraction, reportingFor, MAX_SITE_WORKERS } from './interaction.js';

export const CHAT_SETUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_defaults (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_prompt_drafts (session_id TEXT NOT NULL, mode TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(session_id,mode));
CREATE TABLE IF NOT EXISTS chat_prompt_templates (id TEXT PRIMARY KEY, record TEXT NOT NULL);
`;
export function chatDefaults(store) {
  const row = store.db.prepare('SELECT record FROM chat_defaults WHERE id=1').get();
  return row ? JSON.parse(row.record) : null;
}
export function saveChatDefaults(store, input) {
  if (!Number.isInteger(input.workers) || input.workers < 0 || input.workers > MAX_SITE_WORKERS) throw Error('子代理上限应为0–'+MAX_SITE_WORKERS+'的整数');
  const record = { interaction: normalizeInteraction(input.interaction), reporting: reportingFor(input), workers: input.workers };
  store.db.prepare('INSERT INTO chat_defaults(id,record) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(JSON.stringify(record));
  return record;
}
function text(value, label, max) {
  if (typeof value !== 'string' || value.length > max) throw Error(label+'过长或格式错误');
  return value;
}
export function promptDraft(store, sessionId, mode, input) {
  if (!['regular','nday','0day'].includes(mode)) throw Error('草稿方向错误');
  const previousRow = store.db.prepare('SELECT record FROM chat_prompt_drafts WHERE session_id=? AND mode=?').get(sessionId, mode);
  const previous = previousRow ? JSON.parse(previousRow.record) : null;
  if (input !== undefined) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('草稿格式错误');
    const editedAt = input.editedAt ?? Date.now();
    if (!Number.isSafeInteger(editedAt) || editedAt < 0 || editedAt > Date.now()+300000) throw Error('草稿时间格式错误');
    if (previous && editedAt < (previous.editedAt || 0)) return previous;
    const record = { text: text(input.text, '提示词', 16000), template: text(input.template ?? '', '模板', 100),
      mode, editedAt };
    store.db.prepare('INSERT INTO chat_prompt_drafts(session_id,mode,record) VALUES(?,?,?) ON CONFLICT(session_id,mode) DO UPDATE SET record=excluded.record').run(sessionId, mode, JSON.stringify(record));
    return record;
  }
  return previous;
}
export function promptTemplates(store, input) {
  if (input !== undefined) {
    const title = text(input.title, '模板名称', 60).trim(), body = text(input.text, '提示词', 16000).trim();
    if (!title || !body || !['regular','nday','0day'].includes(input.mode)) throw Error('请填写模板名称和内容');
    const id = input.id || crypto.randomUUID();
    text(id, '模板ID', 100);
    const exists = store.db.prepare('SELECT id FROM chat_prompt_templates WHERE id=?').get(id);
    if (!exists && store.db.prepare('SELECT count(*) AS n FROM chat_prompt_templates').get().n >= 30) throw Error('最多保存30个个人模板');
    store.db.prepare('INSERT INTO chat_prompt_templates(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record')
      .run(id, JSON.stringify({ id, title, text: body, mode: input.mode }));
  }
  return store.db.prepare('SELECT record FROM chat_prompt_templates ORDER BY rowid').all().map(row => JSON.parse(row.record));
}
