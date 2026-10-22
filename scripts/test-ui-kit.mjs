// 5.7 共享组件层门禁：单一来源 shared/ui-kit/ui-kit.json 必须与方案 5.7 一致，
// 且各 UI 令牌门禁必须从它取值（而不是各自硬编码数字）。
//
// 为什么要有：5.7 要求「组件统一为 Button / Input / Select / Badge / DataTable /
// Drawer / InlineNotice / EmptyState」。插件是独立的 window.__ModuleLoader__ 工厂，
// 运行时共享模块需要新建包；当前先把“单一来源 + 全部门禁取值”落地，组件类迁移单独记进度。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_KIT, COMPONENTS, FONT_SIZES, SPACING, LINE_HEIGHT, RADIUS, HEIGHT } from './lib/ui-tokens.mjs';
import { productPluginDirectories } from './lib/product-plugins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_COMPONENTS = ['Button', 'Input', 'Select', 'Badge', 'DataTable', 'Drawer', 'InlineNotice', 'EmptyState'];
const EXPECTED_FONTS = ['12', '13', '14', '16'];
const EXPECTED_SPACING = ['0', '4', '8', '12', '16', '24'];

let failed = 0;
const check = (ok, message) => { if (ok) console.log('ok   ' + message); else { failed = 1; console.log('FAIL ' + message); } };

check(UI_KIT.source.includes('5.7'), '共享组件层标注了来源（方案 5.7）');
check(COMPONENTS.length === EXPECTED_COMPONENTS.length && EXPECTED_COMPONENTS.every((name, i) => COMPONENTS[i] === name),
  '组件清单是 8 项：' + EXPECTED_COMPONENTS.join(' / '));
check([...FONT_SIZES].sort((a, b) => a - b).join(',') === EXPECTED_FONTS.join(','), '字号令牌 12/13/14/16');
check(LINE_HEIGHT === '1.5', '行高令牌 1.5');
check([...SPACING].sort((a, b) => a - b).join(',') === EXPECTED_SPACING.join(','), '间距令牌 0/4/8/12/16/24');
check(RADIUS.control === '6px' && RADIUS.drawer === '12px', '圆角令牌：控件 6px / 抽屉 12px');
check(HEIGHT.control === '32px' && HEIGHT.input === '36px' && HEIGHT.tableRow === '38px' && HEIGHT.icon === '16px',
  '控件尺寸令牌：控件 32 / 输入 36 / 表格行 38 / 图标 16');

// 各门禁必须从共享来源取值，不能再出现"某个门禁自己写死一套数字"。
const gates = ['test-theme-fallbacks.mjs', 'test-ui-spacing.mjs', 'test-ui-radius.mjs', 'test-ui-control-metrics.mjs', 'test-ui-line-height.mjs'];
for (const gate of gates) {
  const source = fs.readFileSync(path.join(root, 'scripts', gate), 'utf8');
  check(source.includes("./lib/ui-tokens.mjs"), `${gate} 从共享组件层取值`);
}

// 共享 CSS 必须定义 8 个 canonical 组件类。
const css = fs.readFileSync(path.join(root, 'shared', 'ui-kit', 'ui-kit.css'), 'utf8').trim();
for (const kind of ['btn', 'input', 'select', 'badge', 'table', 'drawer', 'notice', 'empty']) {
  check(css.includes(`.saker-ui-${kind}`), `canonical 组件类 .saker-ui-${kind} 已定义`);
}

// 所有带标记块的产品插件都必须注入同一份 CSS；主插件 DOM 还要真的用上 canonical 类。
const BLOCK = /\/\* SAKER-UI-KIT:BEGIN \*\/\nvar SAKER_UI_KIT_CSS = (.*?);\n\/\* SAKER-UI-KIT:END \*\//s;
const marked = [];
for (const name of productPluginDirectories(root)) {
  const file = path.join(root, 'plugins', name, 'lib', 'client.js');
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, 'utf8');
  const match = BLOCK.exec(source);
  if (match) marked.push({ name, value: match[1] });
}
check(marked.length >= 4, `至少 4 个产品插件已注入共享 CSS（实际 ${marked.length}）`);
for (const { name, value } of marked) {
  check(JSON.parse(value) === css, `${name} 注入的 CSS 与 shared/ui-kit/ui-kit.css 逐字节一致`);
}
const client = fs.readFileSync(path.join(root, 'plugins', 'dsh-redteam-results', 'lib', 'client.js'), 'utf8');
for (const kind of ['btn', 'select', 'table']) {
  check(new RegExp(`className[^,;\\n]{0,120}saker-ui-${kind}`).test(client), `主插件 DOM 使用 canonical 类 saker-ui-${kind}`);
}

// dsh-mcp-studio：lib 由 src 构建，检查生成的 src 模块与构建产物都带上共享 CSS。
const generated = fs.readFileSync(path.join(root, 'plugins', 'dsh-mcp-studio', 'src', 'client', 'ui-kit-css.ts'), 'utf8');
const generatedMatch = /export const UI_KIT_CSS = (.*)\n/.exec(generated);
check(!!generatedMatch && JSON.parse(generatedMatch[1]) === css, 'dsh-mcp-studio 生成的 ui-kit-css.ts 与共享来源一致');
const mcpLib = fs.readFileSync(path.join(root, 'plugins', 'dsh-mcp-studio', 'lib', 'client.js'), 'utf8');
check(mcpLib.includes('.saker-ui-btn') && mcpLib.includes('.dsh-mcs-btn,.dsh-mcs-iconbtn'), 'dsh-mcp-studio 构建产物带上共享 CSS');

// 三个内联 style 插件：根容器打 data-saker-ui，尺寸由共享 CSS 的作用域规则给。
check(css.includes('[data-saker-ui] button{height:32px}'), '共享 CSS 给 data-saker-ui 根里的按钮 32px');
check(css.includes('[data-saker-ui] input'), '共享 CSS 给 data-saker-ui 根里的输入 36px');
for (const [name, marker] of [['dsh-sec-config', 'sec-config'], ['dsh-skill-browse', 'skill-browse']]) {
  const source = fs.readFileSync(path.join(root, 'plugins', name, 'lib', 'client.js'), 'utf8');
  check(source.includes(`'data-saker-ui': '${marker}'`), `${name} 根容器接入共享组件层`);
}

process.exitCode = failed;
