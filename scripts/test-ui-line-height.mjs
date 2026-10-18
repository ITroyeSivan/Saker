// 5.7 行高门禁：Saker 文本块的无单位 line-height 必须是 1.5。
//
// 允许的例外（与间距/控件高同一套边界思路）：
//   · 像素/百分比行高：固定高徽标与控件需要（例如 `.dsh-mcs-chip{line-height:15px}`）；
//   · 统计数字与图标按钮：`.dsh-rtr-statnum` / `.dsh-mcs-iconbtn` 有专门口径；
//   · 全屏看板 `.dsh-scr-*` 与导出报告文档标签排除（与字号门禁同一套排除）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productPluginDirectories } from './lib/product-plugins.mjs';
import { LINE_HEIGHT } from './lib/ui-tokens.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = /([^{}\n]{1,200})\{([^{}]*)\}/g;
const REPORT_TAGS = new Set(['body', 'h1', 'h2', 'h3', 'pre', 'table', 'td', 'th', '.page', '.meta', '.card', '.sev']);
const KEEP = /statnum|stat>strong|stat>span|iconbtn/;

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
    if (KEEP.test(subject)) continue;
    for (const pattern of [/line-height\s*:\s*([^;}]+)/g, /lineHeight\s*:\s*([^,;}]+)/g]) {
      for (const match of rule[2].matchAll(pattern)) {
        const value = match[1].trim();
        if (/px|em|rem|%/.test(value) || value === LINE_HEIGHT) continue;
        violations.push({ file: rel, subject: subject.slice(0, 50), value });
      }
    }
  }
}

if (violations.length) {
  console.log('FAIL 5.7 行高（文本块必须 1.5；像素行高与统计数字除外）：');
  for (const v of violations.slice(0, 60)) console.log(`   ${v.file} ${v.subject} line-height:${v.value}`);
  if (violations.length > 60) console.log(`   ... 另有 ${violations.length - 60} 处`);
  process.exitCode = 1;
} else {
  console.log(`ok   5.7 行高：${files.length} 个产品客户端文件的文本块行高为 1.5（像素行高/统计数字除外）`);
}
