// 5.7 等级色门禁：等级色（critical/high/medium/low、verified/pending/risk 等）
// 只能出现在状态标记（徽标、状态点、图例、状态图）里，不得当装饰色用。
//
// 允许：
//   · 选择器或规则体带状态语义（sev/status/state/badge/dot/legend/verified/pending/risk/
//     critical/high/medium/low/is-*/notice/toast/alert/error/success/warn/dead/stuck/fixed）；
//   · var(...) 兜底与自定义属性定义；
//   · 全屏看板 `.dsh-scr-*` 与导出报告文档。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productPluginDirectories } from './lib/product-plugins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = /([^{}\n]{1,200})\{([^{}]*)\}/g;
const SEV = /#(?:c2182f|ff4d4d|d9b00c|3b7dd8|ff8fa0|ff6b8a|ffd43b|4dabf7|2f9e44|c92a2a|36f1b0|ff8787|ffdd33|ffc93c)\b/gi;
const STATUS = /sev|status|state|badge|dot|legend|chart|verified|pending|risk|critical|high|medium|low|is-ok|is-err|is-warn|is-danger|is-live|is-done|notice|toast|alert|error|success|warn|dead|stuck|fixed/i;
const REPORT_TAGS = new Set(['body', 'h1', 'h2', 'h3', 'pre', 'table', 'td', 'th', '.page', '.meta', '.card', '.sev']);

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
    const body = rule[2];
    if (STATUS.test(cleaned) || STATUS.test(body)) continue;
    // 内联在看板里的图表色：选择器上下文是 style:，用前后文里的 .dsh-scr- / dsh-fill 判定看板语境。
    const context = source.slice(Math.max(0, rule.index - 300), rule.index + 200);
    if (/dsh-scr-|dsh-fill/.test(context)) continue;
    for (const match of body.matchAll(SEV)) {
      const before = body.slice(0, match.index);
      if (before.lastIndexOf('var(') > before.lastIndexOf(')')) continue;
      if (/--[\w-]+\s*:\s*$/.test(before)) continue;
      violations.push({ file: rel, selector: cleaned.slice(0, 50), value: match[0], snippet: body.slice(Math.max(0, match.index - 28), match.index + 10).trim() });
    }
  }
}

if (violations.length) {
  console.log('FAIL 5.7 等级色（只能出现在状态标记；var 兜底 / token 定义 / 看板 / 报告除外）：');
  for (const v of violations.slice(0, 40)) console.log(`   ${v.file} ${v.selector} ${v.value} :: ...${v.snippet}`);
  process.exitCode = 1;
} else {
  console.log(`ok   5.7 等级色：${files.length} 个产品客户端文件的等级色只出现在状态标记`);
}
