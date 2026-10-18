// v6 第 5.5 节「登录账号（可选）」+ 第 8.1 节执行适配器顺序里的“检查身份需求”。
// 账号名称与秘密分开存：这里按名称把请求的 authContext 关联到任务账号。
// 规则：已失效 / 待确认都不会被当成有效身份（5.5「不把过期当有效」）；
// 只有**有效**账号才把它另存的秘密套到“自己没带 Cookie/Authorization”的已存请求上，
// 秘密本身永不写进回执、资料或模型输入。
import { ACCOUNT_STATUSES } from './accounts.js';

/**
 * 按名称把请求身份关联到任务账号。
 * @param store - 结果库。
 * @param sessionId - 任务会话。
 * @param authContext - 请求记录里的身份名称。
 * @returns `{ name, matched, status, secret }`；名称为空时返回 null。
 */
export function resolveTaskIdentity(store, sessionId, authContext) {
  const name = typeof authContext === 'string' ? authContext.trim() : '';
  if (!name) return null;
  // 身份沿任务树解析（v6 第 8.3 节）：子代理自己没有账号表时，按主任务的账号判定状态 ——
  // 主任务把账号标成已失效/待确认，已经在跑的子代理同样不能再拿它发请求。
  // 只继承**状态**：秘密仍只在子任务自己那份里取，不跨会话套用（第 5.5 节：秘密不外泄）。
  let sid = String(sessionId || '');
  for (let depth = 0; depth < 4 && sid; depth += 1) {
    const row = store.db.prepare('SELECT id, name, status FROM task_accounts WHERE session_id=? AND name=? ORDER BY updated_at DESC, id').get(sid, name);
    if (row) {
      const status = ACCOUNT_STATUSES.includes(row.status) ? row.status : 'unconfirmed';
      const secretRow = depth === 0 ? store.db.prepare('SELECT secret FROM task_account_secrets WHERE session_id=? AND account_id=?').get(sid, row.id) : null;
      return { name: row.name, matched: true, status, secret: typeof secretRow?.secret === 'string' ? secretRow.secret : '' };
    }
    try { sid = store.db.prepare('SELECT parent_session FROM site_workers WHERE child_id=?').get(sid)?.parent_session || ''; }
    catch { sid = ''; }
  }
  return { name, matched: false, status: null, secret: '' };
}

/**
 * 身份是否允许派发。已失效和待确认都拒绝——程序不替用户把不确定的身份当成有效登录。
 * @param identity - `resolveTaskIdentity` 的结果。
 * @returns 拒绝理由；允许时返回 undefined。
 */
export function identityDenial(identity) {
  if (!identity?.matched) return undefined;
  if (identity.status === 'expired')
    return 'identity_expired：账号“' + identity.name + '”在本任务里标记为已失效；程序不会用过期身份发请求。'
      + '先在测试设置里重新绑定或更新该账号，再继续依赖它的权限验证。';
  if (identity.status === 'unconfirmed')
    return 'identity_unconfirmed：账号“' + identity.name + '”在本任务里还是待确认；程序不把待确认身份当成有效。'
      + '确认登录仍然可用（或在测试设置里改状态）后再继续。';
  return undefined;
}

/** 从账号秘密里认出是 Cookie 还是 Authorization 头。 */
function secretHeader(secret) {
  const value = String(secret || '').trim();
  if (!value) return null;
  const authorization = /^authorization\s*:\s*(.+)$/i.exec(value);
  if (authorization) return { name: 'authorization', value: authorization[1].trim(), kind: 'authorization' };
  const cookie = /^cookie\s*:\s*(.+)$/i.exec(value);
  if (cookie) return { name: 'cookie', value: cookie[1].trim(), kind: 'cookie' };
  return { name: 'cookie', value, kind: 'cookie' };
}

/**
 * 算出“派发时实际要带的头”：把有效账号的秘密套上去，**只在该请求自己没带 Cookie/Authorization 时**。
 * 只返回新的头对象，不改 `parsed`——回执仍存请求原文，秘密不会写进回执、资料或模型输入。
 * @param parsed - `parseRequest` 的结果。
 * @param identity - `resolveTaskIdentity` 的结果。
 * @returns `{ kind, headers }`；没有可套的秘密时返回 null。
 */
export function identityRequestHeaders(parsed, identity) {
  if (!parsed || !identity?.matched || identity.status !== 'valid') return null;
  if (parsed.headers.cookie !== undefined || parsed.headers.authorization !== undefined) return null;
  const header = secretHeader(identity.secret);
  if (!header) return null;
  return { kind: header.kind, headers: { ...parsed.headers, [header.name]: header.value } };
}
