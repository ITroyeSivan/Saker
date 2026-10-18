// 反向检查：5.7 圆角门禁必须能失败，且不能误伤胶囊/圆形/进度条/看板/报告。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const boundary = path.resolve(root, '../_ref/tmp');
const suite = path.join(root, 'scripts', 'test-ui-radius.mjs');
const guardFiles = ['plugins/dsh-redteam-results/lib/client.js', 'plugins/dsh-hunter/lib/client.js'];
const digest = () => createHash('sha256').update(guardFiles.map((rel) => fs.readFileSync(path.join(root, rel))).join('\n')).digest('hex');
const before = digest();

const COMPLIANT = 'const css = ".dsh-btn{border-radius:6px}.dsh-drawer{border-radius:12px}";\n';
const variants = [
  { id: 'control-8px', css: 'const css = ".dsh-btn{border-radius:8px}";\n', failure: /圆角令牌/ },
  { id: 'drawer-10px', css: 'const css = ".dsh-drawer{border-radius:10px}";\n', failure: /圆角令牌/ },
];

function buildFixture(tag, css) {
  const fixture = fs.mkdtempSync(path.join(boundary, `revcheck-ui-radius-${tag}-`));
  const inside = path.relative(boundary, fixture);
  assert(inside && !inside.startsWith('..') && !path.isAbsolute(inside), '临时目录逃出 _ref/tmp');
  fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'shared', 'ui-kit'), { recursive: true });
  fs.copyFileSync(suite, path.join(fixture, 'scripts', 'test-ui-radius.mjs'));
  fs.copyFileSync(path.join(root, 'scripts', 'lib', 'product-plugins.mjs'), path.join(fixture, 'scripts', 'lib', 'product-plugins.mjs'));
  fs.copyFileSync(path.join(root, 'scripts', 'lib', 'ui-tokens.mjs'), path.join(fixture, 'scripts', 'lib', 'ui-tokens.mjs'));
  fs.copyFileSync(path.join(root, 'shared', 'ui-kit', 'ui-kit.json'), path.join(fixture, 'shared', 'ui-kit', 'ui-kit.json'));
  for (let i = 1; i <= 8; i++) {
    const dir = path.join(fixture, 'plugins', `dsh-fixture-${i}`);
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@dsh-external/dsh-fixture-${i}`, version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, 'lib', 'client.js'), i === 1 ? css : COMPLIANT);
  }
  return fixture;
}

function runSuite(fixture) {
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'test-ui-radius.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

let failures = 0;
for (const variant of variants) {
  const fixture = buildFixture(variant.id, variant.css);
  try {
    const { status, output } = runSuite(fixture);
    try {
      assert.notEqual(status, 0, `${variant.id}: 坏写法必须让门禁失败`);
      assert.match(output, variant.failure, `${variant.id}: 失败原因要指向圆角令牌门禁`);
      console.log(`ok reverse ${variant.id}: the radius gate caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-6).join('\n'));
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// 反向的另一半：胶囊/圆形、进度条、看板、导出报告不该被圆角门禁误伤。
{
  const fixture = buildFixture('allowed-contexts',
    'const css = ".dsh-btn{border-radius:999px}.dsh-round{border-radius:50%}.dsh-progress{border-radius:2px}.dsh-scr-x{border-radius:10px}.card{border-radius:10px}";\n');
  try {
    const { status, output } = runSuite(fixture);
    assert.equal(status, 0, '胶囊/圆形/进度条/看板/报告被圆角门禁误伤了：' + output.split('\n').filter((l) => l.startsWith('FAIL')).join(' | '));
    console.log('ok pills, circles, progress bars, dashboard and report stay allowed');
  } catch (error) {
    failures++;
    console.log('FAIL allowed-contexts: ' + error.message);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

assert.equal(digest(), before, '反向检查不得改动生产客户端');
console.log('ok radius reverse verification preserves production source');
process.exitCode = failures ? 1 : 0;
