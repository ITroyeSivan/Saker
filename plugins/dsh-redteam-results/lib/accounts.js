// v6 第 5.5 节「登录账号（可选）」：账号名称与状态给界面和任务用，
// 秘密**另存**在单独的表里，列表接口永不返回秘密，也不把账号混进测试资料。
export const ACCOUNTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_accounts (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, id)
);
CREATE TABLE IF NOT EXISTS task_account_secrets (
  session_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  PRIMARY KEY(session_id, account_id)
);`;

/** 有效 / 待确认 / 已失效；过期与待确认都不会被当成有效。 */
export const ACCOUNT_STATUSES = Object.freeze(['valid', 'unconfirmed', 'expired']);
const STATUS_LABELS = Object.freeze({ valid: '有效', unconfirmed: '待确认', expired: '已失效' });
export function accountStatusLabel(status) { return STATUS_LABELS[status] || '待确认'; }

function text(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw Error(label + '不能为空');
    return '';
  }
  if (typeof value !== 'string') throw Error(label + '格式错误');
  const trimmed = value.trim();
  if (required && !trimmed) throw Error(label + '不能为空');
  if (trimmed.length > max) throw Error(label + '过长');
  return trimmed;
}

/** 列表只给名称与状态（外加“有没有存秘密”），不返回秘密本身。 */
export function listAccounts(store, sessionId) {
  const rows = store.db.prepare('SELECT id, name, status, updated_at FROM task_accounts WHERE session_id=? ORDER BY updated_at DESC, name').all(String(sessionId || ''));
  const withSecret = new Set(store.db.prepare('SELECT account_id FROM task_account_secrets WHERE session_id=?').all(String(sessionId || '')).map(row => row.account_id));
  return rows.map(row => ({
    id: row.id, name: row.name, status: ACCOUNT_STATUSES.includes(row.status) ? row.status : 'unconfirmed',
    statusLabel: accountStatusLabel(row.status), hasSecret: withSecret.has(row.id), updatedAt: row.updated_at,
  }));
}

export function saveAccount(store, sessionId, input) {
  const sid = String(sessionId || '');
  if (!sid) throw Error('sessionId required');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('账号格式错误');
  const name = text(input.name, '账号名称', 100, { required: true });
  const status = text(input.status ?? 'unconfirmed', '账号状态', 20, { required: true });
  if (!ACCOUNT_STATUSES.includes(status)) throw Error('账号状态必须是 有效 / 待确认 / 已失效');
  const id = text(input.id, '账号ID', 100) || crypto.randomUUID();
  const secret = text(input.secret, '账号秘密', 8000);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare(`INSERT INTO task_accounts(session_id,id,name,status,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(session_id,id) DO UPDATE SET name=excluded.name,status=excluded.status,updated_at=excluded.updated_at`)
      .run(sid, id, name, status, Date.now());
    if (secret) store.db.prepare(`INSERT INTO task_account_secrets(session_id,account_id,secret) VALUES(?,?,?)
      ON CONFLICT(session_id,account_id) DO UPDATE SET secret=excluded.secret`).run(sid, id, secret);
    else if (input.secret === '') store.db.prepare('DELETE FROM task_account_secrets WHERE session_id=? AND account_id=?').run(sid, id);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return listAccounts(store, sid).find(row => row.id === id);
}

export function removeAccount(store, sessionId, id) {
  const sid = String(sessionId || '');
  if (!sid) throw Error('sessionId required');
  const target = text(id, '账号ID', 100, { required: true });
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('DELETE FROM task_account_secrets WHERE session_id=? AND account_id=?').run(sid, target);
    store.db.prepare('DELETE FROM task_accounts WHERE session_id=? AND id=?').run(sid, target);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return listAccounts(store, sid);
}
