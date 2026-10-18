// Saker 主界面 5.7 令牌门禁：小控件圆角 6px、抽屉 12px、覆盖层 120ms 淡入/展开，
// 且「减少动态效果」下关闭；除覆盖层外不得有动画。
//
// 为什么要有：字号与深色对比已有 `test-theme-fallbacks.mjs`，但圆角和动效没有门禁。
// 旧样式把小控件写成 8px，并用 `.dsh-chat-setup *{animation:none!important}` 把覆盖层
// 动效也一起关掉——这是方案 5.7 的两条明确要求，静态回归却一直是绿的。
// 这里不只查字符串存在，还核对覆盖规则的选择器特异性确实高于被覆盖的旧规则。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'plugins', 'dsh-redteam-results', 'lib', 'client.js');
const source = fs.readFileSync(file, 'utf8');

/** [id, class/attr/pseudo-class, element] 三元组；只用于比较同一文件内两条规则的胜负。 */
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
  const elements = (selector.match(/(^|[\s>+~])([a-z][\w-]*)/gi) || []).length;
  return [ids, classes, elements];
}
const greater = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]);

let failed = 0;
const check = (ok, message) => {
  if (ok) console.log('ok   ' + message);
  else { failed = 1; console.log('FAIL ' + message); }
};

// 1) 小控件 6px：令牌层必须显式覆盖 chip 与通用控件。
const SMALL = '.dsh-chat-setup .dsh-chat-chip,.dsh-chat-setup button,.dsh-chat-setup select,.dsh-chat-setup input,.dsh-chat-setup textarea{border-radius:6px}';
check(source.includes(SMALL), '5.7 小控件圆角 6px 令牌层在位（chip 与通用控件）');
check(greater(specificity('.dsh-chat-setup .dsh-chat-chip'), specificity('.dsh-chat-chip')),
  '5.7 小控件覆盖规则的特异性高于旧 .dsh-chat-chip{8px}');
check(source.indexOf(SMALL) > source.indexOf('.dsh-chat-chip{box-sizing:border-box'),
  '5.7 小控件覆盖规则写在旧规则之后');

// 2) 抽屉 12px。
const DRAWER = '.dsh-chat-setup .dsh-prompt-drawer,.dsh-chat-setup .dsh-chat-more{border-radius:12px}';
check(source.includes(DRAWER), '5.7 抽屉圆角 12px 令牌层在位');

// 3) 覆盖层 120ms 淡入/展开，且必须带 !important 才压得住上面的一刀切规则。
const MOTION = '.dsh-chat-setup .dsh-chat-more,.dsh-chat-setup .dsh-chat-prompt,.dsh-chat-setup .dsh-prompt-drawer{animation:dsh-overlay-in 120ms ease-out!important}';
check(source.includes(MOTION), '5.7 覆盖层 120ms 淡入/展开在位');
check(source.includes('@keyframes dsh-overlay-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}'),
  '5.7 覆盖层关键帧已定义（120ms 淡入/展开，无弹跳）');
check(greater(specificity('.dsh-chat-setup .dsh-chat-more'), specificity('.dsh-chat-setup *')),
  '5.7 覆盖层动效规则的特异性高于 .dsh-chat-setup * 的一刀切规则');

// 4) 减少动态效果时关闭，且与开启规则作用同一组元素、声明在后。
const REDUCED = '@media(prefers-reduced-motion:reduce){.dsh-chat-setup .dsh-chat-more,.dsh-chat-setup .dsh-chat-prompt,.dsh-chat-setup .dsh-prompt-drawer{animation:none!important}}';
check(source.includes(REDUCED), '5.7 减少动态效果时关闭覆盖层动效');
check(source.indexOf(REDUCED) > source.indexOf(MOTION), '5.7 关闭规则声明在开启规则之后');
check(greater(specificity('.dsh-chat-setup .dsh-chat-more'), specificity('.dsh-chat-setup *')),
  '5.7 关闭规则与开启规则同级或更高，确保生效');

// 5) 除覆盖层外仍无动画：一刀切规则必须在位，避免出现持续装饰动画。
check(source.includes('.dsh-chat-setup *{animation:none!important;transition:none!important}'),
  '5.7 除覆盖层外仍无动画（无持续装饰动画）');

process.exitCode = failed;
