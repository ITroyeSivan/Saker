// 5.7 强调色门禁：产品插件不得硬编码强调色；应使用宿主强调色变量
// （var(--dsw-alias-state-business-primary, …) / var(--rt-accent, …)）。
//
// 允许的情形：
//   · var(...) 的 fallback（宿主没定义变量时的兜底色）；
//   · 自定义属性定义（--rt-navy-accent:#38d4ff 这类 token 定义）；
//   · 全屏看板 `.dsh-scr-*` 与导出报告文档（与其它 5.7 门禁同一套排除）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productPluginDirectories } from './lib/product-plugins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = /([^{}\n]{1,200})\{([^{}]*)\}/g;
const REPORT_TAGS = new Set(['body', 'h1', 'h2', 'h3', 'pre', 'table', 'td', 'th', '.page', '.meta', '.card', '.sev']);
// #3a9dff / #38d4ff 在 redteam 与 session-pulse 里是等级色/海军色（允许出现在状态标记与 token 定义），
// 不作为"强调色"检查；这里只查真正的强调色硬编码。
const ACCENTS = /#(?:2f81f7|4c6ef5|4b74d9|3f8ef7|2563eb|1f6feb|2f6fed|3b82f6)\b/gi;

function selectorParts(selector) {
  const tail = selector.slice(selector.lastIndexOf('{') + 1).trim();
  const cleaned = tail.replace(/^[\s\S]*?['"`(]/, '').replace(/^['"`\s]+/, '').trim();
  return { tail, cleaned, first: cleaned.split(',')[0].trim() };
}
function excluded(selector) {
  const { tail, cleaned, first } = selectorParts(selector);
  return cleaned.startsWith('@') || /\.dsh-scr-/.test(tail) || REPORT_TAGS.has(first);
}

const files = [];
for (const name of productPluginDirectories(root)) {
  const client = path.join(root, 'plugins', name, 'lib', 'client.js');
  if (fs.existsSync(client)) files.push(client);
  const source = path.join(root, 'plugins', name, 'src', 'client', 'styles.ts');
  if (fs.existsSync(source)) files.push(source);
}
assert(files.length >= 8, '产品插件客户端文件太少，门禁覆盖范围可疑：' + files.length);

const violations = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\/g, '/');
  for (const rule of source.matchAll(RULE)) {
    if (excluded(rule[1])) continue;
    const body = rule[2];
    for (const match of body.matchAll(ACCENTS)) {
      const before = body.slice(0, match.index);
      if (before.lastIndexOf('var(') > before.lastIndexOf(')')) continue; // var(...) fallback
      if (/--[\w-]+\s*:\s*$/.test(before)) continue; // 自定义属性定义
      violations.push({ file: rel, value: match[0], snippet: body.slice(Math.max(0, match.index - 30), match.index + 12).trim() });
    }
  }
}

if (violations.length) {
  console.log('FAIL 5.7 强调色（应使用宿主强调色变量；var fallback / token 定义 / 看板 / 报告除外）：');
  for (const v of violations.slice(0, 40)) console.log(`   ${v.file} ${v.value} :: ...${v.snippet}`);
  process.exitCode = 1;
} else {
  console.log(`ok   5.7 强调色：${files.length} 个产品客户端文件没有硬编码强调色（var fallback / token 定义除外）`);
}
