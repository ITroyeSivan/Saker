// 5.7 圆角令牌门禁：控件圆角 6px、抽屉/弹层圆角 12px。
//
// 范围只到“控件”和“抽屉/弹层”；进度条、轨道、指示器、导出报告文档不在 5.7 的
// “小控件 / 抽屉”定义内，不纳入本门禁（避免把 2px 的进度条强行改成 6px）。
// 胶囊（999px）与圆形（50%）保持原样。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productPluginDirectories } from './lib/product-plugins.mjs';
import { RADIUS as RADIUS_TOKENS } from './lib/ui-tokens.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = /([^{}\n]{1,200})\{([^{}]*)\}/g;
const RADIUS = /border-radius\s*:\s*([^;}]+)/;
const CONTROL = /(?:button|btn|input|select|chip|tab|typechip|iconbtn|seg|search|pill|badge|tag|item)/i;
const OVERLAY = /(?:drawer|modal|dialog|popover|pop|menu)/i;
const REPORT_TAGS = new Set(['body', 'h1', 'h2', 'h3', 'pre', 'table', 'td', 'th', '.page', '.meta', '.card', '.sev']);

function selectorParts(selector) {
  const tail = selector.slice(selector.lastIndexOf('{') + 1).trim();
  const cleaned = tail.replace(/^[\s\S]*?['"`(]/, '').replace(/^['"`\s]+/, '').trim();
  return { tail, cleaned, first: cleaned.split(',')[0].trim(), subject: cleaned.split(',').pop().trim().split(/\s+/).pop() || '' };
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
    const selector = rule[1];
    if (excluded(selector)) continue;
    const { subject } = selectorParts(selector);
    const target = CONTROL.test(subject) ? RADIUS_TOKENS.control : OVERLAY.test(subject) ? RADIUS_TOKENS.drawer : '';
    if (!target) continue;
    const match = RADIUS.exec(rule[2]);
    if (!match) continue;
    const value = match[1].trim();
    if (/999|50%/.test(value) || value === target) continue;
    violations.push({ file: rel, subject: subject.slice(0, 50), value, target });
  }
}

if (violations.length) {
  console.log('FAIL 5.7 圆角令牌（控件 6px / 抽屉 12px）：');
  for (const v of violations.slice(0, 60)) console.log(`   ${v.file} ${v.subject} border-radius:${v.value} 应为 ${v.target}`);
  if (violations.length > 60) console.log(`   ... 另有 ${violations.length - 60} 处`);
  process.exitCode = 1;
} else {
  console.log(`ok   5.7 圆角令牌：${files.length} 个产品客户端文件的控件/抽屉圆角合规（胶囊与圆形除外）`);
}
