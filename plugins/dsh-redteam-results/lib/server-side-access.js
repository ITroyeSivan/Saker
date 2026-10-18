// 服务端访问（v6 第 9.1 节）：目标服务器真的发起了外连，必须有**宿主可验证的记录**。
//
// 记录只能由宿主产生：读 sec-config 里的 DNSLog 配置（平台地址 / token / 接收域名），
// 在接收域名下按 label 发子域给载荷注入，再用 token 回查平台；命中结果按 label 归因后落库。
// 与 dsh-nday-hunter 的 oob_probe 走同一套 CEYE 兼容协议（`{url}/v1/records?token=&type=dns&filter=`，
// 响应取 `data[]` 或 `records[]`），不另造一套；模型自报的"有回连"一律不算。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readSettingsSection } from 'dsh-saker/settings-compat';

export const INTERACTION_RECORD_SCHEMA = `CREATE TABLE IF NOT EXISTS interaction_records (
 session_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(session_id,id)
);`;

const bounded = (value, size) => String(value ?? '').slice(0, size);

/** sec-config 的 DNSLog 三项配置；缺项由调用方明确报出，不猜。 */
export function readOobConfig(settings) {
  let section = {};
  try { section = readSettingsSection(settings, 'sec-config') ?? {}; } catch { section = {}; }
  const dnslog = section.dnslog ?? {};
  return {
    base: String(dnslog.url || '').trim().replace(/\/+$/, ''),
    token: String(dnslog.token || '').trim(),
    root: String(dnslog.domain || '').trim().replace(/^\.+/, '').replace(/\.+$/, ''),
  };
}

export function oobMissingConfig(config) {
  const missing = [];
  if (!config.base) missing.push('平台地址');
  if (!config.token) missing.push('token');
  if (!config.root) missing.push('接收域名');
  return missing;
}

/** 在接收域名下发一个可归因的子域：label 必填，不看 label 的回查会把别人的记录算成命中。 */
export function issueCallbackHost(config, { label } = {}) {
  const missing = oobMissingConfig(config);
  if (missing.length) throw new Error('DNSLog 未配置：' + missing.join('、') + '（设置 → 安全配置 → DNSLog 平台）');
  const tag = String(label || '').trim() || 'saker-' + randomBytes(4).toString('hex');
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/i.test(tag)) throw new Error('callback label 只能是小写字母、数字和短横线');
  if (!/^[a-z0-9][a-z0-9.-]{3,200}$/i.test(config.root)) throw new Error('DNSLog 接收域名格式无效');
  return { label: tag, host: tag + '.' + config.root };
}

export function oobRecordsEndpoint(base) {
  return /records/i.test(base) ? base : base + '/v1/records';
}

/** 宿主自己回查平台。认不出的响应当失败，绝不把平台错误页当成"有回连"。 */
export async function fetchOobRecords({ base, token, filter, timeoutMs = 8000, fetchImpl = fetch }) {
  if (!base || !token) throw new Error('DNSLog 平台地址与 token 必填');
  if (!filter) throw new Error('回查必须带 label/接收域名过滤条件');
  const url = new URL(oobRecordsEndpoint(base));
  url.searchParams.set('token', token);
  url.searchParams.set('type', 'dns');
  url.searchParams.set('filter', filter);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const text = bounded(await res.text(), 4000);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 下面按不认识处理 */ }
    const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.records) ? parsed.records : null;
    if (!rows) throw new Error('DNSLog 平台返回了无法识别的响应（HTTP ' + res.status + '）：' + bounded(text, 200));
    return { ok: true, rows };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    throw new Error(aborted ? 'DNSLog 回查超时（' + timeoutMs + 'ms）' : String(error?.message || error));
  } finally {
    clearTimeout(timer);
  }
}

const rowTime = row => {
  const raw = row?.created_at ?? row?.createdAt ?? row?.time ?? row?.timestamp ?? '';
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
};

/** 把平台命中落成宿主记录：空命中直接拒绝——"只有客户端访问"不构成服务端访问。 */
export function recordInteraction(store, sessionId, { label, host, rows, provider = 'dnslog', queriedAt = new Date().toISOString() } = {}) {
  if (!/^[a-z0-9][a-z0-9.-]{3,200}$/i.test(String(host || ''))) throw new Error('callback host required');
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/i.test(String(label || ''))) throw new Error('callback label required');
  if (!Array.isArray(rows) || !rows.length) throw new Error('no callback recorded for this label; a client-side request or a plain error is not server-side access');
  if (!Number.isFinite(Date.parse(String(queriedAt)))) throw new Error('invalid query timestamp');
  const boundedRows = rows.slice(0, 50).map(row => ({
    host: bounded(row?.host ?? row?.domain, 200), path: bounded(row?.path, 200), type: bounded(row?.type, 40),
    remoteAddress: bounded(row?.remote_addr ?? row?.remoteAddress ?? row?.ip, 80),
    createdAt: bounded(row?.created_at ?? row?.createdAt ?? row?.time ?? row?.timestamp, 60),
  }));
  const times = boundedRows.map(rowTime).filter(value => value !== null);
  const digest = createHash('sha256').update(JSON.stringify([label, host, boundedRows])).digest('hex');
  const record = { id: 'interaction-' + randomUUID(), source: 'host-dnslog-query', provider, label, host,
    queriedAt, rows: boundedRows, rowCount: boundedRows.length, digest,
    firstSeen: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastSeen: times.length ? new Date(Math.max(...times)).toISOString() : null };
  store.db.prepare('INSERT INTO interaction_records (session_id,id,record) VALUES (?,?,?)').run(sessionId, record.id, JSON.stringify(record));
  return record;
}

export function readInteractionRecord(store, sessionId, id) {
  const row = store.db.prepare('SELECT record FROM interaction_records WHERE session_id=? AND id=?').get(sessionId, String(id || ''));
  if (!row) throw new Error('interaction record not found in current session');
  return JSON.parse(row.record);
}

export function interactionSummary(record) {
  const { rows, ...rest } = record;
  return { ...rest, detail: 'redteam_execution action=detail id=' + record.id };
}
