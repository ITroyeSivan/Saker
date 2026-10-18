// 主题回退门禁（v6 第 5.7 节）：宿主没定义的 CSS 变量 + 写死的近白背景回退 = 深色下"浅底浅字"。
//
// 为什么要有：这个缺陷已经出现两次（报告预览正文、知识库 Exploit-DB 框/分类行/代码块），
// 都是 `background: var(--dsw-xxx, #f...)` 而宿主并不定义 `--dsw-xxx`，回退色永远生效。
// 这里用从官方 Desktop 实测导出的变量名单做静态检查；名单见 scripts/lib/host-theme-vars.json。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productPluginDirectories } from './lib/product-plugins.mjs';
import { FONT_SIZES } from './lib/ui-tokens.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'lib', 'host-theme-vars.json'), 'utf8'));
const hostDefined = new Set(fixture.names);
assert(hostDefined.size > 300, '宿主变量名单看起来不完整：' + hostDefined.size);

const nearWhite = (value) => {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(value).trim());
  if (!m) return false;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const v = parseInt(hex, 16);
  return (v >> 16) > 200 && ((v >> 8) & 255) > 200 && (v & 255) > 200;
};

let failed = 0;
const violations = [];
const tokenViolations = [];
// v6 第 5.7 节的设计令牌：正文 13–14px、分区标题 16px、辅助 12px。
// 实测曾有 10 / 11 / 11.5 / 12.5 / 15 五种"看起来差不多"的散值，肉眼很难发现。
const allowedFontSizes = FONT_SIZES;
// CSS 字符串里的字号同样要查——第一版只匹配 React 内联的 `fontSize:`，漏了 CSS 文本这一半
// （实测漏掉 90+ 处）。三种语境不属于文本角色，显式排除：
//   · 导出 HTML 报告文档的标签（整条选择器就是 h1/pre/table…）
//   · 全屏统计看板 `.dsh-scr-*`
//   · 统计数字本身（`.dsh-mcs-stat>strong` / `.dsh-rtr-statnum`）
const REPORT_TAGS = new Set(['body', 'h1', 'h2', 'h3', 'pre', 'table', 'td', 'th', '.page', '.meta', '.card', '.sev']);
const cssFontSizeExcluded = (selector) => /\.dsh-scr-/.test(selector)
  || REPORT_TAGS.has(selector.split(',')[0].trim())
  || /dsh-mcs-stat>strong/.test(selector)
  || /dsh-rtr-statnum/.test(selector);
// 只看**会随产品安装**的插件；已退役的包不再交付，不纳入本门禁（它们仍在仓库里）。
for (const name of productPluginDirectories(root)) {
  const file = path.join(root, 'plugins', name, 'lib', 'client.js');
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/fontSize:\s*([0-9.]+)\b/g)) {
    if (!allowedFontSizes.has(match[1])) tokenViolations.push({ plugin: name, size: match[1] });
  }
  for (const match of source.matchAll(/([^{}'"`;\n]{1,160})\{([^{}]*font-size:\s*([0-9.]+)px[^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (cssFontSizeExcluded(selector)) continue;
    if (!allowedFontSizes.has(match[3])) tokenViolations.push({ plugin: name, size: match[3], selector: selector.slice(0, 60) });
  }
  // 第三个盲点：`font:11px/16px ui-monospace` 这种**简写**既不是 fontSize: 也不是 font-size:。
  // 实测 mcp-studio 有 6 处，前两版门禁都看不见。
  for (const match of source.matchAll(/font:\s*([0-9.]+)px/g)) {
    if (!allowedFontSizes.has(match[1])) tokenViolations.push({ plugin: name, size: match[1], selector: 'font 简写' });
  }
  // 同一对象是否显式给了文字色：找不到 `color:` 才算可疑；`Object.assign({}, base, {...})`
  // 会从 base 继承颜色，属于无法静态判定的情况，跳过而不是误报。
  const hasExplicitColor = (index) => {
    const before = source.slice(Math.max(0, index - 240), index);
    if (/Object\.assign\(\s*\{\}\s*,/.test(before)) return true;
    const rest = source.slice(index, source.indexOf('}', index) + 1);
    return /\bcolor\s*:/.test(rest);
  };

  // 1) background 用了「宿主未定义变量 + 近白回退」，且同一对象没有显式 color。
  const varBg = /background(?:-color)?\s*:\s*['"][^'"]*var\((--dsw-[a-z0-9-]+)\s*,\s*(#[0-9a-fA-F]{3,6})/g;
  for (const match of source.matchAll(varBg)) {
    const [, variable, fallback] = match;
    if (hostDefined.has(variable) || !nearWhite(fallback)) continue;
    if (!hasExplicitColor(match.index)) violations.push({ plugin: name, kind: 'var-fallback', variable, fallback, snippet: match[0].slice(0, 120) });
  }

  // 2) background 直接写死近白，且同一对象没有显式 color。
  const hardBg = /background(?:-color)?\s*:\s*['"](#[0-9a-fA-F]{3,6})['"]/g;
  for (const match of source.matchAll(hardBg)) {
    const fallback = match[1];
    if (!nearWhite(fallback)) continue;
    if (!hasExplicitColor(match.index)) violations.push({ plugin: name, kind: 'hardcoded', fallback, snippet: match[0].slice(0, 120) });
  }
}

if (violations.length) {
  failed = 1;
  console.log('FAIL 深色主题下会出现浅底浅字的写法：');
  for (const v of violations) console.log('   ' + v.plugin + ' [' + v.kind + '] ' + (v.variable || v.fallback) + ' :: ' + v.snippet);
} else {
  console.log('ok   没有插件用"宿主未定义的变量 + 近白回退"做背景');
}
if (tokenViolations.length) {
  failed = 1;
  console.log('FAIL 字号不在 5.7 令牌里（正文 13–14 / 分区标题 16 / 辅助 12）：');
  for (const v of tokenViolations) console.log('   ' + v.plugin + ' fontSize: ' + v.size + (v.selector ? '  @ ' + v.selector : ''));
} else {
  console.log('ok   产品客户端的字号都在 5.7 令牌里（内联与 CSS 字符串都查，12 / 13 / 14 / 16）');
}
console.log('ok   宿主变量名单 ' + hostDefined.size + ' 个（来源：' + fixture.source + '）');
process.exitCode = failed;
