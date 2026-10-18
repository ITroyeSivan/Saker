// 5.7 控件尺寸门禁：单行控件 32px、输入行 36px、表格行 38px、图标 16px。
// 数值来自共享组件层 shared/ui-kit/ui-kit.json（单一来源）。
//
// 覆盖已逐条确认过的单行控件；两行控件必须不设固定高度：
//   · 模板列表项 `.dsh-prompt-items button`（标题+分组）
//   · 模式菜单项 `.dsh-mg-item`（名称+说明）
// 这两条也进反向套件——给它们加 32px 会裁切。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEIGHT, UI_KIT } from './lib/ui-tokens.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL = `height:${HEIGHT.control}`;
const INPUT = `height:${HEIGHT.input}`;
const TABLE = `height:${HEIGHT.tableRow}`;
const ICON_W = `width:${HEIGHT.icon}`;
const ICON_H = `height:${HEIGHT.icon}`;

const RULE = /([^{}\n]{1,200})\{([^{}]*)\}/g;
const rulesCache = new Map();
function rulesOf(rel) {
  if (!rulesCache.has(rel)) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    rulesCache.set(rel, [...source.matchAll(RULE)].map((m) => ({ selector: m[1], body: m[2] })));
  }
  return rulesCache.get(rel);
}
const hasRule = (rel, fragment, declaration) => rulesOf(rel).some((r) => r.selector.includes(fragment) && r.body.includes(declaration));
const hasFixedHeight = (rel, fragment) => rulesOf(rel).some((r) => r.selector.includes(fragment) && /height\s*:\s*\d+px/.test(r.body));
const hasSource = (rel, snippet) => fs.readFileSync(path.join(root, rel), 'utf8').includes(snippet);

const REDTEAM = 'plugins/dsh-redteam-results/lib/client.js';
const MCP = 'plugins/dsh-mcp-studio/lib/client.js';
const HUNTER = 'plugins/dsh-hunter/lib/client.js';
const PULSE = 'plugins/dsh-session-pulse/lib/client.js';
const MODE = 'plugins/dsh-mode-group/lib/client.js';
const KNOWLEDGE = 'plugins/dsh-knowledge-hub/lib/client.js';
const SECCONFIG = 'plugins/dsh-sec-config/lib/client.js';
const SKILL = 'plugins/dsh-skill-browse/lib/client.js';

let failed = 0;
const check = (ok, message) => { if (ok) console.log('ok   ' + message); else { failed = 1; console.log('FAIL ' + message); } };

// dsh-redteam-results：主聊天/任务界面
check(hasRule(REDTEAM, '.dsh-rtr-btn', CONTROL), '5.7 单行控件 32px：.dsh-rtr-btn');
check(hasRule(REDTEAM, '.dsh-task-nav button', CONTROL), '5.7 单行控件 32px：任务导航按钮');
check(hasRule(REDTEAM, '.dsh-prompt-foot button', CONTROL), '5.7 单行控件 32px：模板抽屉底部按钮');
check(hasRule(REDTEAM, '.dsh-rtr-search', INPUT), '5.7 输入行 36px：.dsh-rtr-search');
check(hasRule(REDTEAM, '.dsh-prompt-list input[type=search]', INPUT), '5.7 输入行 36px：模板搜索框');
check(hasRule(REDTEAM, '.dsh-materials-table td', TABLE), '5.7 表格行 38px：测试资料表格');
check(hasRule(REDTEAM, '.dsh-chat-setup svg', ICON_W) && hasRule(REDTEAM, '.dsh-chat-setup svg', ICON_H), '5.7 图标 16px：聊天界面 svg');
check(!hasFixedHeight(REDTEAM, '.dsh-prompt-items button'), '5.7 两行模板列表项按钮不设高度（避免裁切）');

// dsh-mcp-studio：MCP 工作台
check(hasRule(MCP, '.dsh-mcs-btn', CONTROL), '5.7 单行控件 32px：MCP 工作台按钮');
check(hasRule(MCP, '.dsh-mcs-iconbtn', CONTROL), '5.7 单行控件 32px：MCP 图标按钮');
check(hasRule(MCP, '.dsh-mcs-search', INPUT), '5.7 输入行 36px：MCP 搜索框');
check(hasRule(MCP, '.dsh-mcs-field select', CONTROL), '5.7 单行控件 32px：MCP 下拉');

// dsh-hunter：资产搜索 / 资产平台 API
check(hasRule(HUNTER, '.dsh-hnt-btn', CONTROL), '5.7 单行控件 32px：hunter 按钮');
check(hasRule(HUNTER, '.dsh-hnt-tab', CONTROL), '5.7 单行控件 32px：hunter 标签');
check(hasRule(HUNTER, '.dsh-hnt-input', INPUT), '5.7 输入行 36px：hunter 输入框');
check(hasRule(HUNTER, '.dsh-hnt-select', CONTROL), '5.7 单行控件 32px：hunter 下拉');

// dsh-session-pulse / dsh-mode-group
check(hasRule(PULSE, '.dsh-sp-chip.is-btn', CONTROL), '5.7 单行控件 32px：会话脉冲按钮');
check(hasRule(MODE, '.dsh-mg-chip', CONTROL), '5.7 单行控件 32px：模式切换 chip');
check(!hasFixedHeight(MODE, '.dsh-mg-item'), '5.7 两行模式菜单项不设高度（避免裁切）');

// 内联 style 插件：控件尺寸落在基样式 helper 上（输入 36 / 按钮 32）。
// 三个内联 style 插件改成「根容器打 data-saker-ui + 共享 CSS 给尺寸」，helper 不再写 height。
// 尺寸值本身由 test-ui-kit 检查共享 CSS 的 [data-saker-ui] 规则。
check(hasSource(KNOWLEDGE, "'data-saker-ui': 'knowledge'"), '5.7 知识库根容器接入共享组件层');
check(hasSource(SECCONFIG, "'data-saker-ui': 'sec-config'"), '5.7 安全配置根容器接入共享组件层');
check(hasSource(SKILL, "'data-saker-ui': 'skill-browse'"), '5.7 技能浏览根容器接入共享组件层');
check(!hasSource(KNOWLEDGE, 'height: 36, padding'), '5.7 知识库 helper 不再重复写 height');
check(!hasSource(SECCONFIG, 'height: 32, padding'), '5.7 安全配置 helper 不再重复写 height');
check(!hasSource(SKILL, 'height: 32, padding'), '5.7 技能浏览 helper 不再重复写 height');

process.exitCode = failed;
