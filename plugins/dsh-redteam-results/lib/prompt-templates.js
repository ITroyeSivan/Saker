// 提示词模板库：36 篇内置模板 + 字段定义 + 同义词搜索 + 渲染。
//
// 为什么独立：旧实现把示例模板按模式筛选、正文用 [占位] 且默认选首篇。本层只做
// **纯数据与纯函数**（不碰数据库、不调用模型、不创建任务），让编辑器与 RPC 共用同一份
// 目录。内置模板只读；另存为用户模板时创建新 ID。
//
// 边界：
//   · 模板正文用 {{字段键}}；未填字段代入该字段的默认短句，required 为空时不得插入。
//   · 搜索覆盖标题、关键字与同义词（越权/IDOR、接口/OpenAPI/Swagger、继续/恢复、Nday/CVE 等）。
//   · 版本字段留空显示“未知，先根据实际材料核对”，不猜版本。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CATALOG_PATH = fileURLToPath(new URL('./prompt-templates.json', import.meta.url));
let cached = null;

/** 读取内置目录（只读一次；文件损坏时抛出，不静默降级成空库）。 */
export function promptCatalog() {
  if (cached) return cached;
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  let doc;
  try { doc = JSON.parse(raw); }
  catch (error) { throw new Error('内置提示词模板目录无法解析：' + error.message); }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.templates) || !doc.fields) throw new Error('内置提示词模板目录格式错误');
  cached = doc;
  return cached;
}

/** 字段定义：界面名称、控件类型、占位、默认短句。 */
export function promptFields() {
  return promptCatalog().fields;
}

/** 内置模板只读列表（保持目录顺序）。 */
export function builtinTemplates() {
  return promptCatalog().templates.map(t => ({ ...t, builtin: true, readOnly: true }));
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 模板结构校验：id/标题/分组/正文/必填项都要有界且自洽。 */
export function validateTemplate(template, { builtin = false } = {}) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) throw new Error('模板需要对象');
  const id = String(template.id ?? '').trim();
  if (!ID_RE.test(id)) throw new Error('模板 ID 格式错误：' + id);
  const title = String(template.title ?? '').trim();
  if (!title || title.length > 60) throw new Error('模板名称需为 1–60 字');
  const text = String(template.text ?? '');
  if (!text.trim()) throw new Error('模板正文不能为空');
  if (Buffer.byteLength(text) > 16000) throw new Error('模板正文超过上限');
  const required = template.required ?? [];
  const optional = template.optional ?? [];
  if (!Array.isArray(required) || !Array.isArray(optional)) throw new Error('模板字段声明必须是数组');
  const fields = promptFields();
  for (const key of [...required, ...optional]) if (!fields[key]) throw new Error('模板引用了未定义字段：' + key);
  for (const key of required) if (optional.includes(key)) throw new Error('字段不能同时是必填与可选：' + key);
  const placeholders = new Set([...text.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map(m => m[1]));
  for (const key of placeholders) if (!fields[key]) throw new Error('正文出现未定义字段：' + key);
  for (const key of [...required, ...optional]) if (!placeholders.has(key) && key !== 'materials' && key !== 'repo' && key !== 'change' && key !== 'finding' && key !== 'sources')
    throw new Error('模板声明了字段但正文没有引用：' + key);
  return { id, title, group: String(template.group ?? '自定义').slice(0, 40), text,
    required: [...required], optional: [...optional],
    keywords: Array.isArray(template.keywords) ? template.keywords.map(String).slice(0, 24) : [],
    builtin, readOnly: builtin };
}

/** 同义词：用户输入需求词时也能定位到合适模板。 */
const SYNONYMS = {
  '越权': ['access-control', 'IDOR', 'BOLA'], 'IDOR': ['越权', 'access-control'], 'BOLA': ['越权', 'access-control'],
  '接口': ['js-api', 'API', 'OpenAPI', 'Swagger'], 'API': ['接口', 'js-api'], 'OpenAPI': ['接口', 'A05'], 'Swagger': ['接口', 'A05'],
  'XSS': ['xss', 'DOM', '网页脚本'], 'DOM': ['XSS', 'xss'],
  '继续': ['F03', '恢复'], '恢复': ['F03', '继续'],
  'Nday': ['N01', 'N02', 'CVE'], 'CVE': ['N01', 'Nday'], 'nday': ['N01', 'N02', 'CVE'],
  'EXP': ['N01'], '漏洞': ['N01', 'N02'], '公告': ['N01'],
  'SQL': ['sqli', 'Z06', 'S04'], '注入': ['sqli', 'S04', 'Z06'],
  '子域名': ['R02', 'subdomain'], '端口': ['R03'], '后台': ['R04'], 'FOFA': ['R05', 'R06'],
  '源码': ['A03', 'Z02'], 'HAR': ['S02', 'A01'], '流量': ['A01'], '扫描': ['A04'],
  '报告': ['F04'], '复测': ['F02'], '复核': ['F01'], '学习': ['F05'],
  '资料': ['A06'], '文档': ['P01'], '案例': ['P01'], '逐项': ['P01'],
};

/** 搜索：标题、关键字、ID、同义词命中；空查询返回全部。 */
export function searchTemplates(query, templates = builtinTemplates()) {
  const q = String(query ?? '').trim();
  if (!q) return templates.slice();
  const terms = new Set([q, ...(SYNONYMS[q] || []), ...q.split(/[\s,，、/]+/).filter(Boolean)]);
  const lower = s => String(s).toLowerCase();
  return templates.filter(t => {
    const hay = [t.id, t.title, t.group, ...(t.keywords || []), ...(t.required || []), ...(t.optional || [])].map(lower).join(' ');
    for (const term of terms) if (hay.includes(lower(term))) return true;
    return false;
  });
}

/**
 * 用当前值渲染模板正文。未提供值的字段代入字段默认短句；
 * source 记录每个字段来自“已填/默认/引用当前任务”，供界面显示来源。
 */
export function renderTemplate(template, values = {}) {
  const fields = promptFields();
  const used = {};
  const text = String(template.text).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key) => {
    const raw = values[key];
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') { used[key] = 'input'; return String(raw); }
    const fallback = fields[key]?.default ?? '';
    used[key] = fallback ? 'default' : 'empty';
    return fallback;
  });
  return { text, fields: used };
}

/** 必填项是否已填；返回缺失的中文名称列表，供“还剩 N 项未填”。 */
export function missingRequired(template, values = {}) {
  const fields = promptFields();
  return (template.required || []).filter(key => values[key] === undefined || values[key] === null || String(values[key]).trim() === '')
    .map(key => fields[key]?.label ?? key);
}

/**
 * 校验用户导入的模板文件：schema、字段、重复 ID 与正文大小，逐条报告结果。
 * 重 ID 作为新副本导入；返回 { accepted, rejected }。
 */
export function importTemplates(doc, existingIds = new Set()) {
  const rows = Array.isArray(doc) ? doc : (Array.isArray(doc?.templates) ? doc.templates : null);
  if (!rows) throw new Error('导入文件需要模板数组');
  const accepted = [], rejected = [], seen = new Set(existingIds);
  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index];
    try {
      const record = validateTemplate(raw);
      let id = record.id;
      if (seen.has(id)) id = id + '-' + Math.random().toString(36).slice(2, 8); // 重复 ID 导入为新副本
      seen.add(id);
      accepted.push({ ...record, id, builtin: false, readOnly: false, importedFrom: raw.id });
    } catch (error) { rejected.push({ index, id: raw?.id ?? '', reason: error.message }); }
  }
  return { accepted, rejected };
}
