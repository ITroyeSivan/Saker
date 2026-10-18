// 反向检查：5.7 圆角/动效门禁必须能失败。
//
// 为什么需要：`test-ui-tokens.mjs` 是静态扫描，最容易变成"跑完总是绿"。
// 这里在合成副本里注入坏写法（不动生产文件），要求套件必须报出对应失败。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const boundary = path.resolve(root, '../_ref/tmp');
const suite = path.join(root, 'scripts', 'test-ui-tokens.mjs');
const client = path.join(root, 'plugins', 'dsh-redteam-results', 'lib', 'client.js');
const digest = () => createHash('sha256').update(fs.readFileSync(client)).digest('hex');
const before = digest();

const SMALL = '.dsh-chat-setup .dsh-chat-chip,.dsh-chat-setup button,.dsh-chat-setup select,.dsh-chat-setup input,.dsh-chat-setup textarea{border-radius:6px}';
const DRAWER = '.dsh-chat-setup .dsh-prompt-drawer,.dsh-chat-setup .dsh-chat-more{border-radius:12px}';
const MOTION = '.dsh-chat-setup .dsh-chat-more,.dsh-chat-setup .dsh-chat-prompt,.dsh-chat-setup .dsh-prompt-drawer{animation:dsh-overlay-in 120ms ease-out!important}';
const REDUCED = '@media(prefers-reduced-motion:reduce){.dsh-chat-setup .dsh-chat-more,.dsh-chat-setup .dsh-chat-prompt,.dsh-chat-setup .dsh-prompt-drawer{animation:none!important}}';
const BLANKET = '.dsh-chat-setup *{animation:none!important;transition:none!important}';

const variants = [
  { id: 'small-control-8px', mutate: (s) => s.replace(SMALL, SMALL.replace('border-radius:6px', 'border-radius:8px')), failure: /小控件圆角 6px/ },
  { id: 'drawer-8px', mutate: (s) => s.replace(DRAWER, DRAWER.replace('border-radius:12px', 'border-radius:8px')), failure: /抽屉圆角 12px/ },
  { id: 'motion-without-important', mutate: (s) => s.replace(MOTION, MOTION.replace('ease-out!important', 'ease-out')), failure: /覆盖层 120ms/ },
  { id: 'no-reduced-motion', mutate: (s) => s.replace(REDUCED, ''), failure: /减少动态效果/ },
  { id: 'blanket-animation-removed', mutate: (s) => s.replace(BLANKET, ''), failure: /除覆盖层外仍无动画/ },
];

/** 造一份只含被测套件所需文件的合成仓库，并注入坏写法。 */
function buildFixture(tag, mutate) {
  const fixture = fs.mkdtempSync(path.join(boundary, `revcheck-ui-tokens-${tag}-`));
  const inside = path.relative(boundary, fixture);
  assert(inside && !inside.startsWith('..') && !path.isAbsolute(inside), '临时目录逃出 _ref/tmp');
  fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'plugins', 'dsh-redteam-results', 'lib'), { recursive: true });
  fs.copyFileSync(suite, path.join(fixture, 'scripts', 'test-ui-tokens.mjs'));
  const next = mutate(fs.readFileSync(client, 'utf8'));
  assert.notEqual(next, fs.readFileSync(client, 'utf8'), `${tag}: 变体必须真的改到文件`);
  fs.writeFileSync(path.join(fixture, 'plugins', 'dsh-redteam-results', 'lib', 'client.js'), next);
  return fixture;
}

function runSuite(fixture) {
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'test-ui-tokens.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

let failures = 0;
for (const variant of variants) {
  const fixture = buildFixture(variant.id, variant.mutate);
  try {
    const { status, output } = runSuite(fixture);
    try {
      assert.notEqual(status, 0, `${variant.id}: 坏写法必须让门禁失败`);
      assert.match(output, variant.failure, `${variant.id}: 失败原因要指向对应门禁`);
      console.log(`ok reverse ${variant.id}: the 5.7 token gate caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-6).join('\n'));
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// 反向的另一半：门禁只盯主聊天界面，不能误伤全屏统计看板的独立动效语境。
{
  const fixture = buildFixture('allowed-dashboard-motion', (s) => s + '\nconst __dashboardMotion = ".dsh-scr-probe{animation:spin 2s linear infinite}";\n');
  try {
    const { status, output } = runSuite(fixture);
    assert.equal(status, 0, '统计看板的独立动效被 5.7 门禁误伤了：' + output.split('\n').filter((l) => l.startsWith('FAIL')).join(' | '));
    console.log('ok dashboard motion stays outside the chat-surface gate');
  } catch (error) {
    failures++;
    console.log('FAIL allowed-dashboard-motion: ' + error.message);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

assert.equal(digest(), before, '反向检查不得改动生产客户端');
console.log('ok 5.7 token reverse verification preserves production source');
process.exitCode = failures ? 1 : 0;
