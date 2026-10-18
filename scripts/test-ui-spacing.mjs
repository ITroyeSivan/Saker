// 5.7 间距令牌门禁：Saker 自有 CSS / JS style 对象的 gap、margin、容器 padding
// 只能用 0/4/8/12/16/24px（或同值无单位数字）。
//
// 边界说明（方案同一句里“间距 4/8/12/16/24”与“控件高 32px”字面冲突：
// 12px 字号 ×1.5 行高 + 1px 边框时，32px 控件恰好需要 6px 垂直内边距）：
//   · 控件内部 padding 由“控件高 32 / 输入 36”的口径决定，不按间距令牌检查；
//   · 内联 style 对象无法静态区分控件与容器，只查 gap/margin，不查 padding；
//   · 全屏统计看板 `.dsh-scr-*` 与导出 HTML 报告文档标签排除（与字号门禁同一套排除）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productPluginDirectories } from './lib/product-plugins.mjs';
import { SPACING } from './lib/ui-tokens.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = SPACING;
const REPORT_TAGS = new Set(['body', 'h1', 'h2', 'h3', 'pre', 'table', 'td', 'th', '.page', '.meta', '.card', '.sev']);
const RULE = /([^{}\n]{1,200})\{([^{}]*)\}/g;
const DECL = /^(\s*)(padding(?:Top|Bottom|Left|Right|Inline|Block)?|padding(?:-top|-bottom|-left|-right|-inline|-block)?|margin(?:Top|Bottom|Left|Right)?|margin(?:-top|-bottom|-left|-right)?|gap|rowGap|row-gap|columnGap|column-gap)(\s*:\s*)([\s\S]*?)(\s*)$/;

function splitDeclarations(body) {
  const parts = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === ';' || c === ',')) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts;
}
function selectorParts(selector) {
  const tail = selector.slice(selector.lastIndexOf('{') + 1).trim();
  const cleaned = tail.replace(/^[\s\S]*?['"`(]/, '').replace(/^['"`\s]+/, '').trim();
  return { tail, cleaned, first: cleaned.split(',')[0].trim(), subject: cleaned.split(',').pop().trim().split(/\s+/).pop() || '' };
}
function excluded(selector) {
  const { tail, cleaned, first } = selectorParts(selector);
  return cleaned.startsWith('@') || /\.dsh-scr-/.test(tail) || REPORT_TAGS.has(first);
}
function controlSubject(selector) {
  const { subject } = selectorParts(selector);
  return /(?:^|\.|#)(?:[a-z-]*(?:button|btn|input|select|textarea|chip|tab|toggle|switch|badge|pill|item|option)\b)/i.test(subject)
    || /^(?:button|input|select|textarea)$/i.test(subject);
}
function inlineObject(selector, body) {
  const { tail, cleaned } = selectorParts(selector);
  return /^[A-Za-z_$][\w$]*\s*:/.test(cleaned)
    || /(?:Object\.assign|=>|return|style\.)/.test(tail)
    || /\b[a-z]+[A-Z][A-Za-z]*\s*:/.test(body);
}
function offToken(value) {
  const trimmed = value.trim();
  if (/auto|calc\(|clamp\(/i.test(trimmed)) return [];
  const numbers = [...trimmed.matchAll(/(-?\d+(?:\.\d+)?)(px)?/g)]
    .filter((m) => m[2] === 'px' || /^-?\d+(?:\.\d+)?$/.test(trimmed))
    .map((m) => m[1].replace(/^-/, ''));
  return numbers.filter((n) => !TOKENS.has(n));
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
    const selector = rule[1];
    const body = rule[2];
    if (excluded(selector)) continue;
    const isControl = controlSubject(selector);
    const isInline = inlineObject(selector, body);
    for (const part of splitDeclarations(body)) {
      const decl = DECL.exec(part);
      if (!decl) continue;
      const prop = decl[2];
      if (/padding/i.test(prop) && (isControl || isInline)) continue;
      const bad = offToken(decl[4]);
      if (bad.length) violations.push({ file: rel, prop, value: decl[4].trim().slice(0, 60), bad: bad.join('/') });
    }
  }
}

if (violations.length) {
  console.log('FAIL 5.7 间距令牌（gap/margin/容器 padding 只允许 0/4/8/12/16/24）：');
  for (const v of violations.slice(0, 60)) console.log(`   ${v.file} ${v.prop}:${v.value} -> ${v.bad}`);
  if (violations.length > 60) console.log(`   ... 另有 ${violations.length - 60} 处`);
  process.exitCode = 1;
} else {
  console.log(`ok   5.7 间距令牌：${files.length} 个产品客户端文件全部合规（控件内边距按控件高口径豁免）`);
}
