// 添加测试资料（v6 第 7.1 节）：识别 → 解析 → 去重 → 关联 → 保存。
//
// 本轮实现「粘贴请求、响应或代码」这条离线入口：把用户给的原文保存成一份材料文件，
// 记录格式、条目数与字节摘要，按内容去重。不访问目标、不调用模型、不立刻发送。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_BYTES = 1024 * 1024; // 单次粘贴上限 1MB；更大请用文件/目录入口

/**
 * 身份线索（v6 第 7.1 节）：只识别「这份原文带了哪种身份头」，**不保存秘密本身**，
 * 也不猜账号归属——身份名称与秘密分开，归属未确定时界面显示「身份待关联」。
 */
export function identityHints(text) {
  const raw = String(text ?? '');
  const kinds = [];
  if (/^\s*(?:authorization|proxy-authorization)\s*:/im.test(raw) || /"(?:authorization|proxyAuthorization)"\s*:/i.test(raw)) kinds.push('authorization');
  if (/^\s*(?:cookie|set-cookie)\s*:/im.test(raw) || /"(?:cookie|setCookie)"\s*:/i.test(raw) || /"cookies"\s*:\s*\[/i.test(raw)) kinds.push('cookie');
  const seen = new Set();
  const out = [];
  for (const kind of kinds) { if (seen.has(kind)) continue; seen.add(kind); out.push({ kind, linked: false }); }
  return out;
}

/** 识别粘贴内容属于哪一类；只按可核对的形状判断，不猜。 */
export function detectFormat(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return 'empty';
  // 扫描导出：nmap XML / nuclei JSONL / ffuf JSON —— 先认形状，再谈解析。
  if (/^<\?xml[\s\S]*<nmaprun\b/i.test(trimmed) || /<nmaprun\b/i.test(trimmed.slice(0, 400))) return 'scan';
  if (/^\s*\{\s*"results"\s*:/.test(trimmed) && /"url"|"input"/.test(trimmed.slice(0, 800))) return 'scan';
  {
    const lines = trimmed.split(/\r?\n/).filter(line => line.trim()).slice(0, 5);
    if (lines.length && lines.every(line => /^\s*\{/.test(line))
      && lines.some(line => /"(?:template-id|matched-at|templateID|matcher-name)"/.test(line))) return 'scan';
  }
  // 资产 CSV/JSON：按表头或对象字段判断，不把任意 CSV 当资产。
  {
    const firstLine = trimmed.split(/\r?\n/)[0] || '';
    if (/,/.test(firstLine) && /(^|,)\s*(?:ip|host|domain|url|port)\s*(?:,|$)/i.test(firstLine)) return 'assets';
  }
  if (/^\[/.test(trimmed)) {
    try {
      const list = JSON.parse(trimmed);
      if (Array.isArray(list) && list.length && list.every(item => item && typeof item === 'object')
        && list.some(item => ['ip', 'host', 'domain', 'url', 'port'].some(key => key in item))) return 'assets';
    } catch { /* 不是合法 JSON 数组 */ }
  }
  if (/^\{[\s\S]*"log"[\s\S]*"entries"[\s\S]*\}$/.test(trimmed) || /^\s*\{\s*"log"/.test(trimmed)) {
    try { const parsed = JSON.parse(trimmed); if (parsed && parsed.log && Array.isArray(parsed.log.entries)) return 'har'; } catch { /* 不是合法 HAR */ }
  }
  if (/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+\S+\s+HTTP\/\d(?:\.\d)?\r?\n/i.test(trimmed)) return 'http';
  if (/^curl\s/i.test(trimmed)) return 'curl';
  if (/\.(?:js|mjs|cjs|ts|tsx)\b/i.test(trimmed.slice(0, 200)) && /(?:function|=>|const |let |var |import )/.test(trimmed)) return 'js';
  if (/^\s*[\[{]/.test(trimmed)) return 'json';
  return 'text';
}

/** HAR 摘要：条目数、涉及主机、每条的方法与状态；坏条目单独计数。 */
export function summarizeHar(text) {
  let doc;
  try { doc = JSON.parse(String(text)); } catch { return { format: 'har', invalid: true, entries: 0, hosts: [], broken: 0 }; }
  const list = doc?.log?.entries;
  if (!Array.isArray(list)) return { format: 'har', invalid: true, entries: 0, hosts: [], broken: 0 };
  const hosts = new Set();
  let broken = 0;
  // 坏记录要能定位到**第几条、为什么**，不是只报一个总数（v6 第 10.5 节 UI05「错误可定位」）。
  // 列表最多留 10 条，计数仍是真实总数。
  const brokenEntries = [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    try {
      const url = entry?.request?.url;
      if (typeof url !== 'string') throw new Error('entry without request.url');
      hosts.add(new URL(url).host);
    } catch (error) {
      broken += 1;
      if (brokenEntries.length < 10) {
        const reason = error instanceof Error && /entry without request\.url/.test(error.message)
          ? '缺少 request.url' : (error instanceof Error ? error.message : String(error));
        brokenEntries.push({ index: index + 1, reason });
      }
    }
  }
  return { format: 'har', invalid: false, entries: list.length, broken, brokenEntries, hosts: [...hosts].slice(0, 20) };
}

/** 扫描导出摘要：条目数 + 命中的主机（能解析多少算多少，坏行单独计数）。 */
export function summarizeScan(text) {
  const trimmed = String(text ?? '').trim();
  const hosts = new Set();
  let entries = 0, broken = 0;
  if (/<nmaprun\b/i.test(trimmed)) {
    // nmap 把地址放在 <host> 里的 <address addr="…">，要按整个 host 块取，不能只看 host 标签属性。
    const blocks = trimmed.match(/<host\b[\s\S]*?<\/host>/gi) || [];
    for (const block of blocks) {
      entries += 1;
      const a = /<address\s+addr="([^"]+)"/i.exec(block);
      if (a) hosts.add(a[1]); else broken += 1;
    }
    return { format: 'scan', kind: 'nmap-xml', entries, broken, hosts: [...hosts].slice(0, 20) };
  }
  const lines = trimmed.split(/\r?\n/).filter(line => line.trim());
  const looksJsonl = lines.length && lines.every(line => /^\s*\{/.test(line));
  const rows = looksJsonl ? lines.map(line => { try { return JSON.parse(line); } catch { broken += 1; return null; } }) : [];
  if (looksJsonl && rows.some(Boolean)) {
    for (const row of rows) {
      if (!row) continue;
      entries += 1;
      const value = row['matched-at'] || row.url || row.host || row.input;
      try { if (value) hosts.add(new URL(String(value)).host); } catch { if (value) hosts.add(String(value)); }
    }
    return { format: 'scan', kind: 'jsonl', entries, broken, hosts: [...hosts].slice(0, 20) };
  }
  try {
    const doc = JSON.parse(trimmed);
    const list = Array.isArray(doc?.results) ? doc.results : Array.isArray(doc) ? doc : null;
    if (list) {
      for (const row of list) { entries += 1; const value = row?.url || row?.host || row?.input; if (value) hosts.add(String(value).replace(/^https?:\/\//, '').split('/')[0]); }
      return { format: 'scan', kind: 'json', entries, broken, hosts: [...hosts].slice(0, 20) };
    }
  } catch { /* 交给下面按行统计 */ }
  return { format: 'scan', kind: 'unknown', entries: lines.length, broken, hosts: [...hosts].slice(0, 20) };
}

/** 资产列表摘要：条目数（CSV 去表头；JSON 数组长度）。 */
export function summarizeAssets(text) {
  const trimmed = String(text ?? '').trim();
  if (/^\[/.test(trimmed) || /^\{/.test(trimmed)) {
    try {
      const doc = JSON.parse(trimmed);
      const list = Array.isArray(doc) ? doc : Array.isArray(doc?.assets) ? doc.assets : [];
      return { format: 'assets', kind: 'json', entries: list.length };
    } catch { /* 落回 CSV */ }
  }
  const lines = trimmed.split(/\r?\n/).filter(line => line.trim());
  return { format: 'assets', kind: 'csv', entries: Math.max(0, lines.length - 1), header: lines[0] || '' };
}

/** 保存粘贴内容为一份材料文件并登记；同内容只保存一次（按摘要去重）。 */
export function importPastedMaterial(store, sessionId, input = {}, { home } = {}) {
  const text = typeof input.text === 'string' ? input.text : '';
  const bytes = Buffer.byteLength(text);
  if (!text.trim()) throw new Error('请先粘贴请求、响应或代码');
  if (bytes > MAX_BYTES) throw new Error('单次粘贴超过 1MB，请改用文件或目录入口');
  const format = detectFormat(text);
  if (format === 'empty') throw new Error('内容为空，无法识别格式');
  const digest = createHash('sha256').update(text).digest('hex');
  const identities = identityHints(text);
  const existing = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND digest=?').get(sessionId, digest);
  if (existing) {
    const record = JSON.parse(existing.record);
    return { id: record.id, format, bytes, digest, reused: true, summary: record.summary ?? null,
      identities: Array.isArray(record.identities) ? record.identities : identities, note: '相同内容已存在，合并来源而不是重复保存。' };
  }
  const root = home || (store.dbPath === ':memory:' ? (process.env.DSH_HOME || '.') : path.dirname(path.dirname(store.dbPath)));
  const dir = path.join(root, 'redteam-results', 'materials', String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const id = 'pasted-' + randomUUID();
  const file = path.join(dir, id + '.txt');
  fs.writeFileSync(file, text, 'utf8');
  const base = (typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '粘贴内容').slice(0, 120);
  const name = base + (path.extname(base) ? '' : '.txt');
  const summary = format === 'har' ? summarizeHar(text)
    : format === 'scan' ? summarizeScan(text)
      : format === 'assets' ? summarizeAssets(text)
        : { format, bytes, lines: text.split(/\r?\n/).length };
  const record = { id, file, name, sourceUrl: 'local:' + name, site: '', digest, hints: [], identities,
    coverage: { pasted: true }, summary };
  try {
    store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
      .run(sessionId, id, record.sourceUrl, digest, JSON.stringify(record));
  } catch (error) {
    // 登记失败就不能留下"有文件、没记录"的半状态；把刚写的原文删掉再抛。
    try { fs.unlinkSync(file); } catch { /* 文件已不在 */ }
    throw error;
  }
  return { id, format, bytes, digest, reused: false, summary, identities,
    note: '已保存原文并建立引用；不会立刻发送或访问网站，按需要再读取。' };
}
