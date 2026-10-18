// 测试内容目录（17 项）：界面显示中文用途，后台只按稳定 ID 判断动作。
//
// 为什么独立：方法分类曾经把"某个方法需要哪些模块"绑到执行闸上，用户关掉一项后
// 还要先有方法分类才肯放行。这一层只声明**测试内容本身**（稳定 ID、中文显示名、
// 分组、用途、默认排除项），不再读方法正文、不给任何方法建立执行前置。
//
// 边界：
//   · 稳定 ID 是唯一权威；改名、改中文说明不动 ID。
//   · 默认全选 17 项；cors、open-redirect 不在目录里，只作为默认排除项单独保存。
//   · 目录工具（httpx/ffuf/...）把稳定 ID 映射到测试内容，缺映射的工具不在此处猜。

const ITEM = (id, label, group, purpose, tech) => Object.freeze({ id, label, group, purpose, ...(tech ? { tech } : {}) });

export const TEST_CONTENT_GROUPS = Object.freeze([
  Object.freeze({ id: 'recon', label: '信息收集' }),
  Object.freeze({ id: 'web', label: 'Web 检查' }),
]);

export const TEST_CONTENT_ITEMS = Object.freeze([
  ITEM('subdomain', '网站与子域名', 'recon', '整理当前授权范围内的站点与子域名，标出来源与解析情况。'),
  ITEM('port-service', '端口与服务', 'recon', '识别开放端口、真实协议与可访问服务。'),
  ITEM('fingerprint', '网站技术识别', 'recon', '核对站点使用的产品、框架与组件线索。'),
  ITEM('directory', '目录与公开文件', 'recon', '查找可访问的目录、公开文件与历史页面。'),
  ITEM('js-api', 'JS 和接口', 'recon', '从页面脚本中整理接口、参数与调用关系。'),
  ITEM('access-control', '账号与访问权限', 'web', '比较不同账号、角色对同一对象的实际访问结果。'),
  ITEM('business-logic', '业务流程', 'web', '检查业务操作的前提、顺序、状态变化与影响。'),
  ITEM('sqli', '数据库查询（SQL 注入）', 'web', '核对输入进入数据库查询的路径与可观察影响。'),
  ITEM('xss', '网页脚本（XSS）', 'web', '核对输入进入页面或 DOM 的实际浏览器行为。'),
  ITEM('ssrf', '服务端请求（SSRF）', 'web', '核对服务端发起请求、加载远程或读取本地资源的功能。'),
  ITEM('file-upload', '文件上传', 'web', '检查上传、存储位置与访问方式造成的影响。'),
  ITEM('file-read', '文件读取', 'web', '核对文件读取功能的实际位置、内容与边界。'),
  ITEM('command-injection', '命令执行', 'web', '核对输入进入命令或系统调用的路径与影响。'),
  ITEM('ssti', '模板处理', 'web', '核对输入进入模板引擎处理的路径与影响。'),
  ITEM('deserialization', '对象反序列化', 'web', '核对反序列化入口、可控数据与可观察影响。'),
  ITEM('xxe', 'XML 解析', 'web', '核对 XML 解析配置与外部实体处理的实际结果。'),
  ITEM('jwt-session', '登录状态与令牌', 'web', '核对会话、令牌的生成、校验与失效行为。'),
]);

/** 后台稳定 ID 全集，顺序即界面顺序。 */
export const TEST_CONTENT_KEYS = Object.freeze(TEST_CONTENT_ITEMS.map(item => item.id));

const keySet = new Set(TEST_CONTENT_KEYS);

/**
 * 默认排除项：不在目录里的 CORS、开放重定向。只作为一条简短任务限制传给模型，
 * 不追加测试教程，也不自动生成问题或继续验证。
 */
export const DEFAULT_EXCLUDED_CHECKS = Object.freeze(['cors', 'open-redirect']);

/** 默认排除项不在目录里，显示名单独列一份，供"一行任务限制"用。 */
export const EXCLUDED_CHECK_LABELS = Object.freeze({ cors: 'CORS', 'open-redirect': '开放重定向' });

/** 稳定 ID → 界面显示名；未知 ID 原样返回，不编中文名。 */
export function testContentLabel(id) {
  return TEST_CONTENT_ITEMS.find(item => item.id === id)?.label || String(id);
}

/**
 * 旧方法分类键 → 新稳定 ID。只在一次性迁移时使用；迁移后不再按方法键判断动作。
 * 未覆盖的旧键（如 recon/segment-map、intranet/*）按“目录外”处理，不并入新目录。
 */
export const LEGACY_METHOD_TO_CONTENT = Object.freeze({
  'recon/subdomain-enum': 'subdomain',
  'recon/port-scan': 'port-service',
  'recon/fingerprint': 'fingerprint',
  'recon/dir-enum': 'directory',
  'recon/js-api': 'js-api',
  'exploit/sqli': 'sqli',
  'exploit/xss': 'xss',
  'exploit/ssrf': 'ssrf',
  'exploit/file-upload': 'file-upload',
  'exploit/file-read': 'file-read',
  'exploit/command-injection': 'command-injection',
  'exploit/ssti': 'ssti',
  'exploit/access-control': 'access-control',
  'exploit/business-logic': 'business-logic',
});

export function isTestContentKey(value) {
  return typeof value === 'string' && keySet.has(value);
}

/**
 * 规范化一组测试内容选择：只保留已知稳定 ID、去重、保持目录顺序。
 * 空数组是合法选择（用户有意全不选），不会被默认值替换。
 */
export function normalizeTestContent(active) {
  if (!Array.isArray(active)) throw new Error('测试内容设置格式错误');
  const set = new Set();
  for (const key of active) {
    if (typeof key !== 'string' || !key) throw new Error('测试内容设置格式错误');
    if (keySet.has(key)) set.add(key);
  }
  return TEST_CONTENT_KEYS.filter(key => set.has(key));
}

/** 落在目录外的键单独返回，界面按“本版本不可用”标注，不悄悄当成允许。 */
export function unknownTestContent(active) {
  if (!Array.isArray(active)) return [];
  return [...new Set(active.filter(key => typeof key === 'string' && !keySet.has(key)))];
}

/** 旧方法键 / 旧记录迁移为新稳定 ID。返回 { mapped, unknown, changed }。 */
export function migrateLegacyContent(active) {
  if (!Array.isArray(active)) return { mapped: [], unknown: [], changed: false };
  const out = new Set(), unknown = new Set();
  for (const key of active) {
    if (keySet.has(key)) { out.add(key); continue; }
    const mapped = LEGACY_METHOD_TO_CONTENT[key];
    if (mapped) out.add(mapped);
    else if (typeof key === 'string' && key) unknown.add(key);
  }
  const mapped = TEST_CONTENT_KEYS.filter(key => out.has(key));
  const changed = mapped.length !== active.length || active.some(key => !keySet.has(key));
  return { mapped, unknown: [...unknown], changed };
}

/** 目录只用于界面展示：分组 + 稳定 ID + 中文用途。 */
export function testContentCatalog() {
  return TEST_CONTENT_GROUPS.map(group => ({
    ...group,
    items: TEST_CONTENT_ITEMS.filter(item => item.group === group.id)
      .map(({ id, label, purpose, tech }) => ({ id, label, purpose, ...(tech ? { tech } : {}) })),
  }));
}

/**
 * 传给模型的一行任务限制：默认排除项 + 用户额外排除项去重后的稳定 ID。
 */
export function excludedChecksFor(active, extra = DEFAULT_EXCLUDED_CHECKS) {
  const removed = TEST_CONTENT_KEYS.filter(key => !normalizeTestContent(active).includes(key));
  return [...new Set([...(extra || []), ...removed])];
}
