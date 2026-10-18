// 知识自动补充（v6 第 6.1/6.2 节）。
//
// 触发：消息里出现新的 CVE/EDB 精确标识或「产品 + 版本」，进入同一检索队列；
// 用量上限：每个触发批次最多 3 条、正文+标题+出处+包装合计 ≤3000 UTF-8 字节
// （无计量器时用字节上限，不冒充精确 token）；同一问题 ≤9000、整任务 ≤30000；
// 去重：同一事实只触发一次，已在上下文里的同版片段只返回引用、不重复正文；
// 关闭知识库时这些入口统一停止新读。
//
// 本模块只做纯计算（抽事实、打包、渲染、预算判定），读会话/账本与写使用记录留给调用方，
// 这样每条规则都能在没有宿主的单元测试里直接断言。

export const AUTO_BATCH_MAX_ITEMS = 3;
export const AUTO_BATCH_BYTES = 3000;
export const AUTO_QUESTION_BYTES = 9000;
export const AUTO_TASK_BYTES = 30000;

const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/gi;
const EDB_RE = /\bEDB[-_ ]?\d{3,6}\b/gi;
const PRODUCT_RE = /\b([A-Za-z][A-Za-z0-9.+-]{1,29})\s+(\d+(?:\.\d+){1,3})\b/gi;
// 只出现产品名、没有版本时也允许进入本地资料查询；版本保持 unknown，不冒充命中具体版本。
const PRODUCT_ONLY_RE = /(?:发现产品|产品(?:名称)?)\s*[:：]?\s*([A-Za-z][A-Za-z0-9.+-]{1,29})/gi;
const PRODUCT_STOPWORDS = new Set(['and', 'or', 'the', 'version', 'from', 'with', 'for', 'this', 'that', 'http', 'https', 'port', 'host', 'server', 'client', 'user', 'test', 'target', 'product']);
// 常见别名归一：检索本身大小写不敏感，这里主要避免同一产品因写法不同被重复触发。
const PRODUCT_ALIASES = new Map([
  ['apache', 'Apache'], ['httpd', 'Apache'], ['nginx', 'Nginx'], ['log4j', 'Log4j'], ['log4j2', 'Log4j2'],
  ['spring', 'Spring'], ['tomcat', 'Tomcat'], ['weblogic', 'WebLogic'], ['jboss', 'JBoss'], ['shiro', 'Shiro'],
  ['fastjson', 'Fastjson'], ['struts', 'Struts'], ['thinkphp', 'ThinkPHP'], ['drupal', 'Drupal'],
  ['wordpress', 'WordPress'], ['jenkins', 'Jenkins'], ['gitlab', 'GitLab'], ['confluence', 'Confluence'],
  ['jira', 'Jira'], ['grafana', 'Grafana'], ['zabbix', 'Zabbix'], ['phpmyadmin', 'phpMyAdmin'],
  ['nacos', 'Nacos'], ['rocketmq', 'RocketMQ'], ['elasticsearch', 'Elasticsearch'], ['redis', 'Redis'],
  ['mysql', 'MySQL'], ['postgresql', 'PostgreSQL'], ['mssql', 'MSSQL'], ['oracle', 'Oracle'],
  ['exchange', 'Exchange'], ['sharepoint', 'SharePoint'], ['iis', 'IIS'], ['openssh', 'OpenSSH'],
  ['openssl', 'OpenSSL'], ['sudo', 'sudo'], ['polkit', 'polkit'], ['glibc', 'glibc'],
]);
const canonicalProduct = value => PRODUCT_ALIASES.get(String(value).toLowerCase()) || String(value);

/**
 * 从一段文本里抽可检索的新事实：CVE/EDB 精确标识优先，其次「产品 + 版本」。
 * 大小写归一、同一段内去重；不猜没写出版本的产品。
 */
export function extractFacts(text) {
  const facts = [];
  const seen = new Set();
  const push = (value, kind) => {
    const key = String(value).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    facts.push({ value: String(value), kind });
  };
  const raw = String(text || '');
  for (const match of raw.matchAll(CVE_RE)) push(match[0].toUpperCase(), 'cve');
  for (const match of raw.matchAll(EDB_RE)) push(match[0].replace(/\s+/g, '').toUpperCase(), 'edb');
  for (const match of raw.matchAll(PRODUCT_RE)) {
    const name = canonicalProduct(match[1]);
    if (PRODUCT_STOPWORDS.has(name.toLowerCase())) continue;
    push(name + ' ' + match[2], 'product');
  }
  for (const match of raw.matchAll(PRODUCT_ONLY_RE)) {
    const name = canonicalProduct(match[1]);
    if (PRODUCT_STOPWORDS.has(name.toLowerCase())) continue;
    push(name, 'product');
  }
  return facts;
}

/**
 * 打包一个自动补充批次：条数与字节谁先到算谁；不拆条目正文，宁可少给一条。
 * 返回被丢弃的条数，便于上层如实说明而不是静默吞掉。
 */
export function packAutoItems(items, { maxItems = AUTO_BATCH_MAX_ITEMS, maxBytes = AUTO_BATCH_BYTES } = {}) {
  const kept = [];
  for (const item of items) {
    if (kept.length >= maxItems) break;
    // 按最终将发送的完整块计量：标题、来源、路径、chunkId、ref 与分隔符都算在内。
    if (Buffer.byteLength(renderAutoBlock([...kept, item]), 'utf8') > maxBytes) break;
    kept.push(item);
  }
  const bytes = Buffer.byteLength(renderAutoBlock(kept), 'utf8');
  return { items: kept, bytes, dropped: Math.max(0, items.length - kept.length) };
}

/** 紧凑自动补充块：标题/来源/位置/chunkId/ref + 短片段；正文已在上游截断。 */
export function renderAutoBlock(items) {
  if (!items.length) return '';
  return 'Saker knowledge auto-provide\n'
    + items.map(item => `[${item.source}] ${item.path}:${item.line} chunk=${item.chunkId}${item.deliveryId ? ' ref=' + item.deliveryId : ''}\n${item.title ? item.title + ' · ' : ''}${item.preview ?? item.text ?? ''}`).join('\n---\n');
}

/**
 * 累计额度判定：同一问题与整任务分别计数，先到先停止。
 * `used` 为已经提供的自动补充字节数（问题级/任务级），本批要再加 `next` 字节。
 */
export function autoBudgetAllows(used, next, { questionBytes = AUTO_QUESTION_BYTES, taskBytes = AUTO_TASK_BYTES } = {}) {
  const question = Number.isFinite(used?.questionBytes) ? used.questionBytes : 0;
  const task = Number.isFinite(used?.taskBytes) ? used.taskBytes : 0;
  const add = Number.isFinite(next) && next > 0 ? next : 0;
  return {
    allowed: question + add <= questionBytes && task + add <= taskBytes,
    questionRemaining: Math.max(0, questionBytes - question),
    taskRemaining: Math.max(0, taskBytes - task),
  };
}
