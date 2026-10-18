// 5.7 阴影门禁：阴影只用于覆盖层。
//
// 允许：
//   · 覆盖层选择器（drawer / modal / pop / menu / toast / detail / 导出弹层 / 聊天浮层 /
//     资料导入浮层 / 会话脉冲浮层等，都是 position:absolute|fixed）；
//   · 焦点环（0 0 0 …）与无偏移状态光晕（0 0 N …）；
//   · inset 状态高亮（选中/拖放目标）；
//   · color-mix / currentColor 状态发光；
//   · 全屏看板 `.dsh-scr-*` 与导出报告文档。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productPluginDirectories } from './lib/product-plugins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = /([^{}\n]{1,200})\{([^{}]*)\}/g;
const REPORT_TAGS = new Set(['body', 'h1', 'h2', 'h3', 'pre', 'table', 'td', 'th', '.page', '.meta', '.card', '.sev']);
const OVERLAY = /drawer|modal|pop|menu|toast|detail|exportpop|knowledge-pop|dropdown|dialog|popover|tooltip|overlay|mask|chat-more|chat-prompt|prompt-drawer|materials-import|sp-tasks|sp-pexpand/i;

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
    const selector = rule[1];
    if (excluded(selector)) continue;
    const { cleaned } = selectorParts(selector);
    if (OVERLAY.test(cleaned)) continue;
    for (const match of rule[2].matchAll(/box-shadow\s*:\s*([^;}]+)/g)) {
      const value = match[1].trim();
      if (/none/.test(value)) continue;
      if (/^0 0 0\b/.test(value)) continue; // 焦点环
      if (/^0 0 \d/.test(value)) continue; // 无偏移状态光晕
      if (/inset/.test(value) || /currentColor/.test(value) || /color-mix/.test(value)) continue;
      violations.push({ file: rel, selector: cleaned.slice(0, 50), value: value.slice(0, 60) });
    }
  }
}

if (violations.length) {
  console.log('FAIL 5.7 阴影（只允许覆盖层 / 焦点环 / 状态标记）：');
  for (const v of violations.slice(0, 40)) console.log(`   ${v.file} ${v.selector} :: ${v.value}`);
  process.exitCode = 1;
} else {
  console.log(`ok   5.7 阴影：${files.length} 个产品客户端文件的阴影只出现在覆盖层/焦点环/状态标记`);
}
