// 测试资料页（v6 第 5.4 节）：把当前会话的资产、请求与已索引文件整理成统一列表。
//
// 只做只读整理：不访问目标、不调用模型、不复制漏洞结论。请求原文仍存在任务上下文里，
// 这里只给列表字段与引用；知识文章与账号不属于本页。
import path from 'node:path';
import fs from 'node:fs';
import { readTaskContext } from './task-context.js';
import { readInventory } from 'dsh-saker/asset-inventory';
import { listMaterialReads, listMaterialViews, materialReadKey } from './material-reads.js';
import { findingsReferencing } from './store.js';
import { summarizeHar } from './materials-import.js';

const TYPES = new Set(['all', 'asset', 'request', 'file']);
const SORTS = new Set(['recent', 'name']);
// 读取状态筛选（v6 第 5.4 节）：模型读过 / 只本地看过 / 都没碰过，三类分开。
const READ_FILTERS = new Set(['all', 'model', 'local', 'unread']);
// 模型读原文时按扩展名区分“代码”（80 行上限）与普通文本。
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.java', '.php',
  '.cs', '.c', '.h', '.cc', '.cpp', '.rs', '.sh', '.ps1', '.sql', '.yml', '.yaml', '.json', '.html', '.htm',
  '.css', '.xml', '.vue', '.svelte', '.toml', '.ini', '.conf']);
const HTTP_FORMATS = new Set(['http', 'har', 'curl']);
const CODE_LINE_LIMIT = 80;
const EXCERPT_DEFAULT_BYTES = 6000;

// 主机名与端口分开：端口有独立字段，host 只放主机名，便于按站点聚合。
const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };
const protocolOf = url => { try { return new URL(url).protocol.replace(':', ''); } catch { return ''; } };
const portOf = url => { try { const u = new URL(url); return u.port || (u.protocol === 'https:' ? '443' : '80'); } catch { return ''; } };
function statusOf(response) { const m = /^HTTP\/\S+\s+(\d{3})/.exec(String(response || '')); return m ? Number(m[1]) : null; }
function requestOf(packet) { const m = /^([A-Z]+)\s+(\S+)\s+HTTP\//.exec(String(packet || '')); return m ? { method: m[1], target: m[2] } : { method: '', target: '' }; }

/** 已索引的 JS/源码文件（来自 business_materials）。坏行隔离，不拖垮整页。 */
function fileRows(store, sessionId) {
  const rows = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? ORDER BY rowid').all(sessionId);
  const out = [];
  for (const row of rows) {
    try {
      const record = JSON.parse(row.record);
      // 显示用可读名称：导入时用户给的名字（record.name）优先于磁盘上的内部文件名
      // （pasted-<uuid>.txt）——列表里该让人看到 practice-assets.csv，而不是内部 id。
      const name = String(record.name || '').trim() || path.basename(String(record.file || '')) || record.id;
      const summary = record.summary && typeof record.summary === 'object' ? record.summary : null;
      out.push({ kind: 'file', id: record.id, title: name, meta: { name, source: record.sourceUrl || '', site: record.site || '',
        digest: record.digest || '', hints: Array.isArray(record.hints) ? record.hints.length : 0,
        // 粘贴/导入的原文带上识别出的格式与条目数，列表里能直接看出导入结果。
        format: summary?.format || '', entries: Number.isInteger(summary?.entries) ? summary.entries : null,
        // 坏记录数（v6 第 10.3 节 E09「导入完整性」）：HAR 里解析不了的条目单独计数，
        // 列表里必须看得见 —— 只报"已索引"会让用户以为整份都进来了。
        broken: Number.isInteger(summary?.broken) ? summary.broken : null,
        hosts: Array.isArray(summary?.hosts) ? summary.hosts.slice(0, 5) : [],
        bytes: Number.isInteger(summary?.bytes) ? summary.bytes : null,
        // 身份线索：只记「带了哪种身份头」，归属未确定就是待关联（v6 第 7.1 节）。
        identities: Array.isArray(record.identities) ? record.identities.length : 0,
        unresolved: !!(record.coverage && (record.coverage.dynamicCallsUnresolved || record.coverage.capped)) } });
    } catch { /* 坏记录隔离：不进入列表，也不抛错 */ }
  }
  return out;
}

// 任务上下文把 `https://a.test` 存成带尾斜杠，账本保留原样；去重前统一去掉尾斜杠再比。
const assetKey = (url) => String(url || '').trim().toLowerCase().replace(/\/+$/, '');

/**
 * 工作区资产账本（asset-inventory.json）里的资产。
 *
 * 为什么要有这一步（v6 第 7.2 节 / 12.2 C03「资产→可用材料」）：扫描器与测绘工具把结果写进
 * **工作区账本**，而资料列表原来只读任务 `task_context`，于是"已收集"的资产在「测试资料」页
 * 看不到，成了独立孤岛。这里把账本资产并进列表（按 URL 去重，任务里已有的以任务记录为准）。
 */
function inventoryAssetRows(workspace, seen) {
  if (!workspace) return [];
  const out = [];
  for (const asset of readInventory(workspace).assets || []) {
    const url = String(asset.target || '');
    const key = assetKey(url) || String(asset.id || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: 'asset', id: 'inventory:' + (asset.id || key), title: url || asset.host || asset.ip,
      meta: { host: asset.host || hostOf(url), protocol: asset.protocol || protocolOf(url), port: String(asset.port || portOf(url) || ''),
        product: (asset.tech || []).join('、') || asset.server || '', source: (asset.sources || []).join('/'),
        authorized: asset.authorized === true, origin: 'inventory' } });
  }
  return out;
}

/**
 * 统一的资料列表。type 为 all/asset/request/file；query 匹配标题与来源；
 * 分页为服务端切片（pageSize 默认 50）。返回 counts 供顶部筛选显示。
 */
export function materialsList(store, sessionId, options = {}) {
  const type = options.type ?? 'all';
  if (!TYPES.has(type)) throw new Error('资料类型只能是全部、网站与端口、请求或文件');
  const sort = options.sort ?? 'recent';
  if (!SORTS.has(sort)) throw new Error('资料排序无效');
  const readFilter = options.read ?? 'all';
  if (!READ_FILTERS.has(readFilter)) throw new Error('资料读取筛选无效');
  const page = options.page ?? 1, pageSize = options.pageSize ?? 50;
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Error('页号无效');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('每页数量无效');

  const context = readTaskContext(store, sessionId);
  const rows = [];
  const seenAssetUrls = new Set();
  for (const asset of context?.assets || []) {
    const key = assetKey(asset?.url);
    if (key) seenAssetUrls.add(key);
    rows.push({ kind: 'asset', id: asset.id, title: asset.url,
      meta: { host: hostOf(asset.url), protocol: protocolOf(asset.url), port: portOf(asset.url),
        product: asset.product || asset.tech || '', source: asset.source || '', inScope: asset.inScope === true, reachable: asset.reachable === true, origin: 'task' } });
  }
  for (const request of context?.requests || []) {
    const parsed = requestOf(request.request);
    rows.push({ kind: 'request', id: request.id + ':' + request.revision, title: (parsed.method || request.kind || '请求') + ' ' + request.endpoint,
      meta: { method: parsed.method, host: hostOf(request.endpoint), path: parsed.target || '', endpoint: request.endpoint,
        account: request.authContext, status: statusOf(request.response), valid: request.valid === true, revision: request.revision } });
  }
  rows.push(...fileRows(store, sessionId));
  // 工作区账本里"已收集但任务资料还没登记"的资产（去重后）也进列表，避免独立孤岛。
  rows.push(...inventoryAssetRows(options.workspace, seenAssetUrls));

  const counts = { all: rows.length, asset: 0, request: 0, file: 0 };
  for (const row of rows) counts[row.kind] += 1;

  // 「模型是否读过」（v6 第 5.4 节）：只认模型真的通过工具读过原文的那一次；
  // 本地浏览详情、引用到输入框都不算（它们不增加模型输入）。
  const reads = listMaterialReads(store, sessionId);
  const views = listMaterialViews(store, sessionId);
  for (const row of rows) {
    const key = materialReadKey(row.kind, row.id);
    const hit = reads.get(key);
    row.modelRead = Boolean(hit);
    row.readAt = hit ? new Date(hit.at).toISOString() : null;
    // 「本地查看过」与「模型收到过」分别保存（v6 第 5.4 节）：打开详情是本地动作，不增加模型输入。
    const seen = views.get(key);
    row.viewedAt = seen ? new Date(seen.at).toISOString() : null;
  }

  const q = String(options.query ?? '').trim().toLowerCase();
  let filtered = rows.slice().reverse(); // 默认最近添加的在最前
  if (type !== 'all') filtered = filtered.filter(row => row.kind === type);
  if (q) filtered = filtered.filter(row => (row.title + ' ' + [row.meta.host, row.meta.source, row.meta.account, row.meta.path, row.meta.product].join(' ')).toLowerCase().includes(q));
  if (readFilter === 'model') filtered = filtered.filter(row => row.modelRead);
  else if (readFilter === 'local') filtered = filtered.filter(row => row.viewedAt && !row.modelRead);
  else if (readFilter === 'unread') filtered = filtered.filter(row => !row.modelRead && !row.viewedAt);
  if (sort === 'name') filtered = filtered.slice().sort((a, b) => a.title.localeCompare(b.title));

  const total = filtered.length, offset = (page - 1) * pageSize;
  const pageRows = filtered.slice(offset, offset + pageSize);
  return { type, sort, read: readFilter, page, pageSize, total, counts, rows: pageRows, more: Math.max(0, total - offset - pageRows.length),
    note: '列表正文只用于定位；实际读取原文才会计入模型输入。' };
}

/** 已索引文件的导入时间；没有就返回空串。 */
function materialIndexedAt(store, sessionId, id) {
  const row = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sessionId, id);
  if (!row) return '';
  let record;
  try { record = JSON.parse(row.record); } catch { return ''; }
  if (Number.isFinite(record.indexedAt)) return new Date(record.indexedAt).toISOString();
  // 粘贴/导入的材料不一定带 indexedAt：退回原文件的写入时间，别让结果里的“时间”永远是空。
  try { return fs.statSync(record.file).mtime.toISOString(); } catch { return ''; }
}

/**
 * 模型侧的资料搜索（v6 第 5.4.1 节）：默认最多 **5 条短结果**，含来源、身份与时间，并给下一页游标；
 * 输出按 **3000 UTF-8 字节** 封顶（没有可靠 tokenizer 时的降级口径），超出就少给几条并标 `truncated`。
 * 短结果只用于定位；要正文仍走 materialsDetail 的分段读取，那一步才计入模型输入。
 */
export function searchMaterials(store, sessionId, { query, offset = 0, workspace } = {}) {
  const text = String(query ?? '').trim();
  if (!text) throw new Error('搜索测试资料需要关键词');
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('搜索游标无效');
  const PAGE_SIZE = 5;
  const list = materialsList(store, sessionId, { type: 'all', sort: 'recent', page: Math.floor(offset / PAGE_SIZE) + 1, pageSize: PAGE_SIZE, query: text, workspace });
  const results = list.rows.map(row => ({
    kind: row.kind,
    id: row.kind === 'request' ? String(row.id).split(':')[0] : row.id,
    name: String(row.title || '').slice(0, 120),
    source: String(row.meta.source || row.meta.host || row.meta.endpoint || '').slice(0, 120),
    identity: String(row.meta.account || '').slice(0, 60),
    time: row.kind === 'file' ? materialIndexedAt(store, sessionId, row.id) : '',
  }));
  // `unit` 说明这里的 3000 是 UTF-8 字节上限（没有可靠 tokenizer 的降级口径），不是精确 token。
  const payload = { query: text, offset, pageSize: PAGE_SIZE, total: list.total, unit: 'bytes-approx', results,
    nextOffset: list.more > 0 ? offset + PAGE_SIZE : null,
    note: '短结果只用于定位；读取原文才计入模型输入（默认每段 6000 字节，可续读）。' };
  let truncated = false;
  let json = JSON.stringify(payload);
  while (Buffer.byteLength(json) > 3000 && payload.results.length) { payload.results.pop(); truncated = true; json = JSON.stringify(payload); }
  return { ...payload, truncated, text: json };
}

/**
 * 模型侧读取材料原文（v6 第 5.4.1 节）：默认每段最多 **6000 UTF-8 字节**；
 * 代码最多 **80 行**；HTTP 把**头与体分开**并标出截断落在哪一段；先到限制分页，用 nextOffset 续读。
 * 只读本机已保存的原文，不访问目标、不调用模型。
 */
export function readMaterialExcerpt(store, sessionId, { id, offset = 0, limit } = {}) {
  const target = String(id || '').trim();
  if (!target) throw new Error('读取材料原文需要 material id');
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000000000) throw new Error('读取偏移无效');
  const row = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(String(sessionId || ''), target);
  if (!row) throw new Error('材料不存在于当前任务');
  let record;
  try { record = JSON.parse(row.record); } catch { throw new Error('文件记录损坏，无法读取'); }
  const name = String(record.name || '').trim() || path.basename(String(record.file || '')) || target;
  let bytes;
  try { bytes = fs.readFileSync(record.file); }
  catch {
    const missing = { id: target, name, missing: true, note: '原始文件已不在本机；只保留索引信息。' };
    return { ...missing, text: JSON.stringify(missing) };
  }
  const budget = Number.isInteger(limit) ? Math.max(512, Math.min(limit, 16384)) : EXCERPT_DEFAULT_BYTES;
  const slice = bytes.subarray(offset, offset + budget);
  const byteTruncated = offset + slice.length < bytes.length;
  const format = String(record.summary?.format || '').toLowerCase();
  const kind = HTTP_FORMATS.has(format) ? 'http' : CODE_EXTENSIONS.has(path.extname(name).toLowerCase()) ? 'code' : 'text';
  const base = { id: target, name, kind, offset, limit: budget, totalBytes: bytes.length };
  if (kind === 'http') {
    // 头/体分开给：只有头被截断、还是体被截断，必须一眼能分清，避免把半截体当完整报文。
    const text = slice.toString('utf8');
    const split = text.indexOf('\r\n\r\n');
    const head = split >= 0 ? text.slice(0, split) : text;
    const body = split >= 0 ? text.slice(split + 4) : '';
    const payload = { ...base, head, body, headTruncated: split < 0, bodyTruncated: split >= 0 && byteTruncated,
      nextOffset: byteTruncated ? offset + slice.length : null,
      note: '头与体分开；截断位置已标注，用 nextOffset 续读。' };
    return { ...payload, text: JSON.stringify(payload) };
  }
  if (kind === 'code') {
    // 代码先到限制：字节预算或 80 行，哪个先到算哪个。
    const lines = slice.toString('utf8').split('\n');
    const capped = lines.length > CODE_LINE_LIMIT;
    const kept = capped ? lines.slice(0, CODE_LINE_LIMIT) : lines;
    const content = kept.join('\n');
    const nextOffset = capped ? offset + Buffer.byteLength(content + '\n', 'utf8') : (byteTruncated ? offset + slice.length : null);
    // 先到限制可能是行数（80 行）也可能是字节（6000）：note 必须说清到底被哪个截断，
    // 否则 nextOffset 非空却写"没有更多内容"，模型会以为读完了。
    const note = capped ? '代码最多 80 行，本段先到行数上限；用 nextOffset 续读。'
      : byteTruncated ? '代码每段最多 6000 字节，本段先到字节上限（行数未到 80）；用 nextOffset 续读。'
        : '代码最多 80 行；本段之后没有更多内容。';
    const payload = { ...base, lines: kept.length, content, nextOffset,
      note };
    return { ...payload, text: JSON.stringify(payload) };
  }
  const payload = { ...base, content: slice.toString('utf8'), nextOffset: byteTruncated ? offset + slice.length : null,
    note: '默认每段最多 6000 字节；用 nextOffset 续读。' };
  return { ...payload, text: JSON.stringify(payload) };
}

/** 掩码：原文里的账号密钥不直接回显，用户展开后本地查看。 */
function maskSecrets(text) {
  return String(text || '')
    .replace(/^(authorization|proxy-authorization|cookie|set-cookie):[^\r\n]*/gim, (line) => line.split(':')[0] + ': [已遮蔽]');
}

/**
 * 资料详情：请求给原文（遮蔽密钥）与身份/状态；资产给相关请求与入口；文件给元数据与本地分页片段。
 * 只读本地已保存内容，不访问目标、不调用模型。
 */
export function materialsDetail(store, sessionId, { kind, id, offset, limit } = {}) {
  const context = readTaskContext(store, sessionId);
  if (kind === 'asset') {
    const asset = (context?.assets || []).find(row => row.id === id);
    if (!asset) throw new Error('资产不存在或已移除');
    const related = (context?.requests || []).filter(row => { try { return new URL(row.endpoint).origin === new URL(asset.url).origin; } catch { return false; } });
    return { kind, id, url: asset.url, inScope: asset.inScope === true, reachable: asset.reachable === true,
      product: asset.product || asset.tech || '', source: asset.source || '',
      relatedRequests: related.map(row => ({ id: row.id, revision: row.revision, endpoint: row.endpoint, authContext: row.authContext, valid: row.valid === true })),
      note: '范围外的资产只作线索，不自动访问。' };
  }
  if (kind === 'request') {
    const [requestId, revision] = String(id).split(':');
    const row = (context?.requests || []).find(item => item.id === requestId && item.revision === revision);
    if (!row) throw new Error('请求不存在或已移除');
    const relatedChecks = (context?.checks || []).filter(check => check.endpoint === row.endpoint && check.authContext === row.authContext)
      .map(check => ({ entryId: check.entryId, requestValid: check.requestValid === true, methodReviewed: check.methodReviewed === true }));
    return { kind, id, endpoint: row.endpoint, authContext: row.authContext, revision: row.revision, valid: row.valid === true,
      request: maskSecrets(row.request), response: maskSecrets(row.response),
      inputs: Array.isArray(row.inputs) ? row.inputs.map(input => ({ name: input.name, location: input.location })) : [],
      relatedChecks, relatedFindings: findingsReferencing(store, sessionId, 'request', id),
      note: '原文按保存时的字节返回；密钥已遮蔽。回执不等于影响成立。' };
  }
  if (kind === 'file') {
    const raw = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sessionId, id);
    if (!raw) throw new Error('文件不存在或已移除');
    let record;
    try { record = JSON.parse(raw.record); } catch { throw new Error('文件记录损坏，无法读取'); }
    // 大文件分段（v6 第 9.3 节）：按 offset/limit 读一段并给出 nextOffset，
    // 调用方可以续读，而不是只看得到前 6000 字节。单段上限 16KB，避免一次灌爆上下文。
    const start = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const size = Number.isInteger(limit) ? Math.max(512, Math.min(limit, 16384)) : 6000;
    let preview = null, truncated = false, missing = false, totalBytes = null, nextOffset = null, bytes = null;
    try {
      bytes = fs.readFileSync(record.file);
      totalBytes = bytes.length;
      preview = bytes.subarray(start, start + size).toString('utf8');
      nextOffset = start + size < bytes.length ? start + size : null;
      truncated = nextOffset !== null;
    } catch { missing = true; }
    let importSummary = record.summary && typeof record.summary === 'object' ? {
      format: record.summary.format || '',
      entries: Number.isInteger(record.summary.entries) ? record.summary.entries : null,
      broken: Number.isInteger(record.summary.broken) ? record.summary.broken : null,
      hosts: Array.isArray(record.summary.hosts) ? record.summary.hosts.slice(0, 5) : [],
      brokenEntries: Array.isArray(record.summary.brokenEntries) ? record.summary.brokenEntries.slice(0, 10) : [],
    } : null;
    // 升级前导入的记录可能只有坏记录总数、没有“第几条、为什么”。详情是只读入口，
    // 从本地原文重算一次，历史资料也能定位，不要求用户重新导入。
    if (importSummary && importSummary.format === 'har' && importSummary.broken > 0
      && importSummary.brokenEntries.length === 0 && bytes && bytes.length <= 32 * 1024 * 1024) {
      const recomputed = summarizeHar(bytes.toString('utf8'));
      if (!recomputed.invalid && recomputed.brokenEntries.length) {
        importSummary = {
          ...importSummary,
          entries: recomputed.entries,
          broken: recomputed.broken,
          hosts: recomputed.hosts.slice(0, 5),
          brokenEntries: recomputed.brokenEntries.slice(0, 10),
        };
      }
    }
    return { kind, id, name: String(record.name || '').trim() || path.basename(String(record.file || '')) || record.id, source: record.sourceUrl || '', site: record.site || '',
      digest: record.digest || '', hints: Array.isArray(record.hints) ? record.hints.length : 0,
      identities: Array.isArray(record.identities) ? record.identities : [],
      // 导入摘要（v6 第 10.5 节 UI05「错误可定位」）：条目数、坏记录数，以及坏的是第几条、为什么。
      importSummary,
      coverage: record.coverage || null, missing, truncated, preview,
      offset: start, limit: size, totalBytes, nextOffset,
      relatedFindings: findingsReferencing(store, sessionId, 'file', id),
      note: '分段本地查看；用 nextOffset 续读，预览不证明接口可用，也不会自动送入模型。' };
  }
  throw new Error('资料类型只能是 asset、request 或 file');
}

/**
 * 从本任务移除材料引用（v6 第 5.4 节）：默认动作只移除**引用**，不删磁盘原文
 * （磁盘清理另做引用检查）；仍被问题引用时拒绝，避免把报告还在用的原文抽走。
 */
export function removeMaterial(store, sessionId, { id } = {}) {
  const target = String(id || '').trim();
  if (!target) throw new Error('移除材料需要 id');
  const row = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sessionId, target);
  if (!row) throw new Error('这份材料不在当前任务里');
  const refs = findingsReferencing(store, sessionId, 'file', target);
  if (refs.length) throw new Error('这份原文仍被 ' + refs.length + ' 个问题引用（' + refs.map(item => item.id).join('、')
    + '）：先从问题里去掉引用再移除，或保留它；磁盘清理另做引用检查。');
  store.db.prepare('DELETE FROM business_materials WHERE session_id=? AND id=?').run(sessionId, target);
  return { id: target, removed: true, note: '只从本任务移除引用；磁盘上的原文仍在，清理另做引用检查。' };
}
