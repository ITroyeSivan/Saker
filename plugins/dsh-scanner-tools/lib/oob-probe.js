import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const OOB_LABEL_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function readOobConfig(settings) {
  let section = {};
  try { section = settings?.get?.() ?? settings ?? {}; } catch { section = {}; }
  const dnslog = section?.dnslog ?? section?.['sec-config']?.dnslog ?? {};
  return {
    base: String(dnslog.url || '').trim().replace(/\/+$/, ''),
    token: String(dnslog.token || '').trim(),
    root: String(dnslog.domain || '').trim().replace(/^\.+/, '').replace(/\.+$/, ''),
  };
}

export function missingOobConfig(config) {
  const missing = [];
  if (!config.base) missing.push('平台地址（设置 → 安全配置 → DNSLog 平台 → 平台地址）');
  if (!config.token) missing.push('token（同上）');
  if (!config.root) missing.push('接收域名（同上，如 abc123.ceye.io）');
  return missing;
}

export function oobEndpoint(base) {
  return /records/i.test(base) ? base : base + '/v1/records';
}

export async function fetchOobRecords({ base, token, filter, timeoutMs = 8000, fetchImpl = fetch }) {
  if (!base || !token) return { ok: false, error: 'DNSLog 平台地址与 token 必填' };
  if (!filter) return { ok: false, error: '回查必须带可归因的 label 或域名过滤条件' };
  const url = new URL(oobEndpoint(base));
  url.searchParams.set('token', token);
  url.searchParams.set('type', 'dns');
  url.searchParams.set('filter', filter);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const text = (await response.text()).slice(0, 4000);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* handled below */ }
    const rows = Array.isArray(parsed?.data) ? parsed.data
      : Array.isArray(parsed?.records) ? parsed.records
        : null;
    if (!rows) return { ok: false, error: `DNSLog 平台返回了无法识别的响应（HTTP ${response.status}）：${text.slice(0, 200)}` };
    return { ok: true, rows };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return { ok: false, error: aborted ? `查询超时（${timeoutMs}ms）` : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function parseAssets(value) {
  const seen = new Set();
  const rows = [];
  for (const raw of String(value || '').split(/[\r\n,]+/)) {
    let item = raw.trim();
    if (!item) continue;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(item)) item = 'http://' + item;
    let base;
    try {
      const parsed = new URL(item);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      base = parsed.origin;
    } catch { continue; }
    if (seen.has(base)) continue;
    seen.add(base);
    rows.push({ base });
  }
  return rows;
}

export function writeOobBatchTable(workspace, label, root, rows) {
  const directory = path.join(workspace, '.saker');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `oob-batch-${label}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schema: 'saker.oob-batch/1',
    label,
    root,
    createdAt: new Date().toISOString(),
    rows,
  }, null, 2));
  return file;
}

export async function runOobProbe(args = {}, { config, workspace, fetchImpl = fetch } = {}) {
  const missing = missingOobConfig(config || {});
  if (missing.length) {
    return {
      ok: false,
      error: `带外通道未配置：缺 ${missing.join('、')}。缺任一项都无法确认回连；反序列化、盲 RCE、SSRF 等只能停在疑似。`,
    };
  }

  if (args.action === 'new') {
    const label = `saker-${randomBytes(4).toString('hex')}`;
    const domain = `${label}.${config.root}`;
    return {
      ok: true,
      label,
      domain,
      text: `把下面这个域名注入到要确认的载荷或参数里：\n\n    ${domain}\n\n`
        + `注入后调 oob_probe action=check label=${label}（可给 waitMs 轮询等待）。\n`
        + '回连只证明载荷被处理并触发外连，不等于取得权限。',
    };
  }

  if (args.action === 'batch') {
    if (!workspace) return { ok: false, error: 'batch 需要 workspace，以便保存逐资产归因表' };
    const assets = parseAssets(args.assets);
    if (!assets.length) return { ok: false, error: 'batch 需要 assets：逗号或换行分隔的目标列表' };
    if (assets.length > 200) return { ok: false, error: 'batch 一次最多 200 个资产，请分批' };
    const label = `saker-${randomBytes(4).toString('hex')}`;
    const rows = assets.map((asset, index) => ({
      asset: asset.base,
      domain: `${label}-${index + 1}.${config.root}`,
    }));
    writeOobBatchTable(workspace, label, config.root, rows);
    return {
      ok: true,
      label,
      assets: rows.length,
      rows,
      text: `已为 ${rows.length} 个资产分配可归因子域名（前缀 ${label}）：\n`
        + rows.map(row => `  - ${row.asset} → ${row.domain}`).join('\n')
        + `\n\n把对应域名注入每个资产的载荷，再调 oob_probe action=check label=${label} workspace=<同一 workspace>。`
        + '\n回连只证明载荷被处理并触发外连，不等于取得权限。',
    };
  }

  const label = String(args.label || '').trim();
  if (!OOB_LABEL_RE.test(label)) {
    return { ok: false, error: 'check 需要 new/batch 返回的 label；没有 label 不能把回连归因到本次测试' };
  }
  let batchRows = null;
  if (workspace) {
    const batchFile = path.join(workspace, '.saker', `oob-batch-${label}.json`);
    if (fs.existsSync(batchFile)) {
      try { batchRows = JSON.parse(fs.readFileSync(batchFile, 'utf8')).rows ?? []; } catch { batchRows = null; }
    }
  }
  const filter = batchRows ? label : `${label}.${config.root}`;
  const waitMs = Math.min(Math.max(Number(args.waitMs) || 0, 0), 60000);
  const deadline = Date.now() + waitMs;
  let rows = [];
  for (;;) {
    const queried = await fetchOobRecords({ base: config.base, token: config.token, filter, fetchImpl });
    if (!queried.ok) return queried;
    rows = queried.rows;
    if (rows.length > 0 || Date.now() >= deadline) break;
    await sleep(3000);
  }

  const hits = batchRows
    ? rows.map(row => {
        const name = String(row?.name ?? row?.domain ?? '');
        const matched = batchRows.find(entry => name === entry.domain || name.endsWith(`.${entry.domain}`));
        return {
          asset: matched?.asset ?? '(未对上归因表)',
          domain: matched?.domain ?? name,
          remote: row?.remote_addr ?? row?.remoteAddress ?? row?.ip ?? '?',
          at: row?.created_at ?? row?.timestamp ?? '?',
        };
      })
    : [];
  const hitAssets = [...new Set(hits.map(hit => hit.asset).filter(asset => asset !== '(未对上归因表)'))];
  const preview = rows.slice(0, 5).map(row => {
    const name = row?.name ?? row?.domain ?? '(no name)';
    const remote = row?.remote_addr ?? row?.remoteAddress ?? row?.ip ?? '?';
    const when = row?.created_at ?? row?.timestamp ?? '?';
    return `${name} ← ${remote} @ ${when}`;
  });
  return {
    ok: true,
    hit: rows.length > 0,
    domain: filter,
    count: rows.length,
    ...(batchRows ? { assets: batchRows.length, hitAssets, hits } : {}),
    records: preview,
    text: batchRows
      ? (rows.length
          ? `批量回连：${batchRows.length} 个资产中命中 ${hitAssets.length} 个\n`
            + hits.map(hit => `  - ${hit.asset} ← ${hit.remote} @ ${hit.at}（${hit.domain}）`).join('\n')
            + '\n\n逐条按子域名后缀归因；回连只证明载荷被处理并触发外连，不等于取得权限。'
          : `未收到回连（${batchRows.length} 个资产，等待 ${waitMs}ms 内 0 条记录）。\n`
            + '未回连不等于不存在，可能受载荷、触发条件、出网限制或平台延迟影响。')
      : (rows.length
          ? `收到回连：${filter} 命中 ${rows.length} 条\n${preview.map(line => `  - ${line}`).join('\n')}\n\n`
            + '回连只证明目标处理载荷并触发外连；权限或影响仍需后续证据。'
          : `未收到回连（${filter}，等待 ${waitMs}ms 内 0 条记录）。\n`
            + '未回连不等于不存在，可能受载荷、触发条件、出网限制或平台延迟影响。'),
  };
}
