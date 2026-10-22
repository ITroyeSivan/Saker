// 反向检查：5.7 控件尺寸门禁必须能失败（含其它插件的控件）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const boundary = path.resolve(root, '../_ref/tmp');
const suite = path.join(root, 'scripts', 'test-ui-control-metrics.mjs');
const FILES = [
  'plugins/dsh-redteam-results/lib/client.js',
  'plugins/dsh-mcp-studio/lib/client.js',
  'plugins/dsh-hunter/lib/client.js',
  'plugins/dsh-session-pulse/lib/client.js',
  'plugins/dsh-mode-group/lib/client.js',
  'plugins/dsh-sec-config/lib/client.js',
  'plugins/dsh-skill-browse/lib/client.js',
];
const digest = () => createHash('sha256').update(FILES.map((rel) => fs.readFileSync(path.join(root, rel))).join('\n')).digest('hex');
const before = digest();

const variants = [
  { id: 'rtr-btn-32px-removed', file: FILES[0], mutate: (s) => s.replace(',.dsh-rtr-btn{height:32px', '{height:32px'), failure: /\.dsh-rtr-btn/ },
  { id: 'table-row-34px', file: FILES[0], mutate: (s) => s.replace('.dsh-materials-table td{height:38px}', '.dsh-materials-table td{height:34px}'), failure: /表格行 38px/ },
  { id: 'input-36px-removed', file: FILES[0], mutate: (s) => s.replace(',.dsh-rtr-search{height:36px}', '{height:36px}'), failure: /输入行 36px/ },
  { id: 'list-item-capped', file: FILES[0], mutate: (s) => s.replace('.dsh-prompt-items button{display:flex', '.dsh-prompt-items button{height:32px;display:flex'), failure: /两行模板列表项/ },
  { id: 'mcp-btn-32px-removed', file: FILES[1], mutate: (s) => s.replace('.dsh-mcs-btn,.dsh-mcs-iconbtn', '.dsh-mcs-iconbtn'), failure: /MCP 工作台按钮/ },
  { id: 'hunter-input-36px-removed', file: FILES[2], mutate: (s) => s.replace('.dsh-hnt-input{height:36px}', ''), failure: /hunter 输入框/ },
  { id: 'secconfig-root-detached', file: FILES[5], mutate: (s) => s.replace("'data-saker-ui': 'sec-config'", "''"), failure: /安全配置根容器接入共享组件层/ },
];

function buildFixture(tag, file, mutate) {
  const fixture = fs.mkdtempSync(path.join(boundary, `revcheck-ui-control-${tag}-`));
  const inside = path.relative(boundary, fixture);
  assert(inside && !inside.startsWith('..') && !path.isAbsolute(inside), '临时目录逃出 _ref/tmp');
  fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'shared', 'ui-kit'), { recursive: true });
  fs.copyFileSync(suite, path.join(fixture, 'scripts', 'test-ui-control-metrics.mjs'));
  fs.copyFileSync(path.join(root, 'scripts', 'lib', 'ui-tokens.mjs'), path.join(fixture, 'scripts', 'lib', 'ui-tokens.mjs'));
  fs.copyFileSync(path.join(root, 'shared', 'ui-kit', 'ui-kit.json'), path.join(fixture, 'shared', 'ui-kit', 'ui-kit.json'));
  for (const rel of FILES) {
    const destination = path.join(fixture, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, rel), destination);
  }
  const target = path.join(fixture, file);
  const original = fs.readFileSync(path.join(root, file), 'utf8');
  const next = mutate(original);
  assert.notEqual(next, original, `${tag}: 变体必须真的改到文件`);
  fs.writeFileSync(target, next);
  return fixture;
}

function runSuite(fixture) {
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'test-ui-control-metrics.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

let failures = 0;
for (const variant of variants) {
  const fixture = buildFixture(variant.id, variant.file, variant.mutate);
  try {
    const { status, output } = runSuite(fixture);
    try {
      assert.notEqual(status, 0, `${variant.id}: 坏写法必须让门禁失败`);
      assert.match(output, variant.failure, `${variant.id}: 失败原因要指向对应门禁`);
      console.log(`ok reverse ${variant.id}: the control-metrics gate caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-6).join('\n'));
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

assert.equal(digest(), before, '反向检查不得改动生产客户端');
console.log('ok control-metrics reverse verification preserves production source');
process.exitCode = failures ? 1 : 0;
